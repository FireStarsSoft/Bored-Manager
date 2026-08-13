/**
 * The renderer-side API a module is written against. A module imports from
 * here (and from `@/components/*`, `@/lib/utils`, `@shared/*`) and never from
 * the app's own state, so switching a module off can never leave a dangling
 * reference into the core.
 */
import * as React from 'react'
import type { AppSettings, RefreshSpeed, SystemSnapshot, TopConsumersSnapshot } from '@shared/types'
import { api } from '@/lib/api'
import { useApp } from '@/state/store'

export { useModuleLatest, useModuleSeries } from '@/lib/module-bus'

/**
 * Call a method the module's main half registered with `ctx.handle`. Errors
 * come back as a rejected promise, exactly like a core IPC call.
 */
export function moduleCall<T>(moduleId: string, method: string, ...args: unknown[]): Promise<T> {
  return api.modules.invoke<T>(moduleId, method, args)
}

/**
 * Subscribe to an event the module's main half emits that is not one of the
 * declared streams - a log line, a one-off notification. Declared streams are
 * mirrored into the bus automatically; use `useModuleSeries` for those.
 */
export function moduleOn<T>(
  moduleId: string,
  event: string,
  cb: (payload: T) => void
): () => void {
  return api.modules.onEvent(moduleId, event, cb)
}

/** The current settings, or null before the first load. */
export function useAppSettings(): AppSettings | null {
  return useApp((s) => s.settings)
}

/** The configured speed of a fast interval key, for "polling is paused" copy. */
export function useFastSpeed(key: string): RefreshSpeed | undefined {
  return useApp((s) => s.settings?.refresh[key])
}

/**
 * The core system stream (CPU, memory, network and disk rates, load, uptime).
 * The app always collects it, so a module can rely on it being there.
 */
export function useCoreSystem(): SystemSnapshot[] {
  return useApp((s) => s.system)
}

/** The busiest processes per resource, or null when that collector is off. */
export function useTopConsumers(): TopConsumersSnapshot | null {
  return useApp((s) => s.topNow)
}

/** Open another page - a module's card linking to its own tab, for instance. */
export function useOpenTab(): (tab: string) => void {
  return useApp((s) => s.setActiveTab)
}

/** True while a target machine is connected. */
export function useConnected(): boolean {
  return useApp((s) => s.status.connected)
}

/**
 * Whether another module is installed and switched on. For an optional section
 * that shows data a different module collects: read its stream from the bus and
 * hide the section when it is not running, instead of importing from it.
 */
export function useModuleEnabled(id: string): boolean {
  return useApp((s) => s.enabledModules.includes(id))
}

/** True when commands on the target can be elevated. */
export function useHasSudo(): boolean {
  return useApp((s) => s.status.isRoot === true || s.status.hasSudo === true)
}

/** Show a toast at the top of the window; it disappears on its own. */
export function useNotice(): (kind: 'error' | 'info', text: string) => void {
  return useApp((s) => s.showNotice)
}

/**
 * Open a terminal on the target running `command` and switch to the Terminals
 * page. Returns the error the app reported, or null when it opened - a module
 * that offers a shell (`docker exec`, an interactive tool) uses this instead of
 * running the shell itself.
 */
export function useOpenTerminal(): (title: string, command: string) => Promise<string | null> {
  const refreshTerminals = useApp((s) => s.refreshTerminals)
  const setActiveTab = useApp((s) => s.setActiveTab)
  return React.useCallback(
    async (_title: string, command: string) => {
      const res = await api.terminals.create('custom', 120, 30, command)
      if ('ok' in res && !res.ok) return res.error || 'Failed to open the terminal'
      await refreshTerminals()
      setActiveTab('terminals')
      return null
    },
    [refreshTerminals, setActiveTab]
  )
}

/**
 * Ask the main process for an immediate reading of a slow section this module
 * owns, and report whether one is in flight so a button can show a spinner.
 */
export function useSlowRefresh(target: string): { refreshing: boolean; refresh: () => void } {
  const refreshing = useApp((s) => s.slowRefreshing[target] === true)
  const refreshSlow = useApp((s) => s.refreshSlow)
  const refresh = React.useCallback(() => void refreshSlow(target), [refreshSlow, target])
  return { refreshing, refresh }
}
