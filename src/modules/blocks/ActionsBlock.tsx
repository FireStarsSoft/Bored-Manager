import * as React from 'react'
import type { ActionsBlock } from '@shared/module-ui'
import { ActionButton } from '../action-runner'
import type { BlockCtx } from '../BlockRenderer'

export function ActionsBlockView({ block, ctx }: { block: ActionsBlock; ctx: BlockCtx }): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-2">
      {block.actions.map((action, i) => (
        <ActionButton key={i} action={action} moduleId={ctx.moduleId} scope={ctx.scope} />
      ))}
    </div>
  )
}
