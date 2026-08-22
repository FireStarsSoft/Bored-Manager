import { describe, expect, it } from 'vitest'
import { runCleanClose } from '../../../server/clean-close'

describe('clean-close ordering', () => {
  it('stops producers, flushes their stable history, then tears resources down', async () => {
    const order: string[] = []

    await runCleanClose({
      stopNewWork: () => {
        order.push('stop-new-work')
      },
      stopHostServices: () => {
        order.push('stop-host-services')
      },
      flushHistory: () => {
        order.push('flush-history')
      },
      disconnectExecutor: async () => {
        order.push('disconnect-start')
        await Promise.resolve()
        order.push('disconnect-finish')
      },
      disposeTerminals: () => {
        order.push('dispose-terminals')
      },
      disposeRegistry: () => {
        order.push('dispose-registry')
      }
    })

    expect(order).toEqual([
      'stop-new-work',
      'stop-host-services',
      'flush-history',
      'disconnect-start',
      'disconnect-finish',
      'dispose-terminals',
      'dispose-registry'
    ])
  })

  it('attempts later cleanup after a step fails', async () => {
    const order: string[] = []
    await expect(
      runCleanClose({
        stopNewWork: () => {
          order.push('stop')
          throw new Error('stop failed')
        },
        stopHostServices: () => {
          order.push('services')
        },
        flushHistory: () => {
          order.push('history')
        },
        disconnectExecutor: () => {
          order.push('disconnect')
        },
        disposeTerminals: () => {
          order.push('terminals')
        },
        disposeRegistry: () => {
          order.push('registry')
        }
      })
    ).rejects.toBeInstanceOf(AggregateError)
    expect(order).toEqual([
      'stop',
      'services',
      'history',
      'disconnect',
      'terminals',
      'registry'
    ])
  })
})
