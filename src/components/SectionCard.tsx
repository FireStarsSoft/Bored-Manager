import * as React from 'react'
import { GripVertical } from 'lucide-react'
import { IntervalBadge } from '@/components/IntervalBadge'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/**
 * Grip that react-grid-layout uses as the drag handle. Every Overview card has
 * to render one somewhere, or it cannot be moved.
 */
export function DragHandle(): React.JSX.Element {
  return (
    <span
      className="tm-drag-handle -ml-1 cursor-grab text-muted/30 transition-colors hover:text-muted active:cursor-grabbing"
      title="Drag to rearrange"
      onClick={(e) => e.stopPropagation()}
    >
      <GripVertical className="h-3.5 w-3.5" />
    </span>
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
  action,
  onClick,
  children
}: {
  title: string
  icon: React.ComponentType<{ className?: string }>
  iconClass: string
  /** Which fast interval feeds this card; omitted when `action` says it. */
  fast?: string
  action?: React.ReactNode
  onClick?: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Card
      onClick={onClick}
      className={cn('p-3', onClick && 'cursor-pointer transition-colors hover:bg-card-hover')}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
          <DragHandle />
          <Icon className={`h-3.5 w-3.5 ${iconClass}`} />
          <span className="truncate">{title}</span>
          {fast && <IntervalBadge fast={fast} />}
        </div>
        {action}
      </div>
      {children}
    </Card>
  )
}
