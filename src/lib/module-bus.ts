import { create } from 'zustand'
import { pruneByAge } from '@/lib/utils'

/**
 * Where the snapshots a module's main half pushes are kept for its renderer
 * half. One store for every module rather than one per module: a card only
 * re-renders when the slice it selected changed, and a module that is switched
 * off simply stops being written to.
 */

/** How much live data is kept per series, matching the core metric buffers. */
const RING_MS = 5 * 60 * 1000

/** `<moduleId>:<event>` - flat keys keep the store shape independent of ids. */
function busKey(moduleId: string, event: string): string {
  return `${moduleId}:${event}`
}

interface Timestamped {
  t: number
}

function prune<T extends Timestamped>(arr: T[]): T[] {
  return pruneByAge(arr, RING_MS)
}

interface ModuleBusState {
  /** Growing series, pruned to the last RING_MS. */
  series: Record<string, Timestamped[]>
  /** Single most recent value, for sections that are not charted. */
  latest: Record<string, unknown>
}

const EMPTY: Timestamped[] = []

export const useModuleBus = create<ModuleBusState>(() => ({ series: {}, latest: {} }))

export function pushSeries(moduleId: string, event: string, value: Timestamped): void {
  const key = busKey(moduleId, event)
  useModuleBus.setState((s) => ({
    series: { ...s.series, [key]: prune([...(s.series[key] ?? []), value]) }
  }))
}

export function pushLatest(moduleId: string, event: string, value: unknown): void {
  const key = busKey(moduleId, event)
  useModuleBus.setState((s) => ({ latest: { ...s.latest, [key]: value } }))
}

/** Seed a series from what the main process had buffered before we connected. */
export function seedSeries(moduleId: string, event: string, values: Timestamped[]): void {
  const key = busKey(moduleId, event)
  // Pruned like a pushed sample: the main-process ring is the same length, but
  // that keeps "nothing older than RING_MS is in here" true without trusting it.
  useModuleBus.setState((s) => ({ series: { ...s.series, [key]: prune(values) } }))
}

/** Forget everything the modules collected; used on connect, disconnect and loss. */
export function clearModuleBus(): void {
  useModuleBus.setState({ series: {}, latest: {} })
}

/**
 * Forget one module's data. Called when it is switched off, so switching it
 * back on shows "waiting for data" rather than the last snapshot from before -
 * its collectors restart from scratch, and a stale reading looks current.
 */
export function clearModule(moduleId: string): void {
  const prefix = `${moduleId}:`
  useModuleBus.setState((s) => ({
    series: Object.fromEntries(Object.entries(s.series).filter(([k]) => !k.startsWith(prefix))),
    latest: Object.fromEntries(Object.entries(s.latest).filter(([k]) => !k.startsWith(prefix)))
  }))
}

/** The live series a module emits under `event`, oldest sample first. */
export function useModuleSeries<T extends Timestamped>(moduleId: string, event: string): T[] {
  return useModuleBus((s) => (s.series[busKey(moduleId, event)] ?? EMPTY) as T[])
}

/** The most recent value a module emitted under `event`, or null. */
export function useModuleLatest<T>(moduleId: string, event: string): T | null {
  return useModuleBus((s) => (s.latest[busKey(moduleId, event)] as T | undefined) ?? null)
}
