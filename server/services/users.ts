import { promisify } from 'util'
import { randomBytes, scrypt, timingSafeEqual } from 'crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import {
  DEFAULT_USERNAME,
  USERNAME_PATTERN,
  type UserAccount
} from '@shared/types'
import { dataDir, userDataDir, writePrivateJson } from './store'

const scryptAsync = promisify(scrypt)

/**
 * The accounts that may open the WebUI, in data/users/users.json.
 *
 * They are the app's own accounts, unrelated to the host's system users: the
 * server already runs as somebody, and "who may look at this page" is a
 * different question from "who may run commands on that machine".
 *
 * Passwords are scrypt hashes with a per-user salt. There is no reset flow on
 * purpose - whoever has a terminal on the host can edit this file, and whoever
 * does not should not be able to reset an account.
 */

const SCRYPT_KEYLEN = 64
const SALT_BYTES = 16

interface StoredUser {
  username: string
  /** scrypt hash, hex. Empty means "no password set yet". */
  passwordHash: string
  salt: string
  createdAt: number
  lastLoginAt: number | null
}

interface UsersFile {
  version: number
  users: StoredUser[]
}

function usersFile(): string {
  return join(dataDir(), 'users', 'users.json')
}

function read(): StoredUser[] {
  try {
    if (!existsSync(usersFile())) return []
    const raw = JSON.parse(readFileSync(usersFile(), 'utf8')) as Partial<UsersFile>
    if (!Array.isArray(raw.users)) return []
    return raw.users.filter(
      (u): u is StoredUser => typeof u?.username === 'string' && u.username.length > 0
    )
  } catch {
    return []
  }
}

function write(users: StoredUser[]): void {
  mkdirSync(join(dataDir(), 'users'), { recursive: true })
  writePrivateJson(usersFile(), { version: 1, users } satisfies UsersFile)
}

async function hash(password: string, salt: string): Promise<string> {
  const derived = (await scryptAsync(password, salt, SCRYPT_KEYLEN)) as Buffer
  return derived.toString('hex')
}

function toAccount(user: StoredUser): UserAccount {
  return {
    username: user.username,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    hasPassword: user.passwordHash.length > 0
  }
}

/**
 * Called on every boot. The default account always exists - with auth off,
 * everything a client does is done as this user, so its folder has to be there
 * before the first request arrives.
 */
export function ensureDefaultAdmin(): void {
  const users = read()
  mkdirSync(userDataDir(DEFAULT_USERNAME), { recursive: true })
  if (users.some((u) => u.username === DEFAULT_USERNAME)) return
  users.unshift({
    username: DEFAULT_USERNAME,
    passwordHash: '',
    salt: randomBytes(SALT_BYTES).toString('hex'),
    createdAt: Date.now(),
    lastLoginAt: null
  })
  write(users)
}

export function listUsers(): UserAccount[] {
  return read().map(toAccount)
}

export function userExists(username: string): boolean {
  return read().some((u) => u.username === username)
}

export function hasPassword(username: string): boolean {
  return (read().find((u) => u.username === username)?.passwordHash ?? '').length > 0
}

/** The reason a name is unusable, or null when it is fine. */
function nameProblem(username: string, users: StoredUser[]): string | null {
  if (!USERNAME_PATTERN.test(username)) {
    return 'a username is 3-32 characters: lower case letters, digits, - and _, starting with a letter'
  }
  if (users.some((u) => u.username === username)) return `"${username}" already exists`
  return null
}

export async function createUser(username: string, password: string): Promise<UserAccount> {
  const users = read()
  const problem = nameProblem(username, users)
  if (problem) throw new Error(problem)
  if (!password) throw new Error('a new account needs a password')
  const salt = randomBytes(SALT_BYTES).toString('hex')
  const user: StoredUser = {
    username,
    passwordHash: await hash(password, salt),
    salt,
    createdAt: Date.now(),
    lastLoginAt: null
  }
  users.push(user)
  write(users)
  mkdirSync(userDataDir(username), { recursive: true })
  return toAccount(user)
}

/** Removes the account and everything it saved; the default one is kept. */
export function deleteUser(username: string): void {
  if (username === DEFAULT_USERNAME) {
    throw new Error(`"${DEFAULT_USERNAME}" cannot be deleted`)
  }
  const users = read()
  if (!users.some((u) => u.username === username)) throw new Error(`"${username}" does not exist`)
  write(users.filter((u) => u.username !== username))
  rmSync(userDataDir(username), { recursive: true, force: true })
}

export async function setPassword(username: string, password: string): Promise<void> {
  if (!password) throw new Error('the password cannot be empty')
  const users = read()
  const user = users.find((u) => u.username === username)
  if (!user) throw new Error(`"${username}" does not exist`)
  user.salt = randomBytes(SALT_BYTES).toString('hex')
  user.passwordHash = await hash(password, user.salt)
  write(users)
}

/**
 * True only for the right password of an existing account that has one. An
 * account without a password cannot be logged into at all, which is what makes
 * "turn auth on" require setting one first.
 */
export async function verify(username: string, password: string): Promise<boolean> {
  const user = read().find((u) => u.username === username)
  if (!user || !user.passwordHash) return false
  const expected = Buffer.from(user.passwordHash, 'hex')
  const actual = Buffer.from(await hash(password, user.salt), 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export function recordLogin(username: string): void {
  const users = read()
  const user = users.find((u) => u.username === username)
  if (!user) return
  user.lastLoginAt = Date.now()
  write(users)
}
