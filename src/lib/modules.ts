/**
 * Renderer helpers for declarative module specs. Pages are JSON; the app
 * calls into a module's main half through these, never by importing the
 * module's own React.
 */
import type { AppSettings } from '@shared/types'
import { api } from '@/lib/api'
import { useApp } from '@/state/store'

/**
 * Call a method the module's main half registered with `ctx.handle`. Errors
 * come back as a rejected promise, exactly like a core IPC call.
 */
export function moduleCall<T>(moduleId: string, method: string, ...args: unknown[]): Promise<T> {
  const machineId = useApp.getState().activeMachineId
  if (!machineId) return Promise.reject(new Error('no active machine'))
  return api.modules.invoke<T>(machineId, moduleId, method, args)
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
  return api.modules.onEvent<T>(moduleId, event, (payload) => {
    if (payload.machineId === useApp.getState().activeMachineId) cb(payload.data)
  })
}

/** The current settings, or null before the first load. */
export function useAppSettings(): AppSettings | null {
  return useApp((s) => s.settings)
}

/**
 * Whether another module is installed and switched on. For an optional section
 * that shows data a different module collects: read its stream from the bus and
 * hide the section when it is not running, instead of importing from it.
 */
export function useModuleEnabled(id: string): boolean {
  return useApp((s) => s.enabledModules.includes(id))
}
