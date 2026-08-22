import * as React from 'react'
import { Copy, RefreshCw, Save, Trash2 } from 'lucide-react'
import type { HistoryStats } from '@shared/types'
import { api } from '@/lib/api'
import { useApp } from '@/state/store'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Input } from '@/components/ui/input'
import { SelectField } from '@/components/select-field'
import { Switch } from '@/components/ui/switch'
import { copyText, formatBytes } from '@/lib/utils'
import { timeLabel } from './shared'
import { errorMessage } from '@/lib/utils'
import { useDocumentVisible } from '@/lib/visibility'
import { RETENTION_OPTIONS } from './options'

/**
 * Where the metrics history lives, how big it is and how long it is kept.
 * Samples are batched in RAM and written every few minutes, so this also
 * shows what is still waiting to be flushed.
 */
function DataStorageCard(): React.JSX.Element {
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const showNotice = useApp((s) => s.showNotice)
  const machineCount = useApp((s) => s.machines.length)
  const documentVisible = useDocumentVisible()
  const [stats, setStats] = React.useState<HistoryStats | null>(null)
  const [confirmPurge, setConfirmPurge] = React.useState(false)
  const [capDraft, setCapDraft] = React.useState('')

  const load = React.useCallback(async () => {
    try {
      setStats(await api.history.stats())
    } catch (err) {
      showNotice('error', errorMessage(err))
    }
  }, [showNotice])

  React.useEffect(() => {
    if (!documentVisible) return
    void load()
    const id = setInterval(() => void load(), 15000)
    return () => clearInterval(id)
  }, [load, documentVisible])

  const history = settings?.history
  React.useEffect(() => {
    if (history) setCapDraft(String(history.maxStorageMB))
  }, [history?.maxStorageMB]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!settings || !history) return <></>

  const commitCap = (): void => {
    const mb = Math.min(100_000, Math.max(10, parseInt(capDraft, 10) || history.maxStorageMB))
    setCapDraft(String(mb))
    if (mb !== history.maxStorageMB) {
      void updateSettings({ history: { ...history, maxStorageMB: mb } })
    }
  }

  const copyFolderPath = async (): Promise<void> => {
    const dir = await api.history.folder()
    const copied = await copyText(dir)
    if (copied) showNotice('info', `Path copied: ${dir}`)
    else showNotice('error', `Could not copy the path. It is ${dir}`)
  }

  const rows: Array<[string, React.ReactNode]> = [
    ['Folder', <span className="mono break-all">{stats?.dir ?? '—'}</span>],
    [
      'Writing to',
      <span className="mono break-all">{stats?.dir ?? '—'}</span>
    ],
    ['Connected machines', String(machineCount)],
    [
      'On disk',
      `${formatBytes(stats?.totalBytes ?? 0)} in ${stats?.fileCount ?? 0} file${
        stats?.fileCount === 1 ? '' : 's'
      }`
    ],
    ['Oldest sample', timeLabel(stats?.oldestMs ?? null)],
    ['Newest sample', timeLabel(stats?.newestMs ?? null)],
    [
      'Last write',
      `${timeLabel(stats?.lastFlushMs ?? null)} · ${stats?.pendingPoints ?? 0} samples buffered`
    ]
  ]

  return (
    <Card>
      <CardHeader>
        <CardTitle>Data & storage</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="text-xs text-muted-foreground">
          Charts longer than 10 minutes are served from a metrics log inside the app folder.
          Samples are collected in memory and appended to disk once every{' '}
          {Math.round((stats?.flushIntervalSec ?? 300) / 60)} minutes (and on exit) instead of on
          every tick, which keeps disk wear and I/O negligible.
        </div>

        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm">Keep a metrics history</div>
            <div className="text-xs text-muted-foreground">Turn off to stop writing anything to disk</div>
          </div>
          <Switch
            checked={history.enabled}
            onCheckedChange={(v) => void updateSettings({ history: { ...history, enabled: v } })}
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm">Retention</div>
            <div className="text-xs text-muted-foreground">Older samples are deleted automatically</div>
          </div>
          <SelectField
            value={String(history.retentionHours)}
            onChange={(v) =>
              void updateSettings({ history: { ...history, retentionHours: parseInt(v, 10) } })
            }
            options={RETENTION_OPTIONS}
            className="w-36"
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm">Storage limit</div>
            <div className="text-xs text-muted-foreground">
              The oldest hours are dropped when the log grows past this
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Input
              value={capDraft}
              inputMode="numeric"
              onChange={(e) => setCapDraft(e.target.value)}
              onBlur={commitCap}
              onKeyDown={(e) => e.key === 'Enter' && commitCap()}
              className="w-20 text-right"
            />
            <span className="text-xs text-muted-foreground">MB</span>
          </div>
        </div>

        <div className="rounded-md border border-border bg-muted/50 p-2.5">
          <dl className="flex flex-col gap-1 text-xs">
            {rows.map(([label, value]) => (
              <div key={label} className="flex justify-between gap-3">
                <dt className="shrink-0 text-muted-foreground">{label}</dt>
                <dd className="min-w-0 text-right">{value}</dd>
              </div>
            ))}
          </dl>
          {!!stats?.hosts.length && stats.hosts.length > 1 && (
            <div className="mt-2 border-t border-border pt-2 text-xs text-muted-foreground">
              {stats.hosts.map((h) => (
                <div key={h.hostKey} className="flex justify-between gap-3">
                  <span className="truncate">{h.hostKey}</span>
                  <span>{formatBytes(h.bytes)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => void load()}>
            <RefreshCw className="size-3.5" /> Refresh
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              void api.history
                .flush()
                .then((s) => {
                  setStats(s)
                  showNotice('info', 'Buffered samples written to disk')
                })
                .catch((err) => showNotice('error', errorMessage(err)))
            }}
          >
            <Save className="size-3.5" /> Write now
          </Button>
          {/* The browser cannot open a folder on the host, so the path is
              copied instead - it is the same folder the row above shows. */}
          <Button variant="secondary" onClick={() => void copyFolderPath()}>
            <Copy className="size-3.5" /> Copy path
          </Button>
          <Button variant="destructive" onClick={() => setConfirmPurge(true)}>
            <Trash2 className="size-3.5" /> Clear history
          </Button>
        </div>
      </CardContent>

      <ConfirmDialog
        open={confirmPurge}
        onOpenChange={setConfirmPurge}
        title="Clear metrics history"
        message={`Delete every stored sample (${formatBytes(stats?.totalBytes ?? 0)}) for all machines? Charts longer than 10 minutes will be empty until new data has been collected again.`}
        confirmLabel="Delete"
        onConfirm={() => {
          void api.history
            .purge()
            .then((s) => {
              setStats(s)
              showNotice('info', 'Metrics history cleared')
            })
            .catch((err) => showNotice('error', errorMessage(err)))
        }}
      />
    </Card>
  )
}


export { DataStorageCard }
