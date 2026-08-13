import * as React from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Controlled disclosure: a trigger button plus content. Written here rather
 * than pulled in as a package - the sidebar is the only consumer (T4.1).
 */

const CollapsibleContext = React.createContext<{
  open: boolean
  onOpenChange: (open: boolean) => void
} | null>(null)

function useCollapsible(): { open: boolean; onOpenChange: (open: boolean) => void } {
  const ctx = React.useContext(CollapsibleContext)
  if (!ctx) throw new Error('CollapsibleTrigger and CollapsibleContent must be used inside Collapsible')
  return ctx
}

export function Collapsible({
  open,
  onOpenChange,
  className,
  children
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  const value = React.useMemo(() => ({ open, onOpenChange }), [open, onOpenChange])
  return (
    <CollapsibleContext.Provider value={value}>
      <div data-state={open ? 'open' : 'closed'} className={className}>
        {children}
      </div>
    </CollapsibleContext.Provider>
  )
}

export function CollapsibleTrigger({
  className,
  children,
  onClick,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  const { open, onOpenChange } = useCollapsible()
  return (
    <button
      {...props}
      type="button"
      aria-expanded={open}
      className={cn('flex items-center', className)}
      onClick={(e) => {
        onClick?.(e)
        if (!e.defaultPrevented) onOpenChange(!open)
      }}
    >
      {children}
      <ChevronRight
        className={cn('ml-auto h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-90')}
        aria-hidden
      />
    </button>
  )
}

export function CollapsibleContent({
  className,
  children
}: {
  className?: string
  children: React.ReactNode
}): React.JSX.Element | null {
  const { open } = useCollapsible()
  if (!open) return null
  return <div className={className}>{children}</div>
}
