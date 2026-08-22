import { mkdirSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REGISTRY_VERSION } from '@shared/modules'
import {
  getCatalog,
  REGISTRY_CACHE_TTL_MS
} from '../../../server/services/registry'
import { resetStoreCacheForTests } from '../../../server/services/store'
import { createTestTempDir, type TestTempDir } from '../../helpers/temp-dir'

const entry = {
  id: 'test-module',
  name: 'Test',
  description: 'Fixture',
  author: 'Tests',
  version: '1.0.0',
  download: 'https://github.com/owner/repo/releases/download/v1/test.zip',
  sha256: 'a'.repeat(64),
  verifiedAt: '2026-08-22'
}

let temp: TestTempDir
let previousRoot: string | undefined

function catalog(modules: unknown[] = [entry]): Response {
  return Response.json({ registryVersion: REGISTRY_VERSION, modules })
}

beforeEach(() => {
  temp = createTestTempDir('registry')
  previousRoot = process.env['BM_APP_ROOT']
  process.env['BM_APP_ROOT'] = temp.path
  resetStoreCacheForTests()
  mkdirSync(temp.path, { recursive: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  temp.cleanup()
  if (previousRoot === undefined) delete process.env['BM_APP_ROOT']
  else process.env['BM_APP_ROOT'] = previousRoot
  resetStoreCacheForTests()
})

describe('source-bound module registry cache', () => {
  it('never serves a different repository cache after a fetch failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(catalog())
      .mockRejectedValueOnce(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)

    const first = await getCatalog('owner/one')
    expect(first.entries).toHaveLength(1)
    expect(first.sourceRepo).toBe('owner/one')

    const second = await getCatalog('owner/two')
    expect(second).toMatchObject({
      entries: [],
      sourceRepo: 'owner/two',
      sourceUrl: 'https://raw.githubusercontent.com/owner/two/main/registry/modules.json',
      fetchedAt: null,
      stale: true
    })
  })

  it('shows a stale same-source cache but marks it untrusted', async () => {
    const now = 1_800_000_000_000
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const fetchMock = vi.fn().mockResolvedValueOnce(catalog())
    vi.stubGlobal('fetch', fetchMock)
    await getCatalog('owner/repo')

    clock.mockReturnValue(now + REGISTRY_CACHE_TTL_MS + 1)
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    const stale = await getCatalog('owner/repo')
    expect(stale.entries).toHaveLength(1)
    expect(stale.stale).toBe(true)
    expect(stale.fetchedAt).toBe(now)
  })

  it('uses only an exact fresh cache and retains provenance', async () => {
    const fetchMock = vi.fn().mockResolvedValue(catalog())
    vi.stubGlobal('fetch', fetchMock)
    const first = await getCatalog('owner/repo')
    const second = await getCatalog('owner/repo')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(second).toEqual(first)
    expect(second).toMatchObject({
      sourceRepo: 'owner/repo',
      sourceUrl: 'https://raw.githubusercontent.com/owner/repo/main/registry/modules.json',
      stale: false
    })
  })

  it('drops removed entries after a successful forced refresh', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(catalog())
      .mockResolvedValueOnce(catalog([]))
    vi.stubGlobal('fetch', fetchMock)
    expect((await getCatalog('owner/repo')).entries).toHaveLength(1)
    expect((await getCatalog('owner/repo', true)).entries).toEqual([])
    expect((await getCatalog('owner/repo')).entries).toEqual([])
  })
})
