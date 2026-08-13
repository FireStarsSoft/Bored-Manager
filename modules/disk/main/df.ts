import type { FsInfo } from '@shared/types'

/**
 * Mount usage from `df`. Capacity moves on the scale of minutes, so this is
 * read by the module's slow poller rather than on every tick.
 */

/** `-T` adds the fstype column; busybox and old coreutils fall back to -kP. */
export const DF_CMD = `df -kPT 2>/dev/null || df -kP 2>/dev/null`

/** Pseudo filesystems: they report sizes but hold no real storage. */
const VIRTUAL_FSTYPES = new Set([
  'autofs',
  'binfmt_misc',
  'bpf',
  'cgroup',
  'cgroup2',
  'configfs',
  'debugfs',
  'devfs',
  'devpts',
  'devtmpfs',
  'efivarfs',
  'fuse.gvfsd-fuse',
  'fuse.portal',
  'fuse.snapfuse',
  'fusectl',
  'hugetlbfs',
  'mqueue',
  'none',
  'nsfs',
  'overlay',
  'pstore',
  'proc',
  'procfs',
  'ramfs',
  'rootfs',
  'rpc_pipefs',
  'securityfs',
  'selinuxfs',
  'squashfs',
  'sysfs',
  'tmpfs',
  'tracefs',
  'udev'
])

/** Used only when df cannot report the fstype (no -T support). */
const VIRTUAL_DEVICES = new Set([
  'cgroup',
  'cgroup2',
  'devtmpfs',
  'none',
  'overlay',
  'proc',
  'ramfs',
  'rootfs',
  'shm',
  'sysfs',
  'systemd-1',
  'tmpfs',
  'udev'
])
const VIRTUAL_MOUNT_PREFIXES = ['/proc', '/sys', '/dev', '/run', '/snap/', '/var/snap/']

/**
 * Parse `df -kPT` (or `df -kP`). The fstype column is detected per line
 * instead of from the header, which keeps working on localised targets.
 * Everything that is not a pseudo filesystem is kept, so ZFS, btrfs
 * subvolumes and network mounts show up like any local disk.
 */
export function parseFilesystems(text: string): FsInfo[] {
  const byMount = new Map<string, FsInfo>()
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/)
    if (f.length < 6) continue
    const numeric = (s: string | undefined): boolean => !!s && /^\d+$/.test(s)
    // dev [type] size used avail capacity% mount...
    const hasType = !numeric(f[1]) && numeric(f[2])
    if (!hasType && !numeric(f[1])) continue // header or garbage line
    const off = hasType ? 1 : 0
    if (f.length < 6 + off) continue
    const device = f[0]
    const fstype = hasType ? f[1] : ''
    const mount = f.slice(5 + off).join(' ')
    if (!mount.startsWith('/')) continue
    if (hasType) {
      if (VIRTUAL_FSTYPES.has(fstype) || fstype.startsWith('fuse.')) continue
    } else {
      if (VIRTUAL_DEVICES.has(device)) continue
      if (VIRTUAL_MOUNT_PREFIXES.some((p) => mount === p || mount.startsWith(p))) continue
    }
    const sizeKb = parseInt(f[1 + off], 10) || 0
    if (sizeKb <= 0) continue
    const usedKb = parseInt(f[2 + off], 10) || 0
    byMount.set(mount, {
      device,
      fstype,
      mount,
      sizeKb,
      usedKb,
      sizeBytes: sizeKb * 1024,
      usedBytes: usedKb * 1024,
      pct: parseInt(f[4 + off], 10) || 0
    })
  }
  return [...byMount.values()].sort((a, b) => a.mount.localeCompare(b.mount))
}
