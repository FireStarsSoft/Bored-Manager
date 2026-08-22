import { randomBytes } from 'crypto'
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { dirname, basename, join } from 'path'

const PRIVATE_FILE_MODE = 0o600
const PRIVATE_DIR_MODE = 0o700

export interface RecoveredJson<T> {
  kind: 'value'
  value: T
  recovered: boolean
}

export interface MissingJson {
  kind: 'missing'
}

export type PrivateJsonRead<T> = RecoveredJson<T> | MissingJson

export type JsonParser<T> = (value: unknown) => T

export function backupFile(file: string): string {
  return `${file}.bak`
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function chmodQuiet(file: string, mode: number): void {
  try {
    chmodSync(file, mode)
  } catch {
    // Windows and some mounted filesystems do not expose POSIX modes.
  }
}

function ensurePrivateParent(file: string): void {
  const parent = dirname(file)
  mkdirSync(parent, { recursive: true, mode: PRIVATE_DIR_MODE })
  chmodQuiet(parent, PRIVATE_DIR_MODE)
}

function fsyncDirectoryQuiet(file: string): void {
  let fd: number | null = null
  try {
    fd = openSync(dirname(file), 'r')
    fsyncSync(fd)
  } catch {
    // Opening/fsyncing a directory is unsupported on Windows. The file itself
    // was still fsynced before rename, which is the strongest guarantee there.
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // Nothing useful can be done after the durable file rename.
      }
    }
  }
}

function temporaryFile(target: string): string {
  return join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`
  )
}

/**
 * Replace one file without ever exposing a partial payload. The temporary file
 * is exclusive and in the same directory, so rename is atomic on both NTFS and
 * normal Linux filesystems.
 */
function replacePrivateFile(target: string, data: string | Buffer): void {
  ensurePrivateParent(target)
  let temp = ''
  let fd: number | null = null
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      temp = temporaryFile(target)
      try {
        fd = openSync(temp, 'wx', PRIVATE_FILE_MODE)
        break
      } catch (error) {
        if (errorCode(error) !== 'EEXIST' || attempt === 9) throw error
      }
    }
    if (fd === null) throw new Error(`could not create a temporary file for "${target}"`)

    writeFileSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(temp, target)
    temp = ''
    chmodQuiet(target, PRIVATE_FILE_MODE)
    fsyncDirectoryQuiet(target)
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // The original write error is the useful one.
      }
    }
    if (temp) {
      try {
        rmSync(temp, { force: true })
      } catch {
        // Cleanup is best-effort; never hide the write failure.
      }
    }
  }
}

/**
 * Durably replace a private file and its last-known-good recovery copy.
 * Writing the backup first means a first-run write can still be recovered if
 * the process or filesystem fails before the primary rename.
 */
export function writeAtomicPrivateFile(
  file: string,
  data: string | Buffer,
  options: { backup?: boolean } = {}
): void {
  if (options.backup !== false) replacePrivateFile(backupFile(file), data)
  replacePrivateFile(file, data)
}

export function writeAtomicPrivateJson(file: string, value: unknown): void {
  const text = JSON.stringify(value, null, 2)
  if (text === undefined) throw new Error(`cannot serialize JSON for "${file}"`)
  writeAtomicPrivateFile(file, text)
}

type Candidate<T> =
  | { kind: 'missing' }
  | { kind: 'invalid'; problem: string }
  | { kind: 'value'; value: T; text: string }

function readCandidate<T>(file: string, parse: JsonParser<T>): Candidate<T> {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { kind: 'missing' }
    return { kind: 'invalid', problem: `unreadable (${errorMessage(error)})` }
  }

  try {
    return { kind: 'value', value: parse(JSON.parse(text) as unknown), text }
  } catch (error) {
    return { kind: 'invalid', problem: `invalid (${errorMessage(error)})` }
  }
}

function candidateProblem(candidate: Candidate<unknown>): string {
  if (candidate.kind === 'missing') return 'missing'
  if (candidate.kind === 'invalid') return candidate.problem
  return 'valid'
}

/**
 * Read and validate a JSON file, falling back only to a valid backup. Missing
 * is returned distinctly; malformed and unreadable state never turns into a
 * caller-provided permissive default.
 */
export function readPrivateJson<T>(
  file: string,
  parse: JsonParser<T>,
  label = 'JSON file'
): PrivateJsonRead<T> {
  const primary = readCandidate(file, parse)
  if (primary.kind === 'value') {
    return { kind: 'value', value: primary.value, recovered: false }
  }

  const recovery = readCandidate(backupFile(file), parse)
  if (recovery.kind === 'value') {
    try {
      replacePrivateFile(file, recovery.text)
    } catch {
      // The validated backup is still safe to use. A later successful write
      // will replace both copies, while a read-only install remains fail-safe.
    }
    return { kind: 'value', value: recovery.value, recovered: true }
  }

  if (primary.kind === 'missing' && recovery.kind === 'missing') return { kind: 'missing' }

  throw new Error(
    `Cannot load ${label} "${file}": primary is ${candidateProblem(primary)}; ` +
      `backup is ${candidateProblem(recovery)}`
  )
}
