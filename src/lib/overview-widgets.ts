import * as React from 'react'
import type { OverviewWidgetSettings } from '@shared/types'
import type { ModuleSpecsEntry } from '@shared/module-ui'
import { listModuleWidgets, type OverviewWidgetEntry } from '@/lib/module-registry'
import { ModuleWidget as ModuleWidgetView } from '@/modules/BlockRenderer'

export type { OverviewWidgetEntry }
export { listModuleWidgets }

/** Whether a widget is shown: the user's choice, or the card's own default. */
export function isWidgetOn(
  settings: OverviewWidgetSettings,
  id: string,
  defaultEnabled = false
): boolean {
  return settings[id] ?? defaultEnabled
}

/** The switched-on module widgets, rendered and ready for the grid. */
export function collectOverviewWidgets(
  enabledIds: readonly string[],
  settings: OverviewWidgetSettings,
  specsList: ModuleSpecsEntry[],
  visible: boolean
): Array<{ id: string; order: number; node: React.ReactNode }> {
  return listModuleWidgets(enabledIds, specsList)
    .filter((e) => isWidgetOn(settings, e.id, e.defaultEnabled))
    .map((e) => ({
      id: e.id,
      order: e.order ?? 100,
      node: React.createElement(ModuleWidgetView, {
        key: e.id,
        moduleId: e.moduleId,
        widgetId: e.widgetId,
        spec: e.spec,
        visible
      })
    }))
}
