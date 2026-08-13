import type { SensorsSnapshot } from '@shared/types'
import type { ModuleContext, ModulePoller } from '@shared/modules'
import { splitSections } from '@shared/shell'
import { HWMON_CMD, SENSORS_CMD, parseSensors } from './probe'

const HISTORY_MS = 5 * 60 * 1000

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
  }
}
