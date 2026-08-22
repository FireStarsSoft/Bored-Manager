import { vi } from 'vitest'
import type {
  ModuleContext,
  ModuleExecResult,
  ModulePoller,
  ModuleStreamHandle
} from '@shared/modules'

export type ModuleHandler = (...args: unknown[]) => unknown

export interface ModuleHarnessOptions {
  mode?: 'tab' | 'always' | 'off'
  tabActive?: boolean
  hostData?: unknown
  streamError?: Error
  hasSudo?: boolean
}

export interface ModuleHarness {
  ctx: ModuleContext
  exec: ReturnType<typeof vi.fn<(command: string) => Promise<ModuleExecResult>>>
  handlers: Map<string, ModuleHandler>
  ticks: Array<() => Promise<void>>
  pollers: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }>
  emit: ReturnType<typeof vi.fn>
  stream: {
    start: ReturnType<typeof vi.fn>
    kill: ReturnType<typeof vi.fn>
    pushData(data: string): void
    exit(code: number | null): void
  }
}

/** A ModuleContext that records exec/stream/poller calls instead of talking to a host. */
export function moduleHarness(
  id: string,
  answer: (command: string) => ModuleExecResult | Promise<ModuleExecResult>,
  options: ModuleHarnessOptions = {}
): ModuleHarness {
  const handlers = new Map<string, ModuleHandler>()
  const ticks: Array<() => Promise<void>> = []
  const pollers: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = []
  const exec = vi.fn(async (command: string) => answer(command))
  let dataListener: ((data: string) => void) | null = null
  let exitListener: ((code: number | null) => void) | null = null
  const kill = vi.fn()
  const stream: ModuleStreamHandle = {
    write: vi.fn(),
    kill,
    onData: (listener) => {
      dataListener = listener
    },
    onExit: (listener) => {
      exitListener = listener
    }
  }
  const streamStart = vi.fn(async () => {
    if (options.streamError) throw options.streamError
    return stream
  })
  const emit = vi.fn()
  const ctx = {
    id,
    exec,
    execSudo: exec,
    stream: streamStart,
    streamSudo: streamStart,
    connected: true,
    hasSudo: options.hasSudo ?? false,
    createPoller: (_name: string, tick: () => Promise<void>): ModulePoller => {
      ticks.push(tick)
      const poller = { start: vi.fn(), stop: vi.fn() }
      pollers.push(poller)
      return poller
    },
    fastIntervalMs: () => 2_000,
    slowIntervalSec: () => 60,
    detailMode: () => options.mode ?? 'tab',
    get tabActive() {
      return options.tabActive ?? true
    },
    emit,
    handle: (method: string, fn: (...args: never[]) => unknown) => {
      handlers.set(method, fn as unknown as ModuleHandler)
    },
    addHistory: vi.fn(),
    configGet: () => null,
    configSet: vi.fn(),
    hostDataGet: () => options.hostData ?? null,
    hostDataSet: vi.fn(),
    hostKey: 'local',
    isModuleEnabled: () => false,
    log: vi.fn()
  } as ModuleContext
  return {
    ctx,
    exec,
    handlers,
    ticks,
    pollers,
    emit,
    stream: {
      start: streamStart,
      kill,
      pushData: (data) => dataListener?.(data),
      exit: (code) => exitListener?.(code)
    }
  }
}
