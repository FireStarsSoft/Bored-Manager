import * as React from 'react'
import { HISTORY_WINDOW_OPTIONS } from '@shared/types'
import { useApp } from '@/state/store'
import { LIVE_WINDOW_SEC } from '@/lib/history'
import { cn } from '@/lib/utils'

/**
 * Chart time range selector. Ranges longer than the live buffer are only
 * offered when the metrics history keeps that much data on disk.
 */
function useMaxWindowSec(): number {
  const history = useApp((s) => s.settings?.history)
  return history?.enabled
    ? Math.max(LIVE_WINDOW_SEC, history.retentionHours * 3600)
    : LIVE_WINDOW_SEC
}

export function WindowPicker({
  value,
  onChange,
  className
}: {
  value: number
  onChange: (v: number) => void
  className?: string
}): React.JSX.Element {
  const maxSec = useMaxWindowSec()
  const options = HISTORY_WINDOW_OPTIONS.filter((o) => o.value <= maxSec)

  return (
    <div className={cn('flex items-center gap-0.5 rounded-md border border-border p-0.5', className)}>
      {options.map((w) => (
        <button
          key={w.value}
          onClick={() => onChange(w.value)}
          className={cn(
            'rounded px-2 py-1 text-xs transition-colors cursor-pointer',
            value === w.value ? 'bg-accent/15 font-medium text-accent' : 'text-muted hover:text-fg'
          )}
        >
          {w.label}
        </button>
      ))}
    </div>
  )
}

/**
 * Never ask for more than the history can actually cover: shrinking retention
 * must not leave a chart requesting data that was just deleted.
 */
function clampWindow(win: number, maxSec: number): number {
  if (win <= maxSec) return win
  const allowed = HISTORY_WINDOW_OPTIONS.filter((o) => o.value <= maxSec)
  return allowed.at(-1)?.value ?? LIVE_WINDOW_SEC
}

/**
 * A detail page's own chart window, starting from the default in Settings. Each
 * page keeps its own, so zooming out on one does not disturb another.
 */
export function useHistoryWindow(): [number, (v: number) => void] {
  const settings = useApp((s) => s.settings)
  const maxSec = useMaxWindowSec()
  const [win, setWin] = React.useState<number>(settings?.historyWindow ?? 60)
  React.useEffect(() => {
    if (settings) setWin(settings.historyWindow)
  }, [settings?.historyWindow]) // eslint-disable-line react-hooks/exhaustive-deps
  return [clampWindow(win, maxSec), setWin]
}

/**
 * The Overview's chart window. It lives in the store rather than in the page,
 * because the cards on it come from several modules and all of them have to
 * follow the one picker in the header.
 */
export function useOverviewWindow(): number {
  const win = useApp((s) => s.overviewWindow)
  return clampWindow(win, useMaxWindowSec())
}
