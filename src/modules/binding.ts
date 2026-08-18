/**
 * Resolving one block's `DataSource` to a value, whatever kind it is. Every
 * branch below is a hook that always runs (never called conditionally) - only
 * the one matching `source.kind` does anything, the rest sit idle - so this
 * stays legal under the rules of hooks no matter which kind a given block
 * declares.
 */
import * as React from 'react'
import type { ActionSpec, DataSource } from '@shared/module-ui'
import { REFRESH_INTERVAL_MS, SYSTEM_HISTORY_STREAM, type HistoryPoint, type RefreshSpeed } from '@shared/types'
import { useApp } from '@/state/store'
import { useModuleLatest, useModuleSeries } from '@/lib/module-bus'
import { useWindowedSeries } from '@/lib/history'
import { moduleCall, useAppSettings } from '@/lib/modules'
import { useModuleManifest } from '@/lib/module-registry'
import { errorMessage } from '@/lib/utils'

/** Default chart window when a block does not say otherwise (matches the live buffer). */
export const DEFAULT_BLOCK_WINDOW_SEC = 60

/** Marks a string as "read from the current scope" instead of a literal value or a path into the source. */
const SCOPE_PREFIX = '$row.'

function isScopeRef(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SCOPE_PREFIX)
}

/**
 * Read one field out of a resolved value by a dot path (`"mem.used"`,
 * `"gpus.0.temp"`). Absent for a `stream`/`core` source that already IS the
 * value a block wants (a chart's series array, for instance) - only applied
 * when the block spec sets `path`.
 */
export function resolvePath(value: unknown, path: string | undefined): unknown {
  if (!path) return value
  let cur: unknown = value
  for (const segment of path.split('.')) {
    if (cur == null) return undefined
    if (Array.isArray(cur)) {
      const index = Number(segment)
      cur = Number.isInteger(index) ? cur[index] : undefined
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[segment]
    } else {
      return undefined
    }
  }
  return cur
}

/** `path` starting with `$row.` reads straight from the scope (the open row/drawer) instead of the source's own value. */
function applyPath(raw: unknown, path: string | undefined, scope: unknown): unknown {
  if (isScopeRef(path)) return resolvePath(scope, path.slice(SCOPE_PREFIX.length))
  return resolvePath(raw, path)
}

/** Same `$row.` convention, applied to every element of an args array (`ActionSpec.args`, an `invoke` source's `args`). */
export function substituteScopeArgs(args: unknown[] | undefined, scope: unknown): unknown[] {
  return (args ?? []).map((a) => (isScopeRef(a) ? resolvePath(scope, a.slice(SCOPE_PREFIX.length)) : a))
}

/**
 * The full, ordered argument list for one `ActionSpec` call: `argsFromRow`
 * first (the row's own identity - a pid, a container id), then the literal
 * `args`, then whatever the caller appends (a prompt value, form field
 * values). Matches how every real method is shaped: `kill(pid, signal)`,
 * `containerAction(id, action)`, `setPersistence(index, enabled)`.
 */
export function resolveActionArgs(action: ActionSpec, scope: unknown, extra: unknown[] = []): unknown[] {
  const fromRow = (action.argsFromRow ?? []).map((key) => resolvePath(scope, key))
  return [...fromRow, ...substituteScopeArgs(action.args, scope), ...extra]
}

function useStreamValue(moduleId: string, source: DataSource, scope: unknown): unknown {
  const isStream = source.kind === 'stream'
  const event = isStream ? source.event : ''
  const path = isStream ? source.path : undefined
  const manifest = useModuleManifest(moduleId)
  const streamKind = manifest?.streams?.find((s) => s.event === event)?.kind
  const latest = useModuleLatest(moduleId, event)
  const series = useModuleSeries(moduleId, event)
  if (!isStream) return undefined
  const raw = streamKind === 'series' ? series : latest
  return applyPath(raw, path, scope)
}

/** Invoke's value plus a manual `refetch` - a table's row actions call this after a change (kill, renice, ...). */
function useInvokeValue(
  moduleId: string,
  source: DataSource,
  visible: boolean,
  scope: unknown
): [unknown, () => void] {
  const isInvoke = source.kind === 'invoke'
  const method = isInvoke ? source.method : ''
  const path = isInvoke ? source.path : undefined
  const intervalKey = isInvoke ? source.intervalKey : undefined
  const args = React.useMemo(
    () => (isInvoke ? substituteScopeArgs(source.args, scope) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isInvoke, isInvoke ? JSON.stringify(source.args) : '', scope]
  )
  const speed = useAppSettings()?.refresh[intervalKey ?? '']
  const [value, setValue] = React.useState<unknown>(undefined)
  const [reloadTick, setReloadTick] = React.useState(0)
  const argsKey = JSON.stringify(args)
  const refetch = React.useCallback(() => setReloadTick((t) => t + 1), [])

  React.useEffect(() => {
    if (!isInvoke || !visible) return
    let cancelled = false
    const run = (): void => {
      void moduleCall(moduleId, method, ...args).then(
        (v) => {
          if (!cancelled) setValue(v)
        },
        (err: unknown) => {
          if (!cancelled) {
            useApp.getState().showNotice('error', `${moduleId}.${method}: ${errorMessage(err)}`)
          }
        }
      )
    }
    run()
    if (!intervalKey) return () => (cancelled = true)
    const ms = REFRESH_INTERVAL_MS[speed ?? 'normal']
    if (ms <= 0) return () => (cancelled = true)
    const id = setInterval(run, ms)
    return () => {
      cancelled = true
      clearInterval(id)
    }
    // args is already content-stable via argsKey below; re-running for every new array
    // identity would restart polling on every render for no reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isInvoke, visible, moduleId, method, argsKey, intervalKey, speed, reloadTick])

  if (!isInvoke) return [undefined, refetch]
  return [applyPath(value, path, scope), refetch]
}

function identityPoint(p: HistoryPoint): HistoryPoint {
  return p
}

function useHistoryValue(moduleId: string, source: DataSource, windowSec: number): unknown {
  const isHistory = source.kind === 'history'
  const stream = isHistory ? source.stream : ''
  const coreSystem = useApp((s) => s.system)
  const moduleSeries = useModuleSeries<HistoryPoint>(moduleId, stream)
  const live = stream === SYSTEM_HISTORY_STREAM ? coreSystem : moduleSeries
  const points = useWindowedSeries(stream, windowSec, live as HistoryPoint[], identityPoint)
  return isHistory ? points : undefined
}

function useCoreValue(source: DataSource, scope: unknown): unknown {
  const isCore = source.kind === 'core'
  const stream = isCore ? source.stream : undefined
  const path = isCore ? source.path : undefined
  const system = useApp((s) => s.system)
  const top = useApp((s) => s.topNow)
  const services = useApp((s) => s.servicesNow)
  if (!isCore) return undefined
  if (stream === 'system') return applyPath(system.at(-1), path, scope)
  if (stream === 'top') return applyPath(top, path, scope)
  if (stream === 'services') return applyPath(services, path, scope)
  return undefined
}

function useResolvedBlockData(
  moduleId: string,
  source: DataSource,
  opts: { visible: boolean; windowSec?: number; scope?: unknown }
): { value: unknown; refetch: () => void } {
  const streamValue = useStreamValue(moduleId, source, opts.scope)
  const [invokeValue, invokeRefetch] = useInvokeValue(moduleId, source, opts.visible, opts.scope)
  const historyValue = useHistoryValue(moduleId, source, opts.windowSec ?? DEFAULT_BLOCK_WINDOW_SEC)
  const coreValue = useCoreValue(source, opts.scope)
  let value: unknown
  switch (source.kind) {
    case 'stream':
      value = streamValue
      break
    case 'invoke':
      value = invokeValue
      break
    case 'history':
      value = historyValue
      break
    case 'core':
      value = coreValue
      break
    default:
      value = undefined
  }
  return { value, refetch: source.kind === 'invoke' ? invokeRefetch : () => undefined }
}

/**
 * Resolve one block's data source. Always call with the block's own
 * `moduleId`/`source`. `scope` is the open row when this block lives inside a
 * table's `rowDetail` drawer - `undefined` everywhere else.
 */
export function useBlockData(
  moduleId: string,
  source: DataSource,
  opts: { visible: boolean; windowSec?: number; scope?: unknown }
): unknown {
  return useResolvedBlockData(moduleId, source, opts).value
}

/** Same as `useBlockData`, plus a manual `refetch` - for a block that needs to force an `invoke` source to re-read (a table's row actions). */
export function useBlockDataWithRefetch(
  moduleId: string,
  source: DataSource,
  opts: { visible: boolean; windowSec?: number; scope?: unknown }
): { value: unknown; refetch: () => void } {
  return useResolvedBlockData(moduleId, source, opts)
}

/** The configured speed of a fast interval key, resolved to idle/ms - for blocks that show it. */
export function useIntervalSpeed(key: string | undefined): RefreshSpeed | undefined {
  return useAppSettings()?.refresh[key ?? '']
}
