import * as React from 'react'
import type { ChartBlock, ChartSeriesDecl } from '@shared/module-ui'
import { DetailChart, Sparkline, type ChartColor, type ChartPoint, type SeriesDef } from '@/components/charts'
import { BlockData } from '../binding'
import { BLOCK_PALETTE, formatBlockValue } from '../format'
import type { BlockCtx } from '../BlockRenderer'

function chartFormatter(block: ChartBlock): (v: number) => string {
  const decimals = block.decimals ?? 0
  const unit = block.unit ?? block.series?.[0]?.unit
  return (v: number): string =>
    block.format
      ? formatBlockValue(block.format, v)
      : unit
        ? `${v.toFixed(decimals)} ${unit}`
        : v.toFixed(decimals)
}

function seriesFormatter(block: ChartBlock, series: ChartSeriesDecl): (v: number) => string {
  const decimals = block.decimals ?? 0
  if (series.format) return (v) => formatBlockValue(series.format, v)
  if (series.unit) return (v) => `${v.toFixed(decimals)} ${series.unit}`
  return chartFormatter(block)
}

/**
 * When a spec omits `series`, take numeric keys off the newest point so a
 * machine-dependent set of sensors can share one chart without listing them.
 */
function inferSeries(data: ChartPoint[], limit: number): SeriesDef[] {
  const last = data.at(-1)
  if (!last) return []
  const keys = Object.keys(last).filter((k) => k !== 't' && typeof last[k] === 'number')
  return keys.slice(0, limit).map((key, i) => ({
    key,
    color: BLOCK_PALETTE[i % BLOCK_PALETTE.length],
    name: key
  }))
}

const EMPTY_DATA: ChartPoint[] = []

/**
 * Renders every declared `kind` (line/area/bar) as the app's one area-chart
 * primitive - `src/components/charts.tsx` does not have line/bar variants,
 * and the UI rules say to reuse it rather than start a second chart stack.
 */
export function ChartBlockView({ block, ctx }: { block: ChartBlock; ctx: BlockCtx }): React.JSX.Element {
  const windowSec = block.window ?? ctx.windowSec
  return (
    <div>
      {block.title && (
        <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{block.title}</div>
      )}
      {!ctx.visible ? (
        <div className={ctx.compact ? 'h-28' : 'h-36'} aria-hidden />
      ) : (
        <BlockData
          moduleId={ctx.moduleId}
          source={block.source}
          opts={{ visible: true, windowSec, scope: ctx.scope }}
        >
          {({ value }) => <LiveChart block={block} compact={ctx.compact} value={value} />}
        </BlockData>
      )}
    </div>
  )
}

function LiveChart({
  block,
  compact,
  value
}: {
  block: ChartBlock
  compact: boolean
  value: unknown
}): React.JSX.Element {
  const data = Array.isArray(value) ? (value as ChartPoint[]) : EMPTY_DATA
  const declaredSeries = React.useMemo<SeriesDef[]>(
    () =>
      (block.series ?? []).map((series, index) => ({
        key: series.key,
        color:
          (series.color as ChartColor | undefined) ??
          BLOCK_PALETTE[index % BLOCK_PALETTE.length],
        name: series.label,
        axis: series.axis,
        formatValue: seriesFormatter(block, series)
      })),
    [block]
  )
  const inferredSeries = React.useMemo(
    () => inferSeries(data, block.maxSeries ?? Number.POSITIVE_INFINITY),
    [data, block.maxSeries]
  )
  const series = declaredSeries.length > 0 ? declaredSeries : inferredSeries
  // `format` (bytes/rate/pct/temp/number) scales the value like every other block;
  // a series' own `unit` (or the chart-level `unit` when series are inferred)
  // is only a literal suffix, for whatever `format` cannot express.
  const formatValue = React.useMemo(() => chartFormatter(block), [block])

  return compact ? (
    <Sparkline data={data} series={series} formatValue={formatValue} />
  ) : (
    <DetailChart data={data} series={series} formatValue={formatValue} />
  )
}
