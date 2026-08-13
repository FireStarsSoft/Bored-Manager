import * as React from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import { cn } from '@/lib/utils'

export interface SeriesDef {
  key: string
  color: string
  name?: string
}

export interface ChartPoint {
  t: number
  [key: string]: number
}

let gradientCounter = 0

const TOOLTIP_STYLE = {
  background: 'var(--color-card)',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  fontSize: '0.75rem',
  padding: '4px 8px'
} as const

const AXIS_TICK = { fill: 'var(--color-muted)', fontSize: 10 } as const

const GRID_STROKE = 'var(--color-border)'

/**
 * Breathing room between a tick label and the plot it belongs to. Recharts
 * places labels right against the axis line by default, which makes them read
 * as part of the curve instead of as a scale.
 */
const GAP = 8

/** Height of the strip the time labels live in, label height plus GAP. */
const TIME_STRIP = 20

/**
 * The right margin is what keeps the last time label whole: it is centred on
 * the final sample, so half of it would sit outside the plot area.
 */
const CARD_MARGIN = { top: 10, right: 14, bottom: 0, left: 4 } as const
const DETAIL_MARGIN = { top: 10, right: 18, bottom: 0, left: 4 } as const

/** Windows shorter than this get seconds on the time axis, longer ones don't. */
const SECONDS_AXIS_MS = 10 * 60 * 1000

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function timeLabel(t: number, spanMs: number): string {
  const d = new Date(t)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return spanMs > SECONDS_AXIS_MS ? hm : `${hm}:${pad(d.getSeconds())}`
}

/** Tooltips always name the exact second, whatever the axis is showing. */
function tooltipTime(t: number): string {
  return timeLabel(t, 0)
}

/**
 * Evenly spaced marks between the first and last sample. Recharts' automatic
 * ticks jump around as points scroll past; fixed positions keep the axis
 * readable on a chart that moves every second.
 */
function timeTicks(data: ChartPoint[], count: number): number[] {
  if (data.length < 2) return data.map((d) => d.t)
  const first = data[0].t
  const last = data[data.length - 1].t
  if (last <= first) return [first]
  return Array.from({ length: count }, (_, i) => first + ((last - first) * i) / (count - 1))
}

/**
 * Round up to two significant digits, so the top of the value axis is a
 * stable label instead of one that flickers with every new sample.
 */
function niceMax(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1
  const step = Math.pow(10, Math.floor(Math.log10(v)) - 1)
  return Math.ceil(v / step) * step
}

function peak(data: ChartPoint[], series: SeriesDef[]): number {
  let top = 0
  for (const p of data) {
    for (const s of series) {
      const v = p[s.key]
      if (typeof v === 'number' && v > top) top = v
    }
  }
  return top
}

/**
 * Value axis bounds and its labels. Charts with a known ceiling (percentages,
 * total VRAM) keep it fixed; the rest follow the data so a rate chart still
 * says what "full height" currently means.
 */
function useValueAxis(
  data: ChartPoint[],
  series: SeriesDef[],
  max: number | undefined,
  tickCount: number
): { top: number; ticks: number[] } {
  const dataPeak = peak(data, series)
  return React.useMemo(() => {
    const top = max ?? niceMax(dataPeak)
    const ticks = Array.from({ length: tickCount }, (_, i) => (top * i) / (tickCount - 1))
    return { top, ticks }
  }, [max, dataPeak, tickCount])
}

/** Drop marks that would print the same label twice (0 and 0.5 B/s). */
function distinct(ticks: number[], format: (v: number) => string): number[] {
  const seen = new Set<string>()
  return ticks.filter((v) => {
    const label = format(v)
    if (seen.has(label)) return false
    seen.add(label)
    return true
  })
}

function useTimeAxis(
  data: ChartPoint[],
  tickCount: number
): { ticks: number[]; format: (t: number) => string } {
  const first = data[0]?.t ?? 0
  const last = data[data.length - 1]?.t ?? 0
  return React.useMemo(() => {
    const span = last - first
    return {
      ticks: timeTicks(data, tickCount),
      format: (t: number) => timeLabel(t, span)
    }
    // Ticks only depend on the range and the number of samples.
  }, [first, last, data.length, tickCount]) // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * Reference mesh behind the curve: a line at every value label and one at
 * every time label, so a point on the curve can be read off against both
 * axes instead of only against the value scale.
 */
function Grid({ xTicks }: { xTicks: number[] }): React.JSX.Element {
  return (
    <CartesianGrid
      stroke={GRID_STROKE}
      strokeDasharray="2 4"
      verticalValues={xTicks}
      syncWithTicks
    />
  )
}

/**
 * Colour key under a chart. Without it a stacked pair of areas is a guessing
 * game - which band is upload and which is download?
 */
function Legend({ series }: { series: SeriesDef[] }): React.JSX.Element {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[0.65rem] text-muted">
      {series.map((s) => (
        <span key={s.key} className="flex items-center gap-1">
          <span
            aria-hidden
            className="h-1.5 w-2.5 shrink-0 rounded-sm"
            style={{ background: s.color }}
          />
          {s.name ?? s.key}
        </span>
      ))}
    </div>
  )
}

function useGradientIds(count: number): string[] {
  const idsRef = React.useRef<string[]>([])
  if (idsRef.current.length !== count) {
    idsRef.current = Array.from({ length: count }, () => `grad-${++gradientCounter}`)
  }
  return idsRef.current
}

function Series({ series, ids }: { series: SeriesDef[]; ids: string[] }): React.JSX.Element {
  return (
    <>
      {series.map((s, i) => (
        <Area
          key={s.key}
          type="monotone"
          dataKey={s.key}
          name={s.name ?? s.key}
          stroke={s.color}
          strokeWidth={1.5}
          fill={`url(#${ids[i]})`}
          isAnimationActive={false}
          dot={false}
        />
      ))}
    </>
  )
}

function Gradients({ series, ids }: { series: SeriesDef[]; ids: string[] }): React.JSX.Element {
  return (
    <defs>
      {series.map((s, i) => (
        <linearGradient key={s.key} id={ids[i]} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={s.color} stopOpacity={0.45} />
          <stop offset="100%" stopColor={s.color} stopOpacity={0.03} />
        </linearGradient>
      ))}
    </defs>
  )
}

/**
 * Compact area chart for the Overview cards. Both axes are labelled - even
 * here, because a curve without a scale and without a time range says
 * nothing about what it is showing.
 */
export function Sparkline({
  data,
  series,
  max,
  className,
  formatValue,
  legend
}: {
  data: ChartPoint[]
  series: SeriesDef[]
  max?: number
  className?: string
  formatValue?: (v: number) => string
  /** Defaults to on for multi-series charts. */
  legend?: boolean
}): React.JSX.Element {
  const ids = useGradientIds(series.length)
  const value = useValueAxis(data, series, max, 3)
  const time = useTimeAxis(data, 3)
  const fmt = formatValue ?? ((v: number) => v.toFixed(0))
  return (
    <>
      {/* Taller than the plot alone needs: the two axes take a strip each. */}
      <div className={cn('h-28 w-full', className)}>
        <ResponsiveContainer width="100%" height="100%">
          {/* The top margin is the room the highest value label needs: it is
              centred on the top gridline and would be clipped otherwise. */}
          <AreaChart data={data} margin={CARD_MARGIN}>
            <Gradients series={series} ids={ids} />
            <Grid xTicks={time.ticks} />
            {/* tickSize still offsets the labels when the tick lines are off,
                which pushes them out of the strip reserved for the axis. */}
            <YAxis
              domain={[0, value.top]}
              ticks={distinct(value.ticks, fmt)}
              tickFormatter={fmt}
              tick={AXIS_TICK}
              width={54}
              tickSize={0}
              tickMargin={GAP}
              axisLine={false}
              tickLine={false}
            />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={['dataMin', 'dataMax']}
              ticks={distinct(time.ticks, time.format)}
              tickFormatter={time.format}
              tick={AXIS_TICK}
              height={TIME_STRIP}
              tickSize={0}
              tickMargin={GAP}
              interval="preserveStartEnd"
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              isAnimationActive={false}
              contentStyle={TOOLTIP_STYLE}
              labelFormatter={(t) => tooltipTime(Number(t))}
              formatter={(v, name) => [fmt(Number(v)), String(name)]}
            />
            <Series series={series} ids={ids} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      {(legend ?? series.length > 1) && <Legend series={series} />}
    </>
  )
}

/** Larger chart with labelled time and value axes, for the detail tabs. */
export function DetailChart({
  data,
  series,
  max,
  height = 'h-36',
  formatValue,
  legend
}: {
  data: ChartPoint[]
  series: SeriesDef[]
  max?: number
  height?: string
  formatValue?: (v: number) => string
  /** Defaults to on for multi-series charts. */
  legend?: boolean
}): React.JSX.Element {
  const ids = useGradientIds(series.length)
  const value = useValueAxis(data, series, max, 4)
  const time = useTimeAxis(data, 5)
  const fmt = formatValue ?? ((v: number) => v.toFixed(0))
  return (
    <>
      <div className={cn('w-full', height)}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={DETAIL_MARGIN}>
            <Gradients series={series} ids={ids} />
            <Grid xTicks={time.ticks} />
            <YAxis
              domain={[0, value.top]}
              ticks={distinct(value.ticks, fmt)}
              tickFormatter={fmt}
              tick={AXIS_TICK}
              width={58}
              tickSize={0}
              tickMargin={GAP}
              axisLine={false}
              tickLine={false}
            />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={['dataMin', 'dataMax']}
              ticks={distinct(time.ticks, time.format)}
              tickFormatter={time.format}
              tick={AXIS_TICK}
              height={TIME_STRIP}
              tickSize={0}
              tickMargin={GAP}
              interval="preserveStartEnd"
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              isAnimationActive={false}
              contentStyle={TOOLTIP_STYLE}
              labelFormatter={(t) => tooltipTime(Number(t))}
              formatter={(v, name) => [fmt(Number(v)), String(name)]}
            />
            <Series series={series} ids={ids} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      {(legend ?? series.length > 1) && <Legend series={series} />}
    </>
  )
}

/** Thin horizontal usage bar. */
export function MeterBar({
  pct,
  color,
  className
}: {
  pct: number
  color?: string
  className?: string
}): React.JSX.Element {
  const clamped = Math.min(100, Math.max(0, pct))
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-input', className)}>
      <div
        className="h-full rounded-full transition-[width] duration-300"
        style={{
          width: `${clamped}%`,
          background:
            color ??
            (clamped >= 90
              ? 'var(--color-bad)'
              : clamped >= 70
                ? 'var(--color-warn)'
                : 'var(--color-accent)')
        }}
      />
    </div>
  )
}
