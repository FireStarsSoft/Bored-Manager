import * as React from 'react'
import { TerminalSquare, X } from 'lucide-react'
import type { TerminalBlock } from '@shared/module-ui'
import { api } from '@/lib/api'
import { useApp } from '@/state/store'
import { Button } from '@/components/ui/button'
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
      const res = await api.terminals.create('custom', 100, 30, command)
      if ('ok' in res && !res.ok) {
        showNotice('error', res.error || 'Failed to open the terminal')
        return
      }
      if ('id' in res) setTerminalId(res.id)
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
        <TerminalSquare className="h-3 w-3" /> {block.label}
      </Button>
    )
  }

  return (
    <div className="flex h-72 flex-col overflow-hidden rounded-md border border-border">
      <div className="flex items-center justify-between border-b border-border bg-surface px-2 py-1">
        <span className="text-xs text-muted">{block.label}</span>
        <button
          onClick={close}
          title="Close"
          className="rounded p-1 text-muted transition-colors hover:bg-bad/20 hover:text-bad cursor-pointer"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="relative min-h-0 flex-1 bg-bg">
        <TerminalView terminalId={terminalId} visible />
      </div>
    </div>
  )
}
