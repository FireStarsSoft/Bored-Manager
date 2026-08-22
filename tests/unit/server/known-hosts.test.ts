import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkHostKey,
  HostKeyError,
  resetHostKeyChallengesForTests
} from '../../../server/services/known-hosts'
import { resetStoreCacheForTests } from '../../../server/services/store'
import { createTestTempDir, type TestTempDir } from '../../helpers/temp-dir'

function challenge(
  host: string,
  port: number,
  fingerprint: string,
  now?: number
): HostKeyError {
  try {
    checkHostKey(host, port, fingerprint, undefined, now)
  } catch (error) {
    expect(error).toBeInstanceOf(HostKeyError)
    return error as HostKeyError
  }
  throw new Error('expected a host-key challenge')
}

describe.sequential('SSH host-key confirmation binding', () => {
  let temp: TestTempDir

  beforeEach(() => {
    temp = createTestTempDir('known-hosts')
    vi.stubEnv('BM_APP_ROOT', temp.path)
    resetStoreCacheForTests()
    resetHostKeyChallengesForTests()
  })

  afterEach(() => {
    resetHostKeyChallengesForTests()
    resetStoreCacheForTests()
    temp.cleanup()
  })

  it('accepts only the exact host, port, fingerprint, and one-use token', () => {
    const fingerprint = 'a'.repeat(64)
    const issued = challenge('one.example', 22, fingerprint).hostKey
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{40,}$/)

    const wrongHost = challenge('two.example', 22, fingerprint)
    expect(wrongHost.hostKey.token).not.toBe(issued.token)
    expect(() =>
      checkHostKey('two.example', 22, fingerprint, {
        fingerprint,
        token: issued.token
      })
    ).toThrow(HostKeyError)

    // The mismatched submission consumed the token; it cannot be replayed
    // against the host it originally belonged to.
    expect(() =>
      checkHostKey('one.example', 22, fingerprint, {
        fingerprint,
        token: issued.token
      })
    ).toThrow(HostKeyError)

    const fresh = challenge('one.example', 22, fingerprint).hostKey
    expect(() =>
      checkHostKey('one.example', 22, fingerprint, {
        fingerprint,
        token: fresh.token
      })
    ).not.toThrow()
    expect(() => checkHostKey('one.example', 22, fingerprint)).not.toThrow()

    const stored = JSON.parse(
      readFileSync(join(temp.path, 'data', 'known-hosts.json'), 'utf8')
    ) as { hosts: Record<string, { fingerprint: string }> }
    expect(stored.hosts['one.example:22']?.fingerprint).toBe(fingerprint)
  })

  it('issues a new challenge if the server substitutes its key', () => {
    const firstFingerprint = 'b'.repeat(64)
    const substitutedFingerprint = 'c'.repeat(64)
    const first = challenge('swap.example', 2222, firstFingerprint).hostKey

    let substituted!: HostKeyError
    try {
      checkHostKey('swap.example', 2222, substitutedFingerprint, {
        fingerprint: firstFingerprint,
        token: first.token
      })
    } catch (error) {
      substituted = error as HostKeyError
    }

    expect(substituted).toBeInstanceOf(HostKeyError)
    expect(substituted.hostKey.fingerprint).toBe(substitutedFingerprint)
    expect(substituted.hostKey.token).not.toBe(first.token)
    expect(() => checkHostKey('swap.example', 2222, firstFingerprint)).toThrow(
      HostKeyError
    )
  })

  it('expires confirmations after the short challenge window', () => {
    const fingerprint = 'd'.repeat(64)
    const issued = challenge('expiry.example', 22, fingerprint, 1_000).hostKey

    expect(() =>
      checkHostKey(
        'expiry.example',
        22,
        fingerprint,
        { fingerprint, token: issued.token },
        issued.expiresAt + 1
      )
    ).toThrow(HostKeyError)
    expect(() => checkHostKey('expiry.example', 22, fingerprint)).toThrow(
      HostKeyError
    )
  })
})
