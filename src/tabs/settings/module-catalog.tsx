import * as React from 'react'
import { Download, ExternalLink } from 'lucide-react'
import type { ModuleInstallState, ModuleCatalog, ModuleDescriptor, RegistryEntry } from '@shared/modules'
import { compareVersions } from '@shared/modules'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatBytes } from '@/lib/utils'

export function moduleProgressLabel(state: ModuleInstallState): string {
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
export function moduleProgressPct(state: ModuleInstallState): number | null {
  if (state.phase === 'extracting' || state.phase === 'building') return null
  if (state.phase === 'validating' || state.phase === 'installing') return 100
  const p = state.progress
  if (!p?.totalBytes) return null
  return Math.min(100, Math.round((p.receivedBytes / p.totalBytes) * 100))
}

export function ModuleDetailsDialog({
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
export function CatalogEntryRow({
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

export type { ModuleCatalog }
