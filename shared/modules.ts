// The module system: what a module declares about itself, and the rules an
// archive has to satisfy before the app will install it. Shared between the
// main process (which enforces the rules) and the renderer (which shows the
// verdict), so there is exactly one definition of "a valid module".

/**
 * Version of the contract between the app and a module's entry points. A
 * module declares which one it was written against; the app refuses anything
 * it cannot run. Bump only when an existing entry point changes shape.
 *
 * 2: the renderer half stopped being React compiled into the bundle and
 *    became a declarative `ui/*.json` spec the app renders itself (Phase 3).
 *    `entries.renderer` (the old React entry) is rejected outright - see
 *    `entries.renderer` below.
 */
export const MODULE_API_VERSION = 2

/** Ids the app uses for its own pages - a module may not claim one of them. */
export const RESERVED_MODULE_IDS = [
  'overview',
  'packages',
  'terminals',
  'settings',
  'core',
  'app',
  'module',
  'modules',
  'system'
] as const

/**
 * Lowercase, starts with a letter, 2-32 characters. The id doubles as the
 * folder name, the IPC channel prefix and the layout key of its cards, so it
 * has to be safe in all three.
 */
export const MODULE_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/

/**
 * Same alphabet as a module id, one character shorter at the minimum. A page
 * or widget id only ever appears qualified by its module (`<moduleId>/<id>`,
 * `<moduleId>.<id>`), so `main` or `a` is unambiguous where a bare module id
 * would not be.
 */
export const SUB_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

export const MODULE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/

/** File that carries the manifest, at the root of the module folder. */
export const MODULE_MANIFEST_FILE = 'module.json'

/** Largest module archive the app will download. */
export const MODULE_ARCHIVE_MAX_BYTES = 50 * 1024 * 1024

export const MODULE_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000

/** A sidebar page a module contributes. ≥2 pages become a dropdown (T4.1). */
export interface ModulePageDecl {
  /** Unique within the module; the route is `<moduleId>/<id>`. */
  id: string
  label: string
  /** lucide-react icon name, e.g. "HardDrive". */
  icon?: string
  /** Sort key among the module's own pages, and among sidebar entries when there is only one. */
  order?: number
}

/** An Overview widget a module contributes. */
export interface ModuleWidgetDecl {
  /** Unique within the module; the settings/layout key is `<moduleId>.<id>`. */
  id: string
  label: string
  /** Shown on unless the user turns it off. */
  defaultEnabled?: boolean
  /** Position among the Overview cards before the user drags anything. */
  order?: number
}

/**
 * A snapshot channel the main half emits. The app mirrors it into the
 * renderer's module bus so a block's `{ kind: 'stream' }` source can read it
 * without the module wiring anything itself.
 */
export interface ModuleStreamDecl {
  event: string
  /** `series` keeps a 5-minute ring keyed by `t`; `latest` keeps one value. */
  kind: 'series' | 'latest'
}

/** `module.json` - everything the app knows about a module before running it. */
export interface ModuleManifest {
  apiVersion: number
  id: string
  name: string
  version: string
  description: string
  author: string
  /** Lowest app version this module works with, e.g. "0.0.1". */
  minAppVersion?: string
  /** Whether the module is enabled on first install. Defaults to true. */
  defaultEnabled?: boolean
  entries: {
    /** Path inside the module folder to its main-process half, e.g. `main/index.ts`. */
    main: string
    /**
     * No longer supported (T3.7): the API v1 renderer half was a React entry
     * point compiled into the app's own bundle. Kept in the type only so
     * `manifestProblems` can recognise it and reject it with a clear
     * message instead of silently ignoring an unknown field.
     */
    renderer?: string
  }
  /** Sidebar pages; omit for a module that only adds Overview widgets. */
  pages?: ModulePageDecl[]
  widgets?: ModuleWidgetDecl[]
  streams?: ModuleStreamDecl[]
  /** Names registered with `ctx.handle`, callable from a block spec. */
  methods?: string[]
  /** Key in settings.refresh this module reads. */
  fastInterval?: string
  /** Key in settings.slowRefresh this module reads. */
  slowInterval?: string
}

/** Where an installed module came from. */
export type ModuleSource = 'default' | 'zip' | 'url'

/**
 * Whether the files on disk still hash to what was recorded when the module
 * was installed. `unknown` means the hash could not be computed (unreadable
 * folder), not that the module is broken.
 */
export type ModuleIntegrity = 'ok' | 'modified' | 'unknown'

/** The app's own record of an installed module, kept outside the module. */
export interface ModuleRuntimeState {
  id: string
  enabled: boolean
  /** Version recorded at install time; compared against the manifest on load. */
  version: string
  /** SHA-256 over the module folder, see moduleFolderHash. */
  hash: string
  source: ModuleSource
  installedAt: number
  updatedAt: number
}

/** An installed module as the Settings page sees it. */
export interface ModuleDescriptor {
  manifest: ModuleManifest
  state: ModuleRuntimeState
  integrity: ModuleIntegrity
  /** Set when the module is present but cannot be run, with the reason. */
  problem?: string
  /** Present when the module ships them, for the Details dialog. */
  readme?: string
  changelog?: string
}

/**
 * One rule the app checked an archive against. `error` blocks the install,
 * `warning` needs the user to confirm, `info` and `pass` are informational.
 */
export type ModuleCheckLevel = 'pass' | 'info' | 'warning' | 'error'

export interface ModuleCheckItem {
  id: string
  level: ModuleCheckLevel
  label: string
  detail?: string
}

/** What installing the inspected archive would do to the current install. */
export type ModuleInstallKind = 'new' | 'upgrade' | 'reinstall' | 'downgrade'

export interface ModuleValidation {
  /** error = cannot install; warning = install only after confirming. */
  status: 'pass' | 'warning' | 'error'
  kind: ModuleInstallKind
  moduleId?: string
  moduleName?: string
  newVersion?: string
  /** Version currently installed, absent for a new module. */
  installedVersion?: string
  /** True when this would overwrite a module that shipped with the app. */
  overwritesDefault: boolean
  checks: ModuleCheckItem[]
}

export type ModuleInstallPhase =
  | 'idle'
  | 'downloading'
  | 'extracting'
  | 'validating'
  | 'ready'
  | 'installing'
  | 'building'
  | 'done'
  | 'error'

export interface ModuleInstallState {
  phase: ModuleInstallPhase
  /** Archive being inspected: a URL or the path of the picked file. */
  source?: string
  progress?: { receivedBytes: number; totalBytes: number | null }
  validation?: ModuleValidation
  /** Tail of the build output while phase is 'building'. */
  log?: string[]
  /** Set once the module is in place; the app has to restart to load it. */
  restartRequired?: boolean
  error?: string
}

// ---------- The community catalog ----------
//
// registry/modules.json on the configured update repo's main branch: modules
// someone has reviewed and vouched for. The installer hashes every archive it
// grades and checks it against this list (see module-installer.ts's
// 'catalog-verified' / 'unverified-source' checks) - fetching and caching the
// file itself is server/services/registry.ts.

/** Version of the `registry/modules.json` schema below. */
export const REGISTRY_VERSION = 1

/** One module a maintainer has reviewed and is willing to vouch for. */
export interface RegistryEntry {
  /** Must match the module's own `module.json` id. */
  id: string
  name: string
  description: string
  author: string
  /** Opened in a new tab from the catalog; not every entry has one. */
  homepage?: string
  /** The version that was reviewed - not necessarily the module's latest. */
  version: string
  minAppVersion?: string
  /** Direct link to the reviewed archive, normally a GitHub release asset. */
  download: string
  /** hex SHA-256 of that exact archive; this is what "verified" is checked against. */
  sha256: string
  /** `YYYY-MM-DD` the entry was last reviewed. */
  verifiedAt: string
}

/** The shape of `registry/modules.json`. */
export interface RegistryFile {
  registryVersion: number
  modules: RegistryEntry[]
}

/** What `modules:catalog` and `modules:catalogRefresh` answer. */
export interface ModuleCatalog {
  entries: RegistryEntry[]
  /** When this list was fetched; null when a fetch has never succeeded. */
  fetchedAt: number | null
  /** True when a refetch failed and this is a cached (possibly older) copy. */
  stale: boolean
}

// ---------- The runtime contract ----------
//
// A module's entry points are typed entirely from this file: nothing here
// imports from `server/` or `src/`, so a module never has to reach into the
// app's internals to describe what it does. The server implements these
// shapes (see server/services/modules-host.ts).

export interface ModuleExecResult {
  stdout: string
  stderr: string
  code: number
}

export interface ModuleExecOptions {
  stdin?: string
  timeoutMs?: number
}

/** A command that keeps running, with its output arriving as it comes. */
export interface ModuleStreamHandle {
  write(data: string): void
  kill(): void
  onData(cb: (data: string) => void): void
  onExit(cb: (code: number | null) => void): void
}

/**
 * A repeating job. Starting it runs the tick immediately and then on the
 * interval; a tick that is still running never overlaps with the next one.
 * The app stops it on a clean close even if the module forgets to.
 */
export interface ModulePoller {
  start(intervalMs: number): void
  stop(): void
}

/** One reduced history sample: a timestamp plus a few numbers. */
export interface ModuleHistoryPoint {
  t: number
  [key: string]: number
}

/**
 * Everything a module may do in the main process. Deliberately narrow: a
 * module talks to the target machine and to its own renderer half, and never
 * touches Electron, the app folder or another module's state.
 */
export interface ModuleContext {
  readonly id: string
  /** Run a command on the target machine (local shell or SSH). */
  exec(command: string, opts?: ModuleExecOptions): Promise<ModuleExecResult>
  /** Same, elevated when a sudo password was given; plain otherwise. */
  execSudo(command: string, opts?: ModuleExecOptions): Promise<ModuleExecResult>
  /** Long-running command with a live output stream (e.g. `docker logs -f`). */
  stream(command: string): Promise<ModuleStreamHandle>
  /** Long-running elevated command with a live output stream. */
  streamSudo(command: string): Promise<ModuleStreamHandle>
  /** True when a target machine is connected. */
  readonly connected: boolean
  /** True when commands can be elevated (root, or a sudo password was given). */
  readonly hasSudo: boolean
  createPoller(name: string, tick: () => Promise<void>): ModulePoller
  /** Fast interval in ms for a settings.refresh key; 0 means "paused". */
  fastIntervalMs(key: string): number
  /** Slow interval in seconds for a settings.slowRefresh key; 0 means manual. */
  slowIntervalSec(key: string): number
  /** Detail collector mode for a settings.detailPolling key. */
  detailMode(key: string): 'tab' | 'always' | 'off'
  /** True while any of this module's pages is the visible tab (`<id>` or `<id>/<page>`). */
  readonly tabActive: boolean
  /** Push a payload to the module's renderer half under this event name. */
  emit(event: string, payload: unknown): void
  /** Answer a call from the module's renderer half. */
  handle(method: string, fn: (...args: never[]) => unknown): void
  /** Append a reduced sample to this module's metrics stream on disk. */
  addHistory(point: ModuleHistoryPoint, stream?: string): void
  /** Whether another module is installed and enabled, for optional probes. */
  isModuleEnabled(id: string): boolean
  log(message: string): void
}

/** What a module's main entry returns. Only `dispose` is required. */
export interface ModuleMainInstance {
  /**
   * Start or stop this module's pollers to match the current settings and
   * connection. Called on connect, disconnect, every settings change and when
   * the visible tab changes, so it has to be idempotent.
   */
  applyPollers?(): void
  /** Drop per-session state: rate baselines, session totals, caches. */
  reset?(): void
  /**
   * What a freshly connected renderer needs so its charts do not start empty,
   * keyed by the event name the module emits that data under.
   */
  snapshots?(): Record<string, unknown>
  /** Take an immediate reading of a slow section this module owns. */
  refreshSlow?(target: string): Promise<void>
  /** Slow sections this module answers refreshSlow for. */
  slowTargets?(): string[]
  /** Release everything: pollers, watchers, log streams. */
  dispose(): void
}

/** The default export of `main/index.ts`. */
export type ModuleActivate = (ctx: ModuleContext) => ModuleMainInstance

/**
 * Compare two `x.y.z` strings. Returns a negative number when `a` is older,
 * 0 when they are the same, positive when `a` is newer. Anything that is not
 * a number counts as 0, so a malformed version sorts as the lowest.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Why this id cannot be used, or null when it is fine. */
export function moduleIdProblem(id: unknown): string | null {
  if (typeof id !== 'string' || id.length === 0) return 'no id'
  if (!MODULE_ID_PATTERN.test(id)) {
    return `"${id}" is not a valid id (lowercase letters, digits and dashes, 2-32 characters)`
  }
  if ((RESERVED_MODULE_IDS as readonly string[]).includes(id)) {
    return `"${id}" is a name the app uses itself`
  }
  return null
}

/** The full card id as used in settings and the Overview layout. */
export function moduleCardId(moduleId: string, cardId: string): string {
  return `${moduleId}.${cardId}`
}

/** A relative path has to stay inside the module folder. */
function badRelativePath(value: string): boolean {
  return value.startsWith('/') || value.includes('..') || value.includes('\\')
}

function pathProblem(field: string, value: unknown, required: boolean): string | null {
  if (value == null) return required ? `${field} is required` : null
  if (typeof value !== 'string' || !value.trim()) return `${field} is not a path`
  if (badRelativePath(value)) return `${field} must be a relative path inside the module folder`
  return null
}

/** Why this id cannot be used as a page or widget id, or null when it is fine. */
function subIdProblem(kind: string, id: unknown): string | null {
  if (typeof id !== 'string' || !SUB_ID_PATTERN.test(id)) {
    return `${kind} id "${String(id)}" is not valid (lowercase letters, digits and dashes, 1-32 characters)`
  }
  return null
}

/**
 * Check a parsed `module.json` against the schema. Returns the reasons it is
 * unusable - empty means the manifest is fine. Used both when installing an
 * archive and when loading what is already on disk, so a module can never be
 * half-accepted.
 */
export function manifestProblems(raw: unknown): string[] {
  const problems: string[] = []
  if (typeof raw !== 'object' || raw === null) return ['module.json is not an object']
  const m = raw as Partial<ModuleManifest>

  if (typeof m.apiVersion !== 'number') problems.push('apiVersion is missing')
  else if (m.apiVersion !== MODULE_API_VERSION) {
    problems.push(
      `apiVersion ${m.apiVersion} cannot be run by this app (it speaks ${MODULE_API_VERSION})`
    )
  }

  const idProblem = moduleIdProblem(m.id)
  if (idProblem) problems.push(idProblem)

  if (typeof m.name !== 'string' || !m.name.trim()) problems.push('name is missing')
  if (typeof m.version !== 'string' || !MODULE_VERSION_PATTERN.test(m.version)) {
    problems.push('version is not in x.y.z form')
  }
  if (m.minAppVersion != null && !MODULE_VERSION_PATTERN.test(String(m.minAppVersion))) {
    problems.push('minAppVersion is not in x.y.z form')
  }

  const entries = m.entries
  if (typeof entries !== 'object' || entries === null) {
    problems.push('entries is missing')
  } else {
    const mainProblem = pathProblem('entries.main', entries.main, true)
    if (mainProblem) problems.push(mainProblem)
    if (entries.renderer != null) {
      problems.push(
        'entries.renderer is no longer supported (API v2) - the renderer half must be ui/pages/*.json and ui/widgets/*.json, not a compiled-in React entry'
      )
    }
  }

  const seenPages = new Set<string>()
  for (const page of m.pages ?? []) {
    if (typeof page !== 'object' || page === null) {
      problems.push('pages contains something that is not an object')
      continue
    }
    const p = page as Partial<ModulePageDecl>
    const problem = subIdProblem('page', p.id)
    if (problem) problems.push(problem)
    else if (seenPages.has(p.id as string)) problems.push(`page id "${p.id}" is declared twice`)
    else seenPages.add(p.id as string)
    if (typeof p.label !== 'string' || !p.label.trim()) {
      problems.push(`page "${String(p.id)}" has no label`)
    }
    if (p.order != null && typeof p.order !== 'number') {
      problems.push(`page "${String(p.id)}".order is not a number`)
    }
  }

  const seenWidgets = new Set<string>()
  for (const widget of m.widgets ?? []) {
    if (typeof widget !== 'object' || widget === null) {
      problems.push('widgets contains something that is not an object')
      continue
    }
    const w = widget as Partial<ModuleWidgetDecl>
    const problem = subIdProblem('widget', w.id)
    if (problem) problems.push(problem)
    else if (seenWidgets.has(w.id as string)) problems.push(`widget id "${w.id}" is declared twice`)
    else seenWidgets.add(w.id as string)
    if (typeof w.label !== 'string' || !w.label.trim()) {
      problems.push(`widget "${String(w.id)}" has no label`)
    }
  }

  for (const stream of m.streams ?? []) {
    if (typeof stream !== 'object' || stream === null) {
      problems.push('streams contains something that is not an object')
      continue
    }
    const s = stream as Partial<ModuleStreamDecl>
    if (typeof s.event !== 'string' || !s.event.trim()) {
      problems.push('a stream is missing its event name')
    }
    if (s.kind !== 'series' && s.kind !== 'latest') {
      problems.push(`stream "${String(s.event)}" has an invalid kind (must be "series" or "latest")`)
    }
  }

  if (m.methods != null && (!Array.isArray(m.methods) || m.methods.some((x) => typeof x !== 'string'))) {
    problems.push('methods is not an array of strings')
  }
  if (m.fastInterval != null && typeof m.fastInterval !== 'string') {
    problems.push('fastInterval is not a string')
  }
  if (m.slowInterval != null && typeof m.slowInterval !== 'string') {
    problems.push('slowInterval is not a string')
  }

  return problems
}
