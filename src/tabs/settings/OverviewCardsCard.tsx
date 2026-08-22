import * as React from 'react'
import { LayoutGrid } from 'lucide-react'
import { useApp } from '@/state/store'
import { isWidgetOn, listModuleWidgetToggles } from '@/lib/overview-widgets'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { CORE_WIDGETS } from './options'

function OverviewCardsCard(): React.JSX.Element | null {
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const enabledIds = useApp((s) => s.enabledModules)
  const modules = useApp((s) => s.modules)
  const moduleWidgets = React.useMemo(
    () => listModuleWidgetToggles(enabledIds, modules),
    [enabledIds, modules]
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
      <CardContent className="flex flex-col gap-2.5">
        <div className="text-xs text-muted-foreground">
          CPU, Memory, Network and Disk I/O are always shown. Everything below is optional; every
          card can be dragged into place on the Overview and is as tall as its content needs.
        </div>
        {CORE_WIDGETS.map((c) => (
          <div key={c.id} className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm">{c.label}</div>
              <div className="text-xs text-muted-foreground">{c.desc}</div>
            </div>
            <Switch
              checked={isWidgetOn(widgets, c.id, c.defaultEnabled)}
              onCheckedChange={(v) => toggle(c.id, v)}
            />
          </div>
        ))}
        {[...byModule].map(([moduleName, entries]) => (
          <div key={moduleName} className="border-t border-border pt-2.5">
            <div className="mb-1.5 text-[0.65rem] uppercase tracking-wide text-muted-foreground">
              {moduleName} module
            </div>
            <div className="flex flex-col gap-2.5">
              {entries.map((e) => (
                <div key={e.id} className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm">{e.label}</div>
                    <div className="text-xs text-muted-foreground mono">{e.id}</div>
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
            <div className="text-xs text-muted-foreground">
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
            <LayoutGrid className="size-3.5" /> Reset layout
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}


export { OverviewCardsCard }
