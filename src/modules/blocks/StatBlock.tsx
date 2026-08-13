import * as React from 'react'
import { Gauge } from 'lucide-react'
import type { DataSource, StatBlock } from '@shared/module-ui'
import type { ChartPoint } from '@/components/charts'
import { StatCard } from '@/components/StatCard'
import { useBlockData } from '../binding'
import { formatBlockValue } from '../format'
import type { BlockCtx } from '../BlockRenderer'

/** Used when the block has no `spark`, so the hook is still called every render (rules of hooks). */
const NO_SOURCE: DataSource = { kind: 'core', stream: 'system' }

export function StatBlockView({ block, ctx }: { block: StatBlock; ctx: BlockCtx }): React.JSX.Element {
  const value = useBlockData(ctx.moduleId, block.source, ctx)
  const sparkValue = useBlockData(ctx.moduleId, block.spark?.source ?? NO_SOURCE, ctx)
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
      color="var(--color-accent)"
      value={formatBlockValue(block.format, value)}
      data={block.spark ? sparkPoints : undefined}
      series={block.spark ? [{ key: 'v', color: 'var(--color-accent)' }] : undefined}
      formatValue={(v) => formatBlockValue(block.format, v)}
    />
  )
}
