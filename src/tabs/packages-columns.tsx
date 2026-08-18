import * as React from 'react'
import { Trash2, X } from 'lucide-react'
import type {
  PackageHistoryEntry,
  PackageInfo,
  PackageSearchResult,
  PkgAction,
  UpgradablePackage
} from '@shared/types'
import { type DataTableColumns } from '@/components/data-table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatBytes } from '@/lib/utils'

export interface PendingConfirm {
  action: PkgAction
  pkg?: string
  title: string
  message: React.ReactNode
  confirmLabel: string
}

export const historyColumns: DataTableColumns<PackageHistoryEntry> = [
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

export function historyRowId(entry: PackageHistoryEntry, index: number): string {
  return `${entry.date}-${entry.action}-${entry.packages}-${index}`
}

export function upgradableColumns(
  busy: boolean,
  runAction: (action: PkgAction, pkg?: string) => Promise<void>
): DataTableColumns<UpgradablePackage> {
  return [
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
  ]
}

export function searchColumns(
  busy: boolean,
  runAction: (action: PkgAction, pkg?: string) => Promise<void>
): DataTableColumns<PackageSearchResult> {
  return [
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
  ]
}

export function installedColumns(
  busy: boolean,
  setConfirm: (next: PendingConfirm) => void
): DataTableColumns<PackageInfo> {
  return [
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
  ]
}
