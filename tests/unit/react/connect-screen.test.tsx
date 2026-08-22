// @vitest-environment jsdom
import type * as React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectScreen } from '@/screens/ConnectScreen'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  showNotice: vi.fn(),
  listSaved: vi.fn(async () => []),
  info: vi.fn(async () => ({ platform: 'win32', version: 'test' }))
}))

vi.mock('@/state/store', () => ({
  useApp: (selector: (state: unknown) => unknown) =>
    selector({
      connect: mocks.connect,
      connecting: false,
      showNotice: mocks.showNotice
    })
}))

vi.mock('@/lib/api', () => ({
  api: {
    connection: {
      listSaved: mocks.listSaved,
      getCredentials: vi.fn(),
      deleteSaved: vi.fn()
    },
    app: { info: mocks.info }
  }
}))

vi.mock('@/components/confirm-dialog', () => ({
  ConfirmDialog: ({
    open,
    onConfirm
  }: {
    open: boolean
    onConfirm: () => void
  }) => (open ? <button onClick={onConfirm}>Trust this host</button> : null)
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

describe('ConnectScreen host-key confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    )
  })

  it('resubmits the exact fingerprint and one-use token from the challenge', async () => {
    const fingerprint = 'a'.repeat(64)
    mocks.connect
      .mockResolvedValueOnce({
        ok: false,
        error: 'Unknown host key',
        hostKey: {
          kind: 'unknown',
          host: 'server.example',
          port: 22,
          fingerprint,
          token: 'challenge-token',
          expiresAt: Date.now() + 60_000
        }
      })
      .mockResolvedValueOnce({ ok: true })

    render(<ConnectScreen />)
    await waitFor(() => expect(mocks.info).toHaveBeenCalled())
    fireEvent.change(await screen.findByLabelText('Host'), {
      target: { value: 'server.example' }
    })
    fireEvent.change(screen.getByLabelText('Username'), {
      target: { value: 'tester' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(mocks.connect).toHaveBeenCalledTimes(1))
    fireEvent.click(await screen.findByRole('button', { name: 'Trust this host' }))
    await waitFor(() => expect(mocks.connect).toHaveBeenCalledTimes(2))

    expect(mocks.connect.mock.calls[1][0]).toMatchObject({
      mode: 'ssh',
      host: 'server.example',
      port: 22,
      username: 'tester',
      hostKeyConfirmation: {
        fingerprint,
        token: 'challenge-token'
      }
    })
    expect(mocks.connect.mock.calls[1][0]).not.toHaveProperty('acceptHostKey')
  })
})
