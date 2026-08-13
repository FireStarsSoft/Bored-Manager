import * as React from 'react'
import { Loader2 } from 'lucide-react'
import type { FormBlock } from '@shared/module-ui'
import { useApp } from '@/state/store'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/select'
import { resolveActionArgs } from '../binding'
import { callAction } from '../action-runner'
import type { BlockCtx } from '../BlockRenderer'

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function FormBlockView({ block, ctx }: { block: FormBlock; ctx: BlockCtx }): React.JSX.Element {
  const showNotice = useApp((s) => s.showNotice)
  const [values, setValues] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(block.fields.map((f) => [f.key, f.options?.[0]?.value ?? '']))
  )
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = React.useState(false)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const fieldValues = block.fields.map((f) => (f.input === 'number' ? Number(values[f.key]) : values[f.key]))
      await callAction(ctx.moduleId, block.submit.method, resolveActionArgs(block.submit, ctx.scope, fieldValues))
      showNotice('info', `${block.submit.label}: done`)
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }

  const trySubmit = (): void => {
    if (block.submit.confirm) setConfirmOpen(true)
    else void submit()
  }

  return (
    <div className="space-y-2.5">
      {block.fields.map((f) => (
        <label key={f.key} className="block text-xs text-muted">
          {f.label}
          {f.input === 'select' ? (
            <SimpleSelect
              value={values[f.key]}
              onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))}
              options={f.options ?? []}
              className="mt-1 w-full"
            />
          ) : (
            <Input
              type={f.input === 'number' ? 'number' : 'text'}
              value={values[f.key]}
              onChange={(e) => setValues((s) => ({ ...s, [f.key]: e.target.value }))}
              className="mt-1"
            />
          )}
        </label>
      ))}
      <div className="flex items-center gap-2">
        <Button disabled={busy} onClick={trySubmit}>
          {busy && <Loader2 className="h-3 w-3 animate-spin" />}
          {block.submit.label}
        </Button>
        {error && <span className="text-xs text-bad">{error}</span>}
      </div>
      {block.submit.confirm && (
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title={block.submit.label}
          message={block.submit.confirm}
          destructive={block.submit.kind === 'danger'}
          onConfirm={() => void submit()}
        />
      )}
    </div>
  )
}
