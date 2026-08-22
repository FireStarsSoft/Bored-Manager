import * as React from 'react'
import { Loader2, Play, Search } from 'lucide-react'
import type { ModuleCheckFinding, ModuleCheckReport } from '@shared/check'
import type { CheckFormBlock } from '@shared/module-ui'
import type { ModuleCheckLevel } from '@shared/modules'
import { useApp } from '@/state/store'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { CheckList, worstLevel } from '@/components/check-list'
import { moduleCall } from '@/lib/modules'
import { callAction } from '../action-runner'
import { resolvePath } from '../binding'
import type { BlockCtx } from '../BlockRenderer'
import { errorMessage } from '@/lib/utils'
import { FormFields, coerceFormValues, initialFieldState, type FieldState, type FormValues } from './form-fields'

const LEVELS: ReadonlySet<string> = new Set<ModuleCheckLevel>(['pass', 'info', 'warning', 'error'])

/**
 * A report is whatever the module returned, so it is read defensively: a
 * malformed one becomes a report that simply cannot be applied, rather than a
 * blank panel or a crashed block.
 */
function toReport(raw: unknown): ModuleCheckReport {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, findings: [{ level: 'error', label: 'The check returned nothing usable' }] }
  }
  const r = raw as { ok?: unknown; token?: unknown; findings?: unknown }
  const findings: ModuleCheckFinding[] = []
  for (const entry of Array.isArray(r.findings) ? r.findings : []) {
    if (typeof entry !== 'object' || entry === null) continue
    const f = entry as { level?: unknown; label?: unknown; detail?: unknown }
    if (!LEVELS.has(f.level as string) || typeof f.label !== 'string') continue
    findings.push({
      level: f.level as ModuleCheckLevel,
      label: f.label,
      detail: typeof f.detail === 'string' ? f.detail : undefined
    })
  }
  if (findings.length === 0) {
    findings.push({ level: 'info', label: 'The check reported nothing' })
  }
  return { ok: r.ok === true, token: typeof r.token === 'string' ? r.token : undefined, findings }
}

const HEADLINE: Record<ModuleCheckLevel, { text: string; tone: string }> = {
  pass: { text: 'Ready to apply', tone: 'text-success' },
  info: { text: 'Ready to apply', tone: 'text-primary' },
  warning: { text: 'Read the warnings first', tone: 'text-warning' },
  error: { text: 'Cannot be applied', tone: 'text-destructive' }
}

interface Checked {
  report: ModuleCheckReport
  /** Token-bound apply values; large fields may be blank after the check froze them. */
  values: FormValues
}

export function CheckFormBlockView({
  block,
  ctx
}: {
  block: CheckFormBlock
  ctx: BlockCtx
}): React.JSX.Element {
  const showNotice = useApp((s) => s.showNotice)
  const [values, setValues] = React.useState<FieldState>(() => initialFieldState(block.fields, ctx.scope))
  const [checked, setChecked] = React.useState<Checked | null>(null)
  const [busy, setBusy] = React.useState<'check' | 'apply' | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = React.useState(false)

  const scopeArgs = (block.argsFromScope ?? []).map((key) => resolvePath(ctx.scope, key))
  const danger = block.kind === 'danger'
  const canApply = checked?.report.ok === true && typeof checked.report.token === 'string'

  const runCheck = async (): Promise<void> => {
    setBusy('check')
    setError(null)
    setChecked(null)
    const sent = coerceFormValues(block.fields, values)
    try {
      const raw = await moduleCall<unknown>(ctx.moduleId, block.checkMethod, ...scopeArgs, sent)
      const applyValues = { ...sent }
      for (const field of block.fields) {
        if (field.omitOnApply) applyValues[field.key] = ''
      }
      setChecked({ report: toReport(raw), values: applyValues })
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const runApply = async (): Promise<void> => {
    if (!checked?.report.token) return
    setBusy('apply')
    setError(null)
    try {
      // callAction rather than moduleCall: an apply that refuses (a spent
      // token, something already running) answers `{ ok: false, error }`
      // instead of rejecting, and reporting that as "applied" is worse than
      // saying nothing.
      await callAction(ctx.moduleId, block.applyMethod, [
        ...scopeArgs,
        { token: checked.report.token, values: checked.values }
      ])
      showNotice('info', `${block.title ?? block.applyMethod}: applied`)
    } catch (err) {
      setError(`${errorMessage(err)} - check again before retrying`)
    } finally {
      // The token was single-use whether or not the call got that far, so the
      // report it belonged to is spent either way and a fresh check is the
      // only honest thing to offer.
      setChecked(null)
      setBusy(null)
    }
  }

  const tryApply = (): void => {
    if (danger) setConfirmOpen(true)
    else void runApply()
  }

  const headline = checked ? HEADLINE[checked.report.ok ? worstLevel(checked.report.findings) : 'error'] : null

  return (
    <div className="flex flex-col gap-2.5">
      {block.title && <h4 className="text-sm font-medium">{block.title}</h4>}
      <FormFields
        fields={block.fields}
        values={values}
        onChange={(key, value) => {
          setValues((s) => ({ ...s, [key]: value }))
          // What was applied has to be what the user read the report for, so
          // the report goes the moment the form stops matching it.
          setChecked(null)
          setError(null)
        }}
        moduleId={ctx.moduleId}
        visible={ctx.visible}
        scope={ctx.scope}
        disabled={busy !== null}
        idPrefix={`${ctx.moduleId}-${block.checkMethod}`}
      />
      {checked && headline && (
        <div className="rounded-md border border-border bg-muted/50 p-2.5">
          <div className="mb-2 flex items-center gap-2 border-b border-border pb-2">
            <span className={`text-sm ${headline.tone}`}>{headline.text}</span>
          </div>
          <CheckList items={checked.report.findings} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" disabled={busy !== null} onClick={() => void runCheck()}>
          {busy === 'check' ? (
            <Loader2 className="size-3 animate-spin" aria-hidden />
          ) : (
            <Search className="size-3" aria-hidden />
          )}
          {block.checkLabel ?? 'Check'}
        </Button>
        <Button
          variant={danger ? 'destructive' : 'default'}
          disabled={busy !== null || !canApply}
          onClick={tryApply}
        >
          {busy === 'apply' ? (
            <Loader2 className="size-3 animate-spin" aria-hidden />
          ) : (
            <Play className="size-3" aria-hidden />
          )}
          {block.applyLabel ?? 'Confirm and apply'}
        </Button>
        {!checked && !error && (
          <span className="text-xs text-muted-foreground">Check first to see what would happen.</span>
        )}
        {error && (
          <span role="alert" className="text-xs text-destructive">
            {error}
          </span>
        )}
      </div>
      {danger && (
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title={block.applyLabel ?? 'Confirm and apply'}
          message={`${block.title ?? 'This'} will run against the connected machine and cannot be undone.`}
          destructive
          onConfirm={() => void runApply()}
        />
      )}
    </div>
  )
}
