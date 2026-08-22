import type { WebSocket } from 'ws'
import {
  parseRpcClientFrame,
  type RpcServerFrame
} from '@shared/rpc'
import { isRecord } from '@shared/validation'
import {
  PUBLIC_ERROR_CODES,
  PublicError,
  internalErrorDetail,
  publicErrorPayload
} from './errors'
import {
  ResourceCoordinator,
  type MutationResource
} from './resource-coordinator'

export type RpcHandler = (...args: unknown[]) => unknown
export type RpcSendHandler = (client: RpcClient, ...args: unknown[]) => unknown

export interface RpcClient {
  readonly id: number
  activeTab: string | null
  activeMachine: string | null
  username: string | null
  /** The session this socket was opened with, so its idle timer can be rolled. */
  sessionId: string | null
  /** False means the event was dropped or the client was closed as too slow. */
  send(channel: string, payload: unknown): boolean
  close(code: number, reason: string): void
  /** Suppress authorization-triggered pushes until this invoke is answered. */
  protectReply(): void
  /** Close only after the current invoke result/error has been written. */
  closeAfterReply(code: number, reason: string): void
}

export interface RpcRegistrationOptions {
  resources?: readonly MutationResource[]
}

export interface RpcRouterLimits {
  maxPayload: number
  ratePerSecond: number
  rateBurst: number
  maxQueuedFrames: number
  maxQueuedBytes: number
  outboundHighWater: number
  outboundHardLimit: number
  outboundRetryMs: number
}

export const RPC_LIMITS: RpcRouterLimits = {
  // A checked module form may carry a client-read text file (OpenWRT account
  // lists are capped at 1 MiB). Keep a hard bound, but leave room for the RPC
  // envelope and JSON escaping; apply omits those large fields after check.
  maxPayload: 2 * 1024 * 1024,
  ratePerSecond: 30,
  rateBurst: 60,
  maxQueuedFrames: 64,
  // Visibility-gated module tables can legitimately contain several thousand
  // compact rows. They are never pushed every tick, but one response must fit.
  maxQueuedBytes: 8 * 1024 * 1024,
  outboundHighWater: 2 * 1024 * 1024,
  outboundHardLimit: 8 * 1024 * 1024,
  outboundRetryMs: 25
}

export const WS_CLOSE_CODES = {
  invalidData: 4400,
  unauthorized: 4401,
  queueLimit: 4409,
  slowClient: 4410,
  rateLimit: 4429
} as const

interface HandlerEntry<T> {
  fn: T
  resources: readonly MutationResource[]
}

interface QueuedInput {
  raw: string
  bytes: number
}

interface QueuedEvent {
  channel: string
  text: string
  bytes: number
  replaceable: boolean
  authorized: boolean
  version: number
}

interface SerializedEvent {
  channel: string
  text: string
  bytes: number
  replaceable: boolean
}

interface ClientState {
  socket: WebSocket
  client: RpcClient
  queue: QueuedInput[]
  queuedBytes: number
  processing: boolean
  tokens: number
  lastRefill: number
  closed: boolean
  events: QueuedEvent[]
  eventBytes: number
  eventPumping: boolean
  eventTimer: ReturnType<typeof setTimeout> | null
}

export interface RpcRouterOptions extends Partial<RpcRouterLimits> {
  now?: () => number
}

const OPEN = 1
const REPLACEABLE_EVENTS = new Set([
  'push:system',
  'push:top',
  'push:services',
  'push:update',
  'push:modules',
  'push:modules-list',
  'push:conn-status',
  'packages:state'
])

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function dataBytes(data: unknown): number {
  if (typeof data === 'string') return byteLength(data)
  if (Buffer.isBuffer(data)) return data.byteLength
  if (data instanceof ArrayBuffer) return data.byteLength
  if (Array.isArray(data)) {
    return data.reduce((total, part) => total + dataBytes(part), 0)
  }
  if (ArrayBuffer.isView(data)) return data.byteLength
  return byteLength(String(data))
}

function dataText(data: unknown): string {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (Array.isArray(data)) {
    return Buffer.concat(
      data.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(String(part))))
    ).toString('utf8')
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
  }
  return String(data)
}

function replaceableEvent(channel: string): boolean {
  return REPLACEABLE_EVENTS.has(channel)
}

export class RpcRouter {
  private readonly handlers = new Map<string, HandlerEntry<RpcHandler>>()
  private readonly clientHandlers = new Map<
    string,
    HandlerEntry<(client: RpcClient, ...args: unknown[]) => unknown>
  >()
  private readonly sendHandlers = new Map<string, HandlerEntry<RpcSendHandler>>()
  private readonly clients = new Map<WebSocket, ClientState>()
  private readonly deferredCloses = new Map<RpcClient, { code: number; reason: string }>()
  private readonly protectedReplies = new Set<RpcClient>()
  private readonly coordinator = new ResourceCoordinator()
  private readonly limits: RpcRouterLimits
  private readonly now: () => number
  private nextClientId = 1
  private accepting = true
  private activeWork = 0
  private readonly drainWaiters = new Set<() => void>()

  constructor(
    private readonly logger: (message: string) => void = () => {},
    options: RpcRouterOptions = {}
  ) {
    const { now, ...configured } = options
    this.limits = { ...RPC_LIMITS, ...configured }
    this.now = now ?? Date.now
  }

  /**
   * Checked before every frame. Returning false means the socket is no longer
   * allowed to talk (an expired session) and it is closed with 4401.
   */
  authorize: ((client: RpcClient, activity: boolean) => Promise<boolean>) | null = null

  registerHandler<A extends unknown[]>(
    channel: string,
    fn: (...args: A) => unknown,
    options: RpcRegistrationOptions = {}
  ): void {
    this.handlers.set(channel, {
      fn: fn as RpcHandler,
      resources: options.resources ?? []
    })
  }

  registerClientHandler<A extends unknown[]>(
    channel: string,
    fn: (client: RpcClient, ...args: A) => unknown,
    options: RpcRegistrationOptions = {}
  ): void {
    this.clientHandlers.set(channel, {
      fn: fn as (client: RpcClient, ...args: unknown[]) => unknown,
      resources: options.resources ?? []
    })
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel)
    this.clientHandlers.delete(channel)
  }

  registerSend<A extends unknown[]>(
    channel: string,
    fn: (client: RpcClient, ...args: A) => unknown,
    options: RpcRegistrationOptions = {}
  ): void {
    this.sendHandlers.set(channel, {
      fn: fn as RpcSendHandler,
      resources: options.resources ?? []
    })
  }

  /** Share the same mutation lock with an HTTP upload/import route. */
  runExclusive<T>(
    resources: readonly MutationResource[],
    operation: () => T | Promise<T>
  ): Promise<T> {
    return this.coordinator.run(resources, operation)
  }

  attach(socket: WebSocket): RpcClient {
    let state!: ClientState
    const client: RpcClient = {
      id: this.nextClientId++,
      activeTab: null,
      activeMachine: null,
      username: null,
      sessionId: null,
      send: (channel, payload) => this.queueEvent(state, channel, payload),
      close: (code, reason) => this.closeState(state, code, reason),
      protectReply: () => {
        this.protectedReplies.add(client)
      },
      closeAfterReply: (code, reason) => {
        this.protectedReplies.add(client)
        this.deferredCloses.set(client, { code, reason })
      }
    }
    state = {
      socket,
      client,
      queue: [],
      queuedBytes: 0,
      processing: false,
      tokens: this.limits.rateBurst,
      lastRefill: this.now(),
      closed: false,
      events: [],
      eventBytes: 0,
      eventPumping: false,
      eventTimer: null
    }
    this.clients.set(socket, state)

    socket.on('message', (data, isBinary) => {
      this.acceptInput(state, data, isBinary)
    })
    socket.on('close', () => {
      state.closed = true
      state.queue = []
      state.queuedBytes = 0
      state.events = []
      state.eventBytes = 0
      if (state.eventTimer) clearTimeout(state.eventTimer)
      this.clients.delete(socket)
      this.deferredCloses.delete(client)
      this.protectedReplies.delete(client)
      this.onClose?.(client)
    })
    socket.on('error', (error) => this.logger(`ws socket error: ${internalErrorDetail(error)}`))
    return client
  }

  /** Called after a socket went away, so pollers can be re-evaluated. */
  onClose: ((client: RpcClient) => void) | null = null

  sockets(): RpcClient[] {
    return [...this.clients.values()].map((state) => state.client)
  }

  activeTabs(): Set<string> {
    const out = new Set<string>()
    for (const state of this.clients.values()) {
      if (state.client.activeTab) out.add(state.client.activeTab)
    }
    return out
  }

  activeTabsByMachine(): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>()
    for (const state of this.clients.values()) {
      const { activeMachine, activeTab } = state.client
      if (!activeMachine || !activeTab) continue
      const tabs = out.get(activeMachine) ?? new Set<string>()
      tabs.add(activeTab)
      out.set(activeMachine, tabs)
    }
    return out
  }

  /** Number of clients that accepted the event into a bounded queue. */
  broadcast(channel: string, payload: unknown): number {
    const event = this.serializeEvent(channel, payload)
    if (!event) return 0
    let accepted = 0
    for (const state of this.clients.values()) {
      if (this.queueSerializedEvent(state, event)) accepted++
    }
    return accepted
  }

  /** Broadcast a machine-scoped snapshot only to browsers viewing that machine. */
  broadcastToMachine(machineId: string, channel: string, payload: unknown): number {
    const event = this.serializeEvent(channel, payload)
    if (!event) return 0
    let accepted = 0
    for (const state of this.clients.values()) {
      if (
        state.client.activeMachine === machineId &&
        this.queueSerializedEvent(state, event)
      ) {
        accepted++
      }
    }
    return accepted
  }

  /** Reject new work while allowing the currently executing handlers to finish. */
  stopAccepting(): void {
    if (!this.accepting) return
    this.accepting = false
    for (const state of this.clients.values()) {
      state.events = []
      state.eventBytes = 0
      if (state.eventTimer) {
        clearTimeout(state.eventTimer)
        state.eventTimer = null
      }
    }
  }

  drain(): Promise<void> {
    if (this.activeWork === 0) return Promise.resolve()
    return new Promise((resolve) => this.drainWaiters.add(resolve))
  }

  closeAll(code = 1001, reason = 'server shutting down'): void {
    for (const state of this.clients.values()) this.closeState(state, code, reason)
  }

  terminateAll(): void {
    for (const state of this.clients.values()) {
      state.closed = true
      try {
        state.socket.terminate()
      } catch {
        // The peer may have disappeared between iteration and termination.
      }
    }
  }

  private acceptInput(state: ClientState, data: unknown, isBinary = false): void {
    if (state.closed) return
    if (isBinary) {
      this.closeState(state, WS_CLOSE_CODES.invalidData, 'text frames required')
      return
    }
    const bytes = dataBytes(data)
    if (bytes > this.limits.maxPayload) {
      this.closeState(state, 1009, 'message too large')
      return
    }
    if (!this.takeRateToken(state)) {
      this.closeState(state, WS_CLOSE_CODES.rateLimit, 'rate limit exceeded')
      return
    }

    const raw = dataText(data)
    if (!this.accepting) {
      if (
        state.processing &&
        state.queue.length < this.limits.maxQueuedFrames &&
        state.queuedBytes + bytes <= this.limits.maxQueuedBytes
      ) {
        state.queue.push({ raw, bytes })
        state.queuedBytes += bytes
      } else {
        this.rejectDuringShutdown(state, raw)
      }
      return
    }
    if (
      state.queue.length >= this.limits.maxQueuedFrames ||
      state.queuedBytes + bytes > this.limits.maxQueuedBytes
    ) {
      this.closeState(state, WS_CLOSE_CODES.queueLimit, 'too many queued requests')
      return
    }
    state.queue.push({ raw, bytes })
    state.queuedBytes += bytes
    void this.pumpInput(state)
  }

  private takeRateToken(state: ClientState): boolean {
    const now = this.now()
    const elapsed = Math.max(0, now - state.lastRefill)
    state.lastRefill = now
    state.tokens = Math.min(
      this.limits.rateBurst,
      state.tokens + (elapsed * this.limits.ratePerSecond) / 1000
    )
    if (state.tokens < 1) return false
    state.tokens -= 1
    return true
  }

  private async pumpInput(state: ClientState): Promise<void> {
    if (state.processing || state.closed) return
    state.processing = true
    try {
      await this.withActiveWork(async () => {
        while (!state.closed && state.queue.length > 0) {
          const next = state.queue.shift()!
          state.queuedBytes -= next.bytes
          await this.dispatch(state, next.raw)
        }
      })
    } finally {
      state.processing = false
    }
  }

  private async withActiveWork(operation: () => Promise<void>): Promise<void> {
    this.activeWork++
    try {
      await operation()
    } finally {
      this.activeWork--
      if (this.activeWork === 0) {
        for (const resolve of this.drainWaiters) resolve()
        this.drainWaiters.clear()
      }
    }
  }

  private async dispatch(state: ClientState, raw: string): Promise<void> {
    let frame: unknown
    try {
      frame = JSON.parse(raw)
    } catch {
      this.logger('ws: dropped a frame that is not JSON')
      return
    }
    if (!isRecord(frame)) {
      this.logger('ws: invalid RPC frame: expected an object')
      return
    }
    if (this.protectedReplies.has(state.client)) return

    if (this.authorize && !(await this.isAuthorized(state.client, true))) {
      this.closeState(state, WS_CLOSE_CODES.unauthorized, 'session expired')
      return
    }

    const parsed = parseRpcClientFrame(frame)
    if (!parsed.ok) {
      if (parsed.id !== undefined) {
        this.writeError(state, parsed.id, PUBLIC_ERROR_CODES.invalidRequest, parsed.error)
      } else {
        this.logger(`ws: ${parsed.error}`)
      }
      return
    }

    if (!this.accepting) {
      if (parsed.frame.kind === 'invoke') {
        this.writeError(
          state,
          parsed.frame.id,
          PUBLIC_ERROR_CODES.shuttingDown,
          'Server is shutting down'
        )
      }
      return
    }

    if (parsed.frame.kind === 'invoke') {
      const { id, channel, args } = parsed.frame
      const normal = this.handlers.get(channel)
      const withClient = this.clientHandlers.get(channel)
      if (!normal && !withClient) {
        this.writeError(state, id, 'METHOD_NOT_FOUND', `No handler for "${channel}"`)
        return
      }
      try {
        const entry = withClient ?? normal!
        const value = await this.coordinator.run(entry.resources, () =>
          withClient
            ? withClient.fn(state.client, ...args)
            : (normal as HandlerEntry<RpcHandler>).fn(...args)
        )
        if (!this.writeFrame(state, { kind: 'result', id, value: value ?? null })) {
          if (!state.closed) {
            this.writeError(
              state,
              id,
              PUBLIC_ERROR_CODES.internal,
              'Internal server error'
            )
          }
        }
      } catch (error) {
        if (!(error instanceof PublicError)) {
          this.logger(
            `rpc "${channel}" failed for client ${state.client.id}: ${internalErrorDetail(error)}`
          )
        }
        const exposed = publicErrorPayload(error)
        this.writeError(state, id, exposed.code, exposed.message)
      }
      this.finishDeferredClose(state)
      return
    }

    const { channel, args } = parsed.frame
    const entry = this.sendHandlers.get(channel)
    if (!entry) {
      this.logger(`ws: no send handler for "${channel}"`)
      return
    }
    try {
      await this.coordinator.run(entry.resources, () => entry.fn(state.client, ...args))
    } catch (error) {
      if (error instanceof PublicError) {
        this.closeState(state, WS_CLOSE_CODES.invalidData, 'invalid request')
      } else {
        this.logger(
          `ws send "${channel}" failed for client ${state.client.id}: ${internalErrorDetail(error)}`
        )
        this.closeState(state, 1011, 'request failed')
      }
    }
  }

  private rejectDuringShutdown(state: ClientState, raw: string): void {
    try {
      const parsed = parseRpcClientFrame(JSON.parse(raw) as unknown)
      if (parsed.ok && parsed.frame.kind === 'invoke') {
        this.writeError(
          state,
          parsed.frame.id,
          PUBLIC_ERROR_CODES.shuttingDown,
          'Server is shutting down'
        )
      }
    } catch {
      // There is no safe id to answer.
    }
  }

  private async isAuthorized(client: RpcClient, activity: boolean): Promise<boolean> {
    if (!this.authorize) return true
    try {
      return await this.authorize(client, activity)
    } catch (error) {
      this.logger(`ws authorization failed: ${internalErrorDetail(error)}`)
      return false
    }
  }

  private queueEvent(state: ClientState, channel: string, payload: unknown): boolean {
    const event = this.serializeEvent(channel, payload)
    return event ? this.queueSerializedEvent(state, event) : false
  }

  private serializeEvent(channel: string, payload: unknown): SerializedEvent | null {
    let text: string
    try {
      text = JSON.stringify({ kind: 'event', channel, payload })
    } catch (error) {
      this.logger(`could not serialize event "${channel}": ${internalErrorDetail(error)}`)
      return null
    }
    return {
      channel,
      text,
      bytes: byteLength(text),
      replaceable: replaceableEvent(channel)
    }
  }

  private queueSerializedEvent(state: ClientState, event: SerializedEvent): boolean {
    if (
      !this.accepting ||
      state.closed ||
      state.socket.readyState !== OPEN ||
      this.protectedReplies.has(state.client)
    ) {
      return false
    }

    const { channel, text, bytes, replaceable } = event
    if (bytes > this.limits.outboundHardLimit) {
      this.closeState(state, WS_CLOSE_CODES.slowClient, 'outbound message too large')
      return false
    }

    const existing = replaceable
      ? state.events.find((event) => event.replaceable && event.channel === channel)
      : undefined
    if (existing) {
      state.eventBytes += bytes - existing.bytes
      existing.text = text
      existing.bytes = bytes
      existing.authorized = false
      existing.version++
    } else {
      state.events.push({
        channel,
        text,
        bytes,
        replaceable,
        authorized: false,
        version: 1
      })
      state.eventBytes += bytes
    }

    this.trimReplaceableEvents(state)
    if (
      state.eventBytes > this.limits.outboundHardLimit ||
      state.events.length > this.limits.maxQueuedFrames
    ) {
      this.closeState(state, WS_CLOSE_CODES.slowClient, 'client too slow')
      return false
    }
    void this.pumpEvents(state)
    return true
  }

  private trimReplaceableEvents(state: ClientState): void {
    while (
      state.eventBytes > this.limits.outboundHighWater ||
      state.events.length > this.limits.maxQueuedFrames
    ) {
      const index = state.events.findIndex(
        (event, at) => event.replaceable && at < state.events.length - 1
      )
      if (index < 0) return
      const [dropped] = state.events.splice(index, 1)
      state.eventBytes -= dropped.bytes
    }
  }

  private async pumpEvents(state: ClientState): Promise<void> {
    if (state.eventPumping || state.closed || !this.accepting) return
    state.eventPumping = true
    try {
      while (
        !state.closed &&
        this.accepting &&
        state.events.length > 0 &&
        !this.protectedReplies.has(state.client)
      ) {
        const event = state.events[0]
        if (!event.authorized) {
          const version = event.version
          const authorized = await this.isAuthorized(state.client, false)
          if (state.events[0] !== event || event.version !== version) continue
          if (!authorized) {
            this.closeState(state, WS_CLOSE_CODES.unauthorized, 'session expired')
            return
          }
          event.authorized = true
        }

        const buffered = this.bufferedAmount(state.socket)
        if (
          event.replaceable &&
          buffered + event.bytes > this.limits.outboundHighWater
        ) {
          this.scheduleEventPump(state)
          return
        }
        if (buffered + event.bytes > this.limits.outboundHardLimit) {
          this.closeState(state, WS_CLOSE_CODES.slowClient, 'client too slow')
          return
        }
        state.events.shift()
        state.eventBytes -= event.bytes
        if (!this.sendText(state, event.text, event.bytes)) return
      }
    } finally {
      state.eventPumping = false
    }
  }

  private scheduleEventPump(state: ClientState): void {
    if (state.eventTimer || state.closed) return
    state.eventTimer = setTimeout(() => {
      state.eventTimer = null
      void this.pumpEvents(state)
    }, this.limits.outboundRetryMs)
    state.eventTimer.unref?.()
  }

  private bufferedAmount(socket: WebSocket): number {
    const value = Number(socket.bufferedAmount)
    return Number.isFinite(value) && value > 0 ? value : 0
  }

  private writeError(state: ClientState, id: number, code: string, message: string): boolean {
    return this.writeFrame(state, { kind: 'error', id, code, message })
  }

  private writeFrame(state: ClientState, frame: RpcServerFrame): boolean {
    let text: string
    try {
      text = JSON.stringify(frame)
    } catch (error) {
      this.logger(`could not serialize RPC response: ${internalErrorDetail(error)}`)
      return false
    }
    return this.sendText(state, text, byteLength(text))
  }

  private sendText(state: ClientState, text: string, bytes: number): boolean {
    if (state.closed || state.socket.readyState !== OPEN) return false
    if (this.bufferedAmount(state.socket) + bytes > this.limits.outboundHardLimit) {
      this.closeState(state, WS_CLOSE_CODES.slowClient, 'client too slow')
      return false
    }
    try {
      state.socket.send(text)
      return true
    } catch {
      return false
    }
  }

  private finishDeferredClose(state: ClientState): void {
    this.protectedReplies.delete(state.client)
    const pending = this.deferredCloses.get(state.client)
    if (pending) {
      this.deferredCloses.delete(state.client)
      this.closeState(state, pending.code, pending.reason)
      return
    }
    void this.pumpEvents(state)
  }

  private closeState(state: ClientState, code: number, reason: string): void {
    if (state.closed) return
    state.closed = true
    state.queue = []
    state.queuedBytes = 0
    state.events = []
    state.eventBytes = 0
    if (state.eventTimer) {
      clearTimeout(state.eventTimer)
      state.eventTimer = null
    }
    try {
      state.socket.close(code, reason.slice(0, 123))
    } catch {
      // A socket that died between the state check and close needs no action.
    }
  }
}
