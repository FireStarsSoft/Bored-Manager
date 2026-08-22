import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync
} from 'fs'
import { dirname, join, resolve } from 'path'
import {
  DEFAULT_USERNAME,
  SETTINGS_VERSION,
  type AppSettings,
  type ConnectionConfig,
  type SavedConnection
} from '@shared/types'
import {
  APP_SETTINGS_LIMITS,
  normalizeAllowedHostname,
  normalizeAppSettings
} from '@shared/app-settings'
import { isFiniteNumber, isRecord } from '@shared/validation'
import { MODULE_ID_PATTERN, type ModuleRuntimeState } from '@shared/modules'
import { decryptString, encryptString, isEncrypted } from './secret'
import {
  backupFile,
  readPrivateJson,
  writeAtomicPrivateFile,
  writeAtomicPrivateJson,
  type JsonParser
} from './private-file'

/**
 * Everything lives inside the app root folder (portable install):
 *   data/connections.json     - recent connections (passwords encrypted with data/secret.key)
 *   data/user-settings/settings.json - user customisations, easy to import/export
 *   data/user-settings/module-config/<id>.json - a module's own settings
 *   data/module-data/<id>/<hostKey>.json - what a module remembers per target
 */

let rootCache: string | null = null

/** Test seam for cases that isolate data with a different BM_APP_ROOT. */
export function resetStoreCacheForTests(): void {
  rootCache = null
}

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

function readJson<T>(file: string, fallback: T, parse: JsonParser<T> = (value) => value as T): T {
  const result = readPrivateJson(file, parse, 'application data')
  return result.kind === 'missing' ? fallback : result.value
}

function chmodQuiet(file: string, mode: number): void {
  try {
    chmodSync(file, mode)
  } catch {
    // Windows and some mounts do not implement POSIX modes.
  }
}

/** Create `dir` (and parents) and set it to `0700` so only this user can walk it. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
  chmodQuiet(dir, 0o700)
}

/** JSON on disk that only this user should read (accounts, settings, lockout). */
export function writePrivateJson(file: string, value: unknown): void {
  writeAtomicPrivateJson(file, value)
}

function writeJson(file: string, value: unknown): void {
  writePrivateJson(file, value)
}

/**
 * Lock down the data folder and the files that hold secrets or session state.
 * Called on every boot so an older install, or a file rewritten without a
 * mode, does not stay world-readable.
 */
export function hardenDataPermissions(): void {
  const root = dataDir()
  ensurePrivateDir(root)
  const files = [
    join(root, 'connections.json'),
    join(root, 'auth-lock.json'),
    join(root, 'known-hosts.json'),
    join(root, 'secret.key'),
    join(root, 'users', 'users.json'),
    settingsFile()
  ]
  for (const file of files) {
    if (existsSync(file)) chmodQuiet(file, 0o600)
    if (existsSync(backupFile(file))) chmodQuiet(backupFile(file), 0o600)
  }
  const sessions = join(root, 'sessions')
  ensurePrivateDir(sessions)
  try {
    for (const name of readdirSync(sessions)) {
      chmodQuiet(join(sessions, name), 0o600)
    }
  } catch {
    /* listing is best-effort */
  }
  const usersRoot = join(root, 'users')
  if (existsSync(usersRoot)) {
    ensurePrivateDir(usersRoot)
    try {
      for (const name of readdirSync(usersRoot)) {
        const conn = join(usersRoot, name, 'connections.json')
        if (existsSync(conn)) chmodQuiet(conn, 0o600)
      }
    } catch {
      /* same */
    }
  }
}

// ---------- Settings ----------

export function validateSettingsDocument(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('settings must be a JSON object')
  const rawVersion = value['settingsVersion']
  if (rawVersion === undefined) throw new Error('settingsVersion is required')
  if (
    !isFiniteNumber(rawVersion) ||
      !Number.isInteger(rawVersion) ||
      rawVersion < 0 ||
      rawVersion > SETTINGS_VERSION
  ) {
    throw new Error(`settingsVersion must be an integer from 0 to ${SETTINGS_VERSION}`)
  }

  // Server and authentication settings were introduced in v4. Once a file
  // claims that schema, malformed security fields are corruption rather than
  // "missing values" that may safely inherit the permissive first-run defaults.
  const version = rawVersion
  if (version >= 4) {
    const server = value['server']
    if (!isRecord(server)) throw new Error('server settings must be an object')
    if (
      !isFiniteNumber(server['port']) ||
      !Number.isInteger(server['port']) ||
      server['port'] < 1 ||
      server['port'] > 65_535
    ) {
      throw new Error('server.port is invalid')
    }
    if (
      typeof server['host'] !== 'string' ||
      server['host'].trim().length === 0 ||
      server['host'].length > 255
    ) {
      throw new Error('server.host is invalid')
    }
    if (version >= 7) {
      if (
        !Array.isArray(server['allowedHosts']) ||
        server['allowedHosts'].length > APP_SETTINGS_LIMITS.allowedHosts.maxEntries
      ) {
        throw new Error('server.allowedHosts is invalid')
      }
      for (const entry of server['allowedHosts']) {
        const hostname = normalizeAllowedHostname(entry)
        if (!hostname) {
          throw new Error('server.allowedHosts contains an invalid hostname')
        }
      }
      if (typeof server['trustProxy'] !== 'boolean') {
        throw new Error('server.trustProxy must be boolean')
      }
    }

    const auth = value['auth']
    if (!isRecord(auth)) throw new Error('auth settings must be an object')
    if (typeof auth['enabled'] !== 'boolean') throw new Error('auth.enabled must be boolean')
    const max = auth['maxFailures']
    if (
      !isFiniteNumber(max) ||
      !Number.isInteger(max) ||
      max < APP_SETTINGS_LIMITS.authMaxFailures.min ||
      max > APP_SETTINGS_LIMITS.authMaxFailures.max
    ) {
      throw new Error('auth.maxFailures is invalid')
    }
    const idle = auth['sessionIdle']
    if (!isRecord(idle)) throw new Error('auth.sessionIdle must be an object')
    const idleValue = idle['value']
    if (
      !isFiniteNumber(idleValue) ||
      !Number.isInteger(idleValue) ||
      idleValue < APP_SETTINGS_LIMITS.sessionIdleValue.min ||
      idleValue > APP_SETTINGS_LIMITS.sessionIdleValue.max
    ) {
      throw new Error('auth.sessionIdle.value is invalid')
    }
    if (!['minute', 'hour', 'day'].includes(String(idle['unit']))) {
      throw new Error('auth.sessionIdle.unit is invalid')
    }
  }
  return value
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
 * Modules a v2 settings file wants switched off, captured while that file is
 * still readable: loadSettings rewrites it in the current format, which drops
 * the per-feature collector flags this is derived from.
 */
let legacyDisabled: string[] | null = null

function captureLegacyDisabled(value: unknown): void {
  if (!isRecord(value)) return
  const version = isFiniteNumber(value['settingsVersion'])
    ? Math.max(0, Math.trunc(value['settingsVersion']))
    : 0
  if (version >= 3) return
  const collectors = isRecord(value['collectors']) ? value['collectors'] : {}
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
  const stored = readPrivateJson(settingsFile(), validateSettingsDocument, 'settings')
  const raw: unknown = stored.kind === 'missing' ? null : stored.value
  captureLegacyDisabled(raw)
  const merged = normalizeAppSettings(raw)
  if (raw !== null && (!isRecord(raw) || raw['settingsVersion'] !== SETTINGS_VERSION)) {
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
  const merged = normalizeAppSettings(validateSettingsDocument(settings))
  writeJson(settingsFile(), merged)
  return merged
}

/**
 * Read a settings file the user picked, without writing anything: the caller
 * saves it, so an imported file goes through exactly the same checks as a
 * settings write from the UI. A file with settingsVersion below 3 is converted
 * like one found on disk - including its per-feature collector flags, so
 * takeLegacyDisabledModules() has something to report and importing "GPU was
 * off on that machine" actually switches the GPU module off here.
 */
export function readSettingsFile(sourcePath: string): Partial<AppSettings> {
  const raw = validateSettingsDocument(JSON.parse(readFileSync(sourcePath, 'utf8')) as unknown)
  captureLegacyDisabled(raw)
  return raw as Partial<AppSettings>
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

function moduleRegistryDocument(value: unknown): ModuleRegistryFile {
  if (!isRecord(value) || value['version'] !== 1 || !isRecord(value['modules'])) {
    throw new Error('module registry must contain version 1 and a modules object')
  }
  const modules: Record<string, ModuleRuntimeState> = {}
  for (const [id, raw] of Object.entries(value['modules'])) {
    if (!MODULE_ID_PATTERN.test(id) || !isRecord(raw) || raw['id'] !== id) {
      throw new Error(`module registry entry "${id}" is invalid`)
    }
    if (
      typeof raw['enabled'] !== 'boolean' ||
      typeof raw['version'] !== 'string' ||
      typeof raw['hash'] !== 'string' ||
      !['default', 'zip', 'url'].includes(String(raw['source'])) ||
      !isFiniteNumber(raw['installedAt']) ||
      !isFiniteNumber(raw['updatedAt'])
    ) {
      throw new Error(`module registry entry "${id}" has invalid fields`)
    }
    modules[id] = {
      id,
      enabled: raw['enabled'],
      version: raw['version'],
      hash: raw['hash'],
      source: raw['source'] as ModuleRuntimeState['source'],
      installedAt: raw['installedAt'],
      updatedAt: raw['updatedAt']
    }
  }
  return { version: 1, modules }
}

export function readModuleRegistry(): Record<string, ModuleRuntimeState> {
  return readJson(modulesFile(), { version: 1, modules: {} }, moduleRegistryDocument).modules
}

export function writeModuleRegistry(modules: Record<string, ModuleRuntimeState>): void {
  writeJson(modulesFile(), { version: 1, modules } satisfies ModuleRegistryFile)
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
  writeAtomicPrivateFile(file, text)
}

/**
 * A module's own settings, one file per module. They sit next to the app
 * settings rather than in the module folder: `data/user-settings/` is what an
 * update carries over, so a rule the user changed survives reinstalling the
 * module, and a module cannot ship a new version of its own overrides.
 */
export function moduleConfigPath(id: string): string {
  const safe = safeSegment(id)
  if (!safe) throw new Error(`invalid module id "${id}"`)
  return join(userSettingsDir(), 'module-config', `${safe}.json`)
}

export function readModuleConfig(id: string): unknown {
  const safe = safeSegment(id)
  if (!safe) return null
  return readJson<unknown>(moduleConfigPath(safe), null)
}

export function writeModuleConfig(id: string, value: unknown): void {
  const safe = safeSegment(id)
  if (!safe) throw new Error(`invalid module id "${id}"`)
  writeCappedJson(moduleConfigPath(safe), value)
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
  const file = moduleConfigPath(safe)
  rmSync(file, { force: true })
  rmSync(backupFile(file), { force: true })
}

/**
 * What a module remembers about one target machine - tags it invented, job
 * history, saved templates. Keyed by hostKeyFor() like the metrics history, so
 * two machines never see each other's data, and nothing has to be written on
 * the target itself (which would need sudo and a writable filesystem there).
 */
export function moduleDataPath(moduleId: string): string {
  const safe = safeSegment(moduleId)
  if (!safe) throw new Error(`invalid module id "${moduleId}"`)
  return join(dataDir(), 'module-data', safe)
}

function moduleDataFile(moduleId: string, hostKey: string): string {
  return join(moduleDataPath(moduleId), `${hostKey}.json`)
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
  rmSync(moduleDataPath(id), { recursive: true, force: true })
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
  writeJson(userConnectionsFile(username), list)
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
    ({ id, label, host, port, username: user, encryptedPassword, encryptedSudoPassword }) => ({
      id,
      label,
      host,
      port,
      username: user,
      hasSavedPassword:
        isEncrypted(encryptedPassword) || isEncrypted(encryptedSudoPassword)
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
    /** Remove a previously saved sudo credential after the target rejected it. */
    clearSudoPassword?: boolean
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
  if (existing >= 0) {
    // Keep previously saved credentials unless this successful attempt
    // explicitly supplies a verified replacement or rejects the sudo value.
    entry.encryptedPassword = list[existing].encryptedPassword
    entry.encryptedSudoPassword = list[existing].encryptedSudoPassword
  }
  if (cfg.rememberPassword) {
    if (cfg.password) entry.encryptedPassword = encrypt(cfg.password)
    if (cfg.sudoPassword) entry.encryptedSudoPassword = encrypt(cfg.sudoPassword)
  }
  if (cfg.clearSudoPassword) delete entry.encryptedSudoPassword
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

/** Rebuild a connect request without exposing saved secrets to the browser. */
export function getSavedConnectionConfig(
  username: string,
  id: string
): ConnectionConfig | null {
  const found = readConnections(username).find((connection) => connection.id === id)
  if (!found) return null
  const password = decrypt(found.encryptedPassword)
  const sudoPassword = decrypt(found.encryptedSudoPassword)
  if (!password) return null
  return {
    mode: 'ssh',
    label: found.label,
    host: found.host,
    port: found.port,
    username: found.username,
    password,
    sudoPassword,
    rememberPassword: true
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
