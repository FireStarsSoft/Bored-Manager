import * as React from 'react'
import type { ConditionalBlock } from '@shared/module-ui'
import { resolvePath, useBlockData } from '../binding'
import { BlockList, type BlockCtx } from '../BlockRenderer'

function evaluate(op: 'exists' | 'eq' | 'gt', value: unknown, expected: unknown): boolean {
  switch (op) {
    case 'exists':
      return value != null
    case 'eq':
      return value === expected
    case 'gt':
      return Number(value) > Number(expected)
    default:
      return false
  }
}

export function ConditionalBlockView({
  block,
  ctx
}: {
  block: ConditionalBlock
  ctx: BlockCtx
}): React.JSX.Element | null {
  const raw = useBlockData(ctx.moduleId, block.when.source, ctx)
  const value = resolvePath(raw, block.when.path)
  const matches = evaluate(block.when.op, value, block.when.value)

  if (matches) return <BlockList blocks={block.blocks} ctx={ctx} />
  if (block.else) return <BlockList blocks={block.else} ctx={ctx} />
  return null
}
