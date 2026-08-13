import type { ModuleActivate } from '@shared/modules'
import { DiskService } from './service'
import { StorageService } from './storage'

/** The slow section this module owns, as named in settings.slowRefresh. */
const STORAGE_TARGET = 'storage'

/**
 * Main-process half of the Disk module. Two pollers at very different speeds:
 * throughput and per-process I/O every second or two, and the storage layout
 * (df, inodes, lsblk) on the slow interval - the device inventory is also what
 * gives the throughput table its models and sizes.
 */
const activate: ModuleActivate = (ctx) => {
  const storage = new StorageService(ctx)
  const disk = new DiskService(ctx, () => storage.latest)

  /**
   * Restarting a poller makes it tick immediately. Fine at 1-5s, but the slow
   * poller must not re-run df and lsblk every time an unrelated setting
   * changes, so what was applied is remembered and only re-applied when it
   * actually moved.
   */
  let appliedSlow: string | null = null

  return {
    applyPollers() {
      const fast = ctx.fastIntervalMs('disk')
      const mode = ctx.detailMode('disk')
      const wantDetail = mode === 'always' || (mode === 'tab' && ctx.tabActive)
      if (ctx.connected && wantDetail && fast > 0) disk.poller.start(fast)
      else disk.poller.stop()

      const slowSec = Math.max(0, ctx.slowIntervalSec(STORAGE_TARGET))
      const key = `${ctx.connected}|${slowSec}`
      if (key === appliedSlow) return
      appliedSlow = key
      storage.poller.stop()
      if (!ctx.connected) return
      if (slowSec > 0) storage.poller.start(slowSec * 1000)
      else if (!storage.latest) {
        // "Manual only": still take one reading so the tables are never empty.
        void storage.refreshNow()
      }
    },
    reset() {
      appliedSlow = null
      disk.reset()
      storage.reset()
    },
    snapshots() {
      return { snapshot: disk.latest, series: disk.history, storage: storage.latest }
    },
    slowTargets() {
      return [STORAGE_TARGET]
    },
    async refreshSlow() {
      await storage.refreshNow()
    },
    dispose() {
      disk.dispose()
      storage.dispose()
    }
  }
}

export default activate
