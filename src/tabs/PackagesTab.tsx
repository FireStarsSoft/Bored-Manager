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
import type { PackageSearchResult, PackagesOverview, PkgAction, PkgActionState } from '@shared/types'
import { api } from '@/lib/api'
import { useApp } from '@/state/store'
import { StatCard } from '@/components/StatCard'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn, formatBytes } from '@/lib/utils'

const MAX_INSTALLED_ROWS = 500
const MAX_LOG_CHARS = 200_000

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

  const filteredInstalled = React.useMemo(() => {
    const list = overview?.installed ?? []
    const q = filter.trim().toLowerCase()
    if (!q) return list
    return list.filter(
      (p) => p.name.toLowerCase().includes(q) || p.summary.toLowerCase().includes(q)
    )
  }, [overview?.installed, filter])

  const busy = opState.running
  const manager = overview?.manager

  if (overview && manager === 'none') {
    return (
      <div className="h-full overflow-y-auto p-3">
        <h2 className="mb-3 text-base font-semibold">Packages</h2>
        <Card className="p-4 text-sm text-muted">
          No supported package manager (apt, dnf or pacman) was found on the target machine.
        </Card>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto p-3">
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold leading-tight">Packages</h2>
          <div className="text-xs text-muted">
            {overview ? `manager: ${overview.manager}` : loading ? 'loading…' : 'not loaded yet'}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!status.hasSudo && (
            <Badge kind="warn">no sudo - install/remove/upgrade will likely fail</Badge>
          )}
          <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading || busy}>
            <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} /> Reload
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void runAction('update')} disabled={busy}>
            <Download className="h-3 w-3" /> Update lists
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
            <ArrowUpCircle className="h-3 w-3" /> Upgrade all
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
            <Trash2 className="h-3 w-3" /> Autoremove
          </Button>
        </div>
      </div>

      {/* Summary widgets */}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard
          title="Installed"
          icon={Box}
          color="var(--color-accent)"
          value={overview ? String(overview.installedCount) : '…'}
          sub="packages on the system"
        />
        <StatCard
          title="Upgradable"
          icon={ArrowUpCircle}
          color={overview?.upgradableCount ? 'var(--color-warn)' : 'var(--color-good)'}
          value={overview ? String(overview.upgradableCount) : '…'}
          sub={overview?.upgradableCount ? 'updates available' : 'everything up to date'}
        />
        <StatCard
          title="Lists updated"
          icon={Clock}
          color="var(--color-cpu)"
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
          color="var(--color-mem)"
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
            <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
              <RefreshCw className={cn('h-3.5 w-3.5 text-accent', busy && 'animate-spin')} />
              {busy
                ? `Running: ${opState.action}${opState.target ? ` ${opState.target}` : ''}`
                : 'Last operation output'}
            </div>
            <div className="flex gap-1.5">
              {busy && (
                <Button variant="secondary" size="sm" onClick={() => void api.packages.cancel()}>
                  <X className="h-3 w-3" /> Cancel
                </Button>
              )}
              {!busy && log && (
                <Button variant="secondary" size="sm" onClick={() => setLog('')}>
                  <X className="h-3 w-3" /> Clear
                </Button>
              )}
            </div>
          </div>
          <pre
            ref={logRef}
            className="mono m-3 mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md bg-input p-2 text-[0.7rem] leading-4 text-fg"
          >
            {log || 'starting…'}
          </pre>
        </Card>
      )}

      {/* Upgradable */}
      {!!overview?.upgradable.length && (
        <Card className="mt-3 overflow-hidden">
          <div className="flex items-center gap-1.5 px-3 pt-3 text-xs font-semibold uppercase tracking-wider text-muted">
            <ArrowUpCircle className="h-3.5 w-3.5 text-warn" /> Upgradable ({overview.upgradable.length})
          </div>
          <div className="overflow-x-auto p-3 pt-2">
            <table className="w-full text-xs">
              <thead className="text-muted">
                <tr>
                  <th className="px-2 py-1.5 text-left font-medium">Package</th>
                  <th className="px-2 py-1.5 text-left font-medium">Current</th>
                  <th className="px-2 py-1.5 text-left font-medium">New version</th>
                  <th className="px-2 py-1.5 text-left font-medium">Repo</th>
                  <th className="w-24 px-2 py-1.5" />
                </tr>
              </thead>
              <tbody>
                {overview.upgradable.map((u) => (
                  <tr key={u.name} className="group border-t border-border/50 hover:bg-card-hover">
                    <td className="px-2 py-1 font-medium">{u.name}</td>
                    <td className="px-2 py-1 mono text-muted">{u.currentVersion || '—'}</td>
                    <td className="px-2 py-1 mono text-good">{u.newVersion}</td>
                    <td className="max-w-40 truncate px-2 py-1 text-muted">{u.repo || '—'}</td>
                    <td className="px-2 py-0.5 text-right">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        onClick={() => void runAction('upgrade', u.name)}
                      >
                        Upgrade
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Install new packages */}
      <Card className="mt-3 overflow-hidden">
        <div className="flex items-center gap-1.5 px-3 pt-3 text-xs font-semibold uppercase tracking-wider text-muted">
          <Download className="h-3.5 w-3.5 text-good" /> Install new package
        </div>
        <div className="flex items-center gap-2 px-3 pt-2">
          <div className="relative max-w-sm flex-1">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <Input
              className="pl-7"
              placeholder="Search the package repositories…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void doSearch()}
            />
          </div>
          <Button variant="secondary" size="sm" onClick={() => void doSearch()} disabled={searching}>
            <Search className={cn('h-3 w-3', searching && 'animate-pulse')} /> Search
          </Button>
        </div>
        <div className="p-3 pt-2">
          {searchResults == null ? (
            <div className="px-2 py-2 text-xs text-muted">
              Search the repositories, then install with one click.
            </div>
          ) : searchResults.length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted">No packages found.</div>
          ) : (
            <table className="w-full text-xs">
              <tbody>
                {searchResults.map((r) => (
                  <tr key={r.name} className="group border-t border-border/50 hover:bg-card-hover">
                    <td className="w-56 px-2 py-1 font-medium">{r.name}</td>
                    <td className="truncate px-2 py-1 text-muted">{r.summary}</td>
                    <td className="w-24 px-2 py-0.5 text-right">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        onClick={() => void runAction('install', r.name)}
                      >
                        Install
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>

      {/* Installed */}
      <Card className="mt-3 overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 px-3 pt-3">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
            <Box className="h-3.5 w-3.5 text-accent" /> Installed
          </div>
          <div className="relative ml-2 w-64">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <Input
              className="pl-7"
              placeholder="Filter installed packages…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <div className="text-xs text-muted">
            {filteredInstalled.length} of {overview?.installedCount ?? 0}
            {filteredInstalled.length > MAX_INSTALLED_ROWS
              ? ` (showing first ${MAX_INSTALLED_ROWS})`
              : ''}
          </div>
        </div>
        <div className="overflow-x-auto p-3 pt-2">
          <table className="w-full text-xs">
            <thead className="text-muted">
              <tr>
                <th className="w-56 px-2 py-1.5 text-left font-medium">Package</th>
                <th className="w-40 px-2 py-1.5 text-left font-medium">Version</th>
                <th className="w-16 px-2 py-1.5 text-left font-medium">Arch</th>
                <th className="w-20 px-2 py-1.5 text-right font-medium">Size</th>
                <th className="px-2 py-1.5 text-left font-medium">Description</th>
                <th className="w-20 px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {filteredInstalled.slice(0, MAX_INSTALLED_ROWS).map((p) => (
                <tr key={`${p.name}-${p.arch}`} className="group border-t border-border/50 hover:bg-card-hover">
                  <td className="truncate px-2 py-1 font-medium" title={p.name}>
                    {p.name}
                  </td>
                  <td className="truncate px-2 py-1 mono text-muted" title={p.version}>
                    {p.version}
                  </td>
                  <td className="px-2 py-1 text-muted">{p.arch || '—'}</td>
                  <td className="px-2 py-1 text-right text-muted">
                    {p.sizeKb ? formatBytes(p.sizeKb * 1024) : '—'}
                  </td>
                  <td className="truncate px-2 py-1 text-muted" title={p.summary}>
                    {p.summary || '—'}
                  </td>
                  <td className="px-2 py-0.5">
                    <div className="flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        title="Remove (keep config)"
                        className="rounded p-1 text-muted hover:bg-warn/20 hover:text-warn cursor-pointer disabled:opacity-30"
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
                        <X className="h-3 w-3" />
                      </button>
                      <button
                        title="Purge (remove including config)"
                        className="rounded p-1 text-muted hover:bg-bad/20 hover:text-bad cursor-pointer disabled:opacity-30"
                        disabled={busy}
                        onClick={() =>
                          setConfirm({
                            action: 'purge',
                            pkg: p.name,
                            title: 'Purge package',
                            message: (
                              <>
                                Purge <b>{p.name}</b> ({p.version})? The package and its
                                configuration files are removed.
                              </>
                            ),
                            confirmLabel: 'Purge'
                          })
                        }
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {filteredInstalled.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-4 text-center text-muted">
                    {loading ? 'Loading…' : overview ? 'No packages match the filter' : 'Not loaded yet'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* History */}
      {!!overview?.history.length && (
        <Card className="mt-3 mb-3 overflow-hidden">
          <div className="flex items-center gap-1.5 px-3 pt-3 text-xs font-semibold uppercase tracking-wider text-muted">
            <History className="h-3.5 w-3.5 text-mem" /> Recent operations
          </div>
          <div className="overflow-x-auto p-3 pt-2">
            <table className="w-full text-xs">
              <tbody>
                {overview.history.map((h, i) => (
                  <tr key={i} className="border-t border-border/50 hover:bg-card-hover">
                    <td className="w-44 px-2 py-1 mono text-muted">{h.date}</td>
                    <td className="w-32 px-2 py-1">
                      <Badge
                        kind={
                          /remove|purge/i.test(h.action)
                            ? 'bad'
                            : /upgrade/i.test(h.action)
                              ? 'accent'
                              : 'good'
                        }
                      >
                        {h.action}
                      </Badge>
                    </td>
                    <td className="truncate px-2 py-1 text-muted" title={h.packages}>
                      {h.packages}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
