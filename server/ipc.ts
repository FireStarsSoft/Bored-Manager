import { mkdirSync } from 'fs'
import type {
  AppSettings,
  ConnectionConfig,
  ConnectionResult,
  DetailPollingMode,
  HistoryPayload,
  HistoryStats,
  OkResult,
  RefreshSpeed,
  ServicesSnapshot
} from '@shared/types'
import { DEFAULT_USERNAME, REFRESH_INTERVAL_MS } from '@shared/types'
import { MODULE_ARCHIVE_MAX_BYTES } from '@shared/modules'
import { registerAuthRoutes, usernameOf } from './auth'
import { runCleanClose } from './clean-close'
import { PublicError, ValidationError, internalErrorDetail } from './errors'
import { HostKeyError } from './services/known-hosts'
import { MachinePool, type MachineContext } from './machines'
import { registry } from './session-registry'
import type { HttpApi } from './http'
import { log } from './log'
import type { RpcClient, RpcRouter } from './rpc'
import {
  validateActiveTab,
  validateBoolean,
  validateConnectionConfig,
  validateCurrentSettingsEnvelope,
  validateEnabledInput,
  validateHistoryQuery,
  validateHttpsUrl,
  validateMachineId,
  validateModuleId,
  validateModuleSource,
  validateOpaqueId,
  validatePackageAction,
  validatePackageQuery,
  validateSlowTarget,
  validateTerminalCreate,
  validateTerminalData,
  validateTerminalId,
  validateTerminalSize,
  validateUserPasswordInput
} from './rpc-validation'
import * as users from './services/users'
import { MetricsHistoryService } from './services/history'
import { Poller } from './services/poller'
import { tracker as servicesTracker } from './services/services-tracker'
import { TerminalService } from './services/terminals'
import { UpdaterService } from './services/updater'
import { ModulesHost, moduleTabActive } from './services/modules-host'
import { ModuleInstallerService } from './services/module-installer'
import { getCatalog } from './services/registry'
import * as store from './services/store'
import type { SessionController } from './sessions'
import { PrivateUploadStaging } from './uploads'

let router: RpcRouter | null = null
let shuttingDown = false
const tearingDownMachines = new Set<string>()
let cleanClosePromise: Promise<void> | null = null

function send(channel: string, payload: unknown): void {
  router?.broadcast(channel, payload)
}

function sendToMachine(machineId: string, channel: string, payload: unknown): void {
  router?.broadcastToMachine(machineId, channel, payload)
}

export const appHistory = new MetricsHistoryService('_app')

export const machinePool = new MachinePool({
  onSystem: (machineId, snapshot) => {
    machinePool.get(machineId)?.history.addSystem(snapshot)
    sendToMachine(machineId, 'push:system', { machineId, data: snapshot })
  },
  onTop: (machineId, snapshot) =>
    sendToMachine(machineId, 'push:top', { machineId, data: snapshot }),
  onPackageLog: (machineId, data) => send('packages:log', { machineId, data }),
  onPackageState: (machineId, state) => send('packages:state', { machineId, data: state }),
  onBeforeSwap: (machine) => teardownMachine(machine),
  onLost: (machine) => {
    teardownMachine(machine)
    send('push:conn-lost', { machineId: machine.id })
    send('push:conn-status', machinePool.list())
    applyPollers()
  }
})

/** Latest reading of servicesPoller, for a freshly connected renderer (see metrics:history). */
let latestServices: ServicesSnapshot | null = null

/**
 * What Bored Manager itself is costing right now (see services-tracker.ts).
 * Runs on the same clock as the system stream - it is app-wide upkeep, not
 * tied to any one tab, so unlike topService it is not gated by detailPolling.
 */
const servicesPoller = new Poller('core:services', async () => {
  const target =
    machinePool.values().find((machine) => machine.config.mode === 'local') ??
    machinePool.firstConnected()
  if (!target) return
  const snap = await servicesTracker.snapshot((cmd, opts) => target.manager.exec(cmd, opts))
  latestServices = snap
  send('push:services', snap)
  appHistory.add('services', {
    t: snap.t,
    cpu: snap.totalCpu,
    mem: snap.totalMemBytes,
    count: snap.count
  })
})
/**
 * A terminal belongs to the server, not to a browser: every client sees the
 * same shells, so its output is broadcast to all of them and a client that
 * opens one later catches up through `term:buffer`.
 */
export const terminalService = new TerminalService(
  (id, data) => send('term:data', { id, data }),
  (id) => send('term:exit', { id }),
  (machineId) => machinePool.get(machineId)?.manager
)
export const updaterService = new UpdaterService((s) => send('push:update', s))

/**
 * The server-side half of every installed module. Its handlers are registered
 * and removed as modules are switched on and off, which is why it is given the
 * router's register/remove pair rather than importing them itself.
 */
export const modulesHost = new ModulesHost(
  appHistory,
  send,
  (channel, fn) => router?.registerHandler(channel, fn),
  (channel) => router?.removeHandler(channel),
  (msg) => log(`[modules] ${msg}`),
  (machineId) => {
    const machine = machinePool.get(machineId)
    return machine
      ? { id: machine.id, manager: machine.manager, history: machine.history }
      : undefined
  },
  () => machinePool.values().map((machine) => machine.id),
  sendToMachine
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

function validatedSettings(value: unknown): AppSettings {
  const envelope = validateCurrentSettingsEnvelope(value)
  try {
    store.validateSettingsDocument(envelope)
  } catch (error) {
    throw new ValidationError(
      error instanceof Error ? error.message : 'Settings payload is invalid'
    )
  }
  return envelope as unknown as AppSettings
}

function serverSettingsChanged(
  before: AppSettings['server'],
  after: AppSettings['server']
): boolean {
  return (
    before.port !== after.port ||
    before.host !== after.host ||
    before.trustProxy !== after.trustProxy ||
    before.allowedHosts.length !== after.allowedHosts.length ||
    before.allowedHosts.some((host, index) => host !== after.allowedHosts[index])
  )
}

function rethrowUserMutation(error: unknown, username: string): never {
  const message = error instanceof Error ? error.message : ''
  if (message.includes('already exists')) {
    throw new PublicError('CONFLICT', `"${username}" already exists`, 409)
  }
  if (message.includes('does not exist')) {
    throw new PublicError('NOT_FOUND', `"${username}" does not exist`, 404)
  }
  if (message.includes('cannot be deleted')) {
    throw new PublicError('CONFLICT', `"${username}" cannot be deleted`, 409)
  }
  throw error
}

/**
 * Close sockets that no longer have a current stored session. For the socket
 * that changed the setting, RpcRouter delays the close until its result frame
 * has been written.
 */
async function evictUnauthenticated(
  sessions: SessionController,
  except?: RpcClient
): Promise<void> {
  if (!appSettings.auth.enabled || !router) return
  for (const client of router.sockets()) {
    let valid = false
    if (client.sessionId && client.username) {
      try {
        const session = await sessions.get(client.sessionId)
        valid =
          session?.username === client.username &&
          users.sessionIsCurrent(client.username, session.authVersion)
      } catch {
        valid = false
      }
    }
    if (valid) continue
    if (client === except) client.closeAfterReply(4401, 'login required')
    else client.close(4401, 'login required')
  }
}

function closeSessionSockets(sessionId: string, reason: string): void {
  if (!router || !sessionId) return
  for (const client of router.sockets()) {
    if (client.sessionId === sessionId) client.close(4401, reason)
  }
}

function closeUserSockets(username: string, reason: string, except?: RpcClient): void {
  if (!router) return
  for (const client of router.sockets()) {
    if (client.username !== username) continue
    if (client === except) client.closeAfterReply(4401, reason)
    else client.close(4401, reason)
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

function requireMachine(value: unknown): MachineContext {
  const id = validateMachineId(value)
  const machine = machinePool.get(id)
  if (!machine?.manager.connected) {
    throw new PublicError('NOT_FOUND', `Machine "${id}" is not connected`, 404)
  }
  return machine
}

/**
 * Which tabs are open, across every connected browser. The heavy detail
 * collectors can be limited to "while their tab is open", and with several
 * clients that means "while at least one client has it open" - so the set is
 * read from the router rather than kept as a single value here.
 */
function activeTabsByMachine(): Map<string, Set<string>> {
  return router?.activeTabsByMachine() ?? new Map<string, Set<string>>()
}

const SETTINGS_UPLOAD_MAX = 2 * 1024 * 1024
export const uploadStaging = new PrivateUploadStaging(4)
const settingsUpload = uploadStaging.singleFile(SETTINGS_UPLOAD_MAX)
const moduleUpload = uploadStaging.singleFile(MODULE_ARCHIVE_MAX_BYTES)
const updateUpload = uploadStaging.singleFile(300 * 1024 * 1024)

/**
 * Start or stop everything that polls, from the current settings, connection
 * and visible tab. The app owns three collectors (the system stream, the
 * Overview's top consumers, and the services tracker); every other one
 * belongs to a module, so the rest of the work is handed to the host.
 */
function stopCorePollers(machine?: MachineContext): void {
  const machines = machine ? [machine] : machinePool.values()
  for (const target of machines) {
    target.systemMetrics.poller.stop()
    target.topService.poller.stop()
  }
  servicesPoller.stop()
}

function applyPollers(): void {
  if (shuttingDown) {
    stopCorePollers()
    return
  }

  const tabs = activeTabsByMachine()
  const ms = (speed: RefreshSpeed): number => REFRESH_INTERVAL_MS[speed]
  const c = appSettings.collectors
  appHistory.configure(appSettings.history)
  modulesHost.configure(appSettings, tabs)
  modulesHost.resume()
  for (const machine of machinePool.values()) {
    if (tearingDownMachines.has(machine.id)) continue
    modulesHost.resumeMachine(machine.id)
    machine.history.configure(appSettings.history)
    machine.systemMetrics.configure(c)
    // These two sweeps only feed cards supplied by their corresponding module.
    machine.topService.configure({
      perProcessIo: modulesHost.isEnabled('disk'),
      perProcessNet: modulesHost.isEnabled('network')
    })
    if (
      machine.systemMetrics.hasEnabledSections() &&
      ms(appSettings.refresh.system) > 0
    ) {
      machine.systemMetrics.poller.start(ms(appSettings.refresh.system))
    } else {
      machine.systemMetrics.poller.stop()
    }
    const machineTabs = tabs.get(machine.id) ?? new Set<string>()
    const detailOn = (mode: DetailPollingMode, tab: string): boolean =>
      mode === 'always' || (mode === 'tab' && moduleTabActive(machineTabs, tab))
    if (
      detailOn(appSettings.detailPolling.overviewTop, 'overview') &&
      ms(appSettings.refresh.processes) > 0
    ) {
      machine.topService.poller.start(ms(appSettings.refresh.processes))
    } else {
      machine.topService.poller.stop()
    }
  }
  void modulesHost
    .apply()
    .catch((error) => log(`module lifecycle apply failed: ${internalErrorDetail(error)}`))

  // App upkeep is global and only needs one poller while at least one target is live.
  if (machinePool.anyConnected() && ms(appSettings.refresh.system) > 0) {
    servicesPoller.start(ms(appSettings.refresh.system))
  } else {
    servicesPoller.stop()
  }
}

function teardownMachine(
  machine: MachineContext,
  options: { terminals?: boolean; history?: boolean } = {}
): void {
  if (tearingDownMachines.has(machine.id)) return
  tearingDownMachines.add(machine.id)
  const run = (label: string, action: () => void): void => {
    try {
      action()
    } catch (error) {
      log(`machine ${machine.id} teardown ${label} failed: ${internalErrorDetail(error)}`)
    }
  }
  try {
    run('core poller stop', () => stopCorePollers(machine))
    run('package action stop', () => machine.packagesService.cancelAction())
    run('module stop', () => modulesHost.suspendMachine(machine.id))
    if (options.history !== false) {
      run('history flush', () => machine.history.close())
    }
    if (options.terminals !== false) run('terminal stop', () => terminalService.disposeMachine(machine.id))
    run('system reset', () => machine.systemMetrics.reset())
    run('top reset', () => machine.topService.reset())
    run('packages reset', () => machine.packagesService.reset())
    run('module reset', () => modulesHost.resetAll(machine.id))
  } finally {
    tearingDownMachines.delete(machine.id)
  }
}

export function registerRpc(rpc: RpcRouter, api: HttpApi, sessions: SessionController): void {
  router = rpc
  registerAuthRoutes(api, currentSettings, {
    closeSession: (sid) => closeSessionSockets(sid, 'logged out')
  })
  // Before accounts existed there was one connection list for the machine; it
  // becomes the default account's.
  const moved = store.migrateLegacyConnections()
  if (moved) log(`moved the saved connections to ${moved}`)
  appHistory.configure(appSettings.history)
  // A settings file written before modules existed carries a switch per
  // feature; a feature the user had turned off becomes a disabled module.
  moduleInstaller.recoverPendingTransactions()
  modulesHost.init(store.takeLegacyDisabledModules())
  modulesHost.configure(appSettings, activeTabsByMachine())
  applyPollers()

  // The last browser showing a tab just went away, so whatever was collecting
  // for it has nobody left to collect for.
  rpc.onClose = (client) => {
    log(
      `client ${client.id} left (machine ${client.activeMachine ?? 'none'}, tab ${client.activeTab ?? 'none'})`
    )
    applyPollers()
  }

  // ---------- Connection ----------

  const connectTarget = async (
    client: RpcClient,
    cfg: ConnectionConfig
  ): Promise<ConnectionResult> => {
    try {
      const { machine, outcome } = await machinePool.connect(cfg)
      if (cfg.mode === 'ssh' && cfg.host && cfg.username) {
        try {
          store.rememberConnection(ownerOf(client), {
            host: cfg.host,
            port: cfg.port || 22,
            username: cfg.username,
            label: cfg.label,
            password: cfg.password,
            sudoPassword:
              outcome.sudoState === 'password-verified' ? cfg.sudoPassword : undefined,
            clearSudoPassword: outcome.sudoPasswordRejected,
            rememberPassword: cfg.rememberPassword
          })
        } catch (error) {
          log(`could not remember connection: ${internalErrorDetail(error)}`)
        }
      }
      machine.systemMetrics.reset()
      machine.topService.reset()
      machine.packagesService.reset()
      machine.history.configure(appSettings.history)
      modulesHost.resumeMachine(machine.id)
      applyPollers()
      await modulesHost.apply()
      // Specs are live-instance gated; tell every browser to refetch them now
      // that this host has activated its enabled modules.
      send('push:modules-list', modulesHost.list())
      log(`machine ${machine.id} connected`)
      return {
        ok: true,
        machineId: machine.id,
        ...(outcome.warning ? { error: outcome.warning } : {})
      }
    } catch (err) {
      if (err instanceof HostKeyError) {
        return { ok: false, error: err.message, hostKey: err.hostKey }
      }
      log(`connection failed: ${internalErrorDetail(err)}`)
      return { ok: false, error: 'Could not connect to the target' }
    } finally {
      send('push:conn-status', machinePool.list())
    }
  }

  rpc.registerClientHandler(
    'conn:connect',
    (client, input: unknown) => connectTarget(client, validateConnectionConfig(input)),
    { resources: ['connection'] }
  )

  rpc.registerClientHandler(
    'conn:reconnect',
    (
      client,
      savedId: unknown,
      hostKeyConfirmation?: unknown
    ): Promise<ConnectionResult> | ConnectionResult => {
      const id = validateOpaqueId(savedId, 'connection id')
      const saved = store.getSavedConnectionConfig(ownerOf(client), id)
      if (!saved) {
        return {
          ok: false,
          needsCredentials: true,
          error: 'Saved credentials are required to reconnect'
        }
      }
      const cfg =
        hostKeyConfirmation === undefined
          ? saved
          : validateConnectionConfig({ ...saved, hostKeyConfirmation })
      return connectTarget(client, cfg)
    },
    { resources: ['connection'] }
  )

  rpc.registerHandler(
    'conn:disconnect',
    async (machineId: unknown): Promise<OkResult> => {
      const id = validateMachineId(machineId)
      const machine = machinePool.get(id)
      try {
        if (machine) teardownMachine(machine)
        await machinePool.disconnect(id)
        if (!machinePool.anyConnected()) latestServices = null
        applyPollers()
        log(`machine ${id} disconnected`)
        return { ok: true }
      } finally {
        send('push:conn-status', machinePool.list())
      }
    },
    { resources: ['connection'] }
  )

  rpc.registerHandler('conn:status', () => machinePool.list())
  rpc.registerClientHandler('conn:list', (client) => store.listConnections(ownerOf(client)))
  rpc.registerClientHandler('conn:credentials', (client, id: unknown) =>
    store.getSavedCredentials(ownerOf(client), validateOpaqueId(id, 'connection id'))
  )
  rpc.registerClientHandler(
    'conn:delete',
    (client, id: unknown) => {
      store.deleteConnection(ownerOf(client), validateOpaqueId(id, 'connection id'))
      return store.listConnections(ownerOf(client))
    },
    { resources: ['connection', 'users'] }
  )

  // ---------- Metrics ----------

  rpc.registerHandler(
    'metrics:history',
    (machineId: unknown): HistoryPayload => {
      const machine = requireMachine(machineId)
      return {
        system: machine.systemMetrics.history,
        top: machine.topService.latest,
        services: latestServices,
        modules: modulesHost.snapshots(machine.id)
      }
    }
  )

  // Manual refresh of a slow section; the owning module answers it.
  rpc.registerHandler('metrics:refreshSlow', (machineId: unknown, target: unknown) =>
    modulesHost.refreshSlow(validateMachineId(machineId), validateSlowTarget(target))
  )

  // ---------- Metrics history (data/metrics) ----------

  rpc.registerHandler(
    'history:query',
    (
      machineId: unknown,
      stream: unknown,
      fromMs: unknown,
      toMs: unknown,
      maxPoints?: unknown
    ) => {
      const id = validateMachineId(machineId)
      const valid = validateHistoryQuery(stream, fromMs, toMs, maxPoints)
      return valid[0] === 'services'
        ? appHistory.query(...valid)
        : requireMachine(id).history.query(...valid)
    }
  )
  const combinedHistoryStats = (): HistoryStats => {
    const base = appHistory.stats()
    const live = machinePool.values().map((machine) => machine.history.stats())
    const lastFlush = [base, ...live]
      .map((stats) => stats.lastFlushMs ?? 0)
      .reduce((latest, value) => Math.max(latest, value), 0)
    const newest = [base, ...live]
      .map((stats) => stats.newestMs ?? 0)
      .reduce((latest, value) => Math.max(latest, value), 0)
    return {
      ...base,
      hostKey: null,
      currentFile: null,
      lastFlushMs: lastFlush || null,
      newestMs: newest || null,
      pendingPoints:
        base.pendingPoints + live.reduce((total, stats) => total + stats.pendingPoints, 0)
    }
  }
  rpc.registerHandler('history:stats', combinedHistoryStats)
  rpc.registerHandler('history:flush', () => {
    appHistory.flush()
    for (const machine of machinePool.values()) machine.history.flush()
    return combinedHistoryStats()
  })
  rpc.registerHandler('history:purge', () => {
    appHistory.purge()
    for (const machine of machinePool.values()) machine.history.purge()
    return combinedHistoryStats()
  })
  // The browser cannot open a folder on the host, so it gets the path to show.
  rpc.registerHandler('history:folder', (): string => {
    const dir = appHistory.dir()
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
  rpc.registerSend('ui:activeTab', (client, tab: unknown) => {
    client.activeTab = validateActiveTab(tab)
    applyPollers()
  })
  rpc.registerSend('ui:activeMachine', (client, machineId: unknown) => {
    client.activeMachine =
      machineId === null || machineId === undefined ? null : validateMachineId(machineId)
    applyPollers()
  })

  // ---------- Packages ----------

  rpc.registerHandler('packages:overview', (machineId: unknown) =>
    requireMachine(machineId).packagesService.overview()
  )
  rpc.registerHandler('packages:search', (machineId: unknown, query: unknown) =>
    requireMachine(machineId).packagesService.search(validatePackageQuery(query))
  )
  rpc.registerHandler(
    'packages:action',
    (machineId: unknown, action: unknown, pkg?: unknown) => {
      const valid = validatePackageAction(action, pkg)
      return requireMachine(machineId).packagesService.runAction(...valid)
    },
    { resources: ['packages'] }
  )
  rpc.registerHandler(
    'packages:cancel',
    (machineId: unknown) =>
      requireMachine(machineId).packagesService.cancelAction(),
    { resources: ['packages'] }
  )
  rpc.registerHandler('packages:state', (machineId: unknown) =>
    requireMachine(machineId).packagesService.getState()
  )

  // ---------- Terminals ----------

  rpc.registerHandler(
    'term:create',
    (
      machineId: unknown,
      preset: unknown,
      cols: unknown,
      rows: unknown,
      customCommand?: unknown
    ) =>
      terminalService.create(
        validateMachineId(machineId),
        ...validateTerminalCreate(preset, cols, rows, customCommand)
      )
  )
  rpc.registerHandler('term:list', () => terminalService.list())
  rpc.registerHandler('term:buffer', (id: unknown) =>
    terminalService.getBuffer(validateTerminalId(id))
  )
  rpc.registerSend('term:write', (_client, id: unknown, data: unknown) => {
    terminalService.write(validateTerminalId(id), validateTerminalData(data))
  })
  rpc.registerSend('term:resize', (_client, id: unknown, cols: unknown, rows: unknown) => {
    const size = validateTerminalSize(cols, rows)
    terminalService.resize(validateTerminalId(id), ...size)
  })
  rpc.registerHandler('term:dispose', (id: unknown) =>
    terminalService.dispose(validateTerminalId(id))
  )

  // ---------- Settings ----------

  rpc.registerHandler('settings:get', () => appSettings)
  rpc.registerClientHandler(
    'settings:set',
    async (client, input: unknown) => {
      const next = validatedSettings(input)
      client.protectReply()
      const before = appSettings.server
      // saveSettings normalises, so the browser gets back what is on disk.
      appSettings = saveSettings(next)
      appHistory.configure(appSettings.history)
      for (const machine of machinePool.values()) machine.history.configure(appSettings.history)
      applyPollers()
      // The UI switches the login through auth:setEnabled, but a whole-settings
      // write can carry the flag too, and it has to have the same consequence.
      await evictUnauthenticated(sessions, client)
      return { ...appSettings, restartRequired: serverSettingsChanged(before, appSettings.server) }
    },
    { resources: ['modules', 'settings', 'users'] }
  )

  // ---------- Accounts ----------
  //
  // Flat model: anyone who can log in can manage the accounts. The WebUI is a
  // tool for the people who administer the machine it watches, and a role
  // system would be pretending otherwise.

  rpc.registerHandler('auth:users', () => users.listUsers())
  rpc.registerHandler(
    'auth:createUser',
    async (value: unknown) => {
      const input = validateUserPasswordInput(value)
      try {
        await users.createUser(input.username, input.password!)
      } catch (error) {
        rethrowUserMutation(error, input.username)
      }
      return users.listUsers()
    },
    { resources: ['users'] }
  )
  rpc.registerClientHandler(
    'auth:deleteUser',
    async (client, value: unknown) => {
      client.protectReply()
      const { username } = validateUserPasswordInput(value, { password: false })
      try {
        await users.deleteUser(username)
      } catch (error) {
        rethrowUserMutation(error, username)
      }
      closeUserSockets(username, 'account removed', client)
      await sessions.revokeUsername(username)
      log(`account "${username}" deleted by "${ownerOf(client)}"`)
      return users.listUsers()
    },
    { resources: ['users'] }
  )
  rpc.registerClientHandler(
    'auth:setPassword',
    async (client, value: unknown) => {
      client.protectReply()
      const input = validateUserPasswordInput(value)
      try {
        await users.setPassword(input.username, input.password!)
      } catch (error) {
        rethrowUserMutation(error, input.username)
      }
      const username = input.username
      closeUserSockets(username, 'password changed', client)
      await sessions.revokeUsername(username)
      return users.listUsers()
    },
    { resources: ['users'] }
  )
  rpc.registerClientHandler(
    'auth:setEnabled',
    async (client, input: unknown) => {
      client.protectReply()
      const enabled = validateEnabledInput(input)
      // Turning the login on without a password would lock everyone out, with
      // nothing to log in with and no reset flow.
      if (enabled && !users.hasPassword(DEFAULT_USERNAME)) {
        throw new PublicError('PRECONDITION_FAILED', 'set-admin-password-first', 409)
      }
      appSettings = saveSettings({ ...appSettings, auth: { ...appSettings.auth, enabled } })
      log(`login is now ${enabled ? 'required' : 'not required'}`)
      await evictUnauthenticated(sessions, client)
      return appSettings
    },
    { resources: ['settings', 'users'] }
  )

  // Export and import are HTTP, not RPC: one is a file download, the other a
  // file upload, and a WebSocket carrying JSON frames can do neither well.
  api.get('/settings/export', async (_req, res) => {
    await rpc.runExclusive(['settings'], () => {
      try {
        store.saveSettings(appSettings)
      } catch {
        /* an unwritable folder must not block an existing file download */
      }
    })
    res.download(store.settingsFile(), 'bored-manager-settings.json')
  })

  api.post('/settings/import', settingsUpload, async (req, res) => {
    const file = req.file
    if (!file) {
      res.status(400).json({
        ok: false,
        code: 'INVALID_UPLOAD',
        error: 'No file was uploaded'
      })
      return
    }
    let imported: Partial<AppSettings>
    try {
      imported = store.readSettingsFile(file.path)
    } catch (error) {
      log(`settings import rejected: ${internalErrorDetail(error)}`)
      throw new ValidationError('The settings file is not valid')
    }
    await rpc.runExclusive(['modules', 'settings', 'users'], async () => {
      // Read, then save through the same funnel as a settings write, so an
      // imported file cannot set anything a settings write could not.
      appSettings = saveSettings(imported)
      // An imported file written before modules existed switches features off
      // with a collector flag; honour that here as a migration would.
      modulesHost.applyLegacyDisabled(store.takeLegacyDisabledModules())
      appHistory.configure(appSettings.history)
      for (const machine of machinePool.values()) machine.history.configure(appSettings.history)
      applyPollers()
      // An import that switched the login on has to close the sockets that
      // predate it, the same as the toggle does. This one is an HTTP request,
      // so there is no socket of its own to spare.
      await evictUnauthenticated(sessions)
      send('push:modules-list', modulesHost.list())
    })
    res.json({ ok: true, settings: appSettings })
  })

  // ---------- Modules ----------

  rpc.registerHandler('modules:list', () => modulesHost.list())
  rpc.registerHandler('modules:enabledIds', () => modulesHost.enabledIds())
  rpc.registerHandler('modules:specs', () => modulesHost.specsPayload())
  rpc.registerHandler(
    'modules:setEnabled',
    async (id: unknown, enabled: unknown) => {
      await modulesHost.setEnabled(validateModuleId(id), validateBoolean(enabled, 'enabled'))
      const list = modulesHost.list()
      send('push:modules-list', list)
      return list
    },
    { resources: ['modules'] }
  )
  rpc.registerHandler(
    'modules:verify',
    (id: unknown) => {
      modulesHost.verify(validateModuleId(id))
      const list = modulesHost.list()
      send('push:modules-list', list)
      return list
    },
    { resources: ['modules'] }
  )
  rpc.registerHandler(
    'modules:reload',
    async (id: unknown) => {
      const result = await modulesHost.reload(validateModuleId(id))
      send('push:modules-list', modulesHost.list())
      return result
    },
    { resources: ['modules'] }
  )
  rpc.registerHandler('modules:installState', () => moduleInstaller.getState())
  rpc.registerHandler(
    'modules:checkUrl',
    (url: unknown) => moduleInstaller.checkUrl(validateModuleSource(url)),
    { resources: ['modules'] }
  )
  rpc.registerHandler(
    'modules:install',
    (confirmationToken: unknown) => moduleInstaller.install(confirmationToken),
    { resources: ['modules'] }
  )
  rpc.registerHandler(
    'modules:uninstall',
    (id: unknown) => moduleInstaller.uninstall(validateModuleId(id)),
    { resources: ['modules'] }
  )
  rpc.registerHandler(
    'modules:cancel',
    () => moduleInstaller.cancel(),
    { resources: ['modules'] }
  )
  rpc.registerHandler('modules:catalog', () => getCatalog(appSettings.update.repo))
  rpc.registerHandler(
    'modules:catalogRefresh',
    () => getCatalog(appSettings.update.repo, true),
    { resources: ['modules'] }
  )

  // A module archive arrives as an upload; the installer grades the file on disk.
  api.post('/modules/check-file', moduleUpload, async (req, res) => {
    const file = req.file
    if (!file) {
      res.status(400).json({
        ok: false,
        code: 'INVALID_UPLOAD',
        error: 'No file was uploaded'
      })
      return
    }
    const result = await rpc.runExclusive(['modules'], () =>
      moduleInstaller.checkFile(file.path)
    )
    res.json(result.source === file.path ? { ...result, source: 'upload' } : result)
  })

  // ---------- App update ----------

  rpc.registerHandler('update:state', () => updaterService.getState())
  rpc.registerHandler(
    'update:check',
    (url: unknown) => updaterService.check(validateHttpsUrl(url)),
    { resources: ['update'] }
  )
  rpc.registerHandler('update:checkRepo', () => updaterService.checkRepo(appSettings.update.repo))
  rpc.registerHandler(
    'update:cancel',
    () => updaterService.cancel(),
    { resources: ['update'] }
  )
  rpc.registerHandler(
    'update:apply',
    () => updaterService.apply(),
    { resources: ['update'] }
  )
  rpc.registerHandler(
    'update:consumeResult',
    () => updaterService.consumeResult(),
    { resources: ['update'] }
  )

  api.post('/update/check-file', updateUpload, async (req, res) => {
    const file = req.file
    if (!file) {
      res.status(400).json({
        ok: false,
        code: 'INVALID_UPLOAD',
        error: 'No file was uploaded'
      })
      return
    }
    res.json(await rpc.runExclusive(['update'], () => updaterService.checkFile(file.path)))
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
export function cleanClose(): Promise<void> {
  if (cleanClosePromise) return cleanClosePromise
  shuttingDown = true
  cleanClosePromise = runCleanClose({
    stopNewWork: () => {
      const failures: unknown[] = []
      for (const stop of [
        () => uploadStaging.dispose(),
        () => updaterService.cancel(),
        () => moduleInstaller.cancel()
      ]) {
        try {
          stop()
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Could not stop all pending upload/update work')
      }
    },
    stopHostServices: () => {
      for (const machine of machinePool.values()) {
        teardownMachine(machine, { terminals: false, history: false })
      }
      servicesPoller.stop()
      modulesHost.suspend()
    },
    flushHistory: () => {
      appHistory.close()
      for (const machine of machinePool.values()) machine.history.close()
    },
    disconnectExecutor: () => machinePool.disconnectAll(),
    disposeTerminals: () => terminalService.disposeAll(),
    disposeRegistry: () => registry.disposeAll(5000)
  })
  return cleanClosePromise
}
