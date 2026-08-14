import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import multer from 'multer'
import type {
  AppSettings,
  ConnectionConfig,
  DetailPollingMode,
  HistoryPayload,
  HistoryStream,
  OkResult,
  PkgAction,
  RefreshSpeed,
  ServicesSnapshot,
  SlowRefreshTarget,
  TerminalPreset
} from '@shared/types'
import { DEFAULT_USERNAME, REFRESH_INTERVAL_MS } from '@shared/types'
import { registerAuthRoutes, usernameOf } from './auth'
import { connection } from './connection'
import { registry } from './session-registry'
import type { HttpApi } from './http'
import { log } from './log'
import type { RpcClient, RpcRouter } from './rpc'
import * as users from './services/users'
import { SystemMetricsService } from './services/metrics'
import { MetricsHistoryService, hostKeyFor } from './services/history'
import { Poller } from './services/poller'
import { tracker as servicesTracker } from './services/services-tracker'
import { TopConsumersService } from './services/top'
import { PackagesService } from './services/packages'
import { TerminalService } from './services/terminals'
import { UpdaterService } from './services/updater'
import { ModulesHost, moduleTabActive } from './services/modules-host'
import { ModuleInstallerService } from './services/module-installer'
import { getCatalog } from './services/registry'
import * as store from './services/store'

let router: RpcRouter | null = null

function send(channel: string, payload: unknown): void {
  router?.broadcast(channel, payload)
}

export const metricsHistory = new MetricsHistoryService()

export const systemMetrics = new SystemMetricsService((s) => {
  metricsHistory.addSystem(s)
  send('push:system', s)
})
export const topService = new TopConsumersService((s) => send('push:top', s))

/** Latest reading of servicesPoller, for a freshly connected renderer (see metrics:history). */
let latestServices: ServicesSnapshot | null = null

/**
 * What Bored Manager itself is costing right now (see services-tracker.ts).
 * Runs on the same clock as the system stream - it is app-wide upkeep, not
 * tied to any one tab, so unlike topService it is not gated by detailPolling.
 */
const servicesPoller = new Poller('core:services', async () => {
  const snap = await servicesTracker.snapshot((cmd, opts) => connection.exec(cmd, opts))
  latestServices = snap
  send('push:services', snap)
  metricsHistory.add('services', {
    t: snap.t,
    cpu: snap.totalCpu,
    mem: snap.totalMemBytes,
    count: snap.count
  })
})

export const packagesService = new PackagesService(
  (data) => send('packages:log', data),
  (state) => send('packages:state', state)
)
/**
 * A terminal belongs to the server, not to a browser: every client sees the
 * same shells, so its output is broadcast to all of them and a client that
 * opens one later catches up through `term:buffer`.
 */
export const terminalService = new TerminalService(
  (id, data) => send('term:data', { id, data }),
  (id) => send('term:exit', { id })
)
export const updaterService = new UpdaterService((s) => send('push:update', s))

/**
 * The server-side half of every installed module. Its handlers are registered
 * and removed as modules are switched on and off, which is why it is given the
 * router's register/remove pair rather than importing them itself.
 */
export const modulesHost = new ModulesHost(
  metricsHistory,
  send,
  (channel, fn) => router?.registerHandler(channel, fn),
  (channel) => router?.removeHandler(channel),
  (msg) => log(`[modules] ${msg}`)
)

export const moduleInstaller = new ModuleInstallerService(
  modulesHost,
  (s) => send('push:modules', s),
  () => send('push:modules-list', modulesHost.list()),
  () => appSettings.update.repo
)

/**
 * A login can only be required while the default account has a password: there
 * is no reset flow, on purpose, so "required" plus "no password anywhere" locks
 * everyone out for good. `auth:setEnabled` refuses that outright; this is the
 * net under the other ways the same flag can be written - a whole-settings
 * write, an imported file, a hand-edited settings.json. Returns the settings
 * unchanged when there is nothing to correct.
 */
function withUsableAuth<T extends { auth?: AppSettings['auth'] }>(settings: T): T {
  if (settings.auth?.enabled !== true || users.hasPassword(DEFAULT_USERNAME)) return settings
  log(`"require login" switched off: "${DEFAULT_USERNAME}" has no password, so nobody could sign in`)
  return { ...settings, auth: { ...settings.auth, enabled: false } }
}

/**
 * store.saveSettings, with the guard above applied to the payload rather than
 * to the result - so an unusable "require login" never reaches the disk at all.
 */
function saveSettings(next: Partial<AppSettings>): AppSettings {
  return store.saveSettings(withUsableAuth(next))
}

/**
 * Close the sockets of clients that never logged in. They were opened while the
 * login was off - the upgrade refuses one without a session otherwise - and the
 * per-frame check only runs when a client sends something, so a browser that
 * only listens would keep receiving pushes it is no longer entitled to. The
 * socket that asked for the change is spared, so it can still read the answer.
 */
function evictUnauthenticated(except?: RpcClient): void {
  if (!appSettings.auth.enabled || !router) return
  for (const client of router.sockets()) {
    if (client !== except && !client.username) client.close(4401, 'login required')
  }
}

let appSettings = withUsableAuth(store.loadSettings())

/** The settings the server is running on, for the parts outside this file. */
export function currentSettings(): AppSettings {
  return appSettings
}

/**
 * Which account a client acts as. With a login required that is whoever is
 * logged in on that socket; with auth off there is only the default account,
 * and everything (including the saved connections) belongs to it.
 */
function ownerOf(client: RpcClient): string {
  return usernameOf({ username: client.username ?? undefined }, appSettings.auth.enabled)
}

/**
 * Which tabs are open, across every connected browser. The heavy detail
 * collectors can be limited to "while their tab is open", and with several
 * clients that means "while at least one client has it open" - so the set is
 * read from the router rather than kept as a single value here.
 */
function activeTabs(): Set<string> {
  return router?.activeTabs() ?? new Set<string>()
}

/**
 * Uploads land in the system temp folder; they are read once and deleted. The
 * name the browser sent is kept (stripped to a bare file name) because the
 * module installer reports the path it inspected back to the UI.
 */
const uploadStorage = multer.diskStorage({
  destination: (_req, _file, done) => {
    const dir = join(tmpdir(), 'bored-manager-upload')
    mkdirSync(dir, { recursive: true })
    done(null, dir)
  },
  filename: (_req, file, done) => {
    const safe = basename(file.originalname).replace(/[^\w.-]/g, '_').slice(-64)
    done(null, `${Date.now()}-${safe || 'upload'}`)
  }
})

const upload = multer({ storage: uploadStorage })
const updateUpload = multer({
  storage: uploadStorage,
  limits: { fileSize: 300 * 1024 * 1024 }
})

/**
 * Start or stop everything that polls, from the current settings, connection
 * and visible tab. The app owns three collectors (the system stream, the
 * Overview's top consumers, and the services tracker); every other one
 * belongs to a module, so the rest of the work is handed to the host.
 */
function applyPollers(): void {
  const on = connection.connected
  const tabs = activeTabs()
  const ms = (speed: RefreshSpeed): number => REFRESH_INTERVAL_MS[speed]
  const c = appSettings.collectors
  systemMetrics.configure(c)
  // The two per-process sweeps only feed a card that belongs to a module, so
  // they are skipped when that module is not running.
  topService.configure({
    perProcessIo: modulesHost.isEnabled('disk'),
    perProcessNet: modulesHost.isEnabled('network')
  })
  systemMetrics.poller.stop()
  topService.poller.stop()
  servicesPoller.stop()

  modulesHost.configure(appSettings, tabs)
  void modulesHost.apply()

  if (!on) return
  if (systemMetrics.hasEnabledSections() && ms(appSettings.refresh.system) > 0) {
    systemMetrics.poller.start(ms(appSettings.refresh.system))
  }
  // Not gated by a tab: it reports on the app's own upkeep, which keeps
  // costing whether or not anyone is looking at the Overview card for it.
  if (ms(appSettings.refresh.system) > 0) {
    servicesPoller.start(ms(appSettings.refresh.system))
  }
  // overviewTop still keys off the literal 'overview'. Module pages are
  // `'<id>/<page>'`; moduleTabActive matches the bare id or that prefix, which
  // is also how ctx.tabActive (network/disk detailPolling) decides.
  const detailOn = (mode: DetailPollingMode, tab: string): boolean =>
    mode === 'always' || (mode === 'tab' && moduleTabActive(tabs, tab))
  if (
    detailOn(appSettings.detailPolling.overviewTop, 'overview') &&
    ms(appSettings.refresh.processes) > 0
  ) {
    topService.poller.start(ms(appSettings.refresh.processes))
  }
}

async function teardownSession(): Promise<void> {
  metricsHistory.setHost(null) // writes out whatever is still buffered
  modulesHost.setHostKey(null)
  terminalService.disposeAll()
  systemMetrics.reset()
  topService.reset()
  latestServices = null
  packagesService.reset()
  modulesHost.resetAll()
  applyPollers()
}

export function registerRpc(rpc: RpcRouter, api: HttpApi): void {
  router = rpc
  registerAuthRoutes(api, currentSettings)
  // Before accounts existed there was one connection list for the machine; it
  // becomes the default account's.
  const moved = store.migrateLegacyConnections()
  if (moved) log(`moved the saved connections to ${moved}`)
  metricsHistory.configure(appSettings.history)
  // A settings file written before modules existed carries a switch per
  // feature; a feature the user had turned off becomes a disabled module.
  modulesHost.init(store.takeLegacyDisabledModules())
  modulesHost.configure(appSettings, activeTabs())
  void modulesHost.apply()

  // The last browser showing a tab just went away, so whatever was collecting
  // for it has nobody left to collect for.
  rpc.onClose = (client) => {
    log(`client ${client.id} left (tab ${client.activeTab ?? 'none'})`)
    applyPollers()
  }

  connection.onConnectionLost(() => {
    void teardownSession()
    send('push:conn-lost', {})
  })

  // ---------- Connection ----------

  rpc.registerClientHandler(
    'conn:connect',
    async (client, cfg: ConnectionConfig): Promise<OkResult> => {
      await teardownSession() // drop terminals/watchers from any previous session
      let warning: string | undefined
      try {
        await connection.connect(cfg)
      } catch (err) {
        const keep = (err as { keepConnection?: boolean }).keepConnection
        if (!keep) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
        warning = err instanceof Error ? err.message : String(err)
      }
      if (cfg.mode === 'ssh' && cfg.host && cfg.username) {
        store.rememberConnection(ownerOf(client), {
          host: cfg.host,
          port: cfg.port || 22,
          username: cfg.username,
          label: cfg.label,
          password: cfg.password,
          sudoPassword: cfg.sudoPassword,
          rememberPassword: cfg.rememberPassword
        })
      }
      systemMetrics.reset()
      topService.reset()
      packagesService.reset()
      modulesHost.resetAll()
      metricsHistory.configure(appSettings.history)
      const hostKey = hostKeyFor(cfg.mode, cfg.host, cfg.username)
      metricsHistory.setHost(hostKey)
      modulesHost.setHostKey(hostKey)
      applyPollers()
      // The target machine is shared by every client, so a browser sitting on
      // the connect screen has to follow the one that connected (and the other
      // way round below) instead of showing a form for a session that exists.
      send('push:conn-status', connection.status())
      return { ok: true, error: warning }
    }
  )

  rpc.registerHandler('conn:disconnect', async (): Promise<OkResult> => {
    await teardownSession()
    await connection.disconnect()
    applyPollers()
    send('push:conn-status', connection.status())
    return { ok: true }
  })

  rpc.registerHandler('conn:status', () => connection.status())
  rpc.registerClientHandler('conn:list', (client) => store.listConnections(ownerOf(client)))
  rpc.registerClientHandler('conn:credentials', (client, id: string) =>
    store.getSavedCredentials(ownerOf(client), id)
  )
  rpc.registerClientHandler('conn:delete', (client, id: string) => {
    store.deleteConnection(ownerOf(client), id)
    return store.listConnections(ownerOf(client))
  })

  // ---------- Metrics ----------

  rpc.registerHandler(
    'metrics:history',
    (): HistoryPayload => ({
      system: systemMetrics.history,
      top: topService.latest,
      services: latestServices,
      modules: modulesHost.snapshots()
    })
  )

  // Manual refresh of a slow section; the owning module answers it.
  rpc.registerHandler('metrics:refreshSlow', (target: SlowRefreshTarget) =>
    modulesHost.refreshSlow(target)
  )

  // ---------- Metrics history (data/metrics) ----------

  rpc.registerHandler(
    'history:query',
    (stream: HistoryStream, fromMs: number, toMs: number, maxPoints?: number) =>
      metricsHistory.query(stream, fromMs, toMs, maxPoints)
  )
  rpc.registerHandler('history:stats', () => metricsHistory.stats())
  rpc.registerHandler('history:flush', () => {
    metricsHistory.flush()
    return metricsHistory.stats()
  })
  rpc.registerHandler('history:purge', () => {
    metricsHistory.purge()
    return metricsHistory.stats()
  })
  // The browser cannot open a folder on the host, so it gets the path to show.
  rpc.registerHandler('history:folder', (): string => {
    const dir = metricsHistory.dir()
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* the path is still worth showing */
    }
    return dir
  })

  // The browser reports which tab is visible so 'tab' detail polling can
  // start/stop the matching collectors accordingly. Module pages arrive as
  // `'<moduleId>/<pageId>'`; matching that back to a module is prefix-based
  // (see moduleTabActive).
  rpc.registerSend('ui:activeTab', (client, tab: string) => {
    client.activeTab = typeof tab === 'string' ? tab : 'overview'
    applyPollers()
  })

  // ---------- Packages ----------

  rpc.registerHandler('packages:overview', () => packagesService.overview())
  rpc.registerHandler('packages:search', (query: string) => packagesService.search(query))
  rpc.registerHandler('packages:action', (action: PkgAction, pkg?: string) =>
    packagesService.runAction(action, pkg)
  )
  rpc.registerHandler('packages:cancel', () => packagesService.cancelAction())
  rpc.registerHandler('packages:state', () => packagesService.getState())

  // ---------- Terminals ----------

  rpc.registerHandler(
    'term:create',
    (preset: TerminalPreset, cols: number, rows: number, customCommand?: string) =>
      terminalService.create(preset, cols, rows, customCommand)
  )
  rpc.registerHandler('term:list', () => terminalService.list())
  rpc.registerHandler('term:buffer', (id: string) => terminalService.getBuffer(id))
  rpc.registerSend('term:write', (_client, id: string, data: string) =>
    terminalService.write(id, data)
  )
  rpc.registerSend('term:resize', (_client, id: string, cols: number, rows: number) =>
    terminalService.resize(id, cols, rows)
  )
  rpc.registerHandler('term:dispose', (id: string) => terminalService.dispose(id))

  // ---------- Settings ----------

  rpc.registerHandler('settings:get', () => appSettings)
  rpc.registerClientHandler('settings:set', (client, next: AppSettings) => {
    const before = appSettings.server
    // saveSettings normalises, so the browser gets back what is on disk.
    appSettings = saveSettings(next)
    metricsHistory.configure(appSettings.history)
    applyPollers()
    // The UI switches the login through auth:setEnabled, but a whole-settings
    // write can carry the flag too, and it has to have the same consequence.
    evictUnauthenticated(client)
    // Where the server listens is decided once, when it binds the socket.
    const restartRequired =
      before.port !== appSettings.server.port || before.host !== appSettings.server.host
    return { ...appSettings, restartRequired }
  })

  // ---------- Accounts ----------
  //
  // Flat model: anyone who can log in can manage the accounts. The WebUI is a
  // tool for the people who administer the machine it watches, and a role
  // system would be pretending otherwise.

  rpc.registerHandler('auth:users', () => users.listUsers())
  rpc.registerHandler('auth:createUser', (input: { username: string; password: string }) => {
    users.createUser(String(input?.username ?? '').trim(), String(input?.password ?? ''))
    return users.listUsers()
  })
  rpc.registerClientHandler('auth:deleteUser', (client, input: { username: string }) => {
    const username = String(input?.username ?? '')
    users.deleteUser(username)
    // Sockets belonging to the account that just disappeared cannot stay.
    if (router) {
      for (const other of router.sockets()) {
        if (other.username === username) other.close(4401, 'account removed')
      }
    }
    log(`account "${username}" deleted by "${ownerOf(client)}"`)
    return users.listUsers()
  })
  rpc.registerHandler('auth:setPassword', (input: { username: string; password: string }) => {
    users.setPassword(String(input?.username ?? ''), String(input?.password ?? ''))
    return users.listUsers()
  })
  rpc.registerClientHandler('auth:setEnabled', (client, input: { enabled: boolean }) => {
    const enabled = input?.enabled === true
    // Turning the login on without a password would lock everyone out, with
    // nothing to log in with and no reset flow.
    if (enabled && !users.hasPassword(DEFAULT_USERNAME)) {
      throw new Error('set-admin-password-first')
    }
    appSettings = saveSettings({ ...appSettings, auth: { ...appSettings.auth, enabled } })
    log(`login is now ${enabled ? 'required' : 'not required'}`)
    evictUnauthenticated(client)
    return appSettings
  })

  // Export and import are HTTP, not RPC: one is a file download, the other a
  // file upload, and a WebSocket carrying JSON frames can do neither well.
  api.get('/settings/export', (_req, res) => {
    try {
      store.saveSettings(appSettings)
    } catch {
      /* an unwritable folder must not block the download */
    }
    res.download(store.settingsFile(), 'bored-manager-settings.json')
  })

  api.post('/settings/import', upload.single('file'), (req, res) => {
    const file = req.file
    if (!file) {
      res.status(400).json({ ok: false, error: 'no file was uploaded' })
      return
    }
    try {
      // Read, then save through the same funnel as a settings write, so an
      // imported file cannot set anything a settings write could not.
      appSettings = saveSettings(store.readSettingsFile(file.path))
      // An imported file written before modules existed switches features off
      // with a collector flag; honour that here as a migration would.
      modulesHost.applyLegacyDisabled(store.takeLegacyDisabledModules())
      metricsHistory.configure(appSettings.history)
      applyPollers()
      // An import that switched the login on has to close the sockets that
      // predate it, the same as the toggle does. This one is an HTTP request,
      // so there is no socket of its own to spare.
      evictUnauthenticated()
      send('push:modules-list', modulesHost.list())
      res.json({ ok: true, settings: appSettings })
    } catch (err) {
      res.status(400).json({ ok: false, error: String(err) })
    } finally {
      rmSync(file.path, { force: true })
    }
  })

  // ---------- Modules ----------

  rpc.registerHandler('modules:list', () => modulesHost.list())
  rpc.registerHandler('modules:enabledIds', () => modulesHost.enabledIds())
  rpc.registerHandler('modules:specs', () => modulesHost.specsPayload())
  rpc.registerHandler('modules:setEnabled', (id: string, enabled: boolean) => {
    modulesHost.setEnabled(id, enabled)
    return modulesHost.list()
  })
  rpc.registerHandler('modules:verify', (id: string) => {
    modulesHost.verify(id)
    return modulesHost.list()
  })
  rpc.registerHandler('modules:reload', async (id: string) => {
    const result = await modulesHost.reload(id)
    send('push:modules-list', modulesHost.list())
    return result
  })
  rpc.registerHandler('modules:installState', () => moduleInstaller.getState())
  rpc.registerHandler('modules:checkUrl', (url: string) => moduleInstaller.checkUrl(url))
  rpc.registerHandler('modules:install', () => moduleInstaller.install())
  rpc.registerHandler('modules:uninstall', (id: string) => moduleInstaller.uninstall(id))
  rpc.registerHandler('modules:cancel', () => moduleInstaller.cancel())
  rpc.registerHandler('modules:catalog', () => getCatalog(appSettings.update.repo))
  rpc.registerHandler('modules:catalogRefresh', () => getCatalog(appSettings.update.repo, true))

  // A module archive arrives as an upload; the installer grades the file on disk.
  api.post('/modules/check-file', upload.single('file'), async (req, res) => {
    const file = req.file
    if (!file) {
      res.status(400).json({ ok: false, error: 'no file was uploaded' })
      return
    }
    try {
      res.json(await moduleInstaller.checkFile(file.path))
    } finally {
      // The installer extracted what it needs into its own work folder.
      rmSync(file.path, { force: true })
    }
  })

  // ---------- App update ----------

  rpc.registerHandler('update:state', () => updaterService.getState())
  rpc.registerHandler('update:check', (url: string) => updaterService.check(url))
  rpc.registerHandler('update:checkRepo', () => updaterService.checkRepo(appSettings.update.repo))
  rpc.registerHandler('update:cancel', () => updaterService.cancel())
  rpc.registerHandler('update:apply', () => updaterService.apply())
  rpc.registerHandler('update:consumeResult', () => updaterService.consumeResult())

  api.post('/update/check-file', updateUpload.single('file'), async (req, res) => {
    const file = req.file
    if (!file) {
      res.status(400).json({ ok: false, error: 'no file was uploaded' })
      return
    }
    try {
      res.json(await updaterService.checkFile(file.path))
    } finally {
      rmSync(file.path, { force: true })
    }
  })

  // The browser cannot read process.platform of the host, but the UI needs it:
  // "Local" only makes sense when the server itself runs on Linux.
  rpc.registerHandler('app:info', () => ({
    platform: process.platform,
    version: store.appVersion()
  }))

  // Quitting is how the server restarts: systemd (or the launcher) starts it
  // again, which is the only way a new port or host takes effect. The unit is
  // Restart=on-failure, so this has to leave a non-zero exit code; a clean
  // SIGTERM would otherwise be a successful stop and stay down.
  rpc.registerHandler('app:restart', () => {
    log('restart requested from the WebUI')
    process.exitCode = 1
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 200)
  })
}

/** Full clean close: terminals, watchers, pollers, log streams, SSH connection. */
export async function cleanClose(): Promise<void> {
  metricsHistory.flush() // do not lose the samples buffered since the last batch
  modulesHost.disposeAll()
  await teardownSession()
  await registry.disposeAll(5000)
  await connection.disconnect()
}
