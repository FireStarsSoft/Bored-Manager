import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, DEFAULT_USERNAME } from '@shared/types'
import {
  attemptLogin,
  readLock,
  resetLoginQueueForTests,
  unlock
} from '../../../server/auth'
import {
  ensureDefaultAdmin,
  resetUserMutationQueueForTests,
  setPassword
} from '../../../server/services/users'
import { resetStoreCacheForTests } from '../../../server/services/store'
import { createTestTempDir, type TestTempDir } from '../../helpers/temp-dir'

describe.sequential('login lockout transactions', () => {
  let temp: TestTempDir

  beforeEach(async () => {
    temp = createTestTempDir('lockout')
    vi.stubEnv('BM_APP_ROOT', temp.path)
    resetStoreCacheForTests()
    resetUserMutationQueueForTests()
    resetLoginQueueForTests()
    ensureDefaultAdmin()
    await setPassword(DEFAULT_USERNAME, 'right-password')
  })

  afterEach(() => {
    resetLoginQueueForTests()
    resetUserMutationQueueForTests()
    resetStoreCacheForTests()
    temp.cleanup()
  })

  it('serializes parallel failures and preserves 423 lock semantics', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS)
    settings.auth.enabled = true
    settings.auth.maxFailures = 3

    const attempts = await Promise.all([
      attemptLogin(settings, DEFAULT_USERNAME, 'wrong-password', '127.0.0.1'),
      attemptLogin(settings, DEFAULT_USERNAME, 'wrong-password', '127.0.0.1'),
      attemptLogin(settings, DEFAULT_USERNAME, 'wrong-password', '127.0.0.1')
    ])

    expect(attempts.map((attempt) => attempt.kind)).toEqual(['invalid', 'invalid', 'invalid'])
    expect(attempts[2]).toMatchObject({ kind: 'invalid', failures: 3, locked: true })
    await expect(
      attemptLogin(settings, DEFAULT_USERNAME, 'right-password', '127.0.0.1')
    ).resolves.toEqual({ kind: 'locked' })
    expect(readLock()).toMatchObject({
      users: { [DEFAULT_USERNAME]: { failures: 3 } },
      ips: { '127.0.0.1': { failures: 3 } }
    })
  })

  it('does not count malformed credentials', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS)
    settings.auth.enabled = true

    await expect(attemptLogin(settings, 'x', '', '127.0.0.1')).resolves.toMatchObject({
      kind: 'malformed'
    })
    expect(readLock()).toEqual({ version: 2, users: {}, ips: {} })
  })

  it('fails closed on a corrupt lock file', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS)
    settings.auth.enabled = true
    const file = join(temp.path, 'data', 'auth-lock.json')
    mkdirSync(join(temp.path, 'data'), { recursive: true })
    writeFileSync(file, '{"version":2,"users":', 'utf8')

    await expect(
      attemptLogin(settings, DEFAULT_USERNAME, 'right-password', '127.0.0.1')
    ).rejects.toThrow(/Cannot load auth lock/)
  })

  it('reports unlock persistence failures', () => {
    const data = join(temp.path, 'data')
    rmSync(data, { recursive: true, force: true })
    writeFileSync(data, 'not a directory', 'utf8')

    expect(() => unlock()).toThrow()
  })
})
