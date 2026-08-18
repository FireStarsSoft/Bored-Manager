import { create } from 'zustand'
import { toast } from 'sonner'
import type {
  AppSettings,
  AuthSettings,
  AuthStatus,
  ConnectionConfig,
  ConnectionStatus,
  OkResult,
  Density,
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
import { wsClient, type WsState } from '@/lib/ws-client'

const HISTORY_MS = 5 * 60 * 1000

/**
 * How many connection changes this browser started and has not finished. The
 * server tells every client when the shared target machine is connected or
 * disconnected, including the client that asked for it - and that one already
 * knows, so it must not report its own action as somebody else's.
 */
let selfChanging = 0

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
  connect(cfg: ConnectionConfig): Promise<OkResult>
  disconnect(): Promise<void>
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
    api.metrics.onSystem((s) => set((st) => ({ system: prune([...st.system, s]) })))
    api.metrics.onTop((s) => set({ topNow: s }))
    api.metrics.onServices((s) => set({ servicesNow: s }))
    // Every module's declared streams land in the module bus, not here.
    subscribeModuleStreams()
    api.modules.onListChanged((list) => get().setModules(list))
    api.connection.onLost(() => {
      set({ status: { connected: false }, ...emptySession() })
      get().showNotice('error', 'Connection to the target machine was lost')
    })
    api.connection.onStatus((status) => {
      if (selfChanging > 0) {
        set({ status })
        return
      }
      const was = get().status.connected
      if (status.connected && !was) {
        void get().reseed().catch((err) => get().showNotice('error', errorMessage(err)))
        get().showNotice('info', `Another client connected to ${status.label ?? 'a machine'}`)
        return
      }
      if (!status.connected && was) {
        set({ status, ...emptySession() })
        get().showNotice('info', 'Another client disconnected the target machine')
        return
      }
      set({ status })
    })
    api.terminals.onExit(() => void get().refreshTerminals())

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
      status: { connected: false },
      modules: [],
      enabledModules: [],
      ...emptySession()
    })
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
    const [status, modules] = await Promise.all([api.connection.status(), api.modules.list()])
    get().setModules(modules)
    // setModules already kicks this off, but does not wait for it - seeding
    // right after needs the specs (a module's `streams`) to already be there.
    await useModuleSpecs.getState().refresh()
    if (!status.connected) {
      set({ status, ...emptySession() })
      return
    }
    const history = await api.metrics.history()
    set({ ...emptySession(), status })
    seedModuleSnapshots(history.modules)
    set({ system: history.system, topNow: history.top, servicesNow: history.services })
    await get().refreshTerminals()
    // A fresh socket has no active tab on the server side yet.
    api.ui.setActiveTab(get().activeTab)
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
      const [status, history] = await Promise.all([
        api.connection.status(),
        api.metrics.history()
      ])
      // Drop the previous session before seeding: a stream the new machine has
      // not produced yet would otherwise still be showing the old one's data.
      set({ ...emptySession(), status, activeTab: 'overview' })
      seedModuleSnapshots(history.modules)
      set({ system: history.system, topNow: history.top, servicesNow: history.services })
      await get().refreshTerminals()
      api.ui.setActiveTab('overview')
      return res
    } finally {
      selfChanging--
      set({ connecting: false })
    }
  },

  async disconnect() {
    selfChanging++
    try {
      await api.connection.disconnect()
    } finally {
      selfChanging--
    }
    set({ status: { connected: false }, ...emptySession() })
  },

  setActiveTab(tab) {
    set({ activeTab: tab })
    // Main process starts/stops the tab-scoped detail collectors on this.
    api.ui.setActiveTab(tab)
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
      const terminals = await api.terminals.list()
      set({ terminals })
    } catch (err) {
      get().showNotice('error', errorMessage(err))
    }
  },

  // The owning module pushes the fresh snapshot itself, so this only has to
  // keep the button spinning until the reading is in.
  async refreshSlow(target) {
    if (get().slowRefreshing[target]) return
    set((st) => ({ slowRefreshing: { ...st.slowRefreshing, [target]: true } }))
    try {
      await api.metrics.refreshSlow(target)
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
