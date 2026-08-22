import type { ConnectionConfig, ConnectionStatus } from '@shared/types'
import { shQuote } from '@shared/shell'
import type {
  ExecOptions,
  ExecResult,
  Executor,
  ReadFileResult,
  StreamHandle
} from './executors/types'
import { LocalExecutor } from './executors/local'
import { tracker } from './services/services-tracker'

export type ConnectionPhase = 'idle' | 'connecting' | 'connected' | 'disconnecting'
export type SudoState = 'none' | 'root' | 'passwordless' | 'password-verified'

export interface ConnectOutcome {
  sudoState: SudoState
  sudoPasswordRejected: boolean
  warning?: string
}

interface LossAwareExecutor extends Executor {
  onConnectionLost(cb: () => void): void
}

interface CommittedConfig {
  mode: ConnectionConfig['mode']
  label?: string
  host?: string
  username?: string
}

export interface ConnectionManagerOptions {
  platform?: NodeJS.Platform
  createLocal?: (signal: AbortSignal) => Executor | Promise<Executor>
  createSsh?: (cfg: ConnectionConfig, signal: AbortSignal) => Executor | Promise<Executor>
}

export class ConnectionCancelledError extends Error {
  constructor() {
    super('Connection attempt was superseded or cancelled')
    this.name = 'ConnectionCancelledError'
  }
}

type BeforeSwapHook = (
  current: Readonly<ConnectionStatus>,
  next: Readonly<ConnectionStatus>
) => void

export class ConnectionManager {
  private executor: Executor | null = null
  private config: CommittedConfig | null = null
  private sudoPassword = ''
  private sudoState: SudoState = 'none'
  private phaseValue: ConnectionPhase = 'idle'
  private requestGeneration = 0
  private activeGeneration = 0
  private readonly attempts = new Set<Promise<ConnectOutcome>>()
  private readonly attemptAborts = new Map<number, AbortController>()
  private readonly lostExecutors = new WeakSet<Executor>()
  private readonly lostCbs = new Set<() => void>()
  private beforeSwap: BeforeSwapHook | null = null

  constructor(private readonly options: ConnectionManagerOptions = {}) {}

  get current(): Executor | null {
    return this.executor
  }

  get connected(): boolean {
    return this.executor != null
  }

  get phase(): ConnectionPhase {
    return this.phaseValue
  }

  onConnectionLost(cb: () => void): () => void {
    this.lostCbs.add(cb)
    return () => this.lostCbs.delete(cb)
  }

  /**
   * Called only after a replacement has passed every probe, immediately
   * before the atomic swap. Keep this synchronous so another request cannot
   * invalidate the candidate halfway through old-host teardown.
   */
  setBeforeSwap(hook: BeforeSwapHook | null): void {
    this.beforeSwap = hook
  }

  connect(cfg: ConnectionConfig): Promise<ConnectOutcome> {
    const generation = ++this.requestGeneration
    for (const controller of this.attemptAborts.values()) controller.abort()
    const controller = new AbortController()
    this.attemptAborts.set(generation, controller)
    this.phaseValue = 'connecting'

    const attempt = this.connectAttempt(cfg, generation, controller)
    this.attempts.add(attempt)
    void attempt
      .catch(() => undefined)
      .finally(() => {
        this.attempts.delete(attempt)
        if (this.attemptAborts.get(generation) === controller) {
          this.attemptAborts.delete(generation)
        }
        if (
          generation === this.requestGeneration &&
          !this.executor &&
          this.phaseValue === 'connecting'
        ) {
          this.phaseValue = 'idle'
        }
      })
    return attempt
  }

  private async connectAttempt(
    cfg: ConnectionConfig,
    generation: number,
    controller: AbortController
  ): Promise<ConnectOutcome> {
    let candidate: Executor | null = null
    let committed = false
    try {
      candidate = await this.buildExecutor(cfg, controller.signal)
      this.assertCurrentAttempt(generation, controller.signal)
      const capability = await this.probeCandidate(candidate, cfg, controller.signal)
      this.assertCurrentAttempt(generation, controller.signal)

      const nextStatus = this.statusFor(cfg, capability.sudoState)
      const old = this.executor
      if (old) this.beforeSwap?.(this.status(), nextStatus)
      // The hook is deliberately synchronous, but it may itself start another
      // operation. Re-check before publishing the candidate.
      this.assertCurrentAttempt(generation, controller.signal)

      const activeGeneration = ++this.activeGeneration
      this.executor = candidate
      this.config = {
        mode: cfg.mode,
        label: cfg.label,
        host: cfg.host,
        username: cfg.username
      }
      this.sudoState = capability.sudoState
      this.sudoPassword =
        capability.sudoState === 'password-verified' ? cfg.sudoPassword ?? '' : ''
      this.phaseValue = 'connected'
      committed = true

      const committedExecutor = candidate
      if (this.isLossAware(committedExecutor)) {
        committedExecutor.onConnectionLost(() =>
          this.handleConnectionLost(committedExecutor, activeGeneration)
        )
      }
      candidate = null

      if (old && old !== committedExecutor) await this.disposeQuietly(old)
      return {
        sudoState: capability.sudoState,
        sudoPasswordRejected: capability.sudoPasswordRejected,
        ...(capability.warning ? { warning: capability.warning } : {})
      }
    } catch (error) {
      if (candidate && !committed) await this.disposeQuietly(candidate)
      if (generation === this.requestGeneration) {
        this.phaseValue = this.executor ? 'connected' : 'idle'
      }
      if (
        error instanceof ConnectionCancelledError ||
        controller.signal.aborted ||
        generation !== this.requestGeneration
      ) {
        throw new ConnectionCancelledError()
      }
      throw error
    }
  }

  private async buildExecutor(cfg: ConnectionConfig, signal: AbortSignal): Promise<Executor> {
    if (cfg.mode === 'local') {
      if ((this.options.platform ?? process.platform) === 'win32') {
        throw new Error('Local mode is only available when running on Linux')
      }
      return this.options.createLocal?.(signal) ?? new LocalExecutor()
    }

    if (this.options.createSsh) return this.options.createSsh(cfg, signal)
    // Loaded lazily: ssh2 may pull in optional native bindings. A broken
    // binding can therefore affect an SSH attempt, but never app startup.
    const { SSHExecutor } = await import('./executors/ssh')
    const ssh = new SSHExecutor()
    await ssh.connect(cfg, { signal })
    return ssh
  }

  private async probeCandidate(
    executor: Executor,
    cfg: ConnectionConfig,
    signal: AbortSignal
  ): Promise<{
    sudoState: SudoState
    sudoPasswordRejected: boolean
    warning?: string
  }> {
    const probe = await executor.exec('id -u && uname -s', {
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
      signal
    })
    if (probe.code !== 0) {
      throw new Error(`Target shell probe failed: ${probe.stderr || probe.stdout}`)
    }
    const lines = probe.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    const uid = lines[0] ?? ''
    const kernel = lines[1] ?? ''
    if (!/^\d+$/.test(uid) || kernel.toLowerCase() !== 'linux') {
      throw new Error('Target must be Linux and return a numeric uid')
    }
    if (uid === '0') {
      return { sudoState: 'root', sudoPasswordRejected: false }
    }

    const passwordless = await executor.exec('sudo -n true', {
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
      signal
    })
    if (passwordless.code === 0) {
      return { sudoState: 'passwordless', sudoPasswordRejected: false }
    }

    if (!cfg.sudoPassword) {
      return { sudoState: 'none', sudoPasswordRejected: false }
    }
    const verified = await executor.exec("sudo -S -k -p '' true", {
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
      signal,
      stdin: `${cfg.sudoPassword}\n`
    })
    if (verified.code === 0) {
      return { sudoState: 'password-verified', sudoPasswordRejected: false }
    }
    return {
      sudoState: 'none',
      sudoPasswordRejected: true,
      warning: 'Connected, but the sudo password was rejected'
    }
  }

  private assertCurrentAttempt(generation: number, signal: AbortSignal): void {
    if (signal.aborted || generation !== this.requestGeneration) {
      throw new ConnectionCancelledError()
    }
  }

  private isLossAware(executor: Executor): executor is LossAwareExecutor {
    return (
      'onConnectionLost' in executor &&
      typeof (executor as Partial<LossAwareExecutor>).onConnectionLost === 'function'
    )
  }

  private handleConnectionLost(executor: Executor, generation: number): void {
    if (
      this.executor !== executor ||
      this.activeGeneration !== generation ||
      this.lostExecutors.has(executor)
    ) {
      return
    }
    this.lostExecutors.add(executor)
    this.executor = null
    this.config = null
    this.sudoPassword = ''
    this.sudoState = 'none'
    this.activeGeneration++
    this.phaseValue = this.attemptAborts.size > 0 ? 'connecting' : 'idle'
    void this.disposeQuietly(executor)
    for (const cb of this.lostCbs) {
      try {
        cb()
      } catch (error) {
        console.error('[connection] connection-lost callback failed:', error)
      }
    }
  }

  async disconnect(): Promise<void> {
    const generation = ++this.requestGeneration
    this.phaseValue = 'disconnecting'
    for (const controller of this.attemptAborts.values()) controller.abort()
    this.attemptAborts.clear()

    const ex = this.executor
    this.executor = null
    this.config = null
    this.sudoPassword = ''
    this.sudoState = 'none'
    this.activeGeneration++

    const pending = [...this.attempts]
    await Promise.allSettled([
      ...(ex ? [this.disposeQuietly(ex)] : []),
      ...pending
    ])
    if (generation === this.requestGeneration) {
      this.phaseValue = this.executor ? 'connected' : 'idle'
    }
  }

  status(): ConnectionStatus {
    if (!this.executor || !this.config) return { connected: false }
    return {
      connected: true,
      mode: this.config.mode,
      label: this.config.label,
      host: this.config.mode === 'local' ? 'localhost' : this.config.host,
      username: this.config.username,
      isRoot: this.sudoState === 'root',
      hasSudo: this.sudoState !== 'none'
    }
  }

  private statusFor(cfg: ConnectionConfig, sudoState: SudoState): ConnectionStatus {
    return {
      connected: true,
      mode: cfg.mode,
      label: cfg.label,
      host: cfg.mode === 'local' ? 'localhost' : cfg.host,
      username: cfg.username,
      isRoot: sudoState === 'root',
      hasSudo: sudoState !== 'none'
    }
  }

  exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    if (!this.executor) return Promise.resolve({ stdout: '', stderr: 'not connected', code: 255 })
    return this.executor.exec(command, opts)
  }

  readFiles(paths: string[]): Promise<ReadFileResult[] | null> {
    const readFiles = this.executor?.readFiles
    if (!readFiles) return Promise.resolve(null)
    return readFiles.call(this.executor, paths)
  }

  /** Run a command as root: directly if root, via `sudo -S` otherwise. */
  execSudo(command: string, opts?: ExecOptions): Promise<ExecResult> {
    if (!this.executor) return Promise.resolve({ stdout: '', stderr: 'not connected', code: 255 })
    if (this.sudoState === 'root') return this.executor.exec(command, opts)
    if (this.sudoState === 'password-verified' && this.sudoPassword) {
      return this.executor.exec(`sudo -S -p '' bash -c ${shQuote(command)}`, {
        ...opts,
        stdin: this.sudoPassword + '\n' + (opts?.stdin ?? '')
      })
    }
    // Try passwordless sudo as a last resort.
    return this.executor.exec(`sudo -n bash -c ${shQuote(command)}`, opts)
  }

  /**
   * Long-running command (e.g. `docker logs -f`). `owner` is who to blame for
   * it in the services tracker - 'core' (package actions, anything the app
   * runs for itself) unless a module started it.
   */
  async stream(command: string, owner = 'core'): Promise<StreamHandle> {
    const executor = this.executor
    if (!executor) throw new Error('not connected')
    return this.trackStream(executor, executor.stream(command), owner, command)
  }

  /** Long-running command as root (streamed output, e.g. apt-get install). */
  async streamSudo(command: string, owner = 'core'): Promise<StreamHandle> {
    const executor = this.executor
    if (!executor) throw new Error('not connected')
    const handlePromise = this.sudoState === 'root'
      ? executor.stream(command)
      : this.sudoState === 'password-verified' && this.sudoPassword
        ? executor.stream(`sudo -S -p '' bash -c ${shQuote(command)}`).then((h) => {
            h.write(this.sudoPassword + '\n')
            return h
          })
        : executor.stream(`sudo -n bash -c ${shQuote(command)}`)
    return this.trackStream(executor, handlePromise, owner, command)
  }

  /** Register a stream/shell handle with the services tracker for its whole lifetime. */
  private async trackStream(
    executor: Executor,
    handlePromise: Promise<StreamHandle>,
    owner: string,
    command: string
  ): Promise<StreamHandle> {
    const handle = await handlePromise
    if (this.executor !== executor) {
      handle.kill()
      throw new Error('connection changed before the command started')
    }
    const unregister = tracker.registerStream(owner, command, handle.pid)
    handle.onExit(() => unregister())
    return handle
  }

  private async disposeQuietly(executor: Executor): Promise<void> {
    try {
      await executor.dispose()
    } catch (error) {
      console.error('[connection] executor disposal failed:', error)
    }
  }
}

export const connection = new ConnectionManager()
