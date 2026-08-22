// @vitest-environment jsdom

import { beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type MachinePayload, type MachineStatus, type SystemSnapshot } from '@shared/types'

const mocks = vi.hoisted(() => {
  let systemListener: ((payload: MachinePayload<SystemSnapshot>) => void) | null = null
  let statusListener: ((machines: MachineStatus[]) => void) | null = null
  const noopSubscription = vi.fn(() => () => undefined)
  const api = {
    auth: {
      status: vi.fn(),
      logout: vi.fn()
    },
    settings: {
      get: vi.fn(),
      set: vi.fn()
    },
    connection: {
      status: vi.fn(),
      connect: vi.fn(),
      reconnect: vi.fn(),
      disconnect: vi.fn(),
      onLost: noopSubscription,
      onStatus: vi.fn((listener: (machines: MachineStatus[]) => void) => {
        statusListener = listener
        return () => undefined
      })
    },
    metrics: {
      history: vi.fn(),
      refreshSlow: vi.fn(),
      onSystem: vi.fn((listener: (payload: MachinePayload<SystemSnapshot>) => void) => {
        systemListener = listener
        return () => undefined
      }),
      onTop: noopSubscription,
      onServices: noopSubscription
    },
    modules: {
      list: vi.fn(),
      onListChanged: noopSubscription
    },
    terminals: {
      list: vi.fn(),
      onExit: noopSubscription
    },
    update: {
      consumeResult: vi.fn()
    },
    ui: {
      setActiveMachine: vi.fn(),
      setActiveTab: vi.fn()
    }
  }
  return {
    api,
    getSystemListener: () => systemListener,
    getStatusListener: () => statusListener,
    refreshSpecs: vi.fn(),
    seedSnapshots: vi.fn(),
    clearBus: vi.fn()
  }
})

vi.mock('@/lib/api', () => ({ api: mocks.api }))
vi.mock('@/lib/ws-client', () => ({
  wsClient: {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    onStateChange: null,
    onReconnected: null,
    onUnauthorized: null
  }
}))
vi.mock('@/lib/module-bus', () => ({
  clearModule: vi.fn(),
  clearModuleBus: mocks.clearBus
}))
vi.mock('@/lib/module-registry', () => ({
  seedModuleSnapshots: mocks.seedSnapshots,
  subscribeModuleStreams: vi.fn(() => () => undefined),
  useModuleSpecs: {
    getState: () => ({ refresh: mocks.refreshSpecs })
  }
}))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn() }
}))

let useApp: typeof import('@/state/store').useApp

const alpha = {
  machineId: 'tester@alpha',
  revision: 1,
  connected: true,
  mode: 'ssh' as const,
  host: 'alpha',
  port: 22,
  username: 'tester'
}
const beta = {
  machineId: 'tester@beta',
  revision: 1,
  connected: true,
  mode: 'ssh' as const,
  host: 'beta',
  port: 22,
  username: 'tester'
}

function snapshot(t: number, hostname: string): SystemSnapshot {
  return {
    t,
    cpu: { total: 1, perCore: [1] },
    mem: { total: 10, used: 1, available: 9, swapTotal: 0, swapUsed: 0 },
    netRx: 0,
    netTx: 0,
    diskRead: 0,
    diskWrite: 0,
    load: [0, 0, 0],
    uptimeSec: 1,
    hostname
  }
}

beforeAll(async () => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))
  })
  mocks.api.auth.status.mockResolvedValue({
    authEnabled: false,
    authenticated: true,
    username: 'bored-admin',
    locked: false
  })
  mocks.api.settings.get.mockResolvedValue({
    ...DEFAULT_SETTINGS,
    densityAutoDetected: true
  })
  mocks.api.connection.status.mockResolvedValue([alpha, beta])
  mocks.api.modules.list.mockResolvedValue([])
  mocks.api.terminals.list.mockResolvedValue([])
  mocks.api.update.consumeResult.mockResolvedValue(null)
  mocks.refreshSpecs.mockResolvedValue(undefined)
  mocks.api.metrics.history.mockImplementation(async (machineId: string) => ({
    system: [snapshot(machineId === alpha.machineId ? 1 : 2, machineId)],
    top: null,
    services: null,
    modules: {}
  }))
  ;({ useApp } = await import('@/state/store'))
})

describe('multi-machine renderer state', () => {
  it('reseeds on switch and ignores live samples for another machine', async () => {
    sessionStorage.clear()
    await useApp.getState().init()

    expect(useApp.getState().activeMachineId).toBe(alpha.machineId)
    expect(useApp.getState().system.at(-1)?.hostname).toBe(alpha.machineId)

    mocks.getSystemListener()?.({
      machineId: beta.machineId,
      data: snapshot(Date.now(), 'wrong')
    })
    expect(useApp.getState().system.at(-1)?.hostname).toBe(alpha.machineId)

    mocks.getSystemListener()?.({
      machineId: alpha.machineId,
      data: snapshot(Date.now(), 'alpha-live')
    })
    expect(useApp.getState().system.at(-1)?.hostname).toBe('alpha-live')

    await useApp.getState().setActiveMachine(beta.machineId)
    expect(useApp.getState().status.host).toBe('beta')
    expect(useApp.getState().system.at(-1)?.hostname).toBe(beta.machineId)
    expect(mocks.api.ui.setActiveMachine).toHaveBeenLastCalledWith(beta.machineId)
    expect(sessionStorage.getItem('bm.activeMachine')).toBe(beta.machineId)
  })

  it('refreshes module specs before seeding after connect', async () => {
    await useApp.getState().init()
    mocks.refreshSpecs.mockClear()
    mocks.api.metrics.history.mockClear()
    const order: string[] = []
    mocks.refreshSpecs.mockImplementation(async () => {
      order.push('refresh')
    })
    mocks.api.metrics.history.mockImplementation(async (machineId: string) => {
      order.push('history')
      return {
        system: [snapshot(1, machineId)],
        top: null,
        services: null,
        modules: {}
      }
    })
    mocks.api.connection.connect.mockResolvedValue({ ok: true, machineId: alpha.machineId })
    mocks.api.connection.status.mockResolvedValue([alpha])

    await useApp.getState().connect({ mode: 'local' })

    expect(mocks.refreshSpecs).toHaveBeenCalled()
    expect(order.indexOf('refresh')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('history')).toBeGreaterThan(order.indexOf('refresh'))
  })

  it('refreshes module specs before seeding after reconnect', async () => {
    await useApp.getState().init()
    mocks.refreshSpecs.mockClear()
    mocks.api.metrics.history.mockClear()
    const order: string[] = []
    mocks.refreshSpecs.mockImplementation(async () => {
      order.push('refresh')
    })
    mocks.api.metrics.history.mockImplementation(async (machineId: string) => {
      order.push('history')
      return {
        system: [snapshot(1, machineId)],
        top: null,
        services: null,
        modules: {}
      }
    })
    mocks.api.connection.reconnect.mockResolvedValue({ ok: true, machineId: beta.machineId })
    mocks.api.connection.status.mockResolvedValue([beta])

    await useApp.getState().reconnect('tester@beta')

    expect(mocks.refreshSpecs).toHaveBeenCalled()
    expect(order.indexOf('refresh')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('history')).toBeGreaterThan(order.indexOf('refresh'))
  })

  it('refreshes module specs when another client connects a new machine', async () => {
    await useApp.getState().init()
    mocks.refreshSpecs.mockClear()
    const gamma = {
      ...beta,
      machineId: 'tester@gamma',
      host: 'gamma'
    }
    mocks.getStatusListener()?.([alpha, beta, gamma])
    await vi.waitFor(() => {
      expect(mocks.refreshSpecs).toHaveBeenCalled()
    })
  })
})
