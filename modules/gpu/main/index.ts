import type { ModuleActivate } from '@shared/modules'
import { GpuService } from './service'

/**
 * Main-process half of the GPU module: one fast poller for the metrics, plus
 * the nvidia-smi controls the page calls. Every control needs root, so they go
 * through ctx.execSudo and report the reason back when they fail.
 */
const activate: ModuleActivate = (ctx) => {
  const service = new GpuService(ctx)

  ctx.handle('setPowerLimit', (index: number, watts: number) =>
    service.setPowerLimit(index, watts)
  )
  ctx.handle('setPersistence', (index: number, enabled: boolean) =>
    service.setPersistence(index, enabled)
  )
  ctx.handle('lockClocks', (index: number, min: number, max: number) =>
    service.lockClocks(index, min, max)
  )
  ctx.handle('resetClocks', (index: number) => service.resetClocks(index))
  ctx.handle('autoCapStatus', () => service.getAutoCapStatus())
  // Positional rather than a single config object - a declarative `form`
  // block (T3.5) submits one value per field, not a pre-built object.
  ctx.handle(
    'autoCapStart',
    (gpuIndex: number, idleCap: number, runningCap: number, intervalSec: number) =>
      service.startAutoCap({ gpuIndex, idleCap, runningCap, intervalSec })
  )
  ctx.handle('autoCapStop', () => service.stopAutoCap())
  // Killing a compute process is done here rather than through the Processes
  // module, so this module works on its own whether that one is installed.
  ctx.handle('killProcess', (pid: number) => service.killProcess(pid))

  return {
    applyPollers() {
      const interval = ctx.fastIntervalMs('gpu')
      if (ctx.connected && interval > 0) service.poller.start(interval)
      else service.poller.stop()
    },
    reset() {
      service.reset()
    },
    snapshots() {
      // Same flattening as the live `series` event (see service.ts), so a
      // freshly connected renderer's chart is not empty for the first tick.
      const series = service.history
        .map((s) => {
          const g = s.gpus[0]
          return g
            ? {
                t: s.t,
                util: g.utilization,
                vram: g.memUsedMiB,
                vramTotal: g.memTotalMiB,
                temp: g.temp,
                draw: g.powerDraw,
                limit: g.powerLimit
              }
            : null
        })
        .filter((p): p is NonNullable<typeof p> => p != null)
      return { snapshot: service.history, series, autocap: service.getAutoCapStatus() }
    },
    dispose() {
      service.dispose()
    }
  }
}

export default activate
