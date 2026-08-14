import * as React from 'react'
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react'
import type { ModuleCheckLevel } from '@shared/modules'
import { cn } from '@/lib/utils'

/**
 * The four levels a check can come back at, painted the same way wherever they
 * show up: installing a module (Settings) and a `checkForm` block's report.
 */
export const CHECK_ICON: Record<ModuleCheckLevel, React.ReactNode> = {
  pass: <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />,
  info: <Info className="mt-0.5 size-3.5 shrink-0 text-primary" />,
  warning: <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />,
  error: <XCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
}

/** Structurally both a `ModuleCheckItem` (install) and a `ModuleCheckFinding` (checkForm). */
export interface CheckListItem {
  level: ModuleCheckLevel
  label: string
  detail?: string
}

/** The worst level present, for a heading that has to sum the list up in one word. */
export function worstLevel(items: readonly CheckListItem[]): ModuleCheckLevel {
  if (items.some((i) => i.level === 'error')) return 'error'
  if (items.some((i) => i.level === 'warning')) return 'warning'
  if (items.some((i) => i.level === 'info')) return 'info'
  return 'pass'
}

export function CheckList({
  items,
  className
}: {
  items: readonly CheckListItem[]
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {items.map((item, i) => (
        <div key={i} className="flex items-start gap-2">
          {CHECK_ICON[item.level]}
          <div className="min-w-0">
            <div className="text-xs">{item.label}</div>
            {item.detail && (
              <div className="break-words text-xs text-muted-foreground">{item.detail}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
