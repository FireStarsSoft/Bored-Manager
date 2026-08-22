import type {
  AppSettings,
  AuthStatus,
  ConnectionConfig,
  ConnectionResult,
  HistoryPayload,
  HistoryPoint,
  HistoryStats,
  HistoryStream,
  OkResult,
  MachinePayload,
  MachineStatus,
  PackageSearchResult,
  PackagesOverview,
  PkgAction,
  PkgActionState,
  SavedConnection,
  ServicesSnapshot,
  SlowRefreshTarget,
  SystemSnapshot,
  TerminalInfo,
  TerminalPreset,
  TopConsumersSnapshot,
  UpdateResult,
  UpdateRepoInfo,
  UpdateState,
  UserAccount
} from '@shared/types'
import type { ModuleCatalog, ModuleDescriptor, ModuleInstallState } from '@shared/modules'
import type { ModuleSpecsEntry } from '@shared/module-ui'
import { createWsApi } from './ws-api'
import { wsClient } from './ws-client'

type Unsubscribe = () => void

/** What the host the server runs on is, and which version is running there. */
export interface AppInfo {
  platform: string
  version: string
}

/** Settings as they were written, plus what the write could not do live. */
export type SavedSettings = AppSettings & {
  /** The new port or host only takes effect when the server binds again. */
  restartRequired?: boolean
}

/** Why a login attempt did not work, in the terms the form has to explain. */
export interface LoginResult {
  ok: boolean
  /** Too many wrong passwords for this username or client address: only `unlock` helps now. */
  locked: boolean
  /** Attempts left before that happens. */
  remaining?: number
  error?: string
}

export interface Api {
  connection: {
    connect(cfg: ConnectionConfig): Promise<ConnectionResult>
    reconnect(savedId: string, confirmation?: ConnectionConfig['hostKeyConfirmation']): Promise<ConnectionResult>
    disconnect(machineId: string): Promise<OkResult>
    status(): Promise<MachineStatus[]>
    listSaved(): Promise<SavedConnection[]>
    getCredentials(id: string): Promise<{ password?: string; sudoPassword?: string } | null>
    deleteSaved(id: string): Promise<SavedConnection[]>
    onLost(cb: (payload: { machineId: string }) => void): Unsubscribe
    onStatus(cb: (machines: MachineStatus[]) => void): Unsubscribe
  }
  metrics: {
    history(machineId: string): Promise<HistoryPayload>
    refreshSlow(machineId: string, target: SlowRefreshTarget): Promise<void>
    onSystem(cb: (s: MachinePayload<SystemSnapshot>) => void): Unsubscribe
    onTop(cb: (s: MachinePayload<TopConsumersSnapshot>) => void): Unsubscribe
    onServices(cb: (s: ServicesSnapshot) => void): Unsubscribe
  }
  history: {
    query(
      machineId: string,
      stream: HistoryStream,
      fromMs: number,
      toMs: number,
      maxPoints?: number
    ): Promise<HistoryPoint[]>
    stats(): Promise<HistoryStats>
    flush(): Promise<HistoryStats>
    purge(): Promise<HistoryStats>
    /** Absolute path of the metrics folder on the host, to show and copy. */
    folder(): Promise<string>
  }
  ui: {
    setActiveTab(tab: string | null): void
    setActiveMachine(machineId: string | null): void
  }
  packages: {
    overview(machineId: string): Promise<PackagesOverview>
    search(machineId: string, query: string): Promise<PackageSearchResult[]>
    action(machineId: string, action: PkgAction, pkg?: string): Promise<OkResult>
    cancel(machineId: string): Promise<void>
    state(machineId: string): Promise<PkgActionState>
    onLog(cb: (payload: MachinePayload<string>) => void): Unsubscribe
    onState(cb: (payload: MachinePayload<PkgActionState>) => void): Unsubscribe
  }
  terminals: {
    create(
      machineId: string,
      preset: TerminalPreset,
      cols: number,
      rows: number,
      customCommand?: string
    ): Promise<TerminalInfo | OkResult>
    list(): Promise<TerminalInfo[]>
    buffer(id: string): Promise<string>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    dispose(id: string): Promise<void>
    onData(cb: (p: { id: string; data: string }) => void): Unsubscribe
    onExit(cb: (p: { id: string }) => void): Unsubscribe
  }
  settings: {
    get(): Promise<AppSettings>
    set(s: AppSettings): Promise<SavedSettings>
    /** Starts a browser download of the settings file. */
    export(): void
    import(file: File): Promise<OkResult & { settings?: AppSettings }>
  }
  update: {
    state(): Promise<UpdateState>
    check(url: string): Promise<UpdateState>
    checkRepo(): Promise<UpdateRepoInfo>
    /** Uploads a zip the user picked in the browser and grades it. */
    checkFile(file: File): Promise<UpdateState>
    cancel(): Promise<UpdateState>
    apply(): Promise<OkResult>
    consumeResult(): Promise<UpdateResult | null>
    onState(cb: (s: UpdateState) => void): Unsubscribe
  }
  modules: {
    list(): Promise<ModuleDescriptor[]>
    /** What every enabled module's pages and widgets render from. */
    specs(): Promise<ModuleSpecsEntry[]>
    setEnabled(id: string, enabled: boolean): Promise<ModuleDescriptor[]>
    verify(id: string): Promise<ModuleDescriptor[]>
    /** Recompile a module's main half and bring it back to life - no restart. */
    reload(id: string): Promise<{ ok: true } | { ok: false; error: string }>
    installState(): Promise<ModuleInstallState>
    checkUrl(url: string): Promise<ModuleInstallState>
    /** Uploads a zip the user picked in the browser and grades it. */
    checkFile(file: File): Promise<ModuleInstallState>
    install(confirmationToken: string): Promise<ModuleInstallState>
    uninstall(id: string): Promise<ModuleInstallState>
    cancel(): Promise<ModuleInstallState>
    onInstallState(cb: (s: ModuleInstallState) => void): Unsubscribe
    onListChanged(cb: (list: ModuleDescriptor[]) => void): Unsubscribe
    /** The community catalog, cached server-side for 24h. */
    catalog(): Promise<ModuleCatalog>
    /** Same, but skips the cache and refetches now. */
    catalogRefresh(): Promise<ModuleCatalog>
    /** Call a method a module's main half registered with `ctx.handle`. */
    invoke<T>(machineId: string, moduleId: string, method: string, args: unknown[]): Promise<T>
    /** Subscribe to an event a module's main half emits with `ctx.emit`. */
    onEvent<T>(
      moduleId: string,
      event: string,
      cb: (payload: MachinePayload<T>) => void
    ): Unsubscribe
  }
  app: {
    /** Cached after the first call; it cannot change while the page is open. */
    info(): Promise<AppInfo>
    /** Quits; the service manager or the launcher starts the server again. */
    restart(): Promise<void>
  }
  /**
   * Logging in is HTTP, not RPC: the session cookie it sets is what the
   * WebSocket is later allowed to open with. Managing accounts is RPC, because
   * by then there is a socket and it is already authenticated.
   */
  auth: {
    status(): Promise<AuthStatus>
    login(username: string, password: string): Promise<LoginResult>
    logout(): Promise<void>
    users(): Promise<UserAccount[]>
    createUser(username: string, password: string): Promise<UserAccount[]>
    deleteUser(username: string): Promise<UserAccount[]>
    setPassword(username: string, password: string): Promise<UserAccount[]>
    /** Rejects with 'set-admin-password-first' when there is no password yet. */
    setEnabled(enabled: boolean): Promise<AppSettings>
  }
}

export const api: Api = createWsApi(wsClient)
