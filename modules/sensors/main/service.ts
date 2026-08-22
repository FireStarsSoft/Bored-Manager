import type { SensorKind, SensorsSnapshot } from '@shared/types'
import type { ModuleContext, ModulePoller } from '@shared/modules'
import { splitSections } from '@shared/shell'
import { HWMON_CMD, SENSORS_CMD, parseSensors } from './probe'

const HISTORY_MS = 5 * 60 * 1000

/** Enough distinct colours in BLOCK_PALETTE; more lines make the legend unreadable. */
export const MAX_KIND_SERIES = 8

/** Stream event per reading kind — one chart, one unit. */
export const SERIES_EVENTS = {
  temp: 'temps',
  fan: 'fans',
  voltage: 'voltages',
  power: 'power',
  current: 'current'
} as const satisfies Record<SensorKind, string>

export type SensorSeriesEvent = (typeof SERIES_EVENTS)[SensorKind]

/** Flat point a `chart` block can plot: timestamp plus one numeric key per sensor label. */
export type SensorSeriesPoint = { t: number; [label: string]: number }

const KINDS = Object.keys(SERIES_EVENTS) as SensorKind[]

/**
 * Pivot one snapshot into a chart point for a single kind. Labels are already
 * uniqued by the probe. `"t"` is reserved for the timestamp, so a sensor
 * that somehow used that label is dropped rather than clobbering the axis.
 */
export function toKindPoint(
  snap: SensorsSnapshot,
  kind: SensorKind,
  limit = MAX_KIND_SERIES
): SensorSeriesPoint | null {
  const rows = snap.sensors.filter((s) => s.kind === kind).slice(0, limit)
  if (!rows.length) return null
  const point: SensorSeriesPoint = { t: snap.t }
  for (const s of rows) {
    if (s.label === 't') continue
    point[s.label] = s.value
  }
  return Object.keys(point).length > 1 ? point : null
}

/** Rebuild the 5-minute series rings from the snapshot history, for renderer seed. */
export function seriesFromHistory(history: SensorsSnapshot[]): Record<SensorSeriesEvent, SensorSeriesPoint[]> {
  const out: Record<SensorSeriesEvent, SensorSeriesPoint[]> = {
    temps: [],
    fans: [],
    voltages: [],
    power: [],
    current: []
  }
  for (const snap of history) {
    for (const kind of KINDS) {
      const point = toKindPoint(snap, kind)
      if (point) out[SERIES_EVENTS[kind]].push(point)
    }
  }
  return out
}

/**
 * Temperatures, fans, voltages, power and current. A fan spinning up or a
 * core spiking to 90 °C is a live event, so this reads at the same cadence
 * as CPU or memory rather than on a minutes-long interval.
 */
export class SensorsService {
  history: SensorsSnapshot[] = []
  latest: SensorsSnapshot | null = null
  readonly poller: ModulePoller

  constructor(private ctx: ModuleContext) {
    this.poller = ctx.createPoller('sensors', () => this.sample())
  }

  reset(): void {
    this.history = []
    this.latest = null
  }

  dispose(): void {
    this.poller.stop()
  }

  private emitKindSeries(snap: SensorsSnapshot): void {
    for (const kind of KINDS) {
      const point = toKindPoint(snap, kind)
      if (point) this.ctx.emit(SERIES_EVENTS[kind], point)
    }
  }

  private async sample(): Promise<void> {
    if (!this.ctx.connected) return
    // One shell: HWMON_CMD only runs when `sensors` produced nothing.
    const cmd = `echo '===SENSORS==='; ${SENSORS_CMD}; echo '===HWMON==='; ${HWMON_CMD}`
    const res = await this.ctx.exec(cmd, { timeoutMs: 15000 })
    if (res.code !== 0 && !res.stdout) return
    const sec = splitSections(res.stdout)
    const snap: SensorsSnapshot = {
      t: Date.now(),
      sensors: parseSensors(sec.get('SENSORS') ?? '', sec.get('HWMON') ?? '')
    }
    this.latest = snap
    this.history.push(snap)
    const cutoff = snap.t - HISTORY_MS
    while (this.history.length && this.history[0].t < cutoff) this.history.shift()
    this.ctx.emit('snapshot', snap)
    this.emitKindSeries(snap)
  }
}
