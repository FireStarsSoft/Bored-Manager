import type { FsDetail, StorageSnapshot } from '@shared/types'
import type { ModuleContext, ModulePoller } from '@shared/modules'
import { splitSections } from '@shared/shell'
import { DF_CMD, parseFilesystems } from './df'
import { LSBLK_CMD, parseLsblk } from './lsblk'

/**
 * Storage layout: mount usage, inodes and the block device tree. All of it
 * moves on the scale of minutes, so it runs on its own interval instead of
 * the disk tick - which keeps read/write rates cheap to sample often.
 */
export class StorageService {
  latest: StorageSnapshot | null = null
  readonly poller: ModulePoller

  constructor(private ctx: ModuleContext) {
    this.poller = ctx.createPoller('storage', () => this.sample())
  }

  reset(): void {
    this.latest = null
  }

  dispose(): void {
    this.poller.stop()
  }

  /** Run one tick right now (manual refresh button). */
  async refreshNow(): Promise<StorageSnapshot | null> {
    await this.sample()
    return this.latest
  }

  private async sample(): Promise<void> {
    if (!this.ctx.connected) return
    const cmd = [
      `echo '===DF==='; ${DF_CMD}`,
      `echo '===DFI==='; df -iP 2>/dev/null || true`,
      `echo '===LSBLK==='; ${LSBLK_CMD}`
    ].join('; ')
    const res = await this.ctx.exec(cmd, { timeoutMs: 20000 })
    if (res.code !== 0 && !res.stdout) return
    const sec = splitSections(res.stdout)

    const byMount = new Map<string, FsDetail>()
    for (const f of parseFilesystems(sec.get('DF') ?? '')) {
      byMount.set(f.mount, { ...f, inodesTotal: 0, inodesUsed: 0, inodesPct: 0 })
    }
    for (const line of (sec.get('DFI') ?? '').split('\n').slice(1)) {
      const f = line.trim().split(/\s+/)
      if (f.length < 6) continue
      const fs = byMount.get(f.slice(5).join(' '))
      if (!fs) continue
      fs.inodesTotal = parseInt(f[1], 10) || 0
      fs.inodesUsed = parseInt(f[2], 10) || 0
      fs.inodesPct = parseInt(f[4], 10) || 0
    }
    const filesystems = [...byMount.values()].sort((a, b) => a.mount.localeCompare(b.mount))

    const snap: StorageSnapshot = {
      t: Date.now(),
      filesystems,
      devices: parseLsblk(sec.get('LSBLK') ?? '')
    }
    this.latest = snap
    this.ctx.emit('storage', snap)
  }
}
