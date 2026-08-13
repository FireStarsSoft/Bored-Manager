import type { ModuleActivate } from '@shared/modules'
import { splitSections } from '@shared/shell'

/**
 * Main-process half of the Hello module.
 *
 * The shape to copy: one poller that batches its probes into a single shell
 * command, a small ring of recent snapshots for a chart, a confirm-gated
 * action the page can call, and a dispose that stops everything.
 */

/** What the renderer half receives under the `snapshot` event. */
export interface HelloSnapshot {
  /** Timestamp - required for a `series` stream, which prunes by it. */
  t: number
  uptimeSec: number
  /**
   * Pre-formatted for display ("3d 4h") - a block's `format` only scales
   * numbers (bytes/rate/pct/temp/number), it cannot turn seconds into a
   * duration string itself. `uptimeSec` stays a plain number for the chart.
   */
  uptimeLabel: string
  kernel: string
  hostname: string
  loggedIn: number
}

/** How long the in-memory ring goes back, for the chart and for seeding a freshly connected renderer. */
const HISTORY_MS = 5 * 60 * 1000

/**
 * One roundtrip, four probes. `===NAME===` markers are what splitSections
 * splits on; adding a probe means adding a section, not a second exec.
 */
const PROBE = [
  `echo '===UPTIME==='; cat /proc/uptime`,
  `echo '===KERNEL==='; uname -r`,
  `echo '===HOST==='; hostname`,
  `echo '===WHO==='; who 2>/dev/null | wc -l`
].join('; ')

/** Same shape `src/lib/utils.ts`'s `formatUptime` prints - kept local since `main/` cannot import from `@/lib`. */
function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

/**
 * The `series` stream's point shape: `snapshot` is kept as 'latest' (a
 * `stat`/`keyValue` reading "now" cannot pick the last element off a
 * `series` stream itself), so a chart over time reads this instead - reused
 * for the live emit and for seeding a freshly connected renderer.
 */
function toSeriesPoint(s: HelloSnapshot): { t: number; uptime: number } {
  return { t: s.t, uptime: s.uptimeSec / 3600 }
}

const activate: ModuleActivate = (ctx) => {
  let latest: HelloSnapshot | null = null
  let history: HelloSnapshot[] = []

  const poller = ctx.createPoller('probe', async () => {
    // Every tick starts with this: applyPollers can be called while
    // disconnected, and a poller keeps its interval across a reconnect.
    if (!ctx.connected) return
    const res = await ctx.exec(PROBE, { timeoutMs: 10000 })
    if (res.code !== 0 && !res.stdout) return

    const sections = splitSections(res.stdout)
    const uptimeSec = parseFloat((sections.get('UPTIME') ?? '0').trim().split(/\s+/)[0]) || 0
    const snapshot: HelloSnapshot = {
      t: Date.now(),
      uptimeSec,
      uptimeLabel: formatUptime(uptimeSec),
      kernel: (sections.get('KERNEL') ?? '').trim(),
      hostname: (sections.get('HOST') ?? '').trim(),
      loggedIn: parseInt((sections.get('WHO') ?? '0').trim(), 10) || 0
    }
    latest = snapshot
    history.push(snapshot)
    const cutoff = snapshot.t - HISTORY_MS
    while (history.length && history[0].t < cutoff) history.shift()

    ctx.emit('snapshot', snapshot)
    ctx.emit('series', toSeriesPoint(snapshot))
    // Written to data/metrics/<host>/hello-<hour>.jsonl, so a chart longer
    // than the live buffer has something to read.
    ctx.addHistory({ t: snapshot.t, uptime: Math.round(snapshot.uptimeSec) })
  })

  // Answered over module:hello:invoke:reboot. The confirm dialog lives in the
  // block spec (ui/pages/details.json), not here - a method just does the
  // thing and reports whether it worked.
  ctx.handle('reboot', async () => {
    const res = await ctx.execSudo('systemctl reboot')
    return res.code === 0
      ? { ok: true }
      : { ok: false, error: (res.stderr || res.stdout).trim() || `exit code ${res.code}` }
  })

  return {
    /**
     * Re-derive the interval every time: this is called on connect, on
     * disconnect, on every settings change and on every tab change, so it has
     * to be safe to call repeatedly. start() replaces a running timer.
     */
    applyPollers() {
      const interval = ctx.fastIntervalMs('system')
      if (ctx.connected && interval > 0) poller.start(interval)
      else poller.stop()
    },

    /** Called on connect and disconnect: never mix data from two machines. */
    reset() {
      latest = null
      history = []
    },

    /** Fills a freshly connected renderer. Keys match the declared streams. */
    snapshots() {
      return { snapshot: latest, series: history.map(toSeriesPoint) }
    },

    /** Switching the module off has to leave nothing running on the target. */
    dispose() {
      poller.stop()
    }
  }
}

export default activate
