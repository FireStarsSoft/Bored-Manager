import { EventEmitter } from 'node:events'
import type { Client, ClientChannel } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SSHExecutor } from '../../../server/executors/ssh'

type ChannelCallback = (error: Error | undefined, channel: ClientChannel) => void

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

class FakeChannel extends EventEmitter {
  readonly stderr = new EventEmitter()
  readonly write = vi.fn(() => true)
  readonly end = vi.fn()
  readonly signal = vi.fn()
  readonly close = vi.fn()
  readonly destroy = vi.fn()
  readonly setWindow = vi.fn()

  asChannel(): ClientChannel {
    return this as unknown as ClientChannel
  }
}

class FakeClient extends EventEmitter {
  readonly connect = vi.fn()
  readonly end = vi.fn()
  readonly destroy = vi.fn()
  readonly execRequests: Array<{ command: string; callback: ChannelCallback }> = []
  readonly shellRequests: Array<{ callback: ChannelCallback }> = []

  exec(
    command: string,
    optionsOrCallback: unknown,
    possibleCallback?: ChannelCallback
  ): void {
    const callback =
      typeof optionsOrCallback === 'function'
        ? (optionsOrCallback as ChannelCallback)
        : possibleCallback!
    this.execRequests.push({ command, callback })
  }

  shell(_options: unknown, callback: ChannelCallback): void {
    this.shellRequests.push({ callback })
  }

  ready(): void {
    this.emit('ready')
  }

  asClient(): Client {
    return this as unknown as Client
  }
}

async function connectedExecutor(
  options: ConstructorParameters<typeof SSHExecutor>[0] = {}
): Promise<{ executor: SSHExecutor; client: FakeClient }> {
  const client = new FakeClient()
  const executor = new SSHExecutor({
    connectionTimeoutMs: 100,
    channelOpenTimeoutMs: 100,
    killGraceMs: 10,
    ...options,
    clientFactory: () => client.asClient()
  })
  const connecting = executor.connect({
    mode: 'ssh',
    host: 'example.test',
    username: 'tester'
  })
  client.ready()
  await connecting
  return { executor, client }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('SSHExecutor channel and connection lifecycle', () => {
  it('treats a closed exec channel without an exit status as failure', async () => {
    const { executor, client } = await connectedExecutor()
    const result = executor.exec('true', { timeoutMs: 0 })
    await Promise.resolve()
    const channel = new FakeChannel()
    client.execRequests[0].callback(undefined, channel.asChannel())
    await settle()
    channel.emit('close')

    await expect(result).resolves.toMatchObject({
      code: 255,
      stderr: expect.stringContaining('missing SSH exit status')
    })
    await executor.dispose()
  })

  it('bounds concurrent channels and releases a permit on close', async () => {
    const { executor, client } = await connectedExecutor({
      maxChannels: 1,
      maxQueuedChannels: 2
    })
    const firstResult = executor.exec('first', { timeoutMs: 0 })
    const secondResult = executor.exec('second', { timeoutMs: 0 })
    await Promise.resolve()
    expect(client.execRequests.map((request) => request.command)).toEqual(['first'])

    const first = new FakeChannel()
    client.execRequests[0].callback(undefined, first.asChannel())
    await settle()
    first.emit('exit', 0)
    first.emit('close')
    await firstResult
    await settle()
    expect(client.execRequests.map((request) => request.command)).toEqual([
      'first',
      'second'
    ])

    const second = new FakeChannel()
    client.execRequests[1].callback(undefined, second.asChannel())
    await settle()
    second.emit('exit', 0)
    second.emit('close')
    await expect(secondResult).resolves.toMatchObject({ code: 0 })
    await executor.dispose()
  })

  it('sends TERM then KILL and reports command timeout', async () => {
    vi.useFakeTimers()
    const { executor, client } = await connectedExecutor()
    const result = executor.exec('hang', { timeoutMs: 5 })
    await Promise.resolve()
    const channel = new FakeChannel()
    client.execRequests[0].callback(undefined, channel.asChannel())

    await vi.advanceTimersByTimeAsync(5)
    expect(channel.signal).toHaveBeenCalledWith('TERM')
    await vi.advanceTimersByTimeAsync(10)
    expect(channel.signal).toHaveBeenCalledWith('KILL')
    expect(channel.close).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10)

    await expect(result).resolves.toMatchObject({
      code: 124,
      signal: 'KILL',
      stderr: expect.stringContaining('[timeout]')
    })
    expect(vi.getTimerCount()).toBe(0)
    await executor.dispose()
  })

  it('reports known streamed exit status and signal', async () => {
    const { executor, client } = await connectedExecutor()
    const pending = executor.stream('tail -f /tmp/log')
    await Promise.resolve()
    const channel = new FakeChannel()
    client.execRequests[0].callback(undefined, channel.asChannel())
    const handle = await pending
    const exited = vi.fn()
    handle.onExit(exited)

    channel.emit('exit', 143, 'TERM')
    channel.emit('close')

    expect(exited).toHaveBeenCalledWith(143, 'TERM')
    await executor.dispose()
  })

  it('notifies connection loss once for error plus close', async () => {
    const { executor, client } = await connectedExecutor()
    const lost = vi.fn()
    executor.onConnectionLost(lost)

    client.emit('error', new Error('transport failed'))
    client.emit('close')

    expect(lost).toHaveBeenCalledTimes(1)
    await executor.dispose()
  })

  it('aborts handshake cleanup and cancels queued channels on disposal', async () => {
    const handshakeClient = new FakeClient()
    const handshake = new SSHExecutor({
      clientFactory: () => handshakeClient.asClient(),
      connectionTimeoutMs: 1_000
    })
    const controller = new AbortController()
    const connecting = handshake.connect(
      { mode: 'ssh', host: 'slow.example', username: 'tester' },
      { signal: controller.signal }
    )
    controller.abort()
    await expect(connecting).rejects.toMatchObject({ name: 'AbortError' })
    expect(handshakeClient.end).toHaveBeenCalled()
    expect(handshakeClient.destroy).toHaveBeenCalled()

    const { executor, client } = await connectedExecutor({
      maxChannels: 1,
      maxQueuedChannels: 1
    })
    const first = executor.exec('first', { timeoutMs: 0 })
    await Promise.resolve()
    const channel = new FakeChannel()
    client.execRequests[0].callback(undefined, channel.asChannel())
    await settle()
    const queued = executor.exec('queued', { timeoutMs: 0 })
    await Promise.resolve()
    expect(client.execRequests).toHaveLength(1)

    const disposing = executor.dispose()
    channel.emit('close')
    await expect(first).resolves.toMatchObject({ code: 130 })
    await expect(queued).resolves.toMatchObject({ code: 130 })
    await disposing
    expect(client.execRequests).toHaveLength(1)
  })
})
