import type { IncomingMessage } from 'node:http'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import type { RequestHandler } from 'express'
import { normalizeAllowedHostname } from '@shared/app-settings'
import { isOpenBind, type ServerSettings } from '@shared/types'

export interface RequestSecurity {
  allowedHosts: ReadonlySet<string>
  devMode?: boolean
}

interface Authority {
  hostname: string
  port: string
}

function parseAuthority(raw: string | undefined, protocol = 'http:'): Authority | null {
  if (!raw || raw.length > 512 || /[\s/@?#\\]/.test(raw)) return null
  try {
    const parsed = new URL(`${protocol}//${raw}`)
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      return null
    }
    const hostname = normalizeAllowedHostname(parsed.hostname)
    return hostname ? { hostname, port: parsed.port } : null
  } catch {
    return null
  }
}

export function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

/**
 * Hostnames accepted by this server run. Settings changes intentionally do
 * not alter this set until restart, matching the listen address itself.
 */
export function deriveAllowedHostnames(
  settings: ServerSettings,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()
): Set<string> {
  const allowed = new Set<string>(['localhost', '127.0.0.1', '::1'])
  const add = (value: unknown): void => {
    const hostname = normalizeAllowedHostname(value)
    if (hostname) allowed.add(hostname)
  }

  if (!isOpenBind(settings.host)) add(settings.host)
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) add(entry.address)
  }
  for (const hostname of settings.allowedHosts) add(hostname)
  return allowed
}

export function requestHostname(
  request: Pick<IncomingMessage, 'headers'>,
  allowedHosts: ReadonlySet<string>
): string | null {
  const authority = parseAuthority(request.headers.host)
  return authority && allowedHosts.has(authority.hostname) ? authority.hostname : null
}

export function requestHostAllowed(
  request: Pick<IncomingMessage, 'headers'>,
  allowedHosts: ReadonlySet<string>
): boolean {
  return requestHostname(request, allowedHosts) !== null
}

/**
 * Browsers must name this exact allowed authority in Origin. Vite's local
 * development proxy is the sole exception: it changes the port while both
 * sides remain loopback-only.
 */
export function requestOriginAllowed(
  request: Pick<IncomingMessage, 'headers'>,
  security: RequestSecurity
): boolean {
  const requestHost = parseAuthority(request.headers.host)
  if (!requestHost || !security.allowedHosts.has(requestHost.hostname)) return false

  const origin = request.headers.origin
  if (!origin) return request.headers['sec-fetch-site'] !== 'cross-site'
  if (typeof origin !== 'string' || origin.length > 2048) return false

  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    return false
  }

  const originHost = normalizeAllowedHostname(parsed.hostname)
  if (!originHost || !security.allowedHosts.has(originHost)) return false
  const requestForOrigin = parseAuthority(request.headers.host, parsed.protocol)
  if (!requestForOrigin) return false
  if (originHost === requestForOrigin.hostname && parsed.port === requestForOrigin.port) return true

  return (
    security.devMode === true &&
    isLoopbackHostname(originHost) &&
    isLoopbackHostname(requestForOrigin.hostname)
  )
}

export function requireAllowedHost(security: RequestSecurity): RequestHandler {
  return (req, res, next) => {
    if (requestHostAllowed(req, security.allowedHosts)) {
      next()
      return
    }
    res.status(421).json({
      ok: false,
      code: 'INVALID_HOST',
      error: 'Request host is not allowed'
    })
  }
}

/** CSRF boundary for every state-changing HTTP API call. */
export function requireSameOriginApi(security: RequestSecurity): RequestHandler {
  return (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      next()
      return
    }
    if (!requestOriginAllowed(req, security)) {
      res.status(403).json({
        ok: false,
        code: 'CSRF_REJECTED',
        error: 'Cross-origin request rejected'
      })
      return
    }
    if (req.path === '/auth/login') {
      const mediaType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') {
        res.status(415).json({
          ok: false,
          code: 'UNSUPPORTED_MEDIA_TYPE',
          error: 'Login requires application/json'
        })
        return
      }
    }
    next()
  }
}

/** Only a reverse proxy connected over loopback is trusted. */
export function expressTrustProxySetting(enabled: boolean): false | 'loopback' {
  return enabled ? 'loopback' : false
}
