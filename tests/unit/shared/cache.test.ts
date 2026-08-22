import { describe, expect, it, vi } from 'vitest'
import { createTtlCache } from '@shared/cache'
import { withFakeClock } from '../../helpers/fake-clock'

describe('createTtlCache', () => {
  it('coalesces in-flight reads and reuses successful values until expiry', async () => {
    await withFakeClock(1_000, async () => {
      let release!: (value: string) => void
      const load = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            release = resolve
          })
      )
      const cache = createTtlCache<string>(1_000)

      const first = cache.get('host', load)
      const second = cache.get('host', load)
      await Promise.resolve()
      expect(load).toHaveBeenCalledTimes(1)
      release('ready')
      await expect(Promise.all([first, second])).resolves.toEqual(['ready', 'ready'])

      await expect(cache.get('host', load)).resolves.toBe('ready')
      expect(load).toHaveBeenCalledTimes(1)
      vi.setSystemTime(2_001)
      const expired = cache.get('host', async () => 'fresh')
      await expect(expired).resolves.toBe('fresh')
    })
  })

  it('does not cache failures and clear invalidates an in-flight result', async () => {
    const cache = createTtlCache<string>(1_000)
    await expect(cache.get('failure', async () => Promise.reject(new Error('offline')))).rejects.toThrow(
      'offline'
    )
    await expect(cache.get('failure', async () => 'recovered')).resolves.toBe('recovered')

    let release!: (value: string) => void
    const stale = cache.get(
      'host',
      () =>
        new Promise<string>((resolve) => {
          release = resolve
        })
    )
    await Promise.resolve()
    cache.clear('host')
    release('stale')
    await expect(stale).resolves.toBe('stale')
    await expect(cache.get('host', async () => 'current')).resolves.toBe('current')
  })
})
