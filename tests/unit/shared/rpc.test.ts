import { describe, expect, it } from 'vitest'
import {
  parseRpcClientFrame,
  parseRpcServerFrame
} from '@shared/rpc'

describe('RPC protocol validation', () => {
  it('carries an optional stable error code', () => {
    expect(
      parseRpcServerFrame({
        kind: 'error',
        id: 1,
        code: 'VALIDATION_ERROR',
        message: 'invalid input'
      })
    ).toEqual({
      ok: true,
      frame: {
        kind: 'error',
        id: 1,
        code: 'VALIDATION_ERROR',
        message: 'invalid input'
      }
    })
    expect(
      parseRpcServerFrame({
        kind: 'error',
        id: 1,
        code: 'x'.repeat(65),
        message: 'invalid input'
      })
    ).toMatchObject({ ok: false })
  })

  it('bounds the number of RPC arguments', () => {
    expect(
      parseRpcClientFrame({
        kind: 'invoke',
        id: 1,
        channel: 'test',
        args: Array.from({ length: 65 }, () => null)
      })
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining('at most 64')
    })
  })
})
