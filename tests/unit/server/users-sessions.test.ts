import session, { type SessionData, type Store as SessionStore } from 'express-session'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_USERNAME } from '@shared/types'
import { isAuthenticatedSession } from '../../../server/auth'
import {
  createUser,
  deleteUser,
  ensureDefaultAdmin,
  listUsers,
  resetUserMutationQueueForTests,
  setPassword,
  verifyForSession
} from '../../../server/services/users'
import { resetStoreCacheForTests } from '../../../server/services/store'
import { SessionController } from '../../../server/sessions'
import { createTestTempDir, type TestTempDir } from '../../helpers/temp-dir'

function storeSet(store: SessionStore, sid: string, data: SessionData): Promise<void> {
  return new Promise((resolve, reject) => {
    store.set(sid, data, (error) => (error ? reject(error) : resolve()))
  })
}

describe.sequential('user mutation and session revocation', () => {
  let temp: TestTempDir

  beforeEach(() => {
    temp = createTestTempDir('users')
    vi.stubEnv('BM_APP_ROOT', temp.path)
    resetStoreCacheForTests()
    resetUserMutationQueueForTests()
    ensureDefaultAdmin()
  })

  afterEach(() => {
    resetUserMutationQueueForTests()
    resetStoreCacheForTests()
    temp.cleanup()
  })

  it('serializes concurrent creates without losing accounts', async () => {
    await Promise.all([
      createUser('alice', 'alice-password'),
      createUser('bob', 'bob-password'),
      createUser('carol', 'carol-password')
    ])
    const names = listUsers().map((user) => user.username)
    expect(names).toEqual(expect.arrayContaining([DEFAULT_USERNAME, 'alice', 'bob', 'carol']))

    const duplicates = await Promise.allSettled([
      createUser('dave', 'first-password'),
      createUser('dave', 'second-password')
    ])
    expect(duplicates.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(listUsers().filter((user) => user.username === 'dave')).toHaveLength(1)
  })

  it('revalidates after scrypt so deletion cannot resurrect an account', async () => {
    await createUser('victim', 'old-password')
    const outcomes = await Promise.allSettled([
      setPassword('victim', 'new-password'),
      deleteUser('victim')
    ])

    expect(outcomes.some((result) => result.status === 'rejected')).toBe(true)
    expect(listUsers().some((user) => user.username === 'victim')).toBe(false)
  })

  it('invalidates reused sessions after password changes and deletion', async () => {
    await setPassword(DEFAULT_USERNAME, 'first-password')
    const firstVersion = await verifyForSession(DEFAULT_USERNAME, 'first-password')
    expect(firstVersion).not.toBeNull()
    expect(
      isAuthenticatedSession({ username: DEFAULT_USERNAME, authVersion: firstVersion })
    ).toBe(true)

    await setPassword(DEFAULT_USERNAME, 'second-password')
    expect(
      isAuthenticatedSession({ username: DEFAULT_USERNAME, authVersion: firstVersion })
    ).toBe(false)

    await createUser('alice', 'alice-password')
    const aliceVersion = await verifyForSession('alice', 'alice-password')
    await deleteUser('alice')
    expect(isAuthenticatedSession({ username: 'alice', authVersion: aliceVersion })).toBe(false)
    expect(isAuthenticatedSession({ username: 'missing', authVersion: 1 })).toBe(false)
  })

  it('destroys every stored session belonging to a username', async () => {
    const store = new session.MemoryStore()
    const sessions = new SessionController(store)
    const cookie = { originalMaxAge: null } as SessionData['cookie']
    await storeSet(store, 'alice-one', { cookie, username: 'alice', authVersion: 1 })
    await storeSet(store, 'alice-two', { cookie, username: 'alice', authVersion: 1 })
    await storeSet(store, 'bob-one', { cookie, username: 'bob', authVersion: 1 })

    await sessions.revokeUsername('alice')

    await expect(sessions.get('alice-one')).resolves.toBeNull()
    await expect(sessions.get('alice-two')).resolves.toBeNull()
    await expect(sessions.get('bob-one')).resolves.toMatchObject({ username: 'bob' })
  })
})
