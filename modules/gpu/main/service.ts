import type { AutoCapConfig, AutoCapStatus, GpuInfo, GpuProcess, GpuSnapshot, OkResult } from '@shared/types'
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
  'fan.speed',
  'clocks.sm',
  'clocks.mem',
  'persistence_mode',
  'driver_version'
].join(',')

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
  private autoCap: AutoCapStatus = {
    enabled: false,
    gpuIndex: 0,
    idleCap: 600,
    runningCap: 450,
    intervalSec: 10,
    currentCap: null,
    log: []
  }
  private autoCapPoller: ModulePoller

  constructor(private ctx: ModuleContext) {
    this.poller = ctx.createPoller('metrics', () => this.sample())
    this.autoCapPoller = ctx.createPoller('autocap', () => this.autoCapTick())
  }

  reset(): void {
    this.history = []
    this.stopAutoCap()
  }

  dispose(): void {
    this.poller.stop()
    this.stopAutoCap()
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
      if (f.length < 16) continue
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
        fan: num(f[11]),
        clockSm: num(f[12]),
        clockMem: num(f[13]),
        persistence: f[14].toLowerCase().includes('enabled'),
        driverVersion: f[15]
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

  setPowerLimit(index: number, watts: number): Promise<OkResult> {
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

  // ---------- Auto power cap (in-app watcher, dies with the app) ----------

  getAutoCapStatus(): AutoCapStatus {
    return { ...this.autoCap, log: [...this.autoCap.log] }
  }

  startAutoCap(cfg: AutoCapConfig): AutoCapStatus {
    this.stopAutoCap()
    this.autoCap = {
      ...cfg,
      enabled: true,
      currentCap: null,
      log: [`${new Date().toLocaleTimeString()} - Auto power cap started`]
    }
    this.autoCapPoller.start(Math.max(2, cfg.intervalSec) * 1000)
    this.ctx.emit('autocap', this.getAutoCapStatus())
    return this.getAutoCapStatus()
  }

  stopAutoCap(): AutoCapStatus {
    this.autoCapPoller.stop()
    if (this.autoCap.enabled) {
      this.autoCap.enabled = false
      this.autoCapLog('Auto power cap stopped')
    }
    this.ctx.emit('autocap', this.getAutoCapStatus())
    return this.getAutoCapStatus()
  }

  private autoCapLog(msg: string): void {
    this.autoCap.log.push(`${new Date().toLocaleTimeString()} - ${msg}`)
    if (this.autoCap.log.length > 200) this.autoCap.log.splice(0, this.autoCap.log.length - 200)
  }

  private async autoCapTick(): Promise<void> {
    if (!this.ctx.connected || !this.autoCap.enabled) return
    const ps = await this.ctx.exec('docker ps -q 2>/dev/null | head -c 1', { timeoutMs: 10000 })
    const anyRunning = ps.stdout.trim().length > 0
    const target = anyRunning ? this.autoCap.runningCap : this.autoCap.idleCap
    if (target === this.autoCap.currentCap) return
    const res = await this.setPowerLimit(this.autoCap.gpuIndex, target)
    if (res.ok) {
      this.autoCap.currentCap = target
      this.autoCapLog(
        `Set GPU ${this.autoCap.gpuIndex} power cap to ${target}W (containers ${anyRunning ? 'running' : 'idle'})`
      )
    } else {
      this.autoCapLog(`Failed to set power cap to ${target}W: ${res.error}`)
    }
    this.ctx.emit('autocap', this.getAutoCapStatus())
  }
}
