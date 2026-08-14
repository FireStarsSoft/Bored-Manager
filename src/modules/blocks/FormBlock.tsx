import * as React from 'react'
import { Loader2 } from 'lucide-react'
import type { FormBlock } from '@shared/module-ui'
import { useApp } from '@/state/store'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { resolveActionArgs } from '../binding'
import { callAction } from '../action-runner'
import type { BlockCtx } from '../BlockRenderer'
import { FormFields, initialFieldState, positionalFormValues, type FieldState } from './form-fields'

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function FormBlockView({ block, ctx }: { block: FormBlock; ctx: BlockCtx }): React.JSX.Element {
  const showNotice = useApp((s) => s.showNotice)
  const [values, setValues] = React.useState<FieldState>(() => initialFieldState(block.fields, ctx.scope))
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = React.useState(false)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const fieldValues = positionalFormValues(block.fields, values)
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
      {block.title && <h4 className="text-sm font-medium">{block.title}</h4>}
      <FormFields
        fields={block.fields}
        values={values}
        onChange={(key, value) => setValues((s) => ({ ...s, [key]: value }))}
        moduleId={ctx.moduleId}
        visible={ctx.visible}
        scope={ctx.scope}
        disabled={busy}
        idPrefix={ctx.moduleId}
      />
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
