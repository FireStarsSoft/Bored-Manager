import * as React from 'react'
import {
  Activity,
  ChevronRight,
  LogOut,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  TerminalSquare,
  UserRound
} from 'lucide-react'
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
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator
} from '@/components/ui/breadcrumb'
import { Separator } from '@/components/ui/separator'
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
  'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50'

function navActive(active: boolean): string {
  return active
    ? 'bg-primary/15 font-medium text-primary'
    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
}

type NavRow =
  | { kind: 'core'; order: number; tab: TabDef }
  | { kind: 'module'; order: number; entry: SidebarEntry }

/**
 * Collapsed to a rail, a nav row is only an icon - so the label it dropped has
 * to come back as a tooltip, or the rail is a row of guesses.
 */
function NavLabel({
  collapsed,
  label,
  children
}: {
  collapsed: boolean
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  if (!collapsed) return <>{children}</>
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}

function ModuleNavItem({
  entry,
  activeTab,
  setActiveTab,
  collapsed
}: {
  entry: SidebarEntry
  activeTab: string
  setActiveTab: (tab: string) => void
  collapsed: boolean
}): React.JSX.Element {
  const prefix = `${entry.id}/`
  const childActive = activeTab.startsWith(prefix)
  const [open, setOpen] = React.useState(childActive)

  React.useEffect(() => {
    if (childActive) setOpen(true)
  }, [childActive])

  const Icon = entry.icon

  // Collapsed, a dropdown has nowhere to open into: the whole module jumps to
  // its first page instead, and the palette covers reaching the others.
  if (entry.pages.length === 1 || collapsed) {
    const page = entry.pages[0]
    const route = modulePageTab(entry.id, page.id)
    return (
      <NavLabel collapsed={collapsed} label={entry.label}>
        <button
          type="button"
          onClick={() => setActiveTab(route)}
          className={cn(NAV_BTN, navActive(collapsed ? childActive : activeTab === route), collapsed && 'justify-center px-0')}
        >
          <Icon className="size-4 shrink-0" aria-hidden />
          {!collapsed && <span className="min-w-0 truncate">{entry.label}</span>}
        </button>
      </NavLabel>
    )
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-0.5">
      <CollapsibleTrigger className={cn(NAV_BTN, navActive(childActive))}>
        <Icon className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{entry.label}</span>
        <ChevronRight
          className={cn('ml-auto size-3.5 shrink-0 transition-transform', open && 'rotate-90')}
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-0.5 overflow-hidden data-closed:animate-collapsible-up data-open:animate-collapsible-down">
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

function SidebarBody({
  navRows,
  activeTab,
  setActiveTab,
  collapsed
}: {
  navRows: NavRow[]
  activeTab: string
  setActiveTab: (tab: string) => void
  collapsed: boolean
}): React.JSX.Element {
  const status = useApp((s) => s.status)
  const disconnect = useApp((s) => s.disconnect)
  const auth = useApp((s) => s.auth)
  const logout = useApp((s) => s.logout)
  // The target machine is reached through the server, so a socket that is down
  // means these readings are stale however connected the machine itself is.
  const serverUp = useApp((s) => s.server === 'open')

  return (
    <>
      <nav
        aria-label="Pages"
        className={cn('flex flex-1 flex-col gap-0.5 overflow-y-auto px-2', collapsed && 'px-1.5')}
      >
        {navRows.map((row) =>
          row.kind === 'core' ? (
            <NavLabel key={row.tab.id} collapsed={collapsed} label={row.tab.label}>
              <button
                type="button"
                onClick={() => setActiveTab(row.tab.id)}
                aria-current={activeTab === row.tab.id ? 'page' : undefined}
                className={cn(
                  NAV_BTN,
                  navActive(activeTab === row.tab.id),
                  collapsed && 'justify-center px-0'
                )}
              >
                <row.tab.icon className="size-4 shrink-0" aria-hidden />
                {!collapsed && row.tab.label}
              </button>
            </NavLabel>
          ) : (
            <ModuleNavItem
              key={row.entry.id}
              entry={row.entry}
              activeTab={activeTab}
              setActiveTab={setActiveTab}
              collapsed={collapsed}
            />
          )
        )}
      </nav>

      <div className={cn('border-t border-border p-2.5', collapsed && 'p-1.5')}>
        {!collapsed && (
          <div className="mb-1.5 min-w-0 px-0.5">
            <div className="flex items-center gap-1.5 text-xs">
              <span
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  serverUp ? 'bg-success' : 'bg-warning'
                )}
                aria-hidden
              />
              <span className="truncate font-medium">
                {status.username ? `${status.username}@` : ''}
                {status.host}
              </span>
            </div>
            <div className="mt-0.5 truncate pl-3 text-[0.7rem] text-muted-foreground">
              {status.mode === 'local' ? 'local machine' : 'ssh'}
              {status.isRoot ? ' · root' : status.hasSudo ? ' · sudo' : ' · no sudo'}
              {!serverUp && ' · reconnecting'}
            </div>
          </div>
        )}
        <NavLabel collapsed={collapsed} label={`Disconnect from ${status.host ?? 'the machine'}`}>
          <Button
            variant="ghost"
            size={collapsed ? 'icon-sm' : 'sm'}
            aria-label="Disconnect"
            onClick={() => void disconnect()}
            className={cn(
              'text-muted-foreground hover:bg-destructive/10 hover:text-destructive',
              !collapsed && 'w-full justify-start'
            )}
          >
            <LogOut aria-hidden /> {!collapsed && 'Disconnect'}
          </Button>
        </NavLabel>
        {/* Two different identities live here: who is connected to the target
            machine (above) and who is signed in to the WebUI (below). */}
        {auth?.authEnabled && (
          <>
            <Separator className="my-1.5" />
            {!collapsed && (
              <div className="flex items-center gap-1.5 px-2 text-[0.7rem] text-muted-foreground">
                <UserRound className="size-3 shrink-0" aria-hidden />
                <span className="truncate">{auth.username ?? 'signed in'}</span>
              </div>
            )}
            <NavLabel collapsed={collapsed} label={`Sign out ${auth.username ?? ''}`.trim()}>
              <Button
                variant="ghost"
                size={collapsed ? 'icon-sm' : 'sm'}
                aria-label="Sign out"
                onClick={() => void logout()}
                className={cn('mt-1 text-muted-foreground', !collapsed && 'w-full justify-start')}
              >
                <LogOut aria-hidden /> {!collapsed && 'Sign out'}
              </Button>
            </NavLabel>
          </>
        )}
      </div>
    </>
  )
}

const COLLAPSED_KEY = 'bm.navCollapsed'

export function Dashboard(): React.JSX.Element {
  const activeTab = useApp((s) => s.activeTab)
  const setActiveTab = useApp((s) => s.setActiveTab)
  const packagesOn = useApp((s) => s.settings?.collectors.packages !== false)
  const enabledIds = useApp((s) => s.enabledModules)
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
