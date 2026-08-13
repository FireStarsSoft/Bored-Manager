import * as React from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  CloudDownload,
  Copy,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  Info,
  LayoutGrid,
  Loader2,
  Puzzle,
  RefreshCw,
  Save,
  ShieldCheck,
  Store,
  Trash2,
  Upload,
  UserPlus,
  XCircle
} from 'lucide-react'
import type {
  CollectorSettings,
  Density,
  DetailPollingMode,
  HistoryStats,
  RefreshSpeed,
  SessionIdleUnit,
  UpdateRepoInfo,
  UpdateState,
  UserAccount
} from '@shared/types'
import {
  DEFAULT_USERNAME,
  DEFAULT_UPDATE_REPO,
  HISTORY_RETENTION_OPTIONS,
  HISTORY_WINDOW_OPTIONS,
  SLOW_REFRESH_OPTIONS
} from '@shared/types'
import type {
  ModuleCatalog,
  ModuleCheckLevel,
  ModuleDescriptor,
  ModuleInstallState,
  RegistryEntry,
  ModuleValidation
} from '@shared/modules'
import { compareVersions } from '@shared/modules'
import { api } from '@/lib/api'
import { useApp } from '@/state/store'
import { useModuleSpecs } from '@/lib/module-registry'
import { isWidgetOn, listModuleWidgets } from '@/lib/overview-widgets'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog, Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { copyText, formatBytes } from '@/lib/utils'
import bundledLicenses from '@/generated/licenses.json'

const SPEED_OPTIONS: Array<{ value: RefreshSpeed; label: string }> = [
  { value: 'high', label: 'High (1s)' },
  { value: 'normal', label: 'Normal (2s)' },
  { value: 'low', label: 'Low (5s)' },
  { value: 'paused', label: 'Paused' }
]

const SLOW_OPTIONS = SLOW_REFRESH_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * A Button that opens the browser's file picker. Files now travel from the
 * device the UI runs on to the server, so there is no host file dialog to open
 * any more - only a hidden <input type="file">, which has to stay in the DOM
 * for the click to count as a user gesture.
 */
function FilePickerButton({
  accept,
  label,
  icon,
  disabled,
  onPick
}: {
  accept: string
  label: string
  icon: React.ReactNode
  disabled?: boolean
  onPick: (file: File) => void
}): React.JSX.Element {
  const input = React.useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          // Reset first: picking the same file twice must fire again.
          e.target.value = ''
          if (file) onPick(file)
        }}
      />
      <Button variant="secondary" disabled={disabled} onClick={() => input.current?.click()}>
        {icon} {label}
      </Button>
    </>
  )
}

/**
 * One row per category, split into what has to be sampled often and what
 * only changes on the scale of minutes. Spelling out which metrics belong to
 * which half is the whole point: "Disk" alone would not tell anyone that
 * read/write is measured every second and `df` is not.
 */
const INTERVAL_GROUPS: Array<{
  label: string
  fast?: { key: string; desc: string }
  slow?: { key: string; desc: string }
}> = [
  {
    label: 'System',
    fast: { key: 'system', desc: 'CPU, memory, load average, total network and disk rates' }
  },
  {
    label: 'Sensors',
    fast: { key: 'sensors', desc: 'Temperatures, fans, voltages, power and current' }
  },
  {
    label: 'Processes',
    fast: { key: 'processes', desc: 'Process table and the top consumers on the Overview cards' }
  },
  { label: 'GPU', fast: { key: 'gpu', desc: 'nvidia-smi: utilisation, VRAM, temperature, power' } },
  {
    label: 'Docker',
    fast: { key: 'docker', desc: 'Containers and their CPU/memory stats' },
    slow: { key: 'docker', desc: 'Image, volume and build cache disk usage (docker system df)' }
  },
  {
    label: 'Network',
    fast: { key: 'network', desc: 'Interface rates, connections, per-process bandwidth' },
    slow: { key: 'network', desc: 'Addresses, MTU, link speed, gateway and DNS' }
  },
  {
    label: 'Disk & storage',
    fast: { key: 'disk', desc: 'Throughput, IOPS, utilisation, per-process I/O' },
    slow: { key: 'storage', desc: 'Mount usage and inodes (df), block device list (lsblk)' }
  }
]

const RETENTION_OPTIONS = HISTORY_RETENTION_OPTIONS.map((o) => ({
  value: String(o.value),
  label: o.label
}))

/**
 * Only what the app itself collects. Everything a module collects is switched
 * with the module, in Settings -> Modules.
 */
const COLLECTOR_LIST: Array<{ key: keyof CollectorSettings; label: string; desc: string }> = [
  { key: 'cpu', label: 'CPU', desc: 'Usage, per-core stats and load average' },
  { key: 'memory', label: 'Memory', desc: 'RAM and swap usage' },
  {
    key: 'network',
    label: 'Network rates',
    desc: 'Machine-wide download/upload for the Overview card'
  },
  { key: 'disk', label: 'Disk rates', desc: 'Machine-wide read/write for the Overview card' },
  { key: 'packages', label: 'Packages', desc: 'Package manager tab (loads on demand)' }
]

const DETAIL_OPTIONS: Array<{ value: DetailPollingMode; label: string }> = [
  { value: 'tab', label: 'While tab is open' },
  { value: 'always', label: 'Always (background)' },
  { value: 'off', label: 'Off' }
]

const OVERVIEW_DETAIL_OPTIONS: Array<{ value: DetailPollingMode; label: string }> = [
  { value: 'tab', label: 'While Overview is open' },
  { value: 'always', label: 'Always (background)' },
  { value: 'off', label: 'Off' }
]

const DETAIL_COLLECTORS: Array<{
  key: keyof import('@shared/types').DetailPollingSettings
  label: string
  desc: string
}> = [
  {
    key: 'network',
    label: 'Network detail collector',
    desc: 'Connections, per-process bandwidth'
  },
  { key: 'disk', label: 'Disk detail collector', desc: 'Per-device stats, per-process I/O' },
  {
    key: 'overviewTop',
    label: 'Overview top consumers',
    desc: 'Which processes use the most CPU, memory, disk and network'
  }
]

const DENSITY_OPTIONS: Array<{ value: Density; label: string }> = [
  { value: 'low', label: 'Low - HD screens (larger UI)' },
  { value: 'medium', label: 'Medium - Full HD' },
  { value: 'high', label: 'High - 2K+ (compact UI)' }
]

const WINDOW_OPTIONS = HISTORY_WINDOW_OPTIONS.map((o) => ({
  value: String(o.value),
  label: o.label
}))

/**
 * Overview widgets the app itself provides. The ones modules contribute are
 * listed underneath these, grouped per module (see OverviewCardsCard).
 */
const CORE_WIDGETS: Array<{ id: string; label: string; desc: string; defaultEnabled?: boolean }> = [
  { id: 'appServices', label: 'App services', desc: 'What Bored Manager itself is running, and its cost', defaultEnabled: true },
  { id: 'perCoreCpu', label: 'Per-core CPU', desc: 'Usage bar for every CPU core' },
  { id: 'loadUptime', label: 'Load & uptime', desc: 'Load average 1/5/15 min and uptime' },
  { id: 'topProcesses', label: 'Top processes', desc: 'Five busiest processes by CPU' }
]

export function SettingsTab(): React.JSX.Element {
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const setSettingsFull = useApp((s) => s.setSettingsFull)
  const showNotice = useApp((s) => s.showNotice)

  if (!settings) return <div className="p-4 text-muted">Loading…</div>

  const doExport = (): void => {
    api.settings.export()
    showNotice('info', 'Downloading bored-manager-settings.json')
  }

  const doImport = async (file: File): Promise<void> => {
    try {
      const res = await api.settings.import(file)
      if (res.ok && res.settings) {
        setSettingsFull(res.settings)
        showNotice('info', 'Settings imported')
      } else {
        showNotice('error', res.error || 'Import failed')
      }
    } catch (err) {
      showNotice('error', `Import failed: ${message(err)}`)
    }
  }

  return (
    <div className="h-full overflow-y-auto p-3">
      <h2 className="mb-3 text-base font-semibold">Settings</h2>
      <div className="grid max-w-5xl grid-cols-1 gap-3 xl:grid-cols-2">
        {/* Refresh intervals, per category */}
        <Card>
          <CardHeader>
            <CardTitle>Update intervals</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="text-xs text-muted">
              Within one category, some metrics move every second and others hardly at all. Disk
              throughput is measured on the fast interval while mount usage and the device list run
              on the slow one, so a busy detail page never has to wait for a{' '}
              <span className="mono">df</span> that had nothing new to say. Sections fed by a slow
              interval show their age and a refresh button.
            </div>
            {INTERVAL_GROUPS.map((group) => (
              <div key={group.label} className="border-t border-border pt-3 first:border-0 first:pt-0">
                <div className="mb-1.5 text-sm font-medium">{group.label}</div>
                <div className="space-y-2">
                  {group.fast && (
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-xs">Fast</div>
                        <div className="text-xs text-muted">{group.fast.desc}</div>
                      </div>
                      <SimpleSelect
                        value={settings.refresh[group.fast.key]}
                        onChange={(v) =>
                          void updateSettings({
                            refresh: { ...settings.refresh, [group.fast!.key]: v }
                          })
                        }
                        options={SPEED_OPTIONS}
                        className="w-36 shrink-0"
                      />
                    </div>
                  )}
                  {group.slow && (
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-xs">Slow</div>
                        <div className="text-xs text-muted">{group.slow.desc}</div>
                      </div>
                      <SimpleSelect
                        value={String(settings.slowRefresh[group.slow.key])}
                        onChange={(v) =>
                          void updateSettings({
                            slowRefresh: {
                              ...settings.slowRefresh,
                              [group.slow!.key]: parseInt(v, 10)
                            }
                          })
                        }
                        options={SLOW_OPTIONS}
                        className="w-36 shrink-0"
                      />
                    </div>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Data collection */}
        <Card>
          <CardHeader>
            <CardTitle>Data collection</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5">
            <div className="text-xs text-muted">
              What the app itself reads from the target machine. Disable a collector and it stops
              completely - nothing is polled in the background. Everything a <b>module</b> collects
              (processes, network detail, disk, sensors, GPU, Docker) is switched with the module in{' '}
              <b>Modules</b> below.
            </div>
            {COLLECTOR_LIST.map((c) => (
              <div key={c.key} className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm">{c.label}</div>
                  <div className="text-xs text-muted">{c.desc}</div>
                </div>
                <Switch
                  checked={settings.collectors[c.key]}
                  onCheckedChange={(v) =>
                    void updateSettings({
                      collectors: { ...settings.collectors, [c.key]: v }
                    })
                  }
                />
              </div>
            ))}
            <div className="border-t border-border pt-2.5">
              <div className="mb-2 text-xs text-muted">
                The detail collectors below are the heaviest ones (they enumerate every socket /
                every process). "While tab is open" keeps them free when you are not looking;
                "Always" keeps per-process session totals accurate in the background.
              </div>
              <div className="space-y-2.5">
                {DETAIL_COLLECTORS.map((d) => (
                  <div key={d.key} className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm">{d.label}</div>
                      <div className="text-xs text-muted">{d.desc}</div>
                    </div>
                    <SimpleSelect
                      value={settings.detailPolling[d.key]}
                      onChange={(v) =>
                        void updateSettings({
                          detailPolling: { ...settings.detailPolling, [d.key]: v }
                        })
                      }
                      options={d.key === 'overviewTop' ? OVERVIEW_DETAIL_OPTIONS : DETAIL_OPTIONS}
                      className="w-44"
                    />
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Display */}
        <Card>
          <CardHeader>
            <CardTitle>Display</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm">Display density</div>
                <div className="text-xs text-muted">Match your screen resolution</div>
              </div>
              <SimpleSelect
                value={settings.density}
                onChange={(v) => void updateSettings({ density: v })}
                options={DENSITY_OPTIONS}
                className="w-56"
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm">Default history window</div>
                <div className="text-xs text-muted">Time range shown on Overview charts</div>
              </div>
              <SimpleSelect
                value={String(settings.historyWindow)}
                onChange={(v) =>
                  void updateSettings({ historyWindow: parseInt(v, 10) })
                }
                options={WINDOW_OPTIONS}
                className="w-56"
              />
            </div>
          </CardContent>
        </Card>

        <OverviewCardsCard />

        <ModulesCard />

        <DataStorageCard />

        {/* Import / export */}
        <Card>
          <CardHeader>
            <CardTitle>Backup & portability</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-3 text-xs text-muted">
              All customisations are stored in <span className="mono">data/user-settings/</span>{' '}
              inside the app folder on the server. Export downloads that file to this device, so
              you can move your setup to another machine or import one you saved earlier. Deleting
              the app folder removes the app and all its data completely.
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={doExport}>
                <Download className="h-3.5 w-3.5" /> Export settings
              </Button>
              <FilePickerButton
                accept=".json,application/json"
                label="Import settings"
                icon={<Upload className="h-3.5 w-3.5" />}
                onPick={(file) => void doImport(file)}
              />
            </div>
          </CardContent>
        </Card>

        <ServerUsersCard />

        <SoftwareUpdateCard />

        <AboutCard />
      </div>
    </div>
  )
}

/**
 * Which Overview widgets are shown. The app's own come first, then a block per
 * enabled module - so it is visible at a glance where a card comes from, and a
 * module's cards disappear from the list together with the module.
 */
function OverviewCardsCard(): React.JSX.Element | null {
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const enabledIds = useApp((s) => s.enabledModules)
  const specsList = useModuleSpecs((s) => s.list)
  const moduleWidgets = React.useMemo(
    () => listModuleWidgets(enabledIds, specsList),
    [enabledIds, specsList]
  )
  if (!settings) return null

  const widgets = settings.overviewWidgets
  const toggle = (id: string, on: boolean): void => {
    void updateSettings({ overviewWidgets: { ...widgets, [id]: on } })
  }

  const byModule = new Map<string, typeof moduleWidgets>()
  for (const entry of moduleWidgets) {
    const list = byModule.get(entry.moduleName) ?? []
    list.push(entry)
    byModule.set(entry.moduleName, list)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Overview cards</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2.5">
        <div className="text-xs text-muted">
          CPU, Memory, Network and Disk I/O are always shown. Everything below is optional; every
          card can be dragged into place on the Overview and is as tall as its content needs.
        </div>
        {CORE_WIDGETS.map((c) => (
          <div key={c.id} className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm">{c.label}</div>
              <div className="text-xs text-muted">{c.desc}</div>
            </div>
            <Switch
              checked={isWidgetOn(widgets, c.id, c.defaultEnabled)}
              onCheckedChange={(v) => toggle(c.id, v)}
            />
          </div>
        ))}
        {[...byModule].map(([moduleName, entries]) => (
          <div key={moduleName} className="border-t border-border pt-2.5">
            <div className="mb-1.5 text-[0.65rem] uppercase tracking-wide text-muted">
              {moduleName} module
            </div>
            <div className="space-y-2.5">
              {entries.map((e) => (
                <div key={e.id} className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm">{e.label}</div>
                    <div className="text-xs text-muted mono">{e.id}</div>
                  </div>
                  <Switch
                    checked={isWidgetOn(widgets, e.id, e.defaultEnabled)}
                    onCheckedChange={(v) => toggle(e.id, v)}
                  />
                </div>
              ))}
            </div>
          </div>
        ))}
        <div className="flex items-center justify-between gap-3 border-t border-border pt-2.5">
          <div>
            <div className="text-sm">Card layout</div>
            <div className="text-xs text-muted">
              {Object.keys(settings.overviewLayout).length
                ? 'Your arrangement is saved with the settings'
                : 'Cards are in their default order'}
            </div>
          </div>
          <Button
            variant="secondary"
            disabled={!Object.keys(settings.overviewLayout).length}
            onClick={() => void updateSettings({ overviewLayout: {} })}
          >
            <LayoutGrid className="h-3.5 w-3.5" /> Reset layout
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function timeLabel(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString() : '—'
}

/**
 * Where the metrics history lives, how big it is and how long it is kept.
 * Samples are batched in RAM and written every few minutes, so this also
 * shows what is still waiting to be flushed.
 */
function DataStorageCard(): React.JSX.Element {
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const showNotice = useApp((s) => s.showNotice)
  const connected = useApp((s) => s.status.connected)
  const [stats, setStats] = React.useState<HistoryStats | null>(null)
  const [confirmPurge, setConfirmPurge] = React.useState(false)
  const [capDraft, setCapDraft] = React.useState('')

  const load = React.useCallback(async () => {
    setStats(await api.history.stats())
  }, [])

  React.useEffect(() => {
    void load()
    const id = setInterval(() => void load(), 15000)
    return () => clearInterval(id)
  }, [load])

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
      connected ? (
        <span className="mono break-all">{stats?.currentFile?.split(/[\\/]/).pop() ?? '—'}</span>
      ) : (
        'not connected'
      )
    ],
    ['Machine', stats?.hostKey ?? '—'],
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
      <CardContent className="space-y-3">
        <div className="text-xs text-muted">
          Charts longer than 10 minutes are served from a metrics log inside the app folder.
          Samples are collected in memory and appended to disk once every{' '}
          {Math.round((stats?.flushIntervalSec ?? 300) / 60)} minutes (and on exit) instead of on
          every tick, which keeps disk wear and I/O negligible.
        </div>

        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm">Keep a metrics history</div>
            <div className="text-xs text-muted">Turn off to stop writing anything to disk</div>
          </div>
          <Switch
            checked={history.enabled}
            onCheckedChange={(v) => void updateSettings({ history: { ...history, enabled: v } })}
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm">Retention</div>
            <div className="text-xs text-muted">Older samples are deleted automatically</div>
          </div>
          <SimpleSelect
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
            <div className="text-xs text-muted">
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
            <span className="text-xs text-muted">MB</span>
          </div>
        </div>

        <div className="rounded-md border border-border bg-input/50 p-2.5">
          <dl className="space-y-1 text-xs">
            {rows.map(([label, value]) => (
              <div key={label} className="flex justify-between gap-3">
                <dt className="shrink-0 text-muted">{label}</dt>
                <dd className="min-w-0 text-right">{value}</dd>
              </div>
            ))}
          </dl>
          {!!stats?.hosts.length && stats.hosts.length > 1 && (
            <div className="mt-2 border-t border-border pt-2 text-xs text-muted">
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
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              void api.history.flush().then((s) => {
                setStats(s)
                showNotice('info', 'Buffered samples written to disk')
              })
            }}
          >
            <Save className="h-3.5 w-3.5" /> Write now
          </Button>
          {/* The browser cannot open a folder on the host, so the path is
              copied instead - it is the same folder the row above shows. */}
          <Button variant="secondary" onClick={() => void copyFolderPath()}>
            <Copy className="h-3.5 w-3.5" /> Copy path
          </Button>
          <Button variant="destructive" onClick={() => setConfirmPurge(true)}>
            <Trash2 className="h-3.5 w-3.5" /> Clear history
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
          void api.history.purge().then((s) => {
            setStats(s)
            showNotice('info', 'Metrics history cleared')
          })
        }}
      />
    </Card>
  )
}

const IDLE_UNITS: Array<{ value: SessionIdleUnit; label: string }> = [
  { value: 'minute', label: 'Minutes' },
  { value: 'hour', label: 'Hours' },
  { value: 'day', label: 'Days' }
]

function dateLabel(ms: number | null): string {
  if (!ms) return 'never'
  return new Date(ms).toLocaleString()
}

/**
 * Where the WebUI listens, whether it asks for a login, and who may log in.
 *
 * Everything here is about the server itself rather than the machine it
 * watches, which is why it is one card: turning the login on is only safe once
 * an account has a password, so the two live next to each other.
 */
function ServerUsersCard(): React.JSX.Element {
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const setSettingsFull = useApp((s) => s.setSettingsFull)
  const showNotice = useApp((s) => s.showNotice)
  const auth = useApp((s) => s.auth)

  const [portDraft, setPortDraft] = React.useState('')
  const [hostDraft, setHostDraft] = React.useState('')
  const [restartNeeded, setRestartNeeded] = React.useState(false)
  const [users, setUsers] = React.useState<UserAccount[] | null>(null)
  const [newUser, setNewUser] = React.useState({ username: '', password: '' })
  const [passwordFor, setPasswordFor] = React.useState<string | null>(null)
  const [deleting, setDeleting] = React.useState<string | null>(null)
  /** Set when enabling the login is waiting for the admin password. */
  const [adminPasswordPrompt, setAdminPasswordPrompt] = React.useState(false)

  const server = settings?.server
  React.useEffect(() => {
    if (!server) return
    setPortDraft(String(server.port))
    setHostDraft(server.host)
  }, [server?.port, server?.host]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadUsers = React.useCallback(async () => {
    try {
      setUsers(await api.auth.users())
    } catch (err) {
      showNotice('error', `Could not read the accounts: ${message(err)}`)
    }
  }, [showNotice])

  React.useEffect(() => {
    void loadUsers()
  }, [loadUsers])

  if (!settings || !server) return <></>

  const listening = settings.auth
  const idle = listening.sessionIdle

  const saveServer = async (): Promise<void> => {
    const port = parseInt(portDraft, 10)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      showNotice('error', 'The port has to be a number between 1 and 65535')
      setPortDraft(String(server.port))
      return
    }
    const saved = await updateSettings({ server: { port, host: hostDraft.trim() } })
    setPortDraft(String(saved.server.port))
    setHostDraft(saved.server.host)
    if (saved.restartRequired) {
      setRestartNeeded(true)
      showNotice('info', 'Restart the server for the new address to take effect')
    } else {
      showNotice('info', 'Saved')
    }
  }

  const setLoginRequired = async (enabled: boolean): Promise<void> => {
    try {
      const saved = await api.auth.setEnabled(enabled)
      setSettingsFull(saved)
      if (enabled) showNotice('info', 'A login is now required')
    } catch (err) {
      // The server refuses to lock everyone out of an account with no password.
      if (message(err).includes('set-admin-password-first')) {
        setAdminPasswordPrompt(true)
        return
      }
      showNotice('error', message(err))
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Server & users</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-xs text-muted">
          These settings are about the WebUI itself - where it listens and who may open it - not
          about the machine being monitored.
        </div>

        <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
          <label className="text-xs text-muted">
            Port
            <Input
              value={portDraft}
              inputMode="numeric"
              onChange={(e) => setPortDraft(e.target.value)}
              className="mt-1"
            />
          </label>
          <label className="text-xs text-muted">
            Bind address
            <Input
              value={hostDraft}
              onChange={(e) => setHostDraft(e.target.value)}
              className="mt-1"
            />
          </label>
          <Button
            onClick={() => void saveServer()}
            disabled={portDraft === String(server.port) && hostDraft === server.host}
          >
            <Save className="h-3.5 w-3.5" /> Save
          </Button>
        </div>
        <div className="text-xs text-muted">
          <span className="mono">0.0.0.0</span> answers on every network interface;{' '}
          <span className="mono">127.0.0.1</span> only on the machine itself.
        </div>

        {restartNeeded && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-warn/40 bg-warn/10 px-2.5 py-2 text-xs text-warn">
            <span className="min-w-0 flex-1">
              The address is only read when the server starts, so it is still on{' '}
              <span className="mono">{location.host}</span>.
            </span>
            <Button
              variant="secondary"
              onClick={() => {
                void api.app.restart()
                showNotice('info', 'Restarting - reopen the WebUI on the new address')
                setRestartNeeded(false)
              }}
            >
              <RefreshCw className="h-3.5 w-3.5" /> Restart server
            </Button>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
          <div>
            <div className="text-sm">Require login</div>
            <div className="text-xs text-muted">
              Off means anyone who can reach this address has full access
            </div>
          </div>
          <Switch
            checked={listening.enabled}
            onCheckedChange={(v) => void setLoginRequired(v)}
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm">Wrong passwords before locking</div>
            <div className="text-xs text-muted">
              Counted across all clients; unlock with{' '}
              <span className="mono">./bored-manager unlock</span> on the host
            </div>
          </div>
          <Input
            value={String(listening.maxFailures)}
            inputMode="numeric"
            className="w-20 shrink-0 text-right"
            onChange={(e) => {
              const value = Math.max(1, parseInt(e.target.value, 10) || 1)
              void updateSettings({ auth: { maxFailures: value } })
            }}
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm">Sign out when idle</div>
            <div className="text-xs text-muted">0 = the session never expires</div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Input
              value={String(idle.value)}
              inputMode="numeric"
              className="w-16 text-right"
              onChange={(e) => {
                const value = Math.max(0, parseInt(e.target.value, 10) || 0)
                void updateSettings({ auth: { sessionIdle: { ...idle, value } } })
              }}
            />
            <SimpleSelect
              value={idle.unit}
              onChange={(v) => void updateSettings({ auth: { sessionIdle: { ...idle, unit: v as SessionIdleUnit } } })}
              options={IDLE_UNITS}
              className="w-28"
            />
          </div>
        </div>

        {/* Accounts */}
        <div className="border-t border-border pt-3">
          <div className="mb-1.5 text-sm font-medium">Accounts</div>
          <div className="mb-2 text-xs text-muted">
            Accounts of the WebUI, not of the host. Each one has its own saved connections;
            deleting an account deletes those with it. Everyone who can sign in can manage
            accounts.
          </div>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="bg-input/50 text-muted">
                <tr>
                  <th className="px-2.5 py-1.5 text-left font-medium">User</th>
                  <th className="px-2.5 py-1.5 text-left font-medium">Created</th>
                  <th className="px-2.5 py-1.5 text-left font-medium">Last sign-in</th>
                  <th className="px-2.5 py-1.5" />
                </tr>
              </thead>
              <tbody>
                {(users ?? []).map((user) => (
                  <tr key={user.username} className="border-t border-border">
                    <td className="px-2.5 py-1.5">
                      <span className="mono">{user.username}</span>
                      {user.username === auth?.username && (
                        <span className="ml-1.5 text-muted">(you)</span>
                      )}
                      {!user.hasPassword && (
                        <span className="ml-1.5 text-warn">no password yet</span>
                      )}
                    </td>
                    <td className="px-2.5 py-1.5 text-muted">{dateLabel(user.createdAt)}</td>
                    <td className="px-2.5 py-1.5 text-muted">{dateLabel(user.lastLoginAt)}</td>
                    <td className="px-2.5 py-1.5">
                      <div className="flex justify-end gap-1.5">
                        <Button
                          variant="secondary"
                          onClick={() => setPasswordFor(user.username)}
                        >
                          Change password
                        </Button>
                        <Button
                          variant="destructive"
                          disabled={user.username === DEFAULT_USERNAME}
                          title={
                            user.username === DEFAULT_USERNAME
                              ? 'The default account cannot be deleted'
                              : undefined
                          }
                          onClick={() => setDeleting(user.username)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
                {users?.length === 0 && (
                  <tr>
                    <td className="px-2.5 py-2 text-muted" colSpan={4}>
                      No accounts yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="mt-2 grid grid-cols-[1fr_1fr_auto] gap-2">
            <Input
              placeholder="New username"
              autoComplete="off"
              value={newUser.username}
              onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
            />
            <Input
              type="password"
              placeholder="Password"
              autoComplete="new-password"
              value={newUser.password}
              onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
            />
            <Button
              disabled={!newUser.username.trim() || !newUser.password}
              onClick={() => {
                void api.auth
                  .createUser(newUser.username.trim(), newUser.password)
                  .then((list) => {
                    setUsers(list)
                    setNewUser({ username: '', password: '' })
                    showNotice('info', 'Account created')
                  })
                  .catch((err: unknown) => showNotice('error', message(err)))
              }}
            >
              <UserPlus className="h-3.5 w-3.5" /> Add
            </Button>
          </div>
        </div>
      </CardContent>

      <PasswordDialog
        open={adminPasswordPrompt}
        title={`Set a password for ${DEFAULT_USERNAME}`}
        hint={`A login can only be required once ${DEFAULT_USERNAME} has a password - otherwise nobody could sign in.`}
        onOpenChange={setAdminPasswordPrompt}
        onSubmit={async (password) => {
          setUsers(await api.auth.setPassword(DEFAULT_USERNAME, password))
          await setLoginRequired(true)
        }}
      />

      <PasswordDialog
        open={passwordFor !== null}
        title={`Change the password of ${passwordFor ?? ''}`}
        onOpenChange={(open) => !open && setPasswordFor(null)}
        onSubmit={async (password) => {
          if (!passwordFor) return
          setUsers(await api.auth.setPassword(passwordFor, password))
          setPasswordFor(null)
          showNotice('info', 'Password changed')
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete account"
        message={
          <>
            Delete <span className="mono">{deleting}</span> and everything it saved, including its
            connections? Anyone signed in as that account is signed out immediately.
          </>
        }
        confirmLabel="Delete"
        onConfirm={() => {
          const username = deleting
          setDeleting(null)
          if (!username) return
          void api.auth
            .deleteUser(username)
            .then((list) => {
              setUsers(list)
              showNotice('info', `${username} deleted`)
            })
            .catch((err: unknown) => showNotice('error', message(err)))
        }}
      />
    </Card>
  )
}

/** Two fields, so a password cannot be set to something mistyped. */
function PasswordDialog({
  open,
  title,
  hint,
  onOpenChange,
  onSubmit
}: {
  open: boolean
  title: string
  hint?: string
  onOpenChange: (open: boolean) => void
  onSubmit: (password: string) => Promise<void>
}): React.JSX.Element {
  const showNotice = useApp((s) => s.showNotice)
  const [first, setFirst] = React.useState('')
  const [second, setSecond] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (open) {
      setFirst('')
      setSecond('')
    }
  }, [open])

  const submit = async (): Promise<void> => {
    if (first !== second) return
    setBusy(true)
    try {
      await onSubmit(first)
      onOpenChange(false)
    } catch (err) {
      showNotice('error', message(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title}>
      {hint && <div className="mb-3 text-xs text-muted">{hint}</div>}
      <div className="space-y-2">
        <Input
          type="password"
          placeholder="New password"
          autoComplete="new-password"
          value={first}
          onChange={(e) => setFirst(e.target.value)}
        />
        <Input
          type="password"
          placeholder="Repeat the password"
          autoComplete="new-password"
          value={second}
          onChange={(e) => setSecond(e.target.value)}
        />
        {second && first !== second && (
          <div className="text-xs text-bad">The two passwords are not the same</div>
        )}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button disabled={busy || !first || first !== second} onClick={() => void submit()}>
          Save
        </Button>
      </div>
    </Dialog>
  )
}

function progressLabel(state: UpdateState): string {
  if (state.phase === 'extracting') return 'Unpacking the archive...'
  if (state.phase === 'validating') return 'Checking what the archive contains...'
  if (state.phase === 'applying') return 'Handing over to the update script - the app closes now...'
  const p = state.progress
  if (!p) return 'Contacting the server...'
  if (!p.totalBytes) return `Downloading... ${formatBytes(p.receivedBytes)}`
  const pct = Math.min(100, Math.round((p.receivedBytes / p.totalBytes) * 100))
  return `Downloading... ${pct}% (${formatBytes(p.receivedBytes)} of ${formatBytes(p.totalBytes)})`
}

/**
 * Install a new version from GitHub, a zip URL, or a file. The app only
 * downloads and inspects it; replacing the folder is done by scripts/update.sh
 * after the server has quit.
 */
function SoftwareUpdateCard(): React.JSX.Element {
  const showNotice = useApp((s) => s.showNotice)
  const savedUrl = useApp((s) => s.settings?.update.lastUrl ?? '')
  const savedRepo = useApp((s) => s.settings?.update.repo ?? DEFAULT_UPDATE_REPO)
  const updateSettings = useApp((s) => s.updateSettings)
  const [state, setState] = React.useState<UpdateState | null>(null)
  const [url, setUrl] = React.useState(savedUrl)
  const [repo, setRepo] = React.useState(savedRepo)
  const [repoInfo, setRepoInfo] = React.useState<UpdateRepoInfo | null>(null)
  const [checkingRepo, setCheckingRepo] = React.useState(false)
  const [confirmInstall, setConfirmInstall] = React.useState(false)

  React.useEffect(() => {
    const off = api.update.onState(setState)
    void api.update.state().then((s) => setState((cur) => cur ?? s))
    return off
  }, [])

  React.useEffect(() => {
    setUrl((cur) => cur || savedUrl)
  }, [savedUrl])

  React.useEffect(() => {
    setRepo((cur) => cur || savedRepo)
  }, [savedRepo])

  const stateUrl = state?.url
  React.useEffect(() => {
    if (stateUrl && stateUrl !== 'upload') setUrl(stateUrl)
  }, [stateUrl])

  if (!state) return <></>

  const busy =
    state.phase === 'downloading' || state.phase === 'extracting' || state.phase === 'validating'
  const applying = state.phase === 'applying'
  const validation = state.validation
  const ready = state.phase === 'ready'
  const locked = busy || applying

  const persistRepo = async (value: string): Promise<string> => {
    const next = value.trim() || DEFAULT_UPDATE_REPO
    setRepo(next)
    if (next !== savedRepo) await updateSettings({ update: { repo: next } })
    return next
  }

  const doCheckRepo = async (): Promise<void> => {
    setCheckingRepo(true)
    try {
      await persistRepo(repo)
      const info = await api.update.checkRepo()
      setRepoInfo(info)
    } catch (err) {
      setRepoInfo(null)
      showNotice('error', err instanceof Error ? err.message : String(err))
    } finally {
      setCheckingRepo(false)
    }
  }

  const doCheck = async (link: string): Promise<void> => {
    const trimmed = link.trim()
    setUrl(trimmed)
    if (trimmed && trimmed !== savedUrl && trimmed !== 'upload') {
      void updateSettings({ update: { lastUrl: trimmed } })
    }
    const next = await api.update.check(trimmed)
    setState(next)
    if (next.phase === 'ready') showNotice('info', 'The archive passed every check')
    else if (next.error) showNotice('error', next.error)
  }

  const doCheckFile = async (file: File): Promise<void> => {
    try {
      const next = await api.update.checkFile(file)
      setState(next)
      if (next.phase === 'ready') showNotice('info', 'The archive passed every check')
      else if (next.error) showNotice('error', next.error)
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : String(err))
    }
  }

  const doCancel = async (): Promise<void> => {
    setState(await api.update.cancel())
    setUrl(savedUrl)
  }

  const doApply = async (): Promise<void> => {
    const res = await api.update.apply()
    if (!res.ok) showNotice('error', res.error || 'Could not start the update')
  }

  const repoZip = repoInfo?.assetUrl || repoInfo?.fallbackUrl
  const latestLabel = repoInfo
    ? repoInfo.latestVersion
      ? `Latest: v${repoInfo.latestVersion}`
      : 'No release yet — you can install from the main branch'
    : null
  const alreadyCurrent =
    !!repoInfo?.latestVersion && compareVersions(repoInfo.latestVersion, state.currentVersion) <= 0

  return (
    <Card>
      <CardHeader>
        <CardTitle>Software update</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">Installed version</span>
          <span className="mono text-sm">{state.currentVersion}</span>
        </div>

        <div className="flex flex-col gap-2">
          <div className="text-xs text-muted">
            GitHub repository releases are checked from. The server restarts itself after a
            confirmed install.
          </div>
          <div className="flex gap-2">
            <Input
              value={repo}
              placeholder={DEFAULT_UPDATE_REPO}
              spellCheck={false}
              disabled={locked || checkingRepo}
              onChange={(e) => setRepo(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !locked && !checkingRepo && void doCheckRepo()}
              className="min-w-0 flex-1"
            />
            <Button disabled={locked || checkingRepo} onClick={() => void doCheckRepo()}>
              {checkingRepo ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Check for updates
            </Button>
          </div>
          {latestLabel && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className={alreadyCurrent ? 'text-muted' : 'text-fg'}>{latestLabel}</span>
              {repoZip && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={locked}
                  onClick={() => void doCheck(repoZip)}
                >
                  <CloudDownload className="h-3.5 w-3.5" />
                  Download & test
                </Button>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <div className="text-xs text-muted">
            Or paste a release <span className="mono">.zip</span> URL, or pick a file.
          </div>
          <div className="flex flex-wrap gap-2">
            <Input
              value={url}
              placeholder="https://github.com/owner/repo/releases/download/v0.1.0/bored-manager-0.1.0.zip"
              spellCheck={false}
              disabled={locked}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !locked && void doCheck(url)}
              className="min-w-0 flex-1"
            />
            <Button disabled={locked || !url.trim()} onClick={() => void doCheck(url)}>
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <CloudDownload className="h-3.5 w-3.5" />
              )}
              Download & test
            </Button>
            <FilePickerButton
              accept=".zip"
              label="From file"
              icon={<Upload className="h-3.5 w-3.5" />}
              disabled={locked}
              onPick={(file) => void doCheckFile(file)}
            />
          </div>
        </div>

        {(busy || applying) && (
          <div className="rounded-md border border-border bg-input/50 p-2.5 text-xs">
            {progressLabel(state)}
          </div>
        )}

        {!busy && !applying && state.phase === 'error' && !validation && (
          <div className="flex items-start gap-2 rounded-md border border-bad/30 bg-bad/10 p-2.5 text-xs">
            <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-bad" />
            <span className="min-w-0 break-words">{state.error}</span>
          </div>
        )}

        {validation && !busy && (
          <div className="rounded-md border border-border bg-input/50 p-2.5">
            <div className="mb-2 flex items-center gap-2 border-b border-border pb-2">
              {validation.status === 'pass' ? (
                <>
                  <CheckCircle2 className="h-4 w-4 text-good" />
                  <span className="text-sm text-good">PASS</span>
                </>
              ) : (
                <>
                  <XCircle className="h-4 w-4 text-bad" />
                  <span className="text-sm text-bad">ERROR</span>
                </>
              )}
              <span className="ml-auto mono text-xs text-muted">
                {validation.currentVersion} {'->'} {validation.newVersion ?? '?'}
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              {validation.checks.map((c) => (
                <div key={c.id} className="flex items-start gap-2">
                  {c.ok ? (
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-good" />
                  ) : (
                    <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-bad" />
                  )}
                  <div className="min-w-0">
                    <div className="text-xs">{c.label}</div>
                    {c.detail && (
                      <div className="break-words text-xs text-muted">{c.detail}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {!!validation.warnings.length && (
              <div className="mt-2 flex flex-col gap-1.5 border-t border-border pt-2">
                {validation.warnings.map((w) => (
                  <div key={w} className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
                    <span className="min-w-0 break-words text-xs text-muted">{w}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {ready && (
          <div className="rounded-md border border-warn/30 bg-warn/10 p-2.5 text-xs">
            <div className="mb-1 flex items-center gap-2 text-warn">
              <AlertTriangle className="h-3.5 w-3.5" /> The server will restart itself
            </div>
            <ul className="ml-4 list-disc space-y-1 text-muted">
              <li>The server quits and an update script takes over.</li>
              <li>
                The current folder is replaced by version {validation?.newVersion}; your{' '}
                <span className="text-fg">accounts, saved SSH connections and these settings are
                carried over</span>
                .
              </li>
              <li>
                The metrics history and all logs are <span className="text-fg">deleted</span>.
              </li>
              <li>Dependencies are reinstalled, the app is rebuilt, then the service starts again.</li>
            </ul>
          </div>
        )}

        {(ready || validation || state.phase === 'error') && !busy && (
          <div className="flex flex-wrap gap-2">
            {ready && (
              <Button
                variant="destructive"
                disabled={applying}
                onClick={() => setConfirmInstall(true)}
              >
                <Download className="h-3.5 w-3.5" /> Confirm & install
              </Button>
            )}
            <Button variant="secondary" disabled={applying} onClick={() => void doCancel()}>
              <Trash2 className="h-3.5 w-3.5" />
              {validation ? 'Discard download' : 'Clear'}
            </Button>
          </div>
        )}
      </CardContent>

      <ConfirmDialog
        open={confirmInstall}
        onOpenChange={setConfirmInstall}
        title="Install update"
        message={`Bored Manager ${state.currentVersion} will be replaced by ${
          validation?.newVersion ?? 'the downloaded version'
        }. The server restarts itself; your accounts, saved SSH connections and settings are kept, the metrics history is not.`}
        confirmLabel="Restart & update"
        onConfirm={() => void doApply()}
      />
    </Card>
  )
}

// ---------- Modules ----------

const CHECK_ICON: Record<ModuleCheckLevel, React.ReactNode> = {
  pass: <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-good" />,
  info: <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />,
  warning: <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />,
  error: <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-bad" />
}

function moduleProgressLabel(state: ModuleInstallState): string {
  if (state.phase === 'extracting') return 'Unpacking the archive...'
  if (state.phase === 'validating') return 'Checking the module against the rules...'
  if (state.phase === 'installing') return 'Writing the module into modules/...'
  if (state.phase === 'building') return 'Compiling the module...'
  const p = state.progress
  if (!p) return 'Contacting the server...'
  if (!p.totalBytes) return `Downloading... ${formatBytes(p.receivedBytes)}`
  const pct = Math.min(100, Math.round((p.receivedBytes / p.totalBytes) * 100))
  return `Downloading... ${pct}% (${formatBytes(p.receivedBytes)} of ${formatBytes(p.totalBytes)})`
}

/** The verdict on an inspected archive: one row per rule that was checked. */
function ModuleChecks({ validation }: { validation: ModuleValidation }): React.JSX.Element {
  const label =
    validation.status === 'pass' ? 'PASS' : validation.status === 'warning' ? 'WARNING' : 'ERROR'
  const tone =
    validation.status === 'pass' ? 'text-good' : validation.status === 'warning' ? 'text-warn' : 'text-bad'
  return (
    <div className="rounded-md border border-border bg-input/50 p-2.5">
      <div className="mb-2 flex items-center gap-2 border-b border-border pb-2">
        {CHECK_ICON[validation.status === 'pass' ? 'pass' : validation.status]}
        <span className={`text-sm ${tone}`}>{label}</span>
        <span className="ml-auto min-w-0 truncate mono text-xs text-muted">
          {validation.moduleName ?? '?'}{' '}
          {validation.installedVersion
            ? `${validation.installedVersion} -> ${validation.newVersion ?? '?'}`
            : (validation.newVersion ?? '')}
        </span>
      </div>
      <div className="space-y-1.5">
        {validation.checks.map((c) => (
          <div key={c.id} className="flex items-start gap-2">
            {CHECK_ICON[c.level]}
            <div className="min-w-0">
              <div className="text-xs">{c.label}</div>
              {c.detail && <div className="break-words text-xs text-muted">{c.detail}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** README / CHANGELOG of an installed module, as plain text. */
function ModuleDetailsDialog({
  module,
  onClose
}: {
  module: ModuleDescriptor | null
  onClose: () => void
}): React.JSX.Element {
  const [tab, setTab] = React.useState<'readme' | 'changelog'>('readme')
  const text = (tab === 'readme' ? module?.readme : module?.changelog) ?? ''
  return (
    <Dialog
      open={module != null}
      onOpenChange={(v) => !v && onClose()}
      title={module ? `${module.manifest.name} ${module.state.version}` : ''}
      wide
    >
      {module && (
        <div className="space-y-2">
          <div className="text-xs text-muted">{module.manifest.description}</div>
          <div className="flex gap-1.5">
            {(['readme', 'changelog'] as const).map((t) => (
              <Button
                key={t}
                size="sm"
                variant={tab === t ? 'default' : 'secondary'}
                onClick={() => setTab(t)}
              >
                {t === 'readme' ? 'README' : 'CHANGELOG'}
              </Button>
            ))}
          </div>
          <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md bg-input p-2.5 text-[0.7rem] leading-relaxed">
            {text || `This module ships no ${tab === 'readme' ? 'README.md' : 'CHANGELOG.md'}.`}
          </pre>
        </div>
      )}
    </Dialog>
  )
}

/**
 * One community module in the catalog: what it is, and whether it needs
 * installing, updating, or nothing at all. `onInstall` just starts the same
 * check/validate flow the manual URL box uses - the catalog is a shortcut to
 * a download link, not a separate install path.
 */
function CatalogEntryRow({
  entry,
  installedVersion,
  appVersion,
  busy,
  onInstall
}: {
  entry: RegistryEntry
  installedVersion: string | null
  appVersion: string | null
  busy: boolean
  onInstall: (url: string) => void
}): React.JSX.Element {
  const needsNewerApp =
    !!entry.minAppVersion && !!appVersion && compareVersions(appVersion, entry.minAppVersion) < 0
  const action: 'install' | 'update' | null =
    installedVersion == null
      ? 'install'
      : compareVersions(entry.version, installedVersion) > 0
        ? 'update'
        : null

  return (
    <div className="p-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium">{entry.name}</span>
        <span className="mono text-xs text-muted">{entry.version}</span>
        {entry.author && <span className="text-xs text-muted">by {entry.author}</span>}
        <div className="flex-1" />
        {action ? (
          <Button size="sm" disabled={busy || needsNewerApp} onClick={() => onInstall(entry.download)}>
            <Download className="h-3 w-3" /> {action === 'update' ? 'Update' : 'Install'}
          </Button>
        ) : (
          <Badge kind="good">Installed</Badge>
        )}
      </div>
      {entry.description && <div className="mt-0.5 text-xs text-muted">{entry.description}</div>}
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {entry.homepage && (
          <a
            href={entry.homepage}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-accent hover:underline"
          >
            <ExternalLink className="h-3 w-3" /> Homepage
          </a>
        )}
        {needsNewerApp && (
          <span className="text-warn">
            Needs Bored Manager {entry.minAppVersion}+ (this is {appVersion})
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * Managing what is installed. A module is a folder the host compiles at
 * runtime (see modules-host.ts), so installing, updating, removing and
 * reloading one all take effect immediately - none of them rebuild or
 * restart the app.
 */
function ModulesCard(): React.JSX.Element {
  const modules = useApp((s) => s.modules)
  const setModules = useApp((s) => s.setModules)
  const showNotice = useApp((s) => s.showNotice)
  const [state, setState] = React.useState<ModuleInstallState | null>(null)
  const [url, setUrl] = React.useState('')
  const [details, setDetails] = React.useState<ModuleDescriptor | null>(null)
  const [confirmInstall, setConfirmInstall] = React.useState(false)
  const [confirmUnverified, setConfirmUnverified] = React.useState(false)
  const [confirmRemove, setConfirmRemove] = React.useState<ModuleDescriptor | null>(null)
  const [reloadingId, setReloadingId] = React.useState<string | null>(null)
  const [catalog, setCatalog] = React.useState<ModuleCatalog | null>(null)
  const [catalogBusy, setCatalogBusy] = React.useState(false)
  const [appVersion, setAppVersion] = React.useState<string | null>(null)

  React.useEffect(() => {
    // Subscribe first: an install started before this tab was opened keeps
    // running in the main process and its state is the authoritative one.
    const off = api.modules.onInstallState(setState)
    void api.modules.installState().then((s) => setState((cur) => cur ?? s))
    return off
  }, [])

  React.useEffect(() => {
    void api.modules.catalog().then(setCatalog)
    void api.app.info().then((info) => setAppVersion(info.version))
  }, [])

  const busy = ['downloading', 'extracting', 'validating', 'installing', 'building'].includes(
    state?.phase ?? 'idle'
  )
  const validation = state?.validation
  const ready = state?.phase === 'ready'
  const needsConfirm = validation?.status === 'warning'
  const hasUnverifiedSource = validation?.checks.some((c) => c.id === 'unverified-source') ?? false

  const doCheckUrl = async (target?: string): Promise<void> => {
    const next = await api.modules.checkUrl(target ?? url.trim())
    setState(next)
    if (next.error) showNotice('error', next.error)
  }

  const doCatalogRefresh = async (): Promise<void> => {
    setCatalogBusy(true)
    try {
      setCatalog(await api.modules.catalogRefresh())
    } catch (err) {
      showNotice('error', `Could not refresh the catalog: ${message(err)}`)
    } finally {
      setCatalogBusy(false)
    }
  }

  const doCheckFile = async (file: File): Promise<void> => {
    try {
      const next = await api.modules.checkFile(file)
      setState(next)
      if (next.error) showNotice('error', next.error)
    } catch (err) {
      showNotice('error', `Upload failed: ${message(err)}`)
    }
  }

  const doInstall = async (): Promise<void> => {
    const next = await api.modules.install()
    setState(next)
    if (next.error) showNotice('error', next.error)
  }

  const doUninstall = async (id: string): Promise<void> => {
    const next = await api.modules.uninstall(id)
    setState(next)
    if (next.error) showNotice('error', next.error)
  }

  /** Recompiles a module from its files on disk and brings it back to life - no restart. */
  const doReload = async (m: ModuleDescriptor): Promise<void> => {
    setReloadingId(m.manifest.id)
    try {
      const res = await api.modules.reload(m.manifest.id)
      showNotice(
        res.ok ? 'info' : 'error',
        res.ok ? `${m.manifest.name} reloaded` : `${m.manifest.name}: ${res.error}`
      )
    } catch (err) {
      showNotice('error', message(err))
    } finally {
      setReloadingId(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <Puzzle className="h-3.5 w-3.5 text-accent" /> Modules
        </CardTitle>
        <span className="text-xs text-muted">{modules.length} installed</span>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-xs text-muted">
          Every feature except the Overview, Packages, Terminals and these Settings is a module.
          Switching one off stops its collectors and hides its page and cards immediately.
          Installing, updating, removing and reloading a module take effect immediately too - none
          of them rebuild or restart the app. See <span className="mono">docs/MODULE-RULESET.md</span>{' '}
          to write your own.
        </div>

        {/* Installed modules */}
        <div className="divide-y divide-border rounded-md border border-border">
          {modules.map((m) => (
            <div key={m.manifest.id} className="p-2.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-medium">{m.manifest.name}</span>
                <span className="mono text-xs text-muted">{m.state.version}</span>
                <Badge kind={m.state.source === 'default' ? 'default' : 'accent'}>
                  {m.state.source === 'default' ? 'built in' : 'installed'}
                </Badge>
                {m.problem ? (
                  <Badge kind="bad">cannot run</Badge>
                ) : m.integrity === 'modified' ? (
                  <Badge kind="warn">files modified</Badge>
                ) : null}
                <div className="flex-1" />
                <Switch
                  checked={m.state.enabled && !m.problem}
                  disabled={busy || !!m.problem}
                  onCheckedChange={(v) => {
                    void api.modules.setEnabled(m.manifest.id, v).then(setModules)
                  }}
                />
              </div>
              <div className="mt-0.5 text-xs text-muted">{m.manifest.description}</div>
              {m.problem && (
                <div className="mt-1 break-words text-xs text-bad">{m.problem}</div>
              )}
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <Button size="sm" variant="secondary" onClick={() => setDetails(m)}>
                  <FileText className="h-3 w-3" /> Details
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy || reloadingId === m.manifest.id}
                  onClick={() => void doReload(m)}
                >
                  {reloadingId === m.manifest.id ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3 w-3" />
                  )}
                  Reload
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    void api.modules.verify(m.manifest.id).then((list) => {
                      setModules(list)
                      const now = list.find((x) => x.manifest.id === m.manifest.id)
                      showNotice(
                        now?.integrity === 'ok' ? 'info' : 'error',
                        now?.integrity === 'ok'
                          ? `${m.manifest.name}: files match the installed version`
                          : `${m.manifest.name}: files differ from the installed version`
                      )
                    })
                  }}
                >
                  <ShieldCheck className="h-3 w-3" /> Verify
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => setConfirmRemove(m)}
                >
                  <Trash2 className="h-3 w-3" /> Uninstall
                </Button>
              </div>
            </div>
          ))}
          {modules.length === 0 && (
            <div className="p-2.5 text-xs text-muted">
              No modules are installed - only the Overview, Packages, Terminals and Settings pages
              are available.
            </div>
          )}
        </div>

        {/* Catalog */}
        <div className="border-t border-border pt-3">
          <div className="mb-2 flex items-center gap-2">
            <Store className="h-3.5 w-3.5 text-accent" />
            <span className="text-sm font-medium">Catalog</span>
            <span className="text-xs text-muted">
              {timeLabel(catalog?.fetchedAt ?? null)}
              {catalog?.stale && (
                <Badge kind="warn" className="ml-1.5">
                  stale
                </Badge>
              )}
            </span>
            <div className="flex-1" />
            <Button size="sm" variant="secondary" disabled={catalogBusy} onClick={() => void doCatalogRefresh()}>
              {catalogBusy ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              Refresh
            </Button>
          </div>
          <div className="mb-2 text-xs text-muted">
            Community modules reviewed and vouched for. Installing one still runs through the same
            checks below.
          </div>
          <div className="divide-y divide-border rounded-md border border-border">
            {(catalog?.entries ?? []).map((entry) => (
              <CatalogEntryRow
                key={entry.id}
                entry={entry}
                installedVersion={
                  modules.find((m) => m.manifest.id === entry.id)?.state.version ?? null
                }
                appVersion={appVersion}
                busy={busy}
                onInstall={(target) => void doCheckUrl(target)}
              />
            ))}
            {catalog != null && catalog.entries.length === 0 && (
              <div className="p-2.5 text-xs text-muted">
                The catalog is empty right now - nothing has been reviewed yet, or it could not be
                fetched.
              </div>
            )}
          </div>
        </div>

        {/* Install / update */}
        <div className="border-t border-border pt-3">
          <div className="mb-2 text-sm font-medium">Install or update a module</div>
          <div className="mb-2 text-xs text-muted">
            Point at <span className="mono">owner/repo</span>, a GitHub repo URL, or a direct{' '}
            <span className="mono">.zip</span> link containing a module folder (with its{' '}
            <span className="mono">module.json</span>). A repo resolves to its latest release, or
            the default branch if it has none yet. Nothing is written before you have seen the
            checks.
          </div>
          <div className="flex gap-2">
            <Input
              value={url}
              placeholder="owner/repo, a GitHub repo URL, or a direct .zip URL"
              spellCheck={false}
              disabled={busy}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !busy && url.trim() && void doCheckUrl()}
              className="min-w-0 flex-1"
            />
            <Button disabled={busy || !url.trim()} onClick={() => void doCheckUrl()}>
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <CloudDownload className="h-3.5 w-3.5" />
              )}
              Check
            </Button>
            <FilePickerButton
              accept=".zip,application/zip"
              label="From file"
              icon={<FolderOpen className="h-3.5 w-3.5" />}
              disabled={busy}
              onPick={(file) => void doCheckFile(file)}
            />
          </div>
        </div>

        {busy && state && (
          <div className="rounded-md border border-border bg-input/50 p-2.5 text-xs">
            {moduleProgressLabel(state)}
          </div>
        )}

        {!!state?.log?.length && (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-input p-2 text-[0.65rem] leading-relaxed text-muted">
            {state.log.join('\n')}
          </pre>
        )}

        {state?.phase === 'error' && !validation && state.error && (
          <div className="flex items-start gap-2 rounded-md border border-bad/30 bg-bad/10 p-2.5 text-xs">
            <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-bad" />
            <span className="min-w-0 break-words">{state.error}</span>
          </div>
        )}

        {validation && !busy && <ModuleChecks validation={validation} />}

        {(ready || validation || state?.phase === 'error') && !busy && (
          <div className="flex flex-wrap gap-2">
            {ready && (
              <Button
                variant={needsConfirm ? 'destructive' : 'default'}
                onClick={() => {
                  if (hasUnverifiedSource) setConfirmUnverified(true)
                  else if (needsConfirm) setConfirmInstall(true)
                  else void doInstall()
                }}
              >
                <Download className="h-3.5 w-3.5" />
                {validation?.kind === 'new' ? 'Install module' : 'Overwrite installed module'}
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={() => {
                void api.modules.cancel().then(setState)
                setUrl('')
              }}
            >
              <Trash2 className="h-3.5 w-3.5" /> Discard
            </Button>
          </div>
        )}
      </CardContent>

      <ModuleDetailsDialog module={details} onClose={() => setDetails(null)} />

      <ConfirmDialog
        open={confirmInstall}
        onOpenChange={setConfirmInstall}
        title="Overwrite the installed module"
        message={
          validation && (
            <>
              <b>{validation.moduleName}</b>{' '}
              {validation.kind === 'downgrade'
                ? `will be downgraded from ${validation.installedVersion} to ${validation.newVersion}`
                : validation.kind === 'reinstall'
                  ? `${validation.installedVersion} will be replaced by this copy of the same version`
                  : `will be updated to ${validation.newVersion}`}
              .{' '}
              {validation.overwritesDefault &&
                'It shipped with the app, so the app cannot put the original back afterwards. '}
              It starts running immediately - no rebuild, no restart; if compiling it fails, nothing
              is changed.
            </>
          )
        }
        confirmLabel="Overwrite & install"
        onConfirm={() => void doInstall()}
      />

      <ConfirmDialog
        open={confirmUnverified}
        onOpenChange={setConfirmUnverified}
        title="Unverified module"
        message={
          <>
            <div className="mb-2 flex items-center gap-1.5 font-medium text-warn">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> Not in the verified catalog
            </div>
            This module is not on the list of community-reviewed modules (or its hash does not
            match the reviewed version). It will run with the same access to the target machine as
            the app itself. Are you sure you want to install it?
          </>
        }
        confirmLabel="Install"
        onConfirm={() => void doInstall()}
      />

      <ConfirmDialog
        open={confirmRemove != null}
        onOpenChange={(v) => !v && setConfirmRemove(null)}
        title="Uninstall module"
        message={
          confirmRemove && (
            <>
              Delete <b>{confirmRemove.manifest.name}</b> from{' '}
              <span className="mono">modules/{confirmRemove.manifest.id}/</span>? Its page and cards
              disappear immediately - no rebuild, no restart.{' '}
              {confirmRemove.state.source === 'default'
                ? 'It shipped with the app: getting it back means installing its zip or reinstalling the app.'
                : 'Getting it back means installing its zip again.'}{' '}
              To switch it off without removing it, use the toggle instead.
            </>
          )
        }
        confirmLabel="Uninstall"
        onConfirm={() => {
          if (confirmRemove) void doUninstall(confirmRemove.manifest.id)
        }}
      />
    </Card>
  )
}

/**
 * App identity, the Apache-2.0 license, a link to the configured GitHub
 * repo, and every production library that ships in the bundle. Nothing here
 * is fetched at runtime - licenses.json is generated at build/dev time from
 * package.json dependencies.
 */
function AboutCard(): React.JSX.Element {
  const repo = useApp((s) => s.settings?.update.repo ?? DEFAULT_UPDATE_REPO)
  const repoUrl = `https://github.com/${repo}`
  return (
    <Card>
      <CardHeader>
        <CardTitle>About</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <div className="text-sm font-medium">Bored Manager</div>
          <div className="text-xs text-muted">Version {__APP_VERSION__}</div>
          <div className="text-xs text-muted">License Apache-2.0</div>
          <a
            href={repoUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-xs text-accent hover:underline"
          >
            <ExternalLink className="h-3 w-3" /> {repo}
          </a>
        </div>
        <div className="text-xs text-muted">
          Ứng dụng không tải tài nguyên từ CDN/bên thứ ba — toàn bộ thư viện được đóng gói kèm.
        </div>
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-xs">
            <thead className="bg-input/50 text-muted">
              <tr>
                <th className="px-2.5 py-1.5 text-left font-medium">Name</th>
                <th className="px-2.5 py-1.5 text-left font-medium">Version</th>
                <th className="px-2.5 py-1.5 text-left font-medium">License</th>
              </tr>
            </thead>
            <tbody>
              {bundledLicenses.map((pkg) => (
                <tr key={pkg.name} className="border-t border-border">
                  <td className="px-2.5 py-1.5 mono">{pkg.name}</td>
                  <td className="px-2.5 py-1.5 text-muted">{pkg.version}</td>
                  <td className="px-2.5 py-1.5 text-muted">{pkg.license}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  )
}
