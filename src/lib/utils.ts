import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/** Turn an unknown throw into a string a toast or form can show. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Drop samples older than `maxAgeMs` from the front of a time-ordered ring. */
export function pruneByAge<T extends { t: number }>(arr: T[], maxAgeMs: number, now = Date.now()): T[] {
  const cutoff = now - maxAgeMs
  let i = 0
  while (i < arr.length && arr[i].t < cutoff) i++
  return i > 0 ? arr.slice(i) : arr
}

export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : digits)} ${units[i]}`
}

export function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`
}

export function formatPct(v: number): string {
  return `${v.toFixed(v < 10 && v > 0 ? 1 : 0)}%`
}

export function formatTemp(v: number): string {
  return `${v.toFixed(0)}°C`
}

export function formatWatts(v: number): string {
  return `${v.toFixed(0)} W`
}

/** Compact count for chart axes: 1200 -> "1.2k". */
export function formatCount(v: number): string {
  if (!Number.isFinite(v)) return '0'
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}k`
  return v.toFixed(0)
}

/** "1s" / "30s" / "5m" - how often a section is refreshed. */
export function formatInterval(sec: number): string {
  if (sec <= 0) return 'manual'
  if (sec < 60) return `${sec}s`
  if (sec % 3600 === 0) return `${sec / 3600}h`
  return `${Math.round(sec / 60)}m`
}

export function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

/** "5m" / "2h 3m" - elapsed time since an absolute ms timestamp (a `startedAt`-style field). */
export function formatDuration(startedAtMs: number): string {
  return formatUptime(Math.max(0, (Date.now() - startedAtMs) / 1000))
}

/**
 * Colour a temperature against the chip's own critical point when it reports
 * one - 70 °C is normal for a CPU and alarming for an NVMe controller.
 */
export function tempKind(value: number, crit?: number): 'default' | 'warn' | 'bad' {
  const hot = crit && crit > 0 ? crit * 0.9 : 85
  const warm = crit && crit > 0 ? crit * 0.75 : 70
  if (value >= hot) return 'bad'
  if (value >= warm) return 'warn'
  return 'default'
}

/**
 * Copy to the clipboard, with the fallback that makes it work at all here: the
 * WebUI is served over plain http on a LAN address, which is not a secure
 * context, so navigator.clipboard does not exist in most browsers.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.append(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  } catch {
    return false
  }
}
