import type { RequestHandler } from 'express'
import type { IncomingMessage } from 'http'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { createServer } from 'http'
import { join } from 'path'
import { WebSocketServer, type WebSocket } from 'ws'
import { unlock } from './auth'
import { createHttpApp } from './http'
import { cleanClose, currentSettings, registerRpc } from './ipc'
import { log, startLogSession } from './log'
import { RpcRouter } from './rpc'
import { appRoot, dataDir } from './services/store'
import { ensureDefaultAdmin } from './services/users'

/**
 * The Bored Manager server: one Express app for the built renderer and the
 * few /api routes, one WebSocket endpoint (/ws) carrying the RPC that used to
 * be Electron IPC. Every browser on the network talks to this one process.
 */

const HEARTBEAT_MS = 30_000

// Run from a terminal on the host to clear the login lockout. It only touches a
// file, so it works whether or not a server is running.
if (process.argv[2] === 'unlock') {
  unlock()
  console.log('webUI unlocked')
  process.exit(0)
}

const root = appRoot()
startLogSession()
ensureDefaultAdmin()

function pidPath(): string {
  return join(dataDir(), 'server.pid')
}

function writePidFile(): void {
  mkdirSync(dataDir(), { recursive: true })
  writeFileSync(pidPath(), String(process.pid))
}

function removePidFile(): void {
  try {
    const path = pidPath()
    if (!existsSync(path)) return
    if (readFileSync(path, 'utf8').trim() !== String(process.pid)) return
    unlinkSync(path)
  } catch {
    /* a leftover pidfile is only a status hint */
  }
}

writePidFile()

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

process.on('uncaughtException', (err) => log(`FATAL uncaughtException: ${err.stack || err}`))
process.on('unhandledRejection', (reason) => {
  log(`unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`)
})

const buildTime = typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : 'unknown'
const version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'
log(
  `starting Bored Manager ${version} (build ${buildTime}, node ${process.versions.node}, ` +
    `${process.platform} ${process.arch}, root ${root})`
)

const router = new RpcRouter(log)
const { app, api, session: sessionMiddleware, sessionStore } = createHttpApp(root, currentSettings)
const server = createServer(app)
const wss = new WebSocketServer({ noServer: true })

// A socket that stopped answering pings is gone even when TCP has not noticed;
// without this a laptop that was closed mid-session would hold pollers open.
const alive = new WeakSet<WebSocket>()

/**
 * Who an upgrade request is, according to its session cookie. The session
 * middleware is written for Express, but it only reads the cookie and loads
 * from the store - an upgrade never sends a response body, so a bare object
 * stands in for the one it would write to.
 */
function readSession(req: IncomingMessage): Promise<{ username: string | null; sid: string | null }> {
  return new Promise((resolve) => {
    const request = req as unknown as Parameters<RequestHandler>[0]
    const response = {} as Parameters<RequestHandler>[1]
    sessionMiddleware(request, response, () =>
      resolve({
        username: request.session?.username ?? null,
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
router.authorize = async (client) => {
  if (!currentSettings().auth.enabled) return true
  const sid = client.sessionId
  if (!sid) return false
  const data = await new Promise<{ username?: string } | null>((resolve) => {
    sessionStore.get(sid, (err, value) => resolve(err || !value ? null : value))
  })
  if (!data?.username) return false
  sessionStore.touch?.(sid, data as Parameters<NonNullable<typeof sessionStore.touch>>[1], () => {})
  return true
}

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost')
  if (pathname !== '/ws') {
    socket.destroy()
    return
  }
  void (async () => {
    // The socket carries every call the UI makes, so it is gated exactly like
    // /api is: no valid session while a login is required means no socket.
    const found = await readSession(req)
    if (currentSettings().auth.enabled && !found.username) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      log('rejected a WebSocket upgrade without a session')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, found))
  })()
})

wss.on('connection', (ws, _req, found?: { username: string | null; sid: string | null }) => {
  const client = router.attach(ws)
  client.username = found?.username ?? null
  client.sessionId = found?.sid ?? null
  alive.add(ws)
  ws.on('pong', () => alive.add(ws))
  log(`client ${client.id} connected (${wss.clients.size} total)`)
  // ws has already dropped the socket from wss.clients by the time this fires.
  ws.on('close', () => log(`client ${client.id} disconnected (${wss.clients.size} left)`))
})

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
registerRpc(router, api)

server.listen(port(), host(), () => {
  log(`listening on http://${host()}:${port()}`)
})
server.on('error', (err) => {
  log(`FATAL: the server could not start: ${String(err)}`)
  removePidFile()
  process.exit(1)
})

let closing = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) return
    closing = true
    log(`received ${signal} - quit requested, cleaning up sessions`)
    clearInterval(heartbeat)
    for (const ws of wss.clients) ws.close(1001, 'server shutting down')
    wss.close()
    server.close()
    // Terminals, SSH sessions and the metrics buffer all need flushing before
    // the process may go away; a client that refuses to let go must not stop it.
    const code = process.exitCode || 0
    const bail = setTimeout(() => {
      removePidFile()
      process.exit(code)
    }, 8000)
    bail.unref()
    void cleanClose()
      .catch((err) => log(`clean close failed: ${String(err)}`))
      .finally(() => {
        clearTimeout(bail)
        log('clean close done')
        removePidFile()
        process.exit(code)
      })
  })
}
