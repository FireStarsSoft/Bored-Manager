import * as React from 'react'
import { RefreshCw } from 'lucide-react'
import { useApp } from '@/state/store'
import { IntervalBadge } from '@/components/IntervalBadge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** "12s ago" / "3m ago" / "1h 4m ago" */
export function formatAge(t: number | undefined, now: number): string {
  if (!t) return 'never'
  const sec = Math.max(0, Math.round((now - t) / 1000))
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  return `${Math.floor(min / 60)}h ${min % 60}m ago`
}

/**
 * Interval, age and a manual refresh button for a section that updates on a
 * slow interval. The age re-renders on its own ticker so it stays honest even
 * when no new data arrives for minutes.
 *
 * The caller passes the timestamp of its last reading: the sections live in
 * modules now, so there is no single place this component could read it from.
 */
export function SlowRefresh({
  target,
  at,
  className
}: {
  /** The settings.slowRefresh key this section runs on. */
  target: string
  /** When the section was last read, for the age label. */
  at?: number
  className?: string
}): React.JSX.Element {
  const refreshing = useApp((s) => s.slowRefreshing[target] === true)
  const refreshSlow = useApp((s) => s.refreshSlow)
  const [now, setNow] = React.useState(() => Date.now())

  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className={cn('flex items-center gap-1.5 text-[0.65rem] text-muted-foreground', className)}>
      <IntervalBadge slow={target} />
      <span>{formatAge(at, now)}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh now"
            disabled={refreshing}
            onClick={(e) => {
              e.stopPropagation()
              void refreshSlow(target)
            }}
          >
            <RefreshCw className={cn(refreshing && 'animate-spin')} aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Refresh now</TooltipContent>
      </Tooltip>
    </div>
  )
}
