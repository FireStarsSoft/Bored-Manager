import * as React from 'react'
import type { HistoryPoint, HistoryStream } from '@shared/types'
import { api } from '@/lib/api'
import { useApp } from '@/state/store'

/** Windows up to this length are served from the live buffer in the store. */
export const LIVE_WINDOW_SEC = 600

/**
 * Average samples into at most `maxPoints` buckets. A card sparkline is a
 * few hundred pixels wide, so drawing thousands of points only costs frames.
 */
export function thin<T extends { t: number }>(points: T[], maxPoints: number): T[] {
  if (points.length <= maxPoints || maxPoints <= 0) return points
  const span = points[points.length - 1].t - points[0].t
  if (span <= 0) return points.slice(-maxPoints)
  const bucketMs = span / maxPoints
  const out: T[] = []
  let bucket: T[] = []
  let bucketEnd = points[0].t + bucketMs
  const flush = (): void => {
    if (!bucket.length) return
    const last = bucket[bucket.length - 1]
    const avg: Record<string, number> = { t: last.t }
    for (const key of Object.keys(last)) {
      if (key === 't') continue
      let sum = 0
      for (const p of bucket) sum += (p as unknown as Record<string, number>)[key] ?? 0
      avg[key] = sum / bucket.length
    }
    out.push(avg as unknown as T)
    bucket = []
  }
  for (const p of points) {
    if (p.t > bucketEnd) {
      flush()
      bucketEnd = p.t + bucketMs
    }
    bucket.push(p)
  }
  flush()
  return out
}

/**
 * Chart data for a time window.
 *
 * Short windows come straight from the live buffer. Longer ones are read
 * back (already downsampled) from the metrics history in the main process
 * and get the newest live samples appended, so the chart still moves between
 * refetches. `toPoint` must be stable across renders.
 */
export function useWindowedSeries<T extends { t: number }>(
  stream: HistoryStream,
  windowSec: number,
  live: T[],
  toPoint: (p: HistoryPoint) => T,
  maxPoints = 600
): T[] {
  const connected = useApp((s) => s.status.connected)
  const historyEnabled = useApp((s) => s.settings?.history.enabled ?? true)
  const useArchive = connected && historyEnabled && windowSec > LIVE_WINDOW_SEC
  const [archive, setArchive] = React.useState<T[]>([])
  const toPointRef = React.useRef(toPoint)
  toPointRef.current = toPoint

  React.useEffect(() => {
    if (!useArchive) {
      setArchive([])
      return
    }
    let cancelled = false
    const load = async (): Promise<void> => {
      const now = Date.now()
      const points = await api.history.query(stream, now - windowSec * 1000, now, maxPoints)
      if (!cancelled) setArchive(points.map(toPointRef.current))
    }
    void load()
    // One refetch per ~1% of the window: enough to look live, cheap enough
    // that a 24h chart only re-reads the files a few times per hour.
    const everyMs = Math.min(60_000, Math.max(5_000, (windowSec / 60) * 1000))
    const id = setInterval(() => void load(), everyMs)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [stream, windowSec, maxPoints, useArchive])

  return React.useMemo(() => {
    const cutoff = Date.now() - windowSec * 1000
    const recent = live.filter((p) => p.t >= cutoff)
    if (!useArchive) return thin(recent, maxPoints)
    if (!archive.length) return thin(recent, maxPoints)
    const lastArchived = archive[archive.length - 1].t
    return [...archive, ...recent.filter((p) => p.t > lastArchived)]
  }, [archive, live, windowSec, useArchive, maxPoints])
}
