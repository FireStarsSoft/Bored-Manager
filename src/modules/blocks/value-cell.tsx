import * as React from 'react'
import type { ValueBadge, ValueFormat } from '@shared/module-ui'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { formatBlockValue } from '../format'

function toBadges(value: unknown): ValueBadge[] {
  if (!Array.isArray(value)) return []
  const out: ValueBadge[] = []
  for (const entry of value) {
    if (typeof entry === 'string') {
      out.push({ label: entry })
      continue
    }
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as { label?: unknown; color?: unknown }
    if (typeof e.label !== 'string' || !e.label) continue
    out.push({ label: e.label, color: typeof e.color === 'string' ? e.color : undefined })
  }
  return out
}

/**
 * Every value a block paints goes through here. Almost all of them are a
 * string from `formatBlockValue`; `badges` is the one that has to be markup,
 * because the colours are the user's own data and cannot come from a token.
 */
export function BlockValue({
  format,
  value,
  className
}: {
  format: ValueFormat | undefined
  value: unknown
  className?: string
}): React.ReactNode {
  if (format !== 'badges') return formatBlockValue(format, value)
  const badges = toBadges(value)
  if (badges.length === 0) return <span className="text-muted-foreground">—</span>
  return (
    // Does not wrap by default: in a table this sits in a truncating cell, and
    // a second line there would make one row taller than the rest.
    <span className={cn('inline-flex items-center gap-1 align-middle', className)}>
      {badges.map((badge, i) => (
        <Badge
          key={`${badge.label}-${i}`}
          variant="outline"
          className="h-4 px-1.5 text-[0.6875rem] font-normal"
          style={
            badge.color
              ? {
                  borderColor: badge.color,
                  color: badge.color,
                  backgroundColor: `color-mix(in oklab, ${badge.color} 14%, transparent)`
                }
              : undefined
          }
        >
          {badge.label}
        </Badge>
      ))}
    </span>
  )
}
