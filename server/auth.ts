import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import type { Request, RequestHandler, Router } from 'express'
import {
  DEFAULT_USERNAME,
  type AppSettings,
  type AuthStatus,
  type SessionIdle
} from '@shared/types'
import { log } from './log'
import { dataDir, writePrivateJson } from './services/store'
import { recordLogin, verify } from './services/users'

declare module 'express-session' {
  interface SessionData {
    /** Set on a successful login; absent means "not logged in". */
    username?: string
  }
}

/**
 * Logging in, and the lockout that makes a weak password survivable.
 *
 * Failures are counted per username and per client address, not across the
 * whole WebUI: one person guessing at one account must not lock everyone
 * else out. Once either counter reaches the limit, that account or that
 * address is refused until `./bored-manager unlock` is run on the host.
 *
 * The file is read on every attempt, so an unlock takes effect immediately
 * and no restart is needed.
 */

interface LockEntry {
  failures: number
  lockedAt: number | null
}

interface LockFile {
  version: 2
  users: Record<string, LockEntry>
  ips: Record<string, LockEntry>
}

/** The idle timeout in milliseconds; 0 means the session never expires. */
export function idleMs(idle: SessionIdle): number {
  if (idle.value <= 0) return 0
  const unit = idle.unit === 'minute' ? 60_000 : idle.unit === 'day' ? 86_400_000 : 3_600_000
  return idle.value * unit
}

const EMPTY_ENTRY: LockEntry = { failures: 0, lockedAt: null }
const EMPTY: LockFile = { version: 2, users: {}, ips: {} }

function lockFile(): string {
  return join(dataDir(), 'auth-lock.json')
}

function parseEntry(raw: unknown): LockEntry {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_ENTRY }
  const e = raw as Partial<LockEntry>
  return {
    failures: typeof e.failures === 'number' && e.failures > 0 ? Math.trunc(e.failures) : 0,
    lockedAt: typeof e.lockedAt === 'number' ? e.lockedAt : null
  }
}

function parseMap(raw: unknown): Record<string, LockEntry> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, LockEntry> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key) continue
    out[key] = parseEntry(value)
  }
  return out
}

export function readLock(): LockFile {
  try {
    if (!existsSync(lockFile())) return { version: 2, users: {}, ips: {} }
    const raw = JSON.parse(readFileSync(lockFile(), 'utf8')) as Partial<LockFile> & {
      failures?: number
      lockedAt?: number | null
    }
    // v1 was a single global counter. A leftover file is dropped rather than
    // turning every address into a lockout on the first start of this build.
    if (raw.version !== 2) return { version: 2, users: {}, ips: {} }
    return { version: 2, users: parseMap(raw.users), ips: parseMap(raw.ips) }
  } catch {
    return { version: 2, users: {}, ips: {} }
  }
}

function writeLock(value: LockFile): void {
  try {
    mkdirSync(dataDir(), { recursive: true })
    writePrivateJson(lockFile(), value)
  } catch {
    /* a read-only data folder must not make logging in impossible */
  }
}

function entryLocked(entry: LockEntry | undefined, max: number): boolean {
  if (!entry) return false
  return entry.lockedAt !== null || entry.failures >= max
}

function clientAddress(req: Request): string {
  const raw = req.socket.remoteAddress ?? ''
  return raw.startsWith('::ffff:') ? raw.slice('::ffff:'.length) : raw || 'unknown'
}

export function isLocked(
  settings: AppSettings,
  who: { username?: string; ip?: string }
): boolean {
  const lock = readLock()
  const max = settings.auth.maxFailures
  if (who.username && entryLocked(lock.users[who.username], max)) return true
  if (who.ip && entryLocked(lock.ips[who.ip], max)) return true
  return false
}

/** Clears every counter. Used by the `unlock` subcommand. */
export function unlock(): void {
  writeLock({ ...EMPTY })
}

/**
 * Who a request acts as. With auth off there is nothing to log in to, so
 * everything happens as the default account - the same one whose folder holds
 * the saved connections in that case.
 */
export function usernameOf(session: { username?: string } | undefined, enabled: boolean): string {
  if (!enabled) return DEFAULT_USERNAME
  return session?.username ?? DEFAULT_USERNAME
}

export function authStatus(
  settings: AppSettings,
  session: { username?: string } | undefined,
  ip?: string
): AuthStatus {
  const enabled = settings.auth.enabled
  return {
    authEnabled: enabled,
    // Strictly "is there a session": with no login required there is nothing to
    // log into, and the UI only looks at this when authEnabled is true.
    authenticated: !!session?.username,
    username: session?.username ?? (enabled ? null : DEFAULT_USERNAME),
    locked: isLocked(settings, { username: session?.username, ip })
  }
}

/**
 * Mounts /api/auth/*. `settings()` is read on every call because Require login
 * can be switched while the server runs.
 */
export function registerAuthRoutes(api: Router, settings: () => AppSettings): void {
  api.post('/auth/login', async (req, res) => {
    const current = settings()
    const body = (req.body ?? {}) as { username?: string; password?: string }
    const username = typeof body.username === 'string' ? body.username.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    const ip = clientAddress(req)

    if (!current.auth.enabled) {
      // Nothing to log in to; say so rather than pretending it worked.
      res.status(400).json({ ok: false, error: 'login is not required on this server' })
      return
    }
    const max = current.auth.maxFailures
    if (isLocked(current, { username, ip })) {
      res.status(423).json({ ok: false, locked: true })
      return
    }
    if (!username || !password || !(await verify(username, password))) {
      const lock = readLock()
      const userEntry = lock.users[username] ?? { ...EMPTY_ENTRY }
      const ipEntry = lock.ips[ip] ?? { ...EMPTY_ENTRY }
      userEntry.failures += 1
      ipEntry.failures += 1
      const userLocked = userEntry.failures >= max
      const ipLocked = ipEntry.failures >= max
      if (userLocked) userEntry.lockedAt = Date.now()
      if (ipLocked) ipEntry.lockedAt = Date.now()
      if (username) lock.users[username] = userEntry
      lock.ips[ip] = ipEntry
      writeLock(lock)
      const failures = Math.max(userEntry.failures, ipEntry.failures)
      const locked = userLocked || ipLocked
      log(
        `failed login for "${username || '(no username)'}" from ${ip} - ` +
          `${failures}/${max} attempts` +
          (locked ? ', that username or address is now locked' : '')
      )
      res
        .status(locked ? 423 : 401)
        .json({ ok: false, locked, remaining: Math.max(0, max - failures) })
      return
    }

    const lock = readLock()
    if (username) delete lock.users[username]
    delete lock.ips[ip]
    writeLock(lock)
    recordLogin(username)
    req.session.regenerate((err) => {
      if (err) {
        res.status(500).json({ ok: false, error: String(err) })
        return
      }
      req.session.username = username
      // The idle timeout is applied when the session is created, so changing it
      // takes effect on the next login instead of needing a restart. The store
      // reads originalMaxAge, the browser reads maxAge - both have to be set.
      const ms = idleMs(current.auth.sessionIdle)
      req.session.cookie.maxAge = ms || undefined
      req.session.cookie.originalMaxAge = ms || null
      log(`"${username}" logged in`)
      res.json({ ok: true, username })
    })
  })

  api.post('/auth/logout', (req, res) => {
    const who = req.session.username
    req.session.destroy(() => {
      res.clearCookie('bm.sid')
      if (who) log(`"${who}" logged out`)
      res.json({ ok: true })
    })
  })

  api.get('/auth/status', (req, res) => {
    res.json(authStatus(settings(), req.session, clientAddress(req)))
  })
}

/**
 * Guards /api/* while auth is on. The auth routes themselves stay open (that
 * is where logging in happens) and so do the static files, so a browser can
 * always load the app far enough to show the login form.
 */
export function requireSession(settings: () => AppSettings): RequestHandler {
  return (req, res, next) => {
    if (!settings().auth.enabled) {
      next()
      return
    }
    if (req.path.startsWith('/auth/')) {
      next()
      return
    }
    if (req.session?.username) {
      next()
      return
    }
    res.status(401).json({ ok: false, error: 'not logged in' })
  }
}
