import type { WebSocket } from 'ws'

/**
 * The JSON-RPC layer the browser talks to over /ws. It replaces Electron's
 * ipcMain: the channel names, the "invoke returns a value" shape and the
 * "send is fire and forget" shape are all the same, so everything that used to
 * register an IPC handler registers one here instead.
 *
 * Four frame kinds travel over the socket:
 *   client -> server  { kind: 'invoke', id, channel, args }   needs an answer
 *   client -> server  { kind: 'send',   channel, args }       no answer
 *   server -> client  { kind: 'result', id, value }
 *                     { kind: 'error',  id, message }
 *   server -> client  { kind: 'event',  channel, payload }    push
 */

export type RpcHandler = (...args: unknown[]) => unknown

/** A send handler also gets the client, because some channels are per-socket. */
export type RpcSendHandler = (client: RpcClient, ...args: unknown[]) => void

/**
 * One connected browser. `activeTab` and `username` are per-socket because
 * several clients share one server: which tab is open decides which detail
 * collectors run, and who is logged in decides whose saved connections are read.
 */
export interface RpcClient {
  readonly id: number
  activeTab: string | null
  username: string | null
  /** The session this socket was opened with, so its idle timer can be rolled. */
  sessionId: string | null
  send(channel: string, payload: unknown): void
  close(code: number, reason: string): void
}

interface InvokeFrame {
  kind: 'invoke'
  id: number
  channel: string
  args?: unknown[]
}

interface SendFrame {
  kind: 'send'
  channel: string
  args?: unknown[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The session code the server closes a socket with; see WS_UNAUTHORIZED. */
const UNAUTHORIZED = 4401

export class RpcRouter {
  private readonly handlers = new Map<string, RpcHandler>()
  private readonly clientHandlers = new Map<string, (client: RpcClient, ...a: unknown[]) => unknown>()
  private readonly sendHandlers = new Map<string, RpcSendHandler>()
  private readonly clients = new Map<WebSocket, RpcClient>()
  private nextClientId = 1

  constructor(private readonly logger: (message: string) => void = () => {}) {}

  /**
   * Checked before every frame. Returning false means the socket is no longer
   * allowed to talk (an expired session) and it is closed with 4401.
   */
  authorize: ((client: RpcClient) => Promise<boolean>) | null = null

  // ---------- Registration ----------

  /**
   * Answer an `invoke` frame. Same contract as ipcMain.handle, including the
   * part where the handler declares the argument types it expects: the frame
   * comes off the network as JSON, so what is written here is an assumption
   * either way and spelling it out keeps the handlers readable.
   */
  registerHandler<A extends unknown[]>(channel: string, fn: (...args: A) => unknown): void {
    this.handlers.set(channel, fn as RpcHandler)
  }

  /**
   * Same, for a channel whose answer depends on which client asked - the saved
   * connections belong to an account, not to the server.
   */
  registerClientHandler<A extends unknown[]>(
    channel: string,
    fn: (client: RpcClient, ...args: A) => unknown
  ): void {
    this.clientHandlers.set(channel, fn as (client: RpcClient, ...a: unknown[]) => unknown)
  }

  /** Drop a handler again; modules do this when they are switched off. */
  removeHandler(channel: string): void {
    this.handlers.delete(channel)
    this.clientHandlers.delete(channel)
  }

  /** Act on a `send` frame. Same contract as ipcMain.on. */
  registerSend<A extends unknown[]>(
    channel: string,
    fn: (client: RpcClient, ...args: A) => void
  ): void {
    this.sendHandlers.set(channel, fn as RpcSendHandler)
  }

  // ---------- Sockets ----------

  attach(socket: WebSocket): RpcClient {
    const client: RpcClient = {
      id: this.nextClientId++,
      activeTab: null,
      username: null,
      sessionId: null,
      send: (channel, payload) => writeFrame(socket, { kind: 'event', channel, payload }),
      close: (code, reason) => socket.close(code, reason)
    }
    this.clients.set(socket, client)

    socket.on('message', (data) => {
      void this.dispatch(socket, client, data.toString())
    })
    socket.on('close', () => {
      this.clients.delete(socket)
      this.onClose?.(client)
    })
    socket.on('error', (err) => this.logger(`ws socket error: ${String(err)}`))
    return client
  }

  /** Called after a socket went away, so pollers can be re-evaluated. */
  onClose: ((client: RpcClient) => void) | null = null

  /** Every connected client. */
  sockets(): RpcClient[] {
    return [...this.clients.values()]
  }

  /**
   * Every tab that is open somewhere. A detail collector limited to "while its
   * tab is visible" runs as long as at least one browser is looking at it, so
   * the question is never "which tab" but "which tabs".
   */
  activeTabs(): Set<string> {
    const out = new Set<string>()
    for (const client of this.clients.values()) {
      if (client.activeTab) out.add(client.activeTab)
    }
    return out
  }

  /** Push an event to every open socket. */
  broadcast(channel: string, payload: unknown): void {
    for (const socket of this.clients.keys()) {
      writeFrame(socket, { kind: 'event', channel, payload })
    }
  }

  // ---------- Dispatch ----------

  private async dispatch(socket: WebSocket, client: RpcClient, raw: string): Promise<void> {
    let frame: unknown
    try {
      frame = JSON.parse(raw)
    } catch {
      this.logger('ws: dropped a frame that is not JSON')
      return
    }
    if (!isRecord(frame)) return

    // Talking on the socket is what keeps a session alive, so this is also
    // where an expired one is noticed.
    if (this.authorize && !(await this.authorize(client))) {
      client.close(UNAUTHORIZED, 'session expired')
      return
    }

    if (frame['kind'] === 'invoke') {
      const { id, channel, args } = frame as unknown as InvokeFrame
      if (typeof id !== 'number' || typeof channel !== 'string') return
      const list = Array.isArray(args) ? args : []
      const handler = this.handlers.get(channel)
      const clientHandler = this.clientHandlers.get(channel)
      if (!handler && !clientHandler) {
        writeFrame(socket, { kind: 'error', id, message: `no handler for "${channel}"` })
        return
      }
      try {
        const value = clientHandler ? await clientHandler(client, ...list) : await handler!(...list)
        writeFrame(socket, { kind: 'result', id, value: value ?? null })
      } catch (err) {
        writeFrame(socket, { kind: 'error', id, message: String(err) })
      }
      return
    }

    if (frame['kind'] === 'send') {
      const { channel, args } = frame as unknown as SendFrame
      if (typeof channel !== 'string') return
      const handler = this.sendHandlers.get(channel)
      if (!handler) {
        this.logger(`ws: no send handler for "${channel}"`)
        return
      }
      try {
        handler(client, ...(Array.isArray(args) ? args : []))
      } catch (err) {
        this.logger(`ws: send handler "${channel}" failed: ${String(err)}`)
      }
    }
  }
}

/** WebSocket.OPEN, without importing the runtime class just for the constant. */
const OPEN = 1

function writeFrame(socket: WebSocket, frame: unknown): void {
  if (socket.readyState !== OPEN) return
  try {
    socket.send(JSON.stringify(frame))
  } catch {
    // A socket that died between the check and the write is not an error.
  }
}
