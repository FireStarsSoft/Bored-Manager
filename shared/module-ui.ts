// The declarative UI a module ships instead of React: a page or widget is a
// tree of `Block`s, each one naming where its data comes from (`DataSource`)
// and, for the interactive ones, which of the module's own methods it may
// call. The app renders this itself (src/modules/BlockRenderer.tsx); nothing
// here executes - it is read, validated (`specProblems`) and walked.
import type { ModuleManifest } from './modules'
import { CORE_HISTORY_STREAMS, ownsHistoryStream } from './modules'

/**
 * How a raw value is printed. Maps 1-1 to formatBytes/Rate/Pct/Temp/Duration in
 * src/lib/utils.ts. Two are odd ones out: `duration`'s raw value is an
 * absolute `startedAt`-style ms timestamp, not an elapsed amount - a block
 * cannot compute `Date.now() - value` itself, so the formatter does it; and
 * `badges` does not produce text at all, so it is only useful where a block
 * renders cells rather than a single string (table, list, keyValue).
 */
export type ValueFormat =
  | 'bytes'
  | 'rate'
  | 'pct'
  | 'temp'
  | 'number'
  | 'text'
  | 'duration'
  | 'badges'

/** The value behind a `badges`-formatted cell: chips, each with an optional colour. */
export interface ValueBadge {
  label: string
  /** Any CSS colour; omit for the neutral chip. */
  color?: string
}

/**
 * The swatches a `color` form field offers. Colours a user picks for their own
 * labels cannot come from the theme tokens - they have to survive a theme
 * switch and be stored as data - so this is the one place literal hex belongs.
 * Shared so a module choosing a colour on the user's behalf picks from the
 * same twelve the form shows.
 */
export const FORM_COLOR_SWATCHES: readonly string[] = [
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#eab308',
  '#84cc16',
  '#22c55e',
  '#10b981',
  '#14b8a6',
  '#06b6d4',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899'
]

/**
 * Where a block's data comes from.
 *
 * - `stream`: mirrors one of the module's declared `streams` (series or
 *   latest, per the manifest) out of the renderer's module bus.
 * - `invoke`: calls one of the module's `methods` and re-polls it on
 *   `intervalKey`'s configured speed while the block is visible; omit
 *   `intervalKey` to call it once on mount/visible.
 * - `history`: reads a downsampled series back from the metrics history on
 *   disk (src/lib/history.ts), for a chart window longer than the live buffer.
 *   Limited to the module's own streams and the app's - see checkSource.
 * - `core`: one of the app's own streams - system metrics, top consumers, or
 *   (Phase 5) the services tracker - rather than anything the module itself emits.
 *
 * `path` is a dot-path into the resolved value (e.g. `"mem.used"`), applied
 * by the binding resolver (src/modules/binding.ts); arrays are indexable
 * (`"gpus.0.temp"`).
 */
export type DataSource =
  | { kind: 'stream'; event: string; path?: string }
  | { kind: 'invoke'; method: string; args?: unknown[]; intervalKey?: string; path?: string }
  | { kind: 'history'; stream: string; keys: string[] }
  | { kind: 'core'; stream: 'system' | 'top' | 'services'; path?: string }

export interface ActionPrompt {
  label: string
  input: 'number' | 'text'
  /** Row key to prefill the prompt's value from. */
  initialKey?: string
}

/** A button that calls one of the module's methods, optionally with confirmation or a prompt. */
export interface ActionSpec {
  label: string
  /** Must be one of `manifest.methods`. */
  method: string
  /** Row/scope keys to read positional args from - the row's identity, so these come first (`kill(pid, ...)`, `containerAction(id, ...)`). */
  argsFromRow?: string[]
  /** Literal args, sent after `argsFromRow` and before the prompt/form values (`containerAction(id, "stop")`). */
  args?: unknown[]
  /** Question shown in a confirm dialog before the call is made. */
  confirm?: string
  /** `danger` styles the button and its confirm dialog as destructive. */
  kind?: 'default' | 'danger'
  /** Ask for one value (appended after `args`/`argsFromRow`) before calling. */
  prompt?: ActionPrompt
}

export interface SectionBlock {
  type: 'section'
  title?: string
  /** Grid columns for its own `blocks`; omit for a single column. */
  columns?: number
  /** Shows an IntervalBadge and a manual-refresh button wired to `metrics:refreshSlow`. */
  slowTarget?: string
  blocks: Block[]
}

export interface StatBlock {
  type: 'stat'
  label: string
  source: DataSource
  format: ValueFormat
  /** Small trend chart under the value. */
  spark?: { source: DataSource; key: string }
}

export interface MeterBlock {
  type: 'meter'
  label: string
  source: DataSource
  format?: ValueFormat
  max?: number
}

export interface ChartSeriesDecl {
  /** Key inside the resolved data point. */
  key: string
  label: string
  /** Only used when the chart has no `format` - a literal suffix with no scaling (e.g. "RPM"). */
  unit?: string
}

export interface ChartBlock {
  type: 'chart'
  title?: string
  kind: 'line' | 'area' | 'bar'
  source: DataSource
  series: ChartSeriesDecl[]
  /** How the axis/tooltip prints a value - same formats as `stat`/`meter`. Omit for a raw number (or a series' own `unit` suffix). */
  format?: ValueFormat
  stacked?: boolean
  /** Seconds of history to show; omit to inherit the page/widget's window. */
  window?: number
}

export interface KeyValueRow {
  key: string
  label: string
  format?: ValueFormat
}

/** A fixed label/value list from one resolved object, e.g. an inspect panel. */
export interface KeyValueBlock {
  type: 'keyValue'
  source: DataSource
  rows: KeyValueRow[]
}

export interface ListColumn {
  key: string
  label?: string
  format?: ValueFormat
  align?: 'left' | 'right'
}

/** A short, unsorted, unfiltered list of rows - lighter than `table` for a Overview-sized widget. */
export interface ListBlock {
  type: 'list'
  source: DataSource
  columns: ListColumn[]
  /** Cap the number of rows shown; the source's own array is not truncated on disk. */
  limit?: number
  emptyText?: string
}

export interface TableColumn {
  key: string
  label: string
  format?: ValueFormat
  align?: 'left' | 'right'
  /** Defaults to true. */
  sortable?: boolean
  /** Show a group's total for this column instead of leaving it blank. */
  aggregate?: boolean
}

export interface TableGroupMode {
  id: string
  label: string
  /** Column key to group by; combined with `parentIdKey` this becomes a tree. */
  key: string
  /** Row key that names a row's own id, for matching against `key` on other rows. */
  parentIdKey?: string
}

export interface TableSortDefault {
  key: string
  dir: 'asc' | 'desc'
}

export interface TableBlock {
  type: 'table'
  source: DataSource
  columns: TableColumn[]
  /**
   * Row field used for React keys and for matching a `rowDetail` drawer back
   * to its row on every fresh poll. Defaults to the first column's key - set
   * this explicitly when no displayed column is unique on its own (several
   * connections can share a local port, several processes can share a GPU
   * index, several tags can share an image id).
   */
  rowKey?: string
  sortDefault?: TableSortDefault
  /** Columns the text filter searches; defaults to every text column. */
  filterKeys?: string[]
  groupModes?: TableGroupMode[]
  rowActions?: ActionSpec[]
  /**
   * Adds a tick column and a toolbar for `bulkActions`. Requires an explicit
   * `rowKey`: a selection is a list of those keys, so a column that repeats
   * would act on rows the user did not tick.
   */
  selectable?: boolean
  /**
   * Buttons that act on the ticked rows, called as
   * `method(selectedRowKeys[], ...args, promptValue?)`. The array of keys comes
   * first, before the spec's own `args` - `argsFromRow` means nothing here
   * because there is no single row.
   */
  bulkActions?: ActionSpec[]
  /** Blocks rendered in a drawer when a row is clicked, scoped to that row (`$row.*`). */
  rowDetail?: Block[]
  emptyText?: string
}

/**
 * A live-tailed event, not a declared stream: it does not have to be in
 * `manifest.streams`. `startMethod`/`stopMethod`, when present, must be in
 * `manifest.methods`.
 */
export interface LogBlock {
  type: 'log'
  event: string
  startMethod?: string
  stopMethod?: string
  /** Field names read off the current scope (e.g. `["id"]` for a table row) and passed as args to start/stop, in order. */
  argsFromScope?: string[]
}

/** Opens an embedded terminal running a command built from the current scope. */
export interface TerminalBlock {
  type: 'terminal'
  label: string
  /** `{{key}}` placeholders are filled from the current scope. */
  commandTemplate: string
}

export interface ActionsBlock {
  type: 'actions'
  actions: ActionSpec[]
}

export interface FormFieldOption {
  value: string
  label: string
}

/**
 * `color` is a hex string plus a swatch picker; leaving it empty is meaningful
 * (a module is free to read that as "pick one for me"). `password` only hides
 * the typing - it is sent over the same channel as everything else.
 */
export type FormInput =
  | 'number'
  | 'text'
  | 'select'
  | 'checkbox'
  | 'password'
  | 'textarea'
  | 'color'

export interface FormField {
  key: string
  label: string
  input: FormInput
  /** `select` only: the fixed choices. */
  options?: FormFieldOption[]
  /**
   * `select` only: choices asked of the module instead of listed here, so a
   * form can offer what actually exists on the target machine. Must resolve to
   * an `Array<{ value, label }>`; read once when the block first becomes visible.
   */
  optionsFrom?: DataSource
  placeholder?: string
  /** A line under the field saying what it is for. */
  help?: string
  /** What the field starts out as. */
  initial?: string | number | boolean
  /** Scope key (a table row's field) to start from, which wins over `initial`. */
  initialFromScope?: string
}

export interface FormBlock {
  type: 'form'
  /** Heading above the fields; worth having when a drawer stacks several forms. */
  title?: string
  fields: FormField[]
  submit: ActionSpec
}

/**
 * Fields the user cannot apply until the module has looked at them and said
 * what would happen. `checkMethod` is called as
 * `method(...argsFromScope, values)` and answers a `ModuleCheckReport`
 * (shared/check.ts); the app shows its findings and only offers
 * `method(...argsFromScope, { token, values })` when the report said `ok`.
 * Editing any field throws the report away, so what is applied is always what
 * was read. Use `kind: 'danger'` for anything destructive - it turns the apply
 * button red and puts a confirm dialog in front of it.
 */
export interface CheckFormBlock {
  type: 'checkForm'
  title?: string
  fields: FormField[]
  /** Must be one of `manifest.methods`. */
  checkMethod: string
  /** Must be one of `manifest.methods`. */
  applyMethod: string
  /** Scope keys passed to both methods before the values object, in order. */
  argsFromScope?: string[]
  checkLabel?: string
  applyLabel?: string
  kind?: 'default' | 'danger'
}

/**
 * One tinted card per array item, for a fleet-style status wall where the
 * number of cards is data rather than spec. `table` cannot do this: it has one
 * row per item and no data-driven colour.
 */
export interface StatusCardsBlock {
  type: 'statusCards'
  source: DataSource
  /** Field holding the card's own id - React key, and the drawer's identity across refreshes. */
  rowKey: string
  /** Field printed in the title row. */
  titleKey: string
  /** Field holding `ok` | `warn` | `bad` | `unknown`; tints the title row. */
  statusKey: string
  /** Field with a short right-aligned summary in the title row ("3/4 running"). */
  subtitleKey?: string
  /** A collapsible line under the title, for what the module knows about this item. */
  note?: { key: string; label?: string; startOpen?: boolean }
  /** The chips inside the card. `key` is an array of `{ label, status, pinned? }`. */
  items: {
    key: string
    /** Chip rows shown before the expand arrow; default 2. */
    visibleRows?: number
    labelKey?: string
    statusKey?: string
    pinnedKey?: string
    /** Adds a "pinned only" switch to the toolbar, filtering chips by `pinnedKey`. */
    pinnedFilterLabel?: string
    emptyText?: string
  }
  /** Card columns the user can change at runtime. */
  columns?: { default?: number; min?: number; max?: number }
  rowActions?: ActionSpec[]
  /** Blocks in a drawer when a card is clicked, scoped to that item (`$row.*`). */
  rowDetail?: Block[]
  emptyText?: string
}

export interface ConditionalWhen {
  source: DataSource
  path?: string
  op: 'exists' | 'eq' | 'gt'
  value?: unknown
}

/** Shows one of two block lists depending on the resolved data - e.g. "tool missing" copy. */
export interface ConditionalBlock {
  type: 'conditional'
  when: ConditionalWhen
  blocks: Block[]
  else?: Block[]
}

export type Block =
  | SectionBlock
  | StatBlock
  | MeterBlock
  | ChartBlock
  | KeyValueBlock
  | ListBlock
  | TableBlock
  | StatusCardsBlock
  | LogBlock
  | TerminalBlock
  | ActionsBlock
  | FormBlock
  | CheckFormBlock
  | ConditionalBlock

/** `ui/pages/<pageId>.json` - one sidebar page. */
export interface PageSpec {
  blocks: Block[]
}

/** `ui/widgets/<widgetId>.json` - one Overview card. */
export interface WidgetSpec {
  blocks: Block[]
  /** Seconds of history charts inside it show; omit to inherit the Overview's own window. */
  window?: number
}

/** The `modules:specs` payload: one entry per enabled module, keyed by page/widget id. */
export interface ModuleSpecsEntry {
  id: string
  manifest: ModuleManifest
  pages: Record<string, PageSpec>
  widgets: Record<string, WidgetSpec>
}

const BLOCK_TYPES = new Set<Block['type']>([
  'section',
  'stat',
  'meter',
  'chart',
  'keyValue',
  'list',
  'table',
  'statusCards',
  'log',
  'terminal',
  'actions',
  'form',
  'checkForm',
  'conditional'
])

const VALUE_FORMATS = new Set<ValueFormat>([
  'bytes',
  'rate',
  'pct',
  'temp',
  'number',
  'text',
  'duration',
  'badges'
])

const FORM_INPUTS = new Set<FormInput>([
  'number',
  'text',
  'select',
  'checkbox',
  'password',
  'textarea',
  'color'
])

/** Blocks nested inside `blocks`/`rowDetail`/`else`; walked to check they never reference a CDN. */
function nestedBlockArrays(block: Record<string, unknown>): Array<{ path: string; blocks: unknown[] }> {
  const out: Array<{ path: string; blocks: unknown[] }> = []
  const blocks = block['blocks']
  const rowDetail = block['rowDetail']
  const elseBlocks = block['else']
  if (Array.isArray(blocks)) out.push({ path: 'blocks', blocks })
  if (Array.isArray(rowDetail)) out.push({ path: 'rowDetail', blocks: rowDetail })
  if (Array.isArray(elseBlocks)) out.push({ path: 'else', blocks: elseBlocks })
  return out
}

function pushIf(problems: string[], condition: boolean, message: string): void {
  if (condition) problems.push(message)
}

function checkFormat(problems: string[], where: string, format: unknown): void {
  if (format != null && !VALUE_FORMATS.has(format as ValueFormat)) {
    problems.push(`${where}: "${String(format)}" is not a value format`)
  }
}

/** `where` names the source field itself (`blocks[0].source`, `...fields[1].optionsFrom`). */
function checkSource(problems: string[], where: string, source: unknown, manifest: ModuleManifest): void {
  if (typeof source !== 'object' || source === null) {
    problems.push(`${where} is missing`)
    return
  }
  const s = source as Record<string, unknown>
  const streamEvents = new Set((manifest.streams ?? []).map((x) => x.event))
  const kind = s['kind']
  switch (kind) {
    case 'stream': {
      const event = s['event']
      const known = typeof event === 'string' && streamEvents.has(event)
      if (!known) problems.push(`${where}: stream "${String(event)}" is not declared in manifest.streams`)
      break
    }
    case 'invoke':
      checkMethod(problems, where, s['method'], manifest)
      break
    case 'history': {
      // A module may chart its own history, or one of the app's own streams
      // behind a comparison. Naming a third module's stream is the one case
      // refused: that module can be uninstalled, and reading the chart of
      // something the user removed is not a dependency worth having.
      const stream = s['stream']
      if (typeof stream !== 'string' || !stream) {
        problems.push(`${where}.stream is missing`)
      } else if (
        !ownsHistoryStream(manifest.id, stream) &&
        !(CORE_HISTORY_STREAMS as readonly string[]).includes(stream)
      ) {
        problems.push(
          `${where}: history stream "${stream}" belongs to another module - use "${manifest.id}", "${manifest.id}-<name>", or one of ${CORE_HISTORY_STREAMS.join(', ')}`
        )
      }
      break
    }
    case 'core': {
      const stream = s['stream']
      if (stream !== 'system' && stream !== 'top' && stream !== 'services') {
        problems.push(`${where}: "${String(stream)}" is not a core stream (system, top, services)`)
      }
      break
    }
    default:
      problems.push(`${where}.kind "${String(kind)}" is not a data source kind`)
  }
}

function checkMethod(problems: string[], where: string, method: unknown, manifest: ModuleManifest): void {
  const methods = new Set(manifest.methods ?? [])
  const known = typeof method === 'string' && methods.has(method)
  if (!known) problems.push(`${where}: method "${String(method)}" is not declared in manifest.methods`)
}

function checkAction(problems: string[], where: string, action: unknown, manifest: ModuleManifest): void {
  if (typeof action !== 'object' || action === null) {
    problems.push(`${where} is not an object`)
    return
  }
  const a = action as Record<string, unknown>
  if (typeof a['label'] !== 'string' || !a['label']) problems.push(`${where}.label is missing`)
  checkMethod(problems, where, a['method'], manifest)
}

/** The field list shared by `form` and `checkForm`. */
function checkFields(problems: string[], where: string, fields: unknown, manifest: ModuleManifest): void {
  if (!Array.isArray(fields) || fields.length === 0) {
    problems.push(`${where} is empty`)
    return
  }
  const seen = new Set<string>()
  for (const [i, field] of fields.entries()) {
    const at = `${where}[${i}]`
    if (typeof field !== 'object' || field === null) {
      problems.push(`${at} is not an object`)
      continue
    }
    const f = field as Record<string, unknown>
    const key = f['key']
    if (typeof key !== 'string' || !key) problems.push(`${at}.key is missing`)
    // Values are collected into one object per form, so a repeated key would
    // silently drop a field the user filled in.
    else if (seen.has(key)) problems.push(`${at}.key "${key}" is used twice`)
    else seen.add(key)
    const input = f['input']
    if (!FORM_INPUTS.has(input as FormInput)) {
      problems.push(`${at}.input "${String(input)}" is not a form input`)
    }
    if (f['optionsFrom'] != null) {
      if (input !== 'select') problems.push(`${at}.optionsFrom only applies to a select`)
      checkSource(problems, `${at}.optionsFrom`, f['optionsFrom'], manifest)
    }
  }
}

/** Checks one block's own fields (not its nested block arrays, done by the caller). */
function checkBlock(problems: string[], where: string, block: unknown, manifest: ModuleManifest): void {
  if (typeof block !== 'object' || block === null) {
    problems.push(`${where} is not an object`)
    return
  }
  const b = block as Record<string, unknown>
  const type = b['type']
  if (typeof type !== 'string' || !BLOCK_TYPES.has(type as Block['type'])) {
    problems.push(`${where}.type "${String(type)}" is not a known block type`)
    return
  }

  switch (type as Block['type']) {
    case 'section':
      break
    case 'stat':
    case 'meter':
      pushIf(problems, typeof b['label'] !== 'string' || !b['label'], `${where}.label is missing`)
      checkSource(problems, `${where}.source`, b['source'], manifest)
      checkFormat(problems, where, b['format'])
      if (type === 'stat') {
        const spark = b['spark'] as Record<string, unknown> | undefined
        if (spark != null) checkSource(problems, `${where}.spark.source`, spark['source'], manifest)
      }
      break
    case 'chart': {
      checkSource(problems, `${where}.source`, b['source'], manifest)
      pushIf(
        problems,
        b['kind'] !== 'line' && b['kind'] !== 'area' && b['kind'] !== 'bar',
        `${where}.kind must be line, area or bar`
      )
      const series = b['series']
      pushIf(problems, !Array.isArray(series) || series.length === 0, `${where}.series is empty`)
      checkFormat(problems, where, b['format'])
      break
    }
    case 'keyValue':
      checkSource(problems, `${where}.source`, b['source'], manifest)
      pushIf(problems, !Array.isArray(b['rows']), `${where}.rows is missing`)
      break
    case 'list':
      checkSource(problems, `${where}.source`, b['source'], manifest)
      pushIf(problems, !Array.isArray(b['columns']), `${where}.columns is missing`)
      break
    case 'table': {
      checkSource(problems, `${where}.source`, b['source'], manifest)
      const columns = b['columns']
      pushIf(problems, !Array.isArray(columns) || columns.length === 0, `${where}.columns is empty`)
      const rowActions = b['rowActions']
      for (const [i, action] of (Array.isArray(rowActions) ? rowActions : []).entries()) {
        checkAction(problems, `${where}.rowActions[${i}]`, action, manifest)
      }
      const bulkActions = b['bulkActions']
      for (const [i, action] of (Array.isArray(bulkActions) ? bulkActions : []).entries()) {
        checkAction(problems, `${where}.bulkActions[${i}]`, action, manifest)
      }
      // A selection is a list of rowKey values, and the default rowKey is
      // whatever the first column happens to be - fine for a React key, not
      // for deciding which containers to remove.
      pushIf(
        problems,
        b['selectable'] === true && (typeof b['rowKey'] !== 'string' || !b['rowKey']),
        `${where}.rowKey is required when selectable is true`
      )
      pushIf(
        problems,
        Array.isArray(bulkActions) && bulkActions.length > 0 && b['selectable'] !== true,
        `${where}.bulkActions needs selectable: true, or nothing can reach them`
      )
      break
    }
    case 'statusCards': {
      checkSource(problems, `${where}.source`, b['source'], manifest)
      // A card has no columns to fall back on the way a table does: the three
      // fields below are the only thing that decides what it draws.
      for (const field of ['rowKey', 'titleKey', 'statusKey'] as const) {
        pushIf(problems, typeof b[field] !== 'string' || !b[field], `${where}.${field} is missing`)
      }
      const items = b['items'] as Record<string, unknown> | undefined
      if (items == null) problems.push(`${where}.items is missing`)
      else pushIf(problems, typeof items['key'] !== 'string' || !items['key'], `${where}.items.key is missing`)
      const cardActions = b['rowActions']
      for (const [i, action] of (Array.isArray(cardActions) ? cardActions : []).entries()) {
        checkAction(problems, `${where}.rowActions[${i}]`, action, manifest)
      }
      break
    }
    case 'log': {
      pushIf(problems, typeof b['event'] !== 'string' || !b['event'], `${where}.event is missing`)
      if (b['startMethod'] != null) checkMethod(problems, `${where}.startMethod`, b['startMethod'], manifest)
      if (b['stopMethod'] != null) checkMethod(problems, `${where}.stopMethod`, b['stopMethod'], manifest)
      break
    }
    case 'terminal':
      pushIf(problems, typeof b['label'] !== 'string' || !b['label'], `${where}.label is missing`)
      pushIf(
        problems,
        typeof b['commandTemplate'] !== 'string' || !b['commandTemplate'],
        `${where}.commandTemplate is missing`
      )
      break
    case 'actions': {
      const actions = b['actions']
      for (const [i, action] of (Array.isArray(actions) ? actions : []).entries()) {
        checkAction(problems, `${where}.actions[${i}]`, action, manifest)
      }
      break
    }
    case 'form': {
      checkFields(problems, `${where}.fields`, b['fields'], manifest)
      checkAction(problems, `${where}.submit`, b['submit'], manifest)
      break
    }
    case 'checkForm': {
      checkFields(problems, `${where}.fields`, b['fields'], manifest)
      checkMethod(problems, `${where}.checkMethod`, b['checkMethod'], manifest)
      checkMethod(problems, `${where}.applyMethod`, b['applyMethod'], manifest)
      break
    }
    case 'conditional': {
      const when = b['when'] as Record<string, unknown> | undefined
      if (when == null) problems.push(`${where}.when is missing`)
      else {
        checkSource(problems, `${where}.when.source`, when['source'], manifest)
        pushIf(
          problems,
          when['op'] !== 'exists' && when['op'] !== 'eq' && when['op'] !== 'gt',
          `${where}.when.op must be exists, eq or gt`
        )
      }
      break
    }
  }
}

/** True when any string value anywhere in `value` contains a URL - the no-CDN rule (T7.1). */
function containsUrl(value: unknown): boolean {
  if (typeof value === 'string') return /https?:\/\//i.test(value)
  if (Array.isArray(value)) return value.some(containsUrl)
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some(containsUrl)
  }
  return false
}

/**
 * Check one `ui/pages/<id>.json` or `ui/widgets/<id>.json` against the block
 * schema and the manifest that declares it: every block type is known, every
 * `source`/method points at something the manifest actually declares, and no
 * value anywhere is a URL (modules ship data, not remote scripts or images).
 * Returns the reasons it is unusable - empty means the spec is fine.
 */
export function specProblems(spec: unknown, manifest: ModuleManifest): string[] {
  const problems: string[] = []
  if (typeof spec !== 'object' || spec === null) return ['spec is not an object']
  const s = spec as Record<string, unknown>
  const topBlocks = s['blocks']
  if (!Array.isArray(topBlocks)) return ['spec.blocks is missing']

  const walk = (blocks: unknown[], path: string): void => {
    if (!Array.isArray(blocks)) {
      problems.push(`${path} is not an array`)
      return
    }
    blocks.forEach((block, i) => {
      const where = `${path}[${i}]`
      checkBlock(problems, where, block, manifest)
      if (typeof block === 'object' && block !== null) {
        for (const nested of nestedBlockArrays(block as Record<string, unknown>)) {
          walk(nested.blocks, `${where}.${nested.path}`)
        }
      }
    })
  }
  walk(topBlocks, 'blocks')

  if (containsUrl(spec)) {
    problems.push('spec contains a URL (http:// or https://) - modules may not reference remote content')
  }

  return problems
}
