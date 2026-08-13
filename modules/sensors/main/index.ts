import type { ModuleActivate } from '@shared/modules'
import { SensorsService } from './service'

/**
 * Main-process half of the Sensors module: one fast poller, no actions. The
 * app calls applyPollers again on every settings change and on connect, so
 * simply re-deriving the interval here is enough - Poller.start() replaces a
 * running timer.
 */
const activate: ModuleActivate = (ctx) => {
  const service = new SensorsService(ctx)

  return {
    applyPollers() {
      const interval = ctx.fastIntervalMs('sensors')
      if (ctx.connected && interval > 0) service.poller.start(interval)
      else service.poller.stop()
    },
    reset() {
      service.reset()
    },
    snapshots() {
      return { snapshot: service.history }
    },
    dispose() {
      service.dispose()
    }
  }
}

export default activate
