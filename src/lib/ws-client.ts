/**
 * The browser end of the RPC that used to be Electron IPC. One WebSocket to
 * /ws carries every call and every push; it reconnects on its own, because a
 * laptop that was asleep, a Wi-Fi hiccup or a server restart must not mean the
 * user has to reload the page.
 *
 * The frame shapes are defined in server/rpc.ts.
 */

export type WsState = 'connecting' | 'open' | 'closed'

/** The server closes the socket with this when the session is no longer valid. */
export const WS_UNAUTHORIZED = 4401

const RECONNECT_MIN_MS = 1000
const RECONNECT_MAX_MS = 5000

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
}

type Listener = (payload: unknown) => void

function socketUrl(): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${location.host}/ws`
}

export class WsClient {
  private socket: WebSocket | null = null
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Map<string, Set<Listener>>()
  /** Frames written before the socket was open; flushed once it is. */
  private outbox: string[] = []
  private nextId = 1
  private reconnectMs = RECONNECT_MIN_MS
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private openedOnce = false
  /** Set after a 4401: the session is gone, reconnecting would loop. */
  private stopped = false
  private firstOpen: { resolve(): void } | null = null

  state: WsState = 'closed'

  /** Called after a reconnect (not the first connect), to re-seed the UI. */
  onReconnected: (() => void) | null = null
  /**
   * Called when the server closed the socket because it is not allowed to talk.
   * The reason is the server's own wording, so the UI can say whether a session
   * expired or a login was just switched on.
   */
  onUnauthorized: ((reason: string) => void) | null = null
  onStateChange: ((state: WsState) => void) | null = null

  /** Opens the socket and resolves the first time it is connected. */
  connect(): Promise<void> {
    this.stopped = false
    if (this.state === 'open') return Promise.resolve()
    const waiter = new Promise<void>((resolve) => {
      this.firstOpen = { resolve }
    })
    this.open()
    return waiter
  }

  /** Closes the socket and stops reconnecting; used when logging out. */
  disconnect(): void {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    // Nothing from the session that just ended may be replayed into the next
    // one, and no caller may be left waiting for an answer that cannot come.
    this.openedOnce = false
    this.outbox = []
    for (const [, pending] of this.pending) pending.reject(new Error('signed out'))
    this.pending.clear()
    this.socket?.close(1000, 'signed out')
    this.socket = null
    this.setState('closed')
  }

  invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.write({ kind: 'invoke', id, channel, args })
    })
  }

  send(channel: string, ...args: unknown[]): void {
    this.write({ kind: 'send', channel, args })
  }

  on(channel: string, cb: Listener): () => void {
    const set = this.listeners.get(channel) ?? new Set<Listener>()
    set.add(cb)
    this.listeners.set(channel, set)
    return () => {
      set.delete(cb)
      if (set.size === 0) this.listeners.delete(channel)
    }
  }

  // ---------- Internals ----------

  private setState(state: WsState): void {
    if (this.state === state) return
    this.state = state
    this.onStateChange?.(state)
  }

  private open(): void {
    if (this.socket || this.stopped) return
    this.setState('connecting')
    const socket = new WebSocket(socketUrl())
    this.socket = socket

    socket.onopen = () => {
      this.reconnectMs = RECONNECT_MIN_MS
      this.setState('open')
      for (const frame of this.outbox.splice(0)) socket.send(frame)
      this.firstOpen?.resolve()
      this.firstOpen = null
      if (this.openedOnce) this.onReconnected?.()
      this.openedOnce = true
    }

    socket.onmessage = (event) => this.receive(String(event.data))

    socket.onclose = (event) => {
      this.socket = null
      this.setState('closed')
      // Nothing that was in flight can still be answered.
      const error = new Error(
        event.code === WS_UNAUTHORIZED ? 'the session expired' : 'the server connection dropped'
      )
      for (const [, pending] of this.pending) pending.reject(error)
      this.pending.clear()
      this.outbox = []
      if (event.code === WS_UNAUTHORIZED) {
        this.stopped = true
        this.onUnauthorized?.(event.reason)
        return
      }
      this.scheduleReconnect()
    }

    // onerror always comes with an onclose, which does the reconnecting.
    socket.onerror = () => {}
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return
    const delay = this.reconnectMs
    this.reconnectMs = Math.min(Math.round(this.reconnectMs * 1.5), RECONNECT_MAX_MS)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.open()
    }, delay)
  }

  private write(frame: unknown): void {
    const text = JSON.stringify(frame)
    if (this.socket && this.state === 'open') {
      this.socket.send(text)
      return
    }
    // Mid-reconnect: hold the frame instead of failing the call outright.
    this.outbox.push(text)
    this.open()
  }

  private receive(raw: string): void {
    let frame: unknown
    try {
      frame = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof frame !== 'object' || frame === null) return
    const f = frame as {
      kind?: string
      id?: number
      value?: unknown
      message?: string
      channel?: string
      payload?: unknown
    }

    if (f.kind === 'result' && typeof f.id === 'number') {
      this.pending.get(f.id)?.resolve(f.value)
      this.pending.delete(f.id)
      return
    }
    if (f.kind === 'error' && typeof f.id === 'number') {
      this.pending.get(f.id)?.reject(new Error(f.message ?? 'the server reported an error'))
      this.pending.delete(f.id)
      return
    }
    if (f.kind === 'event' && typeof f.channel === 'string') {
      const set = this.listeners.get(f.channel)
      if (!set) return
      for (const cb of [...set]) cb(f.payload)
    }
  }
}

export const wsClient = new WsClient()
