import * as React from 'react'
import { REFRESH_INTERVAL_MS } from '@shared/types'
import { useApp } from '@/state/store'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn, formatInterval } from '@/lib/utils'

/**
 * Interval keys are open-ended: the app owns `system` and `processes`, every
 * other one belongs to a module (and an installed module may declare its own).
 * A key with no label here still shows its interval, just without the tooltip
 * naming the section.
 */
const FAST_LABELS: Record<string, string> = {
  system: 'System metrics',
  sensors: 'Sensors',
  gpu: 'GPU',
  container: 'Docker and Incus containers',
  processes: 'Processes',
  network: 'Network detail',
  disk: 'Disk activity'
}

const SLOW_LABELS: Record<string, string> = {
  storage: 'File systems & devices',
  container: 'Container disk usage',
  network: 'Interface inventory'
}

/** These two are only collected while their detail collector is enabled. */
const DETAIL_GATED = new Set(['network', 'disk'])

/**
 * How often the section it sits in is refreshed. Two sections of the same
 * card can run at very different speeds (disk throughput every second, mount
 * usage every minute), so each one says which one it is.
 */
export function IntervalBadge({
  fast,
  slow,
  className
}: {
  fast?: string
  slow?: string
  className?: string
}): React.JSX.Element {
  const speed = useApp((s) => (fast ? s.settings?.refresh[fast] : undefined))
  const seconds = useApp((s) => (slow ? s.settings?.slowRefresh[slow] : undefined))
  const detailOff = useApp((s) =>
    fast && DETAIL_GATED.has(fast)
      ? s.settings?.detailPolling[fast as 'network' | 'disk'] === 'off'
      : false
  )

  let label: string
  if (!fast) {
    label = formatInterval(seconds ?? 0)
  } else if (detailOff) {
    label = 'off'
  } else {
    label =
      speed === 'paused' ? 'paused' : formatInterval(REFRESH_INTERVAL_MS[speed ?? 'normal'] / 1000)
  }
  const what = (fast ? FAST_LABELS[fast] : slow ? SLOW_LABELS[slow] : '') || 'This section'
  const explanation =
    label === 'off'
      ? `${what}: the collector is turned off`
      : label === 'paused'
        ? `${what}: polling is paused`
        : label === 'manual'
          ? `${what}: only refreshed on request`
          : `${what}: updated every ${label}`

  return (
    <Tooltip>
      <TooltipTrigger
        className={cn(
          'shrink-0 rounded bg-muted px-1 py-px text-[0.6rem] font-normal normal-case tracking-normal text-muted-foreground',
          className
        )}
      >
        {label}
      </TooltipTrigger>
      <TooltipContent>{explanation}</TooltipContent>
    </Tooltip>
  )
}
