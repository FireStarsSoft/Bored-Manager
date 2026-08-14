import * as React from 'react'
import { GripVertical } from 'lucide-react'
import { IntervalBadge } from '@/components/IntervalBadge'
import { Card } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * Grip that react-grid-layout uses as the drag handle. Every Overview card has
 * to render one somewhere, or it cannot be moved.
 */
export function DragHandle(): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label="Drag to rearrange"
        className="tm-drag-handle -ml-1 cursor-grab text-muted-foreground/30 transition-colors hover:text-muted-foreground active:cursor-grabbing"
        onClick={(e) => e.stopPropagation()}
      >
        <GripVertical className="size-3.5" aria-hidden />
      </TooltipTrigger>
      <TooltipContent>Drag to rearrange</TooltipContent>
    </Tooltip>
  )
}

/**
 * Header + body wrapper for an Overview card that is not a StatCard: title,
 * icon, drag handle and optionally the interval it is refreshed on. Modules
 * use this so their widgets look like the app's own.
 */
export function SectionCard({
  title,
  icon: Icon,
  iconClass,
  fast,
  onClick,
  children
}: {
  title: string
  icon: React.ComponentType<{ className?: string }>
  iconClass: string
  /** Which fast interval feeds this card. */
  fast?: string
  onClick?: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Card
      onClick={onClick}
      className={cn('p-3', onClick && 'cursor-pointer transition-colors hover:bg-accent')}
    >
      <div className="mb-2 flex min-w-0 items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <DragHandle />
        <Icon className={`size-3.5 ${iconClass}`} />
        <span className="truncate">{title}</span>
        {fast && <IntervalBadge fast={fast} />}
      </div>
      {children}
    </Card>
  )
}
