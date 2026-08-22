import {
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types'
import type { ModuleManifest } from '@shared/modules'
import {
  ModulesHost,
  moduleSurfaceActive
} from '../../../server/services/modules-host'
import { resetStoreCacheForTests } from '../../../server/services/store'
import { createTestTempDir, type TestTempDir } from '../../helpers/temp-dir'

const compilerMock = vi.hoisted(() => vi.fn<(id: string) => Promise<void>>())

vi.mock('../../../server/services/module-compiler', () => ({
  compileModule: compilerMock
}))

interface Harness {
  host: ModulesHost
  handlers: Map<string, (...args: unknown[]) => unknown>
  logs: string[]
}

let temp: TestTempDir
let previousRoot: string | undefined
let previousDev: string | undefined

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiVersion: 2,
    id: 'race-module',
    name: 'Race module',
    version: '1.0.0',
    description: 'Lifecycle fixture',
    author: 'Tests',
    entries: { main: 'main/index.ts' },
    pages: [{ id: 'main', label: 'Main' }],
    methods: ['ping'],
    ...overrides
  }
}

function writeModule(
  id = 'race-module',
  manifestValue: Record<string, unknown> = manifest({ id }),
  main = 'source\n'
): void {
  const dir = join(temp.path, 'modules', id)
  mkdirSync(join(dir, 'main'), { recursive: true })
  mkdirSync(join(dir, 'ui', 'pages'), { recursive: true })
  writeFileSync(join(dir, 'module.json'), JSON.stringify(manifestValue))
  writeFileSync(join(dir, 'main', 'index.ts'), main)
  writeFileSync(
    join(dir, 'ui', 'pages', 'main.json'),
    JSON.stringify({ blocks: [{ type: 'stat', label: 'Ready', source: { kind: 'core', stream: 'system' }, format: 'number' }] })
  )
}

function compiledPath(id = 'race-module'): string {
  return join(temp.path, 'modules', id, '.dist', 'main.mjs')
}

function compileAs(source: string): void {
  compilerMock.mockImplementation(async (id) => {
    mkdirSync(join(temp.path, 'modules', id, '.dist'), { recursive: true })
    writeFileSync(compiledPath(id), source)
  })
}

function makeHost(): Harness {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const logs: string[] = []
  const host = new ModulesHost(
    { add: vi.fn() } as never,
    vi.fn(),
    (channel, fn) => handlers.set(channel, fn),
    (channel) => handlers.delete(channel),
    (line) => logs.push(line)
  )
  host.init([])
  host.configure({} as AppSettings, new Set())
  return { host, handlers, logs }
}

beforeEach(() => {
  temp = createTestTempDir('modules-host')
  previousRoot = process.env['BM_APP_ROOT']
  previousDev = process.env['BM_DEV']
  process.env['BM_APP_ROOT'] = temp.path
  delete process.env['BM_DEV']
  resetStoreCacheForTests()
  mkdirSync(join(temp.path, 'modules'), { recursive: true })
  writeFileSync(join(temp.path, 'package.json'), JSON.stringify({ version: '1.0.0' }))
  compilerMock.mockReset()
})

afterEach(() => {
  temp.cleanup()
  if (previousRoot === undefined) delete process.env['BM_APP_ROOT']
  else process.env['BM_APP_ROOT'] = previousRoot
  if (previousDev === undefined) delete process.env['BM_DEV']
  else process.env['BM_DEV'] = previousDev
  delete (globalThis as Record<string, unknown>)['__modulePoller']
  resetStoreCacheForTests()
})

describe('ModulesHost lifecycle serialization', () => {
  it('treats an enabled Overview widget as an active module surface', () => {
    const gpu = {
      id: 'gpu',
      widgets: [{ id: 'summary', label: 'Summary', defaultEnabled: true }]
    } as ModuleManifest
    const settings = structuredClone(DEFAULT_SETTINGS)
    const overview = new Set(['overview'])

    expect(moduleSurfaceActive(overview, 'gpu', gpu, settings)).toBe(true)
    settings.overviewWidgets['gpu.summary'] = false
    expect(moduleSurfaceActive(overview, 'gpu', gpu, settings)).toBe(false)

    settings.overviewWidgets['gpu.summary'] = true
    expect(moduleSurfaceActive(new Set(['settings']), 'gpu', gpu, settings)).toBe(false)
    expect(moduleSurfaceActive(new Set(['gpu/dashboard']), 'gpu', gpu, settings)).toBe(true)
  })

  it('cannot commit an activation disabled while compilation is pending', async () => {
    writeModule()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const compiling = new Promise<void>((resolve) => {
      started = resolve
    })
    compilerMock.mockImplementation(async (id) => {
      mkdirSync(join(temp.path, 'modules', id, '.dist'), { recursive: true })
      writeFileSync(compiledPath(id), 'export default () => ({ dispose() {} })')
      started()
      await gate
    })
    const { host, handlers } = makeHost()
    const applying = host.apply()
    await compiling
    const disabling = host.setEnabled('race-module', false)
    release()
    await Promise.all([applying, disabling])
    expect(host.isLive('race-module')).toBe(false)
    expect(handlers.size).toBe(0)
  })

  it('coalesces duplicate apply requests into one live instance', async () => {
    writeModule()
    compileAs('export default (ctx) => { ctx.handle("ping", () => "pong"); return { dispose() {} } }')
    const { host, handlers } = makeHost()
    await Promise.all([host.apply(), host.apply(), host.apply()])
    expect(host.isLive('race-module')).toBe(true)
    expect(compilerMock).toHaveBeenCalledTimes(1)
    expect(handlers.size).toBe(1)
  })

  it('validates the runtime return contract before publishing specs', async () => {
    writeModule()
    compileAs('export default () => ({})')
    const { host } = makeHost()
    await host.apply()
    expect(host.isLive('race-module')).toBe(false)
    expect(host.specsPayload()).toEqual([])
    expect(host.list()[0]?.problem).toMatch(/dispose/)
  })

  it('publishes specs for enabled modules before they become live', async () => {
    writeModule()
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const compiling = new Promise<void>((resolve) => {
      started = resolve
    })
    compilerMock.mockImplementation(async (id) => {
      mkdirSync(join(temp.path, 'modules', id, '.dist'), { recursive: true })
      writeFileSync(
        compiledPath(id),
        'export default (ctx) => { ctx.handle("ping", () => "pong"); return { dispose() {} } }'
      )
      started()
      await gate
    })
    const { host, handlers } = makeHost()
    const applying = host.apply()
    await compiling
    expect(host.isLive('race-module')).toBe(false)
    expect(host.specsPayload()).toHaveLength(1)
    release()
    await applying
    expect(handlers.has('module:race-module:invoke:ping')).toBe(true)
    expect(host.isLive('race-module')).toBe(true)
    expect(host.specsPayload()).toHaveLength(1)
  })

  it('rechecks exact bytes and refuses a stale integrity reload', async () => {
    writeModule('race-module', manifest(), 'line-one\nline-two\n')
    compileAs('export default () => ({ dispose() {} })')
    const { host } = makeHost()
    writeFileSync(
      join(temp.path, 'modules', 'race-module', 'main', 'index.ts'),
      'line-one\r\nline-two\r\n'
    )
    expect(host.verify('race-module')).toBe('modified')
    compilerMock.mockClear()
    await expect(host.reload('race-module')).resolves.toMatchObject({ ok: false })
    expect(compilerMock).not.toHaveBeenCalled()
  })

  it('enforces minAppVersion again at activation', async () => {
    writeModule('race-module', manifest({ minAppVersion: '9.0.0' }))
    compileAs('export default () => ({ dispose() {} })')
    const { host } = makeHost()
    await host.apply()
    expect(host.isLive('race-module')).toBe(false)
    expect(host.list()[0]?.problem).toMatch(/9\.0\.0/)
  })

  it('revokes pollers and retained handler wrappers after deactivation', async () => {
    writeModule()
    compileAs(`
      export default (ctx) => {
        globalThis.__modulePoller = ctx.createPoller("test", async () => {})
        ctx.handle("ping", () => "pong")
        return { dispose() {} }
      }
    `)
    const { host, handlers } = makeHost()
    await host.apply()
    const retainedHandler = handlers.get('module:race-module:invoke:ping')
    const poller = (globalThis as Record<string, unknown>)['__modulePoller'] as {
      start(ms: number): void
    }
    await host.setEnabled('race-module', false)
    expect(() => poller.start(10)).toThrow(/no longer running/)
    expect(() => retainedHandler?.()).toThrow(/no longer running/)
  })

  it('contains malformed manifests per folder during startup', () => {
    writeModule()
    writeModule(
      'broken-module',
      manifest({
        id: 'broken-module',
        entries: [],
        pages: { not: 'an array' }
      })
    )
    compileAs('export default () => ({ dispose() {} })')
    const { host } = makeHost()
    expect(host.list().map((item) => item.manifest.id).sort()).toEqual([
      'broken-module',
      'race-module'
    ])
    expect(host.list().find((item) => item.manifest.id === 'broken-module')?.problem).toBeTruthy()
    expect(readFileSync(join(temp.path, 'modules', 'race-module', 'module.json'), 'utf8')).toContain(
      'race-module'
    )
  })

  it('dispatches one public method to isolated instances by machine id', async () => {
    writeModule()
    compileAs(`
      let activations = 0
      export default (ctx) => {
        activations++
        ctx.handle("ping", (value) => ({ host: ctx.hostKey, value, activations }))
        return { dispose() {}, snapshots() { return { host: ctx.hostKey } } }
      }
    `)
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const manager = {
      connected: true,
      status: () => ({ connected: true }),
      exec: vi.fn(),
      execSudo: vi.fn(),
      stream: vi.fn(),
      streamSudo: vi.fn()
    }
    const runtimes = new Map(
      ['alpha', 'beta'].map((id) => [
        id,
        {
          id,
          manager: manager as never,
          history: { add: vi.fn() } as never
        }
      ])
    )
    const host = new ModulesHost(
      { add: vi.fn() } as never,
      vi.fn(),
      (channel, handler) => handlers.set(channel, handler),
      (channel) => handlers.delete(channel),
      vi.fn(),
      (machineId) => runtimes.get(machineId),
      () => [...runtimes.keys()]
    )
    host.init([])
    host.configure(DEFAULT_SETTINGS, new Map())

    await host.apply()

    const ping = handlers.get('module:race-module:invoke:ping')
    expect(ping?.('alpha', 'left')).toEqual({
      host: 'alpha',
      value: 'left',
      activations: 1
    })
    expect(ping?.('beta', 'right')).toEqual({
      host: 'beta',
      value: 'right',
      activations: 1
    })
    expect(host.snapshots('alpha')).toEqual({
      'race-module': { host: 'alpha' }
    })

    host.suspendMachine('alpha')
    expect(() => ping?.('alpha', 'gone')).toThrow(/no live module RPC handler/)
    expect(ping?.('beta', 'still')).toMatchObject({ host: 'beta' })
  })
})
