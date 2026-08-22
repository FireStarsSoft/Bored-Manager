import type { RequestHandler } from 'express'
import type { IncomingMessage } from 'http'
import { createServer } from 'http'
import { join } from 'path'
import { WebSocketServer, type WebSocket } from 'ws'
import { isAuthenticatedSession, unlock } from './auth'
import { internalErrorDetail } from './errors'
import { applyHttpServerLimits, createHttpApp } from './http'
import { cleanClose, currentSettings, registerRpc } from './ipc'
import {
  acquirePidFile,
  RequestTracker,
  withinDeadline
} from './lifecycle'
import { log, startLogSession } from './log'
import { RPC_LIMITS, RpcRouter } from './rpc'
import {
  deriveAllowedHostnames,
  requestHostAllowed,
  requestOriginAllowed
} from './security'
import { appRoot, dataDir, hardenDataPermissions } from './services/store'
import { ensureDefaultAdmin, sessionIsCurrent } from './services/users'
import { isOpenBind } from '@shared/types'

/**
 * The Bored Manager server: one Express app for the built renderer and the
 * few /api routes, one WebSocket endpoint (/ws) carrying the RPC that used to
 * be Electron IPC. Every browser on the network talks to this one process.
 */

const HEARTBEAT_MS = 30_000

// Run from a terminal on the host to clear the login lockout. It only touches a
// file, so it works whether or not a server is running.
if (process.argv[2] === 'unlock') {
  try {
    unlock()
    console.log('webUI unlocked')
    process.exit(0)
  } catch (error) {
    console.error(`could not unlock webUI: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

const root = appRoot()
startLogSession()
ensureDefaultAdmin()
hardenDataPermissions()

const pidLease = acquirePidFile(join(dataDir(), 'server.pid'))

/** `--port 9999 --host 127.0.0.1`, the only flags the server takes. */
function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 ? process.argv[at + 1] : undefined
}

function port(): number {
  const raw = flag('port') ?? process.env['BM_PORT']
  const value = Number.parseInt(raw ?? '', 10)
  if (Number.isInteger(value) && value > 0 && value < 65536) return value
  return currentSettings().server.port
}

function host(): string {
  return flag('host') ?? process.env['BM_HOST'] ?? currentSettings().server.host
}

const buildTime = typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : 'unknown'
const version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'
log(
  `starting Bored Manager ${version} (build ${buildTime}, node ${process.versions.node}, ` +
    `${process.platform} ${process.arch}, root ${root})`
)

const router = new RpcRouter(log)
const listenPort = port()
const listenHost = host()
const startupServerSettings = {
  ...currentSettings().server,
  port: listenPort,
  host: listenHost
}
const requestSecurity = {
  allowedHosts: deriveAllowedHostnames(startupServerSettings),
  devMode: process.env.BM_DEV === '1'
}
const requestTracker = new RequestTracker()
const { app, api, session: sessionMiddleware, sessions } = createHttpApp(
  root,
  currentSettings,
  { security: requestSecurity, requestTracker, logger: log }
)
const server = createServer(app)
applyHttpServerLimits(server)
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: RPC_LIMITS.maxPayload,
  perMessageDeflate: false
})

// A socket that stopped answering pings is gone even when TCP has not noticed;
// without this a laptop that was closed mid-session would hold pollers open.
const alive = new WeakSet<WebSocket>()

/**
 * Who an upgrade request is, according to its session cookie. The session
 * middleware is written for Express, but it only reads the cookie and loads
 * from the store - an upgrade never sends a response body, so a bare object
 * stands in for the one it would write to.
 */
function readSession(req: IncomingMessage): Promise<{
  username: string | null
  authVersion: number | null
  sid: string | null
}> {
  return new Promise((resolve) => {
    const request = req as unknown as Parameters<RequestHandler>[0]
    const response = {} as Parameters<RequestHandler>[1]
    sessionMiddleware(request, response, () =>
      resolve({
        username: request.session?.username ?? null,
        authVersion: request.session?.authVersion ?? null,
        sid: request.sessionID ?? null
      })
    )
  })
}

/**
 * Idle expiry over the socket. Every frame counts as activity, so the session
 * is read (which is where an expired one is noticed) and touched (which pushes
 * the deadline out) - the same thing an HTTP request does through `rolling`.
 */
router.authorize = async (client, activity) => {
  if (!currentSettings().auth.enabled) return true
  const sid = client.sessionId
  if (!sid) return false
  const data = await sessions.get(sid)
  if (
    !data?.username ||
    data.username !== client.username ||
    !sessionIsCurrent(data.username, data.authVersion)
  ) {
    void sessions.revokeSession(sid).catch(() => {})
    return false
  }
  if (activity && !(await sessions.touch(sid, data))) return false
  return true
}

let closing = false
server.on('upgrade', (req, socket, head) => {
  if (closing) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  if (!requestHostAllowed(req, requestSecurity.allowedHosts)) {
    socket.write('HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\n\r\n')
    socket.destroy()
    log('rejected a WebSocket upgrade with an untrusted Host')
    return
  }
  let pathname = '/'
  try {
    pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  } catch {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  if (pathname !== '/ws') {
    socket.destroy()
    return
  }
  void (async () => {
    if (!requestOriginAllowed(req, requestSecurity)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      log('rejected a WebSocket upgrade from another origin')
      return
    }
    // The socket carries every call the UI makes, so it is gated exactly like
    // /api is: no valid session while a login is required means no socket.
    const found = await readSession(req)
    if (currentSettings().auth.enabled && !isAuthenticatedSession(found)) {
      if (found.sid) void sessions.revokeSession(found.sid).catch(() => {})
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      log('rejected a WebSocket upgrade without a session')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, found))
  })().catch((error) => {
    log(`failed to authorize a WebSocket upgrade: ${String(error)}`)
    try {
      socket.write('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n')
    } catch {
      // The peer may already have gone away.
    }
    socket.destroy()
  })
})

wss.on(
  'connection',
  (
    ws,
    _req,
    found?: { username: string | null; authVersion: number | null; sid: string | null }
  ) => {
    const client = router.attach(ws)
    client.username = found?.username ?? null
    client.sessionId = found?.sid ?? null
    alive.add(ws)
    ws.on('pong', () => alive.add(ws))
    log(`client ${client.id} connected (${wss.clients.size} total)`)
    // ws has already dropped the socket from wss.clients by the time this fires.
    ws.on('close', () => log(`client ${client.id} disconnected (${wss.clients.size} left)`))
  }
)

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!alive.has(ws)) {
      ws.terminate()
      continue
    }
    alive.delete(ws)
    ws.ping()
  }
}, HEARTBEAT_MS)
heartbeat.unref()

router.registerHandler('app:ping', () => 'pong')
registerRpc(router, api, sessions)

let shutdownPromise: Promise<void> | null = null

function closeHttpListener(): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve()
      return
    }
    server.close((error) => {
      if (error) log(`HTTP close reported: ${internalErrorDetail(error)}`)
      resolve()
    })
    server.closeIdleConnections?.()
  })
}

function closeWebSockets(): Promise<void> {
  return new Promise((resolve) => {
    router.closeAll(1001, 'server shutting down')
    try {
      wss.close((error) => {
        if (error) log(`WebSocket close reported: ${internalErrorDetail(error)}`)
        resolve()
      })
    } catch (error) {
      log(`WebSocket close failed: ${internalErrorDetail(error)}`)
      resolve()
    }
  })
}

function requestShutdown(reason: string, requestedCode: number): Promise<void> {
  if (requestedCode !== 0) process.exitCode = requestedCode
  if (shutdownPromise) return shutdownPromise
  closing = true
  log(`${reason} - stopping new work and draining clients`)
  clearInterval(heartbeat)
  requestTracker.stopAccepting()
  router.stopAccepting()
  const httpClosed = closeHttpListener()

  shutdownPromise = (async () => {
    try {
      const drained = await withinDeadline(
        Promise.all([router.drain(), requestTracker.drain()]),
        5_000
      )
      if (!drained) log('shutdown drain deadline reached; closing remaining clients')

      const socketsClosed = closeWebSockets()
      const networkClosed = await withinDeadline(
        Promise.all([httpClosed, socketsClosed]),
        2_000
      )
      if (!networkClosed) {
        log('network close deadline reached; terminating remaining connections')
        router.terminateAll()
        server.closeAllConnections?.()
      }

      const cleaned = await withinDeadline(
        cleanClose().catch((error) => {
          log(`clean close failed: ${internalErrorDetail(error)}`)
          throw error
        }),
        10_000
      )
      log(cleaned ? 'clean close done' : 'clean close deadline reached')
    } catch (error) {
      log(`shutdown failed: ${internalErrorDetail(error)}`)
      process.exitCode = process.exitCode || 1
    } finally {
      pidLease.release()
      process.exit(process.exitCode || 0)
    }
  })()
  return shutdownPromise
}

process.on('uncaughtException', (error) => {
  log(`FATAL uncaughtException: ${internalErrorDetail(error)}`)
  void requestShutdown('fatal uncaught exception', 1)
})
process.on('unhandledRejection', (reason) => {
  log(`FATAL unhandledRejection: ${internalErrorDetail(reason)}`)
  void requestShutdown('fatal unhandled rejection', 1)
})

server.listen(listenPort, listenHost, () => {
  log(`listening on http://${listenHost}:${listenPort}`)
  if (isOpenBind(listenHost) && !currentSettings().auth.enabled) {
    log(
      'WARNING: login is off and the server is bound to every interface - ' +
        'anyone who can reach this address has full access. Enable login in Settings, ' +
        'or bind 127.0.0.1.'
    )
  }
})
server.on('error', (err) => {
  log(`FATAL server error: ${internalErrorDetail(err)}`)
  void requestShutdown('server error', 1)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    const code =
      typeof process.exitCode === 'number'
        ? process.exitCode
        : Number.parseInt(process.exitCode ?? '', 10) || 0
    void requestShutdown(`received ${signal}`, code)
  })
}
