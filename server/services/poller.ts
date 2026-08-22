import { log } from '../log'
import { registry } from '../session-registry'
import { tracker } from './services-tracker'

/**
 * Repeating job with a configurable interval. Guards against overlapping
 * runs (a slow tick never piles up behind the next one).
 *
 * Every state change is logged. With several browsers connected, "is anything
 * still polling the target machine?" is otherwise unanswerable: a collector
 * runs because *some* client has that tab open, and the log is what shows it.
 */
export class Poller {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private inFlight = false
  private registryId: string | null = null
  private intervalMs = 0

  constructor(
    private name: string,
    private tick: () => Promise<void>
  ) {}

  /** Whether the timer is running, so a caller can tell a leak from a tidy shutdown. */
  get active(): boolean {
    return this.running
  }

  start(intervalMs: number): void {
    // applyPollers() is deliberately called for every tab, machine and settings
    // transition. Preserve the existing timer phase when its desired state did
    // not change; restarting here would also trigger an unnecessary immediate
    // command on the target.
    if (intervalMs > 0 && this.running && this.intervalMs === intervalMs) return

    const wasRunning = this.running
    const previous = this.intervalMs
    this.clear()
    if (intervalMs <= 0) {
      if (wasRunning) log(`poller ${this.name} stopped`)
      return
    }
    this.running = true
    this.intervalMs = intervalMs
    this.registryId = registry.register(`poller:${this.name}`, () => this.stop())
    const loop = async (): Promise<void> => {
      if (!this.running || this.inFlight) return
      this.inFlight = true
      const startedAt = Date.now()
      try {
        await this.tick()
      } catch {
        /* tick errors must not kill the poller */
      } finally {
        this.inFlight = false
        tracker.noteTick(this.name, Date.now() - startedAt, this.intervalMs)
      }
    }
    void loop()
    this.timer = setInterval(() => void loop(), intervalMs)
    // Restarting with the same interval is how "nothing changed" looks from
    // here (applyPollers runs on every settings or tab change), so it is not
    // worth a line.
    if (!wasRunning) log(`poller ${this.name} started, every ${intervalMs} ms`)
    else if (previous !== intervalMs) log(`poller ${this.name} now every ${intervalMs} ms`)
  }

  stop(): void {
    const wasRunning = this.running
    this.clear()
    if (wasRunning) log(`poller ${this.name} stopped`)
  }

  private clear(): void {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.registryId) {
      registry.unregister(this.registryId)
      this.registryId = null
    }
  }
}
