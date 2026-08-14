import * as React from 'react'
import { Loader2 } from 'lucide-react'
import type { ActionSpec } from '@shared/module-ui'
import { moduleCall } from '@/lib/modules'
import { useApp } from '@/state/store'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { resolveActionArgs, resolvePath } from './binding'

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Many methods resolve successfully with `{ ok: false, error }` instead of
 * rejecting (`processes.kill`, every Docker/GPU action). Throwing for that
 * shape here means every caller's `catch` handles both failure styles alike.
 */
export async function callAction(moduleId: string, method: string, args: unknown[]): Promise<void> {
  const result = await moduleCall<unknown>(moduleId, method, ...args)
  if (result && typeof result === 'object' && 'ok' in result && (result as { ok: unknown }).ok === false) {
    throw new Error((result as { error?: string }).error || `${method} failed`)
  }
}

/**
 * One button that calls `moduleCall` for an `ActionSpec` - shared by
 * `TableBlock`'s row actions, `ActionsBlock` and `FormBlock`'s submit, so a
 * confirm question or a value prompt behaves identically everywhere a spec
 * declares one.
 */
export function ActionButton({
  action,
  moduleId,
  scope,
  leadingArgs,
  disabled,
  size = 'sm',
  onDone
}: {
  action: ActionSpec
  moduleId: string
  /** The row this action acts on - resolves `argsFromRow` and a prompt's `initialKey`. */
  scope?: unknown
  /**
   * Args that go in front of everything the spec declares. A table's bulk
   * actions pass the ticked row keys here: they are what the call is about,
   * the way `argsFromRow` is for a single row.
   */
  leadingArgs?: unknown[]
  disabled?: boolean
  size?: 'default' | 'sm'
  onDone?: () => void
}): React.JSX.Element {
  const showNotice = useApp((s) => s.showNotice)
  const [busy, setBusy] = React.useState(false)
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const [promptOpen, setPromptOpen] = React.useState(false)

  const run = async (promptValue?: unknown): Promise<void> => {
    setBusy(true)
    try {
      const extra = promptValue !== undefined ? [promptValue] : []
      await callAction(moduleId, action.method, [
        ...(leadingArgs ?? []),
        ...resolveActionArgs(action, scope, extra)
      ])
      onDone?.()
    } catch (err) {
      showNotice('error', `${action.label} failed: ${message(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleClick = (): void => {
    // A prompt is itself a deliberate step, so it doubles as the confirmation
    // when a spec sets both - a second dialog right after would only annoy.
    if (action.prompt) setPromptOpen(true)
    else if (action.confirm) setConfirmOpen(true)
    else void run()
  }

  return (
    <>
      <Button
        size={size}
        variant={action.kind === 'danger' ? 'destructive' : 'secondary'}
        disabled={disabled || busy}
        onClick={handleClick}
      >
        {busy && <Loader2 className="size-3 animate-spin" aria-hidden />}
        {action.label}
      </Button>
      {action.confirm && (
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title={action.label}
          message={action.confirm}
          destructive={action.kind === 'danger'}
          onConfirm={() => void run()}
        />
      )}
      {action.prompt && (
        <ActionPromptDialog
          open={promptOpen}
          onOpenChange={setPromptOpen}
          label={action.prompt.label}
          input={action.prompt.input}
          initialValue={action.prompt.initialKey ? String(resolvePath(scope, action.prompt.initialKey) ?? '') : ''}
          onSubmit={(value) => {
            setPromptOpen(false)
            void run(action.prompt?.input === 'number' ? Number(value) : value)
          }}
        />
      )}
    </>
  )
}

function ActionPromptDialog({
  open,
  onOpenChange,
  label,
  input,
  initialValue,
  onSubmit
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  label: string
  input: 'number' | 'text'
  initialValue: string
  onSubmit: (value: string) => void
}): React.JSX.Element {
  const [value, setValue] = React.useState(initialValue)

  React.useEffect(() => {
    if (open) setValue(initialValue)
  }, [open, initialValue])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onSubmit={(e) => {
          e.preventDefault()
          onSubmit(value)
        }}
        asChild
      >
        <form>
          <DialogHeader>
            <DialogTitle asChild>
              <Label htmlFor="action-prompt-value">{label}</Label>
            </DialogTitle>
          </DialogHeader>
          <Input
            id="action-prompt-value"
            type={input === 'number' ? 'number' : 'text'}
            value={value}
            autoFocus
            onChange={(e) => setValue(e.target.value)}
          />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit">OK</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
