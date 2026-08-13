import * as React from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

export interface SelectOption<T extends string> {
  value: T
  label: string
}

/**
 * Every select in this app is a flat list of options bound to one setting, so
 * the composable Select parts are wrapped once here instead of at each of the
 * call sites.
 */
export function SelectField<T extends string>({
  value,
  onChange,
  options,
  className,
  disabled,
  size,
  'aria-label': ariaLabel,
  id
}: {
  value: T
  onChange: (v: T) => void
  options: SelectOption<T>[]
  className?: string
  disabled?: boolean
  size?: 'sm' | 'default'
  'aria-label'?: string
  id?: string
}): React.JSX.Element {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as T)} disabled={disabled}>
      <SelectTrigger id={id} size={size} aria-label={ariaLabel} className={cn('w-fit', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((opt) => (
          <SelectItem key={opt.value} value={opt.value}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
