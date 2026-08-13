import type { ServiceEntry, ServicesSnapshot } from '@shared/types'
import type { ExecOptions, ExecResult } from '../executors/types'
import { roundSample } from './history'

type ExecFn = (command: string, opts?: ExecOptions) => Promise<ExecResult>

/** A poller's entry ages out after this many missed intervals (see snapshot()). */
const POLLER_STALE_FACTOR = 2

const SELF_STARTED_AT = Date.now()

interface LiveEntry {
  id: string
  kind: 'stream' | 'shell'
  owner: string
  label: string
  pid?: number
  startedAt: number
}

interface PollerEntry {
  owner: string
  intervalMs: number
  lastTickMs: number
  startedAt: number
  /** Last time noteTick() saw this poller - how staleness is detected. */
  lastSeenAt: number
}

/** `docker:containers` -> `docker`; a name with no `:` (the two core pollers predating this convention) is the app's own. */
function ownerFromPollerName(name: string): string {
  const i = name.indexOf(':')
  return i > 0 ? name.slice(0, i) : 'core'
}

function clampPct(v: number): number {
  return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 0
}

/**
 * Registry of everything the app itself runs, so a snapshot can answer "what
 * is Bored Manager costing" alongside "what is the target machine doing".
 * One instance for the whole process - there is only ever one server.
 */
class ServicesTracker {
  private live = new Map<string, LiveEntry>()
  private pollers = new Map<string, PollerEntry>()
  private counter = 0
  private prevCpuUsage: NodeJS.CpuUsage | null = null
  private prevCpuAt = Date.now()

  /** A long-running command with a live output stream (module `ctx.stream`, package actions, ...). */
  registerStream(owner: string, command: string, pid?: number): () => void {
    return this.registerLive('stream', owner, command, pid)
  }

  /** An interactive PTY (a terminal tab). */
  registerShell(owner: string, label: string, pid?: number): () => void {
    return this.registerLive('shell', owner, label, pid)
  }

  private registerLive(kind: 'stream' | 'shell', owner: string, label: string, pid?: number): () => void {
    const id = `${kind}-${++this.counter}`
    this.live.set(id, { id, kind, owner, label, pid, startedAt: Date.now() })
    return () => {
      this.live.delete(id)
    }
  }

  /**
   * Called from every `Poller` tick, whether or not it belongs to this
   * tracker's own `core:services` poller - that is how a module's poller
   * shows up here without the module knowing this file exists. A poller that
   * stops calling this (switched off, its module disabled) is not removed
   * here: it just ages out of `snapshot()` once it goes quiet for too long.
   */
  noteTick(pollerName: string, durationMs: number, intervalMs: number): void {
    const prev = this.pollers.get(pollerName)
    this.pollers.set(pollerName, {
      owner: ownerFromPollerName(pollerName),
      intervalMs,
      lastTickMs: durationMs,
      startedAt: prev?.startedAt ?? Date.now(),
      lastSeenAt: Date.now()
    })
  }

  /** Node's own cost: CPU from the delta since the last snapshot, RSS as of now. */
  private selfEntry(now: number): ServiceEntry {
    const usage = process.cpuUsage()
    let cpu = 0
    if (this.prevCpuUsage) {
      const dtMs = now - this.prevCpuAt
      const busyMs = (usage.user - this.prevCpuUsage.user + (usage.system - this.prevCpuUsage.system)) / 1000
      cpu = dtMs > 0 ? clampPct((busyMs / dtMs) * 100) : 0
    }
    this.prevCpuUsage = usage
    this.prevCpuAt = now
    return {
      id: 'self',
      kind: 'self',
      owner: 'core',
      label: 'node server',
      pid: process.pid,
      startedAt: SELF_STARTED_AT,
      cpu: roundSample(cpu),
      memBytes: process.memoryUsage().rss
    }
  }

  private prunePollers(now: number): void {
    for (const [name, p] of this.pollers) {
      if (now - p.lastSeenAt > p.intervalMs * POLLER_STALE_FACTOR) this.pollers.delete(name)
    }
  }

  /** `ps` fields are KB for rss; everything else in this file works in bytes. */
  private async readProcStats(
    pids: number[],
    execFn: ExecFn
  ): Promise<Map<number, { cpu: number; memBytes: number }>> {
    const out = new Map<number, { cpu: number; memBytes: number }>()
    const res = await execFn(`ps -o pid=,pcpu=,rss= -p ${pids.join(',')}`, { timeoutMs: 5000 })
    for (const line of res.stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)$/)
      if (!m) continue
      out.set(Number(m[1]), { cpu: Number(m[2]), memBytes: Number(m[3]) * 1024 })
    }
    return out
  }

  /**
   * One reading of everything the app is running right now. `execFn` is the
   * currently connected executor's `exec` (bound by the caller) - a pid is
   * only ever captured for a local child/node-pty (see ServiceEntry.pid), so
   * whichever executor is live is always the right one to `ps` it with.
   */
  async snapshot(execFn: ExecFn): Promise<ServicesSnapshot> {
    const now = Date.now()
    const self = this.selfEntry(now)
    const entries: ServiceEntry[] = [self]

    const withPid = [...this.live.values()].filter((e): e is LiveEntry & { pid: number } => e.pid != null)
    const stats: Map<number, { cpu: number; memBytes: number }> = withPid.length
      ? await this.readProcStats(withPid.map((e) => e.pid), execFn)
      : new Map()

    for (const e of this.live.values()) {
      // Only a `stream` entry's label doubles as its command - a `shell`'s is
      // a display title (the terminal tab name), not something to run.
      const command = e.kind === 'stream' ? e.label : undefined
      if (e.pid == null) {
        entries.push({ id: e.id, kind: e.kind, owner: e.owner, label: e.label, command, startedAt: e.startedAt })
        continue
      }
      const s = stats.get(e.pid)
      if (!s) {
        // The process behind this entry is gone but nothing told us - drop it.
        this.live.delete(e.id)
        continue
      }
      entries.push({
        id: e.id,
        kind: e.kind,
        owner: e.owner,
        label: e.label,
        command,
        pid: e.pid,
        startedAt: e.startedAt,
        cpu: s.cpu,
        memBytes: s.memBytes
      })
    }

    this.prunePollers(now)
    for (const [name, p] of this.pollers) {
      entries.push({
        id: `poller:${name}`,
        kind: 'poller',
        owner: p.owner,
        label: name,
        startedAt: p.startedAt,
        intervalMs: p.intervalMs,
        lastTickMs: p.lastTickMs,
        estCostPct: p.intervalMs > 0 ? roundSample((p.lastTickMs / p.intervalMs) * 100) : 0
      })
    }

    let totalCpu = 0
    let totalMemBytes = 0
    for (const e of entries) {
      if (typeof e.cpu === 'number') totalCpu += e.cpu
      if (typeof e.memBytes === 'number') totalMemBytes += e.memBytes
    }
    return {
      t: now,
      totalCpu: roundSample(totalCpu),
      totalMemBytes,
      count: entries.length,
      selfCpu: self.cpu ?? 0,
      selfMemBytes: self.memBytes ?? 0,
      entries
    }
  }
}

export const tracker = new ServicesTracker()
