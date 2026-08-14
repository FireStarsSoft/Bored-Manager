import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, copyFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import {
  DEFAULT_SETTINGS,
  DEFAULT_USERNAME,
  SETTINGS_VERSION,
  type AppSettings,
  type SavedConnection,
  type ServerSettings,
  type SessionIdle,
  type SessionIdleUnit,
  type Theme
} from '@shared/types'
import type { ModuleRuntimeState } from '@shared/modules'
import { decryptString, encryptString, isEncrypted } from './secret'

/**
 * Everything lives inside the app root folder (portable install):
 *   data/connections.json     - recent connections (passwords encrypted with data/secret.key)
 *   data/user-settings/settings.json - user customisations, easy to import/export
 *   data/user-settings/module-config/<id>.json - a module's own settings
 *   data/module-data/<id>/<hostKey>.json - what a module remembers per target
 */

let rootCache: string | null = null

/**
 * The install folder. There is no Electron app object to ask any more, so it is
 * found by walking up from this file until a package.json shows up: out/server/
 * for the built bundle, server/services/ when running from source under tsx.
 * BM_APP_ROOT overrides it for a wrapper that wants to be explicit.
 */
export function appRoot(): string {
  if (rootCache) return rootCache
  const fromEnv = process.env['BM_APP_ROOT']
  if (fromEnv) {
    rootCache = resolve(fromEnv)
    return rootCache
  }
  let dir = import.meta.dirname
  for (let up = 0; up < 5; up++) {
    if (existsSync(join(dir, 'package.json'))) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  rootCache = dir
  return rootCache
}

export function dataDir(): string {
  return join(appRoot(), 'data')
}

export function userSettingsDir(): string {
  return join(dataDir(), 'user-settings')
}

/** Everything that belongs to one account, and nothing that does not. */
export function userDataDir(username: string): string {
  return join(dataDir(), 'users', username)
}

export function settingsFile(): string {
  return join(userSettingsDir(), 'settings.json')
}

/**
 * The running app's version. Read from package.json rather than kept in the
 * bundle, so a portable install that was updated in place reports the version
 * that is actually on disk; the build-time value is only the fallback.
 */
export function appVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(appRoot(), 'package.json'), 'utf8')) as {
      version?: string
    }
    if (typeof pkg.version === 'string' && pkg.version) return pkg.version
  } catch {
    /* fall through */
  }
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0'
}

function connectionsFile(): string {
  return join(dataDir(), 'connections.json')
}

function ensureDirs(): void {
  mkdirSync(userSettingsDir(), { recursive: true })
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

// ---------- Settings ----------

/** Fields written by versions before the current schema. */
interface LegacySettings {
  /** v1: one slow interval for everything, before it was split per category. */
  refreshSlow?: number
  /** v2: fixed list of extended Overview cards, before cards became keyed. */
  overviewExtended?: Record<string, boolean>
  /** v2: a switch per feature, before features became modules. */
  collectors?: Record<string, boolean>
  /** v3: the update link, before it moved next to the repo it comes from. */
  lastUpdateUrl?: string
}

/**
 * v2 card names -> current widget ids. The cards that moved into a module
 * carry its id now, so both the enabled flags and the saved grid positions
 * have to be renamed; the cards the app kept keep their name. The Docker
 * entries point straight at the Container module rather than at a name that
 * has since been renamed again - a v2 file is converted once, not twice.
 */
const V2_CARD_IDS: Record<string, string> = {
  gpu: 'gpu.summary',
  docker: 'container.summary',
  sensors: 'sensors.summary',
  filesystems: 'disk.filesystems',
  gpuProcesses: 'gpu.processes',
  dockerCounts: 'container.resources'
}

/** v5 widget ids -> v6: the Docker module became Container when Incus joined it. */
const V5_CARD_IDS: Record<string, string> = {
  'docker.summary': 'container.summary',
  'docker.resources': 'container.resources'
}

/**
 * v2 collector names -> module ids. A user who had switched a feature off gets
 * the matching module disabled instead of having it come back enabled.
 */
export const V2_COLLECTOR_MODULES: Record<string, string> = {
  sensors: 'sensors',
  gpu: 'gpu',
  docker: 'container',
  processes: 'processes'
}

/**
 * Merge a nested object but keep only the keys the current version knows. Used
 * for the closed-ended nests (`collectors`, `detailPolling`): a plain spread
 * would carry a removed key like `collectors.gpu` forward forever, and a file
 * still claiming `"gpu": false` next to a GPU module that is running is worse
 * than no entry at all.
 *
 * `refresh` and `slowRefresh` deliberately do NOT go through this - a module
 * may declare an interval key of its own, and that has to survive.
 */
function pickKnown<T extends object>(defaults: T, partial: unknown): T {
  const out = { ...defaults }
  if (typeof partial !== 'object' || partial === null) return out
  const p = partial as Record<string, unknown>
  const d = defaults as Record<string, unknown>
  for (const key of Object.keys(d)) {
    // Same type as the default, or the file is lying about that field.
    if (key in p && typeof p[key] === typeof d[key]) {
      ;(out as Record<string, unknown>)[key] = p[key]
    }
  }
  return out
}

function migrateWidgets(legacy: LegacySettings): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(legacy.overviewExtended ?? {})) {
    if (typeof value !== 'boolean') continue
    out[V2_CARD_IDS[key] ?? key] = value
  }
  return out
}

function migrateLayout(
  layout: AppSettings['overviewLayout'],
  ids: Record<string, string>
): AppSettings['overviewLayout'] {
  const out: AppSettings['overviewLayout'] = {}
  for (const [breakpoint, items] of Object.entries(layout)) {
    if (!Array.isArray(items)) continue
    out[breakpoint as 'lg' | 'md'] = items.map((item) => ({
      ...item,
      i: ids[item.i] ?? item.i
    }))
  }
  return out
}

function renameKeys<T>(source: Record<string, T>, ids: Record<string, string>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const [key, value] of Object.entries(source)) out[ids[key] ?? key] = value
  return out
}

/**
 * Carry an interval key over to its new name without losing the speed the user
 * chose. Applied to what the FILE said, before the defaults are merged in -
 * against the merged object the new key would always already be there, and the
 * carried-over value would be silently dropped for the default.
 *
 * The old key goes: leaving it behind would show up in nothing and be written
 * back to disk forever, since `refresh` is spread rather than filtered so a
 * module-declared key survives.
 */
function renameIntervalKey<T>(fromFile: Record<string, T>, from: string, to: string): void {
  if (!(from in fromFile)) return
  if (!(to in fromFile)) fromFile[to] = fromFile[from]
  delete fromFile[from]
}

/**
 * Bring a settings file of any age into the current shape: fields that no
 * longer exist are dropped, new ones come from the defaults and renamed ones
 * are carried over. An update keeps the user's file, so this is what makes the
 * old file usable instead of throwing it away.
 */
function mergeSettings(partial: Partial<AppSettings> | null | undefined): AppSettings {
  const p = partial ?? {}
  const legacy = p as LegacySettings
  const fromV2 = (p.settingsVersion ?? 0) < 3
  // v5 -> v6: the Docker module became Container, taking its interval keys and
  // its two Overview widgets with it. The interval keys predate modules, so
  // every older file has them; the widget ids only need the v5 map when the v2
  // one did not already rewrite them straight to their current names.
  const fromV5 = (p.settingsVersion ?? 0) < 6
  const fileRefresh = { ...(p.refresh ?? {}) }
  const fileSlowRefresh = { ...(p.slowRefresh ?? {}) }
  if (fromV5) {
    renameIntervalKey(fileRefresh, 'docker', 'container')
    renameIntervalKey(fileSlowRefresh, 'docker', 'container')
  }
  const refresh = { ...DEFAULT_SETTINGS.refresh, ...fileRefresh }
  const slowRefresh = { ...DEFAULT_SETTINGS.slowRefresh, ...fileSlowRefresh }
  if (!p.slowRefresh && typeof legacy.refreshSlow === 'number') {
    slowRefresh.storage = legacy.refreshSlow
  }
  let widgets = { ...(p.overviewWidgets ?? {}) }
  if (fromV2) Object.assign(widgets, migrateWidgets(legacy))
  else if (fromV5) widgets = renameKeys(widgets, V5_CARD_IDS)
  let layout = p.overviewLayout ?? {}
  if (fromV2) layout = migrateLayout(layout, V2_CARD_IDS)
  else if (fromV5) layout = migrateLayout(layout, V5_CARD_IDS)
  // v3 kept the update link at the top level; v4 keeps it next to the repo it
  // is downloaded from, so the two live and travel together.
  const fromV3 = (p.settingsVersion ?? 0) < 4
  const update = pickKnown(DEFAULT_SETTINGS.update, p.update)
  if (fromV3 && typeof legacy.lastUpdateUrl === 'string') update.lastUrl = legacy.lastUpdateUrl
  const auth = pickKnown(DEFAULT_SETTINGS.auth, p.auth)
  auth.sessionIdle = normalizeIdle(p.auth?.sessionIdle)
  // Before v5 the UI was dark and had no say in it. Defaulting those files to
  // 'system' would silently turn somebody's dashboard white after an update.
  const fromV4 = (p.settingsVersion ?? 0) < 5
  return {
    settingsVersion: SETTINGS_VERSION,
    theme: fromV4 ? 'dark' : normalizeTheme(p.theme),
    density: p.density ?? DEFAULT_SETTINGS.density,
    densityAutoDetected: p.densityAutoDetected ?? DEFAULT_SETTINGS.densityAutoDetected,
    historyWindow: p.historyWindow ?? DEFAULT_SETTINGS.historyWindow,
    refresh,
    slowRefresh,
    overviewWidgets: widgets,
    overviewLayout: layout,
    collectors: pickKnown(DEFAULT_SETTINGS.collectors, p.collectors),
    detailPolling: pickKnown(DEFAULT_SETTINGS.detailPolling, p.detailPolling),
    history: pickKnown(DEFAULT_SETTINGS.history, p.history),
    server: normalizeServer(p.server),
    auth,
    update
  }
}

function normalizeTheme(value: unknown): Theme {
  const themes: Theme[] = ['dark', 'light', 'system']
  return themes.includes(value as Theme) ? (value as Theme) : DEFAULT_SETTINGS.theme
}

/** A port or host the settings file cannot be trusted about must not stick. */
function normalizeServer(partial: unknown): ServerSettings {
  const merged = pickKnown(DEFAULT_SETTINGS.server, partial)
  const port = Math.trunc(merged.port)
  return {
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_SETTINGS.server.port,
    host: merged.host.trim() || DEFAULT_SETTINGS.server.host
  }
}

function normalizeIdle(partial: unknown): SessionIdle {
  const merged = pickKnown(DEFAULT_SETTINGS.auth.sessionIdle, partial)
  const units: SessionIdleUnit[] = ['minute', 'hour', 'day']
  const value = Math.trunc(merged.value)
  return {
    value: Number.isFinite(value) && value >= 0 ? value : 0,
    unit: units.includes(merged.unit) ? merged.unit : 'hour'
  }
}

/**
 * Modules a v2 settings file wants switched off, captured while that file is
 * still readable: loadSettings rewrites it in the current format, which drops
 * the per-feature collector flags this is derived from.
 */
let legacyDisabled: string[] | null = null

function captureLegacyDisabled(raw: (Partial<AppSettings> & LegacySettings) | null): void {
  if (!raw || (raw.settingsVersion ?? 0) >= 3) return
  const collectors: Record<string, boolean> = raw.collectors ?? {}
  const off = (key: string): boolean => collectors[key] === false
  const out: string[] = []
  for (const [collector, moduleId] of Object.entries(V2_COLLECTOR_MODULES)) {
    if (off(collector)) out.push(moduleId)
  }
  // The Network page was switched with its collector; the rate lines in the
  // system stream keep that same flag (see CollectorSettings).
  if (off('network')) out.push('network')
  // Disk needs both flags. In v2 `disk` gated the page and the per-device
  // collector while `filesystems` gated df and lsblk, and the Disk module now
  // owns both - so switching it off because only `disk` was false would take
  // away mount usage the user had deliberately kept.
  if (off('disk') && off('filesystems')) out.push('disk')
  legacyDisabled = out
}

/**
 * Reads and clears what captureLegacyDisabled found. Returns an empty list
 * for a file that was already in the current format, so calling it twice
 * cannot disable a module the user has since switched back on.
 */
export function takeLegacyDisabledModules(): string[] {
  const out = legacyDisabled ?? []
  legacyDisabled = null
  return out
}

/**
 * A file written by an older version is rewritten in the current format right
 * away, so "what is on disk" and "what the app runs on" never drift apart
 * after an update.
 */
export function loadSettings(): AppSettings {
  const raw = readJson<(Partial<AppSettings> & LegacySettings) | null>(settingsFile(), null)
  captureLegacyDisabled(raw)
  const merged = mergeSettings(raw)
  if (raw && raw.settingsVersion !== SETTINGS_VERSION) {
    try {
      writeJson(settingsFile(), merged)
    } catch {
      // A read-only app folder is not worth refusing to start over.
    }
  }
  return merged
}

/** Writes the normalised settings and returns exactly what landed on disk. */
export function saveSettings(settings: Partial<AppSettings>): AppSettings {
  const merged = mergeSettings(settings)
  writeJson(settingsFile(), merged)
  return merged
}

export function exportSettings(targetPath: string): void {
  ensureDirs()
  if (!existsSync(settingsFile())) saveSettings(loadSettings())
  copyFileSync(settingsFile(), targetPath)
}

/**
 * Adopt a settings file the user picked. A file with settingsVersion below 3 is
 * converted like one found on disk - including its per-feature collector flags,
 * so takeLegacyDisabledModules() has something to report and importing "GPU was
 * off on that machine" actually switches the GPU module off here.
 */
export function importSettings(sourcePath: string): AppSettings {
  const raw = JSON.parse(readFileSync(sourcePath, 'utf8'))
  if (typeof raw !== 'object' || raw == null) throw new Error('Invalid settings file')
  captureLegacyDisabled(raw as Partial<AppSettings> & LegacySettings)
  return saveSettings(raw as Partial<AppSettings>)
}

// ---------- Installed modules ----------

/**
 * Which modules are installed, at which version, with which hash and whether
 * they are switched on. Kept next to the settings (and not inside the module
 * folders) for two reasons: an app update carries `data/user-settings/` over,
 * so a custom module stays enabled across updates; and the recorded hash has
 * to live somewhere the module itself cannot rewrite.
 */
function modulesFile(): string {
  return join(userSettingsDir(), 'modules.json')
}

interface ModuleRegistryFile {
  version: number
  modules: Record<string, ModuleRuntimeState>
}

export function readModuleRegistry(): Record<string, ModuleRuntimeState> {
  const raw = readJson<Partial<ModuleRegistryFile> | null>(modulesFile(), null)
  const out: Record<string, ModuleRuntimeState> = {}
  for (const [id, entry] of Object.entries(raw?.modules ?? {})) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Partial<ModuleRuntimeState>
    out[id] = {
      id,
      enabled: e.enabled !== false,
      version: typeof e.version === 'string' ? e.version : '0.0.0',
      hash: typeof e.hash === 'string' ? e.hash : '',
      source: e.source === 'default' || e.source === 'url' ? e.source : 'zip',
      installedAt: typeof e.installedAt === 'number' ? e.installedAt : Date.now(),
      updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : Date.now()
    }
  }
  return out
}

export function writeModuleRegistry(modules: Record<string, ModuleRuntimeState>): void {
  try {
    writeJson(modulesFile(), { version: 1, modules } satisfies ModuleRegistryFile)
  } catch {
    // A read-only app folder must not stop modules from running this session.
  }
}

// ---------- Module config and per-host module data ----------

/**
 * A module writes these through ctx, so the id and host key that end up in the
 * path are not fully under the app's control. Anything that is not a plain
 * name is refused rather than sanitised, so a bad key fails loudly at the one
 * call site instead of quietly sharing a file with another module.
 */
function safeSegment(value: string): string | null {
  if (value === '.' || value === '..') return null
  return /^[A-Za-z0-9._@-]+$/.test(value) ? value : null
}

/** A module that goes wrong should not be able to fill the disk. */
const MODULE_JSON_MAX_BYTES = 512 * 1024

function writeCappedJson(file: string, value: unknown): void {
  const text = JSON.stringify(value ?? null, null, 2)
  if (Buffer.byteLength(text, 'utf8') > MODULE_JSON_MAX_BYTES) {
    throw new Error(`payload is larger than ${MODULE_JSON_MAX_BYTES / 1024} KB`)
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf8')
}

/**
 * A module's own settings, one file per module. They sit next to the app
 * settings rather than in the module folder: `data/user-settings/` is what an
 * update carries over, so a rule the user changed survives reinstalling the
 * module, and a module cannot ship a new version of its own overrides.
 */
function moduleConfigFile(id: string): string {
  return join(userSettingsDir(), 'module-config', `${id}.json`)
}

export function readModuleConfig(id: string): unknown {
  const safe = safeSegment(id)
  if (!safe) return null
  return readJson<unknown>(moduleConfigFile(safe), null)
}

export function writeModuleConfig(id: string, value: unknown): void {
  const safe = safeSegment(id)
  if (!safe) throw new Error(`invalid module id "${id}"`)
  writeCappedJson(moduleConfigFile(safe), value)
}

/**
 * Both stores below are a module's private sandbox: nothing else reads them,
 * and once its folder is gone nothing can. Uninstalling therefore takes them
 * with it - unlike the `settings.json` keys, which belong to the app's own
 * file and are deliberately kept so reinstalling puts the widgets back.
 *
 * An update never comes through here: the installer swaps the folder in place
 * (see module-installer.ts install()), so upgrading a module keeps its tags.
 */
export function deleteModuleConfig(id: string): void {
  const safe = safeSegment(id)
  if (!safe) return
  rmSync(moduleConfigFile(safe), { force: true })
}

/**
 * What a module remembers about one target machine - tags it invented, job
 * history, saved templates. Keyed by hostKeyFor() like the metrics history, so
 * two machines never see each other's data, and nothing has to be written on
 * the target itself (which would need sudo and a writable filesystem there).
 */
function moduleDataFile(moduleId: string, hostKey: string): string {
  return join(dataDir(), 'module-data', moduleId, `${hostKey}.json`)
}

export function readModuleData(moduleId: string, hostKey: string): unknown {
  const id = safeSegment(moduleId)
  const key = safeSegment(hostKey)
  if (!id || !key) return null
  return readJson<unknown>(moduleDataFile(id, key), null)
}

export function writeModuleData(moduleId: string, hostKey: string, value: unknown): void {
  const id = safeSegment(moduleId)
  const key = safeSegment(hostKey)
  if (!id || !key) throw new Error(`invalid module data key "${moduleId}/${hostKey}"`)
  writeCappedJson(moduleDataFile(id, key), value)
}

/** Every machine's copy at once - see the note on deleteModuleConfig. */
export function deleteModuleData(moduleId: string): void {
  const id = safeSegment(moduleId)
  if (!id) return
  rmSync(join(dataDir(), 'module-data', id), { recursive: true, force: true })
}

// ---------- Saved connections ----------

interface StoredConnection extends SavedConnection {
  encryptedPassword?: string
  encryptedSudoPassword?: string
}

/**
 * Saved connections belong to the account that saved them: two people using
 * the same WebUI should not see each other's machines, and deleting an account
 * takes its list with it.
 */
function userConnectionsFile(username: string): string {
  return join(userDataDir(username), 'connections.json')
}

function readConnections(username: string): StoredConnection[] {
  return readJson<StoredConnection[]>(userConnectionsFile(username), [])
}

function writeConnections(username: string, list: StoredConnection[]): void {
  mkdirSync(userDataDir(username), { recursive: true })
  writeFileSync(userConnectionsFile(username), JSON.stringify(list, null, 2), 'utf8')
}

function encrypt(plain: string): string | undefined {
  try {
    return encryptString(plain)
  } catch {
    return undefined
  }
}

/**
 * undefined for a value written by the Electron build: those were sealed with
 * the desktop keyring, which this process cannot open. The entry keeps its
 * host/username/port, only the password is gone.
 */
function decrypt(enc: string | undefined): string | undefined {
  return decryptString(enc) ?? undefined
}

export function listConnections(username: string): SavedConnection[] {
  return readConnections(username).map(
    ({ id, label, host, port, username: user, encryptedPassword }) => ({
      id,
      label,
      host,
      port,
      username: user,
      hasSavedPassword: isEncrypted(encryptedPassword)
    })
  )
}

export function rememberConnection(
  owner: string,
  cfg: {
    host: string
    port: number
    username: string
    label?: string
    password?: string
    sudoPassword?: string
    rememberPassword?: boolean
  }
): void {
  const list = readConnections(owner)
  const id = `${cfg.username}@${cfg.host}:${cfg.port}`
  const existing = list.findIndex((c) => c.id === id)
  const entry: StoredConnection = {
    id,
    label: cfg.label || id,
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    hasSavedPassword: false
  }
  if (cfg.rememberPassword && cfg.password) {
    entry.encryptedPassword = encrypt(cfg.password)
    if (cfg.sudoPassword) entry.encryptedSudoPassword = encrypt(cfg.sudoPassword)
  } else if (existing >= 0) {
    // Keep previously saved credentials when re-connecting without "remember".
    entry.encryptedPassword = list[existing].encryptedPassword
    entry.encryptedSudoPassword = list[existing].encryptedSudoPassword
  }
  if (existing >= 0) list.splice(existing, 1)
  list.unshift(entry)
  writeConnections(owner, list.slice(0, 15))
}

export function getSavedCredentials(
  username: string,
  id: string
): { password?: string; sudoPassword?: string } | null {
  const found = readConnections(username).find((c) => c.id === id)
  if (!found) return null
  return {
    password: decrypt(found.encryptedPassword),
    sudoPassword: decrypt(found.encryptedSudoPassword)
  }
}

export function deleteConnection(username: string, id: string): void {
  writeConnections(
    username,
    readConnections(username).filter((c) => c.id !== id)
  )
}

/**
 * One-off move of the single pre-auth connection list into the default
 * account's folder. The saved passwords cannot come along: they were sealed
 * with the desktop keyring of the Electron build (see decrypt()), so only the
 * host, user and port survive - which is still the useful part of the list.
 */
export function migrateLegacyConnections(): string | null {
  const legacy = connectionsFile()
  if (!existsSync(legacy)) return null
  const target = userConnectionsFile(DEFAULT_USERNAME)
  try {
    if (!existsSync(target)) {
      const kept = readJson<StoredConnection[]>(legacy, []).map((c) => ({
        ...c,
        encryptedPassword: isEncrypted(c.encryptedPassword) ? c.encryptedPassword : undefined,
        encryptedSudoPassword: isEncrypted(c.encryptedSudoPassword)
          ? c.encryptedSudoPassword
          : undefined,
        hasSavedPassword: isEncrypted(c.encryptedPassword)
      }))
      writeConnections(DEFAULT_USERNAME, kept)
    }
    renameSync(legacy, `${legacy}.v1.bak`)
    return target
  } catch {
    return null
  }
}
