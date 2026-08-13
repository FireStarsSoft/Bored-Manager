import * as React from 'react'
import { Plus, TerminalSquare, X } from 'lucide-react'
import type { TerminalPreset } from '@shared/types'
import { api } from '@/lib/api'
import { useApp } from '@/state/store'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { TerminalView } from '@/components/TerminalView'
import { cn } from '@/lib/utils'

const PRESETS: Array<{ preset: TerminalPreset; label: string }> = [
  { preset: 'shell', label: 'Shell' },
  { preset: 'nvidia-smi', label: 'watch nvidia-smi' },
  { preset: 'glances', label: 'glances' },
  { preset: 'lazydocker', label: 'lazydocker' }
]

export function TerminalsTab({ active }: { active: boolean }): React.JSX.Element {
  const terminals = useApp((s) => s.terminals)
  const refreshTerminals = useApp((s) => s.refreshTerminals)
  const showNotice = useApp((s) => s.showNotice)
  const [activeId, setActiveId] = React.useState<string>('')
  const [customOpen, setCustomOpen] = React.useState(false)
  const [customCmd, setCustomCmd] = React.useState('')

  React.useEffect(() => {
    if (terminals.length > 0 && !terminals.some((t) => t.id === activeId)) {
      setActiveId(terminals[terminals.length - 1].id)
    }
  }, [terminals, activeId])

  const create = async (preset: TerminalPreset, customCommand?: string): Promise<void> => {
    const res = await api.terminals.create(preset, 100, 30, customCommand)
    if ('ok' in res && !res.ok) {
      showNotice('error', res.error || 'Failed to open terminal')
      return
    }
    await refreshTerminals()
    if ('id' in res) setActiveId(res.id)
  }

  const close = async (id: string): Promise<void> => {
    await api.terminals.dispose(id)
    await refreshTerminals()
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-1 border-b border-border bg-surface px-3 py-2">
        {PRESETS.map((p) => (
          <Button key={p.preset} variant="secondary" size="sm" onClick={() => void create(p.preset)}>
            <Plus className="h-3 w-3" /> {p.label}
          </Button>
        ))}
        <Button variant="secondary" size="sm" onClick={() => setCustomOpen(true)}>
          <Plus className="h-3 w-3" /> Custom…
        </Button>
      </div>

      {/* terminal tabs */}
      {terminals.length > 0 && (
        <div className="flex items-center gap-1 overflow-x-auto border-b border-border px-2 py-1.5">
          {terminals.map((t) => (
            <div
              key={t.id}
              onClick={() => setActiveId(t.id)}
              className={cn(
                'flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors',
                activeId === t.id
                  ? 'bg-accent/15 font-medium text-accent'
                  : 'text-muted hover:bg-card-hover hover:text-fg'
              )}
            >
              <TerminalSquare className="h-3 w-3" />
              {t.title}
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  void close(t.id)
                }}
                className="ml-0.5 rounded p-0.5 hover:bg-bad/20 hover:text-bad cursor-pointer"
                title="Close terminal"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="relative min-h-0 flex-1 bg-bg">
        {terminals.length === 0 ? (
          <div className="flex h-full items-center justify-center text-center text-muted">
            <div>
              <TerminalSquare className="mx-auto mb-2 h-8 w-8 opacity-40" />
              <div className="text-sm">No terminals yet</div>
              <div className="mt-1 text-xs">
                Open a shell or a preset like watch nvidia-smi, glances, lazydocker.
                <br />
                Everything is cleaned up automatically when the app closes.
              </div>
            </div>
          </div>
        ) : (
          terminals.map((t) => (
            <TerminalView key={t.id} terminalId={t.id} visible={active && activeId === t.id} />
          ))
        )}
      </div>

      <Dialog open={customOpen} onOpenChange={setCustomOpen} title="Run custom command">
        <div className="space-y-3">
          <Input
            placeholder="e.g. htop, journalctl -f, docker compose logs -f"
            value={customCmd}
            onChange={(e) => setCustomCmd(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && customCmd.trim()) {
                setCustomOpen(false)
                void create('custom', customCmd.trim())
              }
            }}
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCustomOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!customCmd.trim()}
              onClick={() => {
                setCustomOpen(false)
                void create('custom', customCmd.trim())
              }}
            >
              Run
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
