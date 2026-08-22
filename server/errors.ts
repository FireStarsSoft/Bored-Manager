/**
 * Errors that may cross the HTTP/WebSocket boundary. Only errors created in
 * this module are safe to expose; everything else is logged and reduced to a
 * stable generic response.
 */

export const PUBLIC_ERROR_CODES = {
  validation: 'VALIDATION_ERROR',
  invalidRequest: 'INVALID_REQUEST',
  notFound: 'NOT_FOUND',
  conflict: 'CONFLICT',
  unauthorized: 'UNAUTHORIZED',
  shuttingDown: 'SERVER_SHUTTING_DOWN',
  internal: 'INTERNAL_ERROR'
} as const

export class PublicError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400
  ) {
    super(message)
    this.name = 'PublicError'
  }
}

export class ValidationError extends PublicError {
  constructor(message = 'Invalid request arguments') {
    super(PUBLIC_ERROR_CODES.validation, message, 400)
    this.name = 'ValidationError'
  }
}

export interface PublicErrorPayload {
  code: string
  message: string
  status: number
}

export function publicErrorPayload(error: unknown): PublicErrorPayload {
  if (error instanceof PublicError) {
    return { code: error.code, message: error.message, status: error.status }
  }
  return {
    code: PUBLIC_ERROR_CODES.internal,
    message: 'Internal server error',
    status: 500
  }
}

/** Full detail is for the private server log only. */
export function internalErrorDetail(error: unknown): string {
  if (error instanceof Error) return error.stack || `${error.name}: ${error.message}`
  try {
    return typeof error === 'string' ? error : JSON.stringify(error)
  } catch {
    return String(error)
  }
}
