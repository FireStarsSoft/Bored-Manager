import type { TopConsumersSnapshot, TopProcEntry } from '@shared/types'
import { splitSections } from '@shared/shell'
import { SS_CMD, parseSs } from '@shared/ss'
import { connection } from '../connection'
import { Poller } from './poller'

/** How many processes each Overview card can possibly want to show. */
const TOP_N = 10

/**
 * `comm` is last so a command name containing spaces ("Web Content") cannot
 * shift the numeric columns.
 */
const PS_CMD = `ps axo pid,pcpu,rss,comm --no-headers 2>/dev/null`

/** Same /proc/PID/io sweep the disk collector uses; one awk, one roundtrip. */
const PIO_CMD =
  `awk '/^read_bytes:/{r[FILENAME]=$2} /^write_bytes:/{w[FILENAME]=$2} ` +
  `END{for(f in r){split(f,a,"/"); print a[3], r[f], w[f]+0}}' ` +
  `$(find /proc -maxdepth 2 -name io -readable 2>/dev/null) /dev/null 2>/dev/null`

interface IoCounters {
  read: number
  write: number
}

function topBy(entries: TopProcEntry[]): TopProcEntry[] {
  return entries
    .filter((e) => e.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, TOP_N)
}

/**
 * Which of the two extra sweeps this tick includes. Both are expensive (a
 * /proc walk and an `ss` dump), and both only feed a card that belongs to a
 * module, so they are skipped when that module is not running.
 */
export interface TopProbes {
  /** /proc/PID/io, for the "busiest processes" line on the Disk I/O card. */
  perProcessIo: boolean
  /** ss byte counters, for the same line on the Network card. */
  perProcessNet: boolean
}

/**
 * Which process is eating each resource right now. The Overview cards show
 * the top few per card, so all four answers come from one tick instead of
 * four separate polls.
 */
export class TopConsumersService {
  latest: TopConsumersSnapshot | null = null
  private probes: TopProbes = { perProcessIo: true, perProcessNet: true }
  private prevT = 0
  private prevIo = new Map<number, IoCounters>()
  private prevSock = new Map<string, { acked: number; received: number }>()
  readonly poller: Poller

  constructor(private emit: (snap: TopConsumersSnapshot) => void) {
    this.poller = new Poller('top-consumers', () => this.sample())
  }

  configure(probes: TopProbes): void {
    this.probes = probes
  }

  reset(): void {
    this.latest = null
    this.prevT = 0
    this.prevIo = new Map()
    this.prevSock = new Map()
  }

  private compositeCmd(): string {
    const parts = [`echo '===PS==='; ${PS_CMD}`]
    if (this.probes.perProcessIo) parts.push(`echo '===PIO==='; ${PIO_CMD}`)
    if (this.probes.perProcessNet) parts.push(`echo '===SS==='; ${SS_CMD}`)
    return parts.join('; ')
  }

  private async sample(): Promise<void> {
    if (!connection.connected) return
    const useSudo = connection.status().hasSudo === true
    const cmd = this.compositeCmd()
    const res = useSudo
      ? await connection.execSudo(cmd, { timeoutMs: 20000 })
      : await connection.exec(cmd, { timeoutMs: 20000 })
    if (res.code !== 0 && !res.stdout) return
    const t = Date.now()
    const sec = splitSections(res.stdout)
    const dt = this.prevT ? Math.max((t - this.prevT) / 1000, 0.001) : 0

    // --- CPU and memory (a single ps) ---
    const names = new Map<number, string>()
    const cpu: TopProcEntry[] = []
    const memory: TopProcEntry[] = []
    for (const line of (sec.get('PS') ?? '').split('\n')) {
      const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/)
      if (!m) continue
      const pid = parseInt(m[1], 10)
      const name = m[4].trim()
      names.set(pid, name)
      cpu.push({ pid, name, value: parseFloat(m[2]) || 0 })
      memory.push({ pid, name, value: (parseInt(m[3], 10) || 0) * 1024 })
    }

    // --- Disk I/O per process (counter deltas) ---
    const nextIo = new Map<number, IoCounters>()
    const disk: TopProcEntry[] = []
    for (const line of (sec.get('PIO') ?? '').split('\n')) {
      const f = line.trim().split(/\s+/)
      if (f.length < 3) continue
      const pid = parseInt(f[0], 10)
      if (!Number.isFinite(pid)) continue
      const read = parseInt(f[1], 10) || 0
      const write = parseInt(f[2], 10) || 0
      nextIo.set(pid, { read, write })
      const prev = this.prevIo.get(pid)
      if (!prev || !dt) continue
      const readRate = Math.max(0, read - prev.read) / dt
      const writeRate = Math.max(0, write - prev.write) / dt
      const rate = readRate + writeRate
      if (rate > 0) {
        disk.push({
          pid,
          name: names.get(pid) ?? `pid ${pid}`,
          value: rate,
          read: readRate,
          write: writeRate
        })
      }
    }
    this.prevIo = nextIo

    // --- Network per process (ss byte counters, TCP only) ---
    const nextSock = new Map<string, { acked: number; received: number }>()
    const netByPid = new Map<number, TopProcEntry>()
    for (const r of parseSs(sec.get('SS') ?? '')) {
      if (r.bytesAcked == null && r.bytesReceived == null) continue
      const key = `${r.proto}|${r.local}|${r.peer}`
      const cur = { acked: r.bytesAcked ?? 0, received: r.bytesReceived ?? 0 }
      const prev = this.prevSock.get(key)
      nextSock.set(key, cur)
      if (!prev || !dt || r.pid == null) continue
      const rxRate = Math.max(0, cur.received - prev.received) / dt
      const txRate = Math.max(0, cur.acked - prev.acked) / dt
      if (rxRate + txRate <= 0) continue
      const entry = netByPid.get(r.pid) ?? {
        pid: r.pid,
        name: r.process || names.get(r.pid) || `pid ${r.pid}`,
        value: 0,
        rx: 0,
        tx: 0
      }
      entry.value += rxRate + txRate
      entry.rx = (entry.rx ?? 0) + rxRate
      entry.tx = (entry.tx ?? 0) + txRate
      netByPid.set(r.pid, entry)
    }
    this.prevSock = nextSock

    this.prevT = t

    const snap: TopConsumersSnapshot = {
      t,
      sudo: useSudo,
      cpu: topBy(cpu),
      memory: topBy(memory),
      disk: topBy(disk),
      network: topBy([...netByPid.values()])
    }
    this.latest = snap
    this.emit(snap)
  }
}
