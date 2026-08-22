import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RequestHandler } from 'express'

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : undefined
}

export function pidIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to somebody else.
    return codeOf(error) === 'EPERM'
  }
}

export interface PidFileLease {
  readonly path: string
  readonly pid: number
  release(): void
}

/**
 * Claim a PID file with O_EXCL semantics. A live owner's file is never
 * overwritten, while a demonstrably stale/invalid file is reclaimed.
 */
export function acquirePidFile(
  path: string,
  pid = process.pid,
  isAlive: (candidate: number) => boolean = pidIsAlive
): PidFileLease {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('cannot write an invalid process id')
  mkdirSync(dirname(path), { recursive: true })

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      writeFileSync(path, String(pid), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      let released = false
      return {
        path,
        pid,
        release: () => {
          if (released) return
          released = true
          try {
            if (readFileSync(path, 'utf8').trim() === String(pid)) unlinkSync(path)
          } catch {
            // A status file must never make shutdown fail.
          }
        }
      }
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') throw error
    }

    let owner = Number.NaN
    try {
      const raw = readFileSync(path, 'utf8').trim()
      owner = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
    } catch (error) {
      if (codeOf(error) === 'ENOENT') continue
      throw error
    }
    if (Number.isSafeInteger(owner) && owner > 0 && isAlive(owner)) {
      throw new Error(`Bored Manager is already running (pid ${owner})`)
    }
    try {
      unlinkSync(path)
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') throw error
    }
  }
  throw new Error('could not acquire the server PID file')
}

/** Tracks HTTP work so shutdown can reject new requests and drain old ones. */
export class RequestTracker {
  private accepting = true
  private active = 0
  private readonly waiters = new Set<() => void>()

  readonly middleware: RequestHandler = (_req, res, next) => {
    if (!this.accepting) {
      res.status(503).json({
        ok: false,
        code: 'SERVER_SHUTTING_DOWN',
        error: 'Server is shutting down'
      })
      return
    }

    this.active++
    let finished = false
    const finish = (): void => {
      if (finished) return
      finished = true
      this.active--
      if (this.active === 0) {
        for (const resolve of this.waiters) resolve()
        this.waiters.clear()
      }
    }
    res.once('finish', finish)
    res.once('close', finish)
    next()
  }

  stopAccepting(): void {
    this.accepting = false
  }

  get activeRequests(): number {
    return this.active
  }

  drain(): Promise<void> {
    if (this.active === 0) return Promise.resolve()
    return new Promise((resolve) => this.waiters.add(resolve))
  }
}

/** Resolve false at the deadline instead of leaving shutdown hung forever. */
export async function withinDeadline(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work.then(
        () => true,
        () => false
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
        timer.unref?.()
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
