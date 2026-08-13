import * as React from 'react'
import type { LucideIcon } from 'lucide-react'
import type { TopProcEntry } from '@shared/types'
import { Card } from '@/components/ui/card'
import { Sparkline, type ChartPoint, type SeriesDef } from '@/components/charts'
import { cn } from '@/lib/utils'

/**
 * Both halves of a two-way rate. A single "1.2 MB/s" cannot say whether a
 * process is downloading or uploading, reading or writing - the two numbers
 * can, and they keep the colour key of the Network and Disk tabs.
 */
function SplitRate({
  down,
  up,
  downLabel,
  upLabel,
  downClass,
  upClass,
  format
}: {
  down: number
  up: number
  downLabel: string
  upLabel: string
  downClass: string
  upClass: string
  format: (v: number) => string
}): React.JSX.Element {
  return (
    <span
      className="shrink-0 font-medium tabular-nums"
      title={`${downLabel} ${format(down)} · ${upLabel} ${format(up)}`}
    >
      <span className={downClass}>
        {downLabel} {format(down)}
      </span>
      <span className="mx-1 text-muted/60">·</span>
      <span className={upClass}>
        {upLabel} {format(up)}
      </span>
    </span>
  )
}

/**
 * The processes using most of what the card measures. "62%" is a number;
 * "62% - ffmpeg is taking 41% of it" is an answer.
 */
export function TopConsumers({
  entries,
  format,
  color,
  count = 3,
  emptyText
}: {
  entries: TopProcEntry[] | undefined
  format: (v: number) => string
  color: string
  count?: number
  /** Shown instead of nothing when no process could be measured. */
  emptyText?: React.ReactNode
}): React.JSX.Element | null {
  const top = (entries ?? []).slice(0, count)
  if (!top.length) {
    if (!emptyText) return null
    return (
      <div className="mt-2 border-t border-border/50 pt-1.5 text-[0.7rem] text-muted">
        {emptyText}
      </div>
    )
  }
  return (
    <div className="mt-2 space-y-0.5 border-t border-border/50 pt-1.5">
      {top.map((e) => (
        <div key={e.pid} className="flex items-baseline gap-2 text-[0.7rem]">
          <span className="min-w-0 flex-1 truncate text-muted" title={`PID ${e.pid}`}>
            {e.name}
          </span>
          {e.rx != null && e.tx != null ? (
            <SplitRate
              down={e.rx}
              up={e.tx}
              downLabel="↓"
              upLabel="↑"
              downClass="text-download"
              upClass="text-upload"
              format={format}
            />
          ) : e.read != null && e.write != null ? (
            <SplitRate
              down={e.read}
              up={e.write}
              downLabel="R"
              upLabel="W"
              downClass="text-disk"
              upClass="text-warn"
              format={format}
            />
          ) : (
            <span className="shrink-0 font-medium tabular-nums" style={{ color }}>
              {format(e.value)}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

/** Overview summary card: title, current value, sub info and a history chart. */
export function StatCard({
  title,
  icon: Icon,
  color,
  value,
  sub,
  data,
  series,
  max,
  formatValue,
  handle,
  badge,
  onClick,
  children,
  className
}: {
  title: string
  icon: LucideIcon
  color: string
  value: string
  sub?: React.ReactNode
  data?: ChartPoint[]
  series?: SeriesDef[]
  max?: number
  formatValue?: (v: number) => string
  /** Drag grip, rendered before the title (Overview grid only). */
  handle?: React.ReactNode
  /** Update interval marker, rendered after the title. */
  badge?: React.ReactNode
  onClick?: () => void
  children?: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <Card
      onClick={onClick}
      className={cn(
        'flex flex-col p-3 transition-colors',
        onClick && 'cursor-pointer hover:bg-card-hover',
        className
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
          {handle}
          <Icon className="h-3.5 w-3.5 shrink-0" style={{ color }} />
          <span className="truncate">{title}</span>
          {badge}
        </div>
        <div className="shrink-0 text-base font-semibold leading-none" style={{ color }}>
          {value}
        </div>
      </div>
      {sub != null && <div className="mt-1 text-xs text-muted">{sub}</div>}
      {data && series && (
        <div className="mt-2">
          <Sparkline data={data} series={series} max={max} formatValue={formatValue} />
        </div>
      )}
      {children}
    </Card>
  )
}
