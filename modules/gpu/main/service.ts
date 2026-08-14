import type {
  AutoCapConfig,
  AutoCapGpuStatus,
  AutoCapStatus,
  AutoCapTrigger,
  GpuInfo,
  GpuProcess,
  GpuSnapshot,
  OkResult
} from '@shared/types'
import type { ModuleContext, ModulePoller } from '@shared/modules'

const HISTORY_MS = 5 * 60 * 1000

const GPU_QUERY = [
  'index',
  'name',
  'utilization.gpu',
  'utilization.memory',
  'memory.used',
  'memory.total',
  'temperature.gpu',
  'power.draw',
  'power.limit',
  'power.min_limit',
  'power.max_limit',
  'power.default_limit',
  'fan.speed',
  'clocks.sm',
  'clocks.mem',
  'persistence_mode',
  'driver_version'
].join(',')

/** How many fields the query above returns; a shorter row was cut off. */
const GPU_FIELDS = 17

const AUTO_CAP_DEFAULTS: AutoCapConfig = {
  enabled: false,
  intervalSec: 10,
  trigger: 'docker',
  gpus: {}
}

/**
 * The saved watcher, as read back from the app's own disk. Everything is
 * checked: the file is per machine and outlives module updates, so a shape from
 * an older version (or a hand edit) must not put nonsense watts on a GPU.
 */
function readAutoCapConfig(raw: unknown): AutoCapConfig {
  if (typeof raw !== 'object' || raw === null) return { ...AUTO_CAP_DEFAULTS, gpus: {} }
  const r = raw as Partial<AutoCapConfig>
  const gpus: AutoCapConfig['gpus'] = {}
  if (typeof r.gpus === 'object' && r.gpus !== null) {
    for (const [key, entry] of Object.entries(r.gpus)) {
      const index = Number(key)
      const idleCap = Math.round(Number((entry as { idleCap?: unknown })?.idleCap))
      const runningCap = Math.round(Number((entry as { runningCap?: unknown })?.runningCap))
      if (!Number.isInteger(index) || index < 0) continue
      if (!Number.isFinite(idleCap) || idleCap <= 0) continue
      if (!Number.isFinite(runningCap) || runningCap <= 0) continue
      gpus[String(index)] = { idleCap, runningCap }
    }
  }
  const intervalSec = Math.round(Number(r.intervalSec))
  return {
    enabled: r.enabled === true && Object.keys(gpus).length > 0,
    intervalSec: Number.isFinite(intervalSec) && intervalSec >= 2 ? intervalSec : AUTO_CAP_DEFAULTS.intervalSec,
    trigger: r.trigger === 'gpu' ? 'gpu' : 'docker',
    gpus
  }
}

const QUERY_CMD =
  `nvidia-smi --query-gpu=${GPU_QUERY} --format=csv,noheader,nounits; ` +
  `echo '===PROCS==='; ` +
  `nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null; ` +
  `echo '===UUID==='; ` +
  `nvidia-smi --query-gpu=index,gpu_uuid --format=csv,noheader 2>/dev/null`

function num(v: string): number {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

export class GpuService {
  history: GpuSnapshot[] = []
  readonly poller: ModulePoller
  private autoCapPoller: ModulePoller
  private cfg: AutoCapConfig = { ...AUTO_CAP_DEFAULTS, gpus: {} }
  /** Which machine `cfg` was read for, so it is re-read when that changes. */
  private cfgHost: string | null = null
  /** Interval the watcher is running on, 0 when it is not. */
  private autoCapMs = 0
  /** Cap this watcher last put on a GPU, by index. */
  private applied = new Map<number, number>()
  /** Last busy reading per GPU, for the status the page shows. */
  private busy = new Map<number, boolean>()
  private autoCapLines: string[] = []

  constructor(private ctx: ModuleContext) {
    this.poller = ctx.createPoller('metrics', () => this.sample())
    this.autoCapPoller = ctx.createPoller('autocap', () => this.autoCapTick())
  }

  reset(): void {
    this.history = []
    // The saved caps are not touched here: this runs on every connect and
    // disconnect, and forgetting them would make the watcher a per-session toy
    // again. applyAutoCap() below re-reads them for whatever machine is next.
    this.stopWatcher()
  }

  dispose(): void {
    this.poller.stop()
    this.stopWatcher()
  }

  private async sample(): Promise<void> {
    if (!this.ctx.connected) return
    const res = await this.ctx.exec(QUERY_CMD, { timeoutMs: 15000 })
    const t = Date.now()
    if (res.code !== 0 && !res.stdout.trim()) {
      const snap: GpuSnapshot = { t, available: false, gpus: [], processes: [] }
      this.pushHistory(snap)
      return
    }
    const [gpusPart, rest = ''] = res.stdout.split('===PROCS===')
    const [procsPart, uuidPart = ''] = rest.split('===UUID===')

    const gpus: GpuInfo[] = []
    for (const line of gpusPart.trim().split('\n')) {
      if (!line.trim()) continue
      const f = line.split(',').map((s) => s.trim())
      if (f.length < GPU_FIELDS) continue
      gpus.push({
        index: num(f[0]),
        name: f[1],
        utilization: num(f[2]),
        memUtil: num(f[3]),
        memUsedMiB: num(f[4]),
        memTotalMiB: num(f[5]),
        temp: num(f[6]),
        powerDraw: num(f[7]),
        powerLimit: num(f[8]),
        powerMin: num(f[9]),
        powerMax: num(f[10]),
        powerDefault: num(f[11]),
        fan: num(f[12]),
        clockSm: num(f[13]),
        clockMem: num(f[14]),
        persistence: f[15].toLowerCase().includes('enabled'),
        driverVersion: f[16]
      })
    }

    const uuidToIndex = new Map<string, number>()
    for (const line of uuidPart.trim().split('\n')) {
      const f = line.split(',').map((s) => s.trim())
      if (f.length >= 2) uuidToIndex.set(f[1], num(f[0]))
    }

    const processes: GpuProcess[] = []
    for (const line of procsPart.trim().split('\n')) {
      if (!line.trim() || line.includes('[N/A]')) continue
      const f = line.split(',').map((s) => s.trim())
      if (f.length < 4) continue
      processes.push({
        gpuIndex: uuidToIndex.get(f[0]) ?? 0,
        pid: num(f[1]),
        name: f[2],
        memMiB: num(f[3])
      })
    }

    const snap: GpuSnapshot = { t, available: gpus.length > 0, gpus, processes }
    this.pushHistory(snap)
  }

  private pushHistory(snap: GpuSnapshot): void {
    this.history.push(snap)
    const cutoff = snap.t - HISTORY_MS
    while (this.history.length && this.history[0].t < cutoff) this.history.shift()
    const g = snap.gpus[0]
    if (g) {
      // Flat point for the primary GPU only - what addHistory persists, and
      // (T3.5) what the declarative `chart`/`stat.spark` blocks read live: a
      // block's series source needs numeric keys straight on the point, and
      // `snapshot` carries the full per-GPU detail nested under `gpus[]`.
      const point = {
        t: snap.t,
        util: g.utilization,
        vram: g.memUsedMiB,
        vramTotal: g.memTotalMiB,
        temp: g.temp,
        draw: g.powerDraw,
        limit: g.powerLimit
      }
      this.ctx.addHistory(point)
      this.ctx.emit('series', point)
    }
    this.ctx.emit('snapshot', snap)
  }

  // ---------- Controls (need root) ----------

  private async sudoResult(cmd: string): Promise<OkResult> {
    const res = await this.ctx.execSudo(cmd, { timeoutMs: 20000 })
    return res.code === 0
      ? { ok: true, data: res.stdout.trim() }
      : { ok: false, error: (res.stderr || res.stdout).trim() || `exit code ${res.code}` }
  }

  /** The GPU of the latest reading, so a caller can be told what it may ask for. */
  private gpuAt(index: number): GpuInfo | null {
    const latest = this.history[this.history.length - 1]
    return latest?.gpus.find((g) => g.index === index) ?? null
  }

  /** Same, or the reason there is nothing to check a request against. */
  private gpuOrReason(index: number): GpuInfo | string {
    const gpu = this.gpuAt(index)
    if (gpu) return gpu
    return this.history.length
      ? `GPU ${index} is not on this machine`
      : 'There is no GPU reading yet - the GPU update interval may be paused in Settings'
  }

  /**
   * A watt value that GPU will accept, or the reason it will not. The driver
   * reports the range, so a typo (or an empty number field, which arrives as 0)
   * is refused here instead of by nvidia-smi after the fact. A GPU that reports
   * no range is only checked for being a positive number.
   */
  private checkWatts(gpu: GpuInfo, watts: number, what: string): number | string {
    const value = Math.round(watts)
    if (!Number.isFinite(value) || value <= 0) return `${what} has to be a number of watts above zero`
    const min = gpu.powerMin > 0 ? gpu.powerMin : 0
    const max = gpu.powerMax > 0 ? gpu.powerMax : 0
    if ((min && value < min) || (max && value > max)) {
      return `${what} has to be between ${min || 1} and ${max || 'the board limit'} W on GPU ${gpu.index} (${gpu.name})`
    }
    return value
  }

  setPowerLimit(index: number, watts: number): Promise<OkResult> {
    const gpu = this.gpuOrReason(index)
    if (typeof gpu === 'string') return Promise.resolve({ ok: false, error: gpu })
    const checked = this.checkWatts(gpu, watts, 'The power limit')
    if (typeof checked === 'string') return Promise.resolve({ ok: false, error: checked })
    return this.applyPowerLimit(index, checked)
  }

  private applyPowerLimit(index: number, watts: number): Promise<OkResult> {
    return this.sudoResult(`nvidia-smi -i ${Math.floor(index)} -pl ${Math.floor(watts)}`)
  }

  setPersistence(index: number, enabled: boolean): Promise<OkResult> {
    return this.sudoResult(`nvidia-smi -i ${Math.floor(index)} -pm ${enabled ? 1 : 0}`)
  }

  lockClocks(index: number, minMhz: number, maxMhz: number): Promise<OkResult> {
    return this.sudoResult(
      `nvidia-smi -i ${Math.floor(index)} -lgc ${Math.floor(minMhz)},${Math.floor(maxMhz)}`
    )
  }

  resetClocks(index: number): Promise<OkResult> {
    return this.sudoResult(`nvidia-smi -i ${Math.floor(index)} -rgc`)
  }

  /**
   * SIGKILL a compute process listed on the GPU page. Elevated because such a
   * process usually belongs to another user (a container, a training job).
   */
  killProcess(pid: number): Promise<OkResult> {
    return this.sudoResult(`kill -KILL ${Math.floor(pid)}`)
  }

  // ---------- Auto power cap ----------
  //
  // An in-app watcher: every `intervalSec` it asks whether the machine is busy
  // and puts the idle or the running cap on each configured GPU. What it should
  // do is saved per machine with ctx.hostDataSet, so reconnecting or restarting
  // the app picks it back up - the caps themselves live on the GPU either way,
  // and a watcher that forgot them would leave the last one it set in place.

  getAutoCapStatus(): AutoCapStatus {
    const gpus: AutoCapGpuStatus[] = []
    for (const [key, entry] of Object.entries(this.cfg.gpus)) {
      const index = Number(key)
      gpus.push({
        index,
        name: this.gpuAt(index)?.name ?? `GPU ${index}`,
        idleCap: entry.idleCap,
        runningCap: entry.runningCap,
        appliedCap: this.applied.get(index) ?? null,
        busy: this.busy.has(index) ? this.busy.get(index)! : null
      })
    }
    gpus.sort((a, b) => a.index - b.index)
    return {
      enabled: this.cfg.enabled,
      intervalSec: this.cfg.intervalSec,
      trigger: this.cfg.trigger,
      gpus,
      log: [...this.autoCapLines]
    }
  }

  /**
   * Bring the watcher in line with what is saved for the machine that is
   * connected now. Called from applyPollers, which is the first point after a
   * connect where ctx.hostKey names the new machine.
   */
  applyAutoCap(): void {
    const host = this.ctx.hostKey
    if (host !== this.cfgHost) {
      this.cfgHost = host
      this.cfg = readAutoCapConfig(host ? this.ctx.hostDataGet() : null)
      this.applied.clear()
      this.busy.clear()
      this.autoCapLines = []
      if (this.cfg.enabled) {
        this.note(`Auto power cap resumed for ${Object.keys(this.cfg.gpus).length} GPU(s)`)
      }
    }
    const wanted =
      this.ctx.connected && this.cfg.enabled && Object.keys(this.cfg.gpus).length > 0
        ? Math.max(2, this.cfg.intervalSec) * 1000
        : 0
    // applyPollers runs on every settings and tab change, and start() ticks
    // straight away - so only touch the poller when something actually moved.
    if (wanted !== this.autoCapMs) {
      this.autoCapMs = wanted
      if (wanted > 0) this.autoCapPoller.start(wanted)
      else this.autoCapPoller.stop()
    }
    this.emitAutoCap()
  }

  /** Set both caps of one GPU and start watching it. */
  autoCapSet(index: number, idleCap: number, runningCap: number): OkResult {
    const gpu = this.gpuOrReason(index)
    if (typeof gpu === 'string') return { ok: false, error: gpu }
    const idle = this.checkWatts(gpu, idleCap, 'The idle cap')
    if (typeof idle === 'string') return { ok: false, error: idle }
    const running = this.checkWatts(gpu, runningCap, 'The running cap')
    if (typeof running === 'string') return { ok: false, error: running }
    this.cfg.gpus[String(index)] = { idleCap: idle, runningCap: running }
    this.cfg.enabled = true
    this.applied.delete(index)
    this.note(`GPU ${index} (${gpu.name}): idle ${idle} W, running ${running} W`)
    this.saveAutoCap()
    return { ok: true, data: `Watching GPU ${index}` }
  }

  /** Stop watching one GPU. Whatever cap it has now stays on it. */
  autoCapClear(index: number): OkResult {
    if (!this.cfg.gpus[String(index)]) {
      return { ok: false, error: `GPU ${index} is not being watched` }
    }
    delete this.cfg.gpus[String(index)]
    this.applied.delete(index)
    this.busy.delete(index)
    if (Object.keys(this.cfg.gpus).length === 0) this.cfg.enabled = false
    this.note(`GPU ${index} is no longer watched`)
    this.saveAutoCap()
    return { ok: true, data: `GPU ${index} released` }
  }

  autoCapConfigure(intervalSec: number, trigger: string): OkResult {
    const seconds = Math.round(Number(intervalSec))
    if (!Number.isFinite(seconds) || seconds < 2 || seconds > 3600) {
      return { ok: false, error: 'The check interval has to be between 2 and 3600 seconds' }
    }
    if (trigger !== 'docker' && trigger !== 'gpu') {
      return { ok: false, error: 'The trigger has to be "docker" or "gpu"' }
    }
    this.cfg.intervalSec = seconds
    this.cfg.trigger = trigger as AutoCapTrigger
    this.note(`Checking every ${seconds}s, busy means ${trigger === 'docker' ? 'a running container' : 'a compute process on that GPU'}`)
    this.saveAutoCap()
    return { ok: true, data: 'Saved' }
  }

  /** Watch again, with the caps that are already saved. */
  autoCapStart(): OkResult {
    if (Object.keys(this.cfg.gpus).length === 0) {
      return { ok: false, error: 'No GPU has caps set yet - set them on a GPU below first' }
    }
    this.cfg.enabled = true
    this.note('Auto power cap enabled')
    this.saveAutoCap()
    return { ok: true, data: 'Watching' }
  }

  /**
   * Re-send what the watcher has already said, for a page that was just opened:
   * a `log` block starts empty and only shows what arrives while it is mounted.
   */
  autoCapLogTail(): OkResult {
    if (this.autoCapLines.length) this.ctx.emit('autocaplog', this.autoCapLines.join('\n'))
    return { ok: true }
  }

  /** Stop watching every GPU, keeping the caps for next time. */
  autoCapStop(): OkResult {
    this.cfg.enabled = false
    this.applied.clear()
    this.busy.clear()
    this.note('Auto power cap disabled - the caps now on the GPUs stay as they are')
    this.saveAutoCap()
    return { ok: true, data: 'Stopped' }
  }

  /** Persist and re-evaluate in one step; every change above ends here. */
  private saveAutoCap(): void {
    if (this.ctx.hostKey) this.ctx.hostDataSet(this.cfg)
    // A change to the interval or to `enabled` has to reach the poller, and the
    // page reads the result off the stream.
    const wanted =
      this.ctx.connected && this.cfg.enabled && Object.keys(this.cfg.gpus).length > 0
        ? Math.max(2, this.cfg.intervalSec) * 1000
        : 0
    this.autoCapMs = wanted
    if (wanted > 0) this.autoCapPoller.start(wanted)
    else this.autoCapPoller.stop()
    this.emitAutoCap()
  }

  /** Stop the timer without saying anything about the saved config. */
  private stopWatcher(): void {
    this.autoCapMs = 0
    this.autoCapPoller.stop()
  }

  private emitAutoCap(): void {
    this.ctx.emit('autocap', this.getAutoCapStatus())
  }

  private note(msg: string): void {
    this.autoCapLines.push(`${new Date().toLocaleTimeString()} - ${msg}`)
    if (this.autoCapLines.length > 200) {
      this.autoCapLines.splice(0, this.autoCapLines.length - 200)
    }
    // The page tails this as a log block, so a line has to be pushed as well as
    // kept - the status alone would only show the last one after a reconnect.
    this.ctx.emit('autocaplog', this.autoCapLines[this.autoCapLines.length - 1])
  }

  /** Which of these GPUs currently count as busy. */
  private async readBusy(indexes: number[]): Promise<Map<number, boolean>> {
    const out = new Map<number, boolean>(indexes.map((i) => [i, false]))
    if (this.cfg.trigger === 'docker') {
      // Any running container, which is what the machine being "in use" means
      // for a box that exists to run them. The Docker daemon is enough; the
      // Container module does not have to be installed.
      const ps = await this.ctx.exec('docker ps -q 2>/dev/null | head -c 1', { timeoutMs: 10000 })
      const anyRunning = ps.stdout.trim().length > 0
      for (const index of indexes) out.set(index, anyRunning)
      return out
    }
    // Per GPU: a compute process holding that card. Asked here rather than read
    // off the last snapshot, because the metrics poller can be paused.
    const res = await this.ctx.exec(
      `nvidia-smi --query-compute-apps=gpu_uuid --format=csv,noheader 2>/dev/null; ` +
        `echo '===UUID==='; nvidia-smi --query-gpu=index,gpu_uuid --format=csv,noheader 2>/dev/null`,
      { timeoutMs: 15000 }
    )
    const [procs = '', uuids = ''] = res.stdout.split('===UUID===')
    const byUuid = new Map<string, number>()
    for (const line of uuids.trim().split('\n')) {
      const f = line.split(',').map((s) => s.trim())
      if (f.length >= 2) byUuid.set(f[1], num(f[0]))
    }
    for (const line of procs.trim().split('\n')) {
      const index = byUuid.get(line.trim())
      if (index !== undefined && out.has(index)) out.set(index, true)
    }
    return out
  }

  private async autoCapTick(): Promise<void> {
    if (!this.ctx.connected || !this.cfg.enabled) return
    const indexes = Object.keys(this.cfg.gpus).map(Number)
    if (indexes.length === 0) return
    const busy = await this.readBusy(indexes)
    let changed = false
    for (const index of indexes) {
      const entry = this.cfg.gpus[String(index)]
      if (!entry) continue
      const isBusy = busy.get(index) === true
      if (this.busy.get(index) !== isBusy) {
        this.busy.set(index, isBusy)
        changed = true
      }
      const target = isBusy ? entry.runningCap : entry.idleCap
      if (this.applied.get(index) === target) continue
      const res = await this.applyPowerLimit(index, target)
      changed = true
      if (res.ok) {
        this.applied.set(index, target)
        this.note(`GPU ${index} capped at ${target} W (${isBusy ? 'busy' : 'idle'})`)
      } else {
        this.note(`GPU ${index}: could not set ${target} W: ${res.error}`)
      }
    }
    // A tick that found nothing new says nothing: this runs every few seconds
    // and the page is showing the same numbers it already has.
    if (changed) this.emitAutoCap()
  }
}
