// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChartBlock } from '@shared/module-ui'
import type { ModuleManifest } from '@shared/modules'

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {}
    })
  })
})

const chartMocks = vi.hoisted(() => ({
  sparkline: vi.fn(() => null),
  detail: vi.fn(() => null)
}))

vi.mock('@/components/charts', () => ({
  Sparkline: chartMocks.sparkline,
  DetailChart: chartMocks.detail
}))

import { pushLatest, clearModuleBus } from '../../../src/lib/module-bus'
import { useModuleSpecs } from '../../../src/lib/module-registry'
import { useApp } from '../../../src/state/store'
import { BlockData } from '../../../src/modules/binding'
import { ChartBlockView } from '../../../src/modules/blocks/ChartBlock'

const manifest = {
  apiVersion: 2,
  id: 'probe',
  name: 'Probe',
  version: '1.0.0',
  description: 'Test module.',
  author: 'tests',
  entries: { main: 'main/index.ts' },
  streams: [{ event: 'snapshot', kind: 'latest' }]
} as ModuleManifest

beforeEach(() => {
  clearModuleBus()
  useModuleSpecs.setState({
    list: [{ id: 'probe', manifest, pages: {}, widgets: {} }]
  })
  chartMocks.sparkline.mockClear()
  chartMocks.detail.mockClear()
})

afterEach(() => cleanup())

describe('module block data isolation', () => {
  it('does not re-render a stream source when core system metrics change', () => {
    const renders = vi.fn()
    render(
      <BlockData
        moduleId="probe"
        source={{ kind: 'stream', event: 'snapshot' }}
        opts={{ visible: true }}
      >
        {({ value }) => {
          renders(value)
          return <span>{String((value as { label?: string } | null)?.label ?? 'empty')}</span>
        }}
      </BlockData>
    )

    act(() => pushLatest('probe', 'snapshot', { label: 'ready' }))
    expect(screen.getByText('ready')).toBeTruthy()
    renders.mockClear()

    act(() => {
      useApp.setState({ system: [{ t: Date.now() }] as never })
    })
    expect(renders).not.toHaveBeenCalled()
  })

  it('does not mount a recharts surface while a chart block is hidden', () => {
    const block = {
      type: 'chart',
      kind: 'area',
      source: { kind: 'stream', event: 'snapshot' },
      series: [{ key: 'value', label: 'Value' }]
    } as ChartBlock

    render(
      <ChartBlockView
        block={block}
        ctx={{
          moduleId: 'probe',
          visible: false,
          windowSec: 60,
          compact: false
        }}
      />
    )

    expect(chartMocks.sparkline).not.toHaveBeenCalled()
    expect(chartMocks.detail).not.toHaveBeenCalled()
  })
})
