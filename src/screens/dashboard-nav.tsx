import * as React from 'react'
import {
  Check,
  ChevronsUpDown,
  ChevronRight,
  LogOut,
  Plus,
  RotateCw,
  Server,
  UserRound,
  X
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { HostKeyChallenge } from '@shared/types'
import { useApp, type SessionMachine } from '@/state/store'
import { modulePageTab, type SidebarEntry } from '@/lib/module-registry'
import { cn, errorMessage } from '@/lib/utils'
import { AddMachineDialog } from '@/components/add-machine-dialog'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
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

interface MachineSummary {
  machineId: string
  mode?: 'local' | 'ssh'
  label?: string
  host?: string
  port?: number
  username?: string
}

function machineLabel(machine: MachineSummary): string {
  const label = machine.label?.trim()
  if (label) return label
  if (machine.mode === 'local') return 'Local machine'
  if (machine.host) return machine.username ? `${machine.username}@${machine.host}` : machine.host
  return machine.machineId
}

function machineEndpoint(machine: MachineSummary): string {
  if (machine.mode === 'local') return machine.host ?? 'Local machine'
  if (!machine.host) return 'SSH machine'
  const host = machine.username ? `${machine.username}@${machine.host}` : machine.host
  return machine.port ? `${host}:${machine.port}` : host
}

function MachineSwitcher({ collapsed }: { collapsed: boolean }): React.JSX.Element {
  const machines = useApp((s) => s.machines)
  const activeMachineId = useApp((s) => s.activeMachineId)
  const sessionMachines = useApp((s) => s.sessionMachines)
  const connecting = useApp((s) => s.connecting)
  const serverUp = useApp((s) => s.server === 'open')
  const connect = useApp((s) => s.connect)
  const reconnect = useApp((s) => s.reconnect)
  const disconnect = useApp((s) => s.disconnect)
  const setActiveMachine = useApp((s) => s.setActiveMachine)
  const showNotice = useApp((s) => s.showNotice)

  const connectedMachines = React.useMemo(
    () => machines.filter((machine) => machine.connected),
    [machines]
  )
  const connectedIds = React.useMemo(
    () => new Set(connectedMachines.map((machine) => machine.machineId)),
    [connectedMachines]
  )
  const disconnectedSessionMachines = React.useMemo(
    () => sessionMachines.filter((machine) => !connectedIds.has(machine.machineId)),
    [connectedIds, sessionMachines]
  )
  const activeMachine = connectedMachines.find(
    (machine) => machine.machineId === activeMachineId
  )

  const [addMachineOpen, setAddMachineOpen] = React.useState(false)
  const [initialMachine, setInitialMachine] = React.useState<SessionMachine | undefined>()
  const [pendingHostKey, setPendingHostKey] = React.useState<{
    machine: SessionMachine
    challenge: HostKeyChallenge
  } | null>(null)

  const openMachineDialog = (machine?: SessionMachine): void => {
    setInitialMachine(machine)
    setAddMachineOpen(true)
  }

  const handleDialogOpenChange = (open: boolean): void => {
    setAddMachineOpen(open)
    if (!open) setInitialMachine(undefined)
  }

  const activateMachine = (machineId: string): void => {
    if (machineId === activeMachineId) return
    void setActiveMachine(machineId).catch((err) => showNotice('error', errorMessage(err)))
  }

  const disconnectMachine = (machineId: string): void => {
    void disconnect(machineId).catch((err) => showNotice('error', errorMessage(err)))
  }

  const reconnectSessionMachine = async (
    machine: SessionMachine,
    confirmedHostKey?: HostKeyChallenge
  ): Promise<void> => {
    if (machine.mode === 'ssh' && !machine.savedId) {
      openMachineDialog(machine)
      return
    }

    try {
      const result = machine.savedId
        ? await reconnect(
            machine.savedId,
            confirmedHostKey
              ? {
                  fingerprint: confirmedHostKey.fingerprint,
                  token: confirmedHostKey.token
                }
              : undefined
          )
        : await connect({ mode: 'local' })

      if (result.hostKey) {
        setPendingHostKey({ machine, challenge: result.hostKey })
        return
      }
      if (result.needsCredentials) openMachineDialog(machine)
    } catch (err) {
      showNotice('error', errorMessage(err))
    }
  }

  const activeSubtitle = activeMachine
    ? [
        activeMachine.mode === 'local' ? 'local' : 'ssh',
        activeMachine.isRoot ? 'root' : activeMachine.hasSudo ? 'sudo' : 'no sudo',
        !serverUp ? 'socket reconnecting' : null
      ]
        .filter(Boolean)
        .join(' · ')
    : 'No connected machine'
  const activeLabel = activeMachine ? machineLabel(activeMachine) : 'Select machine'

  const expandedTrigger = (
    <Button
      variant="ghost"
      className="h-auto min-w-0 flex-1 justify-start gap-2 px-2 py-1.5 text-left"
      aria-label={`${activeLabel}. Choose active machine`}
    >
      <span
        className={cn(
          'size-2 shrink-0 rounded-full',
          activeMachine && serverUp ? 'bg-success' : 'bg-warning'
        )}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{activeLabel}</span>
        <span className="block truncate text-[0.7rem] font-normal text-muted-foreground">
          {activeSubtitle}
        </span>
      </span>
      <ChevronsUpDown className="size-3.5 text-muted-foreground" aria-hidden />
    </Button>
  )

  const collapsedTrigger = (
    <Button
      variant="ghost"
      size="icon-sm"
      className="relative"
      aria-label={`${activeLabel}. Choose active machine`}
    >
      <Server aria-hidden />
      <span
        className={cn(
          'absolute bottom-0.5 right-0.5 size-1.5 rounded-full ring-1 ring-background',
          activeMachine && serverUp ? 'bg-success' : 'bg-warning'
        )}
        aria-hidden
      />
    </Button>
  )

  const challenge = pendingHostKey?.challenge

  return (
    <>
      <div className={cn('flex gap-1', collapsed && 'flex-col items-center')}>
        <DropdownMenu>
          {collapsed ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>{collapsedTrigger}</DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="right">{activeLabel}</TooltipContent>
            </Tooltip>
          ) : (
            <DropdownMenuTrigger asChild>{expandedTrigger}</DropdownMenuTrigger>
          )}
          <DropdownMenuContent side="top" align="start" className="w-72">
            {connectedMachines.length > 0 && (
              <>
                <DropdownMenuLabel>Connected</DropdownMenuLabel>
                {connectedMachines.map((machine) => {
                  const active = machine.machineId === activeMachineId
                  return (
                    <DropdownMenuItem
                      key={machine.machineId}
                      className="py-1.5"
                      onSelect={() => activateMachine(machine.machineId)}
                    >
                      <span className="size-2 shrink-0 rounded-full bg-success" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{machineLabel(machine)}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {machineEndpoint(machine)}
                        </span>
                      </span>
                      {active && <Check className="size-4 text-primary" aria-hidden />}
                      <button
                        type="button"
                        className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring/50"
                        aria-label={`Disconnect ${machineLabel(machine)}`}
                        title={`Disconnect ${machineLabel(machine)}`}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          disconnectMachine(machine.machineId)
                        }}
                      >
                        <X className="size-3.5" aria-hidden />
                      </button>
                    </DropdownMenuItem>
                  )
                })}
              </>
            )}

            {disconnectedSessionMachines.length > 0 && (
              <>
                <DropdownMenuLabel>This session</DropdownMenuLabel>
                {disconnectedSessionMachines.map((machine) => (
                  <DropdownMenuItem
                    key={machine.machineId}
                    className="py-1.5"
                    disabled={connecting}
                    onSelect={() => void reconnectSessionMachine(machine)}
                  >
                    <span
                      className="size-2 shrink-0 rounded-full bg-muted-foreground/40"
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{machineLabel(machine)}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {machineEndpoint(machine)}
                      </span>
                    </span>
                    <RotateCw className="size-3.5 text-muted-foreground" aria-hidden />
                  </DropdownMenuItem>
                ))}
              </>
            )}

            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => openMachineDialog()}>
              <Plus aria-hidden /> Add machine
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Add machine"
              onClick={() => openMachineDialog()}
            >
              <Plus aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent side={collapsed ? 'right' : 'top'}>Add machine</TooltipContent>
        </Tooltip>
      </div>

      <AddMachineDialog
        open={addMachineOpen}
        onOpenChange={handleDialogOpenChange}
        initial={initialMachine}
      />

      <ConfirmDialog
        open={challenge != null}
        onOpenChange={(open) => !open && setPendingHostKey(null)}
        title={challenge?.kind === 'changed' ? 'SSH host key changed' : 'Unknown SSH host key'}
        confirmLabel="Trust this host"
        destructive={challenge?.kind === 'changed'}
        message={
          challenge && (
            <>
              {challenge.kind === 'changed'
                ? 'The key this machine presented is not the one stored from last time. Someone may be intercepting the connection.'
                : 'This is the first time this app has seen this host. Compare the fingerprint with the machine before trusting it.'}
              <div className="mt-2 font-medium">
                {challenge.host}:{challenge.port}
              </div>
              <div className="mt-1 break-all font-mono text-xs">
                SHA256:{challenge.fingerprint}
              </div>
            </>
          )
        }
        onConfirm={() => {
          const pending = pendingHostKey
          setPendingHostKey(null)
          if (pending) void reconnectSessionMachine(pending.machine, pending.challenge)
        }}
      />
    </>
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
  const auth = useApp((s) => s.auth)
  const logout = useApp((s) => s.logout)

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
        <MachineSwitcher collapsed={collapsed} />
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
