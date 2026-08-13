import * as React from 'react'
import type { MeterBlock } from '@shared/module-ui'
import { MeterBar } from '@/components/charts'
import { useBlockData } from '../binding'
import { formatBlockValue } from '../format'
import type { BlockCtx } from '../BlockRenderer'

export function MeterBlockView({ block, ctx }: { block: MeterBlock; ctx: BlockCtx }): React.JSX.Element {
  const value = useBlockData(ctx.moduleId, block.source, ctx)
  const num = typeof value === 'number' ? value : Number(value) || 0
  const max = block.max ?? 100
  const pct = max > 0 ? (num / max) * 100 : 0

  return (
    <div className="flex items-center gap-2 py-0.5 text-xs">
      <span className="min-w-0 flex-1 truncate">{block.label}</span>
      <div className="w-24 shrink-0">
        <MeterBar pct={pct} />
      </div>
      <span className="w-16 shrink-0 text-right font-medium">{formatBlockValue(block.format, value)}</span>
    </div>
  )
}
