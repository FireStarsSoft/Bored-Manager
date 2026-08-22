// Adapted from Tremor DonutChart [v1.0.0] - github.com/tremorlabs/tremor (Apache-2.0)
//
// Differences from upstream, all of them deliberate:
//   * no "use client" - this is a Vite SPA, not Next.js
//   * `cn` from @/lib/utils instead of Tremor's `cx`
//   * colours come from the theme tokens in chart-colors.ts, not from the
//     Tailwind default palette
//   * animation is off (upstream already did this)
//   * dropped click-to-filter (`onValueChange`, active/inactive shapes) — a
//     live Overview card is not a drill-down
//   * dropped tooltipCallback / customTooltip; the tooltip matches AreaChart
//   * `labelCaption` sits under the centre total (upstream is one string)
//   * sized by the parent (`h-full w-full`) instead of a fixed 11rem box
import * as React from 'react'
import { Pie, PieChart as RechartsDonutChart, ResponsiveContainer, Tooltip } from 'recharts'
import { cn } from '@/lib/utils'
import {
  AvailableChartColors,
  constructCategoryColors,
  getColorClassName,
  type ChartColor
} from './chart-colors'

function sumValues(data: Array<Record<string, string | number>>, valueKey: string): number {
  return data.reduce((sum, point) => {
    const n = Number(point[valueKey])
    return sum + (Number.isFinite(n) ? n : 0)
  }, 0)
}

function parseData(
  data: Array<Record<string, string | number>>,
  categoryColors: Map<string, ChartColor>,
  category: string
): Array<Record<string, string | number> & { className: string }> {
  return data.map((point) => {
    const color = categoryColors.get(String(point[category])) ?? 'primary'
    return {
      ...point,
      className: getColorClassName(color, 'fill')
    }
  })
}

interface TooltipEntry {
  category: string
  value: number
  color: ChartColor
}

function ChartTooltip({
  active,
  entries,
  valueFormatter
}: {
  active: boolean | undefined
  entries: TooltipEntry[]
  valueFormatter: (value: number) => string
}): React.JSX.Element | null {
  if (!active || entries.length === 0) return null
  return (
    <div className="rounded-md border border-border bg-popover text-xs shadow-md">
      <div className="flex flex-col gap-1 px-2.5 py-1.5">
        {entries.map((entry) => (
          <div key={entry.category} className="flex items-center justify-between gap-6">
            <div className="flex items-center gap-1.5">
              <span
                aria-hidden
                className={cn('h-2 w-2 shrink-0 rounded-full', getColorClassName(entry.color, 'bg'))}
              />
              <span className="whitespace-nowrap text-muted-foreground">{entry.category}</span>
            </div>
            <span className="whitespace-nowrap font-medium tabular-nums">
              {valueFormatter(entry.value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export interface DonutChartProps extends React.HTMLAttributes<HTMLDivElement> {
  data: Array<Record<string, string | number>>
  /** Key holding the slice name. */
  category: string
  /** Key holding the numeric value. */
  value: string
  colors?: ChartColor[]
  variant?: 'donut' | 'pie'
  valueFormatter?: (value: number) => string
  /** Centre number; omit to print the sum of the slices. */
  label?: string
  /** Second line under `label` (e.g. "Machines"). Donut only. */
  labelCaption?: string
  showLabel?: boolean
  showTooltip?: boolean
}

export function DonutChart({
  data,
  category,
  value,
  colors = AvailableChartColors,
  variant = 'donut',
  valueFormatter = (n) => String(n),
  label,
  labelCaption,
  showLabel = false,
  showTooltip = true,
  className,
  ...other
}: DonutChartProps): React.JSX.Element {
  const isDonut = variant === 'donut'
  const categories = data.map((item) => String(item[category]))
  const categoryColors = constructCategoryColors(categories, colors)
  const parsed = parseData(data, categoryColors, category)
  const centre = label ?? valueFormatter(sumValues(data, value))

  return (
    <div className={cn('h-full w-full', className)} {...other}>
      <ResponsiveContainer width="100%" height="100%">
        <RechartsDonutChart margin={{ top: 0, left: 0, right: 0, bottom: 0 }}>
          {showLabel && isDonut && (
            <>
              <text
                className="fill-foreground text-lg font-semibold"
                x="50%"
                y={labelCaption ? '46%' : '50%'}
                textAnchor="middle"
                dominantBaseline="middle"
              >
                {centre}
              </text>
              {labelCaption && (
                <text
                  className="fill-muted-foreground text-[0.65rem]"
                  x="50%"
                  y="62%"
                  textAnchor="middle"
                  dominantBaseline="middle"
                >
                  {labelCaption}
                </text>
              )}
            </>
          )}
          <Pie
            className="stroke-card [&_.recharts-pie-sector]:outline-hidden"
            data={parsed}
            cx="50%"
            cy="50%"
            startAngle={90}
            endAngle={-270}
            innerRadius={isDonut ? '72%' : '0%'}
            outerRadius="100%"
            stroke=""
            strokeLinejoin="round"
            dataKey={value}
            nameKey={category}
            isAnimationActive={false}
            style={{ outline: 'none' }}
          />
          {showTooltip && (
            <Tooltip
              wrapperStyle={{ outline: 'none' }}
              isAnimationActive={false}
              content={({ active, payload }) => {
                const entries: TooltipEntry[] = (payload ?? []).map((item) => {
                  const row = item.payload as Record<string, string | number>
                  const name = String(row[category] ?? '')
                  return {
                    category: name,
                    value: Number(item.value) || 0,
                    color: categoryColors.get(name) ?? 'primary'
                  }
                })
                return <ChartTooltip active={active} entries={entries} valueFormatter={valueFormatter} />
              }}
            />
          )}
        </RechartsDonutChart>
      </ResponsiveContainer>
    </div>
  )
}
