export interface ExecResult {
  stdout: string
  stderr: string
  code: number
  /** Process/remote exit signal when one was reported. */
  signal?: string
}

export interface ExecOptions {
  stdin?: string
  timeoutMs?: number
  /** Combined stdout + stderr byte ceiling. */
  maxOutputBytes?: number
  signal?: AbortSignal
}

export interface ReadFileResult {
  path: string
  ok: boolean
  text: string
}

export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
export const MIN_MAX_OUTPUT_BYTES = 1024
export const MAX_MAX_OUTPUT_BYTES = 64 * 1024 * 1024

export function resolveOutputLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_OUTPUT_BYTES
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_MAX_OUTPUT_BYTES ||
    value > MAX_MAX_OUTPUT_BYTES
  ) {
    throw new RangeError(
      `maxOutputBytes must be an integer from ${MIN_MAX_OUTPUT_BYTES} to ${MAX_MAX_OUTPUT_BYTES}`
    )
  }
  return value
}

export interface StreamHandle {
  write(data: string): void
  kill(): void
  onData(cb: (data: string) => void): void
  onExit(cb: (code: number | null, signal?: string) => void): void
  /** Set only for a locally spawned child or node-pty - never for an SSH-remote command. */
  pid?: number
}

export interface ShellHandle extends StreamHandle {
  readonly resizeSupported: boolean
  /** Present when the fallback has a material terminal limitation. */
  readonly diagnostic?: string
  resize(cols: number, rows: number): void
}

export interface Executor {
  readonly kind: 'local' | 'ssh'
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>
  /** Optional zero-process fast path for files on the server's own Linux host. */
  readFiles?(paths: string[]): Promise<ReadFileResult[]>
  /** Long running command (e.g. docker logs -f). Killed on dispose. */
  stream(command: string): Promise<StreamHandle>
  /** Interactive PTY shell. */
  shell(cols: number, rows: number): Promise<ShellHandle>
  dispose(): Promise<void>
}
