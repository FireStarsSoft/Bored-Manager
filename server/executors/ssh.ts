import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { Client, type ClientChannel } from 'ssh2'
import type { ConnectionConfig } from '@shared/types'
import { checkHostKey } from '../services/known-hosts'
import {
  resolveOutputLimit,
  type ExecOptions,
  type ExecResult,
  type Executor,
  type ShellHandle,
  type StreamHandle
} from './types'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_CONNECT_TIMEOUT_MS = 16_000
const DEFAULT_CHANNEL_OPEN_TIMEOUT_MS = 30_000
const DEFAULT_KILL_GRACE_MS = 500
const DEFAULT_MAX_CHANNELS = 8
const DEFAULT_MAX_QUEUED_CHANNELS = 64

type StopReason = 'timeout' | 'overflow' | 'cancelled' | 'disposed'
type OpenChannel = (
  callback: (error: Error | undefined, channel: ClientChannel) => void
) => void

export interface SSHExecutorOptions {
  clientFactory?: () => Client
  connectionTimeoutMs?: number
  channelOpenTimeoutMs?: number
  killGraceMs?: number
  maxChannels?: number
  maxQueuedChannels?: number
}

class ChannelSemaphore {
  private active = 0
  private closedError: Error | null = null
  private readonly queue: Array<{
    resolve: (release: () => void) => void
    reject: (error: Error) => void
    signal?: AbortSignal
    onAbort: () => void
  }> = []

  constructor(
    private readonly maximum: number,
    private readonly maximumQueued: number
  ) {}

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.closedError) return Promise.reject(this.closedError)
    if (signal?.aborted) return Promise.reject(abortError())
    if (this.active < this.maximum) {
      this.active++
      return Promise.resolve(this.releaseOnce())
    }
    if (this.queue.length >= this.maximumQueued) {
      return Promise.reject(new Error('SSH channel queue is full'))
    }
    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        signal,
        onAbort: (): void => {
          const index = this.queue.indexOf(entry)
          if (index >= 0) this.queue.splice(index, 1)
          reject(abortError())
        }
      }
      this.queue.push(entry)
      signal?.addEventListener('abort', entry.onAbort, { once: true })
    })
  }

  close(error: Error): void {
    if (this.closedError) return
    this.closedError = error
    for (const entry of this.queue.splice(0)) {
      entry.signal?.removeEventListener('abort', entry.onAbort)
      entry.reject(error)
    }
  }

  private releaseOnce(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.active = Math.max(0, this.active - 1)
      this.drain()
    }
  }

  private drain(): void {
    while (!this.closedError && this.active < this.maximum && this.queue.length > 0) {
      const entry = this.queue.shift()!
      entry.signal?.removeEventListener('abort', entry.onAbort)
      if (entry.signal?.aborted) {
        entry.reject(abortError())
        continue
      }
      this.active++
      entry.resolve(this.releaseOnce())
    }
  }
}

class OperationAbort {
  readonly controller = new AbortController()
  reason: StopReason | null = null
  private timer: NodeJS.Timeout | null = null
  private readonly onExternalAbort = (): void => this.stop('cancelled')

  constructor(external: AbortSignal | undefined, timeoutMs: number) {
    if (external?.aborted) this.stop('cancelled')
    else external?.addEventListener('abort', this.onExternalAbort, { once: true })
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      this.timer = unref(setTimeout(() => this.stop('timeout'), Math.trunc(timeoutMs)))
    }
    this.external = external
  }

  private readonly external: AbortSignal | undefined

  stop(reason: StopReason): void {
    if (this.reason) return
    this.reason = reason
    this.controller.abort()
  }

  cleanup(): void {
    if (this.timer) clearTimeout(this.timer)
    this.external?.removeEventListener('abort', this.onExternalAbort)
  }
}

function unref(timer: NodeJS.Timeout): NodeJS.Timeout {
  timer.unref?.()
  return timer
}

function abortError(): Error {
  const error = new Error('Operation aborted')
  error.name = 'AbortError'
  return error
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

function fanOut<T extends unknown[]>(
  cbs: Array<(...args: T) => void>,
  ...args: T
): void {
  for (const cb of [...cbs]) {
    try {
      cb(...args)
    } catch (error) {
      console.error('[ssh-executor] a stream listener threw:', error)
    }
  }
}

function closeChannel(channel: ClientChannel): void {
  try {
    channel.close()
  } catch {
    try {
      channel.destroy()
    } catch {
      // It may already have closed.
    }
  }
}

function signalChannel(channel: ClientChannel, signal: 'TERM' | 'KILL'): void {
  try {
    channel.signal(signal)
  } catch {
    // Servers are allowed not to implement SSH signal requests.
  }
}

async function waitBounded(work: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | null = null
  await Promise.race([
    work,
    new Promise<void>((resolve) => {
      timer = unref(setTimeout(resolve, timeoutMs))
    })
  ])
  if (timer) clearTimeout(timer)
}

class SSHChannelHandle implements ShellHandle {
  readonly resizeSupported: boolean
  readonly closed: Promise<void>
  private resolveClosed!: () => void
  private readonly stdoutDecoder = new StringDecoder('utf8')
  private readonly stderrDecoder = new StringDecoder('utf8')
  private readonly dataCbs: Array<(data: string) => void> = []
  private readonly exitCbs: Array<(code: number | null, signal?: string) => void> = []
  private finished = false
  private exitCode: number | null = null
  private exitSignal: string | undefined
  private killTimer: NodeJS.Timeout | null = null
  private forceTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly channel: ClientChannel,
    private readonly killGraceMs: number,
    private readonly onFinish: () => void,
    private readonly shell: boolean
  ) {
    this.resizeSupported = shell
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve
    })
    channel.on('data', this.onStdout)
    channel.stderr.on('data', this.onStderr)
    channel.on('exit', this.onExitStatus)
    channel.on('error', this.onError)
    channel.on('close', this.onClose)
    if (channel.closed || channel.destroyed) queueMicrotask(this.onClose)
  }

  write(data: string): void {
    if (!this.finished) this.channel.write(data)
  }

  kill(): void {
    if (this.finished || this.killTimer) return
    signalChannel(this.channel, 'TERM')
    this.killTimer = unref(
      setTimeout(() => {
        signalChannel(this.channel, 'KILL')
        closeChannel(this.channel)
        this.forceTimer = unref(
          setTimeout(() => this.finish(this.exitCode, this.exitSignal), this.killGraceMs)
        )
      }, this.killGraceMs)
    )
  }

  onData(cb: (data: string) => void): void {
    if (!this.finished) this.dataCbs.push(cb)
  }

  onExit(cb: (code: number | null, signal?: string) => void): void {
    if (this.finished) {
      queueMicrotask(() => cb(this.exitCode, this.exitSignal))
      return
    }
    this.exitCbs.push(cb)
  }

  resize(cols: number, rows: number): void {
    if (!this.shell || this.finished) return
    try {
      this.channel.setWindow(rows, cols, 0, 0)
    } catch {
      // The shell may have closed between the caller's check and this request.
    }
  }

  private readonly onStdout = (data: Buffer): void => {
    fanOut(this.dataCbs, this.stdoutDecoder.write(data))
  }

  private readonly onStderr = (data: Buffer): void => {
    fanOut(this.dataCbs, this.stderrDecoder.write(data))
  }

  private readonly onExitStatus = (code: number | null, signal?: string): void => {
    this.exitCode = code
    this.exitSignal = signal || undefined
  }

  private readonly onError = (error: Error): void => {
    fanOut(this.dataCbs, `\r\n[SSH channel error: ${String(error)}]\r\n`)
    closeChannel(this.channel)
  }

  private readonly onClose = (): void => this.finish(this.exitCode, this.exitSignal)

  private finish(code: number | null, signal?: string): void {
    if (this.finished) return
    this.finished = true
    const tail = this.stdoutDecoder.end() + this.stderrDecoder.end()
    if (tail) fanOut(this.dataCbs, tail)
    this.exitCode = code
    this.exitSignal = signal
    if (this.killTimer) clearTimeout(this.killTimer)
    if (this.forceTimer) clearTimeout(this.forceTimer)
    this.channel.removeListener('data', this.onStdout)
    this.channel.stderr.removeListener('data', this.onStderr)
    this.channel.removeListener('exit', this.onExitStatus)
    this.channel.removeListener('error', this.onError)
    this.channel.removeListener('close', this.onClose)
    this.onFinish()
    fanOut(this.exitCbs, code, signal)
    this.dataCbs.length = 0
    this.exitCbs.length = 0
    this.resolveClosed()
  }
}

export class SSHExecutor implements Executor {
  readonly kind = 'ssh' as const
  private readonly clientFactory: () => Client
  private readonly connectionTimeoutMs: number
  private readonly channelOpenTimeoutMs: number
  private readonly killGraceMs: number
  private readonly channels: ChannelSemaphore
  private client: Client | null = null
  private disposed = false
  private disposePromise: Promise<void> | null = null
  private lostNotified = false
  private readonly lostCbs = new Set<() => void>()
  private readonly operationAborts = new Set<OperationAbort>()
  private readonly activeChannels = new Set<ClientChannel>()
  private readonly handles = new Set<SSHChannelHandle>()
  private readonly inFlightExecs = new Set<Promise<ExecResult>>()

  constructor(options: SSHExecutorOptions = {}) {
    this.clientFactory = options.clientFactory ?? (() => new Client())
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.channelOpenTimeoutMs = options.channelOpenTimeoutMs ?? DEFAULT_CHANNEL_OPEN_TIMEOUT_MS
    this.killGraceMs = Math.max(10, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS)
    this.channels = new ChannelSemaphore(
      Math.max(1, options.maxChannels ?? DEFAULT_MAX_CHANNELS),
      Math.max(0, options.maxQueuedChannels ?? DEFAULT_MAX_QUEUED_CHANNELS)
    )
  }

  async connect(
    cfg: ConnectionConfig,
    options: { signal?: AbortSignal } = {}
  ): Promise<void> {
    if (this.disposed) throw new Error('SSH executor disposed')
    if (this.client) throw new Error('SSH executor is already connected')
    const client = this.clientFactory()
    const host = cfg.host ?? ''
    const port = cfg.port || 22

    await new Promise<void>((resolve, reject) => {
      let settled = false
      let timer: NodeJS.Timeout | null = null
      const cleanupHandshake = (keepLossListeners: boolean): void => {
        if (timer) clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        client.removeListener('ready', onReady)
        if (!keepLossListeners) {
          client.removeListener('error', onError)
          client.removeListener('close', onClose)
        }
      }
      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        // Keep the error/close listeners on this discarded client while it is
        // being destroyed; ssh2 may emit a final asynchronous error, and an
        // unhandled EventEmitter "error" would terminate the server.
        cleanupHandshake(true)
        this.closeClient(client, true)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      const onReady = (): void => {
        if (settled) return
        settled = true
        this.client = client
        cleanupHandshake(true)
        resolve()
      }
      const onError = (error: Error): void => {
        if (!settled) fail(error)
        else this.handleLost()
      }
      const onClose = (): void => {
        if (!settled) fail(new Error('SSH connection closed during handshake'))
        else this.handleLost()
      }
      const onAbort = (): void => fail(abortError())

      client.once('ready', onReady)
      client.on('error', onError)
      client.on('close', onClose)
      if (options.signal?.aborted) {
        fail(abortError())
        return
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      if (this.connectionTimeoutMs > 0) {
        timer = unref(
          setTimeout(
            () => fail(new Error('SSH connection timed out')),
            this.connectionTimeoutMs
          )
        )
      }

      const connectConfig: Record<string, unknown> = {
        host,
        port,
        username: cfg.username,
        readyTimeout: this.connectionTimeoutMs,
        keepaliveInterval: 10_000,
        keepaliveCountMax: 3,
        hostHash: 'sha256',
        hostVerifier: (fingerprint: string) => {
          try {
            checkHostKey(host, port, fingerprint, cfg.hostKeyConfirmation)
            return true
          } catch (error) {
            fail(error)
            return false
          }
        }
      }
      try {
        if (cfg.privateKeyPath) {
          connectConfig.privateKey = readFileSync(expandHome(cfg.privateKeyPath))
          if (cfg.password) connectConfig.passphrase = cfg.password
        } else {
          connectConfig.password = cfg.password
        }
        client.connect(connectConfig)
      } catch (error) {
        fail(error)
      }
    })
  }

  onConnectionLost(cb: () => void): () => void {
    if (this.lostNotified) {
      queueMicrotask(cb)
      return () => {}
    }
    this.lostCbs.add(cb)
    return () => this.lostCbs.delete(cb)
  }

  exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const operation = this.execInternal(command, options)
    this.inFlightExecs.add(operation)
    void operation
      .catch(() => undefined)
      .finally(() => this.inFlightExecs.delete(operation))
    return operation
  }

  private async execInternal(command: string, options: ExecOptions): Promise<ExecResult> {
    const client = this.client
    if (!client || this.disposed) {
      return { stdout: '', stderr: 'not connected', code: 255 }
    }
    const outputLimit = resolveOutputLimit(options.maxOutputBytes)
    const abort = new OperationAbort(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    this.operationAborts.add(abort)
    let opened: { channel: ClientChannel; release: () => void }
    try {
      opened = await this.requestChannel(
        (callback) => client.exec(command, callback),
        abort.controller.signal
      )
    } catch (error) {
      this.operationAborts.delete(abort)
      abort.cleanup()
      if (abort.reason) return this.stoppedResult(abort.reason)
      return { stdout: '', stderr: String(error), code: 255 }
    }

    try {
      return await this.collectExec(opened.channel, opened.release, options, outputLimit, abort)
    } finally {
      this.operationAborts.delete(abort)
      abort.cleanup()
    }
  }

  private collectExec(
    channel: ClientChannel,
    release: () => void,
    options: ExecOptions,
    outputLimit: number,
    abort: OperationAbort
  ): Promise<ExecResult> {
    return new Promise((resolve) => {
      const stdoutDecoder = new StringDecoder('utf8')
      const stderrDecoder = new StringDecoder('utf8')
      let stdout = ''
      let stderr = ''
      let bytes = 0
      let exitCode: number | null = null
      let exitSignal: string | undefined
      let finished = false
      let killTimer: NodeJS.Timeout | null = null
      let forceTimer: NodeJS.Timeout | null = null

      const stoppedCode = (): number => {
        switch (abort.reason) {
          case 'timeout':
            return 124
          case 'overflow':
            return 125
          case 'cancelled':
          case 'disposed':
            return 130
          default:
            return 255
        }
      }
      const note = (): string => {
        if (!abort.reason) return ''
        return abort.reason === 'cancelled' || abort.reason === 'disposed'
          ? '[cancelled]'
          : `[${abort.reason}]`
      }
      const cleanup = (): void => {
        if (killTimer) clearTimeout(killTimer)
        if (forceTimer) clearTimeout(forceTimer)
        abort.controller.signal.removeEventListener('abort', onAbort)
        channel.removeListener('data', onStdout)
        channel.stderr.removeListener('data', onStderr)
        channel.removeListener('exit', onExit)
        channel.removeListener('error', onError)
        channel.removeListener('close', onClose)
        this.activeChannels.delete(channel)
        release()
      }
      const finish = (forcedCode?: number, forcedSignal?: string): void => {
        if (finished) return
        finished = true
        stdout += stdoutDecoder.end()
        stderr += stderrDecoder.end()
        let code = forcedCode ?? exitCode
        const signal = forcedSignal ?? exitSignal
        if (abort.reason) {
          code = stoppedCode()
          stderr += `${stderr ? '\n' : ''}${note()}`
        } else if (code === null) {
          code = 255
          stderr += `${stderr ? '\n' : ''}[missing SSH exit status]`
        }
        cleanup()
        resolve({
          stdout,
          stderr,
          code,
          ...(signal ? { signal } : {})
        })
      }
      const terminate = (): void => {
        if (finished || killTimer) return
        signalChannel(channel, 'TERM')
        killTimer = unref(
          setTimeout(() => {
            signalChannel(channel, 'KILL')
            closeChannel(channel)
            forceTimer = unref(
              setTimeout(() => finish(stoppedCode(), 'KILL'), this.killGraceMs)
            )
          }, this.killGraceMs)
        )
      }
      const capture = (
        chunk: Buffer,
        decoder: StringDecoder,
        append: (text: string) => void
      ): void => {
        if (finished || abort.reason) return
        const remaining = outputLimit - bytes
        if (chunk.length <= remaining) {
          bytes += chunk.length
          append(decoder.write(chunk))
          return
        }
        if (remaining > 0) {
          bytes += remaining
          append(decoder.write(chunk.subarray(0, remaining)))
        }
        abort.stop('overflow')
      }
      const onStdout = (data: Buffer): void =>
        capture(data, stdoutDecoder, (text) => {
          stdout += text
        })
      const onStderr = (data: Buffer): void =>
        capture(data, stderrDecoder, (text) => {
          stderr += text
        })
      const onExit = (code: number | null, signal?: string): void => {
        exitCode = code
        exitSignal = signal || undefined
      }
      const onError = (error: Error): void => {
        stderr += `${stderr ? '\n' : ''}${String(error)}`
        closeChannel(channel)
        finish(255)
      }
      const onClose = (): void => finish()
      const onAbort = (): void => terminate()

      try {
        channel.on('data', onStdout)
        channel.stderr.on('data', onStderr)
        channel.on('exit', onExit)
        channel.on('error', onError)
        channel.on('close', onClose)
        abort.controller.signal.addEventListener('abort', onAbort, { once: true })
        if (abort.controller.signal.aborted) terminate()
        if (channel.closed || channel.destroyed) queueMicrotask(onClose)
        if (options.stdin !== undefined) channel.write(options.stdin)
        channel.end()
      } catch (error) {
        stderr += `${stderr ? '\n' : ''}${String(error)}`
        closeChannel(channel)
        finish(255)
      }
    })
  }

  async stream(command: string): Promise<StreamHandle> {
    const client = this.requireClient()
    const abort = new OperationAbort(undefined, this.channelOpenTimeoutMs)
    this.operationAborts.add(abort)
    try {
      const opened = await this.requestChannel(
        (callback) => client.exec(command, { pty: true }, callback),
        abort.controller.signal
      )
      return this.makeHandle(opened.channel, opened.release, false)
    } finally {
      this.operationAborts.delete(abort)
      abort.cleanup()
    }
  }

  async shell(cols: number, rows: number): Promise<ShellHandle> {
    const client = this.requireClient()
    const abort = new OperationAbort(undefined, this.channelOpenTimeoutMs)
    this.operationAborts.add(abort)
    try {
      const opened = await this.requestChannel(
        (callback) =>
          client.shell({ term: 'xterm-256color', cols, rows }, callback),
        abort.controller.signal
      )
      return this.makeHandle(opened.channel, opened.release, true)
    } finally {
      this.operationAborts.delete(abort)
      abort.cleanup()
    }
  }

  private makeHandle(
    channel: ClientChannel,
    release: () => void,
    shell: boolean
  ): SSHChannelHandle {
    try {
      let handle!: SSHChannelHandle
      handle = new SSHChannelHandle(
        channel,
        this.killGraceMs,
        () => {
          this.activeChannels.delete(channel)
          this.handles.delete(handle)
          release()
        },
        shell
      )
      this.handles.add(handle)
      if (this.disposed) handle.kill()
      return handle
    } catch (error) {
      this.activeChannels.delete(channel)
      release()
      closeChannel(channel)
      throw error
    }
  }

  private async requestChannel(
    open: OpenChannel,
    signal: AbortSignal
  ): Promise<{ channel: ClientChannel; release: () => void }> {
    if (this.disposed || !this.client) throw new Error('SSH executor disposed')
    const release = await this.channels.acquire(signal)
    return new Promise((resolve, reject) => {
      let settled = false
      const cleanup = (): void => signal.removeEventListener('abort', onAbort)
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        release()
        reject(error)
      }
      const onAbort = (): void => fail(abortError())
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) {
        fail(abortError())
        return
      }
      try {
        open((error, channel) => {
          if (settled) {
            if (channel) closeChannel(channel)
            return
          }
          if (error || !channel) {
            fail(error ?? new Error('SSH server returned no channel'))
            return
          }
          settled = true
          cleanup()
          this.activeChannels.add(channel)
          resolve({ channel, release })
        })
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposed = true
    this.channels.close(new Error('SSH executor disposed'))
    for (const abort of this.operationAborts) abort.stop('disposed')
    for (const handle of this.handles) {
      try {
        handle.kill()
      } catch {
        // Continue closing the remaining channels.
      }
    }
    for (const channel of this.activeChannels) {
      signalChannel(channel, 'TERM')
    }

    const client = this.client
    this.client = null
    if (client) this.closeClient(client, false)

    const work = Promise.allSettled([
      ...this.inFlightExecs,
      ...[...this.handles].map((handle) => handle.closed)
    ])
    this.disposePromise = (async () => {
      await waitBounded(work, this.killGraceMs * 3 + 1_000)
      for (const channel of this.activeChannels) {
        signalChannel(channel, 'KILL')
        closeChannel(channel)
      }
      if (client) this.closeClient(client, true)
      this.activeChannels.clear()
      this.handles.clear()
      this.operationAborts.clear()
    })()
    return this.disposePromise
  }

  private stoppedResult(reason: StopReason): ExecResult {
    const code = reason === 'timeout' ? 124 : reason === 'overflow' ? 125 : 130
    const label = reason === 'cancelled' || reason === 'disposed' ? 'cancelled' : reason
    return { stdout: '', stderr: `[${label}]`, code }
  }

  private requireClient(): Client {
    if (!this.client || this.disposed) throw new Error('not connected')
    return this.client
  }

  private handleLost(): void {
    if (this.disposed || this.lostNotified || !this.client) return
    this.lostNotified = true
    for (const cb of this.lostCbs) {
      try {
        cb()
      } catch (error) {
        console.error('[ssh-executor] connection-lost callback failed:', error)
      }
    }
  }

  private closeClient(client: Client, force: boolean): void {
    try {
      client.end()
    } catch {
      // Continue to destroy on forced cleanup.
    }
    if (force) {
      try {
        client.destroy()
      } catch {
        // Already closed.
      }
    }
  }
}
