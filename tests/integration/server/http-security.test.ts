import { createServer, request as nodeRequest, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Express } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types'
import { readLock, registerAuthRoutes } from '../../../server/auth'
import { createHttpApp } from '../../../server/http'
import { resetStoreCacheForTests } from '../../../server/services/store'
import { createTestTempDir, type TestTempDir } from '../../helpers/temp-dir'

interface HttpResult {
  status: number
  headers: IncomingHttpHeaders
  body: string
  json: Record<string, unknown>
}

async function send(
  port: number,
  path: string,
  options: {
    method?: string
    host?: string
    origin?: string
    headers?: Record<string, string>
    body?: string
  } = {}
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = nodeRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: {
          Host: options.host ?? `127.0.0.1:${port}`,
          ...(options.origin ? { Origin: options.origin } : {}),
          ...(options.headers ?? {})
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          let json: Record<string, unknown> = {}
          try {
            json = JSON.parse(body) as Record<string, unknown>
          } catch {
            // Static/plain-text responses are not used for JSON assertions.
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json })
        })
      }
    )
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

async function withServer<T>(app: Express, run: (port: number) => Promise<T>): Promise<T> {
  const server = createServer(app)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    return await run((server.address() as AddressInfo).port)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe.sequential('HTTP Host, CSRF, and error boundary', () => {
  let temp: TestTempDir

  beforeEach(() => {
    temp = createTestTempDir('http-security')
    vi.stubEnv('BM_APP_ROOT', temp.path)
    resetStoreCacheForTests()
  })

  afterEach(() => {
    resetStoreCacheForTests()
    temp.cleanup()
  })

  function build(settings: AppSettings, logger = vi.fn()) {
    const created = createHttpApp(temp.path, () => settings, {
      security: {
        allowedHosts: new Set(['localhost', '127.0.0.1', 'manager.example.test'])
      },
      logger
    })
    return { ...created, logger }
  }

  it('allows configured Hosts and rejects untrusted Hosts before API/static handling', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS)
    const { app, api } = build(settings)
    api.get('/probe', (_req, res) => res.json({ ok: true }))

    await withServer(app, async (port) => {
      const allowed = await send(port, '/api/probe', {
        host: `manager.example.test:${port}`
      })
      expect(allowed.status).toBe(200)

      const rejectedApi = await send(port, '/api/probe', { host: `evil.test:${port}` })
      expect(rejectedApi.status).toBe(421)
      expect(rejectedApi.json).toMatchObject({ code: 'INVALID_HOST' })

      const rejectedStatic = await send(port, '/', { host: `evil.test:${port}` })
      expect(rejectedStatic.status).toBe(421)
    })
  })

  it('rejects cross-origin login and wrong content types before lockout accounting', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS)
    settings.auth.enabled = true
    const { app, api } = build(settings)
    registerAuthRoutes(api, () => settings)

    await withServer(app, async (port) => {
      const crossOrigin = await send(port, '/api/auth/login', {
        method: 'POST',
        host: `localhost:${port}`,
        origin: 'https://evil.example',
        headers: { 'content-type': 'application/json' },
        body: '{"username":"bored-admin","password":"wrong"}'
      })
      expect(crossOrigin.status).toBe(403)
      expect(crossOrigin.json).toMatchObject({ code: 'CSRF_REJECTED' })

      const form = await send(port, '/api/auth/login', {
        method: 'POST',
        host: `localhost:${port}`,
        origin: `http://localhost:${port}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'username=bored-admin&password=wrong'
      })
      expect(form.status).toBe(415)
      expect(form.json).toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' })
    })

    expect(readLock()).toEqual({ version: 2, users: {}, ips: {} })
  })

  it('returns JSON for malformed bodies, exact API 404s, and unexpected errors', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS)
    const logger = vi.fn()
    const { app, api } = build(settings, logger)
    registerAuthRoutes(api, () => settings)
    api.get('/explode', () => {
      throw new Error('secret at C:\\private\\credentials.json')
    })

    await withServer(app, async (port) => {
      const malformed = await send(port, '/api/auth/login', {
        method: 'POST',
        host: `localhost:${port}`,
        origin: `http://localhost:${port}`,
        headers: { 'content-type': 'application/json' },
        body: '{"username":'
      })
      expect(malformed.status).toBe(400)
      expect(malformed.json).toMatchObject({
        code: 'MALFORMED_JSON',
        error: 'Malformed JSON'
      })

      const nonBrowser = await send(port, '/api/auth/login', {
        method: 'POST',
        host: `localhost:${port}`,
        headers: { 'content-type': 'application/json' },
        body: '{"username":"bored-admin","password":"unused"}'
      })
      expect(nonBrowser.status).toBe(400)
      expect(nonBrowser.json).toMatchObject({
        error: 'login is not required on this server'
      })

      for (const path of ['/api', '/api/missing']) {
        const missing = await send(port, path)
        expect(missing.status).toBe(404)
        expect(missing.json).toMatchObject({ code: 'NOT_FOUND' })
      }

      const exploded = await send(port, '/api/explode')
      expect(exploded.status).toBe(500)
      expect(exploded.json).toEqual({
        ok: false,
        code: 'INTERNAL_ERROR',
        error: 'Internal server error'
      })
      expect(exploded.body).not.toContain('private')
    })

    expect(logger).toHaveBeenCalledWith(expect.stringContaining('credentials.json'))
  })

  it('uses HttpOnly/SameSite cookies and secure auto only through a trusted local proxy', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS)
    settings.server.trustProxy = true
    const { app, api } = build(settings)
    api.get('/session', (req, res) => {
      req.session.username = 'bored-admin'
      res.json({ ok: true })
    })

    expect(app.get('trust proxy')).toBe('loopback')
    await withServer(app, async (port) => {
      const response = await send(port, '/api/session', {
        headers: { 'x-forwarded-proto': 'https' }
      })
      const cookie = response.headers['set-cookie']?.join('; ') ?? ''
      expect(cookie).toContain('bm.sid=')
      expect(cookie).toContain('HttpOnly')
      expect(cookie).toContain('SameSite=Lax')
      expect(cookie).toContain('Secure')
    })

    const direct = structuredClone(DEFAULT_SETTINGS)
    const second = build(direct)
    second.api.get('/session', (req, res) => {
      req.session.username = 'bored-admin'
      res.json({ ok: true })
    })
    expect(second.app.get('trust proxy')).toBe(false)
    await withServer(second.app, async (port) => {
      const response = await send(port, '/api/session', {
        headers: { 'x-forwarded-proto': 'https' }
      })
      const cookie = response.headers['set-cookie']?.join('; ') ?? ''
      expect(cookie).toContain('HttpOnly')
      expect(cookie).not.toContain('Secure')
    })
  })
})
