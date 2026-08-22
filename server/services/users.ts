import { promisify } from 'util'
import { randomBytes, scrypt, timingSafeEqual } from 'crypto'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import {
  DEFAULT_USERNAME,
  USERNAME_PATTERN,
  type UserAccount
} from '@shared/types'
import { isFiniteNumber, isRecord } from '@shared/validation'
import { dataDir, userDataDir } from './store'
import { readPrivateJson, writeAtomicPrivateJson } from './private-file'

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
export const MAX_PASSWORD_LENGTH = 4096
const DUMMY_SALT = randomBytes(SALT_BYTES).toString('hex')
const DUMMY_EXPECTED = randomBytes(SCRYPT_KEYLEN)

interface StoredUser {
  username: string
  /** scrypt hash, hex. Empty means "no password set yet". */
  passwordHash: string
  salt: string
  createdAt: number
  lastLoginAt: number | null
  /** Incremented whenever the password changes, invalidating old sessions. */
  sessionVersion: number
}

interface UsersFile {
  version: 2
  users: StoredUser[]
}

function usersFile(): string {
  return join(dataDir(), 'users', 'users.json')
}

function usersDocument(value: unknown): UsersFile {
  if (!isRecord(value) || (value['version'] !== 1 && value['version'] !== 2)) {
    throw new Error('users database must have version 1 or 2')
  }
  if (!Array.isArray(value['users'])) throw new Error('users database must contain a users array')

  const users: StoredUser[] = []
  const seen = new Set<string>()
  for (const [index, raw] of value['users'].entries()) {
    if (!isRecord(raw)) throw new Error(`users[${index}] must be an object`)
    const username = raw['username']
    if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) {
      throw new Error(`users[${index}].username is invalid`)
    }
    if (seen.has(username)) throw new Error(`users database contains duplicate "${username}"`)
    seen.add(username)

    const passwordHash = raw['passwordHash']
    const salt = raw['salt']
    if (
      typeof passwordHash !== 'string' ||
      (passwordHash !== '' && !/^[0-9a-f]{128}$/i.test(passwordHash))
    ) {
      throw new Error(`users[${index}].passwordHash is invalid`)
    }
    if (typeof salt !== 'string' || !/^[0-9a-f]{32}$/i.test(salt)) {
      throw new Error(`users[${index}].salt is invalid`)
    }
    const createdAt = raw['createdAt']
    const lastLoginAt = raw['lastLoginAt']
    if (!isFiniteNumber(createdAt) || createdAt < 0) {
      throw new Error(`users[${index}].createdAt is invalid`)
    }
    if (lastLoginAt !== null && (!isFiniteNumber(lastLoginAt) || lastLoginAt < 0)) {
      throw new Error(`users[${index}].lastLoginAt is invalid`)
    }
    const rawSessionVersion = value['version'] === 1 ? 1 : raw['sessionVersion']
    if (
      !isFiniteNumber(rawSessionVersion) ||
      !Number.isSafeInteger(rawSessionVersion) ||
      rawSessionVersion < 1
    ) {
      throw new Error(`users[${index}].sessionVersion is invalid`)
    }
    users.push({
      username,
      passwordHash,
      salt,
      createdAt,
      lastLoginAt,
      sessionVersion: rawSessionVersion
    })
  }
  return { version: 2, users }
}

function readResult() {
  return readPrivateJson(usersFile(), usersDocument, 'users database')
}

function read(): StoredUser[] {
  const result = readResult()
  if (result.kind === 'missing') {
    throw new Error(`Users database "${usersFile()}" is missing; initialize it before use`)
  }
  return result.value.users
}

function write(users: StoredUser[]): void {
  mkdirSync(join(dataDir(), 'users'), { recursive: true })
  writeAtomicPrivateJson(usersFile(), { version: 2, users } satisfies UsersFile)
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

let mutationTail: Promise<void> = Promise.resolve()

function serializeMutation<T>(operation: () => T | Promise<T>): Promise<T> {
  const result = mutationTail.then(operation, operation)
  mutationTail = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

/** Test seam; callers must only reset after all prior operations have settled. */
export function resetUserMutationQueueForTests(): void {
  mutationTail = Promise.resolve()
}

/**
 * Called on every boot. The default account always exists - with auth off,
 * everything a client does is done as this user, so its folder has to be there
 * before the first request arrives.
 */
export function ensureDefaultAdmin(): void {
  const result = readResult()
  if (result.kind === 'missing') {
    write([
      {
        username: DEFAULT_USERNAME,
        passwordHash: '',
        salt: randomBytes(SALT_BYTES).toString('hex'),
        createdAt: Date.now(),
        lastLoginAt: null,
        sessionVersion: 1
      }
    ])
  } else if (!result.value.users.some((user) => user.username === DEFAULT_USERNAME)) {
    throw new Error(`Users database is missing required account "${DEFAULT_USERNAME}"`)
  }
  mkdirSync(userDataDir(DEFAULT_USERNAME), { recursive: true })
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

function passwordProblem(password: string): string | null {
  if (!password) return 'the password cannot be empty'
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `the password must be at most ${MAX_PASSWORD_LENGTH} characters`
  }
  return null
}

export async function createUser(username: string, password: string): Promise<UserAccount> {
  if (!USERNAME_PATTERN.test(username)) {
    throw new Error(
      'a username is 3-32 characters: lower case letters, digits, - and _, starting with a letter'
    )
  }
  const passwordError = passwordProblem(password)
  if (passwordError) throw new Error(passwordError)
  const salt = randomBytes(SALT_BYTES).toString('hex')
  const passwordHash = await hash(password, salt)
  return serializeMutation(() => {
    const users = read()
    const problem = nameProblem(username, users)
    if (problem) throw new Error(problem)
    const user: StoredUser = {
      username,
      passwordHash,
      salt,
      createdAt: Date.now(),
      lastLoginAt: null,
      sessionVersion: 1
    }
    users.push(user)
    write(users)
    mkdirSync(userDataDir(username), { recursive: true })
    return toAccount(user)
  })
}

/** Removes the account and everything it saved; the default one is kept. */
export function deleteUser(username: string): Promise<void> {
  if (username === DEFAULT_USERNAME) {
    return Promise.reject(new Error(`"${DEFAULT_USERNAME}" cannot be deleted`))
  }
  if (!USERNAME_PATTERN.test(username)) {
    return Promise.reject(new Error(`"${username}" is not a valid username`))
  }
  return serializeMutation(() => {
    const users = read()
    if (!users.some((u) => u.username === username)) {
      throw new Error(`"${username}" does not exist`)
    }
    write(users.filter((u) => u.username !== username))
    rmSync(userDataDir(username), { recursive: true, force: true })
  })
}

export async function setPassword(username: string, password: string): Promise<void> {
  if (!USERNAME_PATTERN.test(username)) throw new Error(`"${username}" is not a valid username`)
  const problem = passwordProblem(password)
  if (problem) throw new Error(problem)
  const salt = randomBytes(SALT_BYTES).toString('hex')
  const passwordHash = await hash(password, salt)
  await serializeMutation(() => {
    const users = read()
    const user = users.find((u) => u.username === username)
    if (!user) throw new Error(`"${username}" does not exist`)
    if (user.sessionVersion >= Number.MAX_SAFE_INTEGER) {
      throw new Error(`"${username}" session version cannot be incremented`)
    }
    user.salt = salt
    user.passwordHash = passwordHash
    user.sessionVersion += 1
    write(users)
  })
}

/**
 * True only for the right password of an existing account that has one. An
 * account without a password cannot be logged into at all, which is what makes
 * "turn auth on" require setting one first.
 */
export async function verifyForSession(username: string, password: string): Promise<number | null> {
  if (
    !USERNAME_PATTERN.test(username) ||
    password.length === 0 ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    return null
  }

  const user = read().find((candidate) => candidate.username === username)
  const salt = user?.passwordHash ? user.salt : DUMMY_SALT
  const expected = user?.passwordHash ? Buffer.from(user.passwordHash, 'hex') : DUMMY_EXPECTED
  const actual = Buffer.from(await hash(password, salt), 'hex')
  const matches = expected.length === actual.length && timingSafeEqual(expected, actual)

  return serializeMutation(() => {
    const current = read().find((candidate) => candidate.username === username)
    if (
      !matches ||
      !user ||
      !current ||
      current.passwordHash !== user.passwordHash ||
      current.salt !== user.salt ||
      current.sessionVersion !== user.sessionVersion
    ) {
      return null
    }
    return current.sessionVersion
  })
}

export async function verify(username: string, password: string): Promise<boolean> {
  return (await verifyForSession(username, password)) !== null
}

export function sessionIsCurrent(username: string, sessionVersion: unknown): boolean {
  if (!Number.isSafeInteger(sessionVersion) || Number(sessionVersion) < 1) return false
  const user = read().find((candidate) => candidate.username === username)
  return !!user && user.sessionVersion === sessionVersion
}

export function recordLogin(username: string, expectedSessionVersion?: number): Promise<boolean> {
  return serializeMutation(() => {
    const users = read()
    const user = users.find((candidate) => candidate.username === username)
    if (!user || (expectedSessionVersion != null && user.sessionVersion !== expectedSessionVersion)) {
      return false
    }
    user.lastLoginAt = Date.now()
    write(users)
    return true
  })
}
