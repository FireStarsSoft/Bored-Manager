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
  ModuleSource,
  ModuleStreamHandle
} from '@shared/modules'
import { MODULE_MANIFEST_FILE, historyStreamProblem, manifestProblems } from '@shared/modules'
import type { ModuleSpecsEntry, PageSpec, WidgetSpec } from '@shared/module-ui'
import { specProblems } from '@shared/module-ui'
import { connection } from '../connection'
import { Poller } from './poller'
import type { MetricsHistoryService } from './history'
import { compileModule } from './module-compiler'
import {
  appRoot,
  readModuleConfig,
  readModuleData,
  readModuleRegistry,
  writeModuleConfig,
  writeModuleData,
  writeModuleRegistry
} from './store'

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

/**
 * The folder a module lives in. The id reaches this from a manifest, from a
 * directory listing and from an RPC call, so it is checked here rather than at
 * each of those: one path separator or `..` and `join` would hand out a folder
 * outside `modules/` - which callers go on to hash, compile into, or delete.
 */
export function moduleDir(id: string): string {
  if (!id || id === '.' || id === '..' || /[\\/]/.test(id)) {
    throw new Error(`"${id}" is not a module folder name`)
  }
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

/**
 * Modules that changed folder name between app versions. The registry is keyed
 * by folder, so without this the successor arrives as a brand new module at
 * its own `defaultEnabled` - which for Container is off, silently taking away
 * a page the user had been using.
 */
const RENAMED_MODULES: Record<string, string> = { docker: 'container' }

/**
 * Move the old id's registry entry onto the new one. Only the switch and the
 * install date are worth keeping - the version, hash and source describe the
 * folder that is actually on disk, and letting the old hash through would
 * report the new module as modified. The old entry goes either way: if that
 * folder is still there (an update unpacked over the previous install) it then
 * comes back as a new, switched-off module rather than running alongside its
 * own successor.
 */
function carryOverRenamed(
  stored: Record<string, ModuleRuntimeState>,
  onDisk: Map<string, LoadedModule>,
  lock: ModulesLock['modules']
): void {
  for (const [from, to] of Object.entries(RENAMED_MODULES)) {
    const previous = stored[from]
    if (!previous || stored[to] || !onDisk.has(to)) continue
    stored[to] = {
      id: to,
      enabled: previous.enabled,
      version: '0.0.0',
      hash: '',
      source: lock[to] != null ? 'default' : previous.source,
      installedAt: previous.installedAt,
      updatedAt: Date.now()
    }
    delete stored[from]
  }
}

/**
 * The hash a module carries into this session. Normally the one recorded when
 * it was installed - comparing against that is the whole point of the check.
 *
 * The exception is a module the app itself ships, at a version the registry
 * has not seen: an app update replaces those folders wholesale without going
 * through the installer, so the previous version's hash would not match and
 * every updated module would be reported as tampered with. The lock file that
 * arrived alongside those files says what they should hash to, and it only
 * answers for the exact version on disk - a folder edited by hand still fails.
 */
function carriedHash(
  prev: ModuleRuntimeState,
  locked: ModulesLock['modules'][string] | undefined,
  version: string
): string {
  if (prev.version === version) return prev.hash
  return locked?.version === version ? locked.hash : prev.hash
}

// ---------- The host ----------

/**
 * One running module, and everything the app has to be able to take back off
 * it. `instance` is what the module returned; the four collections are what
 * the app handed out and therefore what it can revoke without the module's
 * cooperation - which is the whole point, since a module that is being
 * switched off is not necessarily one that behaves.
 */
interface Live {
  instance: ModuleMainInstance
  /** RPC channels registered through `ctx.handle`. */
  handlers: Set<string>
  /** Every poller `ctx.createPoller` handed out; the ones still ticking are stopped if `dispose()` did not. */
  pollers: Set<Poller>
  /** Commands started through `ctx.stream` that are still running - each drops out when it exits. */
  streams: Set<ModuleStreamHandle>
  /** Flipped before `dispose()`; every `ctx` member throws once it is set. */
  revoked: boolean
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
  /** Which machine ctx.hostDataGet/Set read and write; null while disconnected. */
  private hostKey: string | null = null

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
    carryOverRenamed(stored, this.compiled, lock)
    const now = Date.now()
    for (const [id, loaded] of this.compiled) {
      const prev = stored[id]
      const isDefault = lock[id] != null
      const version = loaded.manifest.version ?? prev?.version ?? '0.0.0'
      const state: ModuleRuntimeState = prev
        ? { ...prev, version, hash: carriedHash(prev, lock[id], version) }
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
   * Point per-host module data at the machine that just connected, using the
   * same key the metrics history files use. Set to null on disconnect so a
   * module cannot keep writing to the host it is no longer talking to.
   */
  setHostKey(key: string | null): void {
    this.hostKey = key
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

  /**
   * Stop a module without forgetting it. The installer calls this before it
   * deletes a folder: the module has to be off the target machine and out of
   * the RPC table *before* the files go, or a poller tick lands halfway
   * through the removal.
   */
  stop(id: string): void {
    this.deactivate(id)
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
      source,
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
   * Compile from source and construct a module's main half. Callers decide
   * whether a module should be activated at all (`apply()`, `reload()`) - this
   * always tries, whatever the enabled flag says.
   */
  private async activate(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const loaded = this.compiled.get(id)
    if (!loaded) return { ok: false, error: `module "${id}" is not known` }
    // Built before the module runs, because `activate()` uses `ctx` while it
    // is still being called - a poller it creates has to land in this record,
    // not in one written afterwards.
    const live: Live = {
      instance: { dispose: () => {} },
      handlers: new Set(),
      pollers: new Set(),
      streams: new Set(),
      revoked: false
    }
    try {
      const integrity = this.integrity.get(id) ?? this.verify(id)
      if (integrity === 'modified' && process.env.BM_DEV !== '1') {
        throw new Error(
          'module files were modified after install; refuse to activate (set BM_DEV=1 to override)'
        )
      }
      // Always compile from source so a planted `.dist/main.mjs` cannot skip
      // the import sandbox. mtime is not trusted.
      await compileModule(id)
      const dist = join(moduleDir(id), '.dist', 'main.mjs')
      const mod = (await import(`${pathToFileURL(dist).href}?v=${Date.now()}`)) as {
        default?: ModuleActivate
      }
      if (typeof mod.default !== 'function') throw new Error('main entry has no default export function')
      live.instance = mod.default(this.contextFor(id, loaded.manifest, live))
      this.live.set(id, live)
      loaded.problem = undefined
      try {
        live.instance.applyPollers?.()
      } catch (err) {
        this.logger(`module ${id}: applyPollers failed: ${String(err)}`)
      }
      return { ok: true }
    } catch (err) {
      // Half of a module is worse than none: take back whatever it managed to
      // register before it threw, and revoke the context so anything it had
      // already scheduled cannot carry on against a module that is not live.
      live.revoked = true
      this.releaseResources(id, live)
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

  /**
   * Stop a module: its own `dispose()` first, then the app takes back
   * everything it handed out. The order matters - `dispose()` is the module's
   * chance to shut a stream down politely (send a quit, flush a buffer), and
   * it still holds a working context while it does. Afterwards the context is
   * dead and anything left over is cut off.
   */
  private deactivate(id: string): void {
    const live = this.live.get(id)
    if (!live) return
    this.live.delete(id)
    try {
      live.instance.dispose()
    } catch (err) {
      this.logger(`module ${id}: dispose failed: ${String(err)}`)
    }
    live.revoked = true
    this.releaseResources(id, live)
  }

  /**
   * Unregister the module's RPC channels and cut off whatever it left
   * running. A poller or stream reaching this point is a bug in the module -
   * it is logged as one, since "disabling a module stops it touching the
   * target machine" is otherwise only true of modules that remember to.
   */
  private releaseResources(id: string, live: Live): void {
    for (const channel of live.handlers) this.unregisterHandler(channel)
    live.handlers.clear()
    // Only the ones still ticking are worth a line: the set holds every poller
    // the module ever created, and a module that stopped its own has done
    // exactly what it was asked to.
    const leaked = [...live.pollers].filter((p) => p.active)
    live.pollers.clear()
    if (leaked.length > 0) {
      this.logger(`module ${id}: ${leaked.length} poller(s) still running after dispose() - stopping them`)
      for (const poller of leaked) {
        try {
          poller.stop()
        } catch {
          /* a poller that cannot be stopped is still worth trying the next one */
        }
      }
    }
    if (live.streams.size > 0) {
      this.logger(`module ${id}: ${live.streams.size} command(s) still running after dispose() - killing them`)
      for (const stream of live.streams) {
        try {
          stream.kill()
        } catch {
          /* the target may have ended it already */
        }
      }
      live.streams.clear()
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

  /**
   * Route a manual slow refresh to whichever running module owns the target.
   * Targets are a flat namespace shared with the app's own sections, so two
   * modules can claim the same one; the first still wins, but the clash is
   * logged rather than leaving the user with a refresh button that quietly
   * belongs to somebody else.
   */
  async refreshSlow(target: SlowRefreshTarget): Promise<void> {
    const owners: string[] = []
    for (const [id, live] of this.live) {
      if ((live.instance.slowTargets?.() ?? []).includes(target)) owners.push(id)
    }
    if (owners.length === 0) return
    if (owners.length > 1) {
      this.logger(
        `slow refresh target "${target}" is claimed by ${owners.join(', ')} - only ${owners[0]} will answer it`
      )
    }
    const live = this.live.get(owners[0])
    try {
      await live?.instance.refreshSlow?.(target)
    } catch (err) {
      this.logger(`module ${owners[0]}: refreshSlow(${target}) failed: ${String(err)}`)
    }
  }

  // ---------- Context ----------

  /**
   * The `ctx` one module sees. Everything it can reach is bound to `id` here -
   * the RPC channels it registers, the event names it emits under, the two
   * stores it reads and the history streams it writes - so a module cannot
   * name another module's anything, whatever it passes in.
   *
   * `live.revoked` closes the whole surface at once when the module stops.
   * Without it a module could keep a reference to `ctx` and go on running
   * commands or rewriting the config file that uninstalling just deleted.
   */
  private contextFor(id: string, manifest: ModuleManifest, live: Live): ModuleContext {
    const host = this
    const declaredMethods = new Set(manifest.methods ?? [])
    /** Every entry point goes through this first; the message names the module. */
    const active = (): void => {
      if (live.revoked) throw new Error(`module "${id}" is no longer running`)
    }
    return {
      id,
      exec: (command, opts) => {
        active()
        return connection.exec(command, opts)
      },
      execSudo: (command, opts) => {
        active()
        return connection.execSudo(command, opts)
      },
      stream: (command) => {
        active()
        return host.trackStream(live, connection.stream(command, id))
      },
      streamSudo: (command) => {
        active()
        return host.trackStream(live, connection.streamSudo(command, id))
      },
      get connected() {
        return !live.revoked && connection.connected
      },
      get hasSudo() {
        if (live.revoked) return false
        const status = connection.status()
        return status.isRoot === true || status.hasSudo === true
      },
      createPoller: (name, tick) => {
        active()
        const poller = new Poller(`${id}:${name}`, tick)
        live.pollers.add(poller)
        return poller
      },
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
        return !live.revoked && moduleTabActive(host.activeTabs, id)
      },
      // An event name is not checked against `manifest.streams`: a `log` block
      // deliberately tails an event that is not a declared stream. The channel
      // carries the module id either way, so an undeclared event can only
      // reach this module's own blocks.
      emit: (event, payload) => {
        active()
        host.send(`module:${id}:event:${event}`, payload)
      },
      handle: (method, fn) => {
        active()
        if (!declaredMethods.has(method)) {
          throw new Error(
            `method "${method}" is not in the manifest's methods - a module may only answer calls it declares`
          )
        }
        const channel = `module:${id}:invoke:${method}`
        live.handlers.add(channel)
        host.registerHandler(channel, fn as (...args: unknown[]) => unknown)
      },
      addHistory: (point, stream) => {
        active()
        const name = stream ?? id
        const problem = historyStreamProblem(id, name)
        if (problem) throw new Error(problem)
        host.history.add(name, point)
      },
      configGet: () => {
        active()
        return readModuleConfig(id)
      },
      configSet: (value) => {
        active()
        writeModuleConfig(id, value)
      },
      get hostKey() {
        return live.revoked ? null : host.hostKey
      },
      hostDataGet: () => {
        active()
        return host.hostKey ? readModuleData(id, host.hostKey) : null
      },
      hostDataSet: (value) => {
        active()
        // Silently doing nothing while disconnected beats throwing: a module
        // that tags a container has no say in when the session drops.
        if (host.hostKey) writeModuleData(id, host.hostKey, value)
      },
      isModuleEnabled: (other) => !live.revoked && host.isEnabled(other),
      log: (message) => {
        active()
        host.logger(`module ${id}: ${message}`)
      }
    }
  }

  /**
   * Hold on to a module's long-running command for as long as it runs, so
   * deactivating can kill one the module did not. Dropped again as soon as it
   * exits on its own - the set is "still running", not "ever started".
   */
  private async trackStream(
    live: Live,
    pending: Promise<ModuleStreamHandle>
  ): Promise<ModuleStreamHandle> {
    const handle = await pending
    // Deactivating between the call and the target answering: honour it here
    // rather than leaving a command nothing is tracking.
    if (live.revoked) {
      handle.kill()
      throw new Error('module was stopped before the command started')
    }
    live.streams.add(handle)
    handle.onExit(() => live.streams.delete(handle))
    return handle
  }

  private requireSettings(): AppSettings {
    if (!this.settings) throw new Error('modules host used before configure()')
    return this.settings
  }
}
