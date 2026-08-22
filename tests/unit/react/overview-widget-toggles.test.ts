import { describe, expect, it } from 'vitest'
import type { ModuleDescriptor, ModuleManifest } from '@shared/modules'
import { listModuleWidgetToggles } from '../../../src/lib/module-registry'

function descriptor(
  id: string,
  widgets: ModuleManifest['widgets'],
  extras: Partial<Pick<ModuleDescriptor, 'problem'>> = {}
): ModuleDescriptor {
  return {
    manifest: {
      apiVersion: 2,
      id,
      name: id[0]!.toUpperCase() + id.slice(1),
      version: '1.0.0',
      description: '',
      author: 'test',
      entries: { main: 'main/index.ts' },
      widgets
    },
    state: {
      id,
      enabled: true,
      version: '1.0.0',
      hash: '',
      source: 'default',
      installedAt: 0,
      updatedAt: 0
    },
    integrity: 'ok',
    ...extras
  }
}

describe('listModuleWidgetToggles', () => {
  it('lists declared widgets of enabled modules without needing live specs', () => {
    const modules = [
      descriptor('gpu', [{ id: 'summary', label: 'GPUs', defaultEnabled: true, order: 40 }]),
      descriptor('processes', []),
      descriptor('broken', [{ id: 'summary', label: 'Broken' }], {
        problem: 'activate() failed'
      })
    ]

    expect(listModuleWidgetToggles(['gpu', 'processes', 'broken'], modules)).toEqual([
      {
        id: 'gpu.summary',
        moduleId: 'gpu',
        widgetId: 'summary',
        moduleName: 'Gpu',
        label: 'GPUs',
        defaultEnabled: true,
        order: 40
      }
    ])
  })

  it('skips a module that is installed but not enabled', () => {
    const modules = [
      descriptor('sensors', [{ id: 'summary', label: 'Sensors' }])
    ]
    expect(listModuleWidgetToggles([], modules)).toEqual([])
  })
})
