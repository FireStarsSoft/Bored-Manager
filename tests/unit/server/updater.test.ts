import {
  cpSync,
  existsSync,
  mkdirSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  digestUpdateTree,
  REQUIRED_UPDATE_ENTRIES,
  validateUpdateTree
} from '../../../server/services/update-archive'
import {
  launchUpdateScript,
  type UpdateLauncher,
  UpdaterService
} from '../../../server/services/updater'
import { resetStoreCacheForTests } from '../../../server/services/store'
import { createTestTempDir, type TestTempDir } from '../../helpers/temp-dir'

const updaterMocks = vi.hoisted(() => ({
  extractZip: vi.fn()
}))

vi.mock('../../../server/services/zip', () => ({
  extractZip: updaterMocks.extractZip
}))

let temp: TestTempDir
let fixtureRoot: string
let previousRoot: string | undefined
let previousDev: string | undefined
let previousInvocation: string | undefined

function writeValidTree(root: string, version = '2.0.0'): void {
  for (const entry of REQUIRED_UPDATE_ENTRIES) {
    const path = join(root, ...entry.path.split('/'))
    if (entry.directory) mkdirSync(path, { recursive: true })
    else {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${entry.path}\n`)
    }
  }
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'bored-manager',
      version,
      scripts: { build: 'vite build' },
      devDependencies: { vite: '1.0.0', typescript: '1.0.0' }
    })
  )
}

beforeEach(() => {
  temp = createTestTempDir('updater')
  fixtureRoot = join(temp.path, 'fixture')
  writeValidTree(fixtureRoot)
  previousRoot = process.env['BM_APP_ROOT']
  previousDev = process.env['BM_DEV']
  previousInvocation = process.env['INVOCATION_ID']
  process.env['BM_APP_ROOT'] = temp.path
  delete process.env['BM_DEV']
  delete process.env['INVOCATION_ID']
  resetStoreCacheForTests()
  updaterMocks.extractZip.mockReset()
  updaterMocks.extractZip.mockImplementation(async (_archive, destination) => {
    cpSync(fixtureRoot, destination, { recursive: true })
  })
})

afterEach(() => {
  temp.cleanup()
  if (previousRoot === undefined) delete process.env['BM_APP_ROOT']
  else process.env['BM_APP_ROOT'] = previousRoot
  if (previousDev === undefined) delete process.env['BM_DEV']
  else process.env['BM_DEV'] = previousDev
  if (previousInvocation === undefined) delete process.env['INVOCATION_ID']
  else process.env['INVOCATION_ID'] = previousInvocation
  resetStoreCacheForTests()
  vi.restoreAllMocks()
})

describe('structural update validation helper', () => {
  it('requires exact semver, identity, files, and build toolchain', () => {
    writeValidTree(fixtureRoot, '2.0.0-beta')
    const result = validateUpdateTree(fixtureRoot, { currentVersion: '1.0.0' })
    expect(result.provenance).toBe('structural-only')
    expect(result.validation.status).toBe('error')
    expect(result.validation.checks.find((check) => check.id === 'version')?.ok).toBe(false)
    expect(result.validation.warnings.join(' ')).toMatch(/does not prove publisher identity/)
  })

  it('digests exact bytes, including carriage returns', async () => {
    const first = await digestUpdateTree(fixtureRoot)
    writeFileSync(join(fixtureRoot, 'server', 'index.ts'), 'server/index.ts\r\n')
    const second = await digestUpdateTree(fixtureRoot)
    expect(second).not.toBe(first)
  })
})

describe('UpdaterService operation safety', () => {
  it('does not let a concurrent check reuse or remove active staging', async () => {
    const upload = join(temp.path, 'upload.zip')
    writeFileSync(upload, 'fixture')
    let started!: () => void
    let release!: () => void
    const extracting = new Promise<void>((resolve) => {
      started = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    updaterMocks.extractZip.mockImplementation(async (_archive, destination) => {
      started()
      await gate
      cpSync(fixtureRoot, destination, { recursive: true })
    })
    const service = new UpdaterService(() => undefined)
    const first = service.checkFile(upload)
    await extracting
    const activeWorkspace = (service as unknown as { workspace: string }).workspace
    await expect(service.checkFile(upload)).resolves.toMatchObject({
      error: 'An update check is already running'
    })
    expect(
      (service as unknown as { workspace: string }).workspace
    ).toBe(activeWorkspace)
    expect(existsSync(activeWorkspace)).toBe(true)
    release()
    await first
    await service.cancel()
  })

  it('uses a unique private workspace for every completed check', async () => {
    const upload = join(temp.path, 'upload.zip')
    writeFileSync(upload, 'fixture')
    const service = new UpdaterService(() => undefined)
    await expect(service.checkFile(upload)).resolves.toMatchObject({ phase: 'ready' })
    const first = (service as unknown as { workspace: string }).workspace
    expect(existsSync(first)).toBe(true)

    await expect(service.checkFile(upload)).resolves.toMatchObject({ phase: 'ready' })
    const second = (service as unknown as { workspace: string }).workspace
    expect(second).not.toBe(first)
    expect(existsSync(first)).toBe(false)
    expect(existsSync(second)).toBe(true)
    await service.cancel()
  })

  it('awaits extraction cancellation before cleaning and returning idle', async () => {
    const upload = join(temp.path, 'upload.zip')
    writeFileSync(upload, 'fixture')
    let started!: () => void
    const extracting = new Promise<void>((resolve) => {
      started = resolve
    })
    let stabilized = false
    updaterMocks.extractZip.mockImplementation(
      async (_archive: string, _destination: string, options: { signal?: AbortSignal }) => {
        started()
        await new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => {
              setTimeout(() => {
                stabilized = true
                reject(new Error('cancelled'))
              }, 10)
            },
            { once: true }
          )
        })
      }
    )
    const service = new UpdaterService(() => undefined)
    const checking = service.checkFile(upload)
    await extracting
    const cancelled = await service.cancel()
    await checking
    expect(stabilized).toBe(true)
    expect(cancelled.phase).toBe('idle')
    expect((service as unknown as { workspace: string | null }).workspace).toBeNull()
  })

  it('detects staged tree changes immediately before handoff', async () => {
    const upload = join(temp.path, 'upload.zip')
    writeFileSync(upload, 'fixture')
    const service = new UpdaterService(() => undefined)
    await service.checkFile(upload)
    const staged = (service as unknown as { stagedRoot: string }).stagedRoot
    writeFileSync(join(staged, 'server', 'index.ts'), 'modified after validation\n')
    await expect(service.apply()).resolves.toEqual({
      ok: false,
      error: 'The staged update changed; check the archive again'
    })
    await service.cancel()
  })
})

describe('systemd update handoff', () => {
  it('does not fall back to an in-cgroup detached child when systemd-run fails', async () => {
    process.env['INVOCATION_ID'] = 'service-invocation'
    const launcher = {
      spawn: vi.fn(),
      spawnSync: vi.fn(() => ({
        pid: 0,
        output: [],
        stdout: '',
        stderr: 'failed',
        status: 1,
        signal: null
      }))
    } as unknown as UpdateLauncher
    await expect(
      launchUpdateScript('/tmp/update.sh', [], temp.path, launcher)
    ).rejects.toThrow(/systemd-run/)
    expect(launcher.spawn).not.toHaveBeenCalled()
  })

  it('requires systemctl to confirm the transient unit is active', async () => {
    process.env['INVOCATION_ID'] = 'service-invocation'
    const spawnSyncMock = vi
      .fn()
      .mockReturnValueOnce({
        pid: 1,
        output: [],
        stdout: '',
        stderr: '',
        status: 0,
        signal: null
      })
      .mockReturnValueOnce({
        pid: 2,
        output: [],
        stdout: 'failed\n',
        stderr: '',
        status: 0,
        signal: null
      })
    const launcher = {
      spawn: vi.fn(),
      spawnSync: spawnSyncMock
    } as unknown as UpdateLauncher
    await expect(
      launchUpdateScript('/tmp/update.sh', [], temp.path, launcher)
    ).rejects.toThrow(/confirmed active/)
    expect(launcher.spawn).not.toHaveBeenCalled()
  })
})
