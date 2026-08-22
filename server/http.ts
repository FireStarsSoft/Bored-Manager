import express, {
  Router,
  type ErrorRequestHandler,
  type Express,
  type RequestHandler
} from 'express'
import type { Server as HttpServer } from 'node:http'
import session, { type Store as SessionStore } from 'express-session'
import FileStoreFactory from 'session-file-store'
import { join } from 'path'
import type { AppSettings } from '@shared/types'
import { idleMs, requireSession } from './auth'
import {
  PublicError,
  internalErrorDetail,
  publicErrorPayload
} from './errors'
import type { RequestTracker } from './lifecycle'
import {
  expressTrustProxySetting,
  requireAllowedHost,
  requireSameOriginApi,
  type RequestSecurity
} from './security'
import { ensureSecretKey } from './services/secret'
import { dataDir, ensurePrivateDir } from './services/store'
import { SessionController } from './sessions'

/**
 * The HTTP half of the server: the built renderer as static files, an SPA
 * fallback so a reload of any in-app route still lands on index.html, and an
 * `/api` router for the few things a WebSocket cannot do (file download and
 * upload, and logging in). The routes themselves are added by registerRpc() in
 * server/ipc.ts and registerAuthRoutes() in server/auth.ts.
 */

/** The `/api` router. Handed to registerRpc(), which mounts its routes on it. */
export type HttpApi = Router

export const HTTP_LIMITS = {
  maxHeadersCount: 100,
  headersTimeoutMs: 15_000,
  requestTimeoutMs: 15 * 60 * 1000,
  keepAliveTimeoutMs: 5_000,
  maxRequestsPerSocket: 1_000,
  maxConnections: 128
} as const

export function applyHttpServerLimits(server: HttpServer): void {
  server.maxHeadersCount = HTTP_LIMITS.maxHeadersCount
  server.headersTimeout = HTTP_LIMITS.headersTimeoutMs
  server.requestTimeout = HTTP_LIMITS.requestTimeoutMs
  server.keepAliveTimeout = HTTP_LIMITS.keepAliveTimeoutMs
  server.maxRequestsPerSocket = HTTP_LIMITS.maxRequestsPerSocket
  server.maxConnections = HTTP_LIMITS.maxConnections
}

/** Ten years: "no idle timeout" still needs a number for the session store. */
const FOREVER_MS = 10 * 365 * 24 * 60 * 60 * 1000

/**
 * Mirrors the meta tag in src/index.html, plus the WebSocket origins the
 * client connects back to. Sent on every response, so it also covers the
 * static assets.
 */
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'"

/**
 * The session middleware, also used by the WebSocket upgrade so both halves
 * agree on who is connected. Rolling expiry: every request or RPC call pushes
 * the deadline out, which is what "idle timeout" means.
 */
export function createSessionMiddleware(settings: AppSettings): {
  middleware: RequestHandler
  store: SessionStore
  sessions: SessionController
} {
  const FileStore = FileStoreFactory(session)
  const ms = idleMs(settings.auth.sessionIdle)
  const sessionsDir = join(dataDir(), 'sessions')
  ensurePrivateDir(sessionsDir)
  const store = new FileStore({
    path: sessionsDir,
    ttl: Math.round((ms || FOREVER_MS) / 1000),
    retries: 1,
    // The store prints a stack trace for every session file it cannot find,
    // which is every expired cookie. Keep the log about the app.
    logFn: () => {}
  })
  const middleware = session({
    name: 'bm.sid',
    secret: ensureSecretKey().toString('hex'),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: 'auto',
      path: '/',
      // No idle timeout means a cookie without an expiry date, so closing the
      // browser is the only thing that ends the session.
      maxAge: ms || undefined
    }
  })
  return { middleware, store, sessions: new SessionController(store, sessionsDir) }
}

export interface HttpAppOptions {
  security: RequestSecurity
  requestTracker?: RequestTracker
  logger?: (message: string) => void
}

export function createHttpApp(
  appRoot: string,
  settings: () => AppSettings,
  options: HttpAppOptions
): {
  app: Express
  api: HttpApi
  session: RequestHandler
  sessionStore: SessionStore
  sessions: SessionController
} {
  const app = express()
  const api: HttpApi = Router()
  const initialSettings = settings()
  app.set('trust proxy', expressTrustProxySetting(initialSettings.server.trustProxy))
  const {
    middleware: sessionMiddleware,
    store: sessionStore,
    sessions
  } = createSessionMiddleware(initialSettings)
  const rendererDir = join(appRoot, 'out', 'renderer')
  const indexFile = join(rendererDir, 'index.html')

  app.disable('x-powered-by')
  if (options.requestTracker) app.use(options.requestTracker.middleware)
  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', CSP)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    next()
  })
  app.use(requireAllowedHost(options.security))
  app.use('/api', requireSameOriginApi(options.security))
  app.use(express.json({ limit: '2mb' }))
  app.use(sessionMiddleware)
  app.use('/api', requireSession(settings), api)
  app.use('/api', (_req, res) => {
    res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'API route not found' })
  })
  app.use(express.static(rendererDir))

  // Everything that is not /api/ is the SPA - served whether or not anyone is
  // logged in, because the login form is part of it. Anything under /api/ that
  // no route claimed has to keep returning 404 instead of quietly serving
  // index.html.
  app.get(/^\/(?!api(?:\/|$)).*/, (_req, res) => {
    res.sendFile(indexFile, (err) => {
      if (err && !res.headersSent) {
        res.status(500).type('text/plain').send('the renderer has not been built yet')
      }
    })
  })

  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    const detail = error as {
      type?: unknown
      status?: unknown
      statusCode?: unknown
    }
    if (detail.type === 'entity.parse.failed') {
      res.status(400).json({ ok: false, code: 'MALFORMED_JSON', error: 'Malformed JSON' })
      return
    }
    if (detail.type === 'entity.too.large') {
      res.status(413).json({ ok: false, code: 'REQUEST_TOO_LARGE', error: 'Request body is too large' })
      return
    }

    if (!(error instanceof PublicError)) {
      options.logger?.(`HTTP request failed: ${internalErrorDetail(error)}`)
    }
    const exposed = publicErrorPayload(error)
    res.status(exposed.status).json({
      ok: false,
      code: exposed.code,
      error: exposed.message
    })
  }
  app.use(errors)

  return { app, api, session: sessionMiddleware, sessionStore, sessions }
}
