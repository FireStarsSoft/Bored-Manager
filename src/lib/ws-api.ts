import type {
  AppSettings,
  AuthStatus,
  ConnectionConfig,
  ConnectionStatus,
  HistoryPayload,
  HistoryPoint,
  HistoryStats,
  HistoryStream,
  OkResult,
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
  UpdateRepoInfo,
  UpdateResult,
  UpdateState,
  UserAccount
} from '@shared/types'
import type { ModuleCatalog, ModuleDescriptor, ModuleInstallState } from '@shared/modules'
import type { ModuleSpecsEntry } from '@shared/module-ui'
import type { Api, AppInfo, SavedSettings } from './api'
import type { WsClient } from './ws-client'

/**
 * Every call the UI can make, mapped onto the transport. This is the file that
 * replaced preload.ts: same channel names, same shapes, a WebSocket instead of
 * ipcRenderer - plus the three things a socket cannot do (download a file,
 * upload a file), which go over plain HTTP.
 */

/** POST a single file to an /api route as multipart/form-data. */
async function postFile<T>(path: string, file: File): Promise<T> {
  const body = new FormData()
  body.append('file', file)
  const response = await fetch(path, { method: 'POST', body })
  const text = await response.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    throw new Error(`the server replied with something unexpected (${response.status})`)
  }
  if (!response.ok) {
    const error = (json as { error?: string } | null)?.error
    throw new Error(error || `the server replied ${response.status}`)
  }
  return json as T
}

/** Ask the browser to save a URL, without opening a window a blocker may eat. */
function downloadUrl(url: string): void {
  const link = document.createElement('a')
  link.href = url
  link.download = ''
  document.body.append(link)
  link.click()
  link.remove()
}

export function createWsApi(client: WsClient): Api {
  const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
    client.invoke<T>(channel, ...args)
  const on = <T>(channel: string, cb: (payload: T) => void): (() => void) =>
    client.on(channel, (payload) => cb(payload as T))

  // The host's platform and version never change while the page is open.
  let info: Promise<AppInfo> | null = null

  return {
    connection: {
      connect: (cfg: ConnectionConfig) => invoke<OkResult>('conn:connect', cfg),
      disconnect: () => invoke<OkResult>('conn:disconnect'),
      status: () => invoke<ConnectionStatus>('conn:status'),
      listSaved: () => invoke<SavedConnection[]>('conn:list'),
      getCredentials: (id: string) =>
        invoke<{ password?: string; sudoPassword?: string } | null>('conn:credentials', id),
      deleteSaved: (id: string) => invoke<SavedConnection[]>('conn:delete', id),
      onLost: (cb: () => void) => on('push:conn-lost', cb),
      onStatus: (cb: (s: ConnectionStatus) => void) => on('push:conn-status', cb)
    },

    metrics: {
      history: () => invoke<HistoryPayload>('metrics:history'),
      refreshSlow: (target: SlowRefreshTarget) => invoke<void>('metrics:refreshSlow', target),
      onSystem: (cb: (s: SystemSnapshot) => void) => on('push:system', cb),
      onTop: (cb: (s: TopConsumersSnapshot) => void) => on('push:top', cb),
      onServices: (cb: (s: ServicesSnapshot) => void) => on('push:services', cb)
    },

    history: {
      query: (stream: HistoryStream, fromMs: number, toMs: number, maxPoints?: number) =>
        invoke<HistoryPoint[]>('history:query', stream, fromMs, toMs, maxPoints),
      stats: () => invoke<HistoryStats>('history:stats'),
      flush: () => invoke<HistoryStats>('history:flush'),
      purge: () => invoke<HistoryStats>('history:purge'),
      folder: () => invoke<string>('history:folder')
    },

    ui: {
      setActiveTab: (tab: string) => client.send('ui:activeTab', tab)
    },

    packages: {
      overview: () => invoke<PackagesOverview>('packages:overview'),
      search: (query: string) => invoke<PackageSearchResult[]>('packages:search', query),
      action: (action: PkgAction, pkg?: string) => invoke<OkResult>('packages:action', action, pkg),
      cancel: () => invoke<void>('packages:cancel'),
      state: () => invoke<PkgActionState>('packages:state'),
      onLog: (cb: (data: string) => void) => on('packages:log', cb),
      onState: (cb: (s: PkgActionState) => void) => on('packages:state', cb)
    },

    terminals: {
      create: (preset: TerminalPreset, cols: number, rows: number, customCommand?: string) =>
        invoke<TerminalInfo | OkResult>('term:create', preset, cols, rows, customCommand),
      list: () => invoke<TerminalInfo[]>('term:list'),
      buffer: (id: string) => invoke<string>('term:buffer', id),
      write: (id: string, data: string) => client.send('term:write', id, data),
      resize: (id: string, cols: number, rows: number) =>
        client.send('term:resize', id, cols, rows),
      dispose: (id: string) => invoke<void>('term:dispose', id),
      onData: (cb: (p: { id: string; data: string }) => void) => on('term:data', cb),
      onExit: (cb: (p: { id: string }) => void) => on('term:exit', cb)
    },

    settings: {
      get: () => invoke<AppSettings>('settings:get'),
      set: (s: AppSettings) => invoke<SavedSettings>('settings:set', s),
      export: () => downloadUrl('/api/settings/export'),
      import: (file: File) =>
        postFile<OkResult & { settings?: AppSettings }>('/api/settings/import', file)
    },

    update: {
      state: () => invoke<UpdateState>('update:state'),
      check: (url: string) => invoke<UpdateState>('update:check', url),
      checkRepo: () => invoke<UpdateRepoInfo>('update:checkRepo'),
      checkFile: (file: File) => postFile<UpdateState>('/api/update/check-file', file),
      cancel: () => invoke<UpdateState>('update:cancel'),
      apply: () => invoke<OkResult>('update:apply'),
      consumeResult: () => invoke<UpdateResult | null>('update:consumeResult'),
      onState: (cb: (s: UpdateState) => void) => on('push:update', cb)
    },

    modules: {
      list: () => invoke<ModuleDescriptor[]>('modules:list'),
      specs: () => invoke<ModuleSpecsEntry[]>('modules:specs'),
      setEnabled: (id: string, enabled: boolean) =>
        invoke<ModuleDescriptor[]>('modules:setEnabled', id, enabled),
      verify: (id: string) => invoke<ModuleDescriptor[]>('modules:verify', id),
      reload: (id: string) => invoke<{ ok: true } | { ok: false; error: string }>('modules:reload', id),
      installState: () => invoke<ModuleInstallState>('modules:installState'),
      checkUrl: (url: string) => invoke<ModuleInstallState>('modules:checkUrl', url),
      checkFile: (file: File) => postFile<ModuleInstallState>('/api/modules/check-file', file),
      install: () => invoke<ModuleInstallState>('modules:install'),
      uninstall: (id: string) => invoke<ModuleInstallState>('modules:uninstall', id),
      cancel: () => invoke<ModuleInstallState>('modules:cancel'),
      onInstallState: (cb: (s: ModuleInstallState) => void) => on('push:modules', cb),
      onListChanged: (cb: (list: ModuleDescriptor[]) => void) => on('push:modules-list', cb),
      catalog: () => invoke<ModuleCatalog>('modules:catalog'),
      catalogRefresh: () => invoke<ModuleCatalog>('modules:catalogRefresh'),

      invoke: <T>(moduleId: string, method: string, args: unknown[]) =>
        invoke<T>(`module:${moduleId}:invoke:${method}`, ...args),
      onEvent: <T>(moduleId: string, event: string, cb: (payload: T) => void) =>
        on(`module:${moduleId}:event:${event}`, cb)
    },

    app: {
      info: () => {
        info ??= invoke<AppInfo>('app:info')
        return info
      },
      restart: () => invoke<void>('app:restart')
    },

    auth: {
      status: async () => {
        const res = await fetch('/api/auth/status')
        if (!res.ok) throw new Error(`auth status failed (${res.status})`)
        return (await res.json()) as AuthStatus
      },
      login: async (username: string, password: string) => {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username, password })
        })
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean
          locked?: boolean
          remaining?: number
          error?: string
        }
        return {
          ok: res.ok && body.ok === true,
          locked: res.status === 423 || body.locked === true,
          remaining: body.remaining,
          error: body.error
        }
      },
      logout: async () => {
        await fetch('/api/auth/logout', { method: 'POST' })
      },
      users: () => invoke<UserAccount[]>('auth:users'),
      createUser: (username: string, password: string) =>
        invoke<UserAccount[]>('auth:createUser', { username, password }),
      deleteUser: (username: string) => invoke<UserAccount[]>('auth:deleteUser', { username }),
      setPassword: (username: string, password: string) =>
        invoke<UserAccount[]>('auth:setPassword', { username, password }),
      setEnabled: (enabled: boolean) => invoke<AppSettings>('auth:setEnabled', { enabled })
    }
  }
}
