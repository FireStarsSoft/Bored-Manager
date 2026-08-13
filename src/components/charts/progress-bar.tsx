// Adapted from Tremor ProgressBar [v0.0.3] - github.com/tremorlabs/tremor (Apache-2.0)
//
// Differences from upstream: CVA instead of tailwind-variants (to match the
// rest of src/components/ui), theme tokens instead of the Tailwind palette, and
// a `threshold` variant that picks its own colour from the value - which is what
// a usage bar in this app almost always wants.
import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'
import type { ChartColor } from './chart-colors'
import { getColorClassName } from './chart-colors'

const progressBarVariants = cva('h-full rounded-full', {
  variants: {
    variant: {
      primary: 'bg-primary',
      neutral: 'bg-muted-foreground',
      warning: 'bg-warning',
      destructive: 'bg-destructive',
      success: 'bg-success'
    }
  },
  defaultVariants: { variant: 'primary' }
})

export interface ProgressBarProps
  extends Omit<React.ComponentProps<'div'>, 'children'>,
    VariantProps<typeof progressBarVariants> {
  value?: number
  max?: number
  /** Colour the bar by how full it is: >=90% bad, >=70% warning. */
  threshold?: boolean
  /** Paint from a series token instead of a variant (per-core CPU, say). */
  color?: ChartColor
  showAnimation?: boolean
  label?: string
}

export function ProgressBar({
  value = 0,
  max = 100,
  label,
  threshold = false,
  color,
  variant,
  showAnimation = true,
  className,
  ...props
}: ProgressBarProps): React.JSX.Element {
  const safeValue = Math.min(max, Math.max(value, 0))
  const pct = max ? (safeValue / max) * 100 : safeValue
  const resolved = threshold
    ? pct >= 90
      ? 'destructive'
      : pct >= 70
        ? 'warning'
        : 'primary'
    : variant

  return (
    <div
      className={cn('flex w-full items-center', className)}
      role="progressbar"
      aria-valuenow={Math.round(safeValue)}
      aria-valuemin={0}
      aria-valuemax={max}
      {...props}
    >
      <div className="relative flex h-1.5 w-full items-center overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            color ? cn('h-full rounded-full', getColorClassName(color, 'bg')) : progressBarVariants({ variant: resolved }),
            showAnimation && 'transform-gpu transition-all duration-300 ease-in-out'
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      {label ? (
        <span className="ml-2 whitespace-nowrap text-xs font-medium leading-none">{label}</span>
      ) : null}
    </div>
  )
}
