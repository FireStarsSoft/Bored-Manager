import * as React from 'react'
import { Download, Upload } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/state/store'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { errorMessage } from '@/lib/utils'
import { FilePickerButton } from './shared'

/** Take the settings file to another machine, or bring one back. */
export function BackupCard(): React.JSX.Element {
  const setSettingsFull = useApp((s) => s.setSettingsFull)
  const showNotice = useApp((s) => s.showNotice)

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
      showNotice('error', `Import failed: ${errorMessage(err)}`)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Backup & portability</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="mb-3 text-xs text-muted-foreground">
          All customisations are stored in <span className="mono">data/user-settings/</span> inside
          the app folder on the server. Export downloads that file to this device, so you can move
          your setup to another machine or import one you saved earlier. Deleting the app folder
          removes the app and all its data completely.
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={doExport}>
            <Download className="size-3.5" /> Export settings
          </Button>
          <FilePickerButton
            accept=".json,application/json"
            label="Import settings"
            icon={<Upload className="size-3.5" />}
            onPick={(file) => void doImport(file)}
          />
        </div>
      </CardContent>
    </Card>
  )
}
