import type {
  CollectorSettings,
  Density,
  DetailPollingMode,
  RefreshSpeed,
  SessionIdleUnit,
  Theme
} from '@shared/types'
import {
  HISTORY_RETENTION_OPTIONS,
  HISTORY_WINDOW_OPTIONS,
  SLOW_REFRESH_OPTIONS
} from '@shared/types'

/** The option lists every Settings card selects from, in one place. */

export const SPEED_OPTIONS: Array<{ value: RefreshSpeed; label: string }> = [
  { value: 'high', label: 'High (1s)' },
  { value: 'normal', label: 'Normal (2s)' },
  { value: 'low', label: 'Low (5s)' },
  { value: 'paused', label: 'Paused' }
]

export const SLOW_OPTIONS = SLOW_REFRESH_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))

export const INTERVAL_GROUPS: Array<{
  label: string
  fast?: { key: string; desc: string }
  slow?: { key: string; desc: string }
}> = [
  {
    label: 'System',
    fast: { key: 'system', desc: 'CPU, memory, load average, total network and disk rates' }
  },
  {
    label: 'Sensors',
    fast: { key: 'sensors', desc: 'Temperatures, fans, voltages, power and current' }
  },
  {
    label: 'Processes',
    fast: { key: 'processes', desc: 'Process table and the top consumers on the Overview cards' }
  },
  { label: 'GPU', fast: { key: 'gpu', desc: 'nvidia-smi: utilisation, VRAM, temperature, power' } },
  {
    label: 'Docker',
    fast: { key: 'docker', desc: 'Containers and their CPU/memory stats' },
    slow: { key: 'docker', desc: 'Image, volume and build cache disk usage (docker system df)' }
  },
  {
    label: 'Network',
    fast: { key: 'network', desc: 'Interface rates, connections, per-process bandwidth' },
    slow: { key: 'network', desc: 'Addresses, MTU, link speed, gateway and DNS' }
  },
  {
    label: 'Disk & storage',
    fast: { key: 'disk', desc: 'Throughput, IOPS, utilisation, per-process I/O' },
    slow: { key: 'storage', desc: 'Mount usage and inodes (df), block device list (lsblk)' }
  }
]

export const RETENTION_OPTIONS = HISTORY_RETENTION_OPTIONS.map((o) => ({
  value: String(o.value),
  label: o.label
}))

/**
 * Only what the app itself collects. Everything a module collects is switched
 * with the module, in Settings -> Modules.
 */
export const COLLECTOR_LIST: Array<{ key: keyof CollectorSettings; label: string; desc: string }> = [
  { key: 'cpu', label: 'CPU', desc: 'Usage, per-core stats and load average' },
  { key: 'memory', label: 'Memory', desc: 'RAM and swap usage' },
  {
    key: 'network',
    label: 'Network rates',
    desc: 'Machine-wide download/upload for the Overview card'
  },
  { key: 'disk', label: 'Disk rates', desc: 'Machine-wide read/write for the Overview card' },
  { key: 'packages', label: 'Packages', desc: 'Package manager tab (loads on demand)' }
]

export const DETAIL_OPTIONS: Array<{ value: DetailPollingMode; label: string }> = [
  { value: 'tab', label: 'While tab is open' },
  { value: 'always', label: 'Always (background)' },
  { value: 'off', label: 'Off' }
]

export const OVERVIEW_DETAIL_OPTIONS: Array<{ value: DetailPollingMode; label: string }> = [
  { value: 'tab', label: 'While Overview is open' },
  { value: 'always', label: 'Always (background)' },
  { value: 'off', label: 'Off' }
]

export const DETAIL_COLLECTORS: Array<{
  key: keyof import('@shared/types').DetailPollingSettings
  label: string
  desc: string
}> = [
  {
    key: 'network',
    label: 'Network detail collector',
    desc: 'Connections, per-process bandwidth'
  },
  { key: 'disk', label: 'Disk detail collector', desc: 'Per-device stats, per-process I/O' },
  {
    key: 'overviewTop',
    label: 'Overview top consumers',
    desc: 'Which processes use the most CPU, memory, disk and network'
  }
]

export const DENSITY_OPTIONS: Array<{ value: Density; label: string }> = [
  { value: 'low', label: 'Low - HD screens (larger UI)' },
  { value: 'medium', label: 'Medium - Full HD' },
  { value: 'high', label: 'High - 2K+ (compact UI)' }
]

export const THEME_OPTIONS: Array<{ value: Theme; label: string }> = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'System - follow this device' }
]

export const WINDOW_OPTIONS = HISTORY_WINDOW_OPTIONS.map((o) => ({
  value: String(o.value),
  label: o.label
}))

/**
 * Overview widgets the app itself provides. The ones modules contribute are
 * listed underneath these, grouped per module (see OverviewCardsCard).
 */
export const CORE_WIDGETS: Array<{ id: string; label: string; desc: string; defaultEnabled?: boolean }> = [
  { id: 'appServices', label: 'App services', desc: 'What Bored Manager itself is running, and its cost', defaultEnabled: true },
  { id: 'perCoreCpu', label: 'Per-core CPU', desc: 'Usage bar for every CPU core' },
  { id: 'loadUptime', label: 'Load & uptime', desc: 'Load average 1/5/15 min and uptime' },
  { id: 'topProcesses', label: 'Top processes', desc: 'Five busiest processes by CPU' }
]



export const IDLE_UNITS: Array<{ value: SessionIdleUnit; label: string }> = [
  { value: 'minute', label: 'Minutes' },
  { value: 'hour', label: 'Hours' },
  { value: 'day', label: 'Days' }
]

