import * as React from 'react'
import { Gauge } from 'lucide-react'
import type { StatBlock } from '@shared/module-ui'
import type { ChartPoint } from '@/components/charts'
import { StatCard } from '@/components/StatCard'
import { BlockData } from '../binding'
import { formatBlockValue } from '../format'
import type { BlockCtx } from '../BlockRenderer'

export function StatBlockView({ block, ctx }: { block: StatBlock; ctx: BlockCtx }): React.JSX.Element {
  return (
    <BlockData moduleId={ctx.moduleId} source={block.source} opts={ctx}>
      {({ value }) =>
        block.spark && ctx.visible ? (
          <BlockData moduleId={ctx.moduleId} source={block.spark.source} opts={ctx}>
            {({ value: sparkValue }) => (
              <StatContent block={block} value={value} sparkValue={sparkValue} />
            )}
          </BlockData>
        ) : (
          <StatContent block={block} value={value} />
        )
      }
    </BlockData>
  )
}

function StatContent({
  block,
  value,
  sparkValue
}: {
  block: StatBlock
  value: unknown
  sparkValue?: unknown
}): React.JSX.Element {
  const sparkKey = block.spark?.key

  const sparkPoints = React.useMemo<ChartPoint[]>(() => {
    if (!block.spark || !Array.isArray(sparkValue)) return []
    return (sparkValue as Array<Record<string, unknown>>)
      .filter((p) => p && typeof p === 'object' && typeof p['t'] === 'number')
      .map((p) => ({ t: p['t'] as number, v: Number(p[sparkKey as string]) || 0 }))
  }, [block.spark, sparkValue, sparkKey])

  return (
    <StatCard
      title={block.label}
      icon={Gauge}
      color="primary"
      value={formatBlockValue(block.format, value)}
      data={block.spark ? sparkPoints : undefined}
      series={block.spark ? [{ key: 'v', color: 'primary' }] : undefined}
      formatValue={(v) => formatBlockValue(block.format, v)}
    />
  )
}
