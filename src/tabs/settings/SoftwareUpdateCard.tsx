import * as React from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  CloudDownload,
  Download,
  Loader2,
  RefreshCw,
  Trash2,
  Upload,
  XCircle
} from 'lucide-react'
import type { UpdateRepoInfo, UpdateState } from '@shared/types'
import { DEFAULT_UPDATE_REPO } from '@shared/types'
import { compareVersions } from '@shared/modules'
import { api } from '@/lib/api'
import { useApp } from '@/state/store'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { formatBytes } from '@/lib/utils'
import { FilePickerButton, message } from './shared'

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
 * A percentage for the bar, or null while the phase has no measurable progress
 * (a server that has not answered yet, a download with no content-length) -
 * which Progress renders as indeterminate rather than as 0%.
 */
function progressPct(state: UpdateState): number | null {
  if (state.phase === 'extracting') return null
  if (state.phase === 'validating' || state.phase === 'applying') return 100
  const p = state.progress
  if (!p?.totalBytes) return null
  return Math.min(100, Math.round((p.receivedBytes / p.totalBytes) * 100))
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
          <div className="text-xs text-muted-foreground">
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
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              Check for updates
            </Button>
          </div>
          {latestLabel && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className={alreadyCurrent ? 'text-muted-foreground' : 'text-foreground'}>{latestLabel}</span>
              {repoZip && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={locked}
                  onClick={() => void doCheck(repoZip)}
                >
                  <CloudDownload className="size-3.5" />
                  Download & test
                </Button>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <div className="text-xs text-muted-foreground">
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
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <CloudDownload className="size-3.5" />
              )}
              Download & test
            </Button>
            <FilePickerButton
              accept=".zip"
              label="From file"
              icon={<Upload className="size-3.5" />}
              disabled={locked}
              onPick={(file) => void doCheckFile(file)}
            />
          </div>
        </div>

        {(busy || applying) && (
          <div className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/50 p-2.5 text-xs">
            <span>{progressLabel(state)}</span>
            <Progress value={progressPct(state)} aria-label="Update progress" />
          </div>
        )}

        {!busy && !applying && state.phase === 'error' && !validation && (
          <Alert variant="destructive">
            <XCircle aria-hidden />
            <AlertDescription className="break-words">{state.error}</AlertDescription>
          </Alert>
        )}

        {validation && !busy && (
          <div className="rounded-md border border-border bg-muted/50 p-2.5">
            <div className="mb-2 flex items-center gap-2 border-b border-border pb-2">
              {validation.status === 'pass' ? (
                <>
                  <CheckCircle2 className="size-4 text-success" />
                  <span className="text-sm text-success">PASS</span>
                </>
              ) : (
                <>
                  <XCircle className="size-4 text-destructive" />
                  <span className="text-sm text-destructive">ERROR</span>
                </>
              )}
              <span className="ml-auto mono text-xs text-muted-foreground">
                {validation.currentVersion} {'->'} {validation.newVersion ?? '?'}
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              {validation.checks.map((c) => (
                <div key={c.id} className="flex items-start gap-2">
                  {c.ok ? (
                    <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
                  ) : (
                    <XCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                  )}
                  <div className="min-w-0">
                    <div className="text-xs">{c.label}</div>
                    {c.detail && (
                      <div className="break-words text-xs text-muted-foreground">{c.detail}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {!!validation.warnings.length && (
              <div className="mt-2 flex flex-col gap-1.5 border-t border-border pt-2">
                {validation.warnings.map((w) => (
                  <div key={w} className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
                    <span className="min-w-0 break-words text-xs text-muted-foreground">{w}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {ready && (
          <div className="rounded-md border border-warning/30 bg-warning/10 p-2.5 text-xs">
            <div className="mb-1 flex items-center gap-2 text-warning">
              <AlertTriangle className="size-3.5" /> The server will restart itself
            </div>
            <ul className="ml-4 list-disc space-y-1 text-muted-foreground">
              <li>The server quits and an update script takes over.</li>
              <li>
                The current folder is replaced by version {validation?.newVersion}; your{' '}
                <span className="text-foreground">accounts, saved SSH connections and these settings are
                carried over</span>
                .
              </li>
              <li>
                The metrics history and all logs are <span className="text-foreground">deleted</span>.
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
                <Download className="size-3.5" /> Confirm & install
              </Button>
            )}
            <Button variant="secondary" disabled={applying} onClick={() => void doCancel()}>
              <Trash2 className="size-3.5" />
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


export { SoftwareUpdateCard }
