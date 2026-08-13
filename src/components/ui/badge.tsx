import * as React from 'react'
import { cn } from '@/lib/utils'

const kinds = {
  default: 'bg-card-hover text-muted border-border',
  good: 'bg-good/10 text-good border-good/30',
  warn: 'bg-warn/10 text-warn border-warn/30',
  bad: 'bg-bad/10 text-bad border-bad/30',
  accent: 'bg-accent/10 text-accent border-accent/30'
} as const

export function Badge({
  kind = 'default',
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { kind?: keyof typeof kinds }): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-px text-[0.7rem] font-medium leading-4',
        kinds[kind],
        className
      )}
      {...props}
    />
  )
}
