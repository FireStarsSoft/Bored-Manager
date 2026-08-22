import {
  spawn as nodeSpawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions
} from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { StringDecoder } from 'node:string_decoder'
import {
  resolveOutputLimit,
  type ExecOptions,
  type ExecResult,
  type Executor,
  type ReadFileResult,
  type ShellHandle,
  type StreamHandle
} from './types'

const require = createRequire(import.meta.url)
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_KILL_GRACE_MS = 500
const READ_FILE_MAX_BYTES = 2 * 1024 * 1024

type SpawnFunction = (command: string, args: string[], options: SpawnOptions) => ChildProcess
type KillProcess = (pid: number, signal: NodeJS.Signals) => boolean

export interface LocalExecutorOptions {
  spawn?: SpawnFunction
  killProcess?: KillProcess
  killGraceMs?: number
  loadPty?: () => NodePtyModule | null
}

interface DisposableRegistration {
  dispose(): void
}

interface NodePtyProcess {
  pid: number
  write(data: string): void
  kill(signal?: string): void
  resize(cols: number, rows: number): void
  onData(cb: (data: string) => void): DisposableRegistration
  onExit(
    cb: (event: { exitCode: number; signal?: number }) => void
  ): DisposableRegistration
}

interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string
      cols: number
      rows: number
      cwd: string
      env: Record<string, string | undefined>
    }
  ): NodePtyProcess
}

interface TrackedOperation {
  readonly closed: Promise<void>
  cancel(reason?: 'disposed'): void
}

function unref(timer: NodeJS.Timeout): NodeJS.Timeout {
  timer.unref?.()
  return timer
}

function bufferOf(data: Buffer | string): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data)
}

function fanOut<T extends unknown[]>(
  cbs: Array<(...args: T) => void>,
  ...args: T
): void {
  for (const cb of [...cbs]) {
    try {
      cb(...args)
    } catch (error) {
      console.error('[local-executor] a stream listener threw:', error)
    }
  }
}

// node-pty is optional and native. Probe it in a disposable process before
// loading it in-process, then cache either the module or the failure.
let nodePty: NodePtyModule | null | undefined
function loadNodePty(): NodePtyModule | null {
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
      nodePty = require('node-pty') as NodePtyModule
    } else {
      console.error(
        `[local-executor] node-pty load probe failed ` +
          `(status=${probe.status ?? 'none'}, signal=${probe.signal ?? 'none'}); ` +
          `using the non-resizable script(1) fallback`
      )
    }
  } catch {
    // Not installed or not loadable; script(1) is attempted below.
  }
  return nodePty
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals, killProcess: KillProcess): void {
  if (child.pid) {
    try {
      killProcess(-child.pid, signal)
      return
    } catch {
      // A process group may not exist yet (or on this platform); fall back to
      // signalling the direct child so cleanup still makes progress.
    }
  }
  try {
    child.kill(signal)
  } catch {
    // It may already have closed.
  }
}

class LocalExecOperation implements TrackedOperation {
  readonly result: Promise<ExecResult>
  readonly closed: Promise<void>
  private resolveResult!: (result: ExecResult) => void
  private resolveClosed!: () => void
  private readonly stdoutDecoder = new StringDecoder('utf8')
  private readonly stderrDecoder = new StringDecoder('utf8')
  private stdout = ''
  private stderr = ''
  private outputBytes = 0
  private finished = false
  private reason: 'timeout' | 'overflow' | 'cancelled' | 'disposed' | null = null
  private timeoutTimer: NodeJS.Timeout | null = null
  private killTimer: NodeJS.Timeout | null = null
  private forceTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly child: ChildProcess,
    private readonly options: ExecOptions,
    private readonly outputLimit: number,
    private readonly killProcess: KillProcess,
    private readonly killGraceMs: number,
    private readonly onFinish: () => void
  ) {
    this.result = new Promise((resolve) => {
      this.resolveResult = resolve
    })
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve
    })
    child.stdout?.on('data', this.onStdout)
    child.stderr?.on('data', this.onStderr)
    child.on('error', this.onError)
    child.on('close', this.onClose)

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      this.timeoutTimer = unref(
        setTimeout(() => this.requestTermination('timeout'), Math.trunc(timeoutMs))
      )
    }
    if (options.signal?.aborted) {
      this.requestTermination('cancelled')
    } else {
      options.signal?.addEventListener('abort', this.onAbort, { once: true })
    }

    try {
      if (options.stdin !== undefined) child.stdin?.write(options.stdin)
      child.stdin?.end()
    } catch (error) {
      this.stderr += String(error)
      this.requestTermination('cancelled')
    }
  }

  cancel(reason: 'disposed' = 'disposed'): void {
    this.requestTermination(reason)
  }

  private readonly onAbort = (): void => this.requestTermination('cancelled')

  private readonly onStdout = (data: Buffer | string): void => {
    this.capture(bufferOf(data), this.stdoutDecoder, (text) => {
      this.stdout += text
    })
  }

  private readonly onStderr = (data: Buffer | string): void => {
    this.capture(bufferOf(data), this.stderrDecoder, (text) => {
      this.stderr += text
    })
  }

  private capture(chunk: Buffer, decoder: StringDecoder, append: (text: string) => void): void {
    if (this.finished || this.reason) return
    const remaining = this.outputLimit - this.outputBytes
    if (chunk.length <= remaining) {
      this.outputBytes += chunk.length
      append(decoder.write(chunk))
      return
    }
    if (remaining > 0) {
      this.outputBytes += remaining
      append(decoder.write(chunk.subarray(0, remaining)))
    }
    this.requestTermination('overflow')
  }

  private readonly onError = (error: Error): void => {
    this.finish(this.reasonCode(127), undefined, String(error))
  }

  private readonly onClose = (
    code: number | null,
    signal: NodeJS.Signals | null
  ): void => {
    this.finish(
      this.reason ? this.reasonCode(1) : code ?? (signal ? 128 : 1),
      signal ?? undefined
    )
  }

  private reasonCode(fallback: number): number {
    switch (this.reason) {
      case 'timeout':
        return 124
      case 'overflow':
        return 125
      case 'cancelled':
      case 'disposed':
        return 130
      default:
        return fallback
    }
  }

  private requestTermination(
    reason: 'timeout' | 'overflow' | 'cancelled' | 'disposed'
  ): void {
    if (this.finished || this.reason) return
    this.reason = reason
    signalGroup(this.child, 'SIGTERM', this.killProcess)
    this.killTimer = unref(
      setTimeout(() => {
        signalGroup(this.child, 'SIGKILL', this.killProcess)
        this.forceTimer = unref(
          setTimeout(
            () => this.finish(this.reasonCode(1), 'SIGKILL'),
            this.killGraceMs
          )
        )
      }, this.killGraceMs)
    )
  }

  private finish(code: number, signal?: string, extraError = ''): void {
    if (this.finished) return
    this.finished = true
    this.stdout += this.stdoutDecoder.end()
    this.stderr += this.stderrDecoder.end()
    if (extraError) this.stderr += `${this.stderr ? '\n' : ''}${extraError}`
    if (this.reason) {
      const label = this.reason === 'cancelled' || this.reason === 'disposed'
        ? 'cancelled'
        : this.reason
      this.stderr += `${this.stderr ? '\n' : ''}[${label}]`
    }
    this.cleanup()
    this.onFinish()
    this.resolveResult({
      stdout: this.stdout,
      stderr: this.stderr,
      code,
      ...(signal ? { signal } : {})
    })
    this.resolveClosed()
  }

  private cleanup(): void {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer)
    if (this.killTimer) clearTimeout(this.killTimer)
    if (this.forceTimer) clearTimeout(this.forceTimer)
    this.options.signal?.removeEventListener('abort', this.onAbort)
    this.child.stdout?.removeListener('data', this.onStdout)
    this.child.stderr?.removeListener('data', this.onStderr)
    this.child.removeListener('error', this.onError)
    this.child.removeListener('close', this.onClose)
  }
}

class LocalChildHandle implements ShellHandle, TrackedOperation {
  readonly resizeSupported: boolean
  readonly diagnostic?: string
  readonly pid?: number
  readonly ready: Promise<void>
  readonly closed: Promise<void>
  private resolveReady!: () => void
  private rejectReady!: (error: Error) => void
  private resolveClosed!: () => void
  private readonly stdoutDecoder = new StringDecoder('utf8')
  private readonly stderrDecoder = new StringDecoder('utf8')
  private readonly dataCbs: Array<(data: string) => void> = []
  private readonly exitCbs: Array<(code: number | null, signal?: string) => void> = []
  private readySettled = false
  private finished = false
  private exitCode: number | null = null
  private exitSignal: string | undefined
  private killTimer: NodeJS.Timeout | null = null
  private forceTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly child: ChildProcess,
    private readonly killProcess: KillProcess,
    private readonly killGraceMs: number,
    private readonly onFinish: () => void,
    capability: { resizeSupported?: boolean; diagnostic?: string } = {}
  ) {
    this.resizeSupported = capability.resizeSupported ?? false
    this.diagnostic = capability.diagnostic
    this.pid = child.pid
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve
    })
    child.stdout?.on('data', this.onStdout)
    child.stderr?.on('data', this.onStderr)
    child.on('spawn', this.onSpawn)
    child.on('error', this.onError)
    child.on('close', this.onClose)
  }

  write(data: string): void {
    if (this.finished) return
    try {
      this.child.stdin?.write(data)
    } catch {
      // The close/error event owns finalisation.
    }
  }

  kill(): void {
    this.cancel()
  }

  cancel(): void {
    if (this.finished || this.killTimer) return
    signalGroup(this.child, 'SIGTERM', this.killProcess)
    this.killTimer = unref(
      setTimeout(() => {
        signalGroup(this.child, 'SIGKILL', this.killProcess)
        this.forceTimer = unref(
          setTimeout(() => this.finish(137, 'SIGKILL'), this.killGraceMs)
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

  resize(_cols: number, _rows: number): void {
    // script(1) cannot resize its allocated PTY after spawn. The explicit
    // capability/diagnostic above lets callers surface that limitation.
  }

  private readonly onSpawn = (): void => {
    if (this.readySettled) return
    this.readySettled = true
    this.resolveReady()
  }

  private readonly onStdout = (data: Buffer | string): void => {
    fanOut(this.dataCbs, this.stdoutDecoder.write(bufferOf(data)))
  }

  private readonly onStderr = (data: Buffer | string): void => {
    fanOut(this.dataCbs, this.stderrDecoder.write(bufferOf(data)))
  }

  private readonly onError = (error: Error): void => {
    if (!this.readySettled) {
      this.readySettled = true
      this.rejectReady(error)
    }
    fanOut(this.dataCbs, `\r\n[spawn failed: ${String(error)}]\r\n`)
    this.finish(127)
  }

  private readonly onClose = (
    code: number | null,
    signal: NodeJS.Signals | null
  ): void => {
    this.finish(code, signal ?? undefined)
  }

  private finish(code: number | null, signal?: string): void {
    if (this.finished) return
    this.finished = true
    if (!this.readySettled) {
      this.readySettled = true
      this.rejectReady(new Error('process closed before it spawned'))
    }
    const tail = this.stdoutDecoder.end() + this.stderrDecoder.end()
    if (tail) fanOut(this.dataCbs, tail)
    this.exitCode = code
    this.exitSignal = signal
    this.cleanup()
    this.onFinish()
    fanOut(this.exitCbs, code, signal)
    this.dataCbs.length = 0
    this.exitCbs.length = 0
    this.resolveClosed()
  }

  private cleanup(): void {
    if (this.killTimer) clearTimeout(this.killTimer)
    if (this.forceTimer) clearTimeout(this.forceTimer)
    this.child.stdout?.removeListener('data', this.onStdout)
    this.child.stderr?.removeListener('data', this.onStderr)
    this.child.removeListener('spawn', this.onSpawn)
    this.child.removeListener('error', this.onError)
    this.child.removeListener('close', this.onClose)
  }
}

class NativePtyHandle implements ShellHandle, TrackedOperation {
  readonly resizeSupported = true
  readonly pid: number
  readonly closed: Promise<void>
  private resolveClosed!: () => void
  private readonly dataCbs: Array<(data: string) => void> = []
  private readonly exitCbs: Array<(code: number | null, signal?: string) => void> = []
  private readonly dataRegistration: DisposableRegistration
  private readonly exitRegistration: DisposableRegistration
  private finished = false
  private exitCode: number | null = null
  private exitSignal: string | undefined
  private killTimer: NodeJS.Timeout | null = null
  private forceTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly pty: NodePtyProcess,
    private readonly killGraceMs: number,
    private readonly onFinish: () => void
  ) {
    this.pid = pty.pid
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve
    })
    try {
      this.dataRegistration = pty.onData((data) => fanOut(this.dataCbs, data))
      this.exitRegistration = pty.onExit(({ exitCode, signal }) =>
        this.finish(exitCode, signal === undefined ? undefined : String(signal))
      )
    } catch (error) {
      try {
        pty.kill()
      } catch {
        // Preserve the registration error.
      }
      throw error
    }
  }

  write(data: string): void {
    if (!this.finished) this.pty.write(data)
  }

  kill(): void {
    this.cancel()
  }

  cancel(): void {
    if (this.finished || this.killTimer) return
    try {
      this.pty.kill('SIGTERM')
    } catch {
      // Continue to the bounded hard kill.
    }
    this.killTimer = unref(
      setTimeout(() => {
        try {
          this.pty.kill('SIGKILL')
        } catch {
          // The force-finaliser still releases bookkeeping.
        }
        this.forceTimer = unref(
          setTimeout(() => this.finish(137, 'SIGKILL'), this.killGraceMs)
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
    if (this.finished) return
    try {
      this.pty.resize(cols, rows)
    } catch {
      // A native PTY can still race its exit.
    }
  }

  private finish(code: number | null, signal?: string): void {
    if (this.finished) return
    this.finished = true
    this.exitCode = code
    this.exitSignal = signal
    if (this.killTimer) clearTimeout(this.killTimer)
    if (this.forceTimer) clearTimeout(this.forceTimer)
    this.dataRegistration.dispose()
    this.exitRegistration.dispose()
    this.onFinish()
    fanOut(this.exitCbs, code, signal)
    this.dataCbs.length = 0
    this.exitCbs.length = 0
    this.resolveClosed()
  }
}

export class LocalExecutor implements Executor {
  readonly kind = 'local' as const
  private readonly spawn: SpawnFunction
  private readonly killProcess: KillProcess
  private readonly killGraceMs: number
  private readonly ptyLoader: () => NodePtyModule | null
  private disposed = false
  private disposePromise: Promise<void> | null = null
  private readonly commands = new Set<LocalExecOperation>()
  private readonly handles = new Set<TrackedOperation & StreamHandle>()

  constructor(options: LocalExecutorOptions = {}) {
    this.spawn = options.spawn ?? ((command, args, spawnOptions) =>
      nodeSpawn(command, args, spawnOptions))
    this.killProcess = options.killProcess ?? ((pid, signal) => process.kill(pid, signal))
    this.killGraceMs = Math.max(10, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS)
    this.ptyLoader = options.loadPty ?? loadNodePty
  }

  exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    if (this.disposed) {
      return Promise.resolve({ stdout: '', stderr: 'executor disposed', code: 255 })
    }
    const outputLimit = resolveOutputLimit(options.maxOutputBytes)
    let child: ChildProcess
    try {
      child = this.spawn('bash', ['-c', command], {
        env: { ...process.env, LANG: 'C' },
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (error) {
      return Promise.resolve({ stdout: '', stderr: String(error), code: 127 })
    }

    let operation!: LocalExecOperation
    operation = new LocalExecOperation(
      child,
      options,
      outputLimit,
      this.killProcess,
      this.killGraceMs,
      () => this.commands.delete(operation)
    )
    this.commands.add(operation)
    return operation.result
  }

  async readFiles(paths: string[]): Promise<ReadFileResult[]> {
    const unavailable = (): ReadFileResult[] =>
      paths.map((path) => ({ path, ok: false, text: '' }))
    if (this.disposed) return unavailable()

    const results = await Promise.all(
      paths.map(async (path): Promise<ReadFileResult> => {
        try {
          const data = await readFile(path)
          return {
            path,
            ok: true,
            text: data.subarray(0, READ_FILE_MAX_BYTES).toString('utf8')
          }
        } catch {
          return { path, ok: false, text: '' }
        }
      })
    )
    return this.disposed ? unavailable() : results
  }

  async stream(command: string): Promise<StreamHandle> {
    this.assertActive()
    let child: ChildProcess
    try {
      child = this.spawn('bash', ['-c', command], {
        env: { ...process.env, LANG: 'C' },
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (error) {
      throw new Error(`Could not spawn local command: ${String(error)}`)
    }
    let handle!: LocalChildHandle
    handle = new LocalChildHandle(
      child,
      this.killProcess,
      this.killGraceMs,
      () => this.handles.delete(handle)
    )
    this.handles.add(handle)
    try {
      await handle.ready
    } catch (error) {
      await handle.closed
      throw new Error(`Could not spawn local command: ${String(error)}`)
    }
    if (this.disposed) {
      handle.kill()
      await handle.closed
      throw new Error('executor disposed')
    }
    return handle
  }

  async shell(cols: number, rows: number): Promise<ShellHandle> {
    this.assertActive()
    const shellCmd = process.env.SHELL || 'bash'
    const nodePty = this.ptyLoader()
    if (nodePty) {
      try {
        const pty = nodePty.spawn(shellCmd, ['-l'], {
          name: 'xterm-256color',
          cols,
          rows,
          cwd: process.env.HOME || process.cwd(),
          env: { ...process.env, TERM: 'xterm-256color' }
        })
        let handle!: NativePtyHandle
        handle = new NativePtyHandle(pty, this.killGraceMs, () =>
          this.handles.delete(handle)
        )
        this.handles.add(handle)
        if (this.disposed) {
          handle.kill()
          await handle.closed
          throw new Error('executor disposed')
        }
        return handle
      } catch (error) {
        console.error(
          `[local-executor] node-pty could not create a terminal (${String(error)}); ` +
            'trying script(1)'
        )
      }
    }

    const diagnostic =
      'Local terminal is using script(1); resize is unavailable until node-pty loads successfully.'
    let child: ChildProcess
    try {
      child = this.spawn('script', ['-qfc', shellCmd, '/dev/null'], {
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          COLUMNS: String(cols),
          LINES: String(rows)
        },
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (error) {
      throw new Error(`Could not spawn local PTY fallback: ${String(error)}`)
    }
    let handle!: LocalChildHandle
    handle = new LocalChildHandle(
      child,
      this.killProcess,
      this.killGraceMs,
      () => this.handles.delete(handle),
      { resizeSupported: false, diagnostic }
    )
    this.handles.add(handle)
    try {
      await handle.ready
    } catch (error) {
      await handle.closed
      throw new Error(`Could not spawn local PTY fallback: ${String(error)}`)
    }
    console.error(`[local-executor] ${diagnostic}`)
    if (this.disposed) {
      handle.kill()
      await handle.closed
      throw new Error('executor disposed')
    }
    return handle
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposed = true
    const operations = [...this.commands, ...this.handles]
    for (const operation of operations) {
      try {
        operation.cancel('disposed')
      } catch {
        // Continue cancelling the remaining children.
      }
    }
    this.disposePromise = Promise.allSettled(operations.map((operation) => operation.closed)).then(
      () => undefined
    )
    return this.disposePromise
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('executor disposed')
  }
}
