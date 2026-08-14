import * as React from 'react'
import type { KeyValueBlock } from '@shared/module-ui'
import { resolvePath, useBlockData } from '../binding'
import type { BlockCtx } from '../BlockRenderer'
import { BlockValue } from './value-cell'

export function KeyValueBlockView({ block, ctx }: { block: KeyValueBlock; ctx: BlockCtx }): React.JSX.Element {
  const data = useBlockData(ctx.moduleId, block.source, ctx)
  return (
    <dl className="flex flex-col gap-1 text-xs">
      {block.rows.map((row) => (
        <div key={row.key} className="flex justify-between gap-3">
          <dt className="shrink-0 text-muted-foreground">{row.label}</dt>
          <dd className="min-w-0 text-right">
            <BlockValue format={row.format} value={resolvePath(data, row.key)} />
          </dd>
        </div>
      ))}
    </dl>
  )
}
