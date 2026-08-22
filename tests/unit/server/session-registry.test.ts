import { describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from '../../../server/session-registry'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('SessionRegistry shutdown state', () => {
  it('disposes registrations made while shutdown is already draining', async () => {
    const logger = vi.fn()
    const registry = new SessionRegistry(logger)
    const late = deferred()
    const order: string[] = []

    registry.register('first', () => {
      order.push('first')
      registry.register('late', async () => {
        order.push('late-start')
        await late.promise
        order.push('late-finish')
      })
    })

    const shutdown = registry.disposeAll(1_000)
    expect(registry.state).toBe('shutting-down')
    await Promise.resolve()
    expect(order).toEqual(['first', 'late-start'])
    late.resolve()
    await shutdown

    expect(order).toEqual(['first', 'late-start', 'late-finish'])
    expect(registry.state).toBe('disposed')
    expect(registry.size).toBe(0)
    expect(logger).not.toHaveBeenCalled()
  })

  it('is idempotent and immediately disposes resources registered after shutdown', async () => {
    const registry = new SessionRegistry()
    const dispose = vi.fn()
    const first = registry.disposeAll()
    expect(registry.disposeAll()).toBe(first)
    await first

    registry.register('too-late', dispose)
    await Promise.resolve()

    expect(dispose).toHaveBeenCalledOnce()
    expect(registry.state).toBe('disposed')
    expect(registry.size).toBe(0)
  })

  it('logs disposal failures without abandoning the remaining resources', async () => {
    const logger = vi.fn()
    const registry = new SessionRegistry(logger)
    const healthy = vi.fn()
    registry.register('broken', () => {
      throw new Error('broken cleanup')
    })
    registry.register('healthy', healthy)

    await registry.disposeAll()

    expect(healthy).toHaveBeenCalledOnce()
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining('broken'),
      expect.any(Error)
    )
  })
})
