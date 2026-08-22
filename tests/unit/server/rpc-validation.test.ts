import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'
import {
  validateActiveTab,
  validateConnectionConfig,
  validateCurrentSettingsEnvelope,
  validateHistoryQuery,
  validateHttpsUrl,
  validateModuleId,
  validatePackageAction,
  validatePackageQuery,
  validateTerminalCreate,
  validateTerminalData,
  validateTerminalId,
  validateTerminalSize
} from '../../../server/rpc-validation'

describe('RPC runtime argument validation', () => {
  it('accepts null only as the explicit hidden-browser active tab', () => {
    expect(validateActiveTab(null)).toBeNull()
    expect(validateActiveTab('network/main')).toBe('network/main')
    expect(() => validateActiveTab(undefined)).toThrow(/active tab/)
    expect(() => validateActiveTab('')).toThrow(/active tab/)
  })

  it('requires an exact host-key fingerprint/token confirmation object', () => {
    const fingerprint = 'a'.repeat(64)
    expect(
      validateConnectionConfig({
        mode: 'ssh',
        host: 'example.test',
        username: 'tester',
        hostKeyConfirmation: { fingerprint: fingerprint.toUpperCase(), token: 'token-123' }
      })
    ).toMatchObject({
      hostKeyConfirmation: { fingerprint, token: 'token-123' }
    })
    expect(() =>
      validateConnectionConfig({
        mode: 'ssh',
        host: 'example.test',
        username: 'tester',
        acceptHostKey: true
      })
    ).toThrow(/acceptHostKey/)
    expect(() =>
      validateConnectionConfig({
        mode: 'ssh',
        host: 'example.test',
        username: 'tester',
        hostKeyConfirmation: { fingerprint: 'wrong', token: 'token-123' }
      })
    ).toThrow(/fingerprint/)
  })

  it('rejects non-finite/invalid history ranges and clamps maxPoints', () => {
    expect(() => validateHistoryQuery('system', Infinity, Date.now(), 600)).toThrow(
      /finite timestamps/
    )
    expect(() => validateHistoryQuery('system', 200, 100, 600)).toThrow(/range/)
    expect(() => validateHistoryQuery('bad/name', 100, 200, 600)).toThrow(/stream/)
    expect(() => validateHistoryQuery('system', 100, 200, Infinity)).toThrow(/maxPoints/)

    expect(validateHistoryQuery('system', 100, 200, -50)).toEqual([
      'system',
      100,
      200,
      1
    ])
    expect(validateHistoryQuery('system', 100, 200, 99_999)[3]).toBe(2_000)
  })

  it('bounds terminal presets, dimensions, ids, and input data', () => {
    expect(validateTerminalCreate('shell', 80, 24, undefined)).toEqual([
      'shell',
      80,
      24,
      undefined
    ])
    expect(() => validateTerminalCreate('unknown', 80, 24, undefined)).toThrow(/preset/)
    expect(() => validateTerminalSize(0, 24)).toThrow(/columns/)
    expect(() => validateTerminalSize(80, Infinity)).toThrow(/rows/)
    expect(validateTerminalId('term-12')).toBe('term-12')
    expect(() => validateTerminalId('../term-1')).toThrow(/terminal id/)
    expect(() => validateTerminalData('x'.repeat(64 * 1024 + 1))).toThrow(/terminal data/)
  })

  it('validates package actions, names, and query sizes', () => {
    expect(validatePackageAction('install', 'curl')).toEqual(['install', 'curl'])
    expect(validatePackageAction('upgradeAll', undefined)).toEqual(['upgradeAll', undefined])
    expect(() => validatePackageAction('install', undefined)).toThrow(/requires/)
    expect(() => validatePackageAction('upgradeAll', 'curl')).toThrow(/does not accept/)
    expect(() => validatePackageAction('install', 'bad package')).toThrow(/package name/)
    expect(() => validatePackageQuery('x'.repeat(101))).toThrow(/package query/)
  })

  it('validates module ids, update URLs, and settings envelopes', () => {
    expect(validateModuleId('service-fleet')).toBe('service-fleet')
    expect(() => validateModuleId('../gpu')).toThrow(/module id/)
    expect(validateHttpsUrl('https://github.com/example/release.zip')).toContain('https://')
    expect(() => validateHttpsUrl('http://example.test/update.zip')).toThrow(/HTTPS/)
    expect(() => validateHttpsUrl('https://user:secret@example.test/update.zip')).toThrow(
      /credentials/
    )
    expect(validateCurrentSettingsEnvelope(structuredClone(DEFAULT_SETTINGS))).toEqual(
      DEFAULT_SETTINGS
    )
    expect(() =>
      validateCurrentSettingsEnvelope({ ...DEFAULT_SETTINGS, settingsVersion: 6 })
    ).toThrow(/version/)
  })
})
