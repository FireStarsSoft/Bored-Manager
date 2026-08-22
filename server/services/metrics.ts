import type { CollectorSettings, SystemSnapshot } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { PHYSICAL_DISK, splitSections } from '@shared/shell'
import { connection, type ConnectionManager } from '../connection'
import { Poller } from './poller'

const HISTORY_MS = 5 * 60 * 1000

interface CpuTimes {
  busy: number
  total: number
}

interface RawSample {
  t: number
  cpus: Map<string, CpuTimes>
  netRxBytes: number
  netTxBytes: number
  diskReadBytes: number
  diskWriteBytes: number
}

interface FileSection {
  name: string
  path: string
}

export class SystemMetricsService {
  history: SystemSnapshot[] = []
  private prev: RawSample | null = null
  private hostname: string | null = null
  private collectors: CollectorSettings = DEFAULT_SETTINGS.collectors
  private collectorsRevision = 0
  private suppressCpuRate = false
  private suppressNetworkRate = false
  private suppressDiskRate = false
  readonly poller: Poller

  constructor(
    private emit: (snap: SystemSnapshot) => void,
    private readonly target: ConnectionManager = connection,
    pollerName = 'system-metrics'
  ) {
    this.poller = new Poller(pollerName, () => this.sample())
  }

  /** Only the sections whose collector is enabled are read on the target. */
  configure(collectors: CollectorSettings): void {
    const changed =
      this.collectors.cpu !== collectors.cpu ||
      this.collectors.memory !== collectors.memory ||
      this.collectors.network !== collectors.network ||
      this.collectors.disk !== collectors.disk
    if (!this.collectors.cpu && collectors.cpu) this.suppressCpuRate = true
    if (!this.collectors.network && collectors.network) this.suppressNetworkRate = true
    if (!this.collectors.disk && collectors.disk) this.suppressDiskRate = true
    this.collectors = collectors
    if (changed) this.collectorsRevision++
  }

  /** False when every section this service could collect is disabled. */
  hasEnabledSections(): boolean {
    const c = this.collectors
    return c.cpu || c.memory || c.network || c.disk
  }

  private compositeCmd(c: CollectorSettings = this.collectors): string {
    const parts: string[] = []
    if (c.cpu) parts.push(`echo '===STAT==='; cat /proc/stat`)
    if (c.memory) parts.push(`echo '===MEM==='; cat /proc/meminfo`)
    if (c.network) parts.push(`echo '===NET==='; cat /proc/net/dev`)
    if (c.disk) parts.push(`echo '===DISK==='; cat /proc/diskstats`)
    parts.push(
      `echo '===UPTIME==='; cat /proc/uptime`,
      `echo '===LOAD==='; cat /proc/loadavg`,
      `echo '===HOST==='; hostname`
    )
    return parts.join('; ')
  }

  private fileSections(c: CollectorSettings): FileSection[] {
    const sections: FileSection[] = []
    if (c.cpu) sections.push({ name: 'STAT', path: '/proc/stat' })
    if (c.memory) sections.push({ name: 'MEM', path: '/proc/meminfo' })
    if (c.network) sections.push({ name: 'NET', path: '/proc/net/dev' })
    if (c.disk) sections.push({ name: 'DISK', path: '/proc/diskstats' })
    sections.push(
      { name: 'UPTIME', path: '/proc/uptime' },
      { name: 'LOAD', path: '/proc/loadavg' }
    )
    return sections
  }

  reset(): void {
    this.collectorsRevision++
    this.history = []
    this.prev = null
    this.hostname = null
    this.suppressCpuRate = false
    this.suppressNetworkRate = false
    this.suppressDiskRate = false
  }

  private async compositeSections(
    collectors: CollectorSettings
  ): Promise<Map<string, string> | null> {
    const res = await this.target.exec(this.compositeCmd(collectors), {
      timeoutMs: 15000
    })
    if (res.code !== 0 && !res.stdout) return null
    return splitSections(res.stdout)
  }

  private async sampleSections(
    collectors: CollectorSettings
  ): Promise<Map<string, string> | null> {
    const wanted = this.fileSections(collectors)
    const files = await this.target.readFiles(wanted.map((section) => section.path))
    if (files === null || files.some((file) => !file.ok)) {
      return this.compositeSections(collectors)
    }

    const sections = new Map<string, string>()
    for (let index = 0; index < wanted.length; index++) {
      sections.set(wanted[index].name, files[index]?.text ?? '')
    }
    // A hostname is effectively immutable during one connection. Cache the
    // one shell lookup so local /proc sampling remains zero-process thereafter.
    if (this.hostname === null) {
      const host = await this.target.exec('hostname', {
        timeoutMs: 15_000,
        maxOutputBytes: 64 * 1024
      })
      this.hostname = host.stdout.trim()
    }
    sections.set('HOST', this.hostname)
    return sections
  }

  private async sample(): Promise<void> {
    if (!this.target.connected) return
    const collectors = this.collectors
    const revision = this.collectorsRevision
    const sec = await this.sampleSections(collectors)
    if (revision !== this.collectorsRevision) return
    if (!sec) return
    const t = Date.now()

    // --- CPU ---
    const cpus = new Map<string, CpuTimes>()
    for (const line of (sec.get('STAT') ?? '').split('\n')) {
      const parts = line.trim().split(/\s+/)
      if (!parts[0]?.startsWith('cpu')) continue
      const nums = parts.slice(1).map((n) => parseInt(n, 10) || 0)
      const idle = (nums[3] ?? 0) + (nums[4] ?? 0)
      const total = nums.reduce((a, b) => a + b, 0)
      cpus.set(parts[0], { busy: total - idle, total })
    }

    // --- Network (sum all non-lo interfaces) ---
    let netRxBytes = 0
    let netTxBytes = 0
    for (const line of (sec.get('NET') ?? '').split('\n')) {
      const m = line.match(/^\s*([^\s:]+):\s*(.*)$/)
      if (!m || m[1] === 'lo') continue
      const f = m[2].trim().split(/\s+/)
      netRxBytes += parseInt(f[0], 10) || 0
      netTxBytes += parseInt(f[8], 10) || 0
    }

    // --- Disk I/O (sectors are 512 bytes) ---
    let diskReadBytes = 0
    let diskWriteBytes = 0
    for (const line of (sec.get('DISK') ?? '').split('\n')) {
      const f = line.trim().split(/\s+/)
      if (f.length < 14 || !PHYSICAL_DISK.test(f[2])) continue
      diskReadBytes += (parseInt(f[5], 10) || 0) * 512
      diskWriteBytes += (parseInt(f[9], 10) || 0) * 512
    }

    const raw: RawSample = { t, cpus, netRxBytes, netTxBytes, diskReadBytes, diskWriteBytes }
    const prev = this.prev
    this.prev = raw
    const suppressCpuRate = this.suppressCpuRate
    const suppressNetworkRate = this.suppressNetworkRate
    const suppressDiskRate = this.suppressDiskRate
    if (this.collectors.cpu) this.suppressCpuRate = false
    if (this.collectors.network) this.suppressNetworkRate = false
    if (this.collectors.disk) this.suppressDiskRate = false
    if (!prev) return // need two samples for rates

    const dt = Math.max((t - prev.t) / 1000, 0.001)

    const cpuPct = (key: string): number => {
      if (suppressCpuRate) return 0
      const a = prev.cpus.get(key)
      const b = cpus.get(key)
      if (!a || !b) return 0
      const dTotal = b.total - a.total
      if (dTotal <= 0) return 0
      return Math.min(100, Math.max(0, ((b.busy - a.busy) / dTotal) * 100)) 
    }
    const perCore: number[] = []
    for (let i = 0; cpus.has(`cpu${i}`); i++) perCore.push(cpuPct(`cpu${i}`))

    // --- Memory ---
    const memVals: Record<string, number> = {}
    for (const line of (sec.get('MEM') ?? '').split('\n')) {
      const m = line.match(/^(\w+):\s+(\d+)/)
      if (m) memVals[m[1]] = parseInt(m[2], 10) * 1024
    }
    const memTotal = memVals.MemTotal ?? 0
    const memAvail = memVals.MemAvailable ?? 0
    const swapTotal = memVals.SwapTotal ?? 0
    const swapFree = memVals.SwapFree ?? 0

    // --- Load / uptime / hostname ---
    const loadParts = (sec.get('LOAD') ?? '').trim().split(/\s+/)
    const load: [number, number, number] = [
      parseFloat(loadParts[0]) || 0,
      parseFloat(loadParts[1]) || 0,
      parseFloat(loadParts[2]) || 0
    ]
    const uptimeSec = parseFloat((sec.get('UPTIME') ?? '0').trim().split(/\s+/)[0]) || 0
    const hostname = (sec.get('HOST') ?? '').trim()

    const snap: SystemSnapshot = {
      t,
      cpu: { total: cpuPct('cpu'), perCore },
      mem: {
        total: memTotal,
        used: memTotal - memAvail,
        available: memAvail,
        swapTotal,
        swapUsed: swapTotal - swapFree
      },
      netRx: suppressNetworkRate
        ? 0
        : Math.max(0, (netRxBytes - prev.netRxBytes) / dt),
      netTx: suppressNetworkRate
        ? 0
        : Math.max(0, (netTxBytes - prev.netTxBytes) / dt),
      diskRead: suppressDiskRate
        ? 0
        : Math.max(0, (diskReadBytes - prev.diskReadBytes) / dt),
      diskWrite: suppressDiskRate
        ? 0
        : Math.max(0, (diskWriteBytes - prev.diskWriteBytes) / dt),
      load,
      uptimeSec,
      hostname
    }

    this.history.push(snap)
    const cutoff = t - HISTORY_MS
    while (this.history.length && this.history[0].t < cutoff) this.history.shift()
    this.emit(snap)
  }
}
