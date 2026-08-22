import type { ValueFormat } from '@shared/module-ui'
import type { ChartColor } from '@/components/charts'
import { formatBytes, formatCount, formatDuration, formatPct, formatRate, formatTemp } from '@/lib/utils'

/** Render a resolved value the way its block spec says to - the one place every block formats through. */
export function formatBlockValue(format: ValueFormat | undefined, value: unknown): string {
  if (value == null || value === '') return '—'
  if (format === 'text' || format == null) return String(value)
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return '—'
  switch (format) {
    case 'bytes':
      return formatBytes(num)
    case 'rate':
      return formatRate(num)
    case 'pct':
      return formatPct(num)
    case 'temp':
      return formatTemp(num)
    case 'number':
      return formatCount(num)
    case 'duration':
      return formatDuration(num)
    default:
      return String(value)
  }
}

/** Fallback swatches when a series does not name a `color`. */
export const BLOCK_PALETTE: ChartColor[] = [
  'primary',
  'cpu',
  'mem',
  'net',
  'disk',
  'warning',
  'success',
  'gpu'
]
