import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, DEFAULT_USERNAME } from '@shared/types'
import {
  loadSettings,
  getSavedCredentials,
  listConnections,
  readModuleRegistry,
  rememberConnection,
  resetStoreCacheForTests,
  saveSettings,
  writeModuleRegistry
} from '../../../server/services/store'
import {
  ensureDefaultAdmin,
  hasPassword,
  listUsers,
  resetUserMutationQueueForTests,
  setPassword
} from '../../../server/services/users'
import {
  checkHostKey,
  HostKeyError,
  resetHostKeyChallengesForTests
} from '../../../server/services/known-hosts'
import { createTestTempDir, type TestTempDir } from '../../helpers/temp-dir'

describe.sequential('security-sensitive persistence recovery', () => {
  let temp: TestTempDir

  beforeEach(() => {
    temp = createTestTempDir('persistence')
    vi.stubEnv('BM_APP_ROOT', temp.path)
    resetStoreCacheForTests()
    resetUserMutationQueueForTests()
    resetHostKeyChallengesForTests()
  })

  afterEach(() => {
    temp.cleanup()
    resetStoreCacheForTests()
    resetUserMutationQueueForTests()
    resetHostKeyChallengesForTests()
  })

  it('rejects corrupt settings without falling back to permissive defaults', () => {
    const file = join(temp.path, 'data', 'user-settings', 'settings.json')
    mkdirSync(join(temp.path, 'data', 'user-settings'), { recursive: true })
    writeFileSync(file, '{"settingsVersion":6,"auth":', 'utf8')

    expect(() => loadSettings()).toThrow(/Cannot load settings/)
    expect(readFileSync(file, 'utf8')).toBe('{"settingsVersion":6,"auth":')
  })

  it('recovers settings from a valid backup and keeps security fields', () => {
    saveSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      server: {
        port: 9443,
        host: '127.0.0.1',
        allowedHosts: ['manager.example.test'],
        trustProxy: true
      },
      auth: {
        ...DEFAULT_SETTINGS.auth,
        enabled: true
      }
    })
    const file = join(temp.path, 'data', 'user-settings', 'settings.json')
    writeFileSync(file, '{"settingsVersion":6', 'utf8')

    const loaded = loadSettings()
    expect(loaded.auth.enabled).toBe(true)
    expect(loaded.server).toEqual({
      port: 9443,
      host: '127.0.0.1',
      allowedHosts: ['manager.example.test'],
      trustProxy: true
    })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      auth: { enabled: true },
      server: {
        port: 9443,
        host: '127.0.0.1',
        allowedHosts: ['manager.example.test'],
        trustProxy: true
      }
    })
  })

  it('bootstraps users only when users.json is genuinely absent', () => {
    ensureDefaultAdmin()
    expect(listUsers()).toEqual([
      expect.objectContaining({
        username: DEFAULT_USERNAME,
        hasPassword: false
      })
    ])
  })

  it('never overwrites a corrupt users file with an empty-password admin', () => {
    const file = join(temp.path, 'data', 'users', 'users.json')
    mkdirSync(join(temp.path, 'data', 'users'), { recursive: true })
    writeFileSync(file, '{"version":2,"users":[', 'utf8')

    expect(() => ensureDefaultAdmin()).toThrow(/Cannot load users database/)
    expect(readFileSync(file, 'utf8')).toBe('{"version":2,"users":[')
  })

  it('recovers a valid users backup instead of bootstrapping', async () => {
    ensureDefaultAdmin()
    await setPassword(DEFAULT_USERNAME, 'correct horse battery staple')
    const file = join(temp.path, 'data', 'users', 'users.json')
    writeFileSync(file, '{"version":2', 'utf8')

    expect(() => ensureDefaultAdmin()).not.toThrow()
    expect(hasPassword(DEFAULT_USERNAME)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      version: 2,
      users: [expect.objectContaining({ username: DEFAULT_USERNAME })]
    })
  })

  it('fails closed for a corrupt module registry', () => {
    const file = join(temp.path, 'data', 'user-settings', 'modules.json')
    mkdirSync(join(temp.path, 'data', 'user-settings'), { recursive: true })
    writeFileSync(file, '{"version":1,"modules":', 'utf8')

    expect(() => readModuleRegistry()).toThrow(/Cannot load module registry|application data/)
  })

  it('recovers known hosts only from a valid backup', () => {
    const fingerprint = 'a'.repeat(64)
    let challenge!: HostKeyError
    try {
      checkHostKey('example.test', 22, fingerprint)
    } catch (error) {
      challenge = error as HostKeyError
    }
    checkHostKey('example.test', 22, fingerprint, {
      fingerprint,
      token: challenge.hostKey.token
    })
    const file = join(temp.path, 'data', 'known-hosts.json')
    writeFileSync(file, '{"version":1', 'utf8')

    expect(() => checkHostKey('example.test', 22, fingerprint)).not.toThrow()

    writeModuleRegistry({})
    const modules = join(temp.path, 'data', 'user-settings', 'modules.json')
    writeFileSync(modules, '{"version":1', 'utf8')
    expect(readModuleRegistry()).toEqual({})
  })

  it('removes a remembered sudo password after the target rejects it', () => {
    const connection = {
      host: 'example.test',
      port: 22,
      username: 'tester',
      password: 'ssh-password',
      sudoPassword: 'old-sudo-password',
      rememberPassword: true
    }
    rememberConnection(DEFAULT_USERNAME, connection)
    const id = 'tester@example.test:22'
    expect(getSavedCredentials(DEFAULT_USERNAME, id)).toEqual({
      password: 'ssh-password',
      sudoPassword: 'old-sudo-password'
    })

    rememberConnection(DEFAULT_USERNAME, {
      ...connection,
      sudoPassword: undefined,
      clearSudoPassword: true
    })
    expect(getSavedCredentials(DEFAULT_USERNAME, id)).toEqual({
      password: 'ssh-password',
      sudoPassword: undefined
    })

    rememberConnection(DEFAULT_USERNAME, {
      host: 'key-only.example',
      port: 22,
      username: 'tester',
      sudoPassword: 'verified-sudo-password',
      rememberPassword: true
    })
    expect(
      listConnections(DEFAULT_USERNAME).find(
        (saved) => saved.id === 'tester@key-only.example:22'
      )?.hasSavedPassword
    ).toBe(true)
    expect(
      getSavedCredentials(DEFAULT_USERNAME, 'tester@key-only.example:22')
    ).toEqual({
      password: undefined,
      sudoPassword: 'verified-sudo-password'
    })
  })
})
