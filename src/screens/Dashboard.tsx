import * as React from 'react'
import { Activity, LogOut, Package, Settings, TerminalSquare, UserRound } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { PageSpec } from '@shared/module-ui'
import { useApp } from '@/state/store'
import {
  modulePageTab,
  sidebarEntries,
  useModuleSpecs,
  type SidebarEntry
} from '@/lib/module-registry'
import { ModulePage } from '@/modules/BlockRenderer'
import { cn } from '@/lib/utils'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { OverviewTab } from '@/tabs/OverviewTab'
import { PackagesTab } from '@/tabs/PackagesTab'
import { TerminalsTab } from '@/tabs/TerminalsTab'
import { SettingsTab } from '@/tabs/SettingsTab'

interface TabDef {
  id: string
  label: string
  icon: LucideIcon
  /** Sidebar position; module pages declare their own and slot in between. */
  order: number
  component: React.ComponentType<{ active: boolean }>
}

/**
 * The pages the app itself provides. Overview and Settings are always there;
 * Packages follows its collector switch. Everything between them comes from the
 * installed modules, which is why the order values leave gaps.
 */
const CORE_TABS: TabDef[] = [
  { id: 'overview', label: 'Overview', icon: Activity, order: 0, component: OverviewTab },
  { id: 'packages', label: 'Packages', icon: Package, order: 70, component: PackagesTab },
  { id: 'terminals', label: 'Terminals', icon: TerminalSquare, order: 80, component: TerminalsTab },
  { id: 'settings', label: 'Settings', icon: Settings, order: 90, component: SettingsTab }
]

const NAV_BTN =
  'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors cursor-pointer'

function navActive(active: boolean): string {
  return active
    ? 'bg-accent/15 font-medium text-accent'
    : 'text-muted hover:bg-card-hover hover:text-fg'
}

type NavRow =
  | { kind: 'core'; order: number; tab: TabDef }
  | { kind: 'module'; order: number; entry: SidebarEntry }

function ModuleNavItem({
  entry,
  activeTab,
  setActiveTab
}: {
  entry: SidebarEntry
  activeTab: string
  setActiveTab: (tab: string) => void
}): React.JSX.Element {
  const prefix = `${entry.id}/`
  const childActive = activeTab.startsWith(prefix)
  const [open, setOpen] = React.useState(childActive)

  React.useEffect(() => {
    if (childActive) setOpen(true)
  }, [childActive])

  const Icon = entry.icon
  if (entry.pages.length === 1) {
    const page = entry.pages[0]
    const route = modulePageTab(entry.id, page.id)
    return (
      <button
        type="button"
        onClick={() => setActiveTab(route)}
        className={cn(NAV_BTN, navActive(activeTab === route))}
      >
        <Icon className="h-4 w-4 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{entry.label}</span>
      </button>
    )
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-0.5">
      <CollapsibleTrigger className={cn(NAV_BTN, navActive(childActive))}>
        <Icon className="h-4 w-4 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{entry.label}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-0.5">
        {entry.pages.map((page) => {
          const route = modulePageTab(entry.id, page.id)
          return (
            <button
              key={page.id}
              type="button"
              onClick={() => setActiveTab(route)}
              className={cn(NAV_BTN, 'py-1.5 pl-7', navActive(activeTab === route))}
            >
              <span className="min-w-0 truncate">{page.label}</span>
            </button>
          )
        })}
      </CollapsibleContent>
    </Collapsible>
  )
}

export function Dashboard(): React.JSX.Element {
  const activeTab = useApp((s) => s.activeTab)
  const setActiveTab = useApp((s) => s.setActiveTab)
  const status = useApp((s) => s.status)
  const disconnect = useApp((s) => s.disconnect)
  const auth = useApp((s) => s.auth)
  const logout = useApp((s) => s.logout)
  const packagesOn = useApp((s) => s.settings?.collectors.packages !== false)
  const enabledIds = useApp((s) => s.enabledModules)
  const specsList = useModuleSpecs((s) => s.list)

  const coreTabs = React.useMemo(
    () => CORE_TABS.filter((t) => t.id !== 'packages' || packagesOn),
    [packagesOn]
  )
  const moduleEntries = React.useMemo(
    () => sidebarEntries(enabledIds, specsList),
    [enabledIds, specsList]
  )
  const navRows = React.useMemo((): NavRow[] => {
    const core: NavRow[] = coreTabs.map((tab) => ({ kind: 'core', order: tab.order, tab }))
    const mods: NavRow[] = moduleEntries.map((entry) => ({
      kind: 'module',
      order: entry.order,
      entry
    }))
    return [...core, ...mods].sort((a, b) => a.order - b.order)
  }, [coreTabs, moduleEntries])

  const modulePages = React.useMemo((): Array<{
    route: string
    moduleId: string
    pageId: string
    spec: PageSpec
  }> => {
    const out: Array<{ route: string; moduleId: string; pageId: string; spec: PageSpec }> = []
    for (const entry of moduleEntries) {
      for (const page of entry.pages) {
        const spec = entry.specs[page.id]
        if (!spec) continue
        out.push({
          route: modulePageTab(entry.id, page.id),
          moduleId: entry.id,
          pageId: page.id,
          spec
        })
      }
    }
    return out
  }, [moduleEntries])

  // If the page that was open just disappeared, fall back to Overview.
  React.useEffect(() => {
    if (coreTabs.some((t) => t.id === activeTab)) return
    if (modulePages.some((p) => p.route === activeTab)) return
    setActiveTab('overview')
  }, [coreTabs, modulePages, activeTab, setActiveTab])

  return (
    <div className="flex h-full bg-bg">
      {/* Sidebar */}
      <aside className="flex w-44 shrink-0 flex-col border-r border-border bg-surface">
        <div className="px-3 py-3.5 text-sm font-bold tracking-tight">
          Bored <span className="text-gpu">Manager</span>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2">
          {navRows.map((row) =>
            row.kind === 'core' ? (
              <button
                key={row.tab.id}
                type="button"
                onClick={() => setActiveTab(row.tab.id)}
                className={cn(NAV_BTN, navActive(activeTab === row.tab.id))}
              >
                <row.tab.icon className="h-4 w-4 shrink-0" aria-hidden />
                {row.tab.label}
              </button>
            ) : (
              <ModuleNavItem
                key={row.entry.id}
                entry={row.entry}
                activeTab={activeTab}
                setActiveTab={setActiveTab}
              />
            )
          )}
        </nav>
        <div className="border-t border-border p-2.5">
          <div className="mb-1.5 min-w-0 px-0.5">
            <div className="flex items-center gap-1.5 text-xs">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-good" />
              <span className="truncate font-medium">
                {status.username ? `${status.username}@` : ''}
                {status.host}
              </span>
            </div>
            <div className="mt-0.5 truncate pl-3 text-[0.7rem] text-muted">
              {status.mode === 'local' ? 'local machine' : 'ssh'}
              {status.isRoot ? ' · root' : status.hasSudo ? ' · sudo' : ' · no sudo'}
            </div>
          </div>
          <button
            onClick={() => void disconnect()}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted transition-colors hover:bg-bad/10 hover:text-bad cursor-pointer"
          >
            <LogOut className="h-3.5 w-3.5" /> Disconnect
          </button>
          {/* Two different identities live here: who is connected to the target
              machine (above) and who is signed in to the WebUI (below). */}
          {auth?.authEnabled && (
            <div className="mt-1.5 border-t border-border pt-1.5">
              <div className="flex items-center gap-1.5 px-0.5 text-[0.7rem] text-muted">
                <UserRound className="h-3 w-3 shrink-0" aria-hidden />
                <span className="truncate">{auth.username ?? 'signed in'}</span>
              </div>
              <button
                onClick={() => void logout()}
                className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted transition-colors hover:bg-card-hover hover:text-fg cursor-pointer"
              >
                <LogOut className="h-3.5 w-3.5" /> Sign out
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* All pages stay mounted so terminals & charts keep their state. */}
      <main className="min-w-0 flex-1">
        {coreTabs.map((t) => (
          <div key={t.id} className={cn('h-full', activeTab !== t.id && 'hidden')}>
            <t.component active={activeTab === t.id} />
          </div>
        ))}
        {modulePages.map((p) => (
          <div key={p.route} className={cn('h-full', activeTab !== p.route && 'hidden')}>
            <ModulePage
              moduleId={p.moduleId}
              pageId={p.pageId}
              spec={p.spec}
              visible={activeTab === p.route}
            />
          </div>
        ))}
      </main>
    </div>
  )
}
