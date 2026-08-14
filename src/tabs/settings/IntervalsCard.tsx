import * as React from 'react'
import { useApp } from '@/state/store'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { SelectField } from '@/components/select-field'
import { INTERVAL_GROUPS, SLOW_OPTIONS, SPEED_OPTIONS } from './options'

/**
 * How often each category is read. A group whose module is switched off is left
 * out: the interval would have nothing to drive, and a list of settings that do
 * nothing is worse than a short list.
 */
export function IntervalsCard(): React.JSX.Element {
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const enabledModules = useApp((s) => s.enabledModules)

  if (!settings) return <></>

  const groups = INTERVAL_GROUPS.filter(
    (g) => !g.moduleId || enabledModules.includes(g.moduleId)
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle>Update intervals</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="text-xs text-muted-foreground">
          Within one category, some metrics move every second and others hardly at all. Disk
          throughput is measured on the fast interval while mount usage and the device list run on
          the slow one, so a busy detail page never has to wait for a{' '}
          <span className="mono">df</span> that had nothing new to say. Sections fed by a slow
          interval show their age and a refresh button.
        </div>
        {groups.map((group) => (
          <div key={group.label} className="border-t border-border pt-3 first:border-0 first:pt-0">
            <div className="mb-1.5 text-sm font-medium">{group.label}</div>
            <div className="flex flex-col gap-2">
              {group.fast && (
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs">Fast</div>
                    <div className="text-xs text-muted-foreground">{group.fast.desc}</div>
                  </div>
                  <SelectField
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
                    <div className="text-xs text-muted-foreground">{group.slow.desc}</div>
                  </div>
                  <SelectField
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
  )
}
