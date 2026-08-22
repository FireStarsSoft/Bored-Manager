import { join } from 'path'
import type { Request, RequestHandler, Router } from 'express'
import {
  DEFAULT_USERNAME,
  USERNAME_PATTERN,
  type AppSettings,
  type AuthStatus,
  type SessionIdle
} from '@shared/types'
import { isFiniteNumber, isRecord } from '@shared/validation'
import { log } from './log'
import { dataDir } from './services/store'
import {
  MAX_PASSWORD_LENGTH,
  recordLogin,
  sessionIsCurrent,
  verifyForSession
} from './services/users'
import { readPrivateJson, writeAtomicPrivateJson } from './services/private-file'

declare module 'express-session' {
  interface SessionData {
    /** Set on a successful login; absent means "not logged in". */
    username?: string
    /** Must match the account's current value; password changes increment it. */
    authVersion?: number
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
  updatedAt: number
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

const EMPTY_ENTRY: LockEntry = { failures: 0, lockedAt: null, updatedAt: 0 }
const MAX_LOCK_ENTRIES = 2048

function emptyMap(): Record<string, LockEntry> {
  return Object.create(null) as Record<string, LockEntry>
}

function emptyLock(): LockFile {
  return { version: 2, users: emptyMap(), ips: emptyMap() }
}

function mapEntry(map: Record<string, LockEntry>, key: string): LockEntry | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined
}

function lockFile(): string {
  return join(dataDir(), 'auth-lock.json')
}

function parseEntry(raw: unknown, label: string): LockEntry {
  if (!isRecord(raw)) throw new Error(`${label} must be an object`)
  const failures = raw['failures']
  const lockedAt = raw['lockedAt']
  const updatedAt = raw['updatedAt']
  if (
    !isFiniteNumber(failures) ||
    !Number.isSafeInteger(failures) ||
    failures < 0 ||
    failures > 1_000_000
  ) {
    throw new Error(`${label}.failures is invalid`)
  }
  if (lockedAt !== null && (!isFiniteNumber(lockedAt) || lockedAt < 0)) {
    throw new Error(`${label}.lockedAt is invalid`)
  }
  if (updatedAt !== undefined && (!isFiniteNumber(updatedAt) || updatedAt < 0)) {
    throw new Error(`${label}.updatedAt is invalid`)
  }
  return { failures, lockedAt, updatedAt: updatedAt ?? lockedAt ?? 0 }
}

function parseMap(
  raw: unknown,
  label: string,
  validKey: (key: string) => boolean
): Record<string, LockEntry> {
  if (!isRecord(raw)) throw new Error(`${label} must be an object`)
  const out = emptyMap()
  for (const [key, value] of Object.entries(raw)) {
    if (!validKey(key)) throw new Error(`${label} contains an invalid key`)
    out[key] = parseEntry(value, `${label}.${key}`)
  }
  return out
}

function lockDocument(value: unknown): LockFile {
  if (!isRecord(value) || value['version'] !== 2) {
    throw new Error('auth lock file must have version 2')
  }
  return {
    version: 2,
    users: parseMap(value['users'], 'users', (key) => USERNAME_PATTERN.test(key)),
    ips: parseMap(
      value['ips'],
      'ips',
      (key) => key === 'unknown' || (key.length <= 128 && /^[0-9a-f:.%]+$/i.test(key))
    )
  }
}

export function readLock(): LockFile {
  const result = readPrivateJson(lockFile(), lockDocument, 'auth lock')
  return result.kind === 'missing' ? emptyLock() : result.value
}

function cappedMap(source: Record<string, LockEntry>): Record<string, LockEntry> {
  const entries = Object.entries(source)
  if (entries.length <= MAX_LOCK_ENTRIES) return source
  entries.sort(([, left], [, right]) => {
    const leftLocked = left.lockedAt !== null ? 1 : 0
    const rightLocked = right.lockedAt !== null ? 1 : 0
    return rightLocked - leftLocked || right.updatedAt - left.updatedAt
  })
  return Object.fromEntries(entries.slice(0, MAX_LOCK_ENTRIES))
}

function writeLock(value: LockFile): void {
  writeAtomicPrivateJson(lockFile(), {
    version: 2,
    users: cappedMap(value.users),
    ips: cappedMap(value.ips)
  } satisfies LockFile)
}

function newEntry(): LockEntry {
  return { ...EMPTY_ENTRY, updatedAt: Date.now() }
}

export function clientAddress(req: Request, trustProxy = false): string {
  const raw = (trustProxy ? req.ip : req.socket.remoteAddress) ?? ''
  const normalized = raw.startsWith('::ffff:') ? raw.slice('::ffff:'.length) : raw
  if (
    normalized.length === 0 ||
    normalized.length > 128 ||
    !/^[0-9a-f:.%]+$/i.test(normalized)
  ) {
    return 'unknown'
  }
  return normalized
}

function entryLocked(entry: LockEntry | undefined, max: number): boolean {
  if (!entry) return false
  return entry.lockedAt !== null || entry.failures >= max
}

export function isLocked(
  settings: AppSettings,
  who: { username?: string; ip?: string }
): boolean {
  const lock = readLock()
  const max = settings.auth.maxFailures
  if (who.username && entryLocked(mapEntry(lock.users, who.username), max)) return true
  if (who.ip && entryLocked(mapEntry(lock.ips, who.ip), max)) return true
  return false
}

/** Clears every counter. Used by the `unlock` subcommand. */
export function unlock(): void {
  writeLock(emptyLock())
}

export function loginInputProblem(username: string, password: string): string | null {
  if (!USERNAME_PATTERN.test(username)) return 'invalid username or password'
  if (password.length === 0) return 'invalid username or password'
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `password must be at most ${MAX_PASSWORD_LENGTH} characters`
  }
  return null
}

export type LoginAttempt =
  | { kind: 'malformed'; error: string }
  | { kind: 'locked' }
  | { kind: 'invalid'; failures: number; remaining: number; locked: boolean }
  | { kind: 'success'; authVersion: number }

let loginTail: Promise<void> = Promise.resolve()

function serializeLogin<T>(operation: () => T | Promise<T>): Promise<T> {
  const result = loginTail.then(operation, operation)
  loginTail = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

/** Test seam; callers must wait for prior attempts before resetting it. */
export function resetLoginQueueForTests(): void {
  loginTail = Promise.resolve()
}

/**
 * One complete check/verify/update transaction. Scrypt runs inside the queue
 * so parallel failures cannot all observe the same stale counter.
 */
export function attemptLogin(
  settings: AppSettings,
  username: string,
  password: string,
  ip: string
): Promise<LoginAttempt> {
  const malformed = loginInputProblem(username, password)
  if (malformed) return Promise.resolve({ kind: 'malformed', error: malformed })
  if (ip !== 'unknown' && (ip.length > 128 || !/^[0-9a-f:.%]+$/i.test(ip))) {
    return Promise.resolve({ kind: 'malformed', error: 'invalid client address' })
  }

  return serializeLogin(async () => {
    const max = settings.auth.maxFailures
    let lock = readLock()
    if (
      entryLocked(mapEntry(lock.users, username), max) ||
      entryLocked(mapEntry(lock.ips, ip), max)
    ) {
      return { kind: 'locked' }
    }

    let authVersion = await verifyForSession(username, password)

    // Re-read after the intentionally expensive verification. This catches a
    // lock written by another process and is also the fail-closed boundary for
    // an unlock/corruption race.
    lock = readLock()
    if (
      entryLocked(mapEntry(lock.users, username), max) ||
      entryLocked(mapEntry(lock.ips, ip), max)
    ) {
      return { kind: 'locked' }
    }

    if (authVersion !== null && (await recordLogin(username, authVersion))) {
      delete lock.users[username]
      delete lock.ips[ip]
      writeLock(lock)
      return { kind: 'success', authVersion }
    }
    authVersion = null

    const now = Date.now()
    const userEntry = mapEntry(lock.users, username) ?? newEntry()
    const ipEntry = mapEntry(lock.ips, ip) ?? newEntry()
    userEntry.failures += 1
    ipEntry.failures += 1
    userEntry.updatedAt = now
    ipEntry.updatedAt = now
    const userLocked = userEntry.failures >= max
    const ipLocked = ipEntry.failures >= max
    if (userLocked) userEntry.lockedAt = now
    if (ipLocked) ipEntry.lockedAt = now
    lock.users[username] = userEntry
    lock.ips[ip] = ipEntry
    writeLock(lock)

    const failures = Math.max(userEntry.failures, ipEntry.failures)
    return {
      kind: 'invalid',
      failures,
      remaining: Math.max(0, max - failures),
      locked: userLocked || ipLocked
    }
  })
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

export function isAuthenticatedSession(
  session:
    | { username?: string | null; authVersion?: number | null }
    | undefined
): boolean {
  return !!session?.username && sessionIsCurrent(session.username, session.authVersion)
}

export function authStatus(
  settings: AppSettings,
  session: { username?: string; authVersion?: number } | undefined,
  ip?: string
): AuthStatus {
  const enabled = settings.auth.enabled
  const authenticated = isAuthenticatedSession(session)
  return {
    authEnabled: enabled,
    authenticated,
    username: authenticated ? session!.username! : enabled ? null : DEFAULT_USERNAME,
    locked: isLocked(settings, { username: session?.username, ip })
  }
}

export interface AuthRouteHooks {
  /** Close sockets carrying a session that just logged out or went stale. */
  closeSession?(sid: string, username?: string): void
}

/**
 * Mounts /api/auth/*. `settings()` is read on every call because Require login
 * can be switched while the server runs.
 */
export function registerAuthRoutes(
  api: Router,
  settings: () => AppSettings,
  hooks: AuthRouteHooks = {}
): void {
  api.post('/auth/login', async (req, res, next) => {
    const current = settings()
    if (!req.is('application/json')) {
      res.status(415).json({
        ok: false,
        code: 'UNSUPPORTED_MEDIA_TYPE',
        error: 'Login requires application/json'
      })
      return
    }
    if (!current.auth.enabled) {
      // Nothing to log in to; say so rather than pretending it worked.
      res.status(400).json({ ok: false, error: 'login is not required on this server' })
      return
    }

    const body = isRecord(req.body) ? req.body : {}
    if (typeof body['username'] !== 'string' || typeof body['password'] !== 'string') {
      res.status(400).json({ ok: false, error: 'invalid username or password' })
      return
    }
    const username = body['username'].trim()
    const password = body['password']
    const problem = loginInputProblem(username, password)
    if (problem) {
      res.status(400).json({ ok: false, error: problem })
      return
    }
    const ip = clientAddress(req, current.server.trustProxy)
    const attempt = await attemptLogin(current, username, password, ip)

    if (attempt.kind === 'malformed') {
      res.status(400).json({ ok: false, error: attempt.error })
      return
    }
    if (attempt.kind === 'locked') {
      res.status(423).json({ ok: false, locked: true })
      return
    }
    if (attempt.kind === 'invalid') {
      log(
        `failed login for "${username}" from ${ip} - ` +
          `${attempt.failures}/${current.auth.maxFailures} attempts` +
          (attempt.locked ? ', that username or address is now locked' : '')
      )
      res
        .status(attempt.locked ? 423 : 401)
        .json({ ok: false, locked: attempt.locked, remaining: attempt.remaining })
      return
    }

    req.session.regenerate((err) => {
      if (err) {
        next(err)
        return
      }
      req.session.username = username
      req.session.authVersion = attempt.authVersion
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

  api.post('/auth/logout', (req, res, next) => {
    const who = req.session.username
    const sid = req.sessionID
    hooks.closeSession?.(sid, who)
    req.session.destroy((error) => {
      if (error) {
        next(error)
        return
      }
      res.clearCookie('bm.sid')
      if (who) log(`"${who}" logged out`)
      res.json({ ok: true })
    })
  })

  api.get('/auth/status', (req, res) => {
    const current = settings()
    const status = authStatus(
      current,
      req.session,
      clientAddress(req, current.server.trustProxy)
    )
    if (current.auth.enabled && req.session.username && !status.authenticated) {
      hooks.closeSession?.(req.sessionID, req.session.username)
      req.session.destroy(() => {})
    }
    res.json(status)
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
    if (isAuthenticatedSession(req.session)) {
      next()
      return
    }
    if (req.session?.username) req.session.destroy(() => {})
    res.status(401).json({ ok: false, error: 'not logged in' })
  }
}
