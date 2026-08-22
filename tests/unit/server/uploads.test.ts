import { createServer } from 'node:http'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  utimesSync
} from 'node:fs'
import type { AddressInfo } from 'node:net'
import { basename, join } from 'node:path'
import express from 'express'
import { describe, expect, it } from 'vitest'
import {
  PrivateUploadStaging,
  UPLOAD_DIRECTORY_PREFIX
} from '../../../server/uploads'
import { withTestTempDir } from '../../helpers/temp-dir'

async function withUploadServer<T>(
  staging: PrivateUploadStaging,
  configure: (app: express.Express) => void,
  run: (baseUrl: string) => Promise<T>
): Promise<T> {
  const app = express()
  configure(app)
  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = (server.address() as AddressInfo).port
    return await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    staging.dispose()
  }
}

function form(contents: string, extraField = false): FormData {
  const data = new FormData()
  data.append('file', new Blob([contents]), 'predictable-settings.json')
  if (extraField) data.append('extra', 'not allowed')
  return data
}

describe('private upload staging', () => {
  it('uses random private files and removes the request directory after success', async () => {
    await withTestTempDir(async (baseDir) => {
      const staging = new PrivateUploadStaging(2, baseDir)
      let stagedPath = ''
      await withUploadServer(
        staging,
        (app) => {
          app.post('/upload', staging.singleFile(1024), (req, res) => {
            stagedPath = req.file?.path ?? ''
            res.json({
              name: basename(stagedPath),
              exists: existsSync(stagedPath),
              mode: statSync(stagedPath).mode & 0o777
            })
          })
        },
        async (baseUrl) => {
          const response = await fetch(`${baseUrl}/upload`, {
            method: 'POST',
            body: form('private settings')
          })
          expect(response.status).toBe(200)
          const result = (await response.json()) as {
            name: string
            exists: boolean
            mode: number
          }
          expect(result.exists).toBe(true)
          expect(result.name).toMatch(/^[0-9a-f]{48}$/)
          expect(result.name).not.toContain('settings')
          if (process.platform !== 'win32') expect(result.mode).toBe(0o600)
          expect(existsSync(stagedPath)).toBe(false)
          expect(readdirSync(staging.root)).toEqual([])
        }
      )
      expect(existsSync(staging.root)).toBe(false)
    }, 'uploads-private')
  })

  it('enforces file/part limits and cleans partial files', async () => {
    await withTestTempDir(async (baseDir) => {
      const staging = new PrivateUploadStaging(2, baseDir)
      await withUploadServer(
        staging,
        (app) => {
          app.post('/upload', staging.singleFile(8), (_req, res) => res.json({ ok: true }))
        },
        async (baseUrl) => {
          const tooLarge = await fetch(`${baseUrl}/upload`, {
            method: 'POST',
            body: form('123456789')
          })
          expect(tooLarge.status).toBe(413)
          await expect(tooLarge.json()).resolves.toMatchObject({ code: 'UPLOAD_TOO_LARGE' })
          expect(readdirSync(staging.root)).toEqual([])

          const extraPart = await fetch(`${baseUrl}/upload`, {
            method: 'POST',
            body: form('small', true)
          })
          expect(extraPart.status).toBe(400)
          await expect(extraPart.json()).resolves.toMatchObject({ code: 'INVALID_UPLOAD' })
          expect(readdirSync(staging.root)).toEqual([])
        }
      )
    }, 'uploads-limits')
  })

  it('applies a global concurrency quota', async () => {
    await withTestTempDir(async (baseDir) => {
      const staging = new PrivateUploadStaging(1, baseDir)
      let entered!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      await withUploadServer(
        staging,
        (app) => {
          app.post('/upload', staging.singleFile(1024), async (_req, res) => {
            entered()
            await gate
            res.json({ ok: true })
          })
        },
        async (baseUrl) => {
          const first = fetch(`${baseUrl}/upload`, { method: 'POST', body: form('first') })
          await started
          expect(staging.activeUploads).toBe(1)

          const second = await fetch(`${baseUrl}/upload`, {
            method: 'POST',
            body: form('second')
          })
          expect(second.status).toBe(429)
          await expect(second.json()).resolves.toMatchObject({ code: 'UPLOAD_BUSY' })

          release()
          expect((await first).status).toBe(200)
          expect(staging.activeUploads).toBe(0)
          expect(readdirSync(staging.root)).toEqual([])
        }
      )
    }, 'uploads-quota')
  })

  it('removes stale process staging directories on startup and its own on shutdown', async () => {
    await withTestTempDir((baseDir) => {
      const stale = join(baseDir, `${UPLOAD_DIRECTORY_PREFIX}stale`)
      mkdirSync(stale)
      const old = new Date(Date.now() - 48 * 60 * 60 * 1000)
      utimesSync(stale, old, old)

      const staging = new PrivateUploadStaging(1, baseDir)
      expect(existsSync(stale)).toBe(false)
      expect(existsSync(staging.root)).toBe(true)
      staging.dispose()
      expect(existsSync(staging.root)).toBe(false)
    }, 'uploads-stale')
  })
})
