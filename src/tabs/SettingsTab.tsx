import * as React from 'react'
import { Download, Upload } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/state/store'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { SelectField } from '@/components/select-field'
import { Switch } from '@/components/ui/switch'
import { FilePickerButton, message } from './settings/shared'
import {
  COLLECTOR_LIST,
  DENSITY_OPTIONS,
  DETAIL_COLLECTORS,
  DETAIL_OPTIONS,
  INTERVAL_GROUPS,
  OVERVIEW_DETAIL_OPTIONS,
  SLOW_OPTIONS,
  SPEED_OPTIONS,
  THEME_OPTIONS,
  WINDOW_OPTIONS
} from './settings/options'
import { AboutCard } from './settings/AboutCard'
import { DataStorageCard } from './settings/DataStorageCard'
import { ModulesCard } from './settings/ModulesCard'
import { OverviewCardsCard } from './settings/OverviewCardsCard'
import { ServerUsersCard } from './settings/ServerUsersCard'
import { SoftwareUpdateCard } from './settings/SoftwareUpdateCard'

/**
 * The Settings page shell. Only the three small cards that read straight from
 * AppSettings live here; everything with its own state and RPC calls is a card
 * module under ./settings/.
 */
export function SettingsTab(): React.JSX.Element {
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const setSettingsFull = useApp((s) => s.setSettingsFull)
  const showNotice = useApp((s) => s.showNotice)

  if (!settings) return <div className="p-4 text-muted-foreground">Loading…</div>

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
          <CardContent className="flex flex-col gap-3">
            <div className="text-xs text-muted-foreground">
              Within one category, some metrics move every second and others hardly at all. Disk
              throughput is measured on the fast interval while mount usage and the device list run
              on the slow one, so a busy detail page never has to wait for a{' '}
              <span className="mono">df</span> that had nothing new to say. Sections fed by a slow
              interval show their age and a refresh button.
            </div>
            {INTERVAL_GROUPS.map((group) => (
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

        {/* Data collection */}
        <Card>
          <CardHeader>
            <CardTitle>Data collection</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2.5">
            <div className="text-xs text-muted-foreground">
              What the app itself reads from the target machine. Disable a collector and it stops
              completely - nothing is polled in the background. Everything a <b>module</b> collects
              (processes, network detail, disk, sensors, GPU, Docker) is switched with the module in{' '}
              <b>Modules</b> below.
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
                The detail collectors below are the heaviest ones (they enumerate every socket /
                every process). "While tab is open" keeps them free when you are not looking;
                "Always" keeps per-process session totals accurate in the background.
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

        {/* Display */}
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
                <div className="text-xs text-muted-foreground">Time range shown on Overview charts</div>
              </div>
              <SelectField
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
            <div className="mb-3 text-xs text-muted-foreground">
              All customisations are stored in <span className="mono">data/user-settings/</span>{' '}
              inside the app folder on the server. Export downloads that file to this device, so
              you can move your setup to another machine or import one you saved earlier. Deleting
              the app folder removes the app and all its data completely.
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

