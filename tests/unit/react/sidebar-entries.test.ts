import { describe, expect, it } from 'vitest'
import type { ModuleDescriptor, ModuleManifest } from '@shared/modules'
import { sidebarEntries } from '../../../src/lib/module-registry'

function descriptor(
  id: string,
  pages: ModuleManifest['pages'],
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
      pages
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

describe('sidebarEntries', () => {
  it('lists declared pages of enabled modules without needing live specs', () => {
    const modules = [
      descriptor('gpu', [{ id: 'dashboard', label: 'GPUs', icon: 'Cpu', order: 50 }]),
      descriptor('processes', []),
      descriptor('broken', [{ id: 'main', label: 'Broken' }], {
        problem: 'activate() failed'
      })
    ]

    const entries = sidebarEntries(['gpu', 'processes', 'broken'], modules)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      id: 'gpu',
      label: 'Gpu',
      order: 50,
      pages: [{ id: 'dashboard', label: 'GPUs', order: 50 }],
      specs: {}
    })
  })

  it('skips a module that is installed but not enabled', () => {
    const modules = [descriptor('sensors', [{ id: 'main', label: 'Sensors' }])]
    expect(sidebarEntries([], modules)).toEqual([])
  })

  it('attaches page specs when modules:specs has caught up', () => {
    const modules = [descriptor('disk', [{ id: 'devices', label: 'Disk', order: 30 }])]
    const spec = { blocks: [{ type: 'note', text: 'ready' }] }
    const entries = sidebarEntries(['disk'], modules, [
      {
        id: 'disk',
        manifest: modules[0]!.manifest,
        pages: { devices: spec as never },
        widgets: {}
      }
    ])
    expect(entries[0]?.specs.devices).toEqual(spec)
  })
})
