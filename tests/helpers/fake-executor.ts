import type {
  ExecOptions,
  ExecResult,
  Executor,
  ShellHandle,
  StreamHandle
} from '../../server/executors/types'

export class FakeStreamHandle implements StreamHandle {
  readonly writes: string[] = []
  killed = false
  pid?: number
  private dataListeners: Array<(data: string) => void> = []
  private exitListeners: Array<(code: number | null, signal?: string) => void> = []

  write(data: string): void {
    this.writes.push(data)
  }

  kill(): void {
    this.killed = true
  }

  onData(cb: (data: string) => void): void {
    this.dataListeners.push(cb)
  }

  onExit(cb: (code: number | null, signal?: string) => void): void {
    this.exitListeners.push(cb)
  }

  pushData(data: string): void {
    for (const listener of this.dataListeners) listener(data)
  }

  exit(code: number | null, signal?: string): void {
    for (const listener of this.exitListeners) listener(code, signal)
  }
}

export class FakeShellHandle extends FakeStreamHandle implements ShellHandle {
  readonly resizeSupported = true
  readonly sizes: Array<{ cols: number; rows: number }> = []

  resize(cols: number, rows: number): void {
    this.sizes.push({ cols, rows })
  }
}

export class FakeExecutor implements Executor {
  readonly kind: 'local' | 'ssh'
  readonly execCalls: Array<{ command: string; options?: ExecOptions }> = []
  readonly streamCalls: string[] = []
  readonly shellCalls: Array<{ cols: number; rows: number }> = []
  readonly streams: FakeStreamHandle[] = []
  readonly shells: FakeShellHandle[] = []
  disposed = false

  constructor(
    private readonly answer: (
      command: string,
      options?: ExecOptions
    ) => ExecResult | Promise<ExecResult> = () => ({ stdout: '', stderr: '', code: 0 }),
    kind: 'local' | 'ssh' = 'local'
  ) {
    this.kind = kind
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    this.execCalls.push({ command, ...(options === undefined ? {} : { options }) })
    return this.answer(command, options)
  }

  async stream(command: string): Promise<StreamHandle> {
    this.streamCalls.push(command)
    const stream = new FakeStreamHandle()
    this.streams.push(stream)
    return stream
  }

  async shell(cols: number, rows: number): Promise<ShellHandle> {
    this.shellCalls.push({ cols, rows })
    const shell = new FakeShellHandle()
    this.shells.push(shell)
    return shell
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const stream of [...this.streams, ...this.shells]) stream.kill()
  }
}
