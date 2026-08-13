export interface ExecResult {
  stdout: string
  stderr: string
  code: number
}

export interface ExecOptions {
  stdin?: string
  timeoutMs?: number
}

export interface StreamHandle {
  write(data: string): void
  kill(): void
  onData(cb: (data: string) => void): void
  onExit(cb: (code: number | null) => void): void
  /** Set only for a locally spawned child or node-pty - never for an SSH-remote command. */
  pid?: number
}

export interface ShellHandle extends StreamHandle {
  resize(cols: number, rows: number): void
}

export interface Executor {
  readonly kind: 'local' | 'ssh'
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>
  /** Long running command (e.g. docker logs -f). Killed on dispose. */
  stream(command: string): Promise<StreamHandle>
  /** Interactive PTY shell. */
  shell(cols: number, rows: number): Promise<ShellHandle>
  dispose(): Promise<void>
}
