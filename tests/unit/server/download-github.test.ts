import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertSafeDownloadUrl,
  downloadFile
} from '../../../server/services/download'
import {
  defaultBranchZipUrl,
  GITHUB_API_MAX_BYTES,
  GITHUB_API_TIMEOUT_MS,
  latestReleaseZip
} from '../../../server/services/github'
import { withTestTempDir } from '../../helpers/temp-dir'

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('aborted', 'AbortError'))
      },
      { once: true }
    )
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('downloadFile', () => {
  it('uses one absolute deadline across redirect hops and removes the partial', async () => {
    await withTestTempDir(async (root) => {
      let requests = 0
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: URL, init: RequestInit) => {
          await abortableDelay(30, init.signal as AbortSignal)
          requests += 1
          if (requests === 1) {
            return new Response(null, {
              status: 302,
              headers: { location: 'https://example.com/final' }
            })
          }
          return new Response('late')
        })
      )
      const dest = join(root, 'archive.zip')
      const transfer = downloadFile('https://example.com/start', dest, {
        maxBytes: 1024,
        timeoutMs: 45,
        allowedHosts: ['example.com']
      })
      await expect(transfer.done).rejects.toThrow(/deadline/)
      expect(requests).toBe(1)
      expect(existsSync(dest)).toBe(false)
    }, 'download-deadline')
  })

  it('caps actual streamed bytes without trusting content-length', async () => {
    await withTestTempDir(async (root) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(new Uint8Array(32)))
      )
      const dest = join(root, 'archive.zip')
      const transfer = downloadFile('https://example.com/archive', dest, {
        maxBytes: 8,
        timeoutMs: 1_000,
        allowedHosts: ['example.com']
      })
      await expect(transfer.done).rejects.toThrow(/byte limit/)
      expect(existsSync(dest)).toBe(false)
    }, 'download-cap')
  })

  it('rejects unsafe redirects before requesting them', async () => {
    await withTestTempDir(async (root) => {
      const fetchMock = vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: 'https://evil.example/archive.zip' }
          })
      )
      vi.stubGlobal('fetch', fetchMock)
      const dest = join(root, 'archive.zip')
      const transfer = downloadFile('https://example.com/start', dest, {
        maxBytes: 1024,
        timeoutMs: 1_000,
        allowedHosts: ['example.com']
      })
      await expect(transfer.done).rejects.toThrow(/not accepted/)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(existsSync(dest)).toBe(false)
    }, 'download-redirect')
  })

  it('caller abort cancels the pipeline and removes the partial', async () => {
    await withTestTempDir(async (root) => {
      let streamCancelled = false
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          const body = new ReadableStream<Uint8Array>({
            pull: () => new Promise(() => undefined),
            cancel: () => {
              streamCancelled = true
            }
          })
          return new Response(body)
        })
      )
      const dest = join(root, 'archive.zip')
      const transfer = downloadFile('https://example.com/archive', dest, {
        maxBytes: 1024,
        timeoutMs: 1_000,
        allowedHosts: ['example.com']
      })
      await new Promise((resolve) => setTimeout(resolve, 5))
      transfer.abort()
      await expect(transfer.done).rejects.toThrow(/cancelled/)
      expect(existsSync(dest)).toBe(false)
      expect(streamCancelled).toBe(true)
    }, 'download-abort')
  })

  it('creates the destination exclusively and preserves an existing file', async () => {
    await withTestTempDir(async (root) => {
      const dest = join(root, 'archive.zip')
      writeFileSync(dest, 'existing')
      vi.stubGlobal('fetch', vi.fn())
      const transfer = downloadFile('https://example.com/archive', dest, {
        maxBytes: 1024,
        timeoutMs: 1_000,
        allowedHosts: ['example.com']
      })
      await expect(transfer.done).rejects.toThrow()
      expect(readFileSync(dest, 'utf8')).toBe('existing')
      expect(fetch).not.toHaveBeenCalled()
    }, 'download-exclusive')
  })

  it('writes a successful response and reports final progress', async () => {
    await withTestTempDir(async (root) => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('archive')))
      const progress = vi.fn()
      const dest = join(root, 'archive.zip')
      await downloadFile('https://example.com/archive', dest, {
        maxBytes: 1024,
        timeoutMs: 1_000,
        allowedHosts: ['example.com'],
        onProgress: progress
      }).done
      expect(readFileSync(dest, 'utf8')).toBe('archive')
      expect(progress).toHaveBeenLastCalledWith(7, null)
    }, 'download-success')
  })

  it('requires exact HTTPS host and port matches', () => {
    expect(() =>
      assertSafeDownloadUrl('https://example.com.evil.test/file', ['example.com'])
    ).toThrow(/not accepted/)
    expect(() => assertSafeDownloadUrl('https://example.com:444/file', ['example.com'])).toThrow(
      /standard HTTPS port/
    )
    expect(() => assertSafeDownloadUrl('http://example.com/file', ['example.com'])).toThrow(
      /https/
    )
  })
})

describe('GitHub archive resolution', () => {
  it('bounds GitHub API requests by time and actual response bytes', async () => {
    let requestSignal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        requestSignal = init?.signal as AbortSignal | undefined
        return new Response(new Uint8Array(GITHUB_API_MAX_BYTES + 1))
      })
    )

    await expect(defaultBranchZipUrl('owner/repo')).rejects.toThrow(/byte limit/)
    expect(requestSignal).toBeInstanceOf(AbortSignal)
    expect(GITHUB_API_TIMEOUT_MS).toBe(15_000)
  })

  it('does not silently guess main when default-branch lookup fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
            status: 403,
            headers: {
              'content-type': 'application/json',
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': '12345'
            }
          })
      )
    )
    await expect(defaultBranchZipUrl('owner/repo')).rejects.toThrow(
      /rate limit exceeded.*rate limit exhausted/i
    )
  })

  it('uses the declared default branch exactly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ default_branch: 'release/next' })
      )
    )
    await expect(defaultBranchZipUrl('owner/repo')).resolves.toBe(
      'https://codeload.github.com/owner/repo/zip/refs/heads/release%2Fnext'
    )
  })

  it('rejects ambiguous matching release assets', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          tag_name: 'v1.2.3',
          assets: [
            { name: 'one.zip', browser_download_url: 'https://github.com/one.zip' },
            { name: 'two.zip', browser_download_url: 'https://github.com/two.zip' }
          ]
        })
      )
    )
    await expect(latestReleaseZip('owner/repo')).rejects.toThrow(/multiple matching ZIP assets/)
  })

  it('returns the sole exact matching release asset', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          tag_name: 'v1.2.3',
          body: 'notes',
          assets: [
            { name: 'source.zip', browser_download_url: 'https://github.com/source.zip' },
            { name: 'app-linux.zip', browser_download_url: 'https://github.com/app.zip' }
          ]
        })
      )
    )
    await expect(
      latestReleaseZip('owner/repo', (name) => name === 'app-linux.zip')
    ).resolves.toEqual({
      url: 'https://github.com/app.zip',
      version: '1.2.3',
      notes: 'notes',
      matched: true
    })
  })
})
