import { once } from 'events'
import { createWriteStream, existsSync, readdirSync, unlinkSync } from 'fs'
import { join } from 'path'

/**
 * Downloading an archive over https. Shared by the app updater and the module
 * installer: both fetch a zip, both have to cap its size, time out and report
 * progress, and neither should reimplement that.
 */

export interface DownloadOptions {
  maxBytes: number
  timeoutMs: number
  onProgress?: (receivedBytes: number, totalBytes: number | null) => void
}

export interface DownloadHandle {
  /** Stop the transfer; the promise rejects with "download was cancelled". */
  abort(): void
  done: Promise<void>
}

export function downloadFile(url: string, dest: string, opts: DownloadOptions): DownloadHandle {
  const canceller = new AbortController()
  let cancelled = false
  const maxMb = Math.round(opts.maxBytes / 1024 / 1024)
  const tooLarge = (): Error => new Error(`the archive is larger than ${maxMb} MB`)

  const done = (async (): Promise<void> => {
    let file: ReturnType<typeof createWriteStream> | null = null
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.any([canceller.signal, AbortSignal.timeout(opts.timeoutMs)])
      })
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
