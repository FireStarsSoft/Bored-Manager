import { spawn, spawnSync } from 'child_process'
import { createHash, randomBytes } from 'crypto'
import {
  chmodSync,
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync
} from 'fs'
import { constants as fsConstants } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type {
  OkResult,
  UpdateRepoInfo,
  UpdateResult,
  UpdateState
} from '@shared/types'
import { DEFAULT_UPDATE_REPO } from '@shared/types'
import {
  assertSafeDownloadUrl,
  downloadFile,
  findArchiveRoot,
  GITHUB_DOWNLOAD_HOSTS,
  type DownloadHandle
} from './download'
import {
  defaultBranchZipUrl,
  isGithubRepoName,
  latestReleaseZip,
  looksLikeZipUrl
} from './github'
import { appRoot, appVersion, dataDir } from './store'
import {
  digestUpdateTree,
  validateUpdateTree
} from './update-archive'
import { extractZip } from './zip'

const MAX_ARCHIVE_BYTES = 300 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000

interface ActiveOperation {
  generation: number
  controller: AbortController
  transfer: DownloadHandle | null
  promise: Promise<UpdateState>
}

export class UpdaterService {
  private state: UpdateState = { phase: 'idle', currentVersion: appVersion() }
  private operation: ActiveOperation | null = null
  private generation = 0
  private workspace: string | null = null
  private stagedRoot: string | null = null
  private stagedDigest: string | null = null
  private checksum: 'ok' | 'skipped' = 'skipped'

  constructor(private readonly onState: (state: UpdateState) => void) {}

  getState(): UpdateState {
    return this.state
  }

  private setState(patch: Partial<UpdateState>): UpdateState {
    this.state = { ...this.state, ...patch, currentVersion: appVersion() }
    this.onState(this.state)
    return this.state
  }

  async check(rawUrl: string): Promise<UpdateState> {
    if (this.operation) return this.setState({ error: 'An update check is already running' })
    if (this.state.phase === 'applying') return this.state
    const normalized = normalizeUrl(rawUrl)
    if ('error' in normalized) {
      return this.setState({ phase: 'error', error: normalized.error, validation: undefined })
    }
    let work: string
    try {
      work = this.createWorkspace()
    } catch (error) {
      return this.setState({
        phase: 'error',
        error: safeMessage(error, 'Could not create private update staging')
      })
    }
    const operation = this.beginOperation()
    this.setState({
      phase: 'downloading',
      url: normalized.value,
      error: undefined,
      validation: undefined,
      progress: { receivedBytes: 0, totalBytes: null }
    })
    operation.promise = this.checkUrlOperation(operation, work, normalized.value).finally(() => {
      if (this.operation === operation) this.operation = null
    })
    return operation.promise
  }

  async checkFile(uploadPath: string): Promise<UpdateState> {
    if (this.operation) return this.setState({ error: 'An update check is already running' })
    if (this.state.phase === 'applying') return this.state
    try {
      const stat = lstatSync(uploadPath)
      if (!stat.isFile()) throw new Error('upload is not a regular file')
      if (stat.size > MAX_ARCHIVE_BYTES) throw new Error('upload exceeds the archive byte limit')
    } catch (error) {
      return this.setState({
        phase: 'error',
        error: safeMessage(error, 'The uploaded archive is unavailable')
      })
    }
    let work: string
    try {
      work = this.createWorkspace()
    } catch (error) {
      return this.setState({
        phase: 'error',
        error: safeMessage(error, 'Could not create private update staging')
      })
    }
    const copied = join(work, 'update.zip')
    try {
      copyFileSync(uploadPath, copied, fsConstants.COPYFILE_EXCL)
      chmodPrivate(copied, 0o600)
    } catch (error) {
      this.discardWorkspaceQuietly()
      return this.setState({
        phase: 'error',
        error: safeMessage(error, 'Could not copy the uploaded archive into private staging')
      })
    }
    const operation = this.beginOperation()
    this.setState({
      phase: 'extracting',
      url: 'upload',
      error: undefined,
      validation: undefined,
      progress: undefined
    })
    operation.promise = this.inspectArchive(operation, copied, 'upload').finally(() => {
      if (this.operation === operation) this.operation = null
    })
    return operation.promise
  }

  async checkRepo(repo = DEFAULT_UPDATE_REPO): Promise<UpdateRepoInfo> {
    const name = repo.trim() || DEFAULT_UPDATE_REPO
    if (!isGithubRepoName(name)) throw new Error(`"${name}" is not a GitHub owner/repo`)
    const release = await latestReleaseZip(name, (assetName) =>
      /^bored-manager-[0-9]+\.[0-9]+\.[0-9]+\.zip$/i.test(assetName)
    )
    if (!release || !release.matched) {
      return {
        currentVersion: appVersion(),
        latestVersion: null,
        fallbackUrl: release?.url ?? (await defaultBranchZipUrl(name)),
        notes: release?.notes
      }
    }
    return {
      currentVersion: appVersion(),
      latestVersion: release.version || null,
      assetUrl: release.url,
      fallbackUrl: await defaultBranchZipUrl(name),
      notes: release.notes
    }
  }

  /** Abort, await pipeline stabilization, then remove only this operation's workspace. */
  async cancel(): Promise<UpdateState> {
    if (this.state.phase === 'applying') return this.state
    this.generation += 1
    const operation = this.operation
    if (operation) {
      operation.controller.abort(new Error('update check cancelled'))
      operation.transfer?.abort()
      await operation.promise.catch(() => undefined)
      if (this.operation === operation) this.operation = null
    }
    this.stagedRoot = null
    this.stagedDigest = null
    try {
      this.discardWorkspace()
    } catch (error) {
      return this.setState({
        phase: 'error',
        progress: undefined,
        validation: undefined,
        error: safeMessage(error, 'Cancelled, but private update staging could not be removed')
      })
    }
    return this.setState({
      phase: 'idle',
      url: undefined,
      progress: undefined,
      validation: undefined,
      error: undefined
    })
  }

  /**
   * Revalidate the exact staged tree, then require a confirmed helper outside
   * the current service cgroup before reporting that handoff succeeded.
   */
  async apply(): Promise<OkResult> {
    if (
      this.state.phase !== 'ready' ||
      !this.stagedRoot ||
      !this.stagedDigest ||
      !this.workspace
    ) {
      return { ok: false, error: 'No structurally validated update is ready to install' }
    }
    if (this.operation) return { ok: false, error: 'The update check is still finishing' }
    if (process.env['BM_DEV'] === '1') {
      return { ok: false, error: 'Updates cannot be installed while running in dev mode' }
    }

    try {
      const revalidation = validateUpdateTree(this.stagedRoot, {
        currentVersion: appVersion(),
        checksumVerified: this.checksum === 'ok'
      }).validation
      if (
        revalidation.status !== 'pass' ||
        revalidation.newVersion !== this.state.validation?.newVersion
      ) {
        return { ok: false, error: 'The staged update changed; check the archive again' }
      }
      const digest = await digestUpdateTree(this.stagedRoot)
      if (digest !== this.stagedDigest) {
        return { ok: false, error: 'The staged update changed; check the archive again' }
      }
    } catch (error) {
      return {
        ok: false,
        error: safeMessage(error, 'The staged update could not be revalidated')
      }
    }

    const source = join(appRoot(), 'scripts', 'update.sh')
    try {
      if (!lstatSync(source).isFile()) throw new Error('not a regular file')
    } catch {
      return { ok: false, error: 'The installed update helper is missing or invalid' }
    }
    const script = join(this.workspace, 'update.sh')
    try {
      copyFileSync(source, script, fsConstants.COPYFILE_EXCL)
      chmodPrivate(script, 0o700)
    } catch (error) {
      return { ok: false, error: safeMessage(error, 'Could not stage the update helper') }
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
      await launchUpdateScript(script, args, this.workspace)
    } catch (error) {
      try {
        unlinkSync(script)
      } catch {
        /* a failed helper may already have removed its staged copy */
      }
      return {
        ok: false,
        error: safeMessage(error, 'Could not start an independent update helper')
      }
    }

    this.setState({ phase: 'applying', error: undefined })
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500)
    return { ok: true }
  }

  consumeResult(): UpdateResult | null {
    const file = join(dataDir(), 'update-result.json')
    if (!existsSync(file)) return null
    try {
      const result = JSON.parse(readFileSync(file, 'utf8')) as UpdateResult
      unlinkSync(file)
      if (typeof result?.ok !== 'boolean') return null
      return {
        ...result,
        error:
          typeof result.error === 'string'
            ? redactKnownPaths(result.error, [appRoot(), dataDir()])
            : undefined
      }
    } catch {
      try {
        unlinkSync(file)
      } catch {
        /* do not repeatedly parse a corrupt result */
      }
      return null
    }
  }

  private beginOperation(): ActiveOperation {
    const operation: ActiveOperation = {
      generation: ++this.generation,
      controller: new AbortController(),
      transfer: null,
      promise: Promise.resolve(this.state)
    }
    this.operation = operation
    this.checksum = 'skipped'
    this.stagedRoot = null
    this.stagedDigest = null
    return operation
  }

  private current(operation: ActiveOperation): boolean {
    return (
      this.operation === operation &&
      operation.generation === this.generation &&
      !operation.controller.signal.aborted
    )
  }

  private async checkUrlOperation(
    operation: ActiveOperation,
    work: string,
    url: string
  ): Promise<UpdateState> {
    const zipPath = join(work, 'update.zip')
    try {
      await this.download(operation, url, zipPath)
      if (!this.current(operation)) return this.state
      await this.maybeVerifyChecksum(operation, url, zipPath)
      if (!this.current(operation)) return this.state
      this.setState({ phase: 'extracting' })
      return await this.inspectArchive(operation, zipPath, url)
    } catch (error) {
      if (!this.current(operation)) return this.state
      const cleanupFailed = !this.discardWorkspaceQuietly()
      return this.setState({
        phase: 'error',
        progress: undefined,
        validation: undefined,
        error: cleanupFailed
          ? 'The update failed and private staging could not be removed'
          : safeMessage(error, 'The update archive could not be downloaded')
      })
    }
  }

  private async inspectArchive(
    operation: ActiveOperation,
    zipPath: string,
    sourceLabel: string
  ): Promise<UpdateState> {
    const stagingDir = join(this.workspace!, 'staging')
    let root: string | null = null
    try {
      await extractZip(zipPath, stagingDir, {
        signal: operation.controller.signal,
        limits: {
          maxTotalCompressedBytes: MAX_ARCHIVE_BYTES,
          maxCompressedBytesPerEntry: MAX_ARCHIVE_BYTES
        }
      })
      root = findArchiveRoot(stagingDir, 'package.json')
    } catch (error) {
      if (!this.current(operation)) return this.state
      const cleanupFailed = !this.discardWorkspaceQuietly()
      return this.setState({
        phase: 'error',
        url: sourceLabel,
        error: cleanupFailed
          ? 'Archive extraction failed and partial staging could not be removed'
          : safeMessage(error, 'The file is not a safe readable ZIP archive')
      })
    }
    if (!this.current(operation)) return this.state

    this.setState({ phase: 'validating', url: sourceLabel })
    const result = validateUpdateTree(root, {
      currentVersion: appVersion(),
      checksumVerified: this.checksum === 'ok'
    })
    if (result.validation.status === 'pass' && root) {
      try {
        this.stagedDigest = await digestUpdateTree(root)
      } catch (error) {
        if (!this.current(operation)) return this.state
        this.stagedRoot = null
        const cleanupFailed = !this.discardWorkspaceQuietly()
        return this.setState({
          phase: 'error',
          validation: result.validation,
          error: cleanupFailed
            ? 'The staged update could not be digested or removed'
            : safeMessage(error, 'The staged update tree could not be digested')
        })
      }
    }
    if (!this.current(operation)) return this.state
    this.stagedRoot = result.validation.status === 'pass' ? root : null
    if (result.validation.status !== 'pass' && !this.discardWorkspaceQuietly()) {
      return this.setState({
        phase: 'error',
        validation: result.validation,
        error: 'The rejected update and its private staging could not be removed'
      })
    }
    return this.setState({
      phase: result.validation.status === 'pass' ? 'ready' : 'error',
      validation: result.validation,
      error:
        result.validation.status === 'pass'
          ? undefined
          : 'The archive did not pass structural validation'
    })
  }

  private async download(
    operation: ActiveOperation,
    url: string,
    destination: string
  ): Promise<void> {
    const transfer = downloadFile(url, destination, {
      maxBytes: MAX_ARCHIVE_BYTES,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      allowedHosts: GITHUB_DOWNLOAD_HOSTS,
      onProgress: (receivedBytes, totalBytes) => {
        if (this.current(operation)) {
          this.setState({ progress: { receivedBytes, totalBytes } })
        }
      }
    })
    operation.transfer = transfer
    try {
      await transfer.done
    } finally {
      if (operation.transfer === transfer) operation.transfer = null
    }
  }

  private async maybeVerifyChecksum(
    operation: ActiveOperation,
    url: string,
    zipPath: string
  ): Promise<void> {
    this.checksum = 'skipped'
    const sidecar = new URL(url)
    sidecar.pathname = `${sidecar.pathname}.sha256`
    const destination = `${zipPath}.sha256`
    const transfer = downloadFile(sidecar.toString(), destination, {
      maxBytes: 8192,
      timeoutMs: 30_000,
      allowedHosts: GITHUB_DOWNLOAD_HOSTS
    })
    operation.transfer = transfer
    try {
      await transfer.done
    } catch {
      this.checksum = 'skipped'
      return
    } finally {
      if (operation.transfer === transfer) operation.transfer = null
    }
    if (!this.current(operation)) return
    const expected = readFileSync(destination, 'utf8').trim().split(/\s+/)[0]?.toLowerCase()
    if (!expected || !/^[0-9a-f]{64}$/.test(expected)) return
    const actual = await hashFile(zipPath)
    if (actual !== expected) throw new Error('The archive SHA-256 does not match its sidecar')
    this.checksum = 'ok'
  }

  private createWorkspace(): string {
    this.discardWorkspace()
    const workspace = mkdtempSync(join(tmpdir(), 'bored-manager-update-'))
    chmodPrivate(workspace, 0o700)
    this.workspace = workspace
    return workspace
  }

  private discardWorkspace(): void {
    const workspace = this.workspace
    if (!workspace) return
    rmSync(workspace, { recursive: true, force: true })
    this.workspace = null
    this.stagedRoot = null
    this.stagedDigest = null
  }

  private discardWorkspaceQuietly(): boolean {
    try {
      this.discardWorkspace()
      return true
    } catch {
      return false
    }
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

function chmodPrivate(path: string, mode: number): void {
  try {
    chmodSync(path, mode)
  } catch (error) {
    if (process.platform !== 'win32') throw error
  }
}

export interface UpdateLauncher {
  spawn: typeof spawn
  spawnSync: typeof spawnSync
}

export async function launchUpdateScript(
  script: string,
  args: string[],
  work: string,
  launcher: UpdateLauncher = { spawn, spawnSync }
): Promise<void> {
  if (process.env['INVOCATION_ID']) {
    const unit = `bored-manager-update-${process.pid}-${randomBytes(6).toString('hex')}`
    const launched = launcher.spawnSync(
      'systemd-run',
      [
        '--user',
        '--collect',
        `--unit=${unit}`,
        '--service-type=exec',
        `--setenv=PATH=${process.env['PATH'] ?? ''}`,
        `--working-directory=${work}`,
        'bash',
        script,
        ...args
      ],
      { cwd: work, encoding: 'utf8' }
    )
    if (launched.error || launched.status !== 0) {
      throw new Error('systemd-run did not create an independent transient service')
    }
    const confirmation = launcher.spawnSync(
      'systemctl',
      ['--user', 'show', unit, '--property=ActiveState', '--value'],
      { cwd: work, encoding: 'utf8' }
    )
    const active = confirmation.stdout?.trim()
    if (
      confirmation.error ||
      confirmation.status !== 0 ||
      (active !== 'active' && active !== 'activating')
    ) {
      throw new Error('the transient update service could not be confirmed active')
    }
    return
  }

  const logFd = openSync(join(work, 'update.log'), 'ax', 0o600)
  try {
    await new Promise<void>((resolve, reject) => {
      const child = launcher.spawn('bash', [script, ...args], {
        cwd: work,
        detached: true,
        stdio: ['ignore', logFd, logFd]
      })
      child.once('error', reject)
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    })
  } finally {
    closeSync(logFd)
  }
}

function redactKnownPaths(text: string, paths: readonly string[]): string {
  let safe = text
  for (const path of paths) {
    if (!path) continue
    safe = safe.split(path).join('[path]')
    safe = safe.split(path.replace(/\\/g, '/')).join('[path]')
  }
  return safe
}

function safeMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error)
  const redacted = redactKnownPaths(raw, [appRoot(), dataDir(), tmpdir()])
  return redacted && !/[A-Za-z]:[\\/]|\/(?:home|tmp|var|opt)\//.test(redacted)
    ? redacted
    : fallback
}

function normalizeUrl(raw: string): { value: string } | { error: string } {
  const trimmed = raw.trim()
  if (!trimmed) return { error: 'Paste the URL of a release .zip first' }
  try {
    const url = assertSafeDownloadUrl(trimmed, GITHUB_DOWNLOAD_HOSTS)
    if (!looksLikeZipUrl(url)) {
      return { error: 'The link must point directly at a .zip archive' }
    }
    return { value: url.toString() }
  } catch (error) {
    return { error: safeMessage(error, 'The update URL is not allowed') }
  }
}
