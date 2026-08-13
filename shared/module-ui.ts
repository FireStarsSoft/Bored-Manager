// The declarative UI a module ships instead of React: a page or widget is a
// tree of `Block`s, each one naming where its data comes from (`DataSource`)
// and, for the interactive ones, which of the module's own methods it may
// call. The app renders this itself (src/modules/BlockRenderer.tsx); nothing
// here executes - it is read, validated (`specProblems`) and walked.
import type { ModuleManifest } from './modules'

/**
 * How a raw value is printed. Maps 1-1 to formatBytes/Rate/Pct/Temp/Duration in
 * src/lib/utils.ts. `duration` is the odd one out: the raw value is an
 * absolute `startedAt`-style ms timestamp, not an elapsed amount - a block
 * cannot compute `Date.now() - value` itself, so the formatter does it.
 */
export type ValueFormat = 'bytes' | 'rate' | 'pct' | 'temp' | 'number' | 'text' | 'duration'

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

export interface FormField {
  key: string
  label: string
  input: 'number' | 'text' | 'select'
  options?: FormFieldOption[]
}

export interface FormBlock {
  type: 'form'
  fields: FormField[]
  submit: ActionSpec
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
  | LogBlock
  | TerminalBlock
  | ActionsBlock
  | FormBlock
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
  'log',
  'terminal',
  'actions',
  'form',
  'conditional'
])

const VALUE_FORMATS = new Set<ValueFormat>([
  'bytes',
  'rate',
  'pct',
  'temp',
  'number',
  'text',
  'duration'
])

/** Blocks nested inside `blocks`/`rowDetail`/`else`; walked to check they never reference a CDN. */
function nestedBlockArrays(block: Record<string, unknown>): unknown[][] {
  const out: unknown[][] = []
  const blocks = block['blocks']
  const rowDetail = block['rowDetail']
  const elseBlocks = block['else']
  if (Array.isArray(blocks)) out.push(blocks)
  if (Array.isArray(rowDetail)) out.push(rowDetail)
  if (Array.isArray(elseBlocks)) out.push(elseBlocks)
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

function checkSource(problems: string[], where: string, source: unknown, manifest: ModuleManifest): void {
  if (typeof source !== 'object' || source === null) {
    problems.push(`${where}.source is missing`)
    return
  }
  const s = source as Record<string, unknown>
  const streamEvents = new Set((manifest.streams ?? []).map((x) => x.event))
  const kind = s['kind']
  switch (kind) {
    case 'stream': {
      const event = s['event']
      const known = typeof event === 'string' && streamEvents.has(event)
      if (!known) problems.push(`${where}.source: stream "${String(event)}" is not declared in manifest.streams`)
      break
    }
    case 'invoke':
      checkMethod(problems, `${where}.source`, s['method'], manifest)
      break
    case 'history': {
      const stream = s['stream']
      if (typeof stream !== 'string' || !stream) problems.push(`${where}.source.stream is missing`)
      break
    }
    case 'core': {
      const stream = s['stream']
      if (stream !== 'system' && stream !== 'top' && stream !== 'services') {
        problems.push(`${where}.source: "${String(stream)}" is not a core stream (system, top, services)`)
      }
      break
    }
    default:
      problems.push(`${where}.source.kind "${String(kind)}" is not a data source kind`)
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
      checkSource(problems, where, b['source'], manifest)
      checkFormat(problems, where, b['format'])
      if (type === 'stat') {
        const spark = b['spark'] as Record<string, unknown> | undefined
        if (spark != null) checkSource(problems, `${where}.spark`, spark['source'], manifest)
      }
      break
    case 'chart': {
      checkSource(problems, where, b['source'], manifest)
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
      checkSource(problems, where, b['source'], manifest)
      pushIf(problems, !Array.isArray(b['rows']), `${where}.rows is missing`)
      break
    case 'list':
      checkSource(problems, where, b['source'], manifest)
      pushIf(problems, !Array.isArray(b['columns']), `${where}.columns is missing`)
      break
    case 'table': {
      checkSource(problems, where, b['source'], manifest)
      const columns = b['columns']
      pushIf(problems, !Array.isArray(columns) || columns.length === 0, `${where}.columns is empty`)
      const rowActions = b['rowActions']
      for (const [i, action] of (Array.isArray(rowActions) ? rowActions : []).entries()) {
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
      const fields = b['fields']
      for (const [i, field] of (Array.isArray(fields) ? fields : []).entries()) {
        const f = (typeof field === 'object' && field !== null ? field : {}) as Record<string, unknown>
        pushIf(problems, typeof f['key'] !== 'string' || !f['key'], `${where}.fields[${i}].key is missing`)
      }
      checkAction(problems, `${where}.submit`, b['submit'], manifest)
      break
    }
    case 'conditional': {
      const when = b['when'] as Record<string, unknown> | undefined
      if (when == null) problems.push(`${where}.when is missing`)
      else {
        checkSource(problems, `${where}.when`, when['source'], manifest)
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
          walk(nested, `${where}.blocks`)
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
