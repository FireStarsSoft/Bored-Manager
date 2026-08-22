import * as React from 'react'
import type { PieBlock, PieSliceStatus } from '@shared/module-ui'
import { Donut, type DonutSlice } from '@/components/charts'
import type { ChartColor } from '@/components/charts/chart-colors'
import { BlockData } from '../binding'
import { formatBlockValue } from '../format'
import type { BlockCtx } from '../BlockRenderer'

/** Same tokens as StatusCardsBlock — a spec sends status, never a colour. */
const STATUS_COLOR: Record<PieSliceStatus, ChartColor> = {
  ok: 'success',
  warn: 'warning',
  bad: 'destructive',
  unknown: 'muted'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function numeric(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

export function PieBlockView({ block, ctx }: { block: PieBlock; ctx: BlockCtx }): React.JSX.Element {
  if (!ctx.visible) {
    return <div className={ctx.compact ? 'h-28' : 'h-36'} aria-hidden />
  }
  return (
    <BlockData moduleId={ctx.moduleId} source={block.source} opts={ctx}>
      {({ value }) => <LivePie block={block} ctx={ctx} value={value} />}
    </BlockData>
  )
}

function LivePie({
  block,
  ctx,
  value
}: {
  block: PieBlock
  ctx: BlockCtx
  value: unknown
}): React.JSX.Element {
  const obj = asRecord(value)
  const format = block.format ?? 'number'

  const slices: DonutSlice[] = block.slices.map((s) => ({
    name: s.label,
    value: numeric(obj?.[s.key]),
    color: STATUS_COLOR[s.status]
  }))

  const centerValue = block.center ? numeric(obj?.[block.center.key]) : slices.reduce((n, s) => n + s.value, 0)

  if (obj == null || centerValue === 0) {
    return <div className="text-xs text-muted-foreground">{block.emptyText ?? 'Nothing to show yet'}</div>
  }

  return (
    <Donut
      data={slices}
      label={formatBlockValue(format, centerValue)}
      labelCaption={block.center?.label}
      formatValue={(v) => formatBlockValue(format, v)}
      compact={ctx.compact}
    />
  )
}
