import { createHash } from 'crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import type { Dirent } from 'fs'
import { join, relative, sep } from 'path'
import { pathToFileURL } from 'url'
import type { AppSettings, DetailPollingMode, RefreshSpeed, SlowRefreshTarget } from '@shared/types'
import { REFRESH_INTERVAL_MS } from '@shared/types'
import type {
  ModuleActivate,
  ModuleContext,
  ModuleDescriptor,
  ModuleIntegrity,
  ModuleMainInstance,
  ModuleManifest,
  ModuleRuntimeState,
  ModuleSource
} from '@shared/modules'
import { MODULE_MANIFEST_FILE, manifestProblems } from '@shared/modules'
import type { ModuleSpecsEntry, PageSpec, WidgetSpec } from '@shared/module-ui'
import { specProblems } from '@shared/module-ui'
import { connection } from '../connection'
import { Poller } from './poller'
import type { MetricsHistoryService } from './history'
import { compileModule } from './module-compiler'
import { appRoot, readModuleRegistry, writeModuleRegistry } from './store'

/**
 * Modules are folders read from disk at runtime, not code compiled into the
 * app's bundle: `module.json` is read eagerly for every folder present (it is
 * a few hundred bytes of JSON and the host needs it to build the Settings
 * list even for a module that never activates), but a module's main half is
 * only compiled - with esbuild, see module-compiler.ts - and imported the
 * first time it activates. That is what makes install/update/reload not
 * touch the app's own bundle.
 */

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * True when any connected browser is looking at this module: the bare id
 * (legacy) or a page route `'<moduleId>/<pageId>'`.
 */
export function moduleTabActive(tabs: Set<string>, moduleId: string): boolean {
  for (const tab of tabs) {
    if (tab === moduleId || tab.startsWith(`${moduleId}/`)) return true
  }
  return false
}

// ---------- Integrity ----------

/** `.dist/` is build output, not something a module ships or the lock records. */
function listFiles(dir: string, base = dir, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.dist') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) listFiles(path, base, out)
    else if (entry.isFile()) out.push(relative(base, path).split(sep).join('/'))
  }
  return out
}

/**
 * SHA-256 over the whole module folder: every file's relative path and its
 * bytes, in sorted path order. Sorting makes the digest independent of the
 * order the filesystem hands entries back, and hashing the paths as well means
 * renaming a file changes the hash even when its content did not.
 */
export function moduleFolderHash(dir: string): string {
  const hash = createHash('sha256')
  for (const rel of listFiles(dir).sort()) {
    hash.update(rel)
    hash.update('\0')
    hash.update(readFileSync(join(dir, rel)))
  }
  return hash.digest('hex')
}

// ---------- Discovery ----------

export function modulesDir(): string {
  return join(appRoot(), 'modules')
}

export function moduleDir(id: string): string {
  return join(modulesDir(), id)
}

/** Hashes recorded when the app was packaged, for the modules it ships with. */
interface ModulesLock {
  modules: Record<string, { version: string; hash: string }>
}

function readLock(): ModulesLock['modules'] {
  try {
    const file = join(modulesDir(), 'modules.lock.json')
    if (!existsSync(file)) return {}
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<ModulesLock>
    return raw.modules ?? {}
  } catch {
    return {}
  }
}

function readTextFile(dir: string, name: string): string | undefined {
  try {
    const path = join(dir, name)
    if (!existsSync(path) || !statSync(path).isFile()) return undefined
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

interface LoadedModule {
  manifest: ModuleManifest
  /** Set when the module cannot be run, with the reason to show the user. */
  problem?: string
}

/** Read and validate one folder's `module.json`; `null` when the folder has none. */
function readManifest(folder: string): LoadedModule | null {
  const dir = moduleDir(folder)
  const manifestPath = join(dir, MODULE_MANIFEST_FILE)
  if (!existsSync(manifestPath)) return null
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (err) {
    return { manifest: { id: folder } as ModuleManifest, problem: `module.json is not valid JSON: ${message(err)}` }
  }
  const problems = manifestProblems(raw)
  const manifest = { ...(raw as ModuleManifest), id: folder }
  const rawId = (raw as Partial<ModuleManifest>).id
  if (rawId && rawId !== folder) {
    problems.push(`id "${rawId}" does not match the folder name "${folder}"`)
  }
  if (manifest.entries?.main && !existsSync(join(dir, manifest.entries.main))) {
    problems.push(`entries.main does not exist: ${manifest.entries.main}`)
  }
  return { manifest, problem: problems.length ? problems.join('; ') : undefined }
}

/** Every module folder present on disk, keyed by id. A folder with a broken manifest is kept with a `problem` instead of being hidden. */
function discoverModules(): Map<string, LoadedModule> {
  const out = new Map<string, LoadedModule>()
  const dir = modulesDir()
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const loaded = readManifest(entry.name)
    if (loaded) out.set(entry.name, loaded)
  }
  return out
}

// ---------- The host ----------

interface Live {
  instance: ModuleMainInstance
  handlers: Set<string>
}

/**
 * Owns the installed modules: which ones exist, whether their files are still
 * the ones that were installed, which are switched on, and the main-process
 * half of the ones that are. Everything outside this file talks to modules
 * through it.
 */
export class ModulesHost {
  private compiled = discoverModules()
  private states = new Map<string, ModuleRuntimeState>()
  private integrity = new Map<string, ModuleIntegrity>()
  private live = new Map<string, Live>()
  private settings: AppSettings | null = null
  /** Tabs open in any connected browser; see RpcRouter.activeTabs(). */
  private activeTabs = new Set<string>()

  constructor(
    private readonly history: MetricsHistoryService,
    private readonly send: (channel: string, payload: unknown) => void,
    private readonly registerHandler: (channel: string, fn: (...a: unknown[]) => unknown) => void,
    private readonly unregisterHandler: (channel: string) => void,
    private readonly logger: (message: string) => void
  ) {}

  /**
   * Read the registry, reconcile it with what is on disk and hash every module.
   * `disabledByMigration` comes from a settings file written before modules
   * existed: a feature the user had switched off stays off.
   */
  init(disabledByMigration: string[]): void {
    const stored = readModuleRegistry()
    const lock = readLock()
    const now = Date.now()
    for (const [id, loaded] of this.compiled) {
      const prev = stored[id]
      const isDefault = lock[id] != null
      const state: ModuleRuntimeState = prev
        ? { ...prev, version: loaded.manifest.version ?? prev.version }
        : {
            id,
            enabled: loaded.manifest.defaultEnabled ?? true,
            version: loaded.manifest.version ?? '0.0.0',
            hash: lock[id]?.hash ?? '',
            source: isDefault ? 'default' : 'zip',
            installedAt: now,
            updatedAt: now
          }
      this.states.set(id, state)
    }
    // Only folders actually on disk get a state, so a module that was removed
    // outside the app drops out of the registry here instead of lingering as
    // an entry with nothing behind it.
    this.applyLegacyDisabled(disabledByMigration)
    this.persist()
    this.verifyAll()
  }

  /**
   * Switch off the modules a pre-module settings file wants off. Applied to
   * every module in the list, whether or not the registry already knew it: the
   * list is only ever non-empty right after a v2 file was read, which is
   * exactly when what that file says should win.
   */
  applyLegacyDisabled(ids: readonly string[]): void {
    if (ids.length === 0) return
    let changed = false
    for (const id of ids) {
      const state = this.states.get(id)
      if (!state || !state.enabled) continue
      state.enabled = false
      changed = true
      this.logger(`module ${id}: disabled to match the settings file it was migrated from`)
    }
    if (changed) this.persist()
  }

  /** Recompute the integrity of every module from the files on disk. */
  verifyAll(): void {
    for (const id of this.compiled.keys()) this.verify(id)
  }

  /**
   * Compare the folder on disk against the hash recorded at install time. A
   * module with no recorded hash (installed by an older build, or shipped
   * without a lock file) adopts what is on disk instead of crying wolf.
   */
  verify(id: string): ModuleIntegrity {
    const state = this.states.get(id)
    if (!state) return 'unknown'
    let hash: string
    try {
      hash = moduleFolderHash(moduleDir(id))
    } catch {
      this.integrity.set(id, 'unknown')
      return 'unknown'
    }
    if (!state.hash) {
      state.hash = hash
      this.persist()
      this.integrity.set(id, 'ok')
      return 'ok'
    }
    const result: ModuleIntegrity = state.hash === hash ? 'ok' : 'modified'
    this.integrity.set(id, result)
    return result
  }

  private persist(): void {
    writeModuleRegistry(Object.fromEntries(this.states))
  }

  // ---------- Queries ----------

  isEnabled(id: string): boolean {
    const loaded = this.compiled.get(id)
    if (!loaded || loaded.problem) return false
    return this.states.get(id)?.enabled === true
  }

  isLive(id: string): boolean {
    return this.live.has(id)
  }

  enabledIds(): string[] {
    return [...this.compiled.keys()].filter((id) => this.isEnabled(id))
  }

  /** Everything the Settings page needs, sorted by display name. */
  list(): ModuleDescriptor[] {
    const out: ModuleDescriptor[] = []
    for (const [id, loaded] of this.compiled) {
      const state = this.states.get(id)
      if (!state) continue
      const dir = moduleDir(id)
      out.push({
        manifest: loaded.manifest,
        state,
        integrity: this.integrity.get(id) ?? 'unknown',
        problem: loaded.problem,
        readme: readTextFile(dir, 'README.md'),
        changelog: readTextFile(dir, 'CHANGELOG.md')
      })
    }
    return out.sort((a, b) => (a.manifest.name ?? '').localeCompare(b.manifest.name ?? ''))
  }

  /** Version and source of an installed module, for the installer's checks. */
  installed(id: string): ModuleRuntimeState | null {
    return this.states.get(id) ?? null
  }

  /** What every enabled module's pages and widgets render from, read fresh off disk. */
  specsPayload(): ModuleSpecsEntry[] {
    const out: ModuleSpecsEntry[] = []
    for (const id of this.enabledIds()) {
      const loaded = this.compiled.get(id)
      if (!loaded) continue
      const dir = moduleDir(id)
      const pages: Record<string, PageSpec> = {}
      const widgets: Record<string, WidgetSpec> = {}
      for (const page of loaded.manifest.pages ?? []) {
        const spec = this.readSpec<PageSpec>(
          join(dir, 'ui', 'pages', `${page.id}.json`),
          loaded.manifest,
          id,
          `page "${page.id}"`
        )
        if (spec) pages[page.id] = spec
      }
      for (const widget of loaded.manifest.widgets ?? []) {
        const spec = this.readSpec<WidgetSpec>(
          join(dir, 'ui', 'widgets', `${widget.id}.json`),
          loaded.manifest,
          id,
          `widget "${widget.id}"`
        )
        if (spec) widgets[widget.id] = spec
      }
      out.push({ id, manifest: loaded.manifest, pages, widgets })
    }
    return out
  }

  private readSpec<T extends { blocks: unknown[] }>(
    path: string,
    manifest: ModuleManifest,
    moduleId: string,
    label: string
  ): T | null {
    if (!existsSync(path)) {
      this.logger(`module ${moduleId}: ${label} has no spec file (${path})`)
      return null
    }
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'))
    } catch (err) {
      this.logger(`module ${moduleId}: ${label} spec is not valid JSON: ${message(err)}`)
      return null
    }
    const problems = specProblems(raw, manifest)
    if (problems.length) {
      this.logger(`module ${moduleId}: ${label} spec problem: ${problems.join('; ')}`)
      return null
    }
    return raw as T
  }

  // ---------- Lifecycle ----------

  configure(settings: AppSettings, activeTabs: Set<string>): void {
    this.settings = settings
    this.activeTabs = activeTabs
  }

  /**
   * Bring the running set in line with what is enabled, then let each running
   * module start or stop its own pollers. Called whenever anything that can
   * influence a poller changed.
   */
  async apply(): Promise<void> {
    const activations: Promise<unknown>[] = []
    for (const id of this.compiled.keys()) {
      const wanted = this.isEnabled(id)
      const running = this.live.has(id)
      if (wanted && !running) activations.push(this.activate(id))
      else if (!wanted && running) this.deactivate(id)
    }
    if (activations.length) await Promise.all(activations)
    for (const [id, live] of this.live) {
      try {
        live.instance.applyPollers?.()
      } catch (err) {
        this.logger(`module ${id}: applyPollers failed: ${String(err)}`)
      }
    }
  }

  /** Switch a module on or off. Takes effect immediately, no rebuild needed. */
  setEnabled(id: string, enabled: boolean): void {
    const state = this.states.get(id)
    if (!state || state.enabled === enabled) return
    state.enabled = enabled
    this.persist()
    void this.apply()
  }

  /** Re-read one module's manifest from disk after its folder changed underneath the host (install/upgrade). */
  rescan(id: string): void {
    const loaded = readManifest(id)
    if (loaded) this.compiled.set(id, loaded)
    else this.compiled.delete(id)
  }

  /** Forget a module after its folder was deleted; nothing on disk backs it any more. */
  forget(id: string): void {
    this.deactivate(id)
    this.states.delete(id)
    this.integrity.delete(id)
    this.compiled.delete(id)
    this.persist()
  }

  /** Record a freshly installed or updated module so it is recognised as one from now on. */
  record(id: string, version: string, hash: string, source: ModuleSource): void {
    const prev = this.states.get(id)
    const now = Date.now()
    this.states.set(id, {
      id,
      enabled: prev?.enabled ?? true,
      version,
      hash,
      source: prev?.source === 'default' ? 'default' : source,
      installedAt: prev?.installedAt ?? now,
      updatedAt: now
    })
    this.integrity.set(id, 'ok')
    this.persist()
  }

  /**
   * Recompile a module's main half and, if it is enabled, bring it back to
   * life with the fresh code. Always recompiles (unlike `activate`, which
   * skips it when nothing changed) - the point of Reload, and of calling this
   * right after install/uninstall, is "the files on disk changed, forget what
   * was cached".
   */
  async reload(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const loaded = this.compiled.get(id)
    if (!loaded) return { ok: false, error: `module "${id}" is not known` }
    this.deactivate(id)
    try {
      await compileModule(id)
    } catch (err) {
      const error = message(err)
      loaded.problem = `compile failed: ${error}`
      this.logger(`module ${id}: ${loaded.problem}`)
      return { ok: false, error }
    }
    loaded.problem = undefined
    if (this.isEnabled(id)) return this.activate(id)
    return { ok: true }
  }

  /**
   * Compile (only if the source is newer than the last build) and construct a
   * module's main half. Callers decide whether a module should be activated at
   * all (`apply()`, `reload()`) - this always tries, whatever the enabled flag says.
   */
  private async activate(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const loaded = this.compiled.get(id)
    if (!loaded) return { ok: false, error: `module "${id}" is not known` }
    const handlers = new Set<string>()
    try {
      if (this.needsCompile(id)) await compileModule(id)
      const dist = join(moduleDir(id), '.dist', 'main.mjs')
      const mod = (await import(`${pathToFileURL(dist).href}?v=${Date.now()}`)) as {
        default?: ModuleActivate
      }
      if (typeof mod.default !== 'function') throw new Error('main entry has no default export function')
      const ctx = this.contextFor(id, handlers)
      const instance = mod.default(ctx)
      this.live.set(id, { instance, handlers })
      loaded.problem = undefined
      try {
        instance.applyPollers?.()
      } catch (err) {
        this.logger(`module ${id}: applyPollers failed: ${String(err)}`)
      }
      return { ok: true }
    } catch (err) {
      for (const channel of handlers) this.unregisterHandler(channel)
      const error = message(err)
      loaded.problem = `activate() failed: ${error}`
      this.logger(`module ${id}: ${loaded.problem}`)
      return { ok: false, error }
    }
  }

  /** Whether `.dist/main.mjs` is missing or older than `module.json`/`main/**`. */
  private needsCompile(id: string): boolean {
    const dir = moduleDir(id)
    const distMtime = this.safeMtime(join(dir, '.dist', 'main.mjs'))
    if (distMtime === 0) return true
    if (this.safeMtime(join(dir, MODULE_MANIFEST_FILE)) > distMtime) return true
    return this.newestMtime(join(dir, 'main')) > distMtime
  }

  private safeMtime(path: string): number {
    try {
      return statSync(path).mtimeMs
    } catch {
      return 0
    }
  }

  private newestMtime(dir: string): number {
    let newest = 0
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return 0
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      newest = Math.max(newest, entry.isDirectory() ? this.newestMtime(full) : this.safeMtime(full))
    }
    return newest
  }

  private deactivate(id: string): void {
    const live = this.live.get(id)
    if (!live) return
    this.live.delete(id)
    for (const channel of live.handlers) this.unregisterHandler(channel)
    try {
      live.instance.dispose()
    } catch (err) {
      this.logger(`module ${id}: dispose failed: ${String(err)}`)
    }
  }

  /** Drop the per-session state of every running module. */
  resetAll(): void {
    for (const [id, live] of this.live) {
      try {
        live.instance.reset?.()
      } catch (err) {
        this.logger(`module ${id}: reset failed: ${String(err)}`)
      }
    }
  }

  /** Stop every module; used on a clean close. */
  disposeAll(): void {
    for (const id of [...this.live.keys()]) this.deactivate(id)
  }

  /** What each running module has buffered, for a renderer that just connected. */
  snapshots(): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {}
    for (const [id, live] of this.live) {
      try {
        out[id] = live.instance.snapshots?.() ?? {}
      } catch {
        out[id] = {}
      }
    }
    return out
  }

  /** Route a manual slow refresh to whichever running module owns the target. */
  async refreshSlow(target: SlowRefreshTarget): Promise<void> {
    for (const [id, live] of this.live) {
      const targets = live.instance.slowTargets?.() ?? []
      if (!targets.includes(target)) continue
      try {
        await live.instance.refreshSlow?.(target)
      } catch (err) {
        this.logger(`module ${id}: refreshSlow(${target}) failed: ${String(err)}`)
      }
      return
    }
  }

  // ---------- Context ----------

  private contextFor(id: string, handlers: Set<string>): ModuleContext {
    const host = this
    return {
      id,
      exec: (command, opts) => connection.exec(command, opts),
      execSudo: (command, opts) => connection.execSudo(command, opts),
      stream: (command) => connection.stream(command, id),
      streamSudo: (command) => connection.streamSudo(command, id),
      get connected() {
        return connection.connected
      },
      get hasSudo() {
        const status = connection.status()
        return status.isRoot === true || status.hasSudo === true
      },
      createPoller: (name, tick) => new Poller(`${id}:${name}`, tick),
      fastIntervalMs: (key) => {
        const speed = host.requireSettings().refresh[key] as RefreshSpeed | undefined
        return speed ? REFRESH_INTERVAL_MS[speed] : 0
      },
      slowIntervalSec: (key) => {
        const value = host.requireSettings().slowRefresh[key]
        return typeof value === 'number' ? value : 60
      },
      detailMode: (key) => {
        const mode = host.requireSettings().detailPolling[
          key as keyof AppSettings['detailPolling']
        ] as DetailPollingMode | undefined
        return mode ?? 'always'
      },
      get tabActive() {
        return moduleTabActive(host.activeTabs, id)
      },
      emit: (event, payload) => host.send(`module:${id}:event:${event}`, payload),
      handle: (method, fn) => {
        const channel = `module:${id}:invoke:${method}`
        handlers.add(channel)
        host.registerHandler(channel, fn as (...args: unknown[]) => unknown)
      },
      addHistory: (point, stream) => host.history.add(stream ?? id, point),
      isModuleEnabled: (other) => host.isEnabled(other),
      log: (message) => host.logger(`module ${id}: ${message}`)
    }
  }

  private requireSettings(): AppSettings {
    if (!this.settings) throw new Error('modules host used before configure()')
    return this.settings
  }
}
