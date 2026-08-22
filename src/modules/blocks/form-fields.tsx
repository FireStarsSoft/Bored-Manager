/**
 * The field list `form` and `checkForm` share. Kept apart from either block so
 * the two cannot drift on what a `checkbox` sends or where a `select` gets its
 * options - which matters, because `checkForm` puts the same values through a
 * check and then an apply and they have to agree.
 */
import * as React from 'react'
import { Shuffle } from 'lucide-react'
import { FORM_COLOR_SWATCHES, type FormField, type FormFieldOption } from '@shared/module-ui'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { SelectField } from '@/components/select-field'
import { Button } from '@/components/ui/button'
import { cn, formatBytes } from '@/lib/utils'
import { BlockData, resolvePath } from '../binding'

/** What a field holds while it is being edited: a tick is a boolean, everything else is text. */
export type FieldState = Record<string, string | boolean>

/** What a module receives: text stays text, a number field is a number, a tick is a boolean. */
export type FormValues = Record<string, string | number | boolean>

/** The choice a select falls back to when nothing else says otherwise. */
function firstOption(field: FormField): string {
  return field.options?.[0]?.value ?? ''
}

/**
 * A field's starting value: the open row wins over the spec's own `initial`,
 * which wins over the first choice of a static select. Everything else starts
 * empty, so a form never quietly submits a value nobody typed.
 */
export function initialFieldState(fields: readonly FormField[], scope: unknown): FieldState {
  const out: FieldState = {}
  for (const field of fields) {
    const fromScope = field.initialFromScope ? resolvePath(scope, field.initialFromScope) : undefined
    const raw = fromScope ?? field.initial ?? (field.input === 'select' ? firstOption(field) : undefined)
    if (field.input === 'checkbox') out[field.key] = raw === true || raw === 'true'
    else out[field.key] = raw == null ? '' : String(raw)
  }
  return out
}

/** Turn the edit state into what the module's method is called with. */
export function coerceFormValues(fields: readonly FormField[], state: FieldState): FormValues {
  const out: FormValues = {}
  for (const field of fields) {
    const raw = state[field.key]
    if (field.input === 'checkbox') out[field.key] = raw === true
    else if (field.input === 'number') out[field.key] = Number(raw)
    else out[field.key] = typeof raw === 'string' ? raw : String(raw ?? '')
  }
  return out
}

/** Same values, in field order - what `form`'s positional submit sends. */
export function positionalFormValues(fields: readonly FormField[], state: FieldState): unknown[] {
  const values = coerceFormValues(fields, state)
  return fields.map((f) => values[f.key])
}

interface FieldProps {
  field: FormField
  value: string | boolean
  onChange: (value: string | boolean) => void
  moduleId: string
  visible: boolean
  scope: unknown
  disabled: boolean
  idPrefix: string
}

export function FormFields({
  fields,
  values,
  onChange,
  moduleId,
  visible,
  scope,
  disabled = false,
  idPrefix
}: {
  fields: readonly FormField[]
  values: FieldState
  onChange: (key: string, value: string | boolean) => void
  moduleId: string
  visible: boolean
  scope?: unknown
  disabled?: boolean
  idPrefix: string
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2.5">
      {fields.map((field) => {
        const props: FieldProps = {
          field,
          value: values[field.key] ?? '',
          onChange: (v) => onChange(field.key, v),
          moduleId,
          visible,
          scope,
          disabled,
          idPrefix
        }
        // Two components rather than one conditional hook: only the remote
        // variant resolves a data source, and swapping between them has to
        // remount rather than change how many hooks the row runs.
        return field.optionsFrom ? (
          <RemoteOptionsField key={field.key} {...props} optionsFrom={field.optionsFrom} />
        ) : (
          <FieldRow key={field.key} {...props} options={field.options ?? []} />
        )
      })}
    </div>
  )
}

/** A select whose choices come from the module (`optionsFrom`), read once when the block is first visible. */
function RemoteOptionsField(
  props: FieldProps & { optionsFrom: NonNullable<FormField['optionsFrom']> }
): React.JSX.Element {
  return (
    <BlockData
      moduleId={props.moduleId}
      source={props.optionsFrom}
      opts={{ visible: props.visible, scope: props.scope }}
    >
      {({ value }) => <FieldRow {...props} options={toOptions(value)} />}
    </BlockData>
  )
}

function toOptions(raw: unknown): FormFieldOption[] {
  if (!Array.isArray(raw)) return []
  const out: FormFieldOption[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as { value?: unknown; label?: unknown }
    if (typeof e.value !== 'string') continue
    out.push({ value: e.value, label: typeof e.label === 'string' ? e.label : e.value })
  }
  return out
}

function FieldRow({
  field,
  value,
  onChange,
  disabled,
  idPrefix,
  options
}: FieldProps & { options: FormFieldOption[] }): React.JSX.Element {
  const id = `${idPrefix}-${field.key}`
  const help = field.help ? (
    <p id={`${id}-help`} className="text-xs text-muted-foreground">
      {field.help}
    </p>
  ) : null
  const describedBy = field.help ? `${id}-help` : undefined

  if (field.input === 'checkbox') {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Checkbox
            id={id}
            checked={value === true}
            disabled={disabled}
            aria-describedby={describedBy}
            onCheckedChange={(v) => onChange(v === true)}
          />
          <Label htmlFor={id} className="text-xs">
            {field.label}
          </Label>
        </div>
        {help}
      </div>
    )
  }

  const text = typeof value === 'string' ? value : String(value)

  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {field.label}
      </Label>
      {field.input === 'select' ? (
        <SelectField
          id={id}
          value={text}
          onChange={onChange}
          options={options}
          disabled={disabled}
          className="w-full"
        />
      ) : field.input === 'textarea' ? (
        <Textarea
          id={id}
          rows={5}
          value={text}
          disabled={disabled}
          placeholder={field.placeholder}
          aria-describedby={describedBy}
          className="mono text-xs"
          onChange={(e) => onChange(e.target.value)}
        />
      ) : field.input === 'file' ? (
        <FileField
          id={id}
          field={field}
          value={text}
          disabled={disabled}
          onChange={onChange}
          describedBy={describedBy}
        />
      ) : field.input === 'color' ? (
        <ColorField id={id} value={text} disabled={disabled} onChange={onChange} describedBy={describedBy} />
      ) : (
        <Input
          id={id}
          type={field.input === 'number' ? 'number' : field.input === 'password' ? 'password' : 'text'}
          value={text}
          disabled={disabled}
          placeholder={field.placeholder}
          aria-describedby={describedBy}
          autoComplete={field.input === 'password' ? 'new-password' : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {help}
    </div>
  )
}

function FileField({
  id,
  field,
  value,
  disabled,
  onChange,
  describedBy
}: {
  id: string
  field: FormField
  value: string
  disabled: boolean
  onChange: (value: string) => void
  describedBy: string | undefined
}): React.JSX.Element {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const readerRef = React.useRef<FileReader | null>(null)
  const operationRef = React.useRef(0)
  const [file, setFile] = React.useState<{ name: string; size: number } | null>(null)
  const [reading, setReading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const previousValueRef = React.useRef(value)

  React.useEffect(
    () => () => {
      operationRef.current += 1
      const reader = readerRef.current
      readerRef.current = null
      if (reader?.readyState === FileReader.LOADING) reader.abort()
    },
    []
  )

  // A form clears its state after a successful submit/check-apply. The native
  // file input and this component's filename are not controlled by that state,
  // so mirror an external non-empty -> empty transition here. While a
  // replacement file is being read, chooseFile intentionally clears the old
  // payload first; `reading` keeps that internal transition from erasing the
  // new selection or a useful read error.
  React.useEffect(() => {
    const previous = previousValueRef.current
    previousValueRef.current = value
    if (!previous || value || reading) return
    if (inputRef.current) inputRef.current.value = ''
    setFile(null)
    setError(null)
  }, [reading, value])

  const stopReading = (): void => {
    operationRef.current += 1
    const reader = readerRef.current
    readerRef.current = null
    if (reader?.readyState === FileReader.LOADING) reader.abort()
    setReading(false)
  }

  const clear = (): void => {
    stopReading()
    if (inputRef.current) inputRef.current.value = ''
    setFile(null)
    setError(null)
    onChange('')
  }

  const chooseFile = (event: React.ChangeEvent<HTMLInputElement>): void => {
    stopReading()
    const selected = event.currentTarget.files?.[0]
    setError(null)
    onChange('')

    if (!selected) {
      setFile(null)
      return
    }

    setFile({ name: selected.name, size: selected.size })
    const configuredMaxKb = field.maxKb ?? 1024
    const maxKb = Number.isFinite(configuredMaxKb) && configuredMaxKb > 0 ? configuredMaxKb : 1024
    const maxBytes = maxKb * 1024
    if (selected.size > maxBytes) {
      event.currentTarget.value = ''
      setError(`${selected.name} is ${formatBytes(selected.size)}; the limit is ${formatBytes(maxBytes)}.`)
      return
    }

    const operation = ++operationRef.current
    const reader = new FileReader()
    readerRef.current = reader
    setReading(true)

    reader.onload = () => {
      if (operationRef.current !== operation) return
      readerRef.current = null
      setReading(false)
      if (typeof reader.result === 'string') {
        onChange(reader.result)
        return
      }
      if (inputRef.current) inputRef.current.value = ''
      setError(`Could not read ${selected.name} as text.`)
    }
    reader.onerror = () => {
      if (operationRef.current !== operation) return
      readerRef.current = null
      setReading(false)
      if (inputRef.current) inputRef.current.value = ''
      setError(
        reader.error?.message
          ? `Could not read ${selected.name}: ${reader.error.message}`
          : `Could not read ${selected.name}.`
      )
    }

    try {
      reader.readAsText(selected)
    } catch (reason) {
      if (operationRef.current !== operation) return
      readerRef.current = null
      setReading(false)
      event.currentTarget.value = ''
      setError(
        reason instanceof Error && reason.message
          ? `Could not read ${selected.name}: ${reason.message}`
          : `Could not read ${selected.name}.`
      )
    }
  }

  const errorId = `${id}-file-error`
  const inputDescribedBy = [describedBy, error ? errorId : null].filter(Boolean).join(' ') || undefined

  return (
    <div className="flex flex-col gap-1">
      <Input
        ref={inputRef}
        id={id}
        type="file"
        accept={field.accept?.trim() || '.txt'}
        disabled={disabled}
        aria-describedby={inputDescribedBy}
        onChange={chooseFile}
      />
      {file && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-input bg-field px-2 py-1">
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {file.name} · {formatBytes(file.size)}
            {reading ? ' · Reading…' : ''}
          </span>
          <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={clear}>
            Clear
          </Button>
        </div>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

/**
 * Twelve swatches, a native picker for anything else, and a way back to empty
 * - which is not the same as black: a module reads "no colour" as "choose one
 * for me", so it has to stay reachable.
 */
function ColorField({
  id,
  value,
  disabled,
  onChange,
  describedBy
}: {
  id: string
  value: string
  disabled: boolean
  onChange: (value: string) => void
  describedBy: string | undefined
}): React.JSX.Element {
  const picked = value.trim()
  return (
    <div className="flex flex-col gap-1.5" aria-describedby={describedBy}>
      <div className="flex flex-wrap items-center gap-1">
        {FORM_COLOR_SWATCHES.map((hex) => (
          <button
            key={hex}
            type="button"
            disabled={disabled}
            aria-label={hex}
            aria-pressed={picked.toLowerCase() === hex}
            title={hex}
            onClick={() => onChange(picked.toLowerCase() === hex ? '' : hex)}
            className={cn(
              'size-5 rounded-sm border border-border transition-[outline]',
              picked.toLowerCase() === hex && 'outline-2 outline-offset-1 outline-ring',
              disabled && 'opacity-50'
            )}
            style={{ backgroundColor: hex }}
          />
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <input
          id={id}
          type="color"
          value={picked || '#888888'}
          disabled={disabled}
          aria-label="Custom colour"
          className="size-8 shrink-0 cursor-pointer rounded-md border border-input bg-field p-0.5 disabled:opacity-50"
          onChange={(e) => onChange(e.target.value)}
        />
        <Input
          value={picked}
          disabled={disabled}
          placeholder="Auto"
          aria-label="Colour hex"
          className="mono w-28"
          onChange={(e) => onChange(e.target.value)}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() =>
            onChange(FORM_COLOR_SWATCHES[Math.floor(Math.random() * FORM_COLOR_SWATCHES.length)])
          }
        >
          <Shuffle className="size-3" aria-hidden />
          Random
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={disabled || !picked} onClick={() => onChange('')}>
          Auto
        </Button>
      </div>
    </div>
  )
}
