import * as React from 'react'
import type { SectionBlock } from '@shared/module-ui'
import { Card } from '@/components/ui/card'
import { SlowRefresh } from '@/components/slow-refresh'
import { cn } from '@/lib/utils'
import { BlockList, type BlockCtx } from '../BlockRenderer'

/** Tailwind needs the literal class names in source - a template string would not survive the JIT scan. */
const COLUMN_CLASSES: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
  4: 'grid-cols-2 sm:grid-cols-4'
}

export function SectionBlockView({ block, ctx }: { block: SectionBlock; ctx: BlockCtx }): React.JSX.Element {
  return (
    <Card className="p-3">
      {(block.title || block.slowTarget) && (
        <div className="mb-2 flex items-center justify-between gap-2">
          {block.title ? (
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{block.title}</div>
          ) : (
            <span />
          )}
          {block.slowTarget && <SlowRefresh target={block.slowTarget} />}
        </div>
      )}
      <div className={cn('grid gap-3', COLUMN_CLASSES[block.columns ?? 1] ?? COLUMN_CLASSES[1])}>
        <BlockList blocks={block.blocks} ctx={ctx} />
      </div>
    </Card>
  )
}
