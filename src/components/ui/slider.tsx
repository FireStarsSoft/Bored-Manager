import * as React from 'react'
import * as SliderPrimitive from '@radix-ui/react-slider'
import { cn } from '@/lib/utils'

export function Slider({
  value,
  onChange,
  min,
  max,
  step = 1,
  className,
  disabled
}: {
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  step?: number
  className?: string
  disabled?: boolean
}): React.JSX.Element {
  return (
    <SliderPrimitive.Root
      value={[value]}
      onValueChange={(v) => onChange(v[0])}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      className={cn('relative flex w-full touch-none select-none items-center py-2', className)}
    >
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-input">
        <SliderPrimitive.Range className="absolute h-full bg-accent" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb className="block h-4 w-4 cursor-pointer rounded-full border border-accent bg-fg shadow focus:outline-none focus:ring-2 focus:ring-accent/50 disabled:opacity-50" />
    </SliderPrimitive.Root>
  )
}
