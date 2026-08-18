import { once } from 'events'
import { createWriteStream, existsSync, readdirSync, unlinkSync } from 'fs'
import { isIP } from 'net'
import { join } from 'path'

/**
 * Downloading an archive over https. Shared by the app updater and the module
 * installer: both fetch a zip, both have to cap its size, time out and report
 * progress, and neither should reimplement that.
 *
 * Hosts are allowlisted (GitHub and its download CDNs). Redirects are followed
 * only when the next hop is still on that list, so a release URL cannot be
 * turned into a request against an internal address.
 */

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
  /** When set, every hop (including redirects) must be one of these hosts. */
  allowedHosts?: readonly string[]
}

export interface DownloadHandle {
  /** Stop the transfer; the promise rejects with "download was cancelled". */
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
    if (compact === '::1') return true
    if (compact.startsWith('fe80:') || compact.startsWith('fc') || compact.startsWith('fd')) return true
    return false
  }
  const [a, b] = ip.split('.').map((n) => Number(n))
  if (a === 10 || a === 127 || a === 0) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

/** Reject anything that is not a public https URL on an allowed host. */
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
  if (url.username || url.password) {
    throw new Error('URLs with credentials are not accepted')
  }
  const host = url.hostname.toLowerCase()
  if (isBlockedHost(host)) {
    throw new Error('that address is not allowed')
  }
  if (allowedHosts && !allowedHosts.includes(host)) {
    throw new Error(`downloads are only accepted from GitHub (got ${url.hostname})`)
  }
  return url
}

export function downloadFile(url: string, dest: string, opts: DownloadOptions): DownloadHandle {
  const canceller = new AbortController()
  let cancelled = false
  const maxMb = Math.round(opts.maxBytes / 1024 / 1024)
  const tooLarge = (): Error => new Error(`the archive is larger than ${maxMb} MB`)
  const allowed = opts.allowedHosts ?? GITHUB_DOWNLOAD_HOSTS

  const done = (async (): Promise<void> => {
    let file: ReturnType<typeof createWriteStream> | null = null
    try {
      let current = assertSafeDownloadUrl(url, allowed).toString()
      let response: Response | null = null
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        response = await fetch(current, {
          redirect: 'manual',
          signal: AbortSignal.any([canceller.signal, AbortSignal.timeout(opts.timeoutMs)])
        })
        if (response.status >= 300 && response.status < 400) {
          const loc = response.headers.get('location')
          if (!loc) throw new Error('server redirected without a location')
          current = assertSafeDownloadUrl(new URL(loc, current).toString(), allowed).toString()
          continue
        }
        break
      }
      if (!response) throw new Error('nothing was written')
      if (response.status >= 300 && response.status < 400) {
        throw new Error('too many redirects')
      }
      if (response.status >= 400) {
        throw new Error(`server replied ${response.status} (check the link)`)
      }
      const declared = parseInt(response.headers.get('content-length') ?? '', 10)
      const totalBytes = Number.isFinite(declared) && declared > 0 ? declared : null
      if (totalBytes && totalBytes > opts.maxBytes) throw tooLarge()
      if (!response.body) throw new Error('nothing was written')

      file = createWriteStream(dest)
      const reader = response.body.getReader()
      let received = 0
      let lastPush = 0
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        received += chunk.value.byteLength
        if (received > opts.maxBytes) {
          await reader.cancel()
          throw tooLarge()
        }
        // Writing faster than the disk accepts would buffer the whole archive
        // in memory, so wait for drain whenever the stream says it is full.
        if (!file.write(chunk.value)) await once(file, 'drain')
        const now = Date.now()
        if (now - lastPush > 200) {
          lastPush = now
          opts.onProgress?.(received, totalBytes)
        }
      }
      opts.onProgress?.(received, totalBytes)
      await new Promise<void>((resolve, reject) => {
        file?.end(() => resolve())
        file?.on('error', reject)
      })
    } catch (err) {
      file?.destroy()
      try {
        if (existsSync(dest)) unlinkSync(dest)
      } catch {
        /* best effort */
      }
      if (cancelled) throw new Error('download was cancelled')
      // fetch() reports both a caller abort and the timeout as AbortError.
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Error('the server took too long to respond')
      }
      throw err instanceof Error ? err : new Error(String(err))
    }
  })()

  return {
    abort: () => {
      cancelled = true
      canceller.abort()
    },
    done
  }
}

/**
 * Where the real content of an extracted archive starts. GitHub wraps source
 * archives in a single folder (`repo-branch/`), release assets and hand-made
 * zips usually do not - both shapes are accepted, identified by a marker file
 * (`package.json` for the app, `module.json` for a module).
 */
export function findArchiveRoot(dir: string, marker: string): string | null {
  if (existsSync(join(dir, marker))) return dir
  let dirs: string[]
  try {
    dirs = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== '__MACOSX')
      .map((e) => e.name)
  } catch {
    return null
  }
  if (dirs.length !== 1) return null
  const inner = join(dir, dirs[0])
  return existsSync(join(inner, marker)) ? inner : null
}
