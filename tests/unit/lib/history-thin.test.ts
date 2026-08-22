// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

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

import { thin } from '@/lib/history'

describe('thin', () => {
  it('returns the same array when there are already few enough points', () => {
    const points = [
      { t: 1, cpu: 1 },
      { t: 2, cpu: 2 }
    ]
    expect(thin(points, 10)).toBe(points)
  })

  it('returns the same array when maxPoints is zero or negative', () => {
    const points = [
      { t: 1, cpu: 1 },
      { t: 2, cpu: 2 },
      { t: 3, cpu: 3 }
    ]
    expect(thin(points, 0)).toBe(points)
    expect(thin(points, -4)).toBe(points)
  })

  it('keeps the tail without averaging when every point shares the same t', () => {
    const points = [
      { t: 10, cpu: 1 },
      { t: 10, cpu: 2 },
      { t: 10, cpu: 3 },
      { t: 10, cpu: 4 }
    ]
    expect(thin(points, 2)).toEqual([
      { t: 10, cpu: 3 },
      { t: 10, cpu: 4 }
    ])
  })

  it('reduces a long evenly spaced series and keeps times increasing', () => {
    const points = Array.from({ length: 1000 }, (_, i) => ({ t: i * 1000, cpu: i }))
    const out = thin(points, 10)
    expect(out.length).toBeLessThanOrEqual(10)
    expect(out.length).toBeGreaterThan(1)
    for (let i = 1; i < out.length; i++) {
      expect(out[i].t).toBeGreaterThan(out[i - 1].t)
    }
  })

  it('averages numeric keys independently inside a bucket', () => {
    const points = [
      { t: 0, cpu: 10, mem: 100 },
      { t: 10, cpu: 30, mem: 200 },
      { t: 1000, cpu: 1, mem: 1 }
    ]
    const out = thin(points, 2)
    expect(out[0]).toEqual({ t: 10, cpu: 20, mem: 150 })
    expect(out[1]).toEqual({ t: 1000, cpu: 1, mem: 1 })
  })

  it('treats a numeric key missing on earlier points as zero', () => {
    const points = [
      { t: 0, cpu: 10 },
      { t: 10, cpu: 10, extra: 20 },
      { t: 1000, cpu: 1 }
    ]
    const out = thin(points, 2)
    expect(out[0]).toEqual({ t: 10, cpu: 10, extra: 10 })
  })

  it('drops keys that are not finite numbers on the last point of the bucket', () => {
    const points = [
      { t: 0, cpu: 10, label: 'a', gap: Number.NaN },
      { t: 10, cpu: 20, label: 'b', gap: Number.NaN },
      { t: 1000, cpu: 1 }
    ]
    const out = thin(points, 2)
    expect(out[0]).toEqual({ t: 10, cpu: 15 })
    expect(out[0]).not.toHaveProperty('label')
    expect(out[0]).not.toHaveProperty('gap')
  })

  it('flushes a leftover point after the last full bucket', () => {
    const points = [
      { t: 0, cpu: 1 },
      { t: 1, cpu: 3 },
      { t: 10, cpu: 9 }
    ]
    const out = thin(points, 2)
    expect(out.at(-1)).toEqual({ t: 10, cpu: 9 })
  })
})
