import * as React from 'react'
import { Loader2 } from 'lucide-react'
import type { FormBlock } from '@shared/module-ui'
import { useApp } from '@/state/store'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Input } from '@/components/ui/input'
import { SelectField } from '@/components/select-field'
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
    <div className="flex flex-col gap-2.5">
      {block.fields.map((f) => {
        const fieldId = `${ctx.moduleId}-${f.key}`
        return (
          <div key={f.key} className="flex flex-col gap-1">
            <Label htmlFor={fieldId} className="text-xs text-muted-foreground">
              {f.label}
            </Label>
            {f.input === 'select' ? (
              <SelectField
                id={fieldId}
                value={values[f.key]}
                onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))}
                options={f.options ?? []}
                className="w-full"
              />
            ) : (
              <Input
                id={fieldId}
                type={f.input === 'number' ? 'number' : 'text'}
                value={values[f.key]}
                onChange={(e) => setValues((s) => ({ ...s, [f.key]: e.target.value }))}
              />
            )}
          </div>
        )
      })}
      <div className="flex items-center gap-2">
        <Button disabled={busy} onClick={trySubmit}>
          {busy && <Loader2 className="size-3 animate-spin" aria-hidden />}
          {block.submit.label}
        </Button>
        {error && (
          <span role="alert" className="text-xs text-destructive">
            {error}
          </span>
        )}
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
