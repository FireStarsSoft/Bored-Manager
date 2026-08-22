import type { OkResult, TerminalInfo, TerminalPreset } from '@shared/types'
import { connection, type ConnectionManager } from '../connection'
import { internalErrorDetail } from '../errors'
import type { ShellHandle } from '../executors/types'
import { log } from '../log'
import { registry } from '../session-registry'
import { tracker } from './services-tracker'

const PRESET_COMMANDS: Record<string, string> = {
  'nvidia-smi': 'watch -n 1 nvidia-smi\n',
  glances: 'glances\n',
  lazydocker: 'lazydocker\n'
}

const PRESET_TITLES: Record<string, string> = {
  shell: 'Shell',
  'nvidia-smi': 'nvidia-smi',
  glances: 'glances',
  lazydocker: 'lazydocker',
  custom: 'Custom'
}

interface TermSession {
  info: TerminalInfo
  handle: ShellHandle
  registryId: string
  buffer: string
  untrack: () => void
  initialTimer: NodeJS.Timeout | null
}

export class TerminalService {
  private sessions = new Map<string, TermSession>()
  private counter = 0

  constructor(
    private emitData: (id: string, data: string) => void,
    private emitExit: (id: string) => void,
    private readonly resolveTarget: (machineId: string) => ConnectionManager | undefined = () =>
      connection
  ) {}

  list(): TerminalInfo[] {
    return [...this.sessions.values()].map((s) => s.info)
  }

  /** Replay buffer so a re-mounted xterm shows previous output. */
  getBuffer(id: string): string {
    return this.sessions.get(id)?.buffer ?? ''
  }

  async create(
    machineId: string,
    preset: TerminalPreset,
    cols: number,
    rows: number,
    customCommand?: string
  ): Promise<TerminalInfo | OkResult>
  async create(
    preset: TerminalPreset,
    cols: number,
    rows: number,
    customCommand?: string
  ): Promise<TerminalInfo | OkResult>
  async create(
    machineIdOrPreset: string,
    presetOrCols: TerminalPreset | number,
    colsOrRows: number,
    rowsOrCommand?: number | string,
    maybeCommand?: string
  ): Promise<TerminalInfo | OkResult> {
    const legacy = typeof presetOrCols === 'number'
    const machineId = legacy ? 'legacy' : machineIdOrPreset
    const preset = (legacy ? machineIdOrPreset : presetOrCols) as TerminalPreset
    const cols = legacy ? presetOrCols : colsOrRows
    const rows = (legacy ? colsOrRows : rowsOrCommand) as number
    const customCommand = (legacy ? rowsOrCommand : maybeCommand) as string | undefined
    const target = this.resolveTarget(machineId)
    if (!target?.current) return { ok: false, error: 'not connected' }
    let handle: ShellHandle
    try {
      handle = await target.current.shell(cols || 80, rows || 24)
    } catch (err) {
      log(`terminal creation failed: ${internalErrorDetail(err)}`)
      return { ok: false, error: 'Could not create the terminal' }
    }
    const id = `term-${++this.counter}`
    const title =
      preset === 'custom' && customCommand
        ? customCommand.slice(0, 24)
        : (PRESET_TITLES[preset] ?? 'Shell')
    const registryId = registry.register(`terminal:${machineId}:${id}`, () => handle.kill())
    const untrack = tracker.registerShell(`terminal:${machineId}`, title, handle.pid)
    const session: TermSession = {
      info: { id, machineId, title, preset },
      handle,
      registryId,
      buffer: '',
      untrack,
      initialTimer: null
    }
    this.sessions.set(id, session)

    handle.onData((d) => {
      session.buffer += d
      if (session.buffer.length > 200_000) {
        session.buffer = session.buffer.slice(-150_000)
      }
      this.emitData(id, d)
    })
    handle.onExit(() => {
      if (this.sessions.get(id) !== session) return
      if (session.initialTimer) clearTimeout(session.initialTimer)
      registry.unregister(registryId)
      untrack()
      this.sessions.delete(id)
      this.emitExit(id)
    })

    const initial =
      preset === 'custom' && customCommand ? customCommand + '\n' : PRESET_COMMANDS[preset]
    if (initial) {
      // Small delay lets the shell prompt initialise before the command is typed.
      session.initialTimer = setTimeout(() => {
        session.initialTimer = null
        try {
          handle.write(initial)
        } catch {
          /* terminal may have died */
        }
      }, 400)
      session.initialTimer.unref?.()
    }
    return session.info
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.handle.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.handle.resize(cols, rows)
  }

  dispose(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    this.sessions.delete(id)
    if (s.initialTimer) clearTimeout(s.initialTimer)
    registry.unregister(s.registryId)
    s.untrack()
    try {
      s.handle.kill()
    } catch {
      /* ignore */
    }
    this.emitExit(id)
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.dispose(id)
  }

  disposeMachine(machineId: string): void {
    for (const [id, session] of this.sessions) {
      if (session.info.machineId === machineId) this.dispose(id)
    }
  }
}
