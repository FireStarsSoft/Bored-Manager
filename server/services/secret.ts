import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { dataDir } from './store'

/**
 * The one secret the install owns: 32 random bytes in data/secret.key, created
 * on first boot and never leaving the host. It encrypts the saved SSH passwords
 * and signs the session cookies, which is why losing it only costs the user
 * their saved passwords and their sessions - nothing else is derived from it.
 *
 * This replaces Electron's safeStorage. A server has no desktop keyring to talk
 * to, so the key is a file, protected by its mode (0600) and by living inside
 * the install folder under $HOME.
 */

/** Marks a value this file wrote, so a safeStorage-era string is recognisable. */
const PREFIX = 'enc2:'
const IV_BYTES = 12
const TAG_BYTES = 16

let cached: Buffer | null = null

function keyFile(): string {
  return join(dataDir(), 'secret.key')
}

function fsyncDataDirectoryQuiet(): void {
  let fd: number | null = null
  try {
    fd = openSync(dataDir(), 'r')
    fsyncSync(fd)
  } catch {
    // Directory handles cannot be fsynced on Windows.
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // The key file itself is already durable.
      }
    }
  }
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : undefined
}

function readExistingKey(file: string): Buffer {
  let lastProblem = ''
  // Another process may have won the exclusive create but not finished its
  // 32-byte write yet. Brief retries avoid treating that valid race as
  // corruption; a persistently short or unreadable key still fails closed.
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      const key = readFileSync(file)
      if (key.length === 32) {
        try {
          chmodSync(file, 0o600)
        } catch {
          // Windows and some mounts do not expose POSIX modes.
        }
        return key
      }
      lastProblem = `expected 32 bytes, found ${key.length}`
    } catch (error) {
      lastProblem = error instanceof Error ? error.message : String(error)
      if (codeOf(error) !== 'ENOENT' && codeOf(error) !== 'EBUSY') break
    }
    if (attempt < 24) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
  }
  throw new Error(`Existing secret key "${file}" is malformed or unreadable: ${lastProblem}`)
}

export function ensureSecretKey(): Buffer {
  if (cached) return cached
  const file = keyFile()
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 })
  try {
    chmodSync(dataDir(), 0o700)
  } catch {
    // Windows and some mounts do not expose POSIX modes.
  }

  let fd: number | null = null
  let created = false
  try {
    try {
      fd = openSync(file, 'wx', 0o600)
      created = true
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') throw error
      const existing = readExistingKey(file)
      cached = existing
      return existing
    }

    const key = randomBytes(32)
    writeFileSync(fd, key)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    try {
      chmodSync(file, 0o600)
    } catch {
      // Windows and some mounts do not implement POSIX modes.
    }
    fsyncDataDirectoryQuiet()
    cached = key
    return key
  } catch (error) {
    if (created) {
      try {
        rmSync(file, { force: true })
      } catch {
        // Preserve the original creation failure.
      }
    }
    throw new Error(
      `Cannot create or read secret key "${file}": ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // Preserve the original error.
      }
    }
  }
}

/** Test seam for isolated BM_APP_ROOT fixtures. */
export function resetSecretKeyCacheForTests(): void {
  cached = null
}

/** AES-256-GCM. Returns `enc2:` + base64(iv | tag | ciphertext). */
export function encryptString(plain: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', ensureSecretKey(), iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
}

/** null for anything this file did not write, or that no longer decrypts. */
export function decryptString(payload: string | undefined): string | null {
  if (!payload || !payload.startsWith(PREFIX)) return null
  try {
    const raw = Buffer.from(payload.slice(PREFIX.length), 'base64')
    if (raw.length <= IV_BYTES + TAG_BYTES) return null
    const decipher = createDecipheriv('aes-256-gcm', ensureSecretKey(), raw.subarray(0, IV_BYTES))
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
    const body = raw.subarray(IV_BYTES + TAG_BYTES)
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

/** True for a value encryptString() produced; a legacy one cannot be read. */
export function isEncrypted(payload: string | undefined): boolean {
  return typeof payload === 'string' && payload.startsWith(PREFIX)
}
