/**
 * How high this module will let a kernel limit be set. These are guard rails,
 * not the limits themselves: they stop a typo turning `fs.file-max` into
 * something that costs the machine its memory, and each one can be raised per
 * install for a machine that genuinely needs it.
 */
import type { ModuleContext } from '@shared/modules'

export interface NetRules {
  /** Highest neighbour table threshold that may be written. */
  maxGcThresh3: number
  /** Highest fs.file-max / fs.nr_open that may be written. */
  maxFileMax: number
  maxInotifyWatches: number
}

export const DEFAULT_NET_RULES: NetRules = {
  maxGcThresh3: 1_000_000,
  maxFileMax: 50_000_000,
  maxInotifyWatches: 10_000_000
}

export function effectiveNetRules(ctx: ModuleContext): NetRules {
  const out = { ...DEFAULT_NET_RULES }
  const overrides = (ctx.configGet() as { rules?: unknown } | null)?.rules
  if (typeof overrides !== 'object' || overrides === null) return out
  for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
    if (!(key in DEFAULT_NET_RULES)) continue
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    out[key as keyof NetRules] = value
  }
  return out
}
