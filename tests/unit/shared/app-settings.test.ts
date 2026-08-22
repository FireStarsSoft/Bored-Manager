import { describe, expect, it } from 'vitest'
import { APP_SETTINGS_LIMITS, normalizeAppSettings } from '@shared/app-settings'
import { DEFAULT_SETTINGS, SETTINGS_VERSION } from '@shared/types'

describe('normalizeAppSettings', () => {
  it('keeps a complete current settings object unchanged', () => {
    expect(normalizeAppSettings(structuredClone(DEFAULT_SETTINGS))).toEqual(DEFAULT_SETTINGS)
  })

  it('fills new resource controls when an existing settings file omits them', () => {
    const normalized = normalizeAppSettings({
      settingsVersion: SETTINGS_VERSION,
      refresh: { system: 'normal' },
      slowRefresh: { storage: 60 },
      detailPolling: { network: 'tab', disk: 'tab', overviewTop: 'tab' }
    })

    expect(normalized.refresh.bmc).toBe('normal')
    expect(normalized.slowRefresh.bmc).toBe(60)
    expect(normalized.detailPolling).toMatchObject({
      gpu: 'always',
      sensors: 'always',
      container: 'always'
    })
  })

  it('normalizes every nested shape and retains valid module-owned keys', () => {
    const normalized = normalizeAppSettings({
      settingsVersion: SETTINGS_VERSION,
      theme: 'neon',
      density: [],
      densityAutoDetected: 'yes',
      historyWindow: Number.POSITIVE_INFINITY,
      refresh: { system: 'turbo', custom: 'low', bad: 2 },
      slowRefresh: { custom: 45.9, negative: -1, infinite: Number.POSITIVE_INFINITY },
      overviewWidgets: { useful: true, bad: 'true' },
      overviewLayout: {
        lg: [
          { i: 'card-a', x: 1.9, y: 2.1, w: 3.8 },
          { i: 'card-a', x: 4, y: 5, w: 2 },
          null,
          { i: 'too-wide', x: 0, y: 0, w: APP_SETTINGS_LIMITS.layoutWidth.max + 1 }
        ],
        xl: [{ i: 'ignored', x: 0, y: 0, w: 1 }]
      },
      collectors: [],
      detailPolling: { network: 'sometimes', disk: 'always', overviewTop: 'off' },
      history: {
        enabled: 'yes',
        retentionHours: Number.NaN,
        maxStorageMB: APP_SETTINGS_LIMITS.historyStorageMB.max + 1
      },
      server: { port: 70_000, host: '   ' },
      auth: {
        enabled: 1,
        maxFailures: 0,
        sessionIdle: { value: Number.NaN, unit: 'week' }
      },
      update: { repo: [], lastUrl: false }
    })

    expect(normalized).toMatchObject({
      settingsVersion: SETTINGS_VERSION,
      theme: DEFAULT_SETTINGS.theme,
      density: DEFAULT_SETTINGS.density,
      densityAutoDetected: DEFAULT_SETTINGS.densityAutoDetected,
      historyWindow: DEFAULT_SETTINGS.historyWindow,
      refresh: { system: DEFAULT_SETTINGS.refresh.system, custom: 'low' },
      slowRefresh: { custom: 45 },
      overviewWidgets: { useful: true },
      overviewLayout: { lg: [{ i: 'card-a', x: 1, y: 2, w: 3 }] },
      collectors: DEFAULT_SETTINGS.collectors,
      detailPolling: { network: 'tab', disk: 'always', overviewTop: 'off' },
      history: DEFAULT_SETTINGS.history,
      server: DEFAULT_SETTINGS.server,
      auth: DEFAULT_SETTINGS.auth,
      update: DEFAULT_SETTINGS.update
    })
    expect(normalized.refresh).not.toHaveProperty('bad')
    expect(normalized.slowRefresh).not.toHaveProperty('negative')
    expect(normalized.overviewLayout).not.toHaveProperty('xl')
  })

  it('migrates legacy interval, widget, layout and update names', () => {
    const normalized = normalizeAppSettings({
      settingsVersion: 2,
      refresh: { docker: 'high' },
      refreshSlow: 120,
      overviewExtended: { docker: false },
      overviewLayout: {
        lg: [{ i: 'dockerCounts', x: 0, y: 1, w: 2 }]
      },
      lastUpdateUrl: 'https://example.invalid/update.zip'
    })

    expect(normalized.refresh.container).toBe('high')
    expect(normalized.refresh).not.toHaveProperty('docker')
    expect(normalized.slowRefresh.storage).toBe(120)
    expect(normalized.overviewWidgets['container.summary']).toBe(false)
    expect(normalized.overviewLayout.lg?.[0].i).toBe('container.resources')
    expect(normalized.update.lastUrl).toBe('https://example.invalid/update.zip')
    expect(normalized.theme).toBe('dark')
  })

  it('normalizes the server allowlist and migrates v6 proxy defaults', () => {
    const current = normalizeAppSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: SETTINGS_VERSION,
      server: {
        port: 8686,
        host: '0.0.0.0',
        allowedHosts: [
          ' Manager.Example.COM. ',
          'manager.example.com',
          '192.168.1.10',
          '[::1]',
          '*.example.com',
          'host:8686'
        ],
        trustProxy: true
      }
    })
    expect(current.server).toEqual({
      port: 8686,
      host: '0.0.0.0',
      allowedHosts: ['manager.example.com', '192.168.1.10', '::1'],
      trustProxy: true
    })

    const migrated = normalizeAppSettings({
      settingsVersion: 6,
      server: { port: 9000, host: '127.0.0.1' }
    })
    expect(migrated.server).toEqual({
      port: 9000,
      host: '127.0.0.1',
      allowedHosts: [],
      trustProxy: false
    })
    expect(migrated.settingsVersion).toBe(SETTINGS_VERSION)
  })

  it('does not mutate imported input objects while migrating them', () => {
    const raw = {
      settingsVersion: 5,
      refresh: { docker: 'normal' },
      slowRefresh: { docker: 300 }
    }
    const before = structuredClone(raw)
    normalizeAppSettings(raw)
    expect(raw).toEqual(before)
  })
})
