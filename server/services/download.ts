import { existsSync, readdirSync } from 'fs'
import { open, rm } from 'fs/promises'
import { isIP } from 'net'
import { join } from 'path'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'

export const GITHUB_DOWNLOAD_HOSTS = [
  'github.com',
  'www.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com'
] as const

const MAX_REDIRECTS = 5

export interface DownloadOptions {
  maxBytes: number
  timeoutMs: number
  onProgress?: (receivedBytes: number, totalBytes: number | null) => void
  /** Every request and redirect hop must have an exact hostname match. */
  allowedHosts?: readonly string[]
}

export interface DownloadHandle {
  abort(): void
  done: Promise<void>
}

function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') return true
  if (host === '::1' || host === '[::1]') return true
  const ip = isIP(host) ? host : null
  if (!ip) return false
  if (ip.includes(':')) {
    const compact = ip.toLowerCase()
    return (
      compact === '::1' ||
      compact.startsWith('fe80:') ||
      compact.startsWith('fc') ||
      compact.startsWith('fd')
    )
  }
  const [a, b] = ip.split('.').map(Number)
  if (a === 10 || a === 127 || a === 0) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b! >= 16 && b! <= 31) return true
  if (a === 192 && b === 168) return true
  return a === 100 && b! >= 64 && b! <= 127
}

/** Reject anything that is not public HTTPS on an exact allowed hostname. */
export function assertSafeDownloadUrl(raw: string, allowedHosts?: readonly string[]): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`"${raw}" is not a valid URL`)
  }
  if (url.protocol !== 'https:') {
    throw new Error(`Only https:// links are accepted (got ${url.protocol}//)`)
  }
  if (url.username || url.password) throw new Error('URLs with credentials are not accepted')
  if (url.port && url.port !== '443') throw new Error('only the standard HTTPS port is accepted')
  const host = url.hostname.toLowerCase()
  if (isBlockedHost(host)) throw new Error('that address is not allowed')
  if (allowedHosts && !allowedHosts.some((candidate) => candidate.toLowerCase() === host)) {
    throw new Error(`downloads are not accepted from ${url.hostname}`)
  }
  return url
}

function declaredLength(response: Response): number | null {
  const raw = response.headers.get('content-length')
  if (raw === null) return null
  if (!/^(0|[1-9]\d*)$/.test(raw)) throw new Error('server returned an invalid content length')
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) throw new Error('server returned an invalid content length')
  return value
}

class DownloadCounter extends Transform {
  received = 0
  private lastProgress = 0

  constructor(
    private readonly maxBytes: number,
    private readonly totalBytes: number | null,
    private readonly onProgress?: DownloadOptions['onProgress']
  ) {
    super()
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void
  ): void {
    this.received += chunk.length
    if (this.received > this.maxBytes) {
      callback(new Error('download exceeded its byte limit'))
      return
    }
    const now = Date.now()
    if (now - this.lastProgress >= 200) {
      this.lastProgress = now
      this.onProgress?.(this.received, this.totalBytes)
    }
    callback(null, chunk)
  }
}

/**
 * Download to a newly-created private file. One deadline covers redirects and
 * body transfer; every failure, timeout, and caller abort removes the partial.
 */
export function downloadFile(url: string, dest: string, opts: DownloadOptions): DownloadHandle {
  if (!Number.isSafeInteger(opts.maxBytes) || opts.maxBytes <= 0) {
    throw new Error('download byte limit is invalid')
  }
  if (!Number.isSafeInteger(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new Error('download timeout is invalid')
  }
  const controller = new AbortController()
  let callerCancelled = false
  let timedOut = false
  const allowed = opts.allowedHosts ?? GITHUB_DOWNLOAD_HOSTS
  const firstUrl = assertSafeDownloadUrl(url, allowed)

  const done = (async (): Promise<void> => {
    const destination = await open(dest, 'wx', 0o600)
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('download deadline exceeded'))
    }, opts.timeoutMs)
    timer.unref?.()
    let succeeded = false
    try {
      let current = firstUrl
      let response: Response | null = null
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        response = await fetch(current, {
          redirect: 'manual',
          signal: controller.signal
        })
        if (response.status < 300 || response.status >= 400) break
        if (hop === MAX_REDIRECTS) throw new Error('too many redirects')
        const location = response.headers.get('location')
        await response.body?.cancel().catch(() => undefined)
        if (!location) throw new Error('server redirected without a location')
        current = assertSafeDownloadUrl(new URL(location, current).toString(), allowed)
      }
      if (!response) throw new Error('the server returned no response')
      if (!response.ok) {
        const rateRemaining = response.headers.get('x-ratelimit-remaining')
        const rateReset = response.headers.get('x-ratelimit-reset')
        const rate =
          response.status === 403 && rateRemaining === '0'
            ? `; GitHub rate limit exhausted${rateReset ? ` until ${rateReset}` : ''}`
            : ''
        throw new Error(
          `server replied ${response.status}${response.statusText ? ` ${response.statusText}` : ''}${rate}`
        )
      }
      const totalBytes = declaredLength(response)
      if (totalBytes !== null && totalBytes > opts.maxBytes) {
        throw new Error('download exceeds its byte limit')
      }
      if (!response.body) throw new Error('the server returned an empty response body')

      const counter = new DownloadCounter(opts.maxBytes, totalBytes, opts.onProgress)
      const output = destination.createWriteStream({ autoClose: true })
      const input = Readable.fromWeb(response.body as never)
      await pipeline(input, counter, output, { signal: controller.signal })
      opts.onProgress?.(counter.received, totalBytes)
      succeeded = true
    } catch (error) {
      if (callerCancelled) throw new Error('download was cancelled')
      if (timedOut) throw new Error('the download exceeded its deadline')
      throw error instanceof Error ? error : new Error(String(error))
    } finally {
      clearTimeout(timer)
      await destination.close().catch(() => undefined)
      if (!succeeded) {
        try {
          await rm(dest, { force: true })
        } catch (cleanupError) {
          throw new AggregateError(
            [cleanupError],
            'download failed and its partial file could not be removed'
          )
        }
      }
    }
  })()

  return {
    abort: () => {
      callerCancelled = true
      controller.abort(new Error('download was cancelled'))
    },
    done
  }
}

/**
 * Find a marker either at archive root or inside its only non-metadata folder.
 */
export function findArchiveRoot(dir: string, marker: string): string | null {
  if (existsSync(join(dir, marker))) return dir
  let dirs: string[]
  try {
    dirs = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== '__MACOSX')
      .map((entry) => entry.name)
  } catch {
    return null
  }
  if (dirs.length !== 1) return null
  const inner = join(dir, dirs[0]!)
  return existsSync(join(inner, marker)) ? inner : null
}
