# Disk & storage

Two very different questions on one page: how much the disks are doing right now, and how they are laid out and how full they are. The two run on separate intervals, because one changes every second and the other every few minutes.

## What it adds

| Where | What |
|---|---|
| Sidebar | **Disk** page — Read/Write widgets, IOPS, busiest device, total capacity; throughput and IOPS charts; a storage devices table covering every block device; a file systems table with inodes; I/O per process |
| Overview | **File systems** widget (off by default) — a usage bar per mount |
| History | writes the `disk` metrics stream (rates and IOPS) |

This module contributes no summary widget. The **Disk I/O** card on the Overview is the app's own, fed by the machine-wide rates in the core system stream, so it keeps working when this module is disabled.

## What it runs on the target

Fast tick (throughput, IOPS, latency, per-process I/O), one roundtrip:

```sh
cat /proc/diskstats
awk '...' $(find /proc -maxdepth 2 -name io -readable)   # per-process read/write bytes
ps axo pid,comm --no-headers                             # names for those pids
```

Slow tick (layout and capacity), one roundtrip:

```sh
df -kPT          # mount usage, with a df -kP fallback for busybox
df -iP           # inodes
lsblk -Jb        # the device tree, with a /proc/diskstats fallback
```

## The "Unattributed" row

The I/O per process table ends with a row for the difference between what the devices moved and what the processes account for. That gap is real, not a rounding error: the kernel charges a process only for the bytes it pushed to the block layer, so page-cache writeback, journal and swap traffic belong to nobody — and without sudo, other users' processes are invisible too.

## Sudo

Without root, `/proc/PID/io` is only readable for the connecting user's own processes, so the per-process table covers less and the Unattributed row grows. The device totals are unaffected.

## Settings it reads

| Setting | Effect |
|---|---|
| Update intervals → **Disk & storage** (fast) | how often throughput, IOPS and per-process I/O are read |
| Update intervals → **Disk & storage** (slow) | how often df, inodes and lsblk are re-read; `Manual only` reads them once and then only on request |
| Data collection → **Per-process disk I/O** | `While tab is open` (default), `Always` or `Off` |
| Overview → **File systems** | whether the Overview widget is shown |
| Data & storage | whether the `disk` history stream is written, and for how long |

The storage reading is not affected by the detail-collector setting: the device inventory also supplies the models and sizes the throughput table shows, so it keeps running on its slow interval regardless.

## When data is incomplete

- **A mount is missing from the file systems table**: the module reads `df -kPT` and excludes by virtual fstype (tmpfs, overlay, squashfs, cgroup, ...) instead of only accepting `/dev/*`, so ZFS, btrfs subvolumes and network mounts all show up. A target whose `df` has no `-T` support (busybox) falls back to `df -kP` with a filter by device name and mount point instead.
- **A device is missing from the storage devices table**: the inventory comes from `lsblk -Jb` (loop and ram devices excluded on purpose). If `lsblk` is missing or has no JSON support, the table falls back to the devices found in `/proc/diskstats` — they still show live throughput, only the model, size and partition tree are unavailable.

## Files

```
main/index.ts     activate(): a fast poller and a slow one, with the slow one
                  only re-applied when its interval actually changed
main/service.ts   throughput, IOPS, latency, per-process I/O
main/storage.ts   df, inodes and lsblk on the slow interval
main/df.ts        the df command and its parser
main/lsblk.ts     the lsblk command, its parser and the flatten helper
renderer/index.tsx     tab + widget + stream declarations
renderer/DiskTab.tsx
renderer/FilesystemsCard.tsx
```
