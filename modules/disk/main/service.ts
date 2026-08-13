import type {
  BlockDeviceInfo,
  DiskDeviceInfo,
  DiskHistoryPoint,
  DiskSnapshot,
  ProcDiskUsage,
  StorageSnapshot
} from '@shared/types'
import type { ModuleContext, ModulePoller } from '@shared/modules'
import { PHYSICAL_DISK, splitSections } from '@shared/shell'
import { flattenDevices } from './lsblk'

const HISTORY_MS = 5 * 60 * 1000
const MAX_PROCESSES = 300

/**
 * One shell roundtrip per tick: device counters from /proc/diskstats and a
 * single awk sweep over /proc/PID/io for per-process I/O (root sees every
 * process; without sudo only the connecting user's processes are readable -
 * honest degradation). Device models, sizes and mount usage do not belong
 * here: they come from the storage poller, which reads them far less often.
 */
const COMPOSITE_CMD = [
  `echo '===DISKSTATS==='; cat /proc/diskstats`,
  `echo '===PIO==='; awk '/^read_bytes:/{r[FILENAME]=$2} /^write_bytes:/{w[FILENAME]=$2} ` +
    `END{for(f in r){split(f,a,"/"); print a[3], r[f], w[f]+0}}' ` +
    `$(find /proc -maxdepth 2 -name io -readable 2>/dev/null) /dev/null 2>/dev/null`,
  `echo '===PS==='; ps axo pid,comm --no-headers 2>/dev/null`
].join('; ')

interface DiskCounters {
  reads: number
  sectorsRead: number
  msRead: number
  writes: number
  sectorsWritten: number
  msWrite: number
  ioTicks: number
}

function parseDiskstats(text: string): Map<string, DiskCounters> {
  const map = new Map<string, DiskCounters>()
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/)
    if (f.length < 14 || !PHYSICAL_DISK.test(f[2])) continue
    map.set(f[2], {
      reads: parseInt(f[3], 10) || 0,
      sectorsRead: parseInt(f[5], 10) || 0,
      msRead: parseInt(f[6], 10) || 0,
      writes: parseInt(f[7], 10) || 0,
      sectorsWritten: parseInt(f[9], 10) || 0,
      msWrite: parseInt(f[10], 10) || 0,
      ioTicks: parseInt(f[12], 10) || 0
    })
  }
  return map
}

export class DiskService {
  history: DiskHistoryPoint[] = []
  latest: DiskSnapshot | null = null

  private prevT = 0
  private prevDisk: Map<string, DiskCounters> | null = null
  private prevPio = new Map<number, { read: number; write: number }>()

  readonly poller: ModulePoller

  constructor(
    private ctx: ModuleContext,
    /** Device inventory comes from the storage poller (see StorageService). */
    private storage: () => StorageSnapshot | null
  ) {
    this.poller = ctx.createPoller('detail', () => this.sample())
  }

  /** Model, size and rotational flag per device name, from the last lsblk. */
  private deviceMeta(): Map<string, BlockDeviceInfo> {
    const map = new Map<string, BlockDeviceInfo>()
    for (const d of flattenDevices(this.storage()?.devices ?? [])) map.set(d.name, d)
    return map
  }

  reset(): void {
    this.history = []
    this.latest = null
    this.prevT = 0
    this.prevDisk = null
    this.prevPio = new Map()
  }

  dispose(): void {
    this.poller.stop()
  }

  private async sample(): Promise<void> {
    if (!this.ctx.connected) return
    const useSudo = this.ctx.hasSudo
    const res = useSudo
      ? await this.ctx.execSudo(COMPOSITE_CMD, { timeoutMs: 20000 })
      : await this.ctx.exec(COMPOSITE_CMD, { timeoutMs: 20000 })
    if (res.code !== 0 && !res.stdout) return
    const t = Date.now()
    const sec = splitSections(res.stdout)
    const dt = this.prevT ? Math.max((t - this.prevT) / 1000, 0.001) : 0

    // --- Devices ---
    const stats = parseDiskstats(sec.get('DISKSTATS') ?? '')
    const meta = this.deviceMeta()
    const devices: DiskDeviceInfo[] = []
    let totalReadRate = 0
    let totalWriteRate = 0
    let totalReadIops = 0
    let totalWriteIops = 0
    for (const [name, cur] of stats) {
      const prev = this.prevDisk?.get(name)
      const info = meta.get(name)
      const d = (now: number, before: number | undefined): number =>
        prev && before != null ? Math.max(0, now - before) : 0
      const dReads = d(cur.reads, prev?.reads)
      const dWrites = d(cur.writes, prev?.writes)
      const dOps = dReads + dWrites
      const dMs = d(cur.msRead, prev?.msRead) + d(cur.msWrite, prev?.msWrite)
      const dev: DiskDeviceInfo = {
        name,
        model: info?.model ?? '',
        sizeBytes: info?.sizeBytes ?? 0,
        rotational: info?.rotational ?? false,
        readRate: dt ? (d(cur.sectorsRead, prev?.sectorsRead) * 512) / dt : 0,
        writeRate: dt ? (d(cur.sectorsWritten, prev?.sectorsWritten) * 512) / dt : 0,
        readIops: dt ? dReads / dt : 0,
        writeIops: dt ? dWrites / dt : 0,
        utilPct: dt ? Math.min(100, (d(cur.ioTicks, prev?.ioTicks) / (dt * 1000)) * 100) : 0,
        avgLatencyMs: dOps > 0 ? dMs / dOps : 0,
        readTotal: cur.sectorsRead * 512,
        writeTotal: cur.sectorsWritten * 512
      }
      devices.push(dev)
      totalReadRate += dev.readRate
      totalWriteRate += dev.writeRate
      totalReadIops += dev.readIops
      totalWriteIops += dev.writeIops
    }
    devices.sort((a, b) => a.name.localeCompare(b.name))
    this.prevDisk = stats

    // --- Per-process I/O ---
    const names = new Map<number, string>()
    for (const line of (sec.get('PS') ?? '').split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/)
      if (m) names.set(parseInt(m[1], 10), m[2])
    }
    const nextPio = new Map<number, { read: number; write: number }>()
    const processes: ProcDiskUsage[] = []
    for (const line of (sec.get('PIO') ?? '').split('\n')) {
      const f = line.trim().split(/\s+/)
      if (f.length < 3) continue
      const pid = parseInt(f[0], 10)
      if (!Number.isFinite(pid)) continue
      const read = parseInt(f[1], 10) || 0
      const write = parseInt(f[2], 10) || 0
      nextPio.set(pid, { read, write })
      const prev = this.prevPio.get(pid)
      const readRate = dt && prev ? Math.max(0, read - prev.read) / dt : 0
      const writeRate = dt && prev ? Math.max(0, write - prev.write) / dt : 0
      if (read === 0 && write === 0 && readRate === 0 && writeRate === 0) continue
      processes.push({
        pid,
        process: names.get(pid) ?? `pid ${pid}`,
        readRate,
        writeRate,
        readTotal: read,
        writeTotal: write
      })
    }
    this.prevPio = nextPio
    processes.sort(
      (a, b) =>
        b.readRate + b.writeRate - (a.readRate + a.writeRate) ||
        b.readTotal + b.writeTotal - (a.readTotal + a.writeTotal)
    )
    const processesOut = processes.slice(0, MAX_PROCESSES)

    this.prevT = t

    /**
     * What the devices moved minus what the listed processes account for: the
     * kernel only charges /proc/PID/io for bytes a process pushed to the block
     * layer, so writeback, journal, swap and (without sudo) other users'
     * processes end up here instead of silently disappearing from the table.
     * A spec's `keyValue`/`stat` block reads a resolved field, not a
     * subtraction across two of a snapshot's own fields, so this is worked
     * out here rather than left to the UI like the pre-spec renderer did.
     */
    let processReadRate = 0
    let processWriteRate = 0
    for (const p of processesOut) {
      processReadRate += p.readRate
      processWriteRate += p.writeRate
    }

    const snap: DiskSnapshot = {
      t,
      sudo: useSudo,
      totalReadRate,
      totalWriteRate,
      totalReadIops,
      totalWriteIops,
      totalIops: totalReadIops + totalWriteIops,
      unattributedReadRate: Math.max(0, totalReadRate - processReadRate),
      unattributedWriteRate: Math.max(0, totalWriteRate - processWriteRate),
      devices,
      processes: processesOut
    }
    this.latest = snap

    const point: DiskHistoryPoint = {
      t,
      read: totalReadRate,
      write: totalWriteRate,
      readIops: totalReadIops,
      writeIops: totalWriteIops
    }
    this.history.push(point)
    const cutoff = t - HISTORY_MS
    while (this.history.length && this.history[0].t < cutoff) this.history.shift()
    this.ctx.addHistory({
      t,
      read: Math.round(totalReadRate),
      write: Math.round(totalWriteRate),
      riops: totalReadIops,
      wiops: totalWriteIops
    })

    // Two streams for the same reason as in the Network module: the page needs
    // the whole snapshot, the charts need five numbers per tick.
    this.ctx.emit('snapshot', snap)
    this.ctx.emit('series', point)
  }
}
