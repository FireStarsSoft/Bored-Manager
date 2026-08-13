import { Client, type ClientChannel } from 'ssh2'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { ExecOptions, ExecResult, Executor, ShellHandle, StreamHandle } from './types'
import type { ConnectionConfig } from '@shared/types'

/**
 * The key path is typed in a browser but read on the host, so the shell
 * shorthand a user would write there has to be expanded here - no shell is
 * involved to do it for us.
 */
function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

function wrapChannel(channel: ClientChannel): StreamHandle {
  const dataCbs: Array<(d: string) => void> = []
  const exitCbs: Array<(c: number | null) => void> = []
  channel.on('data', (d: Buffer) => dataCbs.forEach((cb) => cb(d.toString('utf8'))))
  channel.stderr.on('data', (d: Buffer) => dataCbs.forEach((cb) => cb(d.toString('utf8'))))
  channel.on('close', () => exitCbs.forEach((cb) => cb(null)))
  return {
    write: (data) => channel.write(data),
    kill: () => {
      try {
        channel.signal('TERM')
      } catch {
        /* not all servers support signals */
      }
      try {
        channel.close()
      } catch {
        /* ignore */
      }
    },
    onData: (cb) => dataCbs.push(cb),
    onExit: (cb) => exitCbs.push(cb)
  }
}

export class SSHExecutor implements Executor {
  readonly kind = 'ssh' as const
  private client: Client | null = null
  private disposed = false
  private streams = new Set<StreamHandle>()
  private lostCbs: Array<() => void> = []

  async connect(cfg: ConnectionConfig): Promise<void> {
    const client = new Client()
    await new Promise<void>((resolve, reject) => {
      let settled = false
      client.on('ready', () => {
        settled = true
        resolve()
      })
      client.on('error', (err) => {
        if (!settled) {
          settled = true
          reject(err)
        } else {
          this.handleLost()
        }
      })
      client.on('close', () => {
        if (settled && !this.disposed) this.handleLost()
      })
      const connectCfg: Record<string, unknown> = {
        host: cfg.host,
        port: cfg.port || 22,
        username: cfg.username,
        readyTimeout: 15000,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3
      }
      if (cfg.privateKeyPath) {
        connectCfg.privateKey = readFileSync(expandHome(cfg.privateKeyPath))
        if (cfg.password) connectCfg.passphrase = cfg.password
      } else {
        connectCfg.password = cfg.password
      }
      client.connect(connectCfg)
    })
    this.client = client
  }

  onConnectionLost(cb: () => void): void {
    this.lostCbs.push(cb)
  }

  private handleLost(): void {
    if (this.disposed) return
    this.lostCbs.forEach((cb) => cb())
  }

  exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const client = this.client
    if (!client) return Promise.resolve({ stdout: '', stderr: 'not connected', code: 255 })
    return new Promise((resolve) => {
      let done = false
      const finish = (r: ExecResult) => {
        if (!done) {
          done = true
          resolve(r)
        }
      }
      const timeout = opts.timeoutMs ?? 30000
      let timer: NodeJS.Timeout | null = null
      client.exec(command, (err, channel) => {
        if (err) {
          finish({ stdout: '', stderr: String(err), code: 255 })
          return
        }
        let stdout = ''
        let stderr = ''
        let code = 0
        channel.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
        channel.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
        channel.on('exit', (c: number | null) => {
          if (c != null) code = c
        })
        channel.on('close', () => {
          if (timer) clearTimeout(timer)
          finish({ stdout, stderr, code })
        })
        if (opts.stdin != null) channel.write(opts.stdin)
        channel.end()
        if (timeout > 0) {
          timer = setTimeout(() => {
            try {
              channel.close()
            } catch {
              /* ignore */
            }
            finish({ stdout, stderr: stderr + '\n[timeout]', code: 124 })
          }, timeout)
        }
      })
    })
  }

  stream(command: string): Promise<StreamHandle> {
    const client = this.client
    if (!client) return Promise.reject(new Error('not connected'))
    return new Promise((resolve, reject) => {
      client.exec(command, { pty: true }, (err, channel) => {
        if (err) {
          reject(err)
          return
        }
        const handle = wrapChannel(channel)
        this.streams.add(handle)
        handle.onExit(() => this.streams.delete(handle))
        resolve(handle)
      })
    })
  }

  shell(cols: number, rows: number): Promise<ShellHandle> {
    const client = this.client
    if (!client) return Promise.reject(new Error('not connected'))
    return new Promise((resolve, reject) => {
      client.shell({ term: 'xterm-256color', cols, rows }, (err, channel) => {
        if (err) {
          reject(err)
          return
        }
        const base = wrapChannel(channel)
        const handle: ShellHandle = {
          ...base,
          resize: (c, r) => {
            try {
              channel.setWindow(r, c, 0, 0)
            } catch {
              /* ignore */
            }
          }
        }
        this.streams.add(handle)
        handle.onExit(() => this.streams.delete(handle))
        resolve(handle)
      })
    })
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const s of this.streams) {
      try {
        s.kill()
      } catch {
        /* ignore */
      }
    }
    this.streams.clear()
    if (this.client) {
      try {
        this.client.end()
      } catch {
        /* ignore */
      }
      this.client = null
    }
  }
}
