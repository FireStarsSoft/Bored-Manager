import * as React from 'react'
import { Plus, TerminalSquare, X } from 'lucide-react'
import type { TerminalPreset } from '@shared/types'
import { api } from '@/lib/api'
import { useApp } from '@/state/store'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TerminalView } from '@/components/TerminalView'

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
      <div className="flex flex-wrap items-center gap-1 border-b border-border bg-sidebar px-3 py-2">
        {PRESETS.map((p) => (
          <Button key={p.preset} variant="secondary" size="sm" onClick={() => void create(p.preset)}>
            <Plus className="size-3" aria-hidden /> {p.label}
          </Button>
        ))}
        <Button variant="secondary" size="sm" onClick={() => setCustomOpen(true)}>
          <Plus className="size-3" aria-hidden /> Custom…
        </Button>
      </div>

      {/* The panels are not TabsContent: every TerminalView has to stay mounted
          so xterm keeps its scrollback, so this drives selection only. */}
      {terminals.length > 0 && (
        <Tabs
          value={activeId}
          onValueChange={setActiveId}
          className="shrink-0 border-b border-border"
        >
          <TabsList variant="line" className="h-auto w-full justify-start overflow-x-auto px-2 py-1.5">
            {terminals.map((t) => (
              <div key={t.id} className="relative flex shrink-0 items-center">
                <TabsTrigger value={t.id} className="pr-7 text-xs">
                  <TerminalSquare className="size-3" aria-hidden />
                  {t.title}
                </TabsTrigger>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Close ${t.title}`}
                      className="absolute right-0.5 hover:bg-destructive/20 hover:text-destructive"
                      onClick={() => void close(t.id)}
                    >
                      <X aria-hidden />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Close terminal</TooltipContent>
                </Tooltip>
              </div>
            ))}
          </TabsList>
        </Tabs>
      )}

      <div
        className="relative min-h-0 flex-1 bg-background"
        role="tabpanel"
        aria-label="Terminal output"
      >
        {terminals.length === 0 ? (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <TerminalSquare aria-hidden />
              </EmptyMedia>
              <EmptyTitle>No terminals yet</EmptyTitle>
              <EmptyDescription>
                Open a shell or a preset like watch nvidia-smi, glances, lazydocker. Everything is
                cleaned up automatically when the app closes.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          terminals.map((t) => (
            <TerminalView key={t.id} terminalId={t.id} visible={active && activeId === t.id} />
          ))
        )}
      </div>

      <Dialog open={customOpen} onOpenChange={setCustomOpen}>
        <DialogContent
          asChild
          onSubmit={(e) => {
            e.preventDefault()
            if (!customCmd.trim()) return
            setCustomOpen(false)
            void create('custom', customCmd.trim())
          }}
        >
          <form>
            <DialogHeader>
              <DialogTitle>Run custom command</DialogTitle>
              <DialogDescription>
                Runs in a pty on the target machine, exactly as typed.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="terminal-custom-command">Command</Label>
              <Input
                id="terminal-custom-command"
                placeholder="e.g. htop, journalctl -f, docker compose logs -f"
                value={customCmd}
                onChange={(e) => setCustomCmd(e.target.value)}
              />
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={!customCmd.trim()}>
                Run
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
