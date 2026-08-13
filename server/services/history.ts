import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs'
import { createReadStream } from 'fs'
import { createInterface } from 'readline'
import { join } from 'path'
import type {
  HistoryPoint,
  HistorySettings,
  HistoryStats,
  HistoryStream,
  SystemSnapshot
} from '@shared/types'
import {
  DEFAULT_SETTINGS,
  HISTORY_FLUSH_MS,
  HISTORY_RING_MS,
  SYSTEM_HISTORY_STREAM
} from '@shared/types'
import { registry } from '../session-registry'
import { dataDir } from './store'

/** UTC hour bucket: one file per stream per hour, sorts chronologically. */
function hourKey(t: number): string {
  const d = new Date(t)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}`
}

function hourKeyToMs(key: string): number {
  return Date.UTC(
    Number(key.slice(0, 4)),
    Number(key.slice(4, 6)) - 1,
    Number(key.slice(6, 8)),
    Number(key.slice(8, 10))
  )
}

/**
 * Stream names are not a fixed list any more (a module brings its own), so the
 * file pattern accepts any name a module id can produce.
 */
const FILE_RE = /^([a-z][a-z0-9-]*)-(\d{10})\.jsonl$/

/** Filesystem-safe id for the machine the samples came from. */
export function hostKeyFor(mode: string, host?: string, username?: string): string {
  const raw = mode === 'local' ? 'local' : `${username ?? 'user'}@${host ?? 'host'}`
  return raw.replace(/[^a-zA-Z0-9._@-]/g, '_')
}

/**
 * Long-term metrics history.
 *
 * Samples arrive on every poll tick but are NOT written straight away: they
 * land in a RAM ring (30 minutes, so most chart windows never touch the disk)
 * and in a pending buffer that is appended to disk in one batch every five
 * minutes - plus on quit, disconnect and before purging. That keeps disk
 * writes to a few hundred KB every five minutes instead of a constant
 * trickle, at the cost of losing at most one batch in a hard crash.
 */
export class MetricsHistoryService {
  private settings: HistorySettings = DEFAULT_SETTINGS.history
  private hostKey: string | null = null
  private ring = new Map<HistoryStream, HistoryPoint[]>()
  private pending = new Map<HistoryStream, HistoryPoint[]>()
  private timer: NodeJS.Timeout | null = null
  private registryId: string | null = null
  private lastFlush: number | null = null

  configure(settings: HistorySettings): void {
    const wasEnabled = this.settings.enabled
    this.settings = settings
    if (wasEnabled && !settings.enabled) {
      this.flush()
      this.pending.clear()
    }
    if (settings.enabled && this.hostKey) this.startTimer()
    else this.stopTimer()
    if (settings.enabled) this.enforceLimits()
  }

  /** Called on connect (host) and disconnect (null); flushes what is pending. */
  setHost(hostKey: string | null): void {
    if (hostKey === this.hostKey) return
    this.flush()
    this.hostKey = hostKey
    this.ring.clear()
    this.pending.clear()
    if (hostKey && this.settings.enabled) this.startTimer()
    else this.stopTimer()
  }

  private startTimer(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.flush(), HISTORY_FLUSH_MS)
    this.registryId = registry.register('metrics-history', () => this.stopTimer())
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.registryId) {
      registry.unregister(this.registryId)
      this.registryId = null
    }
  }

  // ---------- Ingest ----------

  /**
   * Record one reduced sample. Modules call this through their context with
   * their own stream name; the app only writes the `system` stream itself.
   */
  add(stream: HistoryStream, point: HistoryPoint): void {
    if (!this.hostKey || !this.settings.enabled) return
    const ring = this.ring.get(stream) ?? []
    ring.push(point)
    const cutoff = point.t - HISTORY_RING_MS
    let drop = 0
    while (drop < ring.length && ring[drop].t < cutoff) drop++
    this.ring.set(stream, drop > 0 ? ring.slice(drop) : ring)
    const pending = this.pending.get(stream) ?? []
    pending.push(point)
    this.pending.set(stream, pending)
  }

  addSystem(s: SystemSnapshot): void {
    this.add(SYSTEM_HISTORY_STREAM, {
      t: s.t,
      cpu: round(s.cpu.total, 2),
      memUsed: s.mem.used,
      memTotal: s.mem.total,
      netRx: Math.round(s.netRx),
      netTx: Math.round(s.netTx),
      diskRead: Math.round(s.diskRead),
      diskWrite: Math.round(s.diskWrite),
      load1: round(s.load[0], 2)
    })
  }

  // ---------- Disk ----------

  dir(): string {
    return join(dataDir(), 'metrics')
  }

  private hostDir(hostKey = this.hostKey): string | null {
    return hostKey ? join(this.dir(), hostKey) : null
  }

  /** Path the next flush of `stream` will append to. */
  currentFile(stream: HistoryStream = SYSTEM_HISTORY_STREAM): string | null {
    const dir = this.hostDir()
    return dir ? join(dir, `${stream}-${hourKey(Date.now())}.jsonl`) : null
  }

  get pendingCount(): number {
    let n = 0
    for (const pts of this.pending.values()) n += pts.length
    return n
  }

  get lastFlushMs(): number | null {
    return this.lastFlush
  }

  /**
   * Write everything buffered so far. Synchronous on purpose: this also runs
   * while the app is quitting, where an async write would be cut short.
   */
  flush(): void {
    const dir = this.hostDir()
    if (!dir || !this.settings.enabled || this.pendingCount === 0) {
      this.pending.clear()
      return
    }
    try {
      mkdirSync(dir, { recursive: true })
      // One append per (stream, hour) file, not per sample.
      const byFile = new Map<string, string[]>()
      for (const [stream, points] of this.pending) {
        for (const p of points) {
          const file = join(dir, `${stream}-${hourKey(p.t)}.jsonl`)
          const lines = byFile.get(file) ?? []
          lines.push(JSON.stringify(p))
          byFile.set(file, lines)
        }
      }
      for (const [file, lines] of byFile) appendFileSync(file, lines.join('\n') + '\n', 'utf8')
      this.lastFlush = Date.now()
    } catch {
      /* never let logging break metrics collection */
    }
    this.pending.clear()
    this.enforceLimits()
  }

  /** Drop hour buckets that are too old or push the folder over its cap. */
  private enforceLimits(): void {
    const root = this.dir()
    if (!existsSync(root)) return
    try {
      interface Entry {
        path: string
        bucket: number
        bytes: number
      }
      const entries: Entry[] = []
      let total = 0
      for (const host of readdirSync(root, { withFileTypes: true })) {
        if (!host.isDirectory()) continue
        const hostPath = join(root, host.name)
        for (const name of readdirSync(hostPath)) {
          const m = FILE_RE.exec(name)
          if (!m) continue
          const path = join(hostPath, name)
          const bytes = statSync(path).size
          total += bytes
          entries.push({ path, bucket: hourKeyToMs(m[2]), bytes })
        }
      }
      const cutoff = Date.now() - this.settings.retentionHours * 3600_000
      const survivors: Entry[] = []
      for (const e of entries) {
        // The bucket covers one hour, so keep it until its end is out of range.
        if (e.bucket + 3600_000 < cutoff) {
          rmSync(e.path, { force: true })
          total -= e.bytes
        } else {
          survivors.push(e)
        }
      }
      const cap = Math.max(1, this.settings.maxStorageMB) * 1024 * 1024
      survivors.sort((a, b) => a.bucket - b.bucket)
      for (const e of survivors) {
        if (total <= cap) break
        rmSync(e.path, { force: true })
        total -= e.bytes
      }
    } catch {
      /* a rotation failure must not stop collection */
    }
  }

  /** Delete every stored sample (RAM buffers included). */
  purge(): void {
    this.pending.clear()
    this.ring.clear()
    try {
      rmSync(this.dir(), { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    this.lastFlush = null
  }

  stats(): HistoryStats {
    const root = this.dir()
    const hosts: HistoryStats['hosts'] = []
    let fileCount = 0
    let totalBytes = 0
    let oldest: number | null = null
    let newest: number | null = null
    try {
      for (const host of readdirSync(root, { withFileTypes: true })) {
        if (!host.isDirectory()) continue
        let files = 0
        let bytes = 0
        for (const name of readdirSync(join(root, host.name))) {
          const m = FILE_RE.exec(name)
          if (!m) continue
          const size = statSync(join(root, host.name, name)).size
          files++
          bytes += size
          const start = hourKeyToMs(m[2])
          if (oldest == null || start < oldest) oldest = start
          if (newest == null || start + 3600_000 > newest) newest = start + 3600_000
        }
        if (files > 0) hosts.push({ hostKey: host.name, files, bytes })
        fileCount += files
        totalBytes += bytes
      }
    } catch {
      /* nothing written yet */
    }
    // Newest can only be as recent as the last sample we actually hold.
    const latestSample = Math.max(0, ...[...this.ring.values()].map((p) => p.at(-1)?.t ?? 0))
    if (latestSample > 0) newest = Math.max(newest ?? 0, latestSample)
    return {
      enabled: this.settings.enabled,
      dir: root,
      hostKey: this.hostKey,
      currentFile: this.currentFile(),
      fileCount,
      totalBytes,
      oldestMs: oldest,
      newestMs: newest,
      lastFlushMs: this.lastFlush,
      pendingPoints: this.pendingCount,
      flushIntervalSec: HISTORY_FLUSH_MS / 1000,
      hosts: hosts.sort((a, b) => b.bytes - a.bytes)
    }
  }

  // ---------- Query ----------

  /**
   * Samples for a time range, downsampled to at most `maxPoints`. The RAM
   * ring answers short windows on its own; older data is streamed off disk
   * line by line so a 24h query never loads a whole file into memory.
   */
  async query(
    stream: HistoryStream,
    fromMs: number,
    toMs: number,
    maxPoints = 600
  ): Promise<HistoryPoint[]> {
    const ring = this.ring.get(stream) ?? []
    const ringStart = ring.length ? ring[0].t : Infinity
    const points: HistoryPoint[] = []
    if (fromMs < ringStart) {
      points.push(...(await this.readFiles(stream, fromMs, Math.min(toMs, ringStart))))
    }
    for (const p of ring) {
      if (p.t >= fromMs && p.t <= toMs) points.push(p)
    }
    points.sort((a, b) => a.t - b.t)
    const deduped: HistoryPoint[] = []
    for (const p of points) {
      if (deduped.length && deduped[deduped.length - 1].t === p.t) continue
      deduped.push(p)
    }
    return downsample(deduped, maxPoints)
  }

  private async readFiles(
    stream: HistoryStream,
    fromMs: number,
    toMs: number
  ): Promise<HistoryPoint[]> {
    const dir = this.hostDir()
    if (!dir || !existsSync(dir)) return []
    const out: HistoryPoint[] = []
    const start = Math.floor(fromMs / 3600_000) * 3600_000
    for (let bucket = start; bucket <= toMs; bucket += 3600_000) {
      const file = join(dir, `${stream}-${hourKey(bucket)}.jsonl`)
      if (!existsSync(file)) continue
      await new Promise<void>((resolve) => {
        const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })
        rl.on('line', (line) => {
          if (!line) return
          try {
            const p = JSON.parse(line) as HistoryPoint
            if (p.t >= fromMs && p.t <= toMs) out.push(p)
          } catch {
            /* a truncated last line after a crash is expected */
          }
        })
        rl.on('close', () => resolve())
        rl.on('error', () => resolve())
      })
    }
    return out
  }
}

function round(v: number, digits: number): number {
  const f = 10 ** digits
  return Math.round((Number.isFinite(v) ? v : 0) * f) / f
}

/** Round a value the way a reduced history sample stores it. */
export function roundSample(v: number, digits = 2): number {
  return round(v, digits)
}

/** Average samples into at most `maxPoints` evenly spaced buckets. */
function downsample(points: HistoryPoint[], maxPoints: number): HistoryPoint[] {
  if (points.length <= maxPoints || maxPoints <= 0) return points
  const span = points[points.length - 1].t - points[0].t
  if (span <= 0) return points.slice(-maxPoints)
  const bucketMs = span / maxPoints
  const out: HistoryPoint[] = []
  let bucket: HistoryPoint[] = []
  let bucketEnd = points[0].t + bucketMs
  const flush = (): void => {
    if (!bucket.length) return
    const avg: HistoryPoint = { t: bucket[bucket.length - 1].t }
    for (const key of Object.keys(bucket[0])) {
      if (key === 't') continue
      let sum = 0
      for (const p of bucket) sum += p[key] ?? 0
      avg[key] = round(sum / bucket.length, 2)
    }
    out.push(avg)
    bucket = []
  }
  for (const p of points) {
    if (p.t > bucketEnd) {
      flush()
      bucketEnd = p.t + bucketMs
    }
    bucket.push(p)
  }
  flush()
  return out
}
