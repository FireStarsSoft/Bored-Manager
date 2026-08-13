import * as React from 'react'
import { cn } from '@/lib/utils'
import { AreaChart, ChartLegend, useCategoryColors } from '@/components/charts/area-chart'
import { ProgressBar } from '@/components/charts/progress-bar'
import type { ChartColor } from '@/components/charts/chart-colors'

/**
 * The app's two chart shapes, on top of the Tremor-derived AreaChart in
 * ./charts/. Everything specific to a live system monitor lives here: a real
 * time axis whose labels do not jump as samples scroll past, and a value axis
 * whose top does not flicker on every new reading.
 */

export interface SeriesDef {
  key: string
  color: ChartColor
  name?: string
}

export interface ChartPoint {
  t: number
  [key: string]: number
}

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

function useAreaSeries(series: SeriesDef[]): Array<{
  category: string
  label: string
  color: ChartColor
}> {
  return React.useMemo(
    () => series.map((s) => ({ category: s.key, label: s.name ?? s.key, color: s.color })),
    [series]
  )
}

function TimeAreaChart({
  data,
  series,
  max,
  valueTicks,
  timeTickCount,
  yAxisWidth,
  formatValue,
  legend,
  heightClass
}: {
  data: ChartPoint[]
  series: SeriesDef[]
  max?: number
  valueTicks: number
  timeTickCount: number
  yAxisWidth: number
  formatValue?: (v: number) => string
  legend?: boolean
  heightClass: string
}): React.JSX.Element {
  const value = useValueAxis(data, series, max, valueTicks)
  const time = useTimeAxis(data, timeTickCount)
  const fmt = formatValue ?? ((v: number) => v.toFixed(0))
  const areaSeries = useAreaSeries(series)
  const categoryColors = useCategoryColors(areaSeries)

  return (
    <>
      {/* Taller than the plot alone needs: the two axes take a strip each. */}
      <div className={cn('w-full', heightClass)}>
        <AreaChart
          data={data}
          index="t"
          series={areaSeries}
          timeAxis
          xTicks={distinct(time.ticks, time.format)}
          xTickFormatter={time.format}
          yTicks={distinct(value.ticks, fmt)}
          maxValue={value.top}
          minValue={0}
          yAxisWidth={yAxisWidth}
          valueFormatter={fmt}
          tooltipLabelFormatter={tooltipTime}
        />
      </div>
      {(legend ?? series.length > 1) && (
        <ChartLegend series={areaSeries} categoryColors={categoryColors} />
      )}
    </>
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
  return (
    <TimeAreaChart
      data={data}
      series={series}
      max={max}
      valueTicks={3}
      timeTickCount={3}
      yAxisWidth={54}
      formatValue={formatValue}
      legend={legend}
      heightClass={cn('h-28', className)}
    />
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
  return (
    <TimeAreaChart
      data={data}
      series={series}
      max={max}
      valueTicks={4}
      timeTickCount={5}
      yAxisWidth={58}
      formatValue={formatValue}
      legend={legend}
      heightClass={height}
    />
  )
}

/**
 * Thin horizontal usage bar. Kept as a named export because Overview and the
 * `meter` block both ask for one by this name.
 */
export function MeterBar({
  pct,
  color,
  className
}: {
  pct: number
  color?: ChartColor
  className?: string
}): React.JSX.Element {
  return (
    <ProgressBar
      value={pct}
      color={color}
      threshold={color == null}
      className={className}
      aria-label="Usage"
    />
  )
}

export { ProgressBar } from '@/components/charts/progress-bar'
export type { ChartColor } from '@/components/charts/chart-colors'
