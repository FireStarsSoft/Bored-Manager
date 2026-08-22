import { describe, expect, it } from 'vitest'
import { parseRpcClientFrame, parseRpcServerFrame } from '@shared/rpc'
import {
  finiteInteger,
  isFiniteNumber,
  isRecord,
  isStringArray,
  oneOf,
  stringValue
} from '@shared/validation'

describe('common runtime validators', () => {
  it('distinguishes JSON objects, arrays and finite scalars', () => {
    expect(isRecord({ ok: true })).toBe(true)
    expect(isRecord([])).toBe(false)
    expect(isRecord(null)).toBe(false)
    expect(isFiniteNumber(1.5)).toBe(true)
    expect(isFiniteNumber(Number.POSITIVE_INFINITY)).toBe(false)
    expect(isStringArray(['a', 'b'])).toBe(true)
    expect(isStringArray(['a', 2])).toBe(false)
  })

  it('normalizes bounded integers, enums and strings', () => {
    expect(finiteInteger(4.9, 1, { min: 1, max: 5 })).toBe(4)
    expect(finiteInteger(Number.NaN, 1, { min: 1, max: 5 })).toBe(1)
    expect(oneOf('open', ['open', 'closed'] as const, 'closed')).toBe('open')
    expect(oneOf('other', ['open', 'closed'] as const, 'closed')).toBe('closed')
    expect(stringValue('  host  ', 'fallback', { trim: true, allowEmpty: false })).toBe('host')
    expect(stringValue('   ', 'fallback', { trim: true, allowEmpty: false })).toBe('fallback')
  })
})

describe('RPC envelope validation', () => {
  it('parses valid invoke, send and server frames', () => {
    expect(parseRpcClientFrame({ kind: 'invoke', id: 7, channel: 'status' })).toEqual({
      ok: true,
      frame: { kind: 'invoke', id: 7, channel: 'status', args: [] }
    })
    expect(parseRpcClientFrame({ kind: 'send', channel: 'tab', args: ['overview'] })).toEqual({
      ok: true,
      frame: { kind: 'send', channel: 'tab', args: ['overview'] }
    })
    expect(parseRpcServerFrame({ kind: 'event', channel: 'push:status', payload: null })).toEqual({
      ok: true,
      frame: { kind: 'event', channel: 'push:status', payload: null }
    })
  })

  it('returns stable failures and only echoes a validated request id', () => {
    expect(parseRpcClientFrame({ kind: 'invoke', id: 9, channel: 'status', args: {} })).toEqual({
      ok: false,
      id: 9,
      error: 'invalid RPC frame: "args" must be an array'
    })
    expect(parseRpcClientFrame({ kind: 'invoke', id: 1.5, channel: 'status' })).toEqual({
      ok: false,
      error: 'invalid RPC frame: invoke "id" must be a positive safe integer'
    })
    expect(parseRpcServerFrame({ kind: 'error', id: 1, message: '' })).toEqual({
      ok: false,
      error: 'invalid RPC frame: error "message" must be a non-empty string'
    })
  })
})
