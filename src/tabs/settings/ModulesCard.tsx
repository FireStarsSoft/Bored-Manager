import * as React from 'react'
import {
  AlertTriangle,
  CloudDownload,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  Loader2,
  Puzzle,
  RefreshCw,
  ShieldCheck,
  Store,
  Trash2,
  XCircle
} from 'lucide-react'
import type { ModuleInstallState } from '@shared/modules'
import type {
  ModuleCatalog,
  ModuleDescriptor,
  RegistryEntry
} from '@shared/modules'
import { compareVersions } from '@shared/modules'
import { api } from '@/lib/api'
import { useApp } from '@/state/store'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatBytes } from '@/lib/utils'
import { FilePickerButton, message, timeLabel } from './shared'
import { ModuleChecks } from './module-checks'

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

/** As progressPct, for the module install phases. */
function moduleProgressPct(state: ModuleInstallState): number | null {
  if (state.phase === 'extracting' || state.phase === 'building') return null
  if (state.phase === 'validating' || state.phase === 'installing') return 100
  const p = state.progress
  if (!p?.totalBytes) return null
  return Math.min(100, Math.round((p.receivedBytes / p.totalBytes) * 100))
}

/** The verdict on an inspected archive: one row per rule that was checked. */

function ModuleDetailsDialog({
  module,
  onClose
}: {
  module: ModuleDescriptor | null
  onClose: () => void
}): React.JSX.Element {
  const docs = [
    { id: 'readme', label: 'README', file: 'README.md', text: module?.readme ?? '' },
    { id: 'changelog', label: 'CHANGELOG', file: 'CHANGELOG.md', text: module?.changelog ?? '' }
  ]
  return (
    <Dialog open={module != null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {module ? `${module.manifest.name} ${module.state.version}` : 'Module'}
          </DialogTitle>
          {module && <DialogDescription>{module.manifest.description}</DialogDescription>}
        </DialogHeader>
        {module && (
          <Tabs defaultValue="readme" className="min-h-0">
            <TabsList>
              {docs.map((d) => (
                <TabsTrigger key={d.id} value={d.id}>
                  {d.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {docs.map((d) => (
              <TabsContent key={d.id} value={d.id} className="min-h-0">
                <pre className="mono max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2.5 text-[0.7rem] leading-relaxed">
                  {d.text || `This module ships no ${d.file}.`}
                </pre>
              </TabsContent>
            ))}
          </Tabs>
        )}
      </DialogContent>
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
        <span className="mono text-xs text-muted-foreground">{entry.version}</span>
        {entry.author && <span className="text-xs text-muted-foreground">by {entry.author}</span>}
        <div className="flex-1" />
        {action ? (
          <Button size="sm" disabled={busy || needsNewerApp} onClick={() => onInstall(entry.download)}>
            <Download className="size-3" /> {action === 'update' ? 'Update' : 'Install'}
          </Button>
        ) : (
          <Badge variant="success">Installed</Badge>
        )}
      </div>
      {entry.description && <div className="mt-0.5 text-xs text-muted-foreground">{entry.description}</div>}
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {entry.homepage && (
          <a
            href={entry.homepage}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            <ExternalLink className="size-3" /> Homepage
          </a>
        )}
        {needsNewerApp && (
          <span className="text-warning">
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
          <Puzzle className="size-3.5 text-primary" /> Modules
        </CardTitle>
        <span className="text-xs text-muted-foreground">{modules.length} installed</span>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="text-xs text-muted-foreground">
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
                <span className="mono text-xs text-muted-foreground">{m.state.version}</span>
                <Badge variant={m.state.source === 'default' ? 'secondary' : 'default'}>
                  {m.state.source === 'default' ? 'built in' : 'installed'}
                </Badge>
                {m.problem ? (
                  <Badge variant="destructive">cannot run</Badge>
                ) : m.integrity === 'modified' ? (
                  <Badge variant="warning">files modified</Badge>
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
              <div className="mt-0.5 text-xs text-muted-foreground">{m.manifest.description}</div>
              {m.problem && (
                <div className="mt-1 break-words text-xs text-destructive">{m.problem}</div>
              )}
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <Button size="sm" variant="secondary" onClick={() => setDetails(m)}>
                  <FileText className="size-3" /> Details
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy || reloadingId === m.manifest.id}
                  onClick={() => void doReload(m)}
                >
                  {reloadingId === m.manifest.id ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <RefreshCw className="size-3" />
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
                  <ShieldCheck className="size-3" /> Verify
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => setConfirmRemove(m)}
                >
                  <Trash2 className="size-3" /> Uninstall
                </Button>
              </div>
            </div>
          ))}
          {modules.length === 0 && (
            <div className="p-2.5 text-xs text-muted-foreground">
              No modules are installed - only the Overview, Packages, Terminals and Settings pages
              are available.
            </div>
          )}
        </div>

        {/* Catalog */}
        <div className="border-t border-border pt-3">
          <div className="mb-2 flex items-center gap-2">
            <Store className="size-3.5 text-primary" />
            <span className="text-sm font-medium">Catalog</span>
            <span className="text-xs text-muted-foreground">
              {timeLabel(catalog?.fetchedAt ?? null)}
              {catalog?.stale && (
                <Badge variant="warning" className="ml-1.5">
                  stale
                </Badge>
              )}
            </span>
            <div className="flex-1" />
            <Button size="sm" variant="secondary" disabled={catalogBusy} onClick={() => void doCatalogRefresh()}>
              {catalogBusy ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <RefreshCw className="size-3" />
              )}
              Refresh
            </Button>
          </div>
          <div className="mb-2 text-xs text-muted-foreground">
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
              <div className="p-2.5 text-xs text-muted-foreground">
                The catalog is empty right now - nothing has been reviewed yet, or it could not be
                fetched.
              </div>
            )}
          </div>
        </div>

        {/* Install / update */}
        <div className="border-t border-border pt-3">
          <div className="mb-2 text-sm font-medium">Install or update a module</div>
          <div className="mb-2 text-xs text-muted-foreground">
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
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <CloudDownload className="size-3.5" />
              )}
              Check
            </Button>
            <FilePickerButton
              accept=".zip,application/zip"
              label="From file"
              icon={<FolderOpen className="size-3.5" />}
              disabled={busy}
              onPick={(file) => void doCheckFile(file)}
            />
          </div>
        </div>

        {busy && state && (
          <div className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/50 p-2.5 text-xs">
            <span>{moduleProgressLabel(state)}</span>
            <Progress value={moduleProgressPct(state)} aria-label="Install progress" />
          </div>
        )}

        {!!state?.log?.length && (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-[0.65rem] leading-relaxed text-muted-foreground">
            {state.log.join('\n')}
          </pre>
        )}

        {state?.phase === 'error' && !validation && state.error && (
          <Alert variant="destructive">
            <XCircle aria-hidden />
            <AlertDescription className="break-words">{state.error}</AlertDescription>
          </Alert>
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
                <Download className="size-3.5" />
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
              <Trash2 className="size-3.5" /> Discard
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
            <div className="mb-2 flex items-center gap-1.5 font-medium text-warning">
              <AlertTriangle className="size-3.5 shrink-0" /> Not in the verified catalog
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
export { ModulesCard }
