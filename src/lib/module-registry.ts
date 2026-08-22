import type { LucideIcon } from 'lucide-react'
import {
  Activity,
  Boxes,
  Cable,
  Container,
  Cpu,
  FileText,
  FolderTree,
  Gauge,
  HardDrive,
  Info,
  Layers,
  ListTree,
  Network,
  Puzzle,
  Server,
  Settings2,
  Sparkles,
  Tag,
  Thermometer,
  Zap
} from 'lucide-react'
import { create } from 'zustand'
import type { ModuleDescriptor, ModuleManifest } from '@shared/modules'
import type { ModuleSpecsEntry, PageSpec, WidgetSpec } from '@shared/module-ui'
import { api } from '@/lib/api'
import { pushLatest, pushSeries, seedSeries } from '@/lib/module-bus'

/**
 * The renderer half of the module system. Every module's UI is a
 * declarative `ui/pages/*.json` / `ui/widgets/*.json` spec, fetched from the
 * server (`modules:specs`) and rendered by `src/modules/BlockRenderer.tsx` -
 * nothing here is compiled into this bundle, so installing, updating,
 * enabling or removing a module never touches it.
 */

interface ModuleSpecsState {
  list: ModuleSpecsEntry[]
  refresh(): Promise<void>
}

/**
 * What every enabled module's pages and widgets render from, per
 * `modules:specs`. Refreshed whenever the modules list changes (see
 * `setModules` in `src/state/store.ts`) - install, uninstall, reload, enable
 * and disable all end with a fresh copy of this.
 */
let specsRefreshGeneration = 0

export const useModuleSpecs = create<ModuleSpecsState>((set) => ({
  list: [],
  async refresh() {
    const generation = ++specsRefreshGeneration
    try {
      const list = await api.modules.specs()
      if (generation !== specsRefreshGeneration) return
      set({ list })
    } catch {
      // A transient failure keeps showing the previous specs rather than
      // blanking every module page at once.
    }
  }
}))

/** A module's manifest, once the specs payload carrying it has loaded. */
export function useModuleManifest(moduleId: string): ModuleManifest | undefined {
  return useModuleSpecs((s) => s.list.find((e) => e.id === moduleId)?.manifest)
}

/**
 * Mirror every enabled module's declared streams into the bus: the app's own
 * subscriptions, kept in sync with `useModuleSpecs` so a module installed,
 * enabled or reloaded after boot is picked up without a page refresh.
 */
export function subscribeModuleStreams(activeMachine: () => string | null = () => null): () => void {
  const active = new Map<string, () => void>()

  const wantedStreams = (): Array<{ id: string; event: string; kind: 'series' | 'latest' }> => {
    const out: Array<{ id: string; event: string; kind: 'series' | 'latest' }> = []
    for (const specEntry of useModuleSpecs.getState().list) {
      for (const stream of specEntry.manifest.streams ?? []) out.push({ id: specEntry.id, ...stream })
    }
    return out
  }

  const sync = (): void => {
    const wanted = new Map(wantedStreams().map((w) => [`${w.id}:${w.event}`, w]))
    for (const [key, off] of active) {
      if (!wanted.has(key)) {
        off()
        active.delete(key)
      }
    }
    for (const [key, w] of wanted) {
      if (active.has(key)) continue
      active.set(
        key,
        api.modules.onEvent(w.id, w.event, (payload) => {
          if (payload.machineId !== activeMachine()) return
          const value = payload.data
          if (w.kind === 'latest') pushLatest(w.id, w.event, value)
          else if (value && typeof (value as { t?: number }).t === 'number') {
            pushSeries(w.id, w.event, value as { t: number })
          }
        })
      )
    }
  }

  sync()
  const unsubscribeSpecs = useModuleSpecs.subscribe(sync)
  return () => {
    unsubscribeSpecs()
    for (const off of active.values()) off()
    active.clear()
  }
}

/**
 * Load what the main process had buffered before this renderer connected, so
 * a chart is not empty for the first tick. A `series` stream expects an
 * array, a `latest` stream a single value; anything else is ignored rather
 * than trusted.
 */
export function seedModuleSnapshots(snapshots: Record<string, Record<string, unknown>>): void {
  const seeded = new Set<string>()
  for (const specEntry of useModuleSpecs.getState().list) {
    for (const stream of specEntry.manifest.streams ?? []) {
      const key = `${specEntry.id}:${stream.event}`
      if (seeded.has(key)) continue
      const value = snapshots[specEntry.id]?.[stream.event]
      if (value == null) continue
      seeded.add(key)
      if (stream.kind === 'latest') pushLatest(specEntry.id, stream.event, value)
      else if (Array.isArray(value)) seedSeries(specEntry.id, stream.event, value as Array<{ t: number }>)
    }
  }
}

// ---------- Sidebar / Overview ----------

/** lucide-react icon names a module.json may reference; add to this as new icons are used. */
const ICONS: Record<string, LucideIcon> = {
  Activity,
  Boxes,
  Cable,
  Container,
  Cpu,
  FileText,
  FolderTree,
  Gauge,
  HardDrive,
  Info,
  Layers,
  ListTree,
  Network,
  Server,
  Settings2,
  Sparkles,
  Tag,
  Thermometer,
  Zap
}

export function iconByName(name: string | undefined): LucideIcon {
  return (name && ICONS[name]) || Puzzle
}

export interface SidebarPageEntry {
  id: string
  label: string
  icon?: LucideIcon
  order?: number
}

/**
 * One nav entry per enabled module that declares at least one page. `pages`
 * comes from the manifest; `specs` is whatever `modules:specs` has loaded so
 * far. The sidebar turns this into a single button or a dropdown (Dashboard.tsx).
 */
export interface SidebarEntry {
  id: string
  label: string
  icon: LucideIcon
  order: number
  pages: SidebarPageEntry[]
  specs: Record<string, PageSpec>
}

/** Route string for a module page, sent as `activeTab` / `ui:activeTab`. */
export function modulePageTab(moduleId: string, pageId: string): string {
  return `${moduleId}/${pageId}`
}

/**
 * `modules` and `specsList` are parameters (not read internally) so the
 * caller's own subscriptions decide when this needs to run again. Pages come
 * from the installed-module list — same intent as Settings → Overview cards.
 * Specs attach when `modules:specs` has caught up; a missing spec still keeps
 * the nav entry.
 */
export function sidebarEntries(
  enabledIds: readonly string[],
  modules: readonly ModuleDescriptor[],
  specsList: ModuleSpecsEntry[] = []
): SidebarEntry[] {
  const enabled = new Set(enabledIds)
  const specsById = new Map(specsList.map((e) => [e.id, e]))
  const out: SidebarEntry[] = []
  for (const module of modules) {
    const id = module.manifest.id
    if (!enabled.has(id) || module.problem) continue
    const specEntry = specsById.get(id)
    const pages = (module.manifest.pages ?? [])
      .map((p) => ({
        id: p.id,
        label: p.label,
        icon: iconByName(p.icon),
        order: p.order
      }))
      .sort((a, b) => (a.order ?? 50) - (b.order ?? 50) || a.id.localeCompare(b.id))
    const first = pages[0]
    if (!first) continue
    out.push({
      id,
      label: module.manifest.name,
      icon: first.icon ?? iconByName(undefined),
      order: first.order ?? 50,
      pages,
      specs: specEntry?.pages ?? {}
    })
  }
  return out
}

/**
 * One Overview widget a module declares. Settings uses this without a spec;
 * the Overview grid adds `spec` once `modules:specs` has loaded the JSON.
 */
export interface OverviewWidgetDecl {
  /** `<moduleId>.<widgetId>` - also the key the saved grid layout uses. */
  id: string
  moduleId: string
  widgetId: string
  moduleName: string
  label: string
  defaultEnabled?: boolean
  order?: number
}

/** One Overview widget of an enabled module that has a loaded spec for it. */
export interface OverviewWidgetEntry extends OverviewWidgetDecl {
  spec: WidgetSpec
}

/**
 * Settings → Overview cards. Comes from the installed-module list, not from
 * `modules:specs`: a widget toggle is intent, and the spec is only needed
 * when the Overview actually renders the card.
 */
export function listModuleWidgetToggles(
  enabledIds: readonly string[],
  modules: readonly ModuleDescriptor[]
): OverviewWidgetDecl[] {
  const enabled = new Set(enabledIds)
  const out: OverviewWidgetDecl[] = []
  for (const module of modules) {
    const id = module.manifest.id
    if (!enabled.has(id) || module.problem) continue
    for (const decl of module.manifest.widgets ?? []) {
      out.push({
        id: `${id}.${decl.id}`,
        moduleId: id,
        widgetId: decl.id,
        moduleName: module.manifest.name,
        label: decl.label,
        defaultEnabled: decl.defaultEnabled,
        order: decl.order
      })
    }
  }
  return out
}

export function listModuleWidgets(
  enabledIds: readonly string[],
  specsList: ModuleSpecsEntry[]
): OverviewWidgetEntry[] {
  const byId = new Map(specsList.map((e) => [e.id, e]))
  const out: OverviewWidgetEntry[] = []
  for (const id of enabledIds) {
    const specEntry = byId.get(id)
    for (const decl of specEntry?.manifest.widgets ?? []) {
      const spec = specEntry?.widgets[decl.id]
      if (!spec) continue
      out.push({
        id: `${id}.${decl.id}`,
        moduleId: id,
        widgetId: decl.id,
        moduleName: specEntry?.manifest.name ?? id,
        label: decl.label,
        defaultEnabled: decl.defaultEnabled,
        order: decl.order,
        spec
      })
    }
  }
  return out
}
