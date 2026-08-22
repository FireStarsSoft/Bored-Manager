import type { ModuleActivate } from '@shared/modules'
import { createTtlCache } from '@shared/cache'
import { NetworkService } from './service'
import { NetTunablesService, type NetTunables } from './tunables'

/**
 * Main-process half of the Network module. One poller, but two speeds inside
 * it: the byte counters and sockets are read every tick, the interface
 * inventory (addresses, MTU, link speed, gateway, DNS) only when the cached
 * copy is older than the slow interval - both in the same shell roundtrip.
 *
 * The collector is heavy (an `ss` dump of every socket), so it follows the
 * "network" detail-polling setting: by default it only runs while the page is
 * open, and set to Always it keeps per-process session totals accurate.
 */
const activate: ModuleActivate = (ctx) => {
  const service = new NetworkService(ctx)
  const tunables = new NetTunablesService(ctx)
  const tunablesReads = createTtlCache<NetTunables>(() =>
    Math.max(1_000, ctx.fastIntervalMs('network') / 2)
  )

  // Killing the owner of a connection is done here rather than through the
  // Processes module, so this page works whether that one is installed.
  ctx.handle('killProcess', async (pid: number) => {
    if (!Number.isInteger(pid) || pid <= 1) return { ok: false, error: 'invalid pid' }
    const cmd = `kill -TERM ${pid}`
    const res = ctx.hasSudo ? await ctx.execSudo(cmd) : await ctx.exec(cmd)
    return res.code === 0
      ? { ok: true }
      : { ok: false, error: (res.stderr || res.stdout).trim() || `exit code ${res.code}` }
  })

  // The Host tuning page. Read on demand rather than polled: these values only
  // move when something changes them, and reading them costs a shell round trip.
  ctx.handle('netTunables', () => tunablesReads.get('host', () => tunables.read()))
  ctx.handle('planCheck', (values: unknown) => tunables.planCheck(values))
  ctx.handle('planApply', async (payload: unknown) => {
    const result = await tunables.planApply(payload)
    if (result.ok) tunablesReads.clear()
    return result
  })
  ctx.handle('tunablesCheck', (values: unknown) => tunables.tunablesCheck(values))
  ctx.handle('tunablesApply', async (payload: unknown) => {
    const result = await tunables.tunablesApply(payload)
    if (result.ok) tunablesReads.clear()
    return result
  })
  ctx.handle('rulesEffective', () => tunables.rulesEffective())
  ctx.handle('rulesCheck', (values: unknown) => tunables.rulesCheck(values))
  ctx.handle('rulesApply', (payload: unknown) => tunables.rulesApply(payload))
  ctx.handle('rulesReset', () => tunables.rulesReset())

  return {
    applyPollers() {
      service.configure(ctx.slowIntervalSec('network'))
      const mode = ctx.detailMode('network')
      const wanted = mode === 'always' || (mode === 'tab' && ctx.tabActive)
      const interval = ctx.fastIntervalMs('network')
      if (ctx.connected && wanted && interval > 0) service.poller.start(interval)
      else service.poller.stop()
    },
    reset() {
      service.reset()
    },
    snapshots() {
      return { snapshot: service.latest, series: service.history }
    },
    dispose() {
      service.dispose()
    }
  }
}

export default activate
