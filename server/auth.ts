import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { RequestHandler, Router } from 'express'
import {
  DEFAULT_USERNAME,
  type AppSettings,
  type AuthStatus,
  type SessionIdle
} from '@shared/types'
import { log } from './log'
import { dataDir } from './services/store'
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
 * The failure counter is global, not per user or per IP: this is one WebUI on
 * a home network, and someone guessing passwords from six devices is the same
 * attacker. Once the counter reaches the limit every login is refused until
 * `./bored-manager unlock` is run in a terminal on the host - proof that the
 * person unlocking it has access to the machine itself.
 *
 * The file is read on every attempt, so an unlock takes effect immediately and
 * no restart is needed.
 */

interface LockFile {
  failures: number
  lockedAt: number | null
}

/** The idle timeout in milliseconds; 0 means the session never expires. */
export function idleMs(idle: SessionIdle): number {
  if (idle.value <= 0) return 0
  const unit = idle.unit === 'minute' ? 60_000 : idle.unit === 'day' ? 86_400_000 : 3_600_000
  return idle.value * unit
}

const EMPTY: LockFile = { failures: 0, lockedAt: null }

function lockFile(): string {
  return join(dataDir(), 'auth-lock.json')
}

export function readLock(): LockFile {
  try {
    if (!existsSync(lockFile())) return { ...EMPTY }
    const raw = JSON.parse(readFileSync(lockFile(), 'utf8')) as Partial<LockFile>
    return {
      failures: typeof raw.failures === 'number' && raw.failures > 0 ? Math.trunc(raw.failures) : 0,
      lockedAt: typeof raw.lockedAt === 'number' ? raw.lockedAt : null
    }
  } catch {
    return { ...EMPTY }
  }
}

function writeLock(value: LockFile): void {
  try {
    mkdirSync(dataDir(), { recursive: true })
    writeFileSync(lockFile(), JSON.stringify(value, null, 2), 'utf8')
  } catch {
    /* a read-only data folder must not make logging in impossible */
  }
}

export function isLocked(settings: AppSettings): boolean {
  const lock = readLock()
  return lock.lockedAt !== null || lock.failures >= settings.auth.maxFailures
}

/** Clears the counter. Used by the `unlock` subcommand. */
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
  session: { username?: string } | undefined
): AuthStatus {
  const enabled = settings.auth.enabled
  return {
    authEnabled: enabled,
    // Strictly "is there a session": with no login required there is nothing to
    // log into, and the UI only looks at this when authEnabled is true.
    authenticated: !!session?.username,
    username: session?.username ?? (enabled ? null : DEFAULT_USERNAME),
    locked: isLocked(settings)
  }
}

/**
 * Mounts /api/auth/*. `settings()` is read on every call because Require login
 * can be switched while the server runs.
 */
export function registerAuthRoutes(api: Router, settings: () => AppSettings): void {
  api.post('/auth/login', (req, res) => {
    const current = settings()
    const body = (req.body ?? {}) as { username?: string; password?: string }
    const username = typeof body.username === 'string' ? body.username.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''

    if (!current.auth.enabled) {
      // Nothing to log in to; say so rather than pretending it worked.
      res.status(400).json({ ok: false, error: 'login is not required on this server' })
      return
    }
    const lock = readLock()
    const max = current.auth.maxFailures
    if (lock.lockedAt !== null || lock.failures >= max) {
      res.status(423).json({ ok: false, locked: true })
      return
    }
    if (!username || !password || !verify(username, password)) {
      const failures = lock.failures + 1
      const locked = failures >= max
      writeLock({ failures, lockedAt: locked ? Date.now() : null })
      log(
        `failed login for "${username || '(no username)'}" - ${failures}/${max} attempts` +
          (locked ? ', the WebUI is now locked' : '')
      )
      res
        .status(locked ? 423 : 401)
        .json({ ok: false, locked, remaining: Math.max(0, max - failures) })
      return
    }

    writeLock({ ...EMPTY })
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
    res.json(authStatus(settings(), req.session))
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
