import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync
} from 'fs'
import { tmpdir } from 'os'
import { basename, join, relative, sep } from 'path'
import type {
  ModuleCatalog,
  ModuleCheckItem,
  ModuleInstallKind,
  ModuleInstallState,
  ModuleManifest,
  ModuleRuntimeState,
  ModuleSource,
  ModuleValidation,
  RegistryEntry
} from '@shared/modules'
import {
  MODULE_ARCHIVE_MAX_BYTES,
  MODULE_DOWNLOAD_TIMEOUT_MS,
  MODULE_ID_PATTERN,
  MODULE_MANIFEST_FILE,
  compareVersions,
  manifestProblems
} from '@shared/modules'
import { specProblems } from '@shared/module-ui'
import { isRecord } from '@shared/validation'
import { PublicError, internalErrorDetail } from '../errors'
import { log } from '../log'
import { extractZip } from './zip'
import {
  assertSafeDownloadUrl,
  downloadFile,
  findArchiveRoot,
  GITHUB_DOWNLOAD_HOSTS,
  type DownloadHandle
} from './download'
import { compileModuleAt } from './module-compiler'
import { defaultBranchZipUrl, latestReleaseZip, looksLikeZipUrl, parseGithubRepo } from './github'
import type { ModulesHost } from './modules-host'
import { moduleFolderHash, modulesDir, moduleDir } from './modules-host'
import { backupFile, writeAtomicPrivateFile } from './private-file'
import { getCatalog } from './registry'
import {
  appVersion,
  dataDir,
  deleteModuleConfig,
  deleteModuleData,
  ensurePrivateDir,
  moduleConfigPath,
  moduleDataPath,
  writeModuleRegistry
} from './store'

/**
 * Installing, updating and removing a module.
 *
 * Inspection always happens in a fresh private OS-temp directory. Applying a
 * module is a journalled transaction: a candidate is built next to the target,
 * the old folder and module-owned state are snapshotted, and only atomic
 * renames put code into service. A startup recovery pass rolls an incomplete
 * transaction back, or finishes cleanup after a committed one.
 */

const MAX_LOG_LINES = 400
const WORK_PREFIX = 'bored-manager-module-'
const TRANSACTION_DIRECTORY = 'module-transactions'
const TRANSACTION_VERSION = 1
const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000
const CONFIRMATION_TTL_MS = 5 * 60 * 1000
const TRANSACTION_ID_PATTERN = /^[0-9a-f]{32}$/

type TransactionOperation = 'install' | 'uninstall'
type TransactionPhase =
  | 'preparing'
  | 'snapshotting'
  | 'prepared'
  | 'moving-target'
  | 'promoting-candidate'
  | 'updating-state'
  | 'rolled-back'
  | 'committed'

interface CatalogBinding {
  repo: string
  sourceUrl: string
  expectedId: string
  expectedVersion: string
  expectedSha256: string
  fetchedAt: number
}

interface StagedModule {
  workDir: string
  root: string
  archivePath: string
  archiveSha256: string
  treeSha256: string
  manifest: ModuleManifest
  source: ModuleSource
  sourceUrl: string | null
  catalogBinding: CatalogBinding | null
}

interface InstallConfirmation {
  tokenHash: Buffer
  expiresAt: number
  runId: number
  treeSha256: string
  moduleId: string
  consumed: boolean
}

interface TransactionJournal {
  version: typeof TRANSACTION_VERSION
  transactionId: string
  operation: TransactionOperation
  id: string
  phase: TransactionPhase
  hadTarget: boolean
  registry: Record<string, ModuleRuntimeState> | null
  configPrimary: boolean
  configBackup: boolean
  moduleData: boolean
}

interface ActiveTransaction {
  journal: TransactionJournal
  hostStopped: boolean
}

class ActivationFailure extends Error {
  constructor(readonly compilerLog: string) {
    super('candidate activation failed')
  }
}

function rawMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function statusOf(checks: ModuleCheckItem[]): ModuleValidation['status'] {
  if (checks.some((check) => check.level === 'error')) return 'error'
  if (checks.some((check) => check.level === 'warning')) return 'warning'
  return 'pass'
}

function normalizeUrl(raw: string): { value: string; trusted: boolean } | { error: string } {
  const trimmed = raw.trim()
  if (!trimmed) return { error: 'Paste a module .zip URL, an owner/repo, or a GitHub repo URL first' }
  try {
    const url = assertSafeDownloadUrl(trimmed, GITHUB_DOWNLOAD_HOSTS)
    if (!looksLikeZipUrl(url)) return { error: 'The link must point directly at a .zip archive' }
    return { value: url.toString(), trusted: true }
  } catch (error) {
    return { error: redactPaths(rawMessage(error)) }
  }
}

function redactPaths(text: string, knownRoots: readonly string[] = []): string {
  let safe = text
  for (const root of [...knownRoots].sort((a, b) => b.length - a.length)) {
    if (!root) continue
    safe = safe.split(root).join('[path]')
    safe = safe.split(root.replace(/\\/g, '/')).join('[path]')
    safe = safe.split(root.replace(/\//g, '\\')).join('[path]')
  }
  // Filesystem errors commonly append an absolute path. Keep the useful
  // diagnostic before it, but never return a host path to the browser.
  safe = safe.replace(/\b[A-Za-z]:[\\/][^\r\n]*/g, '[path]')
  safe = safe.replace(/(^|[\s("'`])\/(?:tmp|var|home|Users|opt|srv)\/[^\r\n]*/g, '$1[path]')
  return safe.trim().slice(0, 2_000)
}

function publicFailure(
  error: unknown,
  fallback: string,
  code = 'MODULE_OPERATION_FAILED',
  status = 500
): PublicError {
  if (error instanceof PublicError) return error
  log(`[module-installer] ${internalErrorDetail(error)}`)
  return new PublicError(code, fallback, status)
}

function diagnostic(error: unknown, fallback: string, roots: readonly string[] = []): string {
  log(`[module-installer] ${internalErrorDetail(error)}`)
  return redactPaths(rawMessage(error), roots) || fallback
}

function chmodPrivate(path: string, mode: number): void {
  try {
    chmodSync(path, mode)
  } catch (error) {
    // POSIX permissions are not implemented by Windows. On a POSIX host a
    // failure means the staging area is not known to be private, so fail.
    if (process.platform !== 'win32') throw error
  }
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function hashFile(path: string): string {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  const fd = openSync(path, 'r')
  try {
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null)
      if (read === 0) break
      hash.update(buffer.subarray(0, read))
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

function treeFiles(root: string, dir = root, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.dist') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      treeFiles(root, path, out)
      continue
    }
    if (!entry.isFile()) {
      throw new Error(`module tree contains a non-regular entry: ${entry.name}`)
    }
    out.push(relative(root, path).split(sep).join('/'))
  }
  return out
}

/** Exact-byte digest used to pin the inspected tree until its atomic swap. */
function exactModuleTreeHash(root: string): string {
  if (!statSync(root).isDirectory()) throw new Error('module root is not a directory')
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  for (const rel of treeFiles(root).sort()) {
    hash.update(rel)
    hash.update('\0')
    const fd = openSync(join(root, rel), 'r')
    try {
      for (;;) {
        const read = readSync(fd, buffer, 0, buffer.length, null)
        if (read === 0) break
        hash.update(buffer.subarray(0, read))
      }
    } finally {
      closeSync(fd)
    }
  }
  return hash.digest('hex')
}

function transactionDir(): string {
  return join(dataDir(), TRANSACTION_DIRECTORY)
}

function transactionFile(transactionId: string): string {
  return join(transactionDir(), `${transactionId}.json`)
}

function snapshotDir(transactionId: string): string {
  return join(transactionDir(), `${transactionId}.snapshot`)
}

function candidateDir(id: string, transactionId: string): string {
  return join(modulesDir(), `${id}.candidate-${transactionId}`)
}

function backupDir(id: string, transactionId: string): string {
  return join(modulesDir(), `${id}.backup-${transactionId}`)
}

function snapshotConfigPrimary(transactionId: string): string {
  return join(snapshotDir(transactionId), 'config.primary')
}

function snapshotConfigBackup(transactionId: string): string {
  return join(snapshotDir(transactionId), 'config.backup')
}

function snapshotModuleData(transactionId: string): string {
  return join(snapshotDir(transactionId), 'module-data')
}

function cloneRegistry(
  registry: Record<string, ModuleRuntimeState>
): Record<string, ModuleRuntimeState> {
  return Object.fromEntries(
    Object.entries(registry).map(([id, state]) => [id, { ...state }])
  )
}

function parseRegistry(value: unknown): Record<string, ModuleRuntimeState> {
  if (!isRecord(value)) throw new Error('transaction registry snapshot is not an object')
  const registry: Record<string, ModuleRuntimeState> = {}
  for (const [id, raw] of Object.entries(value)) {
    if (
      !MODULE_ID_PATTERN.test(id) ||
      !isRecord(raw) ||
      raw['id'] !== id ||
      typeof raw['enabled'] !== 'boolean' ||
      typeof raw['version'] !== 'string' ||
      typeof raw['hash'] !== 'string' ||
      !['default', 'zip', 'url'].includes(String(raw['source'])) ||
      typeof raw['installedAt'] !== 'number' ||
      !Number.isFinite(raw['installedAt']) ||
      typeof raw['updatedAt'] !== 'number' ||
      !Number.isFinite(raw['updatedAt'])
    ) {
      throw new Error(`transaction registry entry "${id}" is invalid`)
    }
    registry[id] = {
      id,
      enabled: raw['enabled'],
      version: raw['version'],
      hash: raw['hash'],
      source: raw['source'] as ModuleSource,
      installedAt: raw['installedAt'],
      updatedAt: raw['updatedAt']
    }
  }
  return registry
}

function parseJournal(file: string, expectedId: string): TransactionJournal {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
  if (!isRecord(raw)) throw new Error('transaction journal is not an object')
  const phase = raw['phase']
  const operation = raw['operation']
  const transactionId = raw['transactionId']
  const id = raw['id']
  const phases: readonly string[] = [
    'preparing',
    'snapshotting',
    'prepared',
    'moving-target',
    'promoting-candidate',
    'updating-state',
    'rolled-back',
    'committed'
  ]
  if (
    raw['version'] !== TRANSACTION_VERSION ||
    transactionId !== expectedId ||
    typeof transactionId !== 'string' ||
    !TRANSACTION_ID_PATTERN.test(transactionId) ||
    (operation !== 'install' && operation !== 'uninstall') ||
    typeof id !== 'string' ||
    !MODULE_ID_PATTERN.test(id) ||
    !phases.includes(String(phase)) ||
    typeof raw['hadTarget'] !== 'boolean' ||
    typeof raw['configPrimary'] !== 'boolean' ||
    typeof raw['configBackup'] !== 'boolean' ||
    typeof raw['moduleData'] !== 'boolean'
  ) {
    throw new Error('transaction journal has invalid fields')
  }
  const registry = raw['registry'] === null ? null : parseRegistry(raw['registry'])
  if (
    registry === null &&
    phase !== 'preparing'
  ) {
    throw new Error('transaction journal has no registry snapshot')
  }
  return {
    version: TRANSACTION_VERSION,
    transactionId,
    operation,
    id,
    phase: phase as TransactionPhase,
    hadTarget: raw['hadTarget'],
    registry,
    configPrimary: raw['configPrimary'],
    configBackup: raw['configBackup'],
    moduleData: raw['moduleData']
  }
}

function writeJournal(journal: TransactionJournal, phase: TransactionPhase): void {
  ensurePrivateDir(transactionDir())
  const next = { ...journal, phase }
  writeAtomicPrivateFile(
    transactionFile(journal.transactionId),
    JSON.stringify(next, null, 2),
    { backup: false }
  )
  journal.phase = phase
}

function copyPrivateFile(source: string, destination: string): void {
  copyFileSync(source, destination, constants.COPYFILE_EXCL)
  chmodPrivate(destination, 0o600)
}

function capturePersistentSnapshot(journal: TransactionJournal): void {
  const root = snapshotDir(journal.transactionId)
  ensurePrivateDir(root)
  chmodPrivate(root, 0o700)
  const config = moduleConfigPath(journal.id)
  if (journal.configPrimary) copyPrivateFile(config, snapshotConfigPrimary(journal.transactionId))
  if (journal.configBackup) {
    copyPrivateFile(backupFile(config), snapshotConfigBackup(journal.transactionId))
  }
  if (journal.moduleData) {
    cpSync(moduleDataPath(journal.id), snapshotModuleData(journal.transactionId), {
      recursive: true,
      errorOnExist: true,
      force: false
    })
  }
}

function assertSnapshotComplete(journal: TransactionJournal): void {
  if (journal.configPrimary && !isRegularFile(snapshotConfigPrimary(journal.transactionId))) {
    throw new Error('module config snapshot is incomplete')
  }
  if (journal.configBackup && !isRegularFile(snapshotConfigBackup(journal.transactionId))) {
    throw new Error('module config backup snapshot is incomplete')
  }
  if (
    journal.moduleData &&
    (!existsSync(snapshotModuleData(journal.transactionId)) ||
      !statSync(snapshotModuleData(journal.transactionId)).isDirectory())
  ) {
    throw new Error('module data snapshot is incomplete')
  }
}

function restorePrivateFile(source: string, destination: string): void {
  writeAtomicPrivateFile(destination, readFileSync(source), { backup: false })
}

function restorePersistentFiles(journal: TransactionJournal): void {
  assertSnapshotComplete(journal)
  const config = moduleConfigPath(journal.id)
  const configBackup = backupFile(config)
  if (journal.configBackup) {
    restorePrivateFile(snapshotConfigBackup(journal.transactionId), configBackup)
  } else {
    rmSync(configBackup, { force: true })
  }
  if (journal.configPrimary) {
    restorePrivateFile(snapshotConfigPrimary(journal.transactionId), config)
  } else {
    rmSync(config, { force: true })
  }

  const currentData = moduleDataPath(journal.id)
  if (!journal.moduleData) {
    rmSync(currentData, { recursive: true, force: true })
    return
  }

  const restore = `${currentData}.restore-${journal.transactionId}`
  const displaced = `${currentData}.discard-${journal.transactionId}`
  rmSync(restore, { recursive: true, force: true })
  rmSync(displaced, { recursive: true, force: true })
  cpSync(snapshotModuleData(journal.transactionId), restore, {
    recursive: true,
    errorOnExist: true,
    force: false
  })
  if (existsSync(currentData)) renameSync(currentData, displaced)
  try {
    renameSync(restore, currentData)
  } catch (error) {
    if (existsSync(displaced) && !existsSync(currentData)) renameSync(displaced, currentData)
    throw error
  }
  rmSync(displaced, { recursive: true, force: true })
}

function restoreModuleFolder(journal: TransactionJournal): void {
  const target = moduleDir(journal.id)
  const backup = backupDir(journal.id, journal.transactionId)
  const candidate = candidateDir(journal.id, journal.transactionId)
  if (journal.hadTarget) {
    if (existsSync(backup)) {
      rmSync(target, { recursive: true, force: true })
      renameSync(backup, target)
    } else if (!existsSync(target)) {
      throw new Error('both the module target and its transaction backup are missing')
    }
  } else {
    rmSync(target, { recursive: true, force: true })
  }
  rmSync(candidate, { recursive: true, force: true })
}

function removeTransactionArtifacts(journal: TransactionJournal): void {
  rmSync(candidateDir(journal.id, journal.transactionId), { recursive: true, force: true })
  rmSync(backupDir(journal.id, journal.transactionId), { recursive: true, force: true })
  rmSync(snapshotDir(journal.transactionId), { recursive: true, force: true })
  rmSync(transactionFile(journal.transactionId), { force: true })
}

function removeUntouchedTransaction(journal: TransactionJournal): void {
  rmSync(candidateDir(journal.id, journal.transactionId), { recursive: true, force: true })
  rmSync(snapshotDir(journal.transactionId), { recursive: true, force: true })
  rmSync(transactionFile(journal.transactionId), { force: true })
}

function phaseMayHaveMutatedState(phase: TransactionPhase): boolean {
  return (
    phase === 'moving-target' ||
    phase === 'promoting-candidate' ||
    phase === 'updating-state' ||
    phase === 'committed'
  )
}

function catalogIsFresh(
  catalog: ModuleCatalog,
  expectedRepo: string,
  now = Date.now()
): catalog is ModuleCatalog & {
  fetchedAt: number
} {
  if (catalog.stale || catalog.fetchedAt === null) return false
  if (
    catalog.sourceRepo !== expectedRepo ||
    catalog.sourceUrl !==
      `https://raw.githubusercontent.com/${expectedRepo}/main/registry/modules.json`
  ) {
    return false
  }
  const age = now - catalog.fetchedAt
  return age >= 0 && age <= CATALOG_MAX_AGE_MS
}

function canonicalCatalogUrl(raw: string): string | null {
  try {
    const url = assertSafeDownloadUrl(raw, GITHUB_DOWNLOAD_HOSTS)
    return looksLikeZipUrl(url) ? url.toString() : null
  } catch {
    return null
  }
}

function exactCatalogMatches(
  entries: readonly RegistryEntry[],
  sourceUrl: string,
  id: string,
  version: string,
  sha256: string
): RegistryEntry[] {
  return entries.filter(
    (entry) =>
      entry.id === id &&
      entry.version === version &&
      entry.sha256 === sha256 &&
      canonicalCatalogUrl(entry.download) === sourceUrl
  )
}

export class ModuleInstallerService {
  private state: ModuleInstallState = { phase: 'idle' }
  private transfer: DownloadHandle | null = null
  private workspace: string | null = null
  private staged: StagedModule | null = null
  private confirmation: InstallConfirmation | null = null
  /** Bumped by cancel(), so an aborted check stops reporting into the state. */
  private runId = 0

  constructor(
    private readonly host: ModulesHost,
    private readonly onState: (state: ModuleInstallState) => void,
    private readonly onListChanged: () => void,
    /** `settings.update.repo`, read lazily so a change takes effect immediately. */
    private readonly getRepo: () => string
  ) {}

  getState(): ModuleInstallState {
    return this.state
  }

  private setState(patch: Partial<ModuleInstallState>): ModuleInstallState {
    const confirmation =
      patch.phase !== undefined && patch.phase !== 'ready' ? undefined : this.state.confirmation
    this.state = { ...this.state, confirmation, ...patch }
    this.onState(this.state)
    return this.state
  }

  private busy(): boolean {
    return ['downloading', 'extracting', 'validating', 'installing', 'building'].includes(
      this.state.phase
    )
  }

  private failState(
    error: unknown,
    fallback: string,
    patch: Partial<ModuleInstallState> = {}
  ): ModuleInstallState {
    const safe = publicFailure(error, fallback)
    return this.setState({ ...patch, phase: 'error', error: safe.message })
  }

  private createWorkspace(): string {
    this.discardWorkspace()
    const work = mkdtempSync(join(tmpdir(), WORK_PREFIX))
    chmodPrivate(work, 0o700)
    this.workspace = work
    return work
  }

  private discardWorkspace(): void {
    this.confirmation = null
    if (!this.workspace) {
      this.staged = null
      return
    }
    const work = this.workspace
    rmSync(work, { recursive: true, force: true })
    if (existsSync(work)) throw new Error('private module staging could not be removed')
    this.workspace = null
    this.staged = null
  }

  private hasPendingTransaction(): boolean {
    if (!existsSync(transactionDir())) return false
    return readdirSync(transactionDir()).some((name) => name.endsWith('.json'))
  }

  // ---------- Startup recovery ----------

  /**
   * Recover every interrupted install/update/uninstall before ModulesHost.init
   * reconciles the folders with the registry. Incomplete work is rolled back;
   * a committed transaction only has its backup/snapshot cleanup finished.
   */
  recoverPendingTransactions(): number {
    if (!existsSync(transactionDir())) return 0
    let recovered = 0
    let names: string[]
    try {
      names = readdirSync(transactionDir())
        .filter((name) => name.endsWith('.json'))
        .sort()
    } catch (error) {
      throw publicFailure(error, 'Interrupted module operations could not be recovered')
    }

    for (const name of names) {
      const transactionId = name.slice(0, -'.json'.length)
      try {
        if (!TRANSACTION_ID_PATTERN.test(transactionId)) {
          throw new Error('unexpected transaction journal filename')
        }
        const journal = parseJournal(join(transactionDir(), name), transactionId)
        const target = moduleDir(journal.id)
        const committedLooksComplete =
          journal.phase === 'committed' &&
          (journal.operation === 'install' ? existsSync(target) : !existsSync(target))

        if (journal.phase === 'committed' && committedLooksComplete) {
          removeTransactionArtifacts(journal)
        } else if (journal.phase === 'rolled-back') {
          removeTransactionArtifacts(journal)
        } else if (!phaseMayHaveMutatedState(journal.phase)) {
          removeUntouchedTransaction(journal)
        } else {
          if (!journal.registry) throw new Error('transaction has no registry snapshot')
          restoreModuleFolder(journal)
          restorePersistentFiles(journal)
          writeModuleRegistry(cloneRegistry(journal.registry))
          writeJournal(journal, 'rolled-back')
          removeTransactionArtifacts(journal)
        }

        // ModulesHost discovers folders in its constructor, which runs before
        // this recovery call. Remove any candidate/backup it saw and refresh
        // the actual id before init() consumes the recovered registry.
        this.host.rescan(journal.id)
        this.host.rescan(basename(candidateDir(journal.id, journal.transactionId)))
        this.host.rescan(basename(backupDir(journal.id, journal.transactionId)))
        recovered++
      } catch (error) {
        throw publicFailure(
          error,
          'Interrupted module operations could not be recovered',
          'MODULE_RECOVERY_FAILED'
        )
      }
    }
    return recovered
  }

  // ---------- Inspect ----------

  async checkUrl(rawUrl: string): Promise<ModuleInstallState> {
    if (this.busy()) return this.setState({ error: 'Another module operation is running' })
    const trimmed = rawUrl.trim()
    if (!trimmed) {
      return this.setState({
        phase: 'error',
        error: 'Paste a module .zip URL, an owner/repo, or a GitHub repo URL first',
        validation: undefined
      })
    }
    if (this.hasPendingTransaction()) {
      return this.setState({
        phase: 'error',
        error: 'An interrupted module operation must be recovered before another can start',
        validation: undefined
      })
    }

    try {
      this.discardWorkspace()
    } catch (error) {
      return this.failState(error, 'The previous private staging area could not be removed')
    }
    const runId = ++this.runId
    const repo = trimmed.toLowerCase().endsWith('.zip') ? null : parseGithubRepo(trimmed)
    let resolvedUrl = trimmed
    if (repo) {
      this.setState({
        phase: 'downloading',
        source: trimmed,
        error: undefined,
        validation: undefined,
        log: undefined,
        progress: undefined
      })
      try {
        const release = await latestReleaseZip(
          repo,
          (name) => name.toLowerCase().endsWith('.zip') && !/^bored-manager-.*\.zip$/i.test(name)
        )
        resolvedUrl = release?.url ?? (await defaultBranchZipUrl(repo))
      } catch (error) {
        if (runId !== this.runId) return this.state
        const safe = new PublicError(
          'MODULE_SOURCE_RESOLUTION_FAILED',
          `Could not resolve the GitHub repository: ${redactPaths(rawMessage(error))}`,
          502
        )
        return this.setState({ phase: 'error', error: safe.message })
      }
      if (runId !== this.runId) return this.state
    }

    const normalized = normalizeUrl(resolvedUrl)
    if ('error' in normalized) {
      return this.setState({ phase: 'error', error: normalized.error, validation: undefined })
    }

    let work: string
    try {
      work = this.createWorkspace()
    } catch (error) {
      return this.failState(error, 'A private staging area could not be created')
    }
    const archivePath = join(work, 'module.zip')
    this.setState({
      phase: 'downloading',
      source: normalized.value,
      error: undefined,
      validation: undefined,
      log: undefined,
      progress: { receivedBytes: 0, totalBytes: null }
    })

    try {
      const transfer = downloadFile(normalized.value, archivePath, {
        maxBytes: MODULE_ARCHIVE_MAX_BYTES,
        timeoutMs: MODULE_DOWNLOAD_TIMEOUT_MS,
        allowedHosts: GITHUB_DOWNLOAD_HOSTS,
        onProgress: (receivedBytes, totalBytes) => {
          if (runId === this.runId) {
            this.setState({ progress: { receivedBytes, totalBytes } })
          }
        }
      })
      this.transfer = transfer
      await transfer.done
      chmodPrivate(archivePath, 0o600)
    } catch (error) {
      if (runId !== this.runId) return this.state
      let cleanupError: unknown = null
      try {
        this.discardWorkspace()
      } catch (caught) {
        cleanupError = caught
      }
      if (cleanupError) {
        return this.failState(
          cleanupError,
          'The failed download and its private staging area could not be removed'
        )
      }
      const detail = redactPaths(rawMessage(error), [work])
      const safe = new PublicError(
        'MODULE_DOWNLOAD_FAILED',
        `Download failed: ${detail || 'the archive could not be downloaded'}`,
        502
      )
      return this.setState({ phase: 'error', error: safe.message })
    } finally {
      this.transfer = null
    }
    if (runId !== this.runId) return this.state
    return this.inspect(archivePath, runId, 'url', normalized.trusted, normalized.value)
  }

  /** Grade a zip the user picked from disk after copying it into private staging. */
  async checkFile(path: string): Promise<ModuleInstallState> {
    if (this.busy()) return this.setState({ error: 'Another module operation is running' })
    if (this.hasPendingTransaction()) {
      return this.setState({
        phase: 'error',
        error: 'An interrupted module operation must be recovered before another can start',
        validation: undefined
      })
    }
    let work: string
    try {
      work = this.createWorkspace()
    } catch (error) {
      return this.failState(error, 'A private staging area could not be created')
    }
    const runId = ++this.runId
    this.setState({
      phase: 'extracting',
      source: 'upload',
      error: undefined,
      validation: undefined,
      log: undefined,
      progress: undefined
    })
    if (!isRegularFile(path)) {
      try {
        this.discardWorkspace()
      } catch (error) {
        return this.failState(error, 'The private staging area could not be removed')
      }
      return this.setState({ phase: 'error', error: 'The uploaded file was not saved' })
    }

    const archivePath = join(work, 'module.zip')
    try {
      copyPrivateFile(path, archivePath)
    } catch (error) {
      try {
        this.discardWorkspace()
      } catch (cleanupError) {
        return this.failState(
          cleanupError,
          'The upload and its private staging area could not be removed'
        )
      }
      return this.failState(error, 'The uploaded archive could not be staged')
    }
    return this.inspect(archivePath, runId, 'zip', true, null)
  }

  private async inspect(
    archivePath: string,
    runId: number,
    source: ModuleSource,
    trusted: boolean,
    sourceUrl: string | null
  ): Promise<ModuleInstallState> {
    const work = this.workspace
    if (!work) return this.setState({ phase: 'error', error: 'Private staging is no longer available' })
    const stagingDir = join(work, 'staging')
    this.setState({ phase: 'extracting' })

    let archiveSha256: string
    let root: string | null = null
    try {
      archiveSha256 = hashFile(archivePath)
      await extractZip(archivePath, stagingDir)
      root = findArchiveRoot(stagingDir, MODULE_MANIFEST_FILE)
    } catch (error) {
      if (runId !== this.runId) return this.state
      let cleanupError: unknown = null
      try {
        this.discardWorkspace()
      } catch (caught) {
        cleanupError = caught
      }
      if (cleanupError) {
        return this.failState(
          cleanupError,
          'The unreadable archive and its private staging area could not be removed'
        )
      }
      const safe = new PublicError(
        'MODULE_ARCHIVE_INVALID',
        `The file is not a readable module archive: ${redactPaths(rawMessage(error), [work])}`,
        400
      )
      return this.setState({ phase: 'error', error: safe.message })
    }
    if (runId !== this.runId) return this.state

    this.setState({ phase: 'validating' })
    let result: Awaited<ReturnType<ModuleInstallerService['validate']>>
    try {
      result = await this.validate(root, trusted, archiveSha256, sourceUrl, work)
    } catch (error) {
      log(`[module-installer] validator escaped its boundary: ${internalErrorDetail(error)}`)
      result = {
        validation: {
          status: 'error',
          kind: 'new',
          overwritesDefault: false,
          checks: [
            {
              id: 'validator',
              level: 'error',
              label: 'Module validation completed safely',
              detail: 'A validator rejected malformed archive data'
            }
          ]
        },
        manifest: null,
        catalogBinding: null
      }
    }
    if (runId !== this.runId) return this.state

    let treeSha256 = ''
    if (result.validation.status !== 'error' && root && result.manifest) {
      try {
        treeSha256 = exactModuleTreeHash(root)
      } catch (error) {
        log(`[module-installer] staged tree digest failed: ${internalErrorDetail(error)}`)
        result.validation.checks.push({
          id: 'tree-digest',
          level: 'error',
          label: 'The staged module tree can be pinned for installation',
          detail: 'The extracted module tree could not be read safely'
        })
        result.validation.status = 'error'
      }
    }

    const installable =
      result.validation.status !== 'error' && !!root && !!result.manifest && !!treeSha256
    let confirmation: ModuleInstallState['confirmation']
    if (installable) {
      this.staged = {
        workDir: work,
        root: root!,
        archivePath,
        archiveSha256,
        treeSha256,
        manifest: result.manifest!,
        source,
        sourceUrl,
        catalogBinding: result.catalogBinding
      }
      confirmation = this.issueConfirmation(this.staged)
    } else {
      try {
        this.discardWorkspace()
      } catch (error) {
        return this.failState(
          error,
          'The rejected archive and its private staging area could not be removed',
          { validation: result.validation }
        )
      }
    }

    return this.setState({
      phase: installable ? 'ready' : 'error',
      confirmation,
      validation: result.validation,
      error: installable ? undefined : 'The archive did not pass every check'
    })
  }

  private async validate(
    root: string | null,
    trusted: boolean,
    sha256: string,
    sourceUrl: string | null,
    work: string
  ): Promise<{
    validation: ModuleValidation
    manifest: ModuleManifest | null
    catalogBinding: CatalogBinding | null
  }> {
    const checks: ModuleCheckItem[] = []
    const fail = (
      kind: ModuleInstallKind = 'new'
    ): {
      validation: ModuleValidation
      manifest: null
      catalogBinding: null
    } => ({
      validation: { status: 'error', kind, overwritesDefault: false, checks },
      manifest: null,
      catalogBinding: null
    })

    if (!root) {
      checks.push({
        id: 'archive',
        level: 'error',
        label: 'Archive contains a module folder',
        detail: `No ${MODULE_MANIFEST_FILE} was found in the archive or in its single top-level folder`
      })
      return fail()
    }
    checks.push({
      id: 'archive',
      level: 'pass',
      label: 'Archive contains a module folder',
      detail: basename(root)
    })

    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(join(root, MODULE_MANIFEST_FILE), 'utf8')) as unknown
    } catch (error) {
      checks.push({
        id: 'manifest',
        level: 'error',
        label: `${MODULE_MANIFEST_FILE} is readable`,
        detail:
          error instanceof SyntaxError
            ? redactPaths(error.message)
            : 'The manifest file could not be read'
      })
      if (!(error instanceof SyntaxError)) {
        log(`[module-installer] manifest read failed: ${internalErrorDetail(error)}`)
      }
      return fail()
    }
    checks.push({ id: 'manifest', level: 'pass', label: `${MODULE_MANIFEST_FILE} is readable` })

    let problems: string[]
    try {
      problems = manifestProblems(raw)
    } catch (error) {
      log(`[module-installer] manifest validator failed: ${internalErrorDetail(error)}`)
      checks.push({
        id: 'schema',
        level: 'error',
        label: 'Manifest matches the module schema',
        detail: 'Manifest validation failed safely; the archive was rejected'
      })
      return fail()
    }
    if (problems.length) {
      checks.push({
        id: 'schema',
        level: 'error',
        label: 'Manifest matches the module schema',
        detail: problems.join('; ')
      })
      return fail()
    }
    const manifest = raw as ModuleManifest
    checks.push({
      id: 'schema',
      level: 'pass',
      label: 'Manifest matches the module schema',
      detail: `${manifest.name} ${manifest.version} (id "${manifest.id}", API ${manifest.apiVersion})`
    })

    if (!isRegularFile(join(root, manifest.entries.main))) {
      checks.push({
        id: 'entries',
        level: 'error',
        label: 'Declared entry points exist',
        detail: `missing: ${manifest.entries.main}`
      })
      return fail()
    }
    checks.push({
      id: 'entries',
      level: 'pass',
      label: 'Declared entry points exist',
      detail: manifest.entries.main
    })

    const current = appVersion()
    if (manifest.minAppVersion && compareVersions(current, manifest.minAppVersion) < 0) {
      checks.push({
        id: 'appVersion',
        level: 'error',
        label: 'This app is new enough to run it',
        detail: `needs Bored Manager ${manifest.minAppVersion} or later, this is ${current}`
      })
      return fail()
    }
    checks.push({
      id: 'appVersion',
      level: 'pass',
      label: 'This app is new enough to run it',
      detail: manifest.minAppVersion ? `needs ${manifest.minAppVersion}, this is ${current}` : undefined
    })

    const missingSpecs: string[] = []
    for (const page of manifest.pages ?? []) {
      if (!isRegularFile(join(root, 'ui', 'pages', `${page.id}.json`))) {
        missingSpecs.push(`ui/pages/${page.id}.json`)
      }
    }
    for (const widget of manifest.widgets ?? []) {
      if (!isRegularFile(join(root, 'ui', 'widgets', `${widget.id}.json`))) {
        missingSpecs.push(`ui/widgets/${widget.id}.json`)
      }
    }
    if (missingSpecs.length) {
      checks.push({
        id: 'ui-specs',
        level: 'error',
        label: 'Every page and widget has a ui/ spec',
        detail: `missing: ${missingSpecs.join(', ')}`
      })
      return fail()
    }
    checks.push({ id: 'ui-specs', level: 'pass', label: 'Every page and widget has a ui/ spec' })

    const specFileProblems: string[] = []
    for (const kind of ['pages', 'widgets'] as const) {
      const dir = join(root, 'ui', kind)
      if (!existsSync(dir)) continue
      let files: string[]
      try {
        files = readdirSync(dir).filter((file) => file.endsWith('.json'))
      } catch (error) {
        log(`[module-installer] UI spec directory read failed: ${internalErrorDetail(error)}`)
        specFileProblems.push(`${kind}: directory could not be read`)
        continue
      }
      for (const file of files) {
        let specRaw: unknown
        try {
          specRaw = JSON.parse(readFileSync(join(dir, file), 'utf8')) as unknown
        } catch (error) {
          specFileProblems.push(
            `${kind}/${file}: ${
              error instanceof SyntaxError ? redactPaths(error.message) : 'file could not be read'
            }`
          )
          if (!(error instanceof SyntaxError)) {
            log(`[module-installer] UI spec read failed: ${internalErrorDetail(error)}`)
          }
          continue
        }
        try {
          const found = specProblems(specRaw, manifest)
          if (found.length) specFileProblems.push(`${kind}/${file}: ${found.join('; ')}`)
        } catch (error) {
          log(`[module-installer] UI spec validator failed: ${internalErrorDetail(error)}`)
          specFileProblems.push(`${kind}/${file}: validator rejected malformed data`)
        }
      }
    }
    if (specFileProblems.length) {
      checks.push({
        id: 'ui-spec-schema',
        level: 'error',
        label: 'ui/ specs match the block schema',
        detail: specFileProblems.join(' | ')
      })
      return fail()
    }
    checks.push({ id: 'ui-spec-schema', level: 'pass', label: 'ui/ specs match the block schema' })

    const compiledMain = join(work, '.dist', 'main.mjs')
    try {
      await compileModuleAt(root, compiledMain)
      checks.push({
        id: 'compile',
        level: 'pass',
        label: 'Main half compiles (only imports its own files and shared/)'
      })
    } catch (error) {
      checks.push({
        id: 'compile',
        level: 'error',
        label: 'Main half compiles (only imports its own files and shared/)',
        detail: diagnostic(error, 'The module did not compile', [root, work])
      })
      return fail()
    }

    try {
      const compiled = readFileSync(compiledMain, 'utf8')
      if (/https?:\/\//.test(compiled)) {
        const found = [...new Set(compiled.match(/https?:\/\/[^\s"'`)\]}>,;]+/g) ?? [])]
        checks.push({
          id: 'external-url-in-code',
          level: 'warning',
          label: 'Module code contains http(s) URLs - review before installing',
          detail: found.length ? found.slice(0, 8).join(', ') : undefined
        })
      }
    } catch (error) {
      log(`[module-installer] compiled output could not be inspected: ${internalErrorDetail(error)}`)
      checks.push({
        id: 'compiled-output',
        level: 'error',
        label: 'Compiled output can be inspected',
        detail: 'The compiler output could not be read back safely'
      })
      return fail()
    }

    if (!trusted) {
      checks.push({
        id: 'source',
        level: 'warning',
        label: 'Source of the archive',
        detail:
          'This archive does not come from GitHub or a local file you picked. A module runs with the same access to the target machine as the app itself - only install one you trust.'
      })
    }

    const installed = this.host.installed(manifest.id)
    const overwritesDefault = installed?.source === 'default'
    let kind: ModuleInstallKind = 'new'
    if (!installed) {
      checks.push({
        id: 'version',
        level: 'info',
        label: 'New module',
        detail: `${manifest.name} ${manifest.version} is not installed yet`
      })
    } else {
      const diff = compareVersions(manifest.version, installed.version)
      if (diff > 0) {
        kind = 'upgrade'
        checks.push({
          id: 'version',
          level: 'info',
          label: 'Update to a newer version',
          detail: `${installed.version} -> ${manifest.version}`
        })
      } else if (diff === 0) {
        kind = 'reinstall'
        checks.push({
          id: 'version',
          level: 'warning',
          label: 'Same version is already installed',
          detail: `version ${manifest.version} is installed; continuing overwrites it with this copy`
        })
      } else {
        kind = 'downgrade'
        checks.push({
          id: 'version',
          level: 'warning',
          label: 'This is older than what is installed',
          detail: `installed ${installed.version}, archive ${manifest.version}; continuing downgrades the module`
        })
      }
      if (overwritesDefault) {
        checks.push({
          id: 'default',
          level: 'warning',
          label: 'Overwrites a module that shipped with the app',
          detail:
            'The app will not be able to restore it: reinstalling means finding this zip again, or reinstalling the app.'
        })
      }
    }

    const docs = (['README.md', 'CHANGELOG.md'] as const).filter(
      (name) => !isRegularFile(join(root, name))
    )
    if (docs.length) {
      checks.push({
        id: 'docs',
        level: 'warning',
        label: 'Ships its own documentation',
        detail: `missing: ${docs.join(', ')} - the module works without them, but nothing describes what it does or what changed`
      })
    } else {
      checks.push({ id: 'docs', level: 'pass', label: 'Ships its own documentation' })
    }

    const catalogBinding = await this.catalogBindingFor(manifest, sha256, sourceUrl)
    if (catalogBinding) {
      checks.push({
        id: 'catalog-verified',
        level: 'pass',
        label: 'Listed in the verified community catalog',
        detail: `${manifest.name} ${manifest.version} - the fresh catalog URL and sha256 ${sha256} match exactly`
      })
    } else {
      checks.push({
        id: 'unverified-source',
        level: 'warning',
        label: 'Not a verified module',
        detail: `sha256 ${sha256} - no unique fresh catalog entry binds this exact module id, version, source URL and archive hash. Only install it if you trust this source.`
      })
    }

    return {
      validation: {
        status: statusOf(checks),
        kind,
        moduleId: manifest.id,
        moduleName: manifest.name,
        newVersion: manifest.version,
        installedVersion: installed?.version,
        overwritesDefault,
        checks
      },
      manifest,
      catalogBinding
    }
  }

  private async catalogBindingFor(
    manifest: ModuleManifest,
    sha256: string,
    sourceUrl: string | null
  ): Promise<CatalogBinding | null> {
    if (!sourceUrl) return null
    const repo = this.getRepo().trim()
    const catalog = await getCatalog(repo)
    if (!catalogIsFresh(catalog, repo)) return null
    const matches = exactCatalogMatches(
      catalog.entries,
      sourceUrl,
      manifest.id,
      manifest.version,
      sha256
    )
    if (matches.length !== 1) return null
    return {
      repo,
      sourceUrl,
      expectedId: manifest.id,
      expectedVersion: manifest.version,
      expectedSha256: sha256,
      fetchedAt: catalog.fetchedAt
    }
  }

  private async verifyCatalogBinding(staged: StagedModule): Promise<void> {
    const binding = staged.catalogBinding
    if (!binding) return
    if (this.getRepo().trim() !== binding.repo) {
      throw new PublicError(
        'MODULE_RECHECK_REQUIRED',
        'The configured catalog repository changed; check the module again',
        409
      )
    }
    const catalog = await getCatalog(binding.repo, true)
    if (!catalogIsFresh(catalog, binding.repo)) {
      throw new PublicError(
        'MODULE_RECHECK_REQUIRED',
        'The catalog could not be refreshed; check the module again before installing it as verified',
        409
      )
    }
    const matches = exactCatalogMatches(
      catalog.entries,
      binding.sourceUrl,
      binding.expectedId,
      binding.expectedVersion,
      binding.expectedSha256
    )
    if (matches.length !== 1) {
      throw new PublicError(
        'MODULE_RECHECK_REQUIRED',
        'The catalog entry changed or was removed; check the module again',
        409
      )
    }
  }

  private blockingTreeProblems(root: string): {
    manifest: ModuleManifest | null
    problems: string[]
  } {
    const problems: string[] = []
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(join(root, MODULE_MANIFEST_FILE), 'utf8')) as unknown
    } catch (error) {
      return {
        manifest: null,
        problems: [
          error instanceof SyntaxError ? `module.json: ${redactPaths(error.message)}` : 'module.json is unreadable'
        ]
      }
    }
    try {
      problems.push(...manifestProblems(raw))
    } catch (error) {
      log(`[module-installer] manifest revalidation failed: ${internalErrorDetail(error)}`)
      problems.push('manifest validator rejected malformed data')
    }
    if (problems.length) return { manifest: null, problems }
    const manifest = raw as ModuleManifest
    if (!isRegularFile(join(root, manifest.entries.main))) {
      problems.push(`missing: ${manifest.entries.main}`)
    }
    if (
      manifest.minAppVersion &&
      compareVersions(appVersion(), manifest.minAppVersion) < 0
    ) {
      problems.push(`this app is older than required ${manifest.minAppVersion}`)
    }
    for (const [kind, declarations] of [
      ['pages', manifest.pages ?? []],
      ['widgets', manifest.widgets ?? []]
    ] as const) {
      for (const declaration of declarations) {
        const path = join(root, 'ui', kind, `${declaration.id}.json`)
        if (!isRegularFile(path)) {
          problems.push(`missing: ui/${kind}/${declaration.id}.json`)
          continue
        }
        try {
          const spec = JSON.parse(readFileSync(path, 'utf8')) as unknown
          try {
            problems.push(
              ...specProblems(spec, manifest).map(
                (problem) => `ui/${kind}/${declaration.id}.json: ${problem}`
              )
            )
          } catch (error) {
            log(`[module-installer] spec revalidation failed: ${internalErrorDetail(error)}`)
            problems.push(`ui/${kind}/${declaration.id}.json: validator rejected malformed data`)
          }
        } catch (error) {
          problems.push(
            `ui/${kind}/${declaration.id}.json: ${
              error instanceof SyntaxError ? redactPaths(error.message) : 'file is unreadable'
            }`
          )
        }
      }
    }
    return { manifest, problems }
  }

  private revalidateStaged(staged: StagedModule, candidate: string): void {
    if (hashFile(staged.archivePath) !== staged.archiveSha256) {
      throw new PublicError(
        'MODULE_RECHECK_REQUIRED',
        'The inspected archive changed; check it again',
        409
      )
    }
    const stagedCheck = this.blockingTreeProblems(staged.root)
    const candidateCheck = this.blockingTreeProblems(candidate)
    const allProblems = [...stagedCheck.problems, ...candidateCheck.problems]
    if (allProblems.length) {
      throw new PublicError(
        'MODULE_RECHECK_REQUIRED',
        `The staged module no longer passes validation: ${allProblems[0]}`,
        409
      )
    }
    for (const manifest of [stagedCheck.manifest, candidateCheck.manifest]) {
      if (
        !manifest ||
        manifest.id !== staged.manifest.id ||
        manifest.version !== staged.manifest.version
      ) {
        throw new PublicError(
          'MODULE_RECHECK_REQUIRED',
          'The staged module identity changed; check it again',
          409
        )
      }
    }
    if (
      exactModuleTreeHash(staged.root) !== staged.treeSha256 ||
      exactModuleTreeHash(candidate) !== staged.treeSha256
    ) {
      throw new PublicError(
        'MODULE_RECHECK_REQUIRED',
        'The staged module files changed; check the archive again',
        409
      )
    }
  }

  // ---------- Transactions ----------

  private beginTransaction(
    operation: TransactionOperation,
    id: string,
    hadTarget: boolean
  ): ActiveTransaction {
    const transactionId = randomBytes(16).toString('hex')
    const journal: TransactionJournal = {
      version: TRANSACTION_VERSION,
      transactionId,
      operation,
      id,
      phase: 'preparing',
      hadTarget,
      registry: null,
      configPrimary: false,
      configBackup: false,
      moduleData: false
    }
    writeJournal(journal, 'preparing')
    return { journal, hostStopped: false }
  }

  private async stopAndSnapshot(transaction: ActiveTransaction): Promise<void> {
    const journal = transaction.journal
    await this.host.stop(journal.id)
    transaction.hostStopped = true
    journal.registry = cloneRegistry(this.host.moduleRegistrySnapshot())
    const config = moduleConfigPath(journal.id)
    journal.configPrimary = existsSync(config)
    journal.configBackup = existsSync(backupFile(config))
    journal.moduleData = existsSync(moduleDataPath(journal.id))
    writeJournal(journal, 'snapshotting')
    capturePersistentSnapshot(journal)
    assertSnapshotComplete(journal)
    writeJournal(journal, 'prepared')
  }

  private async rollbackTransaction(transaction: ActiveTransaction): Promise<void> {
    const journal = transaction.journal
    const mutated = phaseMayHaveMutatedState(journal.phase)
    if (mutated) {
      if (!journal.registry) throw new Error('transaction has no registry snapshot')
      await this.host.stop(journal.id)
      restoreModuleFolder(journal)
      restorePersistentFiles(journal)
      this.host.rescan(journal.id)
      this.host.restoreModuleRegistrySnapshot(cloneRegistry(journal.registry))
    }

    if (transaction.hostStopped && journal.hadTarget) {
      this.host.rescan(journal.id)
      const restored = await this.host.reload(journal.id)
      if (!restored.ok) throw new Error(`restored module did not reload: ${restored.error}`)
    } else if (!journal.hadTarget) {
      this.host.rescan(journal.id)
    }
    if (mutated) {
      writeJournal(journal, 'rolled-back')
      removeTransactionArtifacts(journal)
    } else {
      removeUntouchedTransaction(journal)
    }
    this.host.rescan(basename(candidateDir(journal.id, journal.transactionId)))
    this.host.rescan(basename(backupDir(journal.id, journal.transactionId)))
  }

  private notifyListChanged(): void {
    try {
      this.onListChanged()
    } catch (error) {
      log(`[module-installer] module-list notification failed: ${internalErrorDetail(error)}`)
    }
  }

  private issueConfirmation(staged: StagedModule): NonNullable<ModuleInstallState['confirmation']> {
    const token = randomBytes(32).toString('base64url')
    const expiresAt = Date.now() + CONFIRMATION_TTL_MS
    this.confirmation = {
      tokenHash: createHash('sha256').update(token).digest(),
      expiresAt,
      runId: this.runId,
      treeSha256: staged.treeSha256,
      moduleId: staged.manifest.id,
      consumed: false
    }
    return { token, expiresAt }
  }

  private consumeConfirmation(
    token: unknown,
    staged: StagedModule
  ): { error: string; invalidate: boolean } | null {
    const confirmation = this.confirmation
    if (!confirmation || confirmation.consumed) {
      return { error: 'Check the module again to obtain a fresh install confirmation', invalidate: true }
    }
    if (Date.now() > confirmation.expiresAt) {
      this.confirmation = null
      return { error: 'The install confirmation expired; check the module again', invalidate: true }
    }
    if (typeof token !== 'string' || token.length < 32 || token.length > 128) {
      return { error: 'A valid install confirmation token is required', invalidate: false }
    }
    const suppliedHash = createHash('sha256').update(token).digest()
    if (!timingSafeEqual(suppliedHash, confirmation.tokenHash)) {
      return {
        error: 'The install confirmation does not match this checked module',
        invalidate: false
      }
    }
    if (
      confirmation.runId !== this.runId ||
      confirmation.moduleId !== staged.manifest.id ||
      confirmation.treeSha256 !== staged.treeSha256
    ) {
      this.confirmation = null
      return { error: 'The checked module changed; check it again', invalidate: true }
    }
    try {
      if (exactModuleTreeHash(staged.root) !== confirmation.treeSha256) {
        this.confirmation = null
        return { error: 'The staged module changed; check it again', invalidate: true }
      }
    } catch {
      this.confirmation = null
      return { error: 'The staged module is no longer readable; check it again', invalidate: true }
    }
    confirmation.consumed = true
    return null
  }

  // ---------- Apply ----------

  async install(token: unknown): Promise<ModuleInstallState> {
    const staged = this.staged
    if (this.state.phase !== 'ready' || !staged) {
      return this.setState({ error: 'No inspected module is ready to install' })
    }
    if (this.hasPendingTransaction()) {
      return this.setState({
        phase: 'error',
        error: 'An interrupted module operation must be recovered before another can start'
      })
    }
    const confirmationProblem = this.consumeConfirmation(token, staged)
    if (confirmationProblem) {
      if (confirmationProblem.invalidate) {
        return this.setState({
          phase: 'error',
          confirmation: undefined,
          error: confirmationProblem.error
        })
      }
      return this.setState({ error: confirmationProblem.error })
    }

    const id = staged.manifest.id
    const version = staged.manifest.version
    const target = moduleDir(id)
    const hadPrevious = existsSync(target)
    let transaction: ActiveTransaction | null = null
    let activationFailure: ActivationFailure | null = null

    this.setState({ phase: 'installing', error: undefined, log: [] })
    try {
      mkdirSync(modulesDir(), { recursive: true })
      transaction = this.beginTransaction('install', id, hadPrevious)
      const candidate = candidateDir(id, transaction.journal.transactionId)
      cpSync(staged.root, candidate, {
        recursive: true,
        errorOnExist: true,
        force: false
      })
      if (exactModuleTreeHash(candidate) !== staged.treeSha256) {
        throw new PublicError(
          'MODULE_RECHECK_REQUIRED',
          'The candidate copy does not match the inspected module; check it again',
          409
        )
      }

      this.setState({ phase: 'building', log: [`compiling ${id}@${version} candidate ...`] })
      try {
        await compileModuleAt(candidate, join(candidate, '.dist', 'main.mjs'))
      } catch (error) {
        throw new PublicError(
          'MODULE_BUILD_FAILED',
          `The staged module could not be built again: ${diagnostic(
            error,
            'compilation failed',
            [candidate, staged.workDir]
          )}`,
          400
        )
      }

      // Refresh the exact catalog binding after the potentially slow build,
      // while the old module is still running.
      await this.verifyCatalogBinding(staged)
      await this.stopAndSnapshot(transaction)

      // Last operation before the journalled renames: prove both the immutable
      // staging tree and the built sibling candidate are still the checked bytes.
      this.revalidateStaged(staged, candidate)

      const journal = transaction.journal
      const backup = backupDir(id, journal.transactionId)
      writeJournal(journal, 'moving-target')
      if (hadPrevious) renameSync(target, backup)

      writeJournal(journal, 'promoting-candidate')
      renameSync(candidate, target)

      writeJournal(journal, 'updating-state')
      this.host.rescan(id)
      this.host.record(id, version, moduleFolderHash(target), staged.source)
      const built = await this.host.reload(id)
      if (!built.ok) {
        log(`[module-installer] candidate activation failed: ${built.error}`)
        activationFailure = new ActivationFailure(
          redactPaths(built.error, [target, staged.workDir])
        )
        throw activationFailure
      }
      writeJournal(journal, 'committed')
    } catch (error) {
      let rollbackError: unknown = null
      if (transaction) {
        try {
          await this.rollbackTransaction(transaction)
        } catch (caught) {
          rollbackError = caught
          log(`[module-installer] transaction rollback failed: ${internalErrorDetail(caught)}`)
        }
      }
      try {
        this.discardWorkspace()
      } catch (caught) {
        rollbackError ??= caught
        log(`[module-installer] staging cleanup after failure failed: ${internalErrorDetail(caught)}`)
      }
      this.staged = null
      this.notifyListChanged()
      if (rollbackError) {
        return this.failState(
          rollbackError,
          'The module operation failed and automatic recovery could not be completed; restart the app to retry recovery',
          { log: activationFailure ? this.tailLog(activationFailure.compilerLog) : undefined }
        )
      }
      if (activationFailure) {
        return this.setState({
          phase: 'error',
          error: hadPrevious
            ? 'The candidate could not start; the previous module and all of its state were restored'
            : 'The candidate could not start; no module or module-owned state was installed',
          log: this.tailLog(activationFailure.compilerLog)
        })
      }
      const safe = publicFailure(error, 'The module could not be installed; the previous state was restored')
      return this.setState({ phase: 'error', error: safe.message })
    }

    const journal = transaction.journal
    try {
      removeTransactionArtifacts(journal)
      this.discardWorkspace()
    } catch (error) {
      this.staged = null
      this.notifyListChanged()
      return this.failState(
        error,
        'The module was installed, but transaction cleanup did not complete; restart the app to finish recovery'
      )
    }

    this.notifyListChanged()
    return this.setState({
      phase: 'done',
      error: undefined,
      progress: undefined,
      validation: undefined,
      log: this.tailLog(`${id}@${version} compiled and running - no restart needed.`)
    })
  }

  async uninstall(id: string): Promise<ModuleInstallState> {
    if (this.busy()) return this.setState({ error: 'Another module operation is running' })
    if (this.hasPendingTransaction()) {
      return this.setState({
        phase: 'error',
        error: 'An interrupted module operation must be recovered before another can start'
      })
    }
    if (!this.host.installed(id)) {
      return this.setState({ phase: 'error', error: `Module "${id}" is not installed` })
    }
    let target: string
    try {
      target = moduleDir(id)
    } catch (error) {
      return this.failState(error, 'The module id is not valid')
    }
    if (!existsSync(target)) {
      return this.setState({ phase: 'error', error: `Module "${id}" is not installed` })
    }
    try {
      this.discardWorkspace()
    } catch (error) {
      return this.failState(error, 'The previous private staging area could not be removed')
    }

    this.setState({
      phase: 'installing',
      source: id,
      error: undefined,
      validation: undefined,
      log: []
    })
    let transaction: ActiveTransaction | null = null
    try {
      transaction = this.beginTransaction('uninstall', id, true)
      await this.stopAndSnapshot(transaction)
      const journal = transaction.journal
      const backup = backupDir(id, journal.transactionId)

      writeJournal(journal, 'moving-target')
      renameSync(target, backup)

      writeJournal(journal, 'updating-state')
      deleteModuleConfig(id)
      deleteModuleData(id)
      await this.host.forget(id)
      writeJournal(journal, 'committed')
    } catch (error) {
      let rollbackError: unknown = null
      if (transaction) {
        try {
          await this.rollbackTransaction(transaction)
        } catch (caught) {
          rollbackError = caught
          log(`[module-installer] uninstall rollback failed: ${internalErrorDetail(caught)}`)
        }
      }
      this.notifyListChanged()
      if (rollbackError) {
        return this.failState(
          rollbackError,
          'The uninstall failed and automatic recovery could not be completed; restart the app to retry recovery'
        )
      }
      const safe = publicFailure(error, 'The module could not be removed; its previous state was restored')
      return this.setState({ phase: 'error', error: safe.message })
    }

    try {
      removeTransactionArtifacts(transaction.journal)
    } catch (error) {
      this.notifyListChanged()
      return this.failState(
        error,
        'The module was removed, but transaction cleanup did not complete; restart the app to finish recovery'
      )
    }
    this.notifyListChanged()
    return this.setState({ phase: 'done', error: undefined, source: id })
  }

  /** Throw away downloaded/extracted staging. An install transaction cannot be cancelled mid-swap. */
  cancel(): ModuleInstallState {
    if (this.state.phase === 'installing' || this.state.phase === 'building') return this.state
    this.runId++
    this.transfer?.abort()
    this.transfer = null
    try {
      this.discardWorkspace()
    } catch (error) {
      return this.failState(
        error,
        'The private staging area could not be removed; retry discard after the transfer stops'
      )
    }
    return this.setState({
      phase: 'idle',
      source: undefined,
      progress: undefined,
      validation: undefined,
      log: undefined,
      error: undefined
    })
  }

  private tailLog(text: string): string[] {
    const lines = text.split(/\r?\n/).filter((line) => line.trim())
    return lines.length > MAX_LOG_LINES ? lines.slice(-MAX_LOG_LINES) : lines
  }
}
