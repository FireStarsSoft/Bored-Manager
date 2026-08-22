import { describe, expect, it } from 'vitest'
import { parseFilesystems } from '../../../modules/disk/main/df'
import { flattenDevices, parseLsblk } from '../../../modules/disk/main/lsblk'

describe('parseFilesystems', () => {
  it('reads a df -kPT ext4 root line into bytes and percent', () => {
    const rows = parseFilesystems(
      [
        'Filesystem     Type 1024-blocks Used Available Capacity Mounted on',
        '/dev/sda1      ext4     1048576  524288    524288      50% /'
      ].join('\n')
    )
    expect(rows).toEqual([
      {
        device: '/dev/sda1',
        fstype: 'ext4',
        mount: '/',
        sizeKb: 1_048_576,
        usedKb: 524_288,
        sizeBytes: 1_048_576 * 1024,
        usedBytes: 524_288 * 1024,
        pct: 50
      }
    ])
  })

  it('keeps a real mount from df -kP and drops tmpfs, shm and /run', () => {
    const rows = parseFilesystems(
      [
        'Filesystem 1024-blocks Used Available Capacity Mounted on',
        '/dev/sdb1      2048  1024    1024      50% /data',
        'tmpfs          4096     0    4096       0% /dev/shm',
        'tmpfs          1024     4    1020       1% /run/user/1000'
      ].join('\n')
    )
    expect(rows.map((r) => r.mount)).toEqual(['/data'])
  })

  it('drops fuse and overlay, keeps nfs and zfs', () => {
    const rows = parseFilesystems(
      [
        'gvfsd-fuse fuse.gvfsd-fuse 100 1 99 1% /run/user/1000/gvfs',
        'overlay overlay 100 1 99 1% /var/lib/docker/overlay2',
        'server:/export nfs 2048 10 2038 1% /mnt/nfs',
        'tank/data zfs 4096 100 3996 3% /tank'
      ].join('\n')
    )
    expect(rows.map((r) => r.fstype).sort()).toEqual(['nfs', 'zfs'])
  })

  it('skips the header, short lines and a mount that is not absolute', () => {
    expect(
      parseFilesystems('Filesystem Type Size Used Avail Use% Mounted\nshort\n/dev/sda1 ext4 100 1 99 1% relative')
    ).toEqual([])
  })

  it('lets the last of two same mounts win and sorts by mount', () => {
    const rows = parseFilesystems(
      [
        '/dev/sda2 ext4 100 10 90 10% /b',
        '/dev/sda1 ext4 200 20 180 10% /a',
        '/dev/sda3 ext4 300 30 270 10% /a'
      ].join('\n')
    )
    expect(rows.map((r) => `${r.mount}:${r.device}`)).toEqual(['/a:/dev/sda3', '/b:/dev/sda2'])
  })

  it('returns an empty list for blank input', () => {
    expect(parseFilesystems('   \n')).toEqual([])
  })
})

describe('parseLsblk / flattenDevices', () => {
  const tree = {
    blockdevices: [
      {
        name: 'sda',
        type: 'disk',
        size: '1073741824',
        rota: '1',
        children: [
          {
            name: 'sda1',
            type: 'part',
            size: 536870912,
            mountpoints: [null, '/']
          }
        ]
      }
    ]
  }

  it('builds a disk plus partition and reads mountpoints[]', () => {
    const devices = parseLsblk(JSON.stringify(tree))
    expect(devices).toHaveLength(1)
    expect(devices[0].name).toBe('sda')
    expect(devices[0].rotational).toBe(true)
    expect(devices[0].sizeBytes).toBe(1_073_741_824)
    expect(devices[0].children[0].mountpoint).toBe('/')
    expect(devices[0].children[0].sizeBytes).toBe(536_870_912)
  })

  it('returns [] for invalid JSON or a missing blockdevices key', () => {
    expect(parseLsblk('not json')).toEqual([])
    expect(parseLsblk('{}')).toEqual([])
  })

  it('walks parents before children', () => {
    const flat = flattenDevices(parseLsblk(JSON.stringify(tree)))
    expect(flat.map((d) => d.name)).toEqual(['sda', 'sda1'])
  })
})
