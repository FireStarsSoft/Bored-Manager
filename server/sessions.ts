import { readdir } from 'fs/promises'
import type { SessionData, Store as SessionStore } from 'express-session'

const MAX_REVOKED_IDS = 10_000

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : undefined
}

function getFromStore(store: SessionStore, sid: string): Promise<SessionData | null> {
  return new Promise((resolve, reject) => {
    store.get(sid, (error, value) => {
      if (error) reject(error)
      else resolve(value ?? null)
    })
  })
}

function destroyInStore(store: SessionStore, sid: string): Promise<void> {
  return new Promise((resolve, reject) => {
    store.destroy(sid, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

/**
 * Session-store operations needed by HTTP auth and WebSocket authorization.
 * The revocation set closes the small window between a logout/revocation
 * request and the backing file actually being removed.
 */
export class SessionController {
  private readonly revoked = new Set<string>()

  constructor(
    readonly store: SessionStore,
    private readonly sessionsDir?: string
  ) {}

  async get(sid: string): Promise<SessionData | null> {
    if (!sid || this.revoked.has(sid)) return null
    return getFromStore(this.store, sid)
  }

  async touch(sid: string, data: SessionData): Promise<boolean> {
    if (!sid || this.revoked.has(sid) || !this.store.touch) return false
    return new Promise((resolve) => {
      const touch = this.store.touch as (
        id: string,
        session: SessionData,
        callback: (error?: unknown) => void
      ) => void
      touch.call(this.store, sid, data, (error?: unknown) => resolve(!error))
    })
  }

  async revokeSession(sid: string): Promise<void> {
    if (!sid) return
    this.rememberRevoked(sid)
    await destroyInStore(this.store, sid)
  }

  async revokeUsername(username: string): Promise<void> {
    const entries = await this.entries()
    const failures: unknown[] = []
    for (const [sid, existing] of entries) {
      let data = existing
      if (!data) {
        try {
          data = await getFromStore(this.store, sid)
        } catch (error) {
          // An unreadable session cannot safely be attributed, so revoke it.
          this.rememberRevoked(sid)
          try {
            await destroyInStore(this.store, sid)
          } catch (destroyError) {
            failures.push(destroyError)
          }
          continue
        }
      }
      if (data?.username !== username) continue
      this.rememberRevoked(sid)
      try {
        await destroyInStore(this.store, sid)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, `Could not revoke every session for "${username}"`)
    }
  }

  private rememberRevoked(sid: string): void {
    this.revoked.add(sid)
    while (this.revoked.size > MAX_REVOKED_IDS) {
      const oldest = this.revoked.values().next()
      if (oldest.done) break
      this.revoked.delete(oldest.value)
    }
  }

  private async entries(): Promise<Array<[string, SessionData | null]>> {
    if (this.sessionsDir) {
      let names: string[]
      try {
        names = await readdir(this.sessionsDir)
      } catch (error) {
        if (codeOf(error) === 'ENOENT') return []
        throw error
      }
      return names
        .filter((name) => name.endsWith('.json') && name.length > '.json'.length)
        .map((name) => [name.slice(0, -'.json'.length), null])
    }

    if (!this.store.all) {
      throw new Error('The configured session store cannot enumerate sessions for revocation')
    }
    const all = await new Promise<SessionData[] | Record<string, SessionData> | null>(
      (resolve, reject) => {
        this.store.all!((error, value) => {
          if (error) reject(error)
          else resolve(value ?? null)
        })
      }
    )
    if (!all) return []
    if (Array.isArray(all)) {
      throw new Error('The configured session store returned sessions without their ids')
    }
    return Object.entries(all)
  }
}
