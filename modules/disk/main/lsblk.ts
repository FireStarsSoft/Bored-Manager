import type { BlockDeviceInfo } from '@shared/types'

/**
 * The block device inventory. `-e 7,1` drops loop and ram devices: they are
 * squashfs images and RAM disks, not storage anyone installed. Everything
 * else is listed, whether it carries a filesystem or is mounted or not.
 */
export const LSBLK_CMD =
  `lsblk -Jb -e 7,1 -o NAME,TYPE,SIZE,MODEL,SERIAL,ROTA,TRAN,RM,FSTYPE,MOUNTPOINT ` +
  `2>/dev/null || true`

interface RawLsblk {
  name?: string
  type?: string
  size?: number | string
  model?: string | null
  serial?: string | null
  rota?: boolean | string
  tran?: string | null
  rm?: boolean | string
  fstype?: string | null
  mountpoint?: string | null
  mountpoints?: Array<string | null>
  children?: RawLsblk[]
}

function bool(v: boolean | string | undefined): boolean {
  return v === true || v === '1' || v === 'true'
}

function text(v: string | null | undefined): string {
  return (v ?? '').toString().trim()
}

function toDevice(d: RawLsblk): BlockDeviceInfo {
  return {
    name: text(d.name),
    type: text(d.type),
    sizeBytes: typeof d.size === 'string' ? parseInt(d.size, 10) || 0 : (d.size ?? 0),
    model: text(d.model),
    serial: text(d.serial),
    transport: text(d.tran),
    rotational: bool(d.rota),
    removable: bool(d.rm),
    fstype: text(d.fstype),
    // lsblk 2.37+ reports an array of mount points; older versions a string.
    mountpoint: text(d.mountpoint) || text(d.mountpoints?.find((m) => !!m)),
    children: (d.children ?? []).map(toDevice)
  }
}

export function parseLsblk(text: string): BlockDeviceInfo[] {
  try {
    const root = JSON.parse(text) as { blockdevices?: RawLsblk[] }
    return (root.blockdevices ?? [])
      .filter((d) => !!d.name)
      .map(toDevice)
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    // lsblk missing or without JSON support: the disk poller still reports
    // the devices it finds in /proc/diskstats, just without model or size.
    return []
  }
}

/** Whole disks and partitions in one flat list, parents first. */
export function flattenDevices(devices: BlockDeviceInfo[]): BlockDeviceInfo[] {
  const out: BlockDeviceInfo[] = []
  const walk = (list: BlockDeviceInfo[]): void => {
    for (const d of list) {
      out.push(d)
      walk(d.children)
    }
  }
  walk(devices)
  return out
}
