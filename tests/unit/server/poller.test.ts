import { describe, expect, it, vi } from 'vitest'
import { Poller } from '../../../server/services/poller'
import { withFakeClock } from '../../helpers/fake-clock'

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('Poller', () => {
  it('does not restart or tick immediately when the interval is unchanged', async () => {
    await withFakeClock(0, async () => {
      const tick = vi.fn(async () => {})
      const poller = new Poller('test:stable', tick)

      poller.start(1_000)
      await settle()
      expect(tick).toHaveBeenCalledTimes(1)

      poller.start(1_000)
      await settle()
      expect(tick).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1_000)
      expect(tick).toHaveBeenCalledTimes(2)
      poller.stop()
    })
  })

  it('restarts and ticks immediately when the interval changes', async () => {
    await withFakeClock(0, async () => {
      const tick = vi.fn(async () => {})
      const poller = new Poller('test:interval', tick)

      poller.start(1_000)
      await settle()
      poller.start(2_000)
      await settle()
      expect(tick).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(1_999)
      expect(tick).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(tick).toHaveBeenCalledTimes(3)
      poller.stop()
    })
  })

  it('ticks immediately after an explicit stop and start', async () => {
    await withFakeClock(0, async () => {
      const tick = vi.fn(async () => {})
      const poller = new Poller('test:resume', tick)

      poller.start(1_000)
      await settle()
      poller.stop()
      poller.start(1_000)
      await settle()

      expect(tick).toHaveBeenCalledTimes(2)
      poller.stop()
    })
  })
})
