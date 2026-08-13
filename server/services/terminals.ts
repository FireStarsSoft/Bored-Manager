import type { OkResult, TerminalInfo, TerminalPreset } from '@shared/types'
import { connection } from '../connection'
import type { ShellHandle } from '../executors/types'
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
}

export class TerminalService {
  private sessions = new Map<string, TermSession>()
  private counter = 0

  constructor(
    private emitData: (id: string, data: string) => void,
    private emitExit: (id: string) => void
  ) {}

  list(): TerminalInfo[] {
    return [...this.sessions.values()].map((s) => s.info)
  }

  /** Replay buffer so a re-mounted xterm shows previous output. */
  getBuffer(id: string): string {
    return this.sessions.get(id)?.buffer ?? ''
  }

  async create(
    preset: TerminalPreset,
    cols: number,
    rows: number,
    customCommand?: string
  ): Promise<TerminalInfo | OkResult> {
    if (!connection.current) return { ok: false, error: 'not connected' }
    let handle: ShellHandle
    try {
      handle = await connection.current.shell(cols || 80, rows || 24)
    } catch (err) {
      return { ok: false, error: String(err) }
    }
    const id = `term-${++this.counter}`
    const title =
      preset === 'custom' && customCommand
        ? customCommand.slice(0, 24)
        : (PRESET_TITLES[preset] ?? 'Shell')
    const registryId = registry.register(`terminal:${id}`, () => handle.kill())
    const untrack = tracker.registerShell('terminal', title, handle.pid)
    const session: TermSession = { info: { id, title, preset }, handle, registryId, buffer: '', untrack }
    this.sessions.set(id, session)

    handle.onData((d) => {
      session.buffer += d
      if (session.buffer.length > 200_000) {
        session.buffer = session.buffer.slice(-150_000)
      }
      this.emitData(id, d)
    })
    handle.onExit(() => {
      registry.unregister(registryId)
      untrack()
      this.sessions.delete(id)
      this.emitExit(id)
    })

    const initial =
      preset === 'custom' && customCommand ? customCommand + '\n' : PRESET_COMMANDS[preset]
    if (initial) {
      // Small delay lets the shell prompt initialise before the command is typed.
      setTimeout(() => {
        try {
          handle.write(initial)
        } catch {
          /* terminal may have died */
        }
      }, 400)
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
}
