import * as React from 'react'
import { Info, TriangleAlert } from 'lucide-react'
import type { NoteBlock } from '@shared/module-ui'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { BlockCtx } from '../BlockRenderer'

export function NoteBlockView({ block, ctx }: { block: NoteBlock; ctx: BlockCtx }): React.JSX.Element {
  const warning = block.tone === 'warning'
  const Icon = warning ? TriangleAlert : Info

  return (
    <Card
      className={cn(
        'flex flex-row gap-2 border-border bg-muted p-3',
        warning && 'border-warning/40 bg-warning/10',
        ctx.compact && 'gap-1.5 p-2'
      )}
    >
      <Icon
        className={cn('mt-0.5 size-4 shrink-0', warning ? 'text-warning' : 'text-primary')}
        aria-hidden
      />
      <div className="flex min-w-0 flex-col gap-1">
        {block.title && <div className="text-xs font-semibold text-foreground">{block.title}</div>}
        {block.lines.map((line, index) => (
          <p key={index} className="text-xs text-muted-foreground">
            {line}
          </p>
        ))}
      </div>
    </Card>
  )
}
