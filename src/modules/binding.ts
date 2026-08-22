/**
 * Resolving one block's `DataSource` to a value, whatever kind it is. Every
 * branch below is a hook that always runs (never called conditionally) - only
 * the one matching `source.kind` does anything, the rest sit idle - so this
 * stays legal under the rules of hooks no matter which kind a given block
 * declares.
 */
import * as React from 'react'
import type { ActionSpec, DataSource } from '@shared/module-ui'
import { REFRESH_INTERVAL_MS, SYSTEM_HISTORY_STREAM, type HistoryPoint } from '@shared/types'
import { useApp } from '@/state/store'
import { useModuleLatest, useModuleSeries } from '@/lib/module-bus'
import { useWindowedSeries } from '@/lib/history'
import { moduleCall, useAppSettings } from '@/lib/modules'
import { useModuleManifest } from '@/lib/module-registry'
import { errorMessage } from '@/lib/utils'
import { useDocumentVisible } from '@/lib/visibility'

/** Default chart window when a block does not say otherwise (matches the live buffer). */
export const DEFAULT_BLOCK_WINDOW_SEC = 60

/** Marks a string as "read from the current scope" instead of a literal value or a path into the source. */
const SCOPE_PREFIX = '$row.'
const NOOP = (): void => undefined
const EMPTY_HISTORY: HistoryPoint[] = []

type StreamSource = Extract<DataSource, { kind: 'stream' }>
type InvokeSource = Extract<DataSource, { kind: 'invoke' }>
type HistorySource = Extract<DataSource, { kind: 'history' }>
type CoreSource = Extract<DataSource, { kind: 'core' }>

export interface ResolvedBlockData {
  value: unknown
  refetch: () => void
}

interface BlockDataProps {
  moduleId: string
  source: DataSource
  opts: { visible: boolean; windowSec?: number; scope?: unknown }
  children: (data: ResolvedBlockData) => React.ReactNode
}

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

function useStreamValue(moduleId: string, source: StreamSource, scope: unknown): unknown {
  const event = source.event
  const manifest = useModuleManifest(moduleId)
  const streamKind = manifest?.streams?.find((s) => s.event === event)?.kind
  const latest = useModuleLatest(moduleId, event)
  const series = useModuleSeries(moduleId, event)
  const raw = streamKind === 'series' ? series : latest
  return applyPath(raw, source.path, scope)
}

/** Invoke's value plus a manual `refetch` - a table's row actions call this after a change (kill, renice, ...). */
function useInvokeValue(
  moduleId: string,
  source: InvokeSource,
  visible: boolean,
  scope: unknown
): [unknown, () => void] {
  const method = source.method
  const intervalKey = source.intervalKey
  const machineId = useApp((state) => state.activeMachineId)
  const machineRevision = useApp(
    (state) =>
      state.machines.find((machine) => machine.machineId === state.activeMachineId)?.revision ?? 0
  )
  const args = React.useMemo(
    () => substituteScopeArgs(source.args, scope),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(source.args), scope]
  )
  const speed = useAppSettings()?.refresh[intervalKey ?? '']
  const documentVisible = useDocumentVisible()
  const [value, setValue] = React.useState<unknown>(undefined)
  const [reloadTick, setReloadTick] = React.useState(0)
  const argsKey = JSON.stringify(args)
  const refetch = React.useCallback(() => setReloadTick((t) => t + 1), [])
  const inFlightRef = React.useRef<Promise<void> | null>(null)
  const pendingRunRef = React.useRef<(() => void) | null>(null)

  React.useEffect(() => {
    if (!visible || !documentVisible || !machineId) return
    let cancelled = false
    setValue(undefined)
    const run = (): void => {
      if (inFlightRef.current) {
        pendingRunRef.current = run
        return
      }
      const work = (async (): Promise<void> => {
        try {
          const next = await moduleCall(moduleId, method, ...args)
          if (!cancelled) setValue(next)
        } catch (err) {
          if (!cancelled) {
            useApp.getState().showNotice('error', `${moduleId}.${method}: ${errorMessage(err)}`)
          }
        }
      })()
      inFlightRef.current = work
      void work.finally(() => {
        if (inFlightRef.current === work) inFlightRef.current = null
        const pending = pendingRunRef.current
        pendingRunRef.current = null
        pending?.()
      })
    }
    run()
    if (!intervalKey) {
      return () => {
        cancelled = true
        if (pendingRunRef.current === run) pendingRunRef.current = null
      }
    }
    const ms = REFRESH_INTERVAL_MS[speed ?? 'normal']
    if (ms <= 0) {
      return () => {
        cancelled = true
        if (pendingRunRef.current === run) pendingRunRef.current = null
      }
    }
    const id = setInterval(run, ms)
    return () => {
      cancelled = true
      if (pendingRunRef.current === run) pendingRunRef.current = null
      clearInterval(id)
    }
    // args is already content-stable via argsKey below; re-running for every new array
    // identity would restart polling on every render for no reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    visible,
    documentVisible,
    machineId,
    machineRevision,
    moduleId,
    method,
    argsKey,
    intervalKey,
    speed,
    reloadTick
  ])

  return [applyPath(value, source.path, scope), refetch]
}

function identityPoint(p: HistoryPoint): HistoryPoint {
  return p
}

function useHistoryValue(moduleId: string, source: HistorySource, windowSec: number): unknown {
  const stream = source.stream
  const coreSystem = useApp((s) =>
    stream === SYSTEM_HISTORY_STREAM
      ? (s.system as unknown as HistoryPoint[])
      : EMPTY_HISTORY
  )
  const moduleSeries = useModuleSeries<HistoryPoint>(moduleId, stream)
  const live = stream === SYSTEM_HISTORY_STREAM ? coreSystem : moduleSeries
  return useWindowedSeries(stream, windowSec, live, identityPoint)
}

function useCoreValue(source: CoreSource, scope: unknown): unknown {
  const system = useApp((s) => (source.stream === 'system' ? s.system : EMPTY_HISTORY))
  const top = useApp((s) => (source.stream === 'top' ? s.topNow : null))
  const services = useApp((s) => (source.stream === 'services' ? s.servicesNow : null))
  if (source.stream === 'system') return applyPath(system.at(-1), source.path, scope)
  if (source.stream === 'top') return applyPath(top, source.path, scope)
  if (source.stream === 'services') return applyPath(services, source.path, scope)
  return undefined
}

function StreamData({ moduleId, source, opts, children }: Omit<BlockDataProps, 'source'> & {
  source: StreamSource
}): React.JSX.Element {
  const value = useStreamValue(moduleId, source, opts.scope)
  return React.createElement(React.Fragment, null, children({ value, refetch: NOOP }))
}

function InvokeData({ moduleId, source, opts, children }: Omit<BlockDataProps, 'source'> & {
  source: InvokeSource
}): React.JSX.Element {
  const [value, refetch] = useInvokeValue(moduleId, source, opts.visible, opts.scope)
  return React.createElement(React.Fragment, null, children({ value, refetch }))
}

function HistoryData({ moduleId, source, opts, children }: Omit<BlockDataProps, 'source'> & {
  source: HistorySource
}): React.JSX.Element {
  const value = useHistoryValue(
    moduleId,
    source,
    opts.windowSec ?? DEFAULT_BLOCK_WINDOW_SEC
  )
  return React.createElement(React.Fragment, null, children({ value, refetch: NOOP }))
}

function CoreData({ source, opts, children }: Omit<BlockDataProps, 'source' | 'moduleId'> & {
  source: CoreSource
}): React.JSX.Element {
  const value = useCoreValue(source, opts.scope)
  return React.createElement(React.Fragment, null, children({ value, refetch: NOOP }))
}

/**
 * A component boundary, rather than a conditional hook. Changing source kind
 * remounts the matching resolver, so a stream block never subscribes to core
 * metrics and an invoke block never keeps an archive query alive.
 */
export function BlockData(props: BlockDataProps): React.JSX.Element {
  switch (props.source.kind) {
    case 'stream':
      return React.createElement(StreamData, { ...props, key: 'stream', source: props.source })
    case 'invoke':
      return React.createElement(InvokeData, { ...props, key: 'invoke', source: props.source })
    case 'history':
      return React.createElement(HistoryData, { ...props, key: 'history', source: props.source })
    case 'core':
      return React.createElement(CoreData, { ...props, key: 'core', source: props.source })
  }
}
