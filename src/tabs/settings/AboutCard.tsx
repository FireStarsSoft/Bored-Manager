import * as React from 'react'
import { ExternalLink } from 'lucide-react'
import { DEFAULT_UPDATE_REPO } from '@shared/types'
import { useApp } from '@/state/store'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { DataTable, type DataTableColumns } from '@/components/data-table'
import bundledLicenses from '@/generated/licenses.json'

const licenseColumns: DataTableColumns<(typeof bundledLicenses)[number]> = [
  {
    accessorKey: 'name',
    header: 'Name',
    cell: (c) => <span className="mono">{c.getValue<string>()}</span>
  },
  {
    accessorKey: 'version',
    header: 'Version',
    cell: (c) => <span className="text-muted-foreground">{c.getValue<string>()}</span>
  },
  {
    accessorKey: 'license',
    header: 'License',
    cell: (c) => <span className="text-muted-foreground">{c.getValue<string>()}</span>
  }
]

function AboutCard(): React.JSX.Element {
  const repo = useApp((s) => s.settings?.update.repo ?? DEFAULT_UPDATE_REPO)
  const repoUrl = `https://github.com/${repo}`
  return (
    <Card>
      <CardHeader>
        <CardTitle>About</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div>
          <div className="text-sm font-medium">Bored Manager</div>
          <div className="text-xs text-muted-foreground">Version {__APP_VERSION__}</div>
          <div className="text-xs text-muted-foreground">License Apache-2.0</div>
          <a
            href={repoUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            <ExternalLink className="size-3" /> {repo}
          </a>
        </div>
        <div className="text-xs text-muted-foreground">
          The app does not load assets from a CDN or any other third-party host — every library is packed with the app.
        </div>
        <div className="rounded-md border border-border">
          <DataTable
            data={bundledLicenses}
            columns={licenseColumns}
            getRowId={(pkg) => pkg.name}
            initialSorting={[{ id: 'name', desc: false }]}
            virtualRowHeight={26}
            maxHeight="18rem"
          />
        </div>
      </CardContent>
    </Card>
  )
}

export { AboutCard }
