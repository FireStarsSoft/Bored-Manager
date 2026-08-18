import * as React from 'react'
import { TerminalSquare, X } from 'lucide-react'
import type { TerminalBlock } from '@shared/module-ui'
import { api } from '@/lib/api'
import { createTargetTerminal } from '@/lib/terminals'
import { useApp } from '@/state/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TerminalView } from '@/components/TerminalView'
import { resolvePath } from '../binding'
import type { BlockCtx } from '../BlockRenderer'

/** `{{key}}` placeholders filled from the current scope (a table row, typically). */
function interpolate(template: string, scope: unknown): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    const value = resolvePath(scope, key)
    return value == null ? '' : String(value)
  })
}

export function TerminalBlockView({ block, ctx }: { block: TerminalBlock; ctx: BlockCtx }): React.JSX.Element {
  const showNotice = useApp((s) => s.showNotice)
  const [terminalId, setTerminalId] = React.useState<string | null>(null)
  const [opening, setOpening] = React.useState(false)

  // Disposes the terminal if the block itself unmounts (scope/drawer closed) without the user closing it explicitly.
  React.useEffect(
    () => () => {
      if (terminalId) void api.terminals.dispose(terminalId)
    },
    [terminalId]
  )

  const open = async (): Promise<void> => {
    setOpening(true)
    try {
      const command = interpolate(block.commandTemplate, ctx.scope)
      const res = await createTargetTerminal('custom', 100, 30, command)
      if (!res.ok) {
        showNotice('error', res.error)
        return
      }
      setTerminalId(res.info.id)
    } finally {
      setOpening(false)
    }
  }

  const close = (): void => {
    const id = terminalId
    setTerminalId(null)
    if (id) void api.terminals.dispose(id)
  }

  if (!terminalId) {
    return (
      <Button size="sm" variant="secondary" disabled={opening} onClick={() => void open()}>
        <TerminalSquare aria-hidden /> {block.label}
      </Button>
    )
  }

  return (
    <div className="flex h-72 flex-col overflow-hidden rounded-md border border-border">
      <div className="flex items-center justify-between border-b border-border bg-sidebar px-2 py-1">
        <span className="text-xs text-muted-foreground">{block.label}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={close}
              aria-label={`Close ${block.label}`}
              className="hover:bg-destructive/20 hover:text-destructive"
            >
              <X aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Close</TooltipContent>
        </Tooltip>
      </div>
      <div className="relative min-h-0 flex-1 bg-background">
        <TerminalView terminalId={terminalId} visible />
      </div>
    </div>
  )
}
