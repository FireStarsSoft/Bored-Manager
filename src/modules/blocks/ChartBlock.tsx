import * as React from 'react'
import type { ChartBlock } from '@shared/module-ui'
import { DetailChart, Sparkline, type ChartPoint, type SeriesDef } from '@/components/charts'
import { useBlockData } from '../binding'
import { BLOCK_PALETTE, formatBlockValue } from '../format'
import type { BlockCtx } from '../BlockRenderer'

/**
 * Renders every declared `kind` (line/area/bar) as the app's one area-chart
 * primitive - `src/components/charts.tsx` does not have line/bar variants,
 * and the UI rules say to reuse it rather than start a second chart stack.
 */
export function ChartBlockView({ block, ctx }: { block: ChartBlock; ctx: BlockCtx }): React.JSX.Element {
  const windowSec = block.window ?? ctx.windowSec
  const raw = useBlockData(ctx.moduleId, block.source, { visible: ctx.visible, windowSec, scope: ctx.scope })
  const data = Array.isArray(raw) ? (raw as ChartPoint[]) : []
  const series: SeriesDef[] = block.series.map((s, i) => ({
    key: s.key,
    color: BLOCK_PALETTE[i % BLOCK_PALETTE.length],
    name: s.label
  }))
  // `format` (bytes/rate/pct/temp/number) scales the value like every other block;
  // a series' own `unit` is only a literal suffix, for whatever `format` cannot express.
  const unit = block.series[0]?.unit
  const formatValue = (v: number): string =>
    block.format ? formatBlockValue(block.format, v) : unit ? `${v.toFixed(0)} ${unit}` : v.toFixed(0)

  return (
    <div>
      {block.title && (
        <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted">{block.title}</div>
      )}
      {ctx.compact ? (
        <Sparkline data={data} series={series} formatValue={formatValue} />
      ) : (
        <DetailChart data={data} series={series} formatValue={formatValue} />
      )}
    </div>
  )
}
