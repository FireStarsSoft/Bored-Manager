import { describe, expect, it, vi } from 'vitest'
import {
  RpcRouter,
  WS_CLOSE_CODES
} from '../../../server/rpc'
import { ValidationError } from '../../../server/errors'
import { FakeWebSocket } from '../../helpers/fake-websocket'

async function settleDispatch(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

describe('RpcRouter frame dispatch', () => {
  it('groups each browser active tab by its independently selected machine', () => {
    const router = new RpcRouter()
    const first = router.attach(new FakeWebSocket().asWebSocket())
    const second = router.attach(new FakeWebSocket().asWebSocket())
    first.activeMachine = 'admin@alpha'
    first.activeTab = 'overview'
    second.activeMachine = 'admin@beta'
    second.activeTab = 'disk/devices'

    expect(
      [...router.activeTabsByMachine()].map(([machineId, tabs]) => [
        machineId,
        [...tabs]
      ])
    ).toEqual([
      ['admin@alpha', ['overview']],
      ['admin@beta', ['disk/devices']]
    ])
  })

  it('serializes once and sends machine events only to matching clients', async () => {
    const router = new RpcRouter()
    const alphaSocket = new FakeWebSocket()
    const betaSocket = new FakeWebSocket()
    const idleSocket = new FakeWebSocket()
    const alpha = router.attach(alphaSocket.asWebSocket())
    const beta = router.attach(betaSocket.asWebSocket())
    router.attach(idleSocket.asWebSocket())
    alpha.activeMachine = 'admin@alpha'
    beta.activeMachine = 'admin@beta'
    const stringify = vi.spyOn(JSON, 'stringify')

    expect(
      router.broadcastToMachine('admin@alpha', 'push:system', {
        machineId: 'admin@alpha',
        data: { t: 1 }
      })
    ).toBe(1)
    await settleDispatch()

    expect(stringify).toHaveBeenCalledTimes(1)
    expect(alphaSocket.frames()).toEqual([
      {
        kind: 'event',
        channel: 'push:system',
        payload: { machineId: 'admin@alpha', data: { t: 1 } }
      }
    ])
    expect(betaSocket.frames()).toEqual([])
    expect(idleSocket.frames()).toEqual([])
  })

  it('dispatches validated invoke and send frames', async () => {
    const router = new RpcRouter()
    const socket = new FakeWebSocket()
    const sent = vi.fn()
    router.registerHandler('math:add', (left: unknown, right: unknown) => Number(left) + Number(right))
    router.registerSend('ui:select', (_client, value: unknown) => sent(value))
    router.attach(socket.asWebSocket())

    socket.emitJson({ kind: 'invoke', id: 1, channel: 'math:add', args: [2, 3] })
    socket.emitJson({ kind: 'send', channel: 'ui:select', args: ['overview'] })
    await settleDispatch()

    expect(socket.frames()).toEqual([{ kind: 'result', id: 1, value: 5 }])
    expect(sent).toHaveBeenCalledWith('overview')
  })

  it('returns a stable error for a malformed invoke with a safe id', async () => {
    const logger = vi.fn()
    const handler = vi.fn()
    const router = new RpcRouter(logger)
    const socket = new FakeWebSocket()
    router.registerHandler('safe:call', handler)
    router.attach(socket.asWebSocket())

    socket.emitJson({ kind: 'invoke', id: 17, channel: 'safe:call', args: { not: 'an array' } })
    await settleDispatch()

    expect(handler).not.toHaveBeenCalled()
    expect(socket.frames()).toEqual([
      {
        kind: 'error',
        id: 17,
        code: 'INVALID_REQUEST',
        message: 'invalid RPC frame: "args" must be an array'
      }
    ])
    expect(logger).not.toHaveBeenCalled()
  })

  it('drops malformed frames that have no response-safe id and logs why', async () => {
    const logger = vi.fn()
    const router = new RpcRouter(logger)
    const socket = new FakeWebSocket()
    router.attach(socket.asWebSocket())

    socket.emitRaw('{not-json')
    socket.emitJson({ kind: 'invoke', id: -1, channel: 'safe:call' })
    socket.emitJson([])
    await settleDispatch()

    expect(socket.frames()).toEqual([])
    expect(logger.mock.calls.map(([message]) => message)).toEqual([
      'ws: dropped a frame that is not JSON',
      'ws: invalid RPC frame: invoke "id" must be a positive safe integer',
      'ws: invalid RPC frame: expected an object'
    ])
  })

  it('keeps the existing no-handler error contract after validation', async () => {
    const router = new RpcRouter()
    const socket = new FakeWebSocket()
    router.attach(socket.asWebSocket())

    socket.emitJson({ kind: 'invoke', id: 4, channel: 'missing', args: [] })
    await settleDispatch()

    expect(socket.frames()).toEqual([
      {
        kind: 'error',
        id: 4,
        code: 'METHOD_NOT_FOUND',
        message: 'No handler for "missing"'
      }
    ])
  })

  it('writes the auth-enable result before closing the requester', async () => {
    const router = new RpcRouter()
    const socket = new FakeWebSocket()
    let authEnabled = false
    router.authorize = async () => !authEnabled
    router.registerClientHandler('auth:setEnabled', (client) => {
      client.protectReply()
      authEnabled = true
      router.broadcast('push:system', { shouldNotLeak: true })
      client.closeAfterReply(4401, 'login required')
      return { enabled: true }
    })
    router.attach(socket.asWebSocket())

    socket.emitJson({
      kind: 'invoke',
      id: 8,
      channel: 'auth:setEnabled',
      args: [{ enabled: true }]
    })
    await settleDispatch()

    expect(socket.frames()).toEqual([
      { kind: 'result', id: 8, value: { enabled: true } }
    ])
    expect(socket.closes).toEqual([{ code: 4401, reason: 'login required' }])
  })

  it('does not broadcast to a socket whose session is no longer authorized', async () => {
    const router = new RpcRouter()
    const socket = new FakeWebSocket()
    router.authorize = async () => false
    router.attach(socket.asWebSocket())

    router.broadcast('push:system', { t: 1 })
    await settleDispatch()

    expect(socket.frames()).toEqual([])
    expect(socket.closes).toEqual([{ code: 4401, reason: 'session expired' }])
  })

  it('processes one socket sequentially while other sockets remain independent', async () => {
    const router = new RpcRouter()
    const first = new FakeWebSocket()
    const second = new FakeWebSocket()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started: string[] = []
    router.registerHandler('work', async (name: unknown) => {
      started.push(String(name))
      if (name === 'first') await gate
      return name
    })
    router.attach(first.asWebSocket())
    router.attach(second.asWebSocket())

    first.emitJson({ kind: 'invoke', id: 1, channel: 'work', args: ['first'] })
    first.emitJson({ kind: 'invoke', id: 2, channel: 'work', args: ['second-on-first'] })
    second.emitJson({ kind: 'invoke', id: 3, channel: 'work', args: ['other-socket'] })
    await settleDispatch()

    expect(started).toEqual(['first', 'other-socket'])
    release()
    await settleDispatch()
    expect(first.frames()).toEqual([
      { kind: 'result', id: 1, value: 'first' },
      { kind: 'result', id: 2, value: 'second-on-first' }
    ])
  })

  it('closes clients that exceed frame rate, queue, or payload limits', async () => {
    const rateRouter = new RpcRouter(undefined, { rateBurst: 2, ratePerSecond: 0 })
    const rateSocket = new FakeWebSocket()
    rateRouter.attach(rateSocket.asWebSocket())
    for (let id = 1; id <= 3; id++) {
      rateSocket.emitJson({ kind: 'invoke', id, channel: 'missing', args: [] })
    }
    expect(rateSocket.closes.at(-1)).toEqual({
      code: WS_CLOSE_CODES.rateLimit,
      reason: 'rate limit exceeded'
    })

    const queueRouter = new RpcRouter(undefined, {
      rateBurst: 100,
      ratePerSecond: 100,
      maxQueuedFrames: 2
    })
    const queueSocket = new FakeWebSocket()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    queueRouter.registerHandler('slow', () => gate)
    queueRouter.attach(queueSocket.asWebSocket())
    queueSocket.emitJson({ kind: 'invoke', id: 1, channel: 'slow', args: [] })
    await settleDispatch()
    for (let id = 2; id <= 4; id++) {
      queueSocket.emitJson({ kind: 'invoke', id, channel: 'slow', args: [] })
    }
    expect(queueSocket.closes.at(-1)).toEqual({
      code: WS_CLOSE_CODES.queueLimit,
      reason: 'too many queued requests'
    })
    release()

    const payloadRouter = new RpcRouter(undefined, { maxPayload: 32 })
    const payloadSocket = new FakeWebSocket()
    payloadRouter.attach(payloadSocket.asWebSocket())
    payloadSocket.emitRaw('x'.repeat(33))
    expect(payloadSocket.closes.at(-1)).toEqual({
      code: 1009,
      reason: 'message too large'
    })
  })

  it('caps slow-client output and coalesces replaceable snapshots', async () => {
    vi.useFakeTimers()
    const router = new RpcRouter(undefined, {
      outboundHighWater: 100,
      outboundHardLimit: 400,
      outboundRetryMs: 5
    })
    const socket = new FakeWebSocket()
    socket.bufferedAmount = 100
    router.attach(socket.asWebSocket())

    router.broadcast('push:system', { sequence: 1 })
    router.broadcast('push:system', { sequence: 2 })
    await Promise.resolve()
    expect(socket.frames()).toEqual([])

    socket.bufferedAmount = 0
    await vi.advanceTimersByTimeAsync(5)
    expect(socket.frames()).toEqual([
      {
        kind: 'event',
        channel: 'push:system',
        payload: { sequence: 2 }
      }
    ])

    const slow = new FakeWebSocket()
    slow.bufferedAmount = 400
    router.attach(slow.asWebSocket())
    router.broadcast('term:data', { data: 'x' })
    await Promise.resolve()
    expect(slow.closes.at(-1)).toEqual({
      code: WS_CLOSE_CODES.slowClient,
      reason: 'client too slow'
    })
  })

  it('serializes one mutation resource across clients', async () => {
    const router = new RpcRouter()
    const left = new FakeWebSocket()
    const right = new FakeWebSocket()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let running = 0
    let maxRunning = 0
    const started: number[] = []
    router.registerHandler(
      'settings:mutate',
      async (value: unknown) => {
        running++
        maxRunning = Math.max(maxRunning, running)
        started.push(Number(value))
        if (value === 1) await gate
        running--
        return value
      },
      { resources: ['settings'] }
    )
    router.attach(left.asWebSocket())
    router.attach(right.asWebSocket())

    left.emitJson({ kind: 'invoke', id: 1, channel: 'settings:mutate', args: [1] })
    right.emitJson({ kind: 'invoke', id: 2, channel: 'settings:mutate', args: [2] })
    await settleDispatch()
    expect(started).toEqual([1])
    release()
    await settleDispatch()

    expect(started).toEqual([1, 2])
    expect(maxRunning).toBe(1)
  })

  it('returns stable validation errors and sanitizes unexpected failures', async () => {
    const logger = vi.fn()
    const router = new RpcRouter(logger)
    const socket = new FakeWebSocket()
    router.registerHandler('validate', () => {
      throw new ValidationError('history range is invalid')
    })
    router.registerHandler('explode', () => {
      throw new Error('secret at C:\\private\\token.txt')
    })
    router.attach(socket.asWebSocket())

    socket.emitJson({ kind: 'invoke', id: 1, channel: 'validate', args: [] })
    socket.emitJson({ kind: 'invoke', id: 2, channel: 'explode', args: [] })
    await settleDispatch()

    expect(socket.frames()).toEqual([
      {
        kind: 'error',
        id: 1,
        code: 'VALIDATION_ERROR',
        message: 'history range is invalid'
      },
      {
        kind: 'error',
        id: 2,
        code: 'INTERNAL_ERROR',
        message: 'Internal server error'
      }
    ])
    expect(JSON.stringify(socket.frames())).not.toContain('private')
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('C:\\private\\token.txt'))
  })

  it('rejects new frames during shutdown and drains active RPC work', async () => {
    const router = new RpcRouter()
    const socket = new FakeWebSocket()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    router.registerHandler('slow', async () => {
      await gate
      return 'done'
    })
    router.attach(socket.asWebSocket())
    socket.emitJson({ kind: 'invoke', id: 1, channel: 'slow', args: [] })
    await settleDispatch()

    router.stopAccepting()
    socket.emitJson({ kind: 'invoke', id: 2, channel: 'slow', args: [] })
    let drained = false
    void router.drain().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    release()
    await router.drain()
    expect(socket.frames()).toEqual([
      { kind: 'result', id: 1, value: 'done' },
      {
        kind: 'error',
        id: 2,
        code: 'SERVER_SHUTTING_DOWN',
        message: 'Server is shutting down'
      }
    ])
  })
})
