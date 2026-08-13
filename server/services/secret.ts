import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
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

export function ensureSecretKey(): Buffer {
  if (cached) return cached
  const file = keyFile()
  try {
    if (existsSync(file)) {
      const key = readFileSync(file)
      if (key.length === 32) {
        cached = key
        return key
      }
    }
  } catch {
    // Unreadable key: fall through and write a new one.
  }
  const key = randomBytes(32)
  mkdirSync(dataDir(), { recursive: true })
  writeFileSync(file, key)
  try {
    chmodSync(file, 0o600)
  } catch {
    // Windows and some mounts do not implement POSIX modes.
  }
  cached = key
  return key
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
