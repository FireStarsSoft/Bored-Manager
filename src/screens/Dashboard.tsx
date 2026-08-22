import * as React from 'react'
import {
  Activity,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  TerminalSquare
} from 'lucide-react'
import type { PageSpec } from '@shared/module-ui'
import { useApp } from '@/state/store'
import { modulePageTab, sidebarEntries, useModuleSpecs } from '@/lib/module-registry'
import { ModulePage } from '@/modules/BlockRenderer'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator
} from '@/components/ui/breadcrumb'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  CommandPalette,
  PALETTE_SHORTCUT,
  openCommandPalette,
  type PaletteEntry
} from '@/components/command-palette'
import { ThemeToggle } from '@/components/theme-toggle'
import { OverviewTab } from '@/tabs/OverviewTab'
import { PackagesTab } from '@/tabs/PackagesTab'
import { TerminalsTab } from '@/tabs/TerminalsTab'
import { SettingsTab } from '@/tabs/SettingsTab'
import { SidebarBody, type NavRow, type TabDef } from './dashboard-nav'

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

const COLLAPSED_KEY = 'bm.navCollapsed'

export function Dashboard(): React.JSX.Element {
  const activeTab = useApp((s) => s.activeTab)
  const setActiveTab = useApp((s) => s.setActiveTab)
  const packagesOn = useApp((s) => s.settings?.collectors.packages !== false)
  const enabledIds = useApp((s) => s.enabledModules)
  const modules = useApp((s) => s.modules)
  const specsList = useModuleSpecs((s) => s.list)

  const [collapsed, setCollapsed] = React.useState(
    () => localStorage.getItem(COLLAPSED_KEY) === '1'
  )
  const [drawerOpen, setDrawerOpen] = React.useState(false)

  const toggleCollapsed = (): void => {
    setCollapsed((prev) => {
      localStorage.setItem(COLLAPSED_KEY, prev ? '0' : '1')
      return !prev
    })
  }

  const coreTabs = React.useMemo(
    () => CORE_TABS.filter((t) => t.id !== 'packages' || packagesOn),
    [packagesOn]
  )
  const moduleEntries = React.useMemo(
    () => sidebarEntries(enabledIds, modules, specsList),
    [enabledIds, modules, specsList]
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

  const paletteEntries = React.useMemo((): PaletteEntry[] => {
    const out: PaletteEntry[] = coreTabs.map((tab) => ({
      route: tab.id,
      label: tab.label,
      group: 'Bored Manager',
      icon: <tab.icon aria-hidden />
    }))
    for (const entry of moduleEntries) {
      const Icon = entry.icon
      for (const page of entry.pages) {
        out.push({
          route: modulePageTab(entry.id, page.id),
          label: page.label,
          group: entry.label,
          icon: <Icon aria-hidden />
        })
      }
    }
    return out
  }, [coreTabs, moduleEntries])

  /**
   * Where you are, for the header. A module contributes a second crumb only
   * when the page is called something else: a one-page module usually names its
   * page after itself, and "Sensors / Sensors" says nothing twice.
   */
  const crumbs = React.useMemo((): Array<{ label: string; route?: string }> => {
    const core = coreTabs.find((t) => t.id === activeTab)
    if (core) return [{ label: core.label }]
    for (const entry of moduleEntries) {
      for (const page of entry.pages) {
        if (modulePageTab(entry.id, page.id) !== activeTab) continue
        if (page.label === entry.label) return [{ label: entry.label }]
        return [
          { label: entry.label, route: modulePageTab(entry.id, entry.pages[0].id) },
          { label: page.label }
        ]
      }
    }
    return []
  }, [activeTab, coreTabs, moduleEntries])

  // If the page that was open just disappeared, fall back to Overview.
  React.useEffect(() => {
    if (coreTabs.some((t) => t.id === activeTab)) return
    if (modulePages.some((p) => p.route === activeTab)) return
    setActiveTab('overview')
  }, [coreTabs, modulePages, activeTab, setActiveTab])

  const go = (route: string): void => {
    setActiveTab(route)
    setDrawerOpen(false)
  }

  return (
    <div className="flex h-full bg-background">
      {/* Rail / full sidebar, from md up. Below that it is the drawer. */}
      <aside
        className={cn(
          'hidden shrink-0 flex-col border-r border-border bg-sidebar transition-[width] duration-200 md:flex',
          collapsed ? 'w-13' : 'w-44'
        )}
      >
        <div
          className={cn(
            'flex items-center gap-1 px-2 py-2.5',
            collapsed && 'justify-center px-1.5'
          )}
        >
          {!collapsed && (
            <span className="min-w-0 flex-1 truncate px-0.5 text-sm font-bold tracking-tight">
              Bored <span className="text-metric-gpu">Manager</span>
            </span>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
                aria-expanded={!collapsed}
                onClick={toggleCollapsed}
              >
                {collapsed ? <PanelLeftOpen aria-hidden /> : <PanelLeftClose aria-hidden />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
            </TooltipContent>
          </Tooltip>
        </div>
        <SidebarBody
          navRows={navRows}
          activeTab={activeTab}
          setActiveTab={go}
          collapsed={collapsed}
        />
      </aside>

      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="left" className="w-60 gap-0 p-0 sm:max-w-none">
          <SheetHeader>
            <SheetTitle>
              Bored <span className="text-metric-gpu">Manager</span>
            </SheetTitle>
          </SheetHeader>
          <SidebarBody
            navRows={navRows}
            activeTab={activeTab}
            setActiveTab={go}
            collapsed={false}
          />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-sidebar px-2">
          <Button
            variant="ghost"
            size="icon-sm"
            className="md:hidden"
            aria-label="Open the navigation"
            onClick={() => setDrawerOpen(true)}
          >
            <PanelLeftOpen aria-hidden />
          </Button>
          <Breadcrumb className="min-w-0">
            <BreadcrumbList className="text-xs">
              {crumbs.map((crumb, i) => (
                <React.Fragment key={`${i}-${crumb.label}`}>
                  {i > 0 && <BreadcrumbSeparator />}
                  <BreadcrumbItem className="min-w-0">
                    {crumb.route ? (
                      <BreadcrumbLink asChild>
                        <button type="button" className="truncate" onClick={() => go(crumb.route!)}>
                          {crumb.label}
                        </button>
                      </BreadcrumbLink>
                    ) : (
                      <BreadcrumbPage className="truncate font-medium">
                        {crumb.label}
                      </BreadcrumbPage>
                    )}
                  </BreadcrumbItem>
                </React.Fragment>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={openCommandPalette}
              className="text-muted-foreground"
            >
              <Search aria-hidden />
              <span className="hidden sm:inline">Go to page</span>
              <kbd className="ml-1 hidden rounded border border-border px-1 font-sans text-[0.65rem] sm:inline">
                {PALETTE_SHORTCUT}
              </kbd>
            </Button>
            <ThemeToggle />
          </div>
        </header>

        {/* All pages stay mounted so terminals & charts keep their state. */}
        <main className="min-h-0 min-w-0 flex-1">
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

      <CommandPalette entries={paletteEntries} onSelect={go} />
    </div>
  )
}
