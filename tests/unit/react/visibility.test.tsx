// @vitest-environment jsdom
import * as React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  setActiveTab: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  api: {
    ui: {
      setActiveTab: mocks.setActiveTab
    }
  }
}))

import {
  HIDDEN_TAB_GRACE_MS,
  reportActiveTab,
  startDocumentVisibilityTracking,
  useDocumentVisible
} from '../../../src/lib/visibility'

function VisibilityState(): React.JSX.Element {
  return <span>{useDocumentVisible() ? 'visible' : 'hidden'}</span>
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
  Reflect.deleteProperty(document, 'hidden')
})

describe('document visibility tracking', () => {
  it('pauses immediately, suspends the server after grace, and restores the current tab', async () => {
    vi.useFakeTimers()
    let hidden = false
    let activeTab = 'processes/main'
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => hidden
    })
    const stop = startDocumentVisibilityTracking(() => activeTab)
    render(<VisibilityState />)
    expect(screen.getByText('visible')).toBeTruthy()

    act(() => {
      hidden = true
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(screen.getByText('hidden')).toBeTruthy()
    await act(async () => vi.advanceTimersByTimeAsync(HIDDEN_TAB_GRACE_MS - 1))
    expect(mocks.setActiveTab).not.toHaveBeenCalled()

    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(mocks.setActiveTab).toHaveBeenLastCalledWith(null)

    reportActiveTab('network/main')
    expect(mocks.setActiveTab).toHaveBeenLastCalledWith(null)

    activeTab = 'network/main'
    act(() => {
      hidden = false
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(screen.getByText('visible')).toBeTruthy()
    expect(mocks.setActiveTab).toHaveBeenLastCalledWith('network/main')
    stop()
  })
})
