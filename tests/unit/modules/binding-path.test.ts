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

import { resolveActionArgs, resolvePath, substituteScopeArgs } from '@/modules/binding'

describe('resolvePath', () => {
  const obj = { mem: { used: 3 }, gpus: [{ temp: 71 }] }

  it('returns the value for an empty or missing path', () => {
    expect(resolvePath(obj, undefined)).toBe(obj)
    expect(resolvePath(obj, '')).toBe(obj)
  })

  it('walks a dotted object path', () => {
    expect(resolvePath(obj, 'mem.used')).toBe(3)
  })

  it('walks an integer array index', () => {
    expect(resolvePath(obj, 'gpus.0.temp')).toBe(71)
  })

  it('returns undefined for a non-integer array segment', () => {
    expect(resolvePath(obj, 'gpus.x.temp')).toBeUndefined()
  })

  it('returns undefined when the walk hits null or a primitive', () => {
    expect(resolvePath(null, 'a.b')).toBeUndefined()
    expect(resolvePath(5, 'a')).toBeUndefined()
  })
})

describe('substituteScopeArgs', () => {
  it('replaces $row. fields and leaves literals alone', () => {
    expect(substituteScopeArgs(['$row.pid', 'TERM', 1], { pid: 42 })).toEqual([42, 'TERM', 1])
  })

  it('substitutes undefined when the scope field is missing', () => {
    expect(substituteScopeArgs(['$row.missing'], {})).toEqual([undefined])
  })

  it('treats a missing args list as an empty array', () => {
    expect(substituteScopeArgs(undefined, {})).toEqual([])
  })
})

describe('resolveActionArgs', () => {
  it('orders argsFromRow, substituted args, then extras', () => {
    expect(
      resolveActionArgs(
        { label: 'Act', method: 'do', argsFromRow: ['id'], args: ['$row.action'] },
        { id: 'abc', action: 'stop' },
        ['force']
      )
    ).toEqual(['abc', 'stop', 'force'])
  })

  it('resolves a nested argsFromRow path next to a literal arg', () => {
    expect(
      resolveActionArgs(
        { label: 'Ping', method: 'ping', argsFromRow: ['net.ip'], args: ['ping'] },
        { net: { ip: '10.0.0.8' } }
      )
    ).toEqual(['10.0.0.8', 'ping'])
  })
})
