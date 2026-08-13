import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-50 cursor-pointer',
  {
    variants: {
      variant: {
        default: 'bg-accent text-white hover:bg-accent/85',
        secondary: 'bg-card-hover text-fg border border-border hover:bg-border/60',
        outline: 'border border-border bg-transparent text-fg hover:bg-card-hover',
        ghost: 'text-muted hover:text-fg hover:bg-card-hover',
        destructive: 'bg-bad/15 text-bad border border-bad/30 hover:bg-bad/25'
      },
      size: {
        default: 'h-8 px-3 text-sm',
        sm: 'h-6.5 px-2 text-xs',
        lg: 'h-10 px-5 text-sm',
        icon: 'h-7 w-7'
      }
    },
    defaultVariants: { variant: 'default', size: 'default' }
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  )
)
Button.displayName = 'Button'
