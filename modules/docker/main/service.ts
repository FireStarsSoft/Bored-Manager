import type {
  DockerContainer,
  DockerDfRow,
  DockerHealth,
  DockerImage,
  DockerInspect,
  DockerMount,
  DockerNetwork,
  DockerNetworkAttachment,
  DockerPortMapping,
  DockerSlowSnapshot,
  DockerSnapshot,
  DockerVolume,
  OkResult
} from '@shared/types'
import type { ModuleContext, ModulePoller, ModuleStreamHandle } from '@shared/modules'
import { shQuote } from '@shared/shell'

const HISTORY_MS = 5 * 60 * 1000
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:\/-]*$/

function parseJsonLines<T>(out: string): T[] {
  const items: T[] = []
  for (const line of out.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    try {
      items.push(JSON.parse(s) as T)
    } catch {
      /* skip malformed line */
    }
  }
  return items
}

function pct(v: string | undefined): number {
  return parseFloat(String(v ?? '').replace('%', '')) || 0
}

/**
 * The `series` stream's point shape: a `snapshot` is kept as 'latest' (see
 * `sample()`), so the summary chart/spark reads this instead - reused for the
 * live emit and for seeding a freshly connected renderer from `history`.
 */
export function toSeriesPoint(s: DockerSnapshot): { t: number; running: number; cpu: number; mem: number } {
  return { t: s.t, running: s.running, cpu: s.totalCpuPct, mem: s.totalMemPct }
}

/**
 * Docker prints human sizes with SI units ("1.958GB"), sometimes with a
 * percentage attached ("1.093GB (55%)"). Binary suffixes are accepted too in
 * case a daemon reports them.
 */
const SIZE_UNITS: Record<string, number> = {
  '': 1,
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  pb: 1e15,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4
}

function parseDockerSize(raw: string | undefined): number {
  const m = String(raw ?? '')
    .trim()
    .match(/^([\d.]+)\s*([a-zA-Z]*)/)
  if (!m) return 0
  const value = parseFloat(m[1])
  if (!Number.isFinite(value)) return 0
  return value * (SIZE_UNITS[m[2].toLowerCase()] ?? 1)
}

/**
 * `docker ps` puts the healthcheck result inside the status string
 * ("Up 2 hours (healthy)"), the only place the CLI exposes it without an
 * inspect per container.
 */
function healthFromStatus(status: string | undefined): string {
  const m = String(status ?? '').match(/\((health: )?(healthy|unhealthy|starting)\)/i)
  return m ? m[2].toLowerCase() : ''
}

/**
 * Docker timestamps are RFC 3339; the zero value means "never happened".
 * Formatted here rather than left as a number: a `keyValue` row has no
 * date/time format to apply itself, only bytes/rate/pct/temp/number/text.
 */
function dockerTimeLabel(raw: unknown): string {
  if (typeof raw !== 'string' || !raw || raw.startsWith('0001-01-01')) return ''
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : ''
}

/**
 * Image and volume inventory is NOT here: enumerating it costs extra docker
 * calls for numbers that hardly ever change, so the slow docker poller below
 * owns disk usage and this tick stays down to containers and their stats.
 */
const SNAPSHOT_CMD =
  `docker ps -a --format '{{json .}}' 2>/dev/null; ` +
  `echo '===STATS==='; docker stats --no-stream --format '{{json .}}' 2>/dev/null`

const DF_CMD = `docker system df --format '{{json .}}' 2>/dev/null`

/** Fallback when `docker system df` is unavailable: counts, no sizes. */
const COUNTS_CMD =
  `docker images -q 2>/dev/null | wc -l; docker volume ls -q 2>/dev/null | wc -l; ` +
  `docker ps -aq 2>/dev/null | wc -l`

const EMPTY_DF_ROW: DockerDfRow = { count: 0, active: 0, sizeBytes: 0, reclaimableBytes: 0 }

/** The subset of `docker inspect` this service reads; everything is optional. */
interface RawInspect {
  Id?: string
  Name?: string
  Created?: string
  Path?: string
  Args?: string[]
  Image?: string
  RestartCount?: number
  State?: {
    Status?: string
    StartedAt?: string
    FinishedAt?: string
    ExitCode?: number
    Health?: {
      Status?: string
      FailingStreak?: number
      Log?: Array<{ Output?: string }>
    }
  }
  Config?: { Image?: string; Labels?: Record<string, string> }
  HostConfig?: { RestartPolicy?: { Name?: string; MaximumRetryCount?: number } }
  NetworkSettings?: {
    Networks?: Record<string, { IPAddress?: string; Gateway?: string; MacAddress?: string } | null>
    Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>
  }
  Mounts?: Array<{
    Type?: string
    Name?: string
    Source?: string
    Destination?: string
    RW?: boolean
  }>
}

export class DockerService {
  history: DockerSnapshot[] = []
  /** Disk usage, refreshed on the slow docker interval. */
  slowLatest: DockerSlowSnapshot | null = null
  readonly poller: ModulePoller
  readonly slowPoller: ModulePoller
  private logStreams = new Map<string, ModuleStreamHandle>()

  constructor(private ctx: ModuleContext) {
    this.poller = ctx.createPoller('metrics', () => this.sample())
    this.slowPoller = ctx.createPoller('storage', () => this.sampleSlow())
  }

  reset(): void {
    this.history = []
    this.slowLatest = null
    for (const id of [...this.logStreams.keys()]) this.stopLogs(id)
  }

  dispose(): void {
    this.poller.stop()
    this.slowPoller.stop()
    for (const id of [...this.logStreams.keys()]) this.stopLogs(id)
  }

  /** Run one disk-usage tick right now (manual refresh button). */
  async refreshSlowNow(): Promise<DockerSlowSnapshot | null> {
    await this.sampleSlow()
    return this.slowLatest
  }

  /**
   * `docker system df` in one call: counts, sizes and what a prune would
   * reclaim for images, containers, volumes and the build cache.
   */
  private async sampleSlow(): Promise<void> {
    if (!this.ctx.connected) return
    const res = await this.ctx.exec(DF_CMD, { timeoutMs: 60000 })
    interface RawDf {
      Type: string
      TotalCount: string
      Active: string
      Size: string
      Reclaimable: string
    }
    const rows = parseJsonLines<RawDf>(res.stdout)
    const snap: DockerSlowSnapshot = {
      t: Date.now(),
      available: rows.length > 0,
      hasSizes: rows.length > 0,
      images: { ...EMPTY_DF_ROW },
      containers: { ...EMPTY_DF_ROW },
      volumes: { ...EMPTY_DF_ROW },
      buildCache: { ...EMPTY_DF_ROW },
      totalSizeBytes: 0,
      totalReclaimableBytes: 0
    }
    for (const r of rows) {
      const row: DockerDfRow = {
        count: parseInt(r.TotalCount, 10) || 0,
        active: parseInt(r.Active, 10) || 0,
        sizeBytes: parseDockerSize(r.Size),
        reclaimableBytes: parseDockerSize(r.Reclaimable)
      }
      const type = (r.Type ?? '').toLowerCase()
      if (type === 'images') snap.images = row
      else if (type === 'containers') snap.containers = row
      else if (type === 'local volumes') snap.volumes = row
      else if (type === 'build cache') snap.buildCache = row
    }

    if (!rows.length) {
      // Old daemon or df not permitted: at least report how many there are.
      const counts = await this.ctx.exec(COUNTS_CMD, { timeoutMs: 30000 })
      const nums = counts.stdout
        .split('\n')
        .map((l) => parseInt(l.trim(), 10))
        .filter((n) => Number.isFinite(n))
      if (nums.length) {
        snap.available = true
        snap.images.count = nums[0] ?? 0
        snap.volumes.count = nums[1] ?? 0
        snap.containers.count = nums[2] ?? 0
      }
    }

    // Sums a `keyValue`/`stat` block cannot compute itself - see DockerSlowSnapshot.
    for (const row of [snap.images, snap.containers, snap.volumes, snap.buildCache]) {
      snap.totalSizeBytes += row.sizeBytes
      snap.totalReclaimableBytes += row.reclaimableBytes
    }

    this.slowLatest = snap
    this.ctx.emit('storage', snap)
  }

  private async sample(): Promise<void> {
    if (!this.ctx.connected) return
    const res = await this.ctx.exec(SNAPSHOT_CMD, { timeoutMs: 25000 })
    const t = Date.now()
    const [psPart, statsPart = ''] = res.stdout.split('===STATS===')

    interface RawPs {
      ID: string
      Names: string
      Image: string
      State: string
      Status: string
      Ports: string
      RunningFor: string
    }
    interface RawStat {
      ID: string
      Name: string
      CPUPerc: string
      MemPerc: string
      MemUsage: string
      NetIO: string
      BlockIO: string
      PIDs: string
    }

    // `docker ps` and `docker stats` are two separate commands; a stopped
    // container has no stats row at all, so it keeps the zero/empty defaults
    // below instead of a "—" a table cannot leave a cell showing on its own.
    const statsById = new Map(parseJsonLines<RawStat>(statsPart).map((s) => [s.ID, s]))
    const containers: DockerContainer[] = parseJsonLines<RawPs>(psPart).map((c) => {
      const s = statsById.get(c.ID)
      return {
        id: c.ID,
        name: c.Names,
        image: c.Image,
        state: c.State,
        status: c.Status,
        ports: c.Ports,
        runningFor: c.RunningFor,
        health: healthFromStatus(c.Status),
        cpuPct: s ? pct(s.CPUPerc) : 0,
        memPct: s ? pct(s.MemPerc) : 0,
        memUsage: s?.MemUsage ?? '',
        netIO: s?.NetIO ?? '',
        blockIO: s?.BlockIO ?? '',
        pids: s ? parseInt(s.PIDs, 10) || 0 : 0
      }
    })
    const available =
      res.stdout.includes('===STATS===') &&
      !(res.stderr.includes('command not found') || res.stderr.includes('Cannot connect'))

    const snap: DockerSnapshot = {
      t,
      available: available && (containers.length > 0 || res.code === 0),
      running: containers.filter((c) => c.state === 'running').length,
      stopped: containers.filter((c) => c.state !== 'running').length,
      totalCpuPct: containers.reduce((a, c) => a + c.cpuPct, 0),
      totalMemPct: containers.reduce((a, c) => a + c.memPct, 0),
      containers
    }
    this.history.push(snap)
    const cutoff = t - HISTORY_MS
    while (this.history.length && this.history[0].t < cutoff) this.history.shift()
    this.ctx.addHistory({
      t,
      running: snap.running,
      cpu: snap.totalCpuPct,
      mem: snap.totalMemPct
    })
    // `snapshot` is the full listing (kind 'latest' - a table/stat reading
    // "now" cannot pick an element off a series); `series` is a slim point
    // for the summary chart/spark, mirroring the other multi-page modules.
    this.ctx.emit('snapshot', snap)
    this.ctx.emit('series', toSeriesPoint(snap))
  }

  // ---------- Listings ----------

  async listImages(): Promise<DockerImage[]> {
    const res = await this.ctx.exec(`docker images --format '{{json .}}' 2>/dev/null`)
    interface Raw {
      ID: string
      Repository: string
      Tag: string
      Size: string
      CreatedSince: string
    }
    return parseJsonLines<Raw>(res.stdout).map((i) => ({
      id: i.ID,
      repository: i.Repository,
      tag: i.Tag,
      size: i.Size,
      created: i.CreatedSince,
      // The same id can carry more than one tag - two rows, same id, different
      // tag - so `id` alone cannot be a table's row key; this can.
      key: `${i.ID}:${i.Tag}`
    }))
  }

  async listVolumes(): Promise<DockerVolume[]> {
    const res = await this.ctx.exec(`docker volume ls --format '{{json .}}' 2>/dev/null`)
    interface Raw {
      Name: string
      Driver: string
    }
    return parseJsonLines<Raw>(res.stdout).map((v) => ({ name: v.Name, driver: v.Driver }))
  }

  async listNetworks(): Promise<DockerNetwork[]> {
    const res = await this.ctx.exec(`docker network ls --format '{{json .}}' 2>/dev/null`)
    interface Raw {
      ID: string
      Name: string
      Driver: string
    }
    return parseJsonLines<Raw>(res.stdout).map((n) => ({ id: n.ID, name: n.Name, driver: n.Driver }))
  }

  /**
   * Everything the fast tick cannot answer: why a container stopped, how often
   * it restarted, whether its healthcheck passes, which addresses, published
   * ports and mounts it has. One daemon call, made only when a row is opened.
   */
  async inspect(id: string): Promise<DockerInspect | null> {
    if (!ID_RE.test(id)) return null
    const res = await this.ctx.exec(
      `docker inspect --format '{{json .}}' ${shQuote(id)} 2>/dev/null`,
      { timeoutMs: 20000 }
    )
    const raw = parseJsonLines<RawInspect>(res.stdout)[0]
    if (!raw) return null

    const health: DockerHealth | null = raw.State?.Health
      ? {
          status: String(raw.State.Health.Status ?? ''),
          failingStreak: raw.State.Health.FailingStreak ?? 0,
          lastOutput: String(raw.State.Health.Log?.at(-1)?.Output ?? '').trim().slice(0, 2000)
        }
      : null

    const networks: DockerNetworkAttachment[] = Object.entries(
      raw.NetworkSettings?.Networks ?? {}
    ).map(([name, n]) => ({
      name,
      ipv4: String(n?.IPAddress ?? ''),
      gateway: String(n?.Gateway ?? ''),
      macAddress: String(n?.MacAddress ?? '')
    }))

    const ports: DockerPortMapping[] = Object.entries(raw.NetworkSettings?.Ports ?? {}).map(
      ([container, bindings]) => ({
        container,
        host: (bindings ?? [])
          .map((b) => `${b.HostIp || '0.0.0.0'}:${b.HostPort ?? ''}`)
          .join(', ')
      })
    )

    const mounts: DockerMount[] = (raw.Mounts ?? []).map((m) => ({
      type: String(m.Type ?? ''),
      source: String(m.Name || m.Source || ''),
      destination: String(m.Destination ?? ''),
      mode: m.RW !== false ? 'rw' : 'ro'
    }))

    const policy = raw.HostConfig?.RestartPolicy
    const retries = policy?.MaximumRetryCount ?? 0
    const labels = raw.Config?.Labels ?? {}

    return {
      id: String(raw.Id ?? id),
      name: String(raw.Name ?? '').replace(/^\//, ''),
      image: String(raw.Config?.Image ?? ''),
      imageId: String(raw.Image ?? ''),
      command: [raw.Path ?? '', ...(raw.Args ?? [])].join(' ').trim(),
      createdAt: dockerTimeLabel(raw.Created),
      startedAt: dockerTimeLabel(raw.State?.StartedAt),
      finishedAt: dockerTimeLabel(raw.State?.FinishedAt),
      state: String(raw.State?.Status ?? ''),
      exitCode: typeof raw.State?.ExitCode === 'number' ? raw.State.ExitCode : null,
      restartCount: raw.RestartCount ?? 0,
      restartPolicy:
        (policy?.Name || 'no') + (policy?.Name === 'on-failure' && retries ? `:${retries}` : ''),
      health,
      networks,
      ports,
      mounts,
      composeProject: String(labels['com.docker.compose.project'] ?? ''),
      composeService: String(labels['com.docker.compose.service'] ?? '')
    }
  }

  // ---------- Actions ----------

  private async action(cmd: string): Promise<OkResult> {
    const res = await this.ctx.exec(cmd, { timeoutMs: 120000 })
    return res.code === 0
      ? { ok: true, data: res.stdout.trim() }
      : { ok: false, error: (res.stderr || res.stdout).trim() || `exit code ${res.code}` }
  }

  containerAction(
    id: string,
    action: 'start' | 'stop' | 'restart' | 'rm' | 'kill' | 'pause' | 'unpause'
  ): Promise<OkResult> {
    if (!ID_RE.test(id)) return Promise.resolve({ ok: false, error: 'invalid container id' })
    const flag = action === 'rm' ? ' -f' : ''
    return this.action(`docker ${action}${flag} ${shQuote(id)}`)
  }

  removeImage(id: string, force: boolean): Promise<OkResult> {
    if (!ID_RE.test(id)) return Promise.resolve({ ok: false, error: 'invalid image id' })
    return this.action(`docker rmi ${force ? '-f ' : ''}${shQuote(id)}`)
  }

  pruneImages(all: boolean): Promise<OkResult> {
    return this.action(`docker image prune -f ${all ? '-a' : ''}`)
  }

  removeVolume(name: string): Promise<OkResult> {
    if (!ID_RE.test(name)) return Promise.resolve({ ok: false, error: 'invalid volume name' })
    return this.action(`docker volume rm ${shQuote(name)}`)
  }

  pruneVolumes(): Promise<OkResult> {
    return this.action('docker volume prune -f')
  }

  removeNetwork(id: string): Promise<OkResult> {
    if (!ID_RE.test(id)) return Promise.resolve({ ok: false, error: 'invalid network id' })
    return this.action(`docker network rm ${shQuote(id)}`)
  }

  pruneNetworks(): Promise<OkResult> {
    return this.action('docker network prune -f')
  }

  pruneSystem(): Promise<OkResult> {
    return this.action('docker system prune -f')
  }

  // ---------- Log streaming ----------

  async startLogs(containerId: string): Promise<OkResult> {
    if (!ID_RE.test(containerId)) return { ok: false, error: 'invalid container id' }
    if (!this.ctx.connected) return { ok: false, error: 'not connected' }
    this.stopLogs(containerId)
    try {
      const handle = await this.ctx.stream(
        `docker logs -f --tail 300 ${shQuote(containerId)} 2>&1`
      )
      handle.onData((d) => this.ctx.emit('log', { id: containerId, data: d }))
      handle.onExit(() => this.logStreams.delete(containerId))
      this.logStreams.set(containerId, handle)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  }

  /**
   * Every stream is killed by dispose() as well, which the app calls when the
   * module is switched off and on a clean close - nothing is left running on
   * the target machine.
   */
  stopLogs(containerId: string): void {
    const handle = this.logStreams.get(containerId)
    if (!handle) return
    this.logStreams.delete(containerId)
    try {
      handle.kill()
    } catch {
      /* ignore */
    }
  }
}
