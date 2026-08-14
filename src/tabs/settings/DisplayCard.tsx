import * as React from 'react'
import { useApp } from '@/state/store'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { SelectField } from '@/components/select-field'
import { DENSITY_OPTIONS, THEME_OPTIONS, WINDOW_OPTIONS } from './options'

/** Theme, density and the default chart range. */
export function DisplayCard(): React.JSX.Element {
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)

  if (!settings) return <></>

  return (
    <Card>
      <CardHeader>
        <CardTitle>Display</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm">Theme</div>
            <div className="text-xs text-muted-foreground">Colour scheme of the WebUI</div>
          </div>
          <SelectField
            value={settings.theme}
            onChange={(v) => void updateSettings({ theme: v })}
            options={THEME_OPTIONS}
            className="w-56"
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm">Display density</div>
            <div className="text-xs text-muted-foreground">Match your screen resolution</div>
          </div>
          <SelectField
            value={settings.density}
            onChange={(v) => void updateSettings({ density: v })}
            options={DENSITY_OPTIONS}
            className="w-56"
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm">Default history window</div>
            <div className="text-xs text-muted-foreground">
              Time range shown on Overview charts
            </div>
          </div>
          <SelectField
            value={String(settings.historyWindow)}
            onChange={(v) => void updateSettings({ historyWindow: parseInt(v, 10) })}
            options={WINDOW_OPTIONS}
            className="w-56"
          />
        </div>
      </CardContent>
    </Card>
  )
}
