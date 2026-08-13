import type { ModuleActivate } from '@shared/modules'
import { DockerService, toSeriesPoint } from './service'

/** The slow section this module owns, as named in settings.slowRefresh. */
const STORAGE_TARGET = 'docker'

type ContainerAction = 'start' | 'stop' | 'restart' | 'rm' | 'kill' | 'pause' | 'unpause'

/**
 * Main-process half of the Docker module. A fast poller for containers and
 * their stats, a slow one for `docker system df`, and one handler per action
 * the page offers. Listings and inspect are pulled on demand, never polled.
 */
const activate: ModuleActivate = (ctx) => {
  const service = new DockerService(ctx)

  ctx.handle('images', () => service.listImages())
  ctx.handle('volumes', () => service.listVolumes())
  ctx.handle('networks', () => service.listNetworks())
  ctx.handle('inspect', (id: string) => service.inspect(id))
  ctx.handle('containerAction', (id: string, action: ContainerAction) =>
    service.containerAction(id, action)
  )
  ctx.handle('removeImage', (id: string, force: boolean) => service.removeImage(id, force))
  ctx.handle('pruneImages', (all: boolean) => service.pruneImages(all))
  ctx.handle('removeVolume', (name: string) => service.removeVolume(name))
  ctx.handle('pruneVolumes', () => service.pruneVolumes())
  ctx.handle('removeNetwork', (id: string) => service.removeNetwork(id))
  ctx.handle('pruneNetworks', () => service.pruneNetworks())
  ctx.handle('logsStart', (id: string) => service.startLogs(id))
  ctx.handle('logsStop', (id: string) => service.stopLogs(id))

  /** See the same guard in the Disk module: df must not re-run on every change. */
  let appliedSlow: string | null = null

  return {
    applyPollers() {
      const fast = ctx.fastIntervalMs('docker')
      if (ctx.connected && fast > 0) service.poller.start(fast)
      else service.poller.stop()

      const slowSec = Math.max(0, ctx.slowIntervalSec(STORAGE_TARGET))
      const key = `${ctx.connected}|${slowSec}`
      if (key === appliedSlow) return
      appliedSlow = key
      service.slowPoller.stop()
      if (!ctx.connected) return
      if (slowSec > 0) service.slowPoller.start(slowSec * 1000)
      else if (!service.slowLatest) void service.refreshSlowNow()
    },
    reset() {
      appliedSlow = null
      service.reset()
    },
    snapshots() {
      // `snapshot` is 'latest' (the current listing), `series` is 'series'
      // (the last 5 minutes of it, flattened) - see the comment in service.ts.
      return {
        snapshot: service.history.at(-1) ?? null,
        series: service.history.map(toSeriesPoint),
        storage: service.slowLatest
      }
    },
    slowTargets() {
      return [STORAGE_TARGET]
    },
    async refreshSlow() {
      await service.refreshSlowNow()
    },
    dispose() {
      service.dispose()
    }
  }
}

export default activate
