import type { ModuleActivate } from '@shared/modules'
import { SensorsService, seriesFromHistory } from './service'

/**
 * Main-process half of the Sensors module: one fast poller, no actions. The
 * app calls applyPollers again on every settings, connection and visible
 * surface change, so simply re-deriving the desired state here is enough.
 */
const activate: ModuleActivate = (ctx) => {
  const service = new SensorsService(ctx)

  return {
    applyPollers() {
      const interval = ctx.fastIntervalMs('sensors')
      const mode = ctx.detailMode('sensors')
      const wanted = mode === 'always' || (mode === 'tab' && ctx.tabActive)
      if (ctx.connected && wanted && interval > 0) service.poller.start(interval)
      else service.poller.stop()
    },
    reset() {
      service.reset()
    },
    snapshots() {
      // `snapshot` is 'latest' (one object). Seeding the history array here
      // used to push the whole ring into latest and blank the list until the
      // next tick. Each kind's series is derived from that same ring.
      return { snapshot: service.latest, ...seriesFromHistory(service.history) }
    },
    dispose() {
      service.dispose()
    }
  }
}

export default activate
