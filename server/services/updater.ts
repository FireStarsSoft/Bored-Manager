import { spawn } from 'child_process'
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { extractZip } from './zip'
import { downloadFile, findArchiveRoot, type DownloadHandle } from './download'
import { defaultBranchZipUrl, isGithubRepoName, latestReleaseZip, looksLikeZipUrl } from './github'
import type {
  OkResult,
  UpdateCheckItem,
  UpdateRepoInfo,
  UpdateResult,
  UpdateState,
  UpdateValidation
} from '@shared/types'
import { DEFAULT_UPDATE_REPO } from '@shared/types'
import { compareVersions } from '@shared/modules'
import { appRoot, appVersion, dataDir } from './store'

/**
 * In-app updater for the portable install.
 *
 * The app is distributed as a source folder, so an update is "replace every
 * file except the saved connections, then reinstall dependencies and rebuild".
 * That cannot happen from inside the running app (it would delete its own
 * code), so this service only downloads and inspects the archive; the actual
 * swap is done by scripts/update.sh after the server has quit.
 *
 * Everything is staged in the system temp folder, never inside the app folder,
 * because the app folder is about to be moved away wholesale.
 */

/** Hosts a GitHub release/source zip is served from (incl. redirect targets). */
const ALLOWED_HOSTS = [
  'github.com',
  'www.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com'
]

const MAX_ARCHIVE_BYTES = 300 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000

/**
 * Files and folders a usable Bored Manager source tree cannot be missing. Kept
 * in step with REQUIRED_ENTRIES in scripts/package.sh, so an archive built by
 * that always passes this check.
 */
const REQUIRED_ENTRIES: Array<{ path: string; dir?: boolean }> = [
  { path: 'package.json' },
  { path: 'package-lock.json' },
  { path: 'vite.config.ts' },
  { path: 'vite.config.server.ts' },
  { path: 'server/index.ts' },
  { path: 'server/ipc.ts' },
  { path: 'shared/types.ts' },
  { path: 'shared/modules.ts' },
  { path: 'src', dir: true },
  { path: 'src/index.html' },
  { path: 'modules', dir: true },
  { path: 'assets/icon.png' },
  { path: 'run.sh' },
  { path: 'install.sh' },
  { path: 'bored-manager' }
]

interface PackageManifest {
  name?: string
  version?: string
  scripts?: Record<string, string>
  devDependencies?: Record<string, string>
}

export class UpdaterService {
  private state: UpdateState = { phase: 'idle', currentVersion: currentVersion() }
  private transfer: DownloadHandle | null = null
  /** root of the extracted tree (the folder holding package.json) */
  private stagedRoot: string | null = null
  /** bumped by cancel(), so an aborted check stops reporting into the state */
  private runId = 0

  constructor(private readonly onState: (s: UpdateState) => void) {}

  getState(): UpdateState {
    return this.state
  }

  private setState(patch: Partial<UpdateState>): UpdateState {
    this.state = { ...this.state, ...patch, currentVersion: currentVersion() }
    this.onState(this.state)
    return this.state
  }

  private workDir(): string {
    return join(tmpdir(), 'bored-manager-update')
  }

  /** Download the archive, unpack it and report what it contains. */
  async check(rawUrl: string): Promise<UpdateState> {
    if (this.state.phase === 'applying') return this.state
    if (this.state.phase === 'downloading' || this.state.phase === 'extracting') {
      return this.setState({ error: 'A download is already running' })
    }

    const url = normalizeUrl(rawUrl)
    if ('error' in url) {
      return this.setState({ phase: 'error', error: url.error, validation: undefined })
    }

    this.cleanWorkDir()
    this.stagedRoot = null
    const runId = ++this.runId
    const work = this.workDir()
    const zipPath = join(work, 'update.zip')
    this.setState({
      phase: 'downloading',
      url: url.value,
      error: undefined,
      validation: undefined,
      progress: { receivedBytes: 0, totalBytes: null }
    })

    try {
      mkdirSync(work, { recursive: true })
      await this.download(url.value, zipPath)
    } catch (err) {
      if (runId !== this.runId) return this.state // cancelled while downloading
      this.cleanWorkDir()
      return this.setState({ phase: 'error', error: `Download failed: ${message(err)}` })
    }
    if (runId !== this.runId) return this.state

    this.setState({ phase: 'extracting' })
    return this.inspectArchive(zipPath, url.value, runId)
  }

  /**
   * Grade a zip the browser uploaded. Same checks as `check()`, without the
   * download — the file is already on disk.
   */
  async checkFile(zipPath: string): Promise<UpdateState> {
    if (this.state.phase === 'applying') return this.state
    if (this.state.phase === 'downloading' || this.state.phase === 'extracting') {
      return this.setState({ error: 'A download is already running' })
    }
    if (!existsSync(zipPath)) {
      return this.setState({ phase: 'error', error: 'The uploaded file was not saved' })
    }

    this.cleanWorkDir()
    this.stagedRoot = null
    const runId = ++this.runId
    const work = this.workDir()
    const copied = join(work, 'update.zip')
    mkdirSync(work, { recursive: true })
    try {
      copyFileSync(zipPath, copied)
    } catch (err) {
      return this.setState({ phase: 'error', error: `Could not keep the upload: ${message(err)}` })
    }
    this.setState({
      phase: 'extracting',
      url: 'upload',
      error: undefined,
      validation: undefined,
      progress: undefined
    })
    return this.inspectArchive(copied, 'upload', runId)
  }

  /**
   * Look up the latest GitHub release for `settings.update.repo`. A missing
   * release is not an error: the UI can fall back to the default branch zip.
   */
  async checkRepo(repo = DEFAULT_UPDATE_REPO): Promise<UpdateRepoInfo> {
    const current = currentVersion()
    const name = repo.trim() || DEFAULT_UPDATE_REPO
    if (!isGithubRepoName(name)) throw new Error(`"${name}" is not a GitHub owner/repo`)
    const fallbackUrl = await defaultBranchZipUrl(name)
    const release = await latestReleaseZip(name, (assetName) => /^bored-manager-.*\.zip$/i.test(assetName))
    if (!release) return { currentVersion: current, latestVersion: null, fallbackUrl }
    if (release.version) compareVersions(release.version, current)
    return {
      currentVersion: current,
      latestVersion: release.version || null,
      assetUrl: release.url,
      fallbackUrl,
      notes: release.notes
    }
  }

  private async inspectArchive(zipPath: string, sourceLabel: string, runId: number): Promise<UpdateState> {
    const stagingDir = join(this.workDir(), 'staging')
    let root: string | null = null
    try {
      await extractZip(zipPath, stagingDir)
      root = findArchiveRoot(stagingDir, 'package.json')
    } catch (err) {
      if (runId !== this.runId) return this.state
      return this.setState({
        phase: 'error',
        url: sourceLabel,
        error: `The file is not a readable zip archive: ${message(err)}`
      })
    }
    if (runId !== this.runId) return this.state

    this.setState({ phase: 'validating', url: sourceLabel })
    const validation = this.validate(root)
    this.stagedRoot = validation.status === 'pass' ? root : null
    return this.setState({
      phase: validation.status === 'pass' ? 'ready' : 'error',
      validation,
      error: validation.status === 'pass' ? undefined : 'The archive did not pass every check'
    })
  }

  /** Throw away whatever was downloaded and go back to the starting point. */
  cancel(): UpdateState {
    if (this.state.phase === 'applying') return this.state
    this.runId++
    this.transfer?.abort()
    this.transfer = null
    this.cleanWorkDir()
    this.stagedRoot = null
    return this.setState({
      phase: 'idle',
      url: undefined,
      progress: undefined,
      validation: undefined,
      error: undefined
    })
  }

  /**
   * Hand over to the external update script and quit. From here on the app is
   * no longer in control: the script waits for this process to disappear,
   * swaps the folder and reinstalls. There is no window to show it in any more,
   * so it always runs headless with its output in the staging folder's log.
   */
  apply(): OkResult {
    if (this.state.phase !== 'ready' || !this.stagedRoot) {
      return { ok: false, error: 'No verified update is ready to install' }
    }
    if (process.env['BM_DEV'] === '1') {
      return { ok: false, error: 'Updates cannot be installed while running in dev mode' }
    }

    const work = this.workDir()
    const scriptName = 'update.sh'
    const source = join(appRoot(), 'scripts', scriptName)
    if (!existsSync(source)) {
      return { ok: false, error: `Update script is missing: ${source}` }
    }
    // Run the script from temp: the app folder it operates on is about to move.
    const script = join(work, scriptName)
    try {
      copyFileSync(source, script)
    } catch (err) {
      return { ok: false, error: `Could not stage the update script: ${message(err)}` }
    }

    const args = [
      '-AppDir',
      appRoot(),
      '-StagingDir',
      this.stagedRoot,
      '-AppPid',
      String(process.pid),
      '-NewVersion',
      this.state.validation?.newVersion ?? ''
    ]

    try {
      const logFd = openSync(join(work, 'update.log'), 'a')
      const child = spawn('bash', [script, ...args], {
        cwd: work,
        detached: true,
        stdio: ['ignore', logFd, logFd]
      })
      child.unref()
      closeSync(logFd)
    } catch (err) {
      return { ok: false, error: `Could not start the update script: ${message(err)}` }
    }

    this.setState({ phase: 'applying', error: undefined })
    // Give the RPC reply time to reach the browser before the socket dies.
    setTimeout(() => process.exit(0), 500)
    return { ok: true }
  }

  /** Result the update script left behind, read (and cleared) once on start. */
  consumeResult(): UpdateResult | null {
    const file = join(dataDir(), 'update-result.json')
    try {
      if (!existsSync(file)) return null
      const result = JSON.parse(readFileSync(file, 'utf8')) as UpdateResult
      unlinkSync(file)
      return typeof result?.ok === 'boolean' ? result : null
    } catch {
      return null
    }
  }

  private async download(url: string, dest: string): Promise<void> {
    const transfer = downloadFile(url, dest, {
      maxBytes: MAX_ARCHIVE_BYTES,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      onProgress: (receivedBytes, totalBytes) =>
        this.setState({ progress: { receivedBytes, totalBytes } })
    })
    this.transfer = transfer
    try {
      await transfer.done
    } finally {
      this.transfer = null
    }
  }

  /**
   * Everything that can be verified without building: is this really a Task
   * Manager source tree, and is it complete enough to install?
   */
  private validate(root: string | null): UpdateValidation {
    const current = currentVersion()
    const checks: UpdateCheckItem[] = []
    const warnings: string[] = []

    if (!root) {
      checks.push({
        id: 'archive',
        label: 'Archive contains an app folder',
        ok: false,
        detail: 'No package.json was found in the archive or in its single top-level folder'
      })
      return { status: 'error', currentVersion: current, checks, warnings }
    }
    checks.push({
      id: 'archive',
      label: 'Archive contains an app folder',
      ok: true,
      detail: root.split(/[\\/]/).pop()
    })

    let manifest: PackageManifest | null = null
    try {
      manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageManifest
      checks.push({ id: 'manifest', label: 'package.json is readable', ok: true })
    } catch (err) {
      checks.push({
        id: 'manifest',
        label: 'package.json is readable',
        ok: false,
        detail: message(err)
      })
    }

    const name = manifest?.name
    checks.push({
      id: 'identity',
      label: 'Archive is a Bored Manager release',
      ok: name === 'bored-manager',
      detail:
        name === 'bored-manager'
          ? undefined
          : `package.json name is "${name ?? 'missing'}", expected "bored-manager"`
    })

    const newVersion = typeof manifest?.version === 'string' ? manifest.version : undefined
    const versionOk = !!newVersion && /^\d+\.\d+\.\d+/.test(newVersion)
    checks.push({
      id: 'version',
      label: 'Version number is valid',
      ok: versionOk,
      detail: versionOk ? `${current} -> ${newVersion}` : `found "${newVersion ?? 'nothing'}"`
    })
    if (versionOk && compareVersions(newVersion, current) <= 0) {
      warnings.push(
        compareVersions(newVersion, current) === 0
          ? `The archive has the same version as the installed app (${current})`
          : `The archive is older than the installed app (${newVersion} < ${current})`
      )
    }

    const missing = REQUIRED_ENTRIES.filter((entry) => {
      const full = join(root, entry.path)
      try {
        return !existsSync(full) || statSync(full).isDirectory() !== !!entry.dir
      } catch {
        return true
      }
    }).map((e) => e.path)
    checks.push({
      id: 'files',
      label: `Core files are present (${REQUIRED_ENTRIES.length} checked)`,
      ok: missing.length === 0,
      detail: missing.length ? `missing: ${missing.join(', ')}` : undefined
    })

    const dev = manifest?.devDependencies ?? {}
    const hasVite = typeof dev['vite'] === 'string'
    const hasBuild = !!manifest?.scripts?.['build']
    const toolchainOk = hasVite && hasBuild
    checks.push({
      id: 'toolchain',
      label: 'Build toolchain is declared',
      ok: toolchainOk,
      detail: toolchainOk
        ? `vite ${dev['vite']}`
        : [hasVite ? '' : 'missing devDependency: vite', hasBuild ? '' : 'no "build" script']
            .filter(Boolean)
            .join('; ')
    })

    if (!existsSync(join(root, 'scripts', 'update.sh'))) {
      warnings.push(
        'The new version has no scripts/update.sh, so it will not be able to update itself again'
      )
    }

    return {
      status: checks.every((c) => c.ok) ? 'pass' : 'error',
      currentVersion: current,
      newVersion,
      checks,
      warnings
    }
  }

  private cleanWorkDir(): void {
    try {
      rmSync(this.workDir(), { recursive: true, force: true })
    } catch {
      /* a leftover temp folder is harmless */
    }
  }
}

function currentVersion(): string {
  return appVersion()
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function normalizeUrl(raw: string): { value: string } | { error: string } {
  const trimmed = raw.trim()
  if (!trimmed) return { error: 'Paste the URL of a release .zip first' }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { error: `"${trimmed}" is not a valid URL` }
  }
  if (url.protocol !== 'https:') {
    return { error: `Only https:// links are accepted (got ${url.protocol}//)` }
  }
  if (!ALLOWED_HOSTS.includes(url.hostname)) {
    return { error: `Only GitHub downloads are accepted (got ${url.hostname})` }
  }
  if (!looksLikeZipUrl(url)) {
    return { error: 'The link must point directly at a .zip archive' }
  }
  return { value: url.toString() }
}
