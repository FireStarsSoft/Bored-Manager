import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import express from 'express'
import { describe, expect, it } from 'vitest'
import {
  acquirePidFile,
  RequestTracker
} from '../../../server/lifecycle'
import { withTestTempDir } from '../../helpers/temp-dir'

describe('PID ownership', () => {
  it('claims exclusively, rejects a live owner, and reclaims a stale owner', async () => {
    await withTestTempDir((root) => {
      const path = join(root, 'data', 'server.pid')
      const first = acquirePidFile(path, 101, (pid) => pid === 101)
      expect(readFileSync(path, 'utf8')).toBe('101')
      expect(() => acquirePidFile(path, 202, (pid) => pid === 101)).toThrow(
        /already running/
      )

      first.release()
      writeFileSync(path, '303', 'utf8')
      const replacement = acquirePidFile(path, 202, () => false)
      expect(readFileSync(path, 'utf8')).toBe('202')
      replacement.release()
    }, 'pid')
  })

  it('only removes the PID file it still owns', async () => {
    await withTestTempDir((root) => {
      const path = join(root, 'server.pid')
      const lease = acquirePidFile(path, 101, () => false)
      writeFileSync(path, '202', 'utf8')
      lease.release()
      expect(readFileSync(path, 'utf8')).toBe('202')
    }, 'pid-owner')
  })
})

describe('RequestTracker drain', () => {
  it('rejects new HTTP work and resolves only after active work finishes', async () => {
    const tracker = new RequestTracker()
    const app = express()
    app.use(tracker.middleware)
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    app.get('/slow', async (_req, res) => {
      entered()
      await gate
      res.json({ ok: true })
    })
    app.get('/fast', (_req, res) => res.json({ ok: true }))

    const server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    try {
      const first = fetch(`http://127.0.0.1:${port}/slow`)
      await started
      expect(tracker.activeRequests).toBe(1)

      tracker.stopAccepting()
      const rejected = await fetch(`http://127.0.0.1:${port}/fast`)
      expect(rejected.status).toBe(503)
      await expect(rejected.json()).resolves.toMatchObject({
        code: 'SERVER_SHUTTING_DOWN'
      })

      let drained = false
      void tracker.drain().then(() => {
        drained = true
      })
      await Promise.resolve()
      expect(drained).toBe(false)

      release()
      await first
      await tracker.drain()
      expect(drained).toBe(true)
      expect(tracker.activeRequests).toBe(0)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
