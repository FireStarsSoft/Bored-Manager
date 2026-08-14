import * as React from 'react'
import {
  ArrowUpCircle,
  Box,
  Clock,
  Download,
  History,
  Package as PackageIcon,
  RefreshCw,
  Search,
  Trash2,
  X
} from 'lucide-react'
import type {
  PackageHistoryEntry,
  PackageInfo,
  PackageSearchResult,
  PackagesOverview,
  PkgAction,
  PkgActionState,
  UpgradablePackage
} from '@shared/types'
import { api } from '@/lib/api'
import { useApp } from '@/state/store'
import { StatCard } from '@/components/StatCard'
import { DataTable, type DataTableColumns } from '@/components/data-table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn, formatBytes } from '@/lib/utils'

/** Rows per page of the installed list; the full list can be many thousands. */
const MAX_INSTALLED_ROWS = 500
const MAX_LOG_CHARS = 200_000

const historyColumns: DataTableColumns<PackageHistoryEntry> = [
  {
    accessorKey: 'date',
    header: 'When',
    cell: (c) => <span className="mono text-muted-foreground">{c.getValue<string>()}</span>
  },
  {
    accessorKey: 'action',
    header: 'Action',
    cell: (c) => {
      const action = c.getValue<string>()
      return (
        <Badge
          variant={
            /remove|purge/i.test(action)
              ? 'destructive'
              : /upgrade/i.test(action)
                ? 'default'
                : 'success'
          }
        >
          {action}
        </Badge>
      )
    }
  },
  {
    accessorKey: 'packages',
    header: 'Packages',
    cell: (c) => (
      <span className="text-muted-foreground" title={c.getValue<string>()}>
        {c.getValue<string>()}
      </span>
    )
  }
]

interface PendingConfirm {
  action: PkgAction
  pkg?: string
  title: string
  message: React.ReactNode
  confirmLabel: string
}

export function PackagesTab({ active }: { active: boolean }): React.JSX.Element {
  const status = useApp((s) => s.status)
  const showNotice = useApp((s) => s.showNotice)

  const [overview, setOverview] = React.useState<PackagesOverview | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [filter, setFilter] = React.useState('')
  const [searchQuery, setSearchQuery] = React.useState('')
  const [searchResults, setSearchResults] = React.useState<PackageSearchResult[] | null>(null)
  const [searching, setSearching] = React.useState(false)
  const [log, setLog] = React.useState('')
  const [opState, setOpState] = React.useState<PkgActionState>({ running: false })
  const [confirm, setConfirm] = React.useState<PendingConfirm | null>(null)
  const loadedRef = React.useRef(false)
  const logRef = React.useRef<HTMLPreElement | null>(null)

  const load = React.useCallback(async (): Promise<void> => {
    if (!status.connected) return
    setLoading(true)
    try {
      setOverview(await api.packages.overview())
    } finally {
      setLoading(false)
    }
  }, [status.connected])

  // Load once when the tab is first opened (data is on-demand, no polling).
  React.useEffect(() => {
    if (active && status.connected && !loadedRef.current) {
      loadedRef.current = true
      void load()
    }
    if (!status.connected) {
      loadedRef.current = false
      setOverview(null)
      setLog('')
      setSearchResults(null)
    }
  }, [active, status.connected, load])

  // Live output + state of package operations.
  React.useEffect(() => {
    const offLog = api.packages.onLog((data) =>
      setLog((prev) => {
        const next = prev + data
        return next.length > MAX_LOG_CHARS ? next.slice(next.length - MAX_LOG_CHARS) : next
      })
    )
    const offState = api.packages.onState((s) => {
      setOpState(s)
      if (!s.running && s.exitCode != null) {
        if (s.exitCode === 0) showNotice('info', `Package operation finished: ${s.action}`)
        else showNotice('error', `Package operation failed (exit ${s.exitCode})`)
        void load()
      }
    })
    void api.packages.state().then(setOpState)
    return () => {
      offLog()
      offState()
    }
  }, [load, showNotice])

  React.useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [log])

  const runAction = async (action: PkgAction, pkg?: string): Promise<void> => {
    setLog('')
    const res = await api.packages.action(action, pkg)
    if (!res.ok) showNotice('error', res.error || 'Could not start the operation')
  }

  const doSearch = async (): Promise<void> => {
    const q = searchQuery.trim()
    if (!q) return
    setSearching(true)
    try {
      setSearchResults(await api.packages.search(q))
    } finally {
      setSearching(false)
    }
  }

  const busy = opState.running
  const manager = overview?.manager
  const installedRows = overview?.installed ?? []

  // Only what the header counter needs; the table itself filters through
  // TanStack's global filter so sorting and paging stay in step with it.
  const matchCount = React.useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return installedRows.length
    return installedRows.filter(
      (p) => p.name.toLowerCase().includes(q) || p.summary.toLowerCase().includes(q)
    ).length
  }, [installedRows, filter])

  const upgradableColumns = React.useMemo<DataTableColumns<UpgradablePackage>>(
    () => [
      { accessorKey: 'name', header: 'Package', cell: (c) => <span className="font-medium">{c.getValue<string>()}</span> },
      {
        accessorKey: 'currentVersion',
        header: 'Current',
        cell: (c) => <span className="mono text-muted-foreground">{c.getValue<string>() || '—'}</span>
      },
      {
        accessorKey: 'newVersion',
        header: 'New version',
        cell: (c) => <span className="mono text-success">{c.getValue<string>()}</span>
      },
      {
        accessorKey: 'repo',
        header: 'Repo',
        cell: (c) => <span className="text-muted-foreground">{c.getValue<string>() || '—'}</span>
      },
      {
        id: 'actions',
        header: '',
        enableSorting: false,
        meta: { align: 'right' },
        cell: (c) => (
          <Button
            variant="secondary"
            size="xs"
            disabled={busy}
            onClick={() => void runAction('upgrade', c.row.original.name)}
          >
            Upgrade
          </Button>
        )
      }
    ],
    [busy]
  )

  const searchColumns = React.useMemo<DataTableColumns<PackageSearchResult>>(
    () => [
      { accessorKey: 'name', header: 'Package', cell: (c) => <span className="font-medium">{c.getValue<string>()}</span> },
      {
        accessorKey: 'summary',
        header: 'Description',
        cell: (c) => <span className="text-muted-foreground">{c.getValue<string>()}</span>
      },
      {
        id: 'actions',
        header: '',
        enableSorting: false,
        meta: { align: 'right' },
        cell: (c) => (
          <Button
            variant="secondary"
            size="xs"
            disabled={busy}
            onClick={() => void runAction('install', c.row.original.name)}
          >
            Install
          </Button>
        )
      }
    ],
    [busy]
  )

  const installedColumns = React.useMemo<DataTableColumns<PackageInfo>>(
    () => [
      {
        accessorKey: 'name',
        header: 'Package',
        // Truncated data cells keep the native tooltip: a Radix one per cell
        // would mean hundreds of instances on a page of packages.
        cell: (c) => (
          <span className="font-medium" title={c.getValue<string>()}>
            {c.getValue<string>()}
          </span>
        )
      },
      {
        accessorKey: 'version',
        header: 'Version',
        cell: (c) => (
          <span className="mono text-muted-foreground" title={c.getValue<string>()}>
            {c.getValue<string>()}
          </span>
        )
      },
      {
        accessorKey: 'arch',
        header: 'Arch',
        cell: (c) => <span className="text-muted-foreground">{c.getValue<string>() || '—'}</span>
      },
      {
        accessorKey: 'sizeKb',
        header: 'Size',
        meta: { align: 'right' },
        cell: (c) => {
          const kb = c.getValue<number>()
          return <span className="text-muted-foreground">{kb ? formatBytes(kb * 1024) : '—'}</span>
        }
      },
      {
        accessorKey: 'summary',
        header: 'Description',
        cell: (c) => (
          <span className="text-muted-foreground" title={c.getValue<string>()}>
            {c.getValue<string>() || '—'}
          </span>
        )
      },
      {
        id: 'actions',
        header: '',
        enableSorting: false,
        enableGlobalFilter: false,
        meta: { align: 'right' },
        cell: (c) => {
          const p = c.row.original
          return (
            <div className="flex justify-end gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove ${p.name}`}
                    className="hover:bg-warning/20 hover:text-warning"
                    disabled={busy}
                    onClick={() =>
                      setConfirm({
                        action: 'remove',
                        pkg: p.name,
                        title: 'Remove package',
                        message: (
                          <>
                            Remove <b>{p.name}</b> ({p.version})? Configuration files are kept.
                          </>
                        ),
                        confirmLabel: 'Remove'
                      })
                    }
                  >
                    <X aria-hidden />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Remove (keep config)</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Purge ${p.name}`}
                    className="hover:bg-destructive/20 hover:text-destructive"
                    disabled={busy}
                    onClick={() =>
                      setConfirm({
                        action: 'purge',
                        pkg: p.name,
                        title: 'Purge package',
                        message: (
                          <>
                            Purge <b>{p.name}</b> ({p.version})? The package and its configuration
                            files are removed.
                          </>
                        ),
                        confirmLabel: 'Purge'
                      })
                    }
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Purge (remove including config)</TooltipContent>
              </Tooltip>
            </div>
          )
        }
      }
    ],
    [busy]
  )

  if (overview && manager === 'none') {
    return (
      <div className="h-full overflow-y-auto p-3">
        <Card className="p-4 text-sm text-muted-foreground">
          No supported package manager (apt, dnf or pacman) was found on the target machine.
        </Card>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto p-3">
      {/* Header. The page is named by the breadcrumb, so this only says which
          package manager the machine turned out to have. */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">
          {overview ? `manager: ${overview.manager}` : loading ? 'loading…' : 'not loaded yet'}
        </div>
        <div className="flex items-center gap-2">
          {!status.hasSudo && (
            <Badge variant="warning">no sudo - install/remove/upgrade will likely fail</Badge>
          )}
          <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading || busy}>
            <RefreshCw className={cn('size-3', loading && 'animate-spin')} /> Reload
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void runAction('update')} disabled={busy}>
            <Download className="size-3" /> Update lists
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || !overview?.upgradableCount}
            onClick={() =>
              setConfirm({
                action: 'upgradeAll',
                title: 'Upgrade all packages',
                message: (
                  <>
                    Upgrade <b>{overview?.upgradableCount ?? 0}</b> packages on{' '}
                    <b>{status.host}</b>? This can take a while; output is streamed below.
                  </>
                ),
                confirmLabel: 'Upgrade all'
              })
            }
          >
            <ArrowUpCircle className="size-3" /> Upgrade all
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() =>
              setConfirm({
                action: 'autoremove',
                title: 'Autoremove unused packages',
                message: <>Remove packages that were installed as dependencies and are no longer needed?</>,
                confirmLabel: 'Autoremove'
              })
            }
          >
            <Trash2 className="size-3" /> Autoremove
          </Button>
        </div>
      </div>

      {/* Summary widgets */}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard
          title="Installed"
          icon={Box}
          color="primary"
          value={overview ? String(overview.installedCount) : '…'}
          sub="packages on the system"
        />
        <StatCard
          title="Upgradable"
          icon={ArrowUpCircle}
          color={overview?.upgradableCount ? 'warning' : 'success'}
          value={overview ? String(overview.upgradableCount) : '…'}
          sub={overview?.upgradableCount ? 'updates available' : 'everything up to date'}
        />
        <StatCard
          title="Lists updated"
          icon={Clock}
          color="cpu"
          value={
            overview?.lastListUpdate ? new Date(overview.lastListUpdate).toLocaleDateString() : '—'
          }
          sub={
            overview?.lastListUpdate
              ? new Date(overview.lastListUpdate).toLocaleTimeString()
              : 'unknown'
          }
        />
        <StatCard
          title="Installed size"
          icon={PackageIcon}
          color="mem"
          value={
            overview?.totalInstalledSizeKb != null
              ? formatBytes(overview.totalInstalledSizeKb * 1024)
              : '—'
          }
          sub="sum of package sizes"
        />
      </div>

      {/* Operation log */}
      {(log || busy) && (
        <Card className="mt-3 overflow-hidden">
          <div className="flex items-center justify-between px-3 pt-3">
            <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <RefreshCw className={cn('size-3.5 text-primary', busy && 'animate-spin')} />
              {busy
                ? `Running: ${opState.action}${opState.target ? ` ${opState.target}` : ''}`
                : 'Last operation output'}
            </div>
            <div className="flex gap-1.5">
              {busy && (
                <Button variant="secondary" size="sm" onClick={() => void api.packages.cancel()}>
                  <X className="size-3" /> Cancel
                </Button>
              )}
              {!busy && log && (
                <Button variant="secondary" size="sm" onClick={() => setLog('')}>
                  <X className="size-3" /> Clear
                </Button>
              )}
            </div>
          </div>
          <pre
            ref={logRef}
            className="mono m-3 mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-[0.7rem] leading-4 text-foreground"
          >
            {log || 'starting…'}
          </pre>
        </Card>
      )}

      {/* Upgradable */}
      {!!overview?.upgradable.length && (
        <Card className="mt-3 overflow-hidden">
          <div className="flex items-center gap-1.5 px-3 pt-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <ArrowUpCircle className="size-3.5 text-warning" /> Upgradable ({overview.upgradable.length})
          </div>
          <div className="p-3 pt-2">
            <DataTable
              data={overview.upgradable}
              columns={upgradableColumns}
              getRowId={(u) => u.name}
              initialSorting={[{ id: 'name', desc: false }]}
            />
          </div>
        </Card>
      )}

      {/* Install new packages */}
      <Card className="mt-3 overflow-hidden">
        <div className="flex items-center gap-1.5 px-3 pt-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <Download className="size-3.5 text-success" /> Install new package
        </div>
        <div className="flex items-center gap-2 px-3 pt-2">
          <div className="relative max-w-sm flex-1">
            <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-7"
              placeholder="Search the package repositories…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void doSearch()}
            />
          </div>
          <Button variant="secondary" size="sm" onClick={() => void doSearch()} disabled={searching}>
            <Search className={cn('size-3', searching && 'animate-pulse')} /> Search
          </Button>
        </div>
        <div className="p-3 pt-2">
          {searchResults == null ? (
            <div className="px-2 py-2 text-xs text-muted-foreground">
              Search the repositories, then install with one click.
            </div>
          ) : (
            <DataTable
              data={searchResults}
              columns={searchColumns}
              getRowId={(r) => r.name}
              emptyText="No packages found."
            />
          )}
        </div>
      </Card>

      {/* Installed */}
      <Card className="mt-3 overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 px-3 pt-3">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <Box className="size-3.5 text-primary" /> Installed
          </div>
          <div className="relative ml-2 w-64">
            <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-7"
              placeholder="Filter installed packages…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <div className="text-xs text-muted-foreground">
            {matchCount} of {overview?.installedCount ?? 0}
          </div>
        </div>
        <div className="p-3 pt-2">
          <DataTable
            data={installedRows}
            columns={installedColumns}
            globalFilter={filter}
            getRowId={(p) => `${p.name}-${p.arch}`}
            initialSorting={[{ id: 'name', desc: false }]}
            pageSize={MAX_INSTALLED_ROWS}
            emptyText={
              loading ? 'Loading…' : overview ? 'No packages match the filter' : 'Not loaded yet'
            }
          />
        </div>
      </Card>

      {/* History */}
      {!!overview?.history.length && (
        <Card className="mt-3 mb-3 overflow-hidden">
          <div className="flex items-center gap-1.5 px-3 pt-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <History className="size-3.5 text-metric-mem" /> Recent operations
          </div>
          <div className="p-3 pt-2">
            <DataTable data={overview.history} columns={historyColumns} />
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={confirm != null}
        onOpenChange={(v) => !v && setConfirm(null)}
        title={confirm?.title ?? ''}
        message={confirm?.message}
        confirmLabel={confirm?.confirmLabel ?? 'Confirm'}
        onConfirm={() => {
          if (confirm) void runAction(confirm.action, confirm.pkg)
        }}
      />
    </div>
  )
}
