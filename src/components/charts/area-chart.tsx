// Adapted from Tremor AreaChart [v1.0.0] - github.com/tremorlabs/tremor (Apache-2.0)
//
// Differences from upstream, all of them deliberate:
//   * no "use client" - this is a Vite SPA, not Next.js
//   * `cn` from @/lib/utils instead of Tremor's `cx`
//   * colours come from the theme tokens in chart-colors.ts, not from the
//     Tailwind default palette
//   * `timeAxis` renders the index as a real time scale with interpolated
//     ticks. Upstream's categorical axis makes labels jump on every sample,
//     which is unreadable on a monitor that redraws once a second.
//   * animation is off, for the same reason
//   * dropped the pieces this app has no use for: legend slider, click-to-
//     filter, active dots, percent stacking, axis labels
import * as React from 'react'
import {
  Area,
  CartesianGrid,
  AreaChart as RechartsAreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import type { AxisDomain } from 'recharts/types/util/types'
import { cn } from '@/lib/utils'
import {
  AvailableChartColors,
  constructCategoryColors,
  getColorClassName,
  type ChartColor
} from './chart-colors'

export interface AreaChartSeries {
  /** Key in each datum. */
  category: string
  label?: string
  color?: ChartColor
  /** Omit or `left` for the only / left axis. `right` adds a second Y-axis. */
  axis?: 'left' | 'right'
}

interface TooltipEntry {
  category: string
  label: string
  value: number
  color: ChartColor
}

function ChartTooltip({
  active,
  label,
  entries,
  valueFormatter
}: {
  active: boolean | undefined
  label: string
  entries: TooltipEntry[]
  valueFormatter: (value: number, category: string) => string
}): React.JSX.Element | null {
  if (!active || entries.length === 0) return null
  return (
    <div className="rounded-md border border-border bg-popover text-xs shadow-md">
      <div className="border-b border-inherit px-2.5 py-1.5 font-medium">{label}</div>
      <div className="flex flex-col gap-1 px-2.5 py-1.5">
        {entries.map((entry) => (
          <div key={entry.category} className="flex items-center justify-between gap-6">
            <div className="flex items-center gap-1.5">
              <span
                aria-hidden
                className={cn('h-[3px] w-3.5 shrink-0 rounded-full', getColorClassName(entry.color, 'bg'))}
              />
              <span className="whitespace-nowrap text-muted-foreground">{entry.label}</span>
            </div>
            <span className="whitespace-nowrap font-medium tabular-nums">
              {valueFormatter(entry.value, entry.category)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Colour key under a chart; without it a pair of areas is a guessing game. */
export function ChartLegend({
  series,
  categoryColors,
  className
}: {
  series: AreaChartSeries[]
  categoryColors: Map<string, ChartColor>
  className?: string
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[0.65rem] text-muted-foreground',
        className
      )}
    >
      {series.map((s) => (
        <span key={s.category} className="flex items-center gap-1">
          <span
            aria-hidden
            className={cn(
              'h-1.5 w-2.5 shrink-0 rounded-sm',
              getColorClassName(categoryColors.get(s.category) ?? 'primary', 'bg')
            )}
          />
          {s.label ?? s.category}
        </span>
      ))}
    </div>
  )
}

export interface AreaChartProps extends React.HTMLAttributes<HTMLDivElement> {
  data: Array<Record<string, number>>
  /** Key holding the x value of each datum. */
  index: string
  series: AreaChartSeries[]
  valueFormatter?: (value: number, category?: string) => string
  /** Treat `index` as epoch milliseconds and lay the axis out in real time. */
  timeAxis?: boolean
  /** Interpolated x tick positions; pass with `timeAxis` to stop label jitter. */
  xTicks?: number[]
  xTickFormatter?: (value: number) => string
  /** Explicit y ticks, so 0 and 0.5 B/s do not both print as "0". */
  yTicks?: number[]
  minValue?: number
  maxValue?: number
  /** Right-axis ticks when any series uses `axis: 'right'`. */
  rightYTicks?: number[]
  rightMinValue?: number
  rightMaxValue?: number
  rightValueFormatter?: (value: number) => string
  autoMinValue?: boolean
  yAxisWidth?: number
  xAxisHeight?: number
  showXAxis?: boolean
  showYAxis?: boolean
  showGridLines?: boolean
  showTooltip?: boolean
  /** Overlaid by default; `stacked` sums the series into bands. */
  type?: 'default' | 'stacked'
  fill?: 'gradient' | 'solid' | 'none'
  tooltipLabelFormatter?: (value: number) => string
}

export function AreaChart({
  data,
  index,
  series,
  valueFormatter = (value) => String(value),
  timeAxis = false,
  xTicks,
  xTickFormatter,
  yTicks,
  minValue,
  maxValue,
  rightYTicks,
  rightMinValue,
  rightMaxValue,
  rightValueFormatter,
  autoMinValue = false,
  yAxisWidth = 54,
  xAxisHeight = 20,
  showXAxis = true,
  showYAxis = true,
  showGridLines = true,
  showTooltip = true,
  type = 'default',
  fill = 'gradient',
  tooltipLabelFormatter,
  className,
  ...other
}: AreaChartProps): React.JSX.Element {
  const categories = React.useMemo(() => series.map((s) => s.category), [series])
  const explicitColors = React.useMemo(
    () => series.map((s, i) => s.color ?? AvailableChartColors[i % AvailableChartColors.length]),
    [series]
  )
  const categoryColors = React.useMemo(
    () => constructCategoryColors(categories, explicitColors),
    [categories, explicitColors]
  )
  const labels = React.useMemo(
    () => new Map(series.map((s) => [s.category, s.label ?? s.category])),
    [series]
  )

  const stacked = type === 'stacked'
  const areaId = React.useId()
  const yAxisDomain = [autoMinValue ? 'auto' : (minValue ?? 0), maxValue ?? 'auto']
  // Dual-axis only when both sides have a series. A lone `right` falls back
  // to the single left axis so the plot is never left without a scale.
  const hasRight =
    series.some((s) => s.axis === 'right') && series.some((s) => (s.axis ?? 'left') !== 'right')
  const rightDomain = [autoMinValue ? 'auto' : (rightMinValue ?? 0), rightMaxValue ?? 'auto']
  const axisTick = {
    tickSize: 0,
    tickMargin: 8,
    tickLine: false,
    axisLine: false,
    className: 'text-[10px] fill-muted-foreground'
  } as const

  return (
    <div className={cn('h-full w-full', className)} {...other}>
      <ResponsiveContainer width="100%" height="100%">
        <RechartsAreaChart
          data={data}
          // Room for the topmost value label, which is centred on the top
          // gridline and would otherwise be clipped. Dual-axis: the right
          // YAxis width itself reserves the strip, so the margin stays thin.
          margin={{ top: 10, right: hasRight ? 4 : 14, bottom: 0, left: 4 }}
        >
          {showGridLines && (
            <CartesianGrid
              className="stroke-border"
              strokeDasharray="2 4"
              horizontal
              vertical={xTicks != null}
              verticalValues={xTicks}
              syncWithTicks={xTicks != null}
            />
          )}
          <XAxis
            hide={!showXAxis}
            dataKey={index}
            {...(timeAxis
              ? { type: 'number' as const, scale: 'time' as const, domain: ['dataMin', 'dataMax'] }
              : {})}
            ticks={xTicks}
            tickFormatter={xTickFormatter}
            height={xAxisHeight}
            interval="preserveStartEnd"
            // tickSize still offsets labels when the tick lines are hidden,
            // which pushes them out of the strip reserved for the axis.
            {...axisTick}
          />
          <YAxis
            hide={!showYAxis}
            {...(hasRight ? { yAxisId: 'left' } : {})}
            width={yAxisWidth}
            type="number"
            domain={yAxisDomain as AxisDomain}
            ticks={yTicks}
            tickFormatter={(v) => valueFormatter(v)}
            {...axisTick}
          />
          {hasRight && (
            <YAxis
              yAxisId="right"
              orientation="right"
              hide={!showYAxis}
              width={yAxisWidth}
              type="number"
              domain={rightDomain as AxisDomain}
              ticks={rightYTicks}
              tickFormatter={rightValueFormatter ?? ((v) => valueFormatter(v))}
              {...axisTick}
            />
          )}
          {showTooltip && (
            <Tooltip
              wrapperStyle={{ outline: 'none' }}
              isAnimationActive={false}
              cursor={{ className: 'stroke-border', strokeWidth: 1 }}
              offset={20}
              position={{ y: 0 }}
              content={({ active, payload, label }) => (
                <ChartTooltip
                  active={active}
                  label={
                    tooltipLabelFormatter
                      ? tooltipLabelFormatter(Number(label))
                      : String(label ?? '')
                  }
                  entries={(payload ?? []).map((item) => ({
                    category: String(item.dataKey),
                    label: labels.get(String(item.dataKey)) ?? String(item.dataKey),
                    value: Number(item.value),
                    color: categoryColors.get(String(item.dataKey)) ?? 'primary'
                  }))}
                  valueFormatter={(v, category) => valueFormatter(v, category)}
                />
              )}
            />
          )}
          {series.map((s) => {
            const color = categoryColors.get(s.category) ?? 'primary'
            const gradientId = `${areaId}-${s.category.replace(/[^a-zA-Z0-9]/g, '')}`
            return (
              <React.Fragment key={s.category}>
                {/* The `text-*` class is what `currentColor` resolves against,
                    so one token drives stroke and gradient alike. */}
                <defs>
                  <linearGradient
                    className={getColorClassName(color, 'text')}
                    id={gradientId}
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    {fill === 'none' ? (
                      <stop stopColor="currentColor" stopOpacity={0} />
                    ) : fill === 'solid' ? (
                      <stop stopColor="currentColor" stopOpacity={0.3} />
                    ) : (
                      <>
                        <stop offset="5%" stopColor="currentColor" stopOpacity={0.45} />
                        <stop offset="95%" stopColor="currentColor" stopOpacity={0.03} />
                      </>
                    )}
                  </linearGradient>
                </defs>
                <Area
                  className={getColorClassName(color, 'stroke')}
                  name={s.label ?? s.category}
                  type="monotone"
                  dataKey={s.category}
                  {...(hasRight ? { yAxisId: s.axis === 'right' ? 'right' : 'left' } : {})}
                  stroke=""
                  strokeWidth={1.5}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  isAnimationActive={false}
                  connectNulls={false}
                  stackId={stacked ? 'stack' : undefined}
                  fill={`url(#${gradientId})`}
                  dot={false}
                />
              </React.Fragment>
            )
          })}
        </RechartsAreaChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Exposed so a caller can render the legend outside the plot's height box. */
export function useCategoryColors(series: AreaChartSeries[]): Map<string, ChartColor> {
  return React.useMemo(
    () =>
      constructCategoryColors(
        series.map((s) => s.category),
        series.map((s, i) => s.color ?? AvailableChartColors[i % AvailableChartColors.length])
      ),
    [series]
  )
}
