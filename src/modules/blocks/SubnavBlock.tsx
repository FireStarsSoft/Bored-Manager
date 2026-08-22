import * as React from 'react'
import type { SubnavBlock } from '@shared/module-ui'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { iconByName } from '@/lib/module-registry'
import { BlockList, type BlockCtx } from '../BlockRenderer'

function defaultItemId(block: SubnavBlock): string {
  if (block.initial && block.items.some((item) => item.id === block.initial)) return block.initial
  return block.items[0]?.id ?? ''
}

export function SubnavBlockView({
  block,
  ctx
}: {
  block: SubnavBlock
  ctx: BlockCtx
}): React.JSX.Element {
  const [selectedId, setSelectedId] = React.useState(() => defaultItemId(block))
  const activeId = block.items.some((item) => item.id === selectedId)
    ? selectedId
    : defaultItemId(block)

  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-md border border-border md:flex-row">
      <nav
        aria-label="Page sections"
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-border p-2 md:w-44 md:flex-col md:overflow-x-visible md:border-b-0 md:border-r"
      >
        {block.items.map((item) => {
          const Icon = item.icon ? iconByName(item.icon) : null
          const current = item.id === activeId
          return (
            <Button
              key={item.id}
              type="button"
              variant={current ? 'secondary' : 'ghost'}
              size="sm"
              aria-current={current ? 'page' : undefined}
              className={cn('shrink-0 md:w-full md:justify-start', !current && 'text-muted-foreground')}
              onClick={() => setSelectedId(item.id)}
            >
              {Icon && <Icon className="size-4 shrink-0" aria-hidden />}
              {item.label}
            </Button>
          )
        })}
      </nav>

      <div className="min-w-0 flex-1 p-3">
        {block.items.map((item) => {
          const current = item.id === activeId
          return (
            <div key={item.id} className={cn('grid min-w-0 grid-cols-1 gap-3', !current && 'hidden')}>
              <BlockList
                blocks={item.blocks}
                ctx={{ ...ctx, visible: ctx.visible && current }}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
