import * as React from 'react'
import type { ListBlock } from '@shared/module-ui'
import { cn } from '@/lib/utils'
import { useBlockData } from '../binding'
import { formatBlockValue } from '../format'
import type { BlockCtx } from '../BlockRenderer'

export function ListBlockView({ block, ctx }: { block: ListBlock; ctx: BlockCtx }): React.JSX.Element {
  const raw = useBlockData(ctx.moduleId, block.source, ctx)
  const rows = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : []
  const shown = block.limit ? rows.slice(0, block.limit) : rows

  if (shown.length === 0) {
    return <div className="text-xs text-muted">{block.emptyText ?? 'Nothing to show yet'}</div>
  }

  return (
    <div className="divide-y divide-border/40 text-xs">
      {shown.map((row, i) => (
        <div key={i} className="flex items-center gap-2 py-1">
          {block.columns.map((col, ci) => (
            <span
              key={col.key}
              className={cn(
                ci === 0 ? 'min-w-0 flex-1 truncate' : 'shrink-0 font-medium tabular-nums',
                col.align === 'right' && 'text-right'
              )}
            >
              {formatBlockValue(col.format, row[col.key])}
            </span>
          ))}
        </div>
      ))}
    </div>
  )
}
