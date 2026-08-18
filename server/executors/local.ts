import { spawn, spawnSync, ChildProcess } from 'child_process'
import { createRequire } from 'module'
import type { ExecOptions, ExecResult, Executor, ShellHandle, StreamHandle } from './types'

const require = createRequire(import.meta.url)

// node-pty is an optional NATIVE addon. A broken build (e.g. compiled against
// the system Node ABI instead of Electron's) does not throw on require() - it
// SEGFAULTS the whole process, which a try/catch cannot stop. So:
//  - never load it at startup (this module is imported by main.ts),
//  - before loading it in-process, prove it is loadable in a disposable child
//    process running Electron's own Node (same V8/ABI as this process).
let nodePty: unknown | null | undefined // undefined = not probed yet, null = unusable
function loadNodePty(): any | null {
  if (nodePty !== undefined) return nodePty
  nodePty = null
  try {
    const entry = require.resolve('node-pty')
    const probe = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(entry)})`], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 10_000,
      stdio: 'ignore'
    })
    if (probe.status === 0) {
      nodePty = require('node-pty')
      console.log('[local-executor] node-pty loaded (native PTY for local terminals)')
    } else {
      console.error(
        `[local-executor] node-pty failed its load probe ` +
          `(status=${probe.status ?? 'none'}, signal=${probe.signal ?? 'none'}) - ` +
          `it was probably built for the wrong ABI. Using the 'script' fallback. ` +
          `Re-run ./install.sh to rebuild or remove it.`
      )
    }
  } catch {
    // Not installed at all - fine, the 'script' fallback below covers it.
  }
  return nodePty
}

/**
 * Dispatch to every listener, isolating each one. These run inside a stream's
 * 'data'/'exit' event, where a throw is an uncaught exception that takes the
 * whole server down - and the listeners belong to modules, which is exactly
 * the code that should not be able to do that.
 */
function fanOut<T>(cbs: Array<(value: T) => void>, value: T): void {
  for (const cb of cbs) {
    try {
      cb(value)
    } catch (err) {
      console.error('[local-executor] a stream listener threw:', err)
    }
  }
}

function wrapChild(child: ChildProcess): StreamHandle {
  const dataCbs: Array<(d: string) => void> = []
  const exitCbs: Array<(c: number | null) => void> = []
  child.stdout?.on('data', (d: Buffer) => fanOut(dataCbs, d.toString('utf8')))
  child.stderr?.on('data', (d: Buffer) => fanOut(dataCbs, d.toString('utf8')))
  child.on('exit', (code) => fanOut(exitCbs, code))
  return {
    write: (data) => child.stdin?.write(data),
    kill: () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
    },
    onData: (cb) => dataCbs.push(cb),
    onExit: (cb) => exitCbs.push(cb),
    pid: child.pid
  }
}

export class LocalExecutor implements Executor {
  readonly kind = 'local' as const
  private disposed = false
  private streams = new Set<StreamHandle>()

  exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    return new Promise((resolve) => {
      const child = spawn('bash', ['-c', command], { env: { ...process.env, LANG: 'C' } })
      let stdout = ''
      let stderr = ''
      let done = false
      const finish = (code: number) => {
        if (done) return
        done = true
        resolve({ stdout, stderr, code })
      }
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
      child.on('error', (err) => {
        stderr += String(err)
        finish(127)
      })
      child.on('close', (code) => finish(code ?? 1))
      if (opts.stdin != null) {
        child.stdin.write(opts.stdin)
      }
      child.stdin.end()
      const timeout = opts.timeoutMs ?? 30000
      if (timeout > 0) {
        setTimeout(() => {
          if (!done) {
            child.kill('SIGKILL')
            stderr += '\n[timeout]'
            finish(124)
          }
        }, timeout)
      }
    })
  }

  async stream(command: string): Promise<StreamHandle> {
    const child = spawn('bash', ['-c', command], {
      env: { ...process.env, LANG: 'C' },
      detached: true
    })
    const handle = wrapChild(child)
    this.streams.add(handle)
    handle.onExit(() => this.streams.delete(handle))
    return handle
  }

  async shell(cols: number, rows: number): Promise<ShellHandle> {
    const shellCmd = process.env.SHELL || 'bash'
    const nodePty = loadNodePty()
    if (nodePty) {
      const pty = nodePty.spawn(shellCmd, ['-l'], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: process.env.HOME || process.cwd(),
        env: { ...process.env, TERM: 'xterm-256color' }
      })
      const handle: ShellHandle = {
        write: (data) => pty.write(data),
        kill: () => pty.kill(),
        onData: (cb) => pty.onData(cb),
        onExit: (cb) => pty.onExit(({ exitCode }: { exitCode: number }) => cb(exitCode)),
        resize: (c, r) => {
          try {
            pty.resize(c, r)
          } catch {
            /* ignore */
          }
        },
        pid: pty.pid
      }
      this.streams.add(handle)
      handle.onExit(() => this.streams.delete(handle))
      return handle
    }
    // Fallback: `script` allocates a PTY without native node modules.
    const child = spawn('script', ['-qfc', shellCmd, '/dev/null'], {
      env: { ...process.env, TERM: 'xterm-256color', COLUMNS: String(cols), LINES: String(rows) },
      detached: true
    })
    const base = wrapChild(child)
    const handle: ShellHandle = { ...base, resize: () => undefined }
    this.streams.add(handle)
    handle.onExit(() => this.streams.delete(handle))
    return handle
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
  }
}
