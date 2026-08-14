import { createHash } from 'crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type {
  ModuleCheckItem,
  ModuleInstallKind,
  ModuleInstallState,
  ModuleSource,
  ModuleValidation
} from '@shared/modules'
import {
  MODULE_ARCHIVE_MAX_BYTES,
  MODULE_DOWNLOAD_TIMEOUT_MS,
  MODULE_MANIFEST_FILE,
  compareVersions,
  manifestProblems
} from '@shared/modules'
import type { ModuleManifest } from '@shared/modules'
import { specProblems } from '@shared/module-ui'
import { extractZip } from './zip'
import { downloadFile, findArchiveRoot, type DownloadHandle } from './download'
import { compileModuleAt } from './module-compiler'
import { defaultBranchZipUrl, latestReleaseZip, looksLikeZipUrl, parseGithubRepo } from './github'
import type { ModulesHost } from './modules-host'
import { moduleFolderHash, modulesDir, moduleDir } from './modules-host'
import { getCatalog } from './registry'
import { appVersion, deleteModuleConfig, deleteModuleData } from './store'

/**
 * Installing, updating and removing a module.
 *
 * A module is a folder the host reads and compiles at runtime (see
 * modules-host.ts / module-compiler.ts), so putting one in place never
 * touches the app's own bundle: write the folder, compile its main half with
 * esbuild, (re)activate it. The compile is the part that can fail (a type
 * error, a disallowed import), so the previous folder is backed up first and
 * put back when it does not succeed - a bad module can never leave a working
 * install broken, and nothing here ever asks for a restart.
 *
 * Nothing is decided silently: the archive is graded against the rule set and
 * the verdict goes to the UI, which only calls install() once the user has seen
 * it (and confirmed, when overwriting).
 */

/** Anything not on GitHub is accepted but flagged - see the `source` check. */
const TRUSTED_HOSTS = [
  'github.com',
  'www.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com'
]

/** How much of the compile output is kept for the UI's log panel. */
const MAX_LOG_LINES = 400

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function normalizeUrl(raw: string): { value: string; trusted: boolean } | { error: string } {
  const trimmed = raw.trim()
  if (!trimmed) return { error: 'Paste a module .zip URL, an owner/repo, or a GitHub repo URL first' }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { error: `"${trimmed}" is not a valid URL` }
  }
  if (url.protocol !== 'https:') {
    return { error: `Only https:// links are accepted (got ${url.protocol}//)` }
  }
  if (!looksLikeZipUrl(url)) {
    return { error: 'The link must point directly at a .zip archive' }
  }
  return { value: url.toString(), trusted: TRUSTED_HOSTS.includes(url.hostname) }
}

/** The worst level present decides whether installing is allowed at all. */
function statusOf(checks: ModuleCheckItem[]): ModuleValidation['status'] {
  if (checks.some((c) => c.level === 'error')) return 'error'
  if (checks.some((c) => c.level === 'warning')) return 'warning'
  return 'pass'
}

export class ModuleInstallerService {
  private state: ModuleInstallState = { phase: 'idle' }
  private transfer: DownloadHandle | null = null
  /** Root of the extracted module folder, set once it passed validation. */
  private stagedRoot: string | null = null
  private stagedManifest: ModuleManifest | null = null
  private stagedSource: ModuleSource = 'zip'
  /** Bumped by cancel(), so an aborted check stops reporting into the state. */
  private runId = 0

  constructor(
    private readonly host: ModulesHost,
    private readonly onState: (s: ModuleInstallState) => void,
    private readonly onListChanged: () => void,
    /** `settings.update.repo`, read lazily so a change takes effect immediately. */
    private readonly getRepo: () => string
  ) {}

  getState(): ModuleInstallState {
    return this.state
  }

  private setState(patch: Partial<ModuleInstallState>): ModuleInstallState {
    this.state = { ...this.state, ...patch }
    this.onState(this.state)
    return this.state
  }

  private workDir(): string {
    return join(tmpdir(), 'bored-manager-module')
  }

  private busy(): boolean {
    return ['downloading', 'extracting', 'validating', 'installing', 'building'].includes(
      this.state.phase
    )
  }

  // ---------- Inspect ----------

  /**
   * Download an archive and grade it. Nothing is written to the app folder.
   * `rawUrl` may be a direct `.zip` link, `owner/repo`, or a GitHub repo URL -
   * the latter two are resolved to the latest release's zip (or, lacking a
   * release, the default branch's source zip) before anything downloads.
   */
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

    this.reset()
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
        const release = await latestReleaseZip(repo)
        resolvedUrl = release?.url ?? (await defaultBranchZipUrl(repo))
      } catch (err) {
        if (runId !== this.runId) return this.state
        return this.setState({ phase: 'error', error: `Could not resolve ${repo} on GitHub: ${message(err)}` })
      }
      if (runId !== this.runId) return this.state
    }

    const url = normalizeUrl(resolvedUrl)
    if ('error' in url) {
      return this.setState({ phase: 'error', error: url.error, validation: undefined })
    }

    const work = this.workDir()
    const zipPath = join(work, 'module.zip')
    this.setState({
      phase: 'downloading',
      source: url.value,
      error: undefined,
      validation: undefined,
      log: undefined,
      progress: { receivedBytes: 0, totalBytes: null }
    })

    try {
      mkdirSync(work, { recursive: true })
      const transfer = downloadFile(url.value, zipPath, {
        maxBytes: MODULE_ARCHIVE_MAX_BYTES,
        timeoutMs: MODULE_DOWNLOAD_TIMEOUT_MS,
        onProgress: (receivedBytes, totalBytes) =>
          this.setState({ progress: { receivedBytes, totalBytes } })
      })
      this.transfer = transfer
      await transfer.done
    } catch (err) {
      if (runId !== this.runId) return this.state
      this.cleanWorkDir()
      return this.setState({ phase: 'error', error: `Download failed: ${message(err)}` })
    } finally {
      this.transfer = null
    }
    if (runId !== this.runId) return this.state
    return this.inspect(zipPath, runId, 'url', url.trusted)
  }

  /** Grade a zip the user picked from disk. */
  async checkFile(path: string): Promise<ModuleInstallState> {
    if (this.busy()) return this.setState({ error: 'Another module operation is running' })
    this.reset()
    const runId = ++this.runId
    this.setState({
      phase: 'extracting',
      source: path,
      error: undefined,
      validation: undefined,
      log: undefined,
      progress: undefined
    })
    if (!existsSync(path)) {
      return this.setState({ phase: 'error', error: `${path} does not exist` })
    }
    return this.inspect(path, runId, 'zip', true)
  }

  private async inspect(
    zipPath: string,
    runId: number,
    source: ModuleSource,
    trusted: boolean
  ): Promise<ModuleInstallState> {
    const stagingDir = join(this.workDir(), 'staging')
    this.setState({ phase: 'extracting' })
    // Hashes the archive as downloaded/uploaded, before it is unpacked - this
    // is what a registry entry's sha256 is computed from (see registry.ts).
    const sha256 = this.hashArchive(zipPath)
    let root: string | null = null
    try {
      mkdirSync(this.workDir(), { recursive: true })
      rmSync(stagingDir, { recursive: true, force: true })
      await extractZip(zipPath, stagingDir)
      root = findArchiveRoot(stagingDir, MODULE_MANIFEST_FILE)
    } catch (err) {
      if (runId !== this.runId) return this.state
      return this.setState({
        phase: 'error',
        error: `The file is not a readable zip archive: ${message(err)}`
      })
    }
    if (runId !== this.runId) return this.state

    this.setState({ phase: 'validating' })
    const { validation, manifest } = await this.validate(root, trusted, sha256)
    if (runId !== this.runId) return this.state
    const installable = validation.status !== 'error'
    this.stagedRoot = installable ? root : null
    this.stagedManifest = installable ? manifest : null
    this.stagedSource = source
    return this.setState({
      phase: installable ? 'ready' : 'error',
      validation,
      error: installable ? undefined : 'The archive did not pass every check'
    })
  }

  /** SHA-256 of the archive file itself, hex-encoded; '' when it cannot be read. */
  private hashArchive(path: string): string {
    try {
      return createHash('sha256').update(readFileSync(path)).digest('hex')
    } catch {
      return ''
    }
  }

  /**
   * The rule set, in the order a reader would want it: is this an archive, is
   * it a module, can this app run it, does its declarative UI check out, and
   * what would installing it replace.
   */
  private async validate(
    root: string | null,
    trusted: boolean,
    sha256: string
  ): Promise<{ validation: ModuleValidation; manifest: ModuleManifest | null }> {
    const checks: ModuleCheckItem[] = []
    const fail = (kind: ModuleInstallKind = 'new'): { validation: ModuleValidation; manifest: null } => ({
      validation: { status: 'error', kind, overwritesDefault: false, checks },
      manifest: null
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
      detail: root.split(/[\\/]/).pop()
    })

    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(join(root, MODULE_MANIFEST_FILE), 'utf8'))
    } catch (err) {
      checks.push({
        id: 'manifest',
        level: 'error',
        label: `${MODULE_MANIFEST_FILE} is readable`,
        detail: message(err)
      })
      return fail()
    }
    checks.push({ id: 'manifest', level: 'pass', label: `${MODULE_MANIFEST_FILE} is readable` })

    const problems = manifestProblems(raw)
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

    // The declared entry point has to be in the archive, or the module loads
    // into nothing and silently does not exist once installed.
    if (!existsSync(join(root, manifest.entries.main))) {
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

    // Every declared page/widget needs a ui/*.json spec - manifestProblems()
    // already rejected `entries.renderer` above, so there is no transitional
    // fallback left to check for.
    const missingSpecs: string[] = []
    for (const page of manifest.pages ?? []) {
      if (!existsSync(join(root, 'ui', 'pages', `${page.id}.json`))) {
        missingSpecs.push(`ui/pages/${page.id}.json`)
      }
    }
    for (const widget of manifest.widgets ?? []) {
      if (!existsSync(join(root, 'ui', 'widgets', `${widget.id}.json`))) {
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
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
        let specRaw: unknown
        try {
          specRaw = JSON.parse(readFileSync(join(dir, file), 'utf8'))
        } catch (err) {
          specFileProblems.push(`${kind}/${file}: not valid JSON (${message(err)})`)
          continue
        }
        const found = specProblems(specRaw, manifest)
        if (found.length) specFileProblems.push(`${kind}/${file}: ${found.join('; ')}`)
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

    // Trial-compile in place (a throwaway output, nothing under modules/ is
    // touched yet) so a disallowed import shows up here, not after install.
    // The host writes the same bytes to modules/<id>/.dist/main.mjs on install.
    const compiledMain = join(this.workDir(), '.dist', 'main.mjs')
    try {
      await compileModuleAt(root, compiledMain)
      checks.push({
        id: 'compile',
        level: 'pass',
        label: 'Main half compiles (only imports its own files and shared/)'
      })
    } catch (err) {
      checks.push({
        id: 'compile',
        level: 'error',
        label: 'Main half compiles (only imports its own files and shared/)',
        detail: message(err)
      })
      return fail()
    }

    // Spec already rejects http(s) as an error (specProblems). A URL that
    // only exists in compiled main is a warning so the user can still
    // install a module they trust after reading the list.
    try {
      const compiled = readFileSync(compiledMain, 'utf8')
      if (/https?:\/\//.test(compiled)) {
        const found = [...new Set(compiled.match(/https?:\/\/[^\s"'`)\]}>,;]+/g) ?? [])]
        checks.push({
          id: 'external-url-in-code',
          level: 'warning',
          label: 'Code module chứa URL http(s) — xem lại trước khi cài',
          detail: found.length ? found.slice(0, 8).join(', ') : undefined
        })
      }
    } catch {
      /* compile succeeded; a missing outfile is not a separate failure */
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

    // What installing it would do to the current install.
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
      (name) => !existsSync(join(root, name))
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

    // Independent of the 'source' host check above: a file picked from disk
    // or a URL on an untrusted host can still be a byte-for-byte copy of a
    // reviewed release, and a github.com link is not automatically the
    // reviewed version of that module.
    const catalog = await getCatalog(this.getRepo())
    const catalogEntry = catalog.entries.find((e) => e.id === manifest.id)
    if (catalogEntry && sha256 && catalogEntry.sha256 === sha256) {
      checks.push({
        id: 'catalog-verified',
        level: 'pass',
        label: 'Listed in the verified community catalog',
        detail: `${catalogEntry.name} ${catalogEntry.version} - sha256 ${sha256} matches the verified entry`
      })
    } else {
      checks.push({
        id: 'unverified-source',
        level: 'warning',
        label: 'Not a verified module',
        detail: `sha256 ${sha256 || '(unreadable)'} - not in the community catalog of verified modules, or the hash does not match the verified entry. Only install it if you trust this source.`
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
      manifest
    }
  }

  // ---------- Apply ----------

  /**
   * Put the inspected module in place and compile it. On failure everything is
   * restored - the module folder as it was and the previous compiled output -
   * so the app the user is looking at is the one they had; nothing here ever
   * asks for a restart.
   */
  async install(): Promise<ModuleInstallState> {
    if (this.state.phase !== 'ready' || !this.stagedRoot || !this.stagedManifest) {
      return this.setState({ error: 'No inspected module is ready to install' })
    }

    const id = this.stagedManifest.id
    const version = this.stagedManifest.version
    const target = moduleDir(id)
    const backup = `${target}.backup-${Date.now()}`
    const hadPrevious = existsSync(target)
    const previousState = this.host.installed(id)

    this.setState({ phase: 'installing', error: undefined, log: [] })
    mkdirSync(modulesDir(), { recursive: true })

    // Moved aside before anything is written, so a failure here never
    // touches the current install - there is nothing yet to roll back. The
    // version being replaced is stopped first: it would otherwise go on
    // polling the target machine out of a folder that is being renamed under
    // it, and the rollback path re-activates it either way.
    if (hadPrevious) {
      this.host.stop(id)
      try {
        renameSync(target, backup)
      } catch (err) {
        // Its folder never moved, so the version that was running is intact -
        // start it again rather than leaving the user with a module that is
        // installed, enabled and silent until the next settings change.
        await this.host.reload(id).catch(() => undefined)
        return this.setState({
          phase: 'error',
          error: `Could not write the module: the current install could not be moved aside (${message(err)})`
        })
      }
    }

    try {
      cpSync(this.stagedRoot, target, { recursive: true })
    } catch (err) {
      // The backup (if any) was already made; put it back exactly as it was.
      try {
        rmSync(target, { recursive: true, force: true })
        if (hadPrevious) {
          renameSync(backup, target)
          await this.host.reload(id).catch(() => undefined)
        }
      } catch {
        /* reported below */
      }
      return this.setState({ phase: 'error', error: `Could not write the module: ${message(err)}` })
    }

    this.setState({ phase: 'building', log: [`compiling ${id}@${version} ...`] })
    this.host.rescan(id)
    this.host.record(id, version, moduleFolderHash(target), this.stagedSource)
    const built = await this.host.reload(id)

    if (!built.ok) {
      try {
        rmSync(target, { recursive: true, force: true })
        if (hadPrevious) {
          renameSync(backup, target)
          this.host.rescan(id)
          if (previousState) {
            this.host.record(id, previousState.version, previousState.hash, previousState.source)
          }
          await this.host.reload(id).catch(() => undefined)
        } else {
          this.host.forget(id)
        }
      } catch (err) {
        return this.setState({
          phase: 'error',
          error: `Compiling failed AND the previous module could not be restored (${message(err)}). The folder ${backup} still holds it.`,
          log: this.tailLog(built.error)
        })
      }
      this.onListChanged()
      return this.setState({
        phase: 'error',
        error: hadPrevious
          ? `Compiling this module failed - the previous version is back in place and running.`
          : `Compiling this module failed - nothing was installed.`,
        log: this.tailLog(built.error)
      })
    }

    try {
      rmSync(backup, { recursive: true, force: true })
    } catch {
      /* a leftover backup folder is harmless */
    }
    this.onListChanged()
    this.cleanWorkDir()
    this.stagedRoot = null
    this.stagedManifest = null
    return this.setState({
      phase: 'done',
      error: undefined,
      progress: undefined,
      log: this.tailLog(`${id}@${version} compiled and running - no restart needed.`)
    })
  }

  /**
   * Remove a module's folder, and with it the two stores only that module
   * could read - its own settings and what it remembered about each machine.
   * Leaving those behind would be unreachable bytes, since nothing else knows
   * their shape.
   *
   * What is deliberately kept: the keys in the app's own `settings.json`
   * (`refresh.<id>`, the `overviewWidgets` flags and their grid positions), so
   * reinstalling later puts the widgets back where they were; and the metrics
   * history, which is per machine and expires on its own retention.
   *
   * An update does not come through here - install() swaps the folder in
   * place - so upgrading a module keeps everything it had.
   */
  async uninstall(id: string): Promise<ModuleInstallState> {
    if (this.busy()) return this.setState({ error: 'Another module operation is running' })
    // The id arrives from a browser and ends up in a recursive delete, so it
    // is not enough for the path to look right: it has to name a module the
    // host actually has. `moduleDir` refuses a traversal in any case, but a
    // folder under `modules/` that is not a module is not ours to remove.
    if (!this.host.installed(id)) {
      return this.setState({ phase: 'error', error: `Module "${id}" is not installed` })
    }
    let target: string
    try {
      target = moduleDir(id)
    } catch (err) {
      return this.setState({ phase: 'error', error: message(err) })
    }
    if (!existsSync(target)) {
      return this.setState({ phase: 'error', error: `Module "${id}" is not installed` })
    }

    this.setState({
      phase: 'installing',
      source: id,
      error: undefined,
      validation: undefined,
      log: []
    })
    // Stopped before a single file goes: deactivating unregisters its RPC
    // channels, revokes its context and kills anything it left running, so
    // there is no tick that can arrive halfway through the delete and no
    // chance of it writing its config back after the next two lines.
    this.host.stop(id)
    try {
      rmSync(target, { recursive: true, force: true })
    } catch (err) {
      return this.setState({ phase: 'error', error: `Could not remove the module: ${message(err)}` })
    }
    try {
      deleteModuleConfig(id)
      deleteModuleData(id)
    } catch {
      // The module is already gone; a leftover file it can no longer reach is
      // not worth failing the uninstall over.
    }
    this.host.forget(id)
    this.onListChanged()
    return this.setState({ phase: 'done', error: undefined })
  }

  /** Throw away whatever was downloaded and go back to the starting point. */
  cancel(): ModuleInstallState {
    if (this.state.phase === 'installing' || this.state.phase === 'building') return this.state
    this.runId++
    this.transfer?.abort()
    this.transfer = null
    this.reset()
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
    const lines = text.split(/\r?\n/).filter((l) => l.trim())
    return lines.length > MAX_LOG_LINES ? lines.slice(-MAX_LOG_LINES) : lines
  }

  private reset(): void {
    this.cleanWorkDir()
    this.stagedRoot = null
    this.stagedManifest = null
  }

  private cleanWorkDir(): void {
    try {
      rmSync(this.workDir(), { recursive: true, force: true })
    } catch {
      /* a leftover temp folder is harmless */
    }
  }
}
