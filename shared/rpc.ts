import { isRecord, isSafeInteger } from './validation'

export interface RpcInvokeFrame {
  kind: 'invoke'
  id: number
  channel: string
  args: unknown[]
}

export interface RpcSendFrame {
  kind: 'send'
  channel: string
  args: unknown[]
}

export type RpcClientFrame = RpcInvokeFrame | RpcSendFrame

export interface RpcResultFrame {
  kind: 'result'
  id: number
  value: unknown
}

export interface RpcErrorFrame {
  kind: 'error'
  id: number
  code?: string
  message: string
}

export interface RpcEventFrame {
  kind: 'event'
  channel: string
  payload: unknown
}

export type RpcServerFrame = RpcResultFrame | RpcErrorFrame | RpcEventFrame

export type RpcFrameParseResult<T> =
  | { ok: true; frame: T }
  | { ok: false; error: string; id?: number }

const MAX_CHANNEL_LENGTH = 512
const MAX_ARGS = 64
const MAX_ERROR_CODE_LENGTH = 64
const INVALID_FRAME = 'invalid RPC frame'

function validId(value: unknown): value is number {
  return isSafeInteger(value) && value > 0
}

function channelProblem(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return '"channel" must be a non-empty string'
  if (value.length > MAX_CHANNEL_LENGTH) {
    return `"channel" must be at most ${MAX_CHANNEL_LENGTH} characters`
  }
  return null
}

function argsProblem(value: unknown): string | null {
  if (value === undefined) return null
  if (!Array.isArray(value)) return '"args" must be an array'
  return value.length <= MAX_ARGS ? null : `"args" must contain at most ${MAX_ARGS} items`
}

/**
 * Validate a client-to-server frame without trusting a transport cast. The
 * optional id on a failure is safe to echo in an error response.
 */
export function parseRpcClientFrame(value: unknown): RpcFrameParseResult<RpcClientFrame> {
  if (!isRecord(value)) return { ok: false, error: `${INVALID_FRAME}: expected an object` }

  const id = validId(value['id']) ? value['id'] : undefined
  const kind = value['kind']
  if (kind !== 'invoke' && kind !== 'send') {
    return {
      ok: false,
      error: `${INVALID_FRAME}: "kind" must be "invoke" or "send"`,
      ...(id === undefined ? {} : { id })
    }
  }

  if (kind === 'invoke' && id === undefined) {
    return {
      ok: false,
      error: `${INVALID_FRAME}: invoke "id" must be a positive safe integer`
    }
  }

  const channelError = channelProblem(value['channel'])
  if (channelError) {
    return {
      ok: false,
      error: `${INVALID_FRAME}: ${channelError}`,
      ...(id === undefined ? {} : { id })
    }
  }

  const argsError = argsProblem(value['args'])
  if (argsError) {
    return {
      ok: false,
      error: `${INVALID_FRAME}: ${argsError}`,
      ...(id === undefined ? {} : { id })
    }
  }

  const args = Array.isArray(value['args']) ? value['args'] : []
  if (kind === 'invoke') {
    return {
      ok: true,
      frame: { kind, id: id as number, channel: value['channel'] as string, args }
    }
  }
  return {
    ok: true,
    frame: { kind, channel: value['channel'] as string, args }
  }
}

/** Validate the three envelopes sent from the server to a browser. */
export function parseRpcServerFrame(value: unknown): RpcFrameParseResult<RpcServerFrame> {
  if (!isRecord(value)) return { ok: false, error: `${INVALID_FRAME}: expected an object` }

  switch (value['kind']) {
    case 'result':
      if (!validId(value['id'])) {
        return { ok: false, error: `${INVALID_FRAME}: result "id" must be a positive safe integer` }
      }
      return {
        ok: true,
        frame: { kind: 'result', id: value['id'], value: value['value'] }
      }
    case 'error':
      if (!validId(value['id'])) {
        return { ok: false, error: `${INVALID_FRAME}: error "id" must be a positive safe integer` }
      }
      if (typeof value['message'] !== 'string' || value['message'].length === 0) {
        return { ok: false, error: `${INVALID_FRAME}: error "message" must be a non-empty string` }
      }
      if (
        value['code'] !== undefined &&
        (typeof value['code'] !== 'string' ||
          value['code'].length === 0 ||
          value['code'].length > MAX_ERROR_CODE_LENGTH)
      ) {
        return { ok: false, error: `${INVALID_FRAME}: error "code" must be a short string` }
      }
      return {
        ok: true,
        frame: {
          kind: 'error',
          id: value['id'],
          ...(typeof value['code'] === 'string' ? { code: value['code'] } : {}),
          message: value['message']
        }
      }
    case 'event': {
      const problem = channelProblem(value['channel'])
      if (problem) return { ok: false, error: `${INVALID_FRAME}: ${problem}` }
      return {
        ok: true,
        frame: { kind: 'event', channel: value['channel'] as string, payload: value['payload'] }
      }
    }
    default:
      return {
        ok: false,
        error: `${INVALID_FRAME}: "kind" must be "result", "error" or "event"`
      }
  }
}
