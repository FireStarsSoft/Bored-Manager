import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ModuleCatalog,
  ModuleRuntimeState,
  ModuleSource
} from '@shared/modules'
import { MODULE_API_VERSION } from '@shared/modules'
import { ModuleInstallerService } from '../../../server/services/module-installer'
import type { ModulesHost } from '../../../server/services/modules-host'
import { moduleFolderHash } from '../../../server/services/modules-host'
import { backupFile } from '../../../server/services/private-file'
import {
  deleteModuleConfig,
  deleteModuleData,
  moduleConfigPath,
  moduleDataPath,
  readModuleConfig,
  readModuleData,
  readModuleRegistry,
  resetStoreCacheForTests,
  writeModuleConfig,
  writeModuleData,
  writeModuleRegistry
} from '../../../server/services/store'
import { createTestTempDir, type TestTempDir } from '../../helpers/temp-dir'

const serviceMocks = vi.hoisted(() => ({
  archiveTree: '',
  extractZip: vi.fn(),
  compileModuleAt: vi.fn(),
  getCatalog: vi.fn()
}))

vi.mock('../../../server/services/zip', () => ({
  extractZip: serviceMocks.extractZip
}))

vi.mock('../../../server/services/module-compiler', () => ({
  compileModuleAt: serviceMocks.compileModuleAt
}))

vi.mock('../../../server/services/registry', () => ({
  getCatalog: serviceMocks.getCatalog
}))

class FakeModulesHost {
  readonly stopped: string[] = []
  readonly rescanned: string[] = []
  reloadHandler: (id: string) => Promise<{ ok: true } | { ok: false; error: string }> =
    async () => ({ ok: true })

  constructor(readonly states = new Map<string, ModuleRuntimeState>()) {}

  installed(id: string): ModuleRuntimeState | null {
    return this.states.get(id) ?? null
  }

  stop(id: string): void {
    this.stopped.push(id)
  }

  rescan(id: string): void {
    this.rescanned.push(id)
  }

  record(id: string, version: string, hash: string, source: ModuleSource): void {
    const previous = this.states.get(id)
    const now = Date.now()
    this.states.set(id, {
      id,
      enabled: previous?.enabled ?? true,
      version,
      hash,
      source,
      installedAt: previous?.installedAt ?? now,
      updatedAt: now
    })
    writeModuleRegistry(this.moduleRegistrySnapshot())
  }

  forget(id: string): void {
    this.states.delete(id)
    writeModuleRegistry(this.moduleRegistrySnapshot())
  }

  reload(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.reloadHandler(id)
  }

  moduleRegistrySnapshot(): Record<string, ModuleRuntimeState> {
    return Object.fromEntries(
      [...this.states].map(([id, state]) => [id, { ...state }])
    )
  }

  restoreModuleRegistrySnapshot(snapshot: Record<string, ModuleRuntimeState>): void {
    this.states.clear()
    for (const [id, state] of Object.entries(snapshot)) this.states.set(id, { ...state })
    writeModuleRegistry(this.moduleRegistrySnapshot())
  }
}

function asHost(host: FakeModulesHost): ModulesHost {
  return host as unknown as ModulesHost
}

function moduleState(id: string, version: string, hash: string): ModuleRuntimeState {
  return {
    id,
    enabled: true,
    version,
    hash,
    source: 'zip',
    installedAt: 1_000,
    updatedAt: 2_000
  }
}

function writeModuleTree(root: string, id: string, version: string, marker: string): void {
  mkdirSync(join(root, 'main'), { recursive: true })
  writeFileSync(
    join(root, 'module.json'),
    JSON.stringify({
      apiVersion: MODULE_API_VERSION,
      id,
      name: 'Transaction fixture',
      version,
      description: 'Installer transaction fixture',
      author: 'Tests',
      entries: { main: 'main/index.ts' }
    }),
    'utf8'
  )
  writeFileSync(join(root, 'main', 'index.ts'), `export default ${JSON.stringify(marker)}\n`, 'utf8')
  writeFileSync(join(root, 'marker.txt'), marker, 'utf8')
}

function transactionPaths(root: string, id: string, transactionId: string) {
  const transactions = join(root, 'data', 'module-transactions')
  return {
    transactions,
    journal: join(transactions, `${transactionId}.json`),
    snapshot: join(transactions, `${transactionId}.snapshot`),
    candidate: join(root, 'modules', `${id}.candidate-${transactionId}`),
    backup: join(root, 'modules', `${id}.backup-${transactionId}`),
    target: join(root, 'modules', id)
  }
}

function writeInterruptedJournal(
  root: string,
  id: string,
  transactionId: string,
  operation: 'install' | 'uninstall',
  phase: 'updating-state' | 'committed',
  registry: Record<string, ModuleRuntimeState>
): void {
  const paths = transactionPaths(root, id, transactionId)
  mkdirSync(paths.transactions, { recursive: true })
  writeFileSync(
    paths.journal,
    JSON.stringify({
      version: 1,
      transactionId,
      operation,
      id,
      phase,
      hadTarget: true,
      registry,
      configPrimary: true,
      configBackup: true,
      moduleData: true
    }),
    'utf8'
  )
}

function snapshotPersistentState(root: string, id: string, transactionId: string): void {
  const paths = transactionPaths(root, id, transactionId)
  mkdirSync(paths.snapshot, { recursive: true })
  const config = moduleConfigPath(id)
  copyFileSync(config, join(paths.snapshot, 'config.primary'))
  copyFileSync(backupFile(config), join(paths.snapshot, 'config.backup'))
  cpSync(moduleDataPath(id), join(paths.snapshot, 'module-data'), { recursive: true })
}

describe.sequential('ModuleInstaller transaction safety', () => {
  const id = 'fixture-module'
  let temp: TestTempDir

  beforeEach(() => {
    temp = createTestTempDir('module-installer')
    vi.stubEnv('BM_APP_ROOT', temp.path)
    resetStoreCacheForTests()
    writeFileSync(
      join(temp.path, 'package.json'),
      JSON.stringify({ name: 'bored-manager', version: '0.3.2' }),
      'utf8'
    )
    serviceMocks.extractZip.mockImplementation(async (_archive: string, destination: string) => {
      cpSync(serviceMocks.archiveTree, destination, { recursive: true })
    })
    serviceMocks.compileModuleAt.mockImplementation(async (_root: string, outfile: string) => {
      mkdirSync(dirname(outfile), { recursive: true })
      writeFileSync(outfile, 'export default () => ({ dispose() {} })\n', 'utf8')
    })
    serviceMocks.getCatalog.mockResolvedValue({
      entries: [],
      sourceRepo: 'owner/repo',
      sourceUrl: 'https://raw.githubusercontent.com/owner/repo/main/registry/modules.json',
      fetchedAt: Date.now(),
      stale: false
    } satisfies ModuleCatalog)
  })

  afterEach(() => {
    resetStoreCacheForTests()
    temp.cleanup()
    vi.clearAllMocks()
  })

  it('restores registry, config, host data, and old code after activation fails', async () => {
    const target = join(temp.path, 'modules', id)
    writeModuleTree(target, id, '1.0.0', 'old-code')
    const oldState = moduleState(id, '1.0.0', moduleFolderHash(target))
    writeModuleRegistry({ [id]: oldState })
    writeModuleConfig(id, { owner: 'old-config' })
    writeModuleData(id, 'local', { owner: 'old-data' })

    const archiveTree = join(temp.path, 'fixture-archive')
    writeModuleTree(archiveTree, id, '2.0.0', 'candidate-code')
    serviceMocks.archiveTree = archiveTree
    const upload = join(temp.path, 'upload.zip')
    writeFileSync(upload, 'test archive bytes', 'utf8')

    const host = new FakeModulesHost(new Map([[id, { ...oldState }]]))
    let reloads = 0
    host.reloadHandler = async () => {
      reloads++
      if (reloads === 1) {
        writeModuleConfig(id, { owner: 'candidate-config' })
        writeModuleData(id, 'local', { owner: 'candidate-data' })
        return {
          ok: false,
          error: `activation failed at ${join(temp.path, 'private', 'candidate.mjs')}`
        }
      }
      return { ok: true }
    }
    const service = new ModuleInstallerService(asHost(host), () => {}, () => {}, () => 'owner/repo')

    const checked = await service.checkFile(upload)
    expect(checked).toMatchObject({ phase: 'ready' })
    const result = await service.install(checked.confirmation?.token)

    expect(result).toMatchObject({
      phase: 'error',
      error: expect.stringContaining('previous module')
    })
    expect(JSON.stringify(result)).not.toContain(temp.path)
    expect(readFileSync(join(target, 'marker.txt'), 'utf8')).toBe('old-code')
    expect(readModuleRegistry()).toEqual({ [id]: oldState })
    expect(readModuleConfig(id)).toEqual({ owner: 'old-config' })
    expect(readModuleData(id, 'local')).toEqual({ owner: 'old-data' })
    expect(reloads).toBe(2)
    const transactionRoot = join(temp.path, 'data', 'module-transactions')
    expect(
      existsSync(transactionRoot)
        ? readdirSync(transactionRoot).filter((name) => name.endsWith('.json'))
        : []
    ).toEqual([])
  })

  it('refuses a formerly verified install when its catalog binding is stale', async () => {
    const archiveTree = join(temp.path, 'fixture-archive')
    writeModuleTree(archiveTree, id, '2.0.0', 'candidate-code')
    serviceMocks.archiveTree = archiveTree
    const upload = join(temp.path, 'upload.zip')
    writeFileSync(upload, 'catalog archive bytes', 'utf8')
    const host = new FakeModulesHost()
    const service = new ModuleInstallerService(asHost(host), () => {}, () => {}, () => 'owner/repo')
    const checked = await service.checkFile(upload)
    expect(checked).toMatchObject({ phase: 'ready' })

    const internal = service as unknown as {
      staged: {
        catalogBinding: {
          repo: string
          sourceUrl: string
          expectedId: string
          expectedVersion: string
          expectedSha256: string
          fetchedAt: number
        } | null
      } | null
    }
    expect(internal.staged).not.toBeNull()
    internal.staged!.catalogBinding = {
      repo: 'owner/repo',
      sourceUrl: 'https://github.com/owner/repo/releases/download/v2/fixture.zip',
      expectedId: id,
      expectedVersion: '2.0.0',
      expectedSha256: 'a'.repeat(64),
      fetchedAt: Date.now()
    }
    serviceMocks.getCatalog.mockResolvedValue({
      entries: [],
      sourceRepo: 'owner/repo',
      sourceUrl: 'https://raw.githubusercontent.com/owner/repo/main/registry/modules.json',
      fetchedAt: Date.now() - 48 * 60 * 60 * 1000,
      stale: true
    } satisfies ModuleCatalog)

    const result = await service.install(checked.confirmation?.token)
    expect(result).toMatchObject({
      phase: 'error',
      error: expect.stringContaining('catalog')
    })
    expect(existsSync(join(temp.path, 'modules', id))).toBe(false)
    expect(readModuleRegistry()).toEqual({})
  })

  it('does not trust an exact entry returned with wrong catalog provenance', async () => {
    const archiveUrl = 'https://github.com/owner/repo/releases/download/v2/fixture.zip'
    const sha256 = 'b'.repeat(64)
    serviceMocks.getCatalog.mockResolvedValue({
      entries: [
        {
          id,
          name: 'Fixture',
          description: 'Fixture',
          author: 'Tests',
          version: '2.0.0',
          download: archiveUrl,
          sha256,
          verifiedAt: '2026-08-22'
        }
      ],
      sourceRepo: 'other/repo',
      sourceUrl: 'https://raw.githubusercontent.com/other/repo/main/registry/modules.json',
      fetchedAt: Date.now(),
      stale: false
    } satisfies ModuleCatalog)
    const service = new ModuleInstallerService(
      asHost(new FakeModulesHost()),
      () => {},
      () => {},
      () => 'owner/repo'
    )
    const internal = service as unknown as {
      catalogBindingFor(
        manifest: { id: string; version: string },
        archiveSha256: string,
        sourceUrl: string
      ): Promise<unknown>
    }
    await expect(
      internal.catalogBindingFor({ id, version: '2.0.0' }, sha256, archiveUrl)
    ).resolves.toBeNull()
  })

  it('requires a fresh matching one-use confirmation token for install', async () => {
    const archiveTree = join(temp.path, 'fixture-token')
    writeModuleTree(archiveTree, id, '2.0.0', 'candidate-code')
    serviceMocks.archiveTree = archiveTree
    const upload = join(temp.path, 'token.zip')
    writeFileSync(upload, 'token archive bytes', 'utf8')
    const service = new ModuleInstallerService(
      asHost(new FakeModulesHost()),
      () => {},
      () => {},
      () => 'owner/repo'
    )

    const first = await service.checkFile(upload)
    expect(first.confirmation?.token).toBeTruthy()
    await expect(service.install(undefined)).resolves.toMatchObject({
      phase: 'ready',
      error: expect.stringContaining('token')
    })
    await expect(service.install('mismatched-confirmation-token-value-000000')).resolves.toMatchObject(
      {
        phase: 'ready',
        error: expect.stringContaining('does not match')
      }
    )
    expect(existsSync(join(temp.path, 'modules', id))).toBe(false)

    const clock = vi.spyOn(Date, 'now').mockReturnValue((first.confirmation?.expiresAt ?? 0) + 1)
    await expect(service.install(first.confirmation?.token)).resolves.toMatchObject({
      phase: 'error',
      error: expect.stringContaining('expired')
    })
    clock.mockRestore()

    const second = await service.checkFile(upload)
    const staleOperationToken = second.confirmation?.token
    const third = await service.checkFile(upload)
    await expect(service.install(staleOperationToken)).resolves.toMatchObject({
      phase: 'ready',
      error: expect.stringContaining('does not match')
    })
    const stagedRoot = (
      service as unknown as { staged: { root: string } | null }
    ).staged?.root
    expect(stagedRoot).toBeTruthy()
    writeFileSync(join(stagedRoot!, 'marker.txt'), 'changed after check')
    await expect(service.install(third.confirmation?.token)).resolves.toMatchObject({
      phase: 'error',
      error: expect.stringContaining('staged module changed')
    })

    const fourth = await service.checkFile(upload)
    const token = fourth.confirmation?.token
    expect(token).toBeTruthy()
    await expect(service.install(token)).resolves.toMatchObject({ phase: 'done' })
    await expect(service.install(token)).resolves.toMatchObject({
      error: expect.stringContaining('No inspected module')
    })
  })

  it('rolls an interrupted update back from its journal on startup', () => {
    const transactionId = 'a'.repeat(32)
    const paths = transactionPaths(temp.path, id, transactionId)
    writeModuleTree(paths.target, id, '1.0.0', 'old-code')
    const oldState = moduleState(id, '1.0.0', moduleFolderHash(paths.target))
    writeModuleRegistry({ [id]: oldState })
    writeModuleConfig(id, { owner: 'old-config' })
    writeModuleData(id, 'local', { owner: 'old-data' })
    snapshotPersistentState(temp.path, id, transactionId)

    renameSync(paths.target, paths.backup)
    writeModuleTree(paths.target, id, '2.0.0', 'candidate-code')
    writeModuleConfig(id, { owner: 'candidate-config' })
    writeModuleData(id, 'local', { owner: 'candidate-data' })
    writeModuleRegistry({ [id]: moduleState(id, '2.0.0', moduleFolderHash(paths.target)) })
    writeInterruptedJournal(
      temp.path,
      id,
      transactionId,
      'install',
      'updating-state',
      { [id]: oldState }
    )

    const host = new FakeModulesHost()
    const service = new ModuleInstallerService(asHost(host), () => {}, () => {}, () => 'owner/repo')
    expect(service.recoverPendingTransactions()).toBe(1)

    expect(readFileSync(join(paths.target, 'marker.txt'), 'utf8')).toBe('old-code')
    expect(readModuleRegistry()).toEqual({ [id]: oldState })
    expect(readModuleConfig(id)).toEqual({ owner: 'old-config' })
    expect(readModuleData(id, 'local')).toEqual({ owner: 'old-data' })
    expect(existsSync(paths.backup)).toBe(false)
    expect(existsSync(paths.snapshot)).toBe(false)
    expect(existsSync(paths.journal)).toBe(false)
  })

  it('finishes cleanup without rolling back a committed update', () => {
    const transactionId = 'b'.repeat(32)
    const paths = transactionPaths(temp.path, id, transactionId)
    writeModuleTree(paths.target, id, '1.0.0', 'old-code')
    const oldState = moduleState(id, '1.0.0', moduleFolderHash(paths.target))
    writeModuleRegistry({ [id]: oldState })
    writeModuleConfig(id, { owner: 'old-config' })
    writeModuleData(id, 'local', { owner: 'old-data' })
    snapshotPersistentState(temp.path, id, transactionId)

    renameSync(paths.target, paths.backup)
    writeModuleTree(paths.target, id, '2.0.0', 'candidate-code')
    const newState = moduleState(id, '2.0.0', moduleFolderHash(paths.target))
    writeModuleConfig(id, { owner: 'candidate-config' })
    writeModuleData(id, 'local', { owner: 'candidate-data' })
    writeModuleRegistry({ [id]: newState })
    writeInterruptedJournal(
      temp.path,
      id,
      transactionId,
      'install',
      'committed',
      { [id]: oldState }
    )

    const service = new ModuleInstallerService(
      asHost(new FakeModulesHost()),
      () => {},
      () => {},
      () => 'owner/repo'
    )
    expect(service.recoverPendingTransactions()).toBe(1)

    expect(readFileSync(join(paths.target, 'marker.txt'), 'utf8')).toBe('candidate-code')
    expect(readModuleRegistry()).toEqual({ [id]: newState })
    expect(readModuleConfig(id)).toEqual({ owner: 'candidate-config' })
    expect(readModuleData(id, 'local')).toEqual({ owner: 'candidate-data' })
    expect(existsSync(paths.backup)).toBe(false)
    expect(existsSync(paths.journal)).toBe(false)
  })

  it('recovers an uninstall interrupted after deleting module-owned state', () => {
    const transactionId = 'c'.repeat(32)
    const paths = transactionPaths(temp.path, id, transactionId)
    writeModuleTree(paths.target, id, '1.0.0', 'old-code')
    const oldState = moduleState(id, '1.0.0', moduleFolderHash(paths.target))
    writeModuleRegistry({ [id]: oldState })
    writeModuleConfig(id, { owner: 'old-config' })
    writeModuleData(id, 'local', { owner: 'old-data' })
    snapshotPersistentState(temp.path, id, transactionId)

    renameSync(paths.target, paths.backup)
    deleteModuleConfig(id)
    deleteModuleData(id)
    writeModuleRegistry({})
    writeInterruptedJournal(
      temp.path,
      id,
      transactionId,
      'uninstall',
      'updating-state',
      { [id]: oldState }
    )

    const service = new ModuleInstallerService(
      asHost(new FakeModulesHost()),
      () => {},
      () => {},
      () => 'owner/repo'
    )
    expect(service.recoverPendingTransactions()).toBe(1)

    expect(readFileSync(join(paths.target, 'marker.txt'), 'utf8')).toBe('old-code')
    expect(readModuleRegistry()).toEqual({ [id]: oldState })
    expect(readModuleConfig(id)).toEqual({ owner: 'old-config' })
    expect(readModuleData(id, 'local')).toEqual({ owner: 'old-data' })
    expect(existsSync(paths.backup)).toBe(false)
    expect(existsSync(paths.journal)).toBe(false)
  })
})
