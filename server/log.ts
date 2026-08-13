import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync, writeSync } from 'fs'
import { join } from 'path'
import { dataDir } from './services/store'

/**
 * The one log every part of the server writes to (data/app.log), plus stderr so
 * the same lines show up in `journalctl --user -u bored-manager` and in the
 * terminal when the server is started by hand.
 *
 * appendFileSync/writeSync are deliberate: a line that was logged has been
 * written, even if the process dies in the next moment.
 */

const MAX_BYTES = 512_000

let file: string | null = null

function logFile(): string {
  if (file) return file
  file = join(dataDir(), 'app.log')
  return file
}

/** Called once at startup: rotate an oversized log and mark the new run. */
export function startLogSession(): void {
  try {
    mkdirSync(dataDir(), { recursive: true })
    if (existsSync(logFile()) && statSync(logFile()).size > MAX_BYTES) {
      writeFileSync(logFile(), '')
    }
    appendFileSync(
      logFile(),
      `\n----- run pid=${process.pid} ${new Date().toISOString()} -----\n`
    )
  } catch {
    /* logging must never break the app */
  }
}

export function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`
  try {
    writeSync(2, line)
  } catch {
    /* stderr may be closed */
  }
  try {
    appendFileSync(logFile(), line)
  } catch {
    /* ignore */
  }
}
