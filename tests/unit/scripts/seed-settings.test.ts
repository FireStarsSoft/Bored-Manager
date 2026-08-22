import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, SETTINGS_VERSION } from '@shared/types'
import {
  isCompleteSettings,
  seedSettingsDocument,
  seedSettingsFile,
  V034_INSTALLER_STUB
} from '../../../scripts/seed-settings'
import { createTestTempDir, type TestTempDir } from '../../helpers/temp-dir'

describe('seed-settings', () => {
  let temp: TestTempDir

  afterEach(() => {
    temp?.cleanup()
  })

  it('builds a missing file from DEFAULT_SETTINGS', () => {
    const { action, settings } = seedSettingsDocument(null, {})
    expect(action).toBe('created')
    expect(settings.settingsVersion).toBe(SETTINGS_VERSION)
    expect(settings.server).toEqual(DEFAULT_SETTINGS.server)
    expect(settings.auth).toEqual(DEFAULT_SETTINGS.auth)
  })

  it('applies port and host overrides on a missing file', () => {
    const { settings } = seedSettingsDocument(null, {
      port: 9000,
      host: '127.0.0.1'
    })
    expect(settings.server).toEqual({
      ...DEFAULT_SETTINGS.server,
      port: 9000,
      host: '127.0.0.1'
    })
    expect(settings.auth).toEqual(DEFAULT_SETTINGS.auth)
  })

  it('repairs the v0.3.4 installer stub and keeps its port', () => {
    expect(isCompleteSettings(V034_INSTALLER_STUB)).toBe(false)
    const { action, settings } = seedSettingsDocument(
      { settingsVersion: 6, server: { port: 8790, host: '0.0.0.0' } },
      {}
    )
    expect(action).toBe('repaired')
    expect(settings).toMatchObject({
      settingsVersion: SETTINGS_VERSION,
      server: { port: 8790, host: '0.0.0.0' },
      auth: DEFAULT_SETTINGS.auth
    })
  })

  it('leaves a healthy file alone unless port or host flags are set', () => {
    const healthy = structuredClone(DEFAULT_SETTINGS)
    expect(isCompleteSettings(healthy)).toBe(true)
    expect(seedSettingsDocument(healthy, {}).action).toBe('kept')

    const { action, settings } = seedSettingsDocument(healthy, {
      port: 9443,
      portSet: true
    })
    expect(action).toBe('updated')
    expect(settings).toMatchObject({
      server: { port: 9443 },
      auth: healthy.auth
    })
  })

  it('writes a missing file and refuses to invent defaults over corrupt JSON', () => {
    temp = createTestTempDir('seed-settings')
    const file = join(temp.path, 'data', 'user-settings', 'settings.json')
    mkdirSync(join(temp.path, 'data', 'user-settings'), { recursive: true })

    const created = seedSettingsFile(file, { port: 8686, host: '0.0.0.0' })
    expect(created.action).toBe('created')
    const written = JSON.parse(readFileSync(file, 'utf8'))
    expect(written.settingsVersion).toBe(SETTINGS_VERSION)
    expect(written.server).toEqual(DEFAULT_SETTINGS.server)
    expect(written.auth).toEqual(DEFAULT_SETTINGS.auth)

    writeFileSync(file, '{"settingsVersion":6,"auth":', 'utf8')
    expect(() => seedSettingsFile(file, {})).toThrow(/invalid/)
    expect(readFileSync(file, 'utf8')).toBe('{"settingsVersion":6,"auth":')
  })
})
