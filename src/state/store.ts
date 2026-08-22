import { create } from 'zustand'
import { toast } from 'sonner'
import type {
  AppSettings,
  AuthSettings,
  AuthStatus,
  ConnectionConfig,
  ConnectionResult,
  ConnectionStatus,
  Density,
  MachineStatus,
  ServerSettings,
  ServicesSnapshot,
  SystemSnapshot,
  TerminalInfo,
  Theme,
  TopConsumersSnapshot,
  UpdateSettings
} from '@shared/types'
import type { ModuleDescriptor } from '@shared/modules'
import { api, type SavedSettings } from '@/lib/api'
import { clearModule, clearModuleBus } from '@/lib/module-bus'
import { seedModuleSnapshots, subscribeModuleStreams, useModuleSpecs } from '@/lib/module-registry'
import { errorMessage, pruneByAge } from '@/lib/utils'
import {
  reportActiveTab,
  startDocumentVisibilityTracking
} from '@/lib/visibility'
import { wsClient, type WsState } from '@/lib/ws-client'

const HISTORY_MS = 5 * 60 * 1000

/**
 * How many connection changes this browser started and has not finished. The
 * server tells every client when the shared target machine is connected or
 * disconnected, including the client that asked for it - and that one already
 * knows, so it must not report its own action as somebody else's.
 */
let selfChanging = 0
let machineSeedGeneration = 0

const ACTIVE_MACHINE_KEY = 'bm.activeMachine'
const SESSION_MACHINES_KEY = 'bm.sessionMachines'

export interface SessionMachine {
  machineId: string
  mode: ConnectionConfig['mode']
  label?: string
  host?: string
  port?: number
  username?: string
  savedId?: string
}

function readSessionMachines(): SessionMachine[] {
  try {
    const value = JSON.parse(sessionStorage.getItem(SESSION_MACHINES_KEY) ?? '[]') as unknown
    return Array.isArray(value)
      ? value.filter(
          (item): item is SessionMachine =>
            !!item &&
            typeof item === 'object' &&
            typeof (item as SessionMachine).machineId === 'string' &&
            ((item as SessionMachine).mode === 'local' || (item as SessionMachine).mode === 'ssh')
        )
      : []
  } catch {
    return []
  }
}

function writeSessionMachines(machines: SessionMachine[]): void {
  try {
    sessionStorage.setItem(SESSION_MACHINES_KEY, JSON.stringify(machines))
  } catch {
    /* storage can be unavailable in a hardened browser */
  }
}

function storedActiveMachine(): string | null {
  try {
    return sessionStorage.getItem(ACTIVE_MACHINE_KEY)
  } catch {
    return null
  }
}

function persistActiveMachine(machineId: string | null): void {
  try {
    if (machineId) sessionStorage.setItem(ACTIVE_MACHINE_KEY, machineId)
    else sessionStorage.removeItem(ACTIVE_MACHINE_KEY)
  } catch {
    /* storage can be unavailable in a hardened browser */
  }
}

function sessionMachineFromStatus(machine: MachineStatus): SessionMachine {
  return {
    machineId: machine.machineId,
    mode: machine.mode ?? 'ssh',
    label: machine.label,
    host: machine.host,
    port: machine.port,
    username: machine.username,
    savedId:
      machine.mode === 'ssh' && machine.username && machine.host
        ? `${machine.username}@${machine.host}:${machine.port || 22}`
        : undefined
  }
}

function mergeSessionMachines(
  current: SessionMachine[],
  connected: MachineStatus[]
): SessionMachine[] {
  const byId = new Map(current.map((machine) => [machine.machineId, machine]))
  for (const machine of connected) byId.set(machine.machineId, sessionMachineFromStatus(machine))
  const result = [...byId.values()]
  writeSessionMachines(result)
  return result
}

/**
 * A page id. Either one of the app's own (`overview`, `packages`, `terminals`,
 * `settings` - see CORE_TABS in Dashboard.tsx) or a module page
 * `'<moduleId>/<pageId>'` (e.g. `'disk/devices'`), which is why this is a
 * plain string rather than a union.
 */
export type TabId = string

/**
 * What a settings control may change. The nested blocks are merged over the
 * current value, so a card can save one field without restating the rest.
 */
export type SettingsPatch = Partial<Omit<AppSettings, 'server' | 'auth' | 'update'>> & {
  server?: Partial<ServerSettings>
  auth?: Partial<AuthSettings>
  update?: Partial<UpdateSettings>
}

function prune<T extends { t: number }>(arr: T[]): T[] {
  return pruneByAge(arr, HISTORY_MS)
}

/** Everything a session collects, cleared on connect, disconnect and loss. */
function emptySession(): {
  system: SystemSnapshot[]
  topNow: TopConsumersSnapshot | null
  servicesNow: ServicesSnapshot | null
  terminals: TerminalInfo[]
} {
  clearModuleBus()
  return { system: [], topNow: null, servicesNow: null, terminals: [] }
}

interface AppState {
  initialized: boolean
  /** Set when init/boot failed so the splash can offer a retry. */
  initError: string | null
  /** The socket to the Bored Manager server, not to the monitored machine. */
  server: WsState
  /** null until the server has been asked whether a login is required. */
  auth: AuthStatus | null
  /** Every target currently connected to the shared server pool. */
  machines: MachineStatus[]
  /** The target this browser is rendering. */
  activeMachineId: string | null
  /** Targets seen by this browser tab, including disconnected ones. */
  sessionMachines: SessionMachine[]
  /** Compatibility view of the active machine for existing core components. */
  status: ConnectionStatus
  settings: AppSettings | null
  /** The theme after resolving 'system'; see applyTheme. */
  dark: boolean
  activeTab: TabId
  /** Installed modules as the main process reports them. */
  modules: ModuleDescriptor[]
  /** Ids of the modules that are switched on, derived from `modules`. */
  enabledModules: string[]
  system: SystemSnapshot[]
  topNow: TopConsumersSnapshot | null
  /** What the app itself is running right now (services-tracker.ts), for the "App services" card. */
  servicesNow: ServicesSnapshot | null
  /** Chart range of the Overview, shared with the cards modules contribute. */
  overviewWindow: number
  /** Slow sections with a manual refresh in flight, keyed by settings key. */
  slowRefreshing: Record<string, boolean>
  terminals: TerminalInfo[]
  connecting: boolean

  init(): Promise<void>
  /** Re-run auth/boot after a failed init without re-subscribing. */
  retryInit(): Promise<void>
  /** Ask whether a login is needed, then open the socket if it is not. */
  startSession(): Promise<void>
  /** Opens the socket and loads everything; also used right after a login. */
  boot(): Promise<void>
  /**
   * Pick up a session that was created while the app was already open, by
   * switching the login on from Settings. The socket predates the session and
   * the server only reads the cookie when a socket is opened, so it is replaced.
   */
  adoptSession(): Promise<void>
  /** Drop the session and show the login form again. */
  requireLogin(reason?: string): void
  logout(): Promise<void>
  /** Pull the current server-side state again, after (re)connecting to it. */
  reseed(): Promise<void>
  connect(cfg: ConnectionConfig): Promise<ConnectionResult>
  reconnect(savedId: string, confirmation?: ConnectionConfig['hostKeyConfirmation']): Promise<ConnectionResult>
  disconnect(machineId?: string): Promise<void>
  setActiveMachine(machineId: string | null): Promise<void>
  setActiveTab(tab: TabId): void
  setOverviewWindow(sec: number): void
  updateSettings(patch: SettingsPatch): Promise<SavedSettings>
  setSettingsFull(s: AppSettings): void
  setModules(list: ModuleDescriptor[]): void
  /** Raises a toast; the signature predates sonner and is kept for its callers. */
  showNotice(kind: 'error' | 'info', text: string): void
  refreshTerminals(): Promise<void>
  refreshSlow(target: string): Promise<void>
}

export const useApp = create<AppState>((set, get) => ({
  initialized: false,
  initError: null,
  server: 'closed',
  auth: null,
  machines: [],
  activeMachineId: storedActiveMachine(),
  sessionMachines: readSessionMachines(),
  status: { connected: false },
  settings: null,
  dark: document.documentElement.classList.contains('dark'),
  activeTab: 'overview',
  modules: [],
  enabledModules: [],
  ...emptySession(),
  overviewWindow: 60,
  slowRefreshing: {},
  connecting: false,

  async init() {
    if (get().initialized) return
    set({ initialized: true, initError: null })

    // Nothing can be asked before the socket is up, and everything has to be
    // asked again after it came back: the server may have been restarted, or
    // the target machine may have been connected from another browser.
    wsClient.onStateChange = (server) => set({ server })
    wsClient.onReconnected = () => void get().reseed().catch((err) => get().showNotice('error', errorMessage(err)))
    wsClient.onUnauthorized = (reason) =>
      get().requireLogin(
        reason === 'login required'
          ? 'This server now requires a login.'
          : 'Your session expired. Please log in again.'
      )

    // Subscriptions live on the client, not on the socket, so they are set up
    // once and survive both a reconnect and a new login.
    api.metrics.onSystem(({ machineId, data }) => {
      if (machineId === get().activeMachineId) {
        set((st) => ({ system: prune([...st.system, data]) }))
      }
    })
    api.metrics.onTop(({ machineId, data }) => {
      if (machineId === get().activeMachineId) set({ topNow: data })
    })
    api.metrics.onServices((s) => set({ servicesNow: s }))
    // Every module's declared streams land in the module bus, not here.
    subscribeModuleStreams(() => get().activeMachineId)
    api.modules.onListChanged((list) => get().setModules(list))
    api.connection.onLost(({ machineId }) => {
      const machine = get().machines.find((entry) => entry.machineId === machineId)
      get().showNotice(
        'error',
        `Connection to ${machine?.label ?? machine?.host ?? machineId} was lost`
      )
    })
    api.connection.onStatus((machines) => {
      const before = get().machines
      const beforeIds = new Set(before.map((machine) => machine.machineId))
      const nextIds = new Set(machines.map((machine) => machine.machineId))
      const sessionMachines = mergeSessionMachines(get().sessionMachines, machines)
      const current = get().activeMachineId
      const preferred =
        (current && nextIds.has(current) ? current : null) ??
        (storedActiveMachine() && nextIds.has(storedActiveMachine()!) ? storedActiveMachine() : null) ??
        machines[0]?.machineId ??
        null
      const activeRevisionChanged =
        preferred != null &&
        preferred === current &&
        before.find((machine) => machine.machineId === preferred)?.revision !==
          machines.find((machine) => machine.machineId === preferred)?.revision

      set({ machines, sessionMachines })
      if (preferred !== current || activeRevisionChanged) {
        void get()
          .setActiveMachine(preferred)
          .catch((err) => get().showNotice('error', errorMessage(err)))
      } else {
        set({ status: machines.find((machine) => machine.machineId === preferred) ?? { connected: false } })
      }

      if (selfChanging === 0) {
        if (activeRevisionChanged && preferred) {
          const machine = machines.find((entry) => entry.machineId === preferred)
          get().showNotice(
            'info',
            `Another client reconnected ${machine?.label ?? machine?.host ?? preferred}`
          )
        }
        for (const machine of machines) {
          if (!beforeIds.has(machine.machineId)) {
            get().showNotice(
              'info',
              `Another client connected to ${machine.label ?? machine.host ?? machine.machineId}`
            )
          }
        }
        for (const machine of before) {
          if (!nextIds.has(machine.machineId)) {
            get().showNotice(
              'info',
              `Another client disconnected ${machine.label ?? machine.host ?? machine.machineId}`
            )
          }
        }
      }
    })
    api.terminals.onExit(() => void get().refreshTerminals())
    startDocumentVisibilityTracking(() => get().activeTab)

    await get().startSession()
  },

  async retryInit() {
    set({ initError: null })
    if (!get().initialized) {
      await get().init()
      return
    }
    await get().startSession()
  },

  async startSession() {
    try {
      // Whether a login is needed is the first thing to know: with one required
      // and no session, opening the socket would only be refused.
      const auth = await api.auth.status()
      set({ auth, initError: null })
      if (auth.authEnabled && !auth.authenticated) return
      await get().boot()
    } catch (err) {
      set({ initError: errorMessage(err) })
    }
  },

  async boot() {
    await wsClient.connect()
    let settings = await api.settings.get()
    // First run: pick density from the actual screen resolution.
    if (!settings.densityAutoDetected) {
      const w = window.screen.width * (window.devicePixelRatio || 1)
      const density: Density = w >= 2304 ? 'high' : w >= 1728 ? 'medium' : 'low'
      settings = await api.settings.set({ ...settings, density, densityAutoDetected: true })
    }
    applyDensity(settings.density)
    applyTheme(settings.theme)
    set({ settings, overviewWindow: settings.historyWindow })
    await get().reseed()

    // First start after an update: report what the update script did.
    const result = await api.update.consumeResult()
    if (result?.ok) {
      const quarantined = (result.quarantined ?? []).filter(Boolean)
      const extra = quarantined.length
        ? `. These modules could not be built against the new version and were moved to modules-disabled/: ${quarantined.join(', ')}`
        : ''
      get().showNotice(
        'info',
        `Bored Manager was updated${result.version ? ` to version ${result.version}` : ''}${extra}`
      )
    } else if (result) {
      get().showNotice('error', `Update failed: ${result.error || 'see data/update.log'}`)
    }
  },

  async adoptSession() {
    try {
      const auth = await api.auth.status()
      set({ auth })
      wsClient.disconnect()
      await get().boot()
    } catch (err) {
      get().showNotice('error', errorMessage(err))
    }
  },

  requireLogin(reason) {
    wsClient.disconnect()
    set({
      auth: { authEnabled: true, authenticated: false, username: null, locked: false },
      settings: null,
      machines: [],
      activeMachineId: null,
      sessionMachines: [],
      status: { connected: false },
      modules: [],
      enabledModules: [],
      ...emptySession()
    })
    persistActiveMachine(null)
    writeSessionMachines([])
    if (reason) get().showNotice('error', reason)
  },

  async logout() {
    await api.auth.logout()
    get().requireLogin()
  },

  /**
   * The server holds the session, not the browser: on a reload - or on a
   * reconnect after the socket dropped - what it already collected is fetched
   * back instead of starting from an empty page.
   */
  async reseed() {
    const [machines, modules] = await Promise.all([api.connection.status(), api.modules.list()])
    get().setModules(modules)
    // setModules already kicks this off, but does not wait for it - seeding
    // right after needs the specs (a module's `streams`) to already be there.
    await useModuleSpecs.getState().refresh()
    const sessionMachines = mergeSessionMachines(get().sessionMachines, machines)
    set({ machines, sessionMachines })
    const current = get().activeMachineId
    const stored = storedActiveMachine()
    const active =
      (current && machines.some((machine) => machine.machineId === current) ? current : null) ??
      (stored && machines.some((machine) => machine.machineId === stored) ? stored : null) ??
      machines[0]?.machineId ??
      null
    if (!active) {
      persistActiveMachine(null)
      api.ui.setActiveMachine(null)
      set({ activeMachineId: null, status: { connected: false }, ...emptySession() })
      return
    }
    await get().setActiveMachine(active)
  },

  async connect(cfg) {
    set({ connecting: true })
    selfChanging++
    try {
      const res = await api.connection.connect(cfg)
      if (!res.ok) {
        if (!res.hostKey) get().showNotice('error', res.error || 'Connection failed')
        return res
      }
      if (res.error) {
        // Connected, but with a warning (e.g. sudo password rejected).
        get().showNotice('error', res.error)
      }
      const machines = await api.connection.status()
      const sessionMachines = mergeSessionMachines(get().sessionMachines, machines)
      set({ machines, sessionMachines, activeTab: 'overview' })
      if (res.machineId) await get().setActiveMachine(res.machineId)
      reportActiveTab('overview')
      return res
    } finally {
      selfChanging--
      set({ connecting: false })
    }
  },

  async reconnect(savedId, confirmation) {
    set({ connecting: true })
    selfChanging++
    try {
      const res = await api.connection.reconnect(savedId, confirmation)
      if (!res.ok) {
        if (!res.hostKey && !res.needsCredentials) {
          get().showNotice('error', res.error || 'Reconnect failed')
        }
        return res
      }
      if (res.error) get().showNotice('error', res.error)
      const machines = await api.connection.status()
      const sessionMachines = mergeSessionMachines(get().sessionMachines, machines)
      set({ machines, sessionMachines })
      if (res.machineId) await get().setActiveMachine(res.machineId)
      return res
    } finally {
      selfChanging--
      set({ connecting: false })
    }
  },

  async disconnect(machineId) {
    const id = machineId ?? get().activeMachineId
    if (!id) return
    selfChanging++
    try {
      await api.connection.disconnect(id)
    } finally {
      selfChanging--
    }
    await get().reseed()
  },

  async setActiveMachine(machineId) {
    const generation = ++machineSeedGeneration
    const machine = machineId
      ? get().machines.find((entry) => entry.machineId === machineId)
      : undefined
    if (!machine) {
      persistActiveMachine(null)
      api.ui.setActiveMachine(null)
      set({ activeMachineId: null, status: { connected: false }, ...emptySession() })
      return
    }

    persistActiveMachine(machine.machineId)
    api.ui.setActiveMachine(machine.machineId)
    set({
      ...emptySession(),
      activeMachineId: machine.machineId,
      status: machine
    })
    const history = await api.metrics.history(machine.machineId)
    if (generation !== machineSeedGeneration || get().activeMachineId !== machine.machineId) return
    seedModuleSnapshots(history.modules)
    set({ system: history.system, topNow: history.top, servicesNow: history.services })
    await get().refreshTerminals()
    reportActiveTab(get().activeTab)
  },

  setActiveTab(tab) {
    set({ activeTab: tab })
    // Main process starts/stops the tab-scoped detail collectors on this.
    reportActiveTab(tab)
  },

  setOverviewWindow(sec) {
    set({ overviewWindow: sec })
  },

  async updateSettings(patch) {
    const cur = get().settings
    if (!cur) throw new Error('settings have not been loaded yet')
    const next: AppSettings = {
      ...cur,
      ...patch,
      refresh: { ...cur.refresh, ...(patch.refresh ?? {}) },
      slowRefresh: { ...cur.slowRefresh, ...(patch.slowRefresh ?? {}) },
      overviewWidgets: { ...cur.overviewWidgets, ...(patch.overviewWidgets ?? {}) },
      overviewLayout: patch.overviewLayout ?? cur.overviewLayout,
      collectors: { ...cur.collectors, ...(patch.collectors ?? {}) },
      detailPolling: { ...cur.detailPolling, ...(patch.detailPolling ?? {}) },
      history: { ...cur.history, ...(patch.history ?? {}) },
      server: { ...cur.server, ...(patch.server ?? {}) },
      auth: { ...cur.auth, ...(patch.auth ?? {}) },
      update: { ...cur.update, ...(patch.update ?? {}) }
    }
    const saved = await api.settings.set(next)
    applyDensity(saved.density)
    applyTheme(saved.theme)
    set({ settings: saved })
    return saved
  },

  setSettingsFull(s) {
    applyDensity(s.density)
    applyTheme(s.theme)
    set({ settings: s })
  },

  setModules(list) {
    const enabled = list.filter((m) => m.state.enabled && !m.problem).map((m) => m.manifest.id)
    // A module that was just switched off keeps its last snapshot in the bus,
    // which would look current when it is switched back on.
    for (const id of get().enabledModules) {
      if (!enabled.includes(id)) clearModule(id)
    }
    set({ modules: list, enabledModules: enabled })
    // Whatever changed the list - install, uninstall, reload, enable, disable
    // - the pages and widgets it renders from need a fresh copy too.
    void useModuleSpecs.getState().refresh()
  },

  showNotice(kind, text) {
    if (kind === 'error') toast.error(text)
    else toast.info(text)
  },

  async refreshTerminals() {
    try {
      const machineId = get().activeMachineId
      const terminals = (await api.terminals.list()).filter(
        (terminal) => terminal.machineId === machineId
      )
      set({ terminals })
    } catch (err) {
      get().showNotice('error', errorMessage(err))
    }
  },

  // The owning module pushes the fresh snapshot itself, so this only has to
  // keep the button spinning until the reading is in.
  async refreshSlow(target) {
    const machineId = get().activeMachineId
    if (!machineId) return
    if (get().slowRefreshing[target]) return
    set((st) => ({ slowRefreshing: { ...st.slowRefreshing, [target]: true } }))
    try {
      await api.metrics.refreshSlow(machineId, target)
    } catch (err) {
      get().showNotice('error', errorMessage(err))
    } finally {
      set((st) => ({ slowRefreshing: { ...st.slowRefreshing, [target]: false } }))
    }
  }
}))

export function applyDensity(density: Density): void {
  document.documentElement.dataset.density = density
}

const systemDark = (): boolean => window.matchMedia('(prefers-color-scheme: dark)').matches

/**
 * Tailwind's dark variant is class-based here (see @custom-variant in
 * styles.css). `dark` is mirrored into the store because anything painting on a
 * canvas (xterm, the charts) cannot read a CSS variable through a class and has
 * to be told when the resolved scheme changed - which 'system' does without the
 * setting itself changing.
 */
export function applyTheme(theme: Theme): void {
  const dark = theme === 'dark' || (theme === 'system' && systemDark())
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  if (useApp.getState().dark !== dark) useApp.setState({ dark })
}

/** Registered once for the lifetime of the page. */
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  const theme = useApp.getState().settings?.theme
  if (theme === 'system') applyTheme(theme)
})
