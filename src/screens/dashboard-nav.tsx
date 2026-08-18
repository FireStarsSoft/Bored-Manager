import * as React from 'react'
import { ChevronRight, LogOut, UserRound } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useApp } from '@/state/store'
import { modulePageTab, type SidebarEntry } from '@/lib/module-registry'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export interface TabDef {
  id: string
  label: string
  icon: LucideIcon
  /** Sidebar position; module pages declare their own and slot in between. */
  order: number
  component: React.ComponentType<{ active: boolean }>
}

export type NavRow =
  | { kind: 'core'; order: number; tab: TabDef }
  | { kind: 'module'; order: number; entry: SidebarEntry }

const NAV_BTN =
  'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50'

function navActive(active: boolean): string {
  return active
    ? 'bg-primary/15 font-medium text-primary'
    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
}

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

export function SidebarBody({
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
