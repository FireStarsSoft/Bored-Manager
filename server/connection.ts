import type { ConnectionConfig, ConnectionStatus } from '@shared/types'
import { shQuote } from '@shared/shell'
import type { ExecOptions, ExecResult, Executor, StreamHandle } from './executors/types'
import { LocalExecutor } from './executors/local'
import { tracker } from './services/services-tracker'

export class ConnectionManager {
  private executor: Executor | null = null
  private config: ConnectionConfig | null = null
  private sudoPassword = ''
  private isRoot = false
  private lostCbs: Array<() => void> = []

  get current(): Executor | null {
    return this.executor
  }

  get connected(): boolean {
    return this.executor != null
  }

  onConnectionLost(cb: () => void): void {
    this.lostCbs.push(cb)
  }

  async connect(cfg: ConnectionConfig): Promise<void> {
    await this.disconnect()
    let executor: Executor
    if (cfg.mode === 'local') {
      if (process.platform === 'win32') {
        throw new Error('Local mode is only available when running on Linux')
      }
      executor = new LocalExecutor()
    } else {
      // Loaded lazily: ssh2 may pull in optional NATIVE bindings (sshcrypto,
      // cpu-features). Keeping it off the startup path means a broken binding
      // can only ever affect an SSH connect attempt, never app launch.
      const { SSHExecutor } = await import('./executors/ssh')
      const ssh = new SSHExecutor()
      await ssh.connect(cfg)
      ssh.onConnectionLost(() => {
        this.executor = null
        this.config = null
        this.lostCbs.forEach((cb) => cb())
      })
      executor = ssh
    }
    // Sanity check: must be a Linux-ish target with a usable shell.
    const probe = await executor.exec('id -u && uname -s', { timeoutMs: 10000 })
    if (probe.code !== 0) {
      await executor.dispose()
      throw new Error(`Target shell probe failed: ${probe.stderr || probe.stdout}`)
    }
    const [uid] = probe.stdout.trim().split('\n')
    this.isRoot = uid.trim() === '0'
    this.executor = executor
    this.config = cfg
    this.sudoPassword = cfg.sudoPassword || ''

    if (this.sudoPassword && !this.isRoot) {
      const check = await this.execSudo('true', { timeoutMs: 10000 })
      if (check.code !== 0) {
        // Keep the connection but surface the problem.
        throw Object.assign(new Error('Connected, but the sudo password was rejected'), {
          keepConnection: true
        })
      }
    }
  }

  async disconnect(): Promise<void> {
    const ex = this.executor
    this.executor = null
    this.config = null
    this.sudoPassword = ''
    this.isRoot = false
    if (ex) await ex.dispose()
  }

  status(): ConnectionStatus {
    if (!this.executor || !this.config) return { connected: false }
    return {
      connected: true,
      mode: this.config.mode,
      label: this.config.label,
      host: this.config.mode === 'local' ? 'localhost' : this.config.host,
      username: this.config.username,
      isRoot: this.isRoot,
      hasSudo: this.isRoot || !!this.sudoPassword
    }
  }

  exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    if (!this.executor) return Promise.resolve({ stdout: '', stderr: 'not connected', code: 255 })
    return this.executor.exec(command, opts)
  }

  /** Run a command as root: directly if root, via `sudo -S` otherwise. */
  execSudo(command: string, opts?: ExecOptions): Promise<ExecResult> {
    if (!this.executor) return Promise.resolve({ stdout: '', stderr: 'not connected', code: 255 })
    if (this.isRoot) return this.executor.exec(command, opts)
    if (this.sudoPassword) {
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
    if (!this.executor) throw new Error('not connected')
    return this.trackStream(this.executor.stream(command), owner, command)
  }

  /** Long-running command as root (streamed output, e.g. apt-get install). */
  async streamSudo(command: string, owner = 'core'): Promise<StreamHandle> {
    if (!this.executor) throw new Error('not connected')
    const handlePromise = this.isRoot
      ? this.executor.stream(command)
      : this.sudoPassword
        ? this.executor.stream(`sudo -S -p '' bash -c ${shQuote(command)}`).then((h) => {
            h.write(this.sudoPassword + '\n')
            return h
          })
        : this.executor.stream(`sudo -n bash -c ${shQuote(command)}`)
    return this.trackStream(handlePromise, owner, command)
  }

  /** Register a stream/shell handle with the services tracker for its whole lifetime. */
  private async trackStream(
    handlePromise: Promise<StreamHandle>,
    owner: string,
    command: string
  ): Promise<StreamHandle> {
    const handle = await handlePromise
    const unregister = tracker.registerStream(owner, command, handle.pid)
    handle.onExit(() => unregister())
    return handle
  }
}

export const connection = new ConnectionManager()
