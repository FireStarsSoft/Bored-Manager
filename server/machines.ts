import type {
  ConnectionConfig,
  MachineStatus,
  PkgActionState,
  SystemSnapshot,
  TopConsumersSnapshot
} from '@shared/types'
import { ConnectionManager, type ConnectOutcome } from './connection'
import { MetricsHistoryService, machineIdFor } from './services/history'
import { PackagesService } from './services/packages'
import { SystemMetricsService } from './services/metrics'
import { TopConsumersService } from './services/top'

export interface MachineConfig {
  mode: ConnectionConfig['mode']
  label?: string
  host?: string
  port: number
  username?: string
}

/** Everything whose counters, cache or lifetime belongs to one target. */
export interface MachineContext {
  readonly id: string
  readonly manager: ConnectionManager
  readonly history: MetricsHistoryService
  readonly systemMetrics: SystemMetricsService
  readonly topService: TopConsumersService
  readonly packagesService: PackagesService
  config: MachineConfig
  revision: number
  savedConnectionId?: string
}

export interface MachinePoolOptions {
  createManager?: () => ConnectionManager
  onSystem?: (machineId: string, snapshot: SystemSnapshot) => void
  onTop?: (machineId: string, snapshot: TopConsumersSnapshot) => void
  onPackageLog?: (machineId: string, data: string) => void
  onPackageState?: (machineId: string, state: PkgActionState) => void
  /** Synchronous by design: ConnectionManager swaps only after this returns. */
  onBeforeSwap?: (machine: MachineContext) => void
  onLost?: (machine: MachineContext) => void
}

export interface MachineConnectResult {
  machine: MachineContext
  outcome: ConnectOutcome
  created: boolean
}

export function savedConnectionIdFor(config: {
  mode: ConnectionConfig['mode']
  host?: string
  port?: number
  username?: string
}): string | undefined {
  if (config.mode !== 'ssh' || !config.host || !config.username) return undefined
  return `${config.username}@${config.host}:${config.port || 22}`
}

/**
 * Process-wide pool of live targets. Each entry owns independent collectors,
 * rate baselines, package actions and history buffers.
 */
export class MachinePool {
  private readonly machines = new Map<string, MachineContext>()

  constructor(private readonly options: MachinePoolOptions = {}) {}

  async connect(config: ConnectionConfig): Promise<MachineConnectResult> {
    const id = machineIdFor(config.mode, config.host, config.username)
    const existing = this.machines.get(id)
    const machine = existing ?? this.createMachine(id, config)
    const previousConfig = machine.config
    if (!existing) this.machines.set(id, machine)

    try {
      const outcome = await machine.manager.connect(config)
      machine.config = this.committedConfig(config)
      machine.revision++
      machine.savedConnectionId = savedConnectionIdFor(config)
      return { machine, outcome, created: !existing }
    } catch (error) {
      if (
        !existing &&
        this.machines.get(id) === machine &&
        !machine.manager.connected &&
        machine.manager.phase === 'idle'
      ) {
        this.machines.delete(id)
      }
      else machine.config = previousConfig
      throw error
    }
  }

  get(machineId: string): MachineContext | undefined {
    return this.machines.get(machineId)
  }

  require(machineId: string): MachineContext {
    const machine = this.machines.get(machineId)
    if (!machine?.manager.connected) throw new Error(`machine "${machineId}" is not connected`)
    return machine
  }

  values(): MachineContext[] {
    return [...this.machines.values()].filter((machine) => machine.manager.connected)
  }

  firstConnected(): MachineContext | undefined {
    return this.values()[0]
  }

  anyConnected(): boolean {
    return this.values().length > 0
  }

  list(): MachineStatus[] {
    return this.values()
      .map((machine) => this.status(machine))
      .sort((a, b) => (a.label ?? a.machineId).localeCompare(b.label ?? b.machineId))
  }

  status(machine: MachineContext): MachineStatus {
    const status = machine.manager.status()
    return {
      ...status,
      machineId: machine.id,
      revision: machine.revision,
      port: machine.config.port,
      label: status.label ?? machine.config.label
    }
  }

  async disconnect(machineId: string): Promise<void> {
    const machine = this.machines.get(machineId)
    if (!machine) return
    this.machines.delete(machineId)
    await machine.manager.disconnect()
  }

  async disconnectAll(): Promise<void> {
    const machines = [...this.machines.values()]
    this.machines.clear()
    await Promise.allSettled(machines.map((machine) => machine.manager.disconnect()))
  }

  private createMachine(id: string, config: ConnectionConfig): MachineContext {
    const manager = this.options.createManager?.() ?? new ConnectionManager()
    const history = new MetricsHistoryService(id)
    const machine: MachineContext = {
      id,
      manager,
      history,
      systemMetrics: new SystemMetricsService(
        (snapshot) => this.options.onSystem?.(id, snapshot),
        manager,
        `system-metrics:${id}`
      ),
      topService: new TopConsumersService(
        (snapshot) => this.options.onTop?.(id, snapshot),
        manager,
        `top-consumers:${id}`
      ),
      packagesService: new PackagesService(
        (data) => this.options.onPackageLog?.(id, data),
        (state) => this.options.onPackageState?.(id, state),
        manager,
        `packages:${id}`
      ),
      config: this.committedConfig(config),
      revision: 0,
      savedConnectionId: savedConnectionIdFor(config)
    }

    manager.setBeforeSwap(() => this.options.onBeforeSwap?.(machine))
    manager.onConnectionLost(() => {
      if (this.machines.get(id) !== machine) return
      this.machines.delete(id)
      this.options.onLost?.(machine)
    })
    return machine
  }

  private committedConfig(config: ConnectionConfig): MachineConfig {
    return {
      mode: config.mode,
      label: config.label,
      host: config.mode === 'local' ? 'localhost' : config.host,
      port: config.mode === 'local' ? 0 : config.port || 22,
      username: config.username
    }
  }
}
