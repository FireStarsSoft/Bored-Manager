import * as React from 'react'
import { useApp } from '@/state/store'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { SelectField } from '@/components/select-field'
import { Switch } from '@/components/ui/switch'
import {
  COLLECTOR_LIST,
  DETAIL_COLLECTORS,
  DETAIL_OPTIONS,
  OVERVIEW_DETAIL_OPTIONS
} from './options'

/** What the app itself reads from the target machine, and how eagerly. */
export function CollectionCard(): React.JSX.Element {
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)

  if (!settings) return <></>

  return (
    <Card>
      <CardHeader>
        <CardTitle>Data collection</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5">
        <div className="text-xs text-muted-foreground">
          What the app itself reads from the target machine. Disable a collector and it stops
          completely - nothing is polled in the background. Everything a <b>module</b> collects
          (processes, network detail, disk, sensors, GPU, containers) is switched with the module in{' '}
          <b>Modules</b>.
        </div>
        {COLLECTOR_LIST.map((c) => (
          <div key={c.key} className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm">{c.label}</div>
              <div className="text-xs text-muted-foreground">{c.desc}</div>
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
          <div className="mb-2 text-xs text-muted-foreground">
            These collectors run external tools or enumerate detailed target state. “While
            page/card is visible” stops that work when neither a module page nor one of its enabled
            Overview cards is on screen; time-series history will have gaps while it is stopped.
            “Always” preserves continuous history and per-process session totals.
          </div>
          <div className="flex flex-col gap-2.5">
            {DETAIL_COLLECTORS.map((d) => (
              <div key={d.key} className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm">{d.label}</div>
                  <div className="text-xs text-muted-foreground">{d.desc}</div>
                </div>
                <SelectField
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
  )
}
