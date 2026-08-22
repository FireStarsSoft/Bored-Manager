import { join } from 'path'
import type { ModuleCatalog, RegistryEntry, RegistryFile } from '@shared/modules'
import {
  MODULE_ID_PATTERN,
  MODULE_VERSION_PATTERN,
  REGISTRY_VERSION
} from '@shared/modules'
import { isRecord } from '@shared/validation'
import { log } from '../log'
import { isGithubRepoName } from './github'
import { readPrivateJson, writeAtomicPrivateJson } from './private-file'
import { dataDir } from './store'

export const REGISTRY_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const REGISTRY_CACHE_VERSION = 1
const SHA256_PATTERN = /^[0-9a-f]{64}$/

const EMPTY_REGISTRY: RegistryFile = { registryVersion: REGISTRY_VERSION, modules: [] }

interface RegistryCache {
  version: typeof REGISTRY_CACHE_VERSION
  sourceRepo: string
  sourceUrl: string
  fetchedAt: number
  payload: RegistryFile
}

function cacheFile(): string {
  return join(dataDir(), 'registry-cache.json')
}

export function registryUrl(repo: string): string {
  if (!isGithubRepoName(repo)) throw new Error(`"${repo}" is not a valid GitHub repository`)
  return `https://raw.githubusercontent.com/${repo}/main/registry/modules.json`
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeEntry(raw: unknown): RegistryEntry | null {
  if (!isRecord(raw)) return null
  if (typeof raw['id'] !== 'string' || !MODULE_ID_PATTERN.test(raw['id'])) return null
  if (
    typeof raw['version'] !== 'string' ||
    !MODULE_VERSION_PATTERN.test(raw['version'])
  ) {
    return null
  }
  if (typeof raw['download'] !== 'string' || !raw['download']) return null
  if (
    typeof raw['sha256'] !== 'string' ||
    !SHA256_PATTERN.test(raw['sha256'].toLowerCase())
  ) {
    return null
  }
  return {
    id: raw['id'],
    name: typeof raw['name'] === 'string' && raw['name'] ? raw['name'] : raw['id'],
    description: typeof raw['description'] === 'string' ? raw['description'] : '',
    author: typeof raw['author'] === 'string' ? raw['author'] : '',
    homepage:
      typeof raw['homepage'] === 'string' && raw['homepage'] ? raw['homepage'] : undefined,
    version: raw['version'],
    minAppVersion:
      typeof raw['minAppVersion'] === 'string' &&
      MODULE_VERSION_PATTERN.test(raw['minAppVersion'])
        ? raw['minAppVersion']
        : undefined,
    download: raw['download'],
    sha256: raw['sha256'].toLowerCase(),
    verifiedAt: typeof raw['verifiedAt'] === 'string' ? raw['verifiedAt'] : ''
  }
}

function parsePayload(raw: unknown): RegistryFile {
  if (!isRecord(raw) || raw['registryVersion'] !== REGISTRY_VERSION) {
    log('[registry] catalog schema is unsupported - treating it as empty')
    return EMPTY_REGISTRY
  }
  if (!Array.isArray(raw['modules'])) {
    log('[registry] catalog modules is not an array - treating it as empty')
    return EMPTY_REGISTRY
  }
  const modules = raw['modules']
    .map(normalizeEntry)
    .filter((entry): entry is RegistryEntry => entry !== null)
  return { registryVersion: REGISTRY_VERSION, modules }
}

function parseCache(raw: unknown): RegistryCache {
  if (!isRecord(raw)) throw new Error('cache is not an object')
  if (raw['version'] !== REGISTRY_CACHE_VERSION) throw new Error('cache version is unsupported')
  if (typeof raw['sourceRepo'] !== 'string' || !isGithubRepoName(raw['sourceRepo'])) {
    throw new Error('cache repository is invalid')
  }
  if (typeof raw['sourceUrl'] !== 'string') throw new Error('cache URL is invalid')
  if (
    typeof raw['fetchedAt'] !== 'number' ||
    !Number.isSafeInteger(raw['fetchedAt']) ||
    raw['fetchedAt'] < 0
  ) {
    throw new Error('cache timestamp is invalid')
  }
  const expectedUrl = registryUrl(raw['sourceRepo'])
  if (raw['sourceUrl'] !== expectedUrl) throw new Error('cache repository and URL disagree')
  return {
    version: REGISTRY_CACHE_VERSION,
    sourceRepo: raw['sourceRepo'],
    sourceUrl: raw['sourceUrl'],
    fetchedAt: raw['fetchedAt'],
    payload: parsePayload(raw['payload'])
  }
}

function readCache(): RegistryCache | null {
  try {
    const result = readPrivateJson(cacheFile(), parseCache, 'module registry cache')
    return result.kind === 'missing' ? null : result.value
  } catch (error) {
    log(`[registry] ignored an invalid catalog cache: ${message(error)}`)
    return null
  }
}

function writeCache(cache: RegistryCache): void {
  try {
    writeAtomicPrivateJson(cacheFile(), cache)
  } catch (error) {
    log(`[registry] could not persist the catalog cache: ${message(error)}`)
  }
}

function response(
  repo: string,
  url: string,
  entries: RegistryEntry[],
  fetchedAt: number | null,
  stale: boolean
): ModuleCatalog {
  return { entries, sourceRepo: repo, sourceUrl: url, fetchedAt, stale }
}

/**
 * Fetch or show a cache only when both repository and derived URL match the
 * exact request. A stale same-source cache remains useful to the catalog UI,
 * but `stale: true` prevents it from granting installer verification.
 */
export async function getCatalog(repo: string, force = false): Promise<ModuleCatalog> {
  const sourceRepo = repo.trim()
  const sourceUrl = registryUrl(sourceRepo)
  const cache = readCache()
  const matchingCache =
    cache?.sourceRepo === sourceRepo && cache.sourceUrl === sourceUrl ? cache : null
  const age = matchingCache ? Date.now() - matchingCache.fetchedAt : Number.POSITIVE_INFINITY
  const fresh = age >= 0 && age < REGISTRY_CACHE_TTL_MS
  if (!force && matchingCache && fresh) {
    return response(
      sourceRepo,
      sourceUrl,
      matchingCache.payload.modules,
      matchingCache.fetchedAt,
      false
    )
  }

  try {
    const fetchResponse = await fetch(sourceUrl, {
      headers: { 'User-Agent': 'bored-manager' },
      signal: AbortSignal.timeout(15_000)
    })
    if (!fetchResponse.ok) {
      throw new Error(`GitHub returned ${fetchResponse.status} for ${sourceUrl}`)
    }
    let raw: unknown
    try {
      raw = await fetchResponse.json()
    } catch {
      throw new Error('GitHub returned malformed catalog JSON')
    }
    const payload = parsePayload(raw)
    const fetchedAt = Date.now()
    writeCache({
      version: REGISTRY_CACHE_VERSION,
      sourceRepo,
      sourceUrl,
      fetchedAt,
      payload
    })
    return response(sourceRepo, sourceUrl, payload.modules, fetchedAt, false)
  } catch (error) {
    log(`[registry] could not fetch the module catalog: ${message(error)}`)
    if (matchingCache) {
      return response(
        sourceRepo,
        sourceUrl,
        matchingCache.payload.modules,
        matchingCache.fetchedAt,
        true
      )
    }
    return response(sourceRepo, sourceUrl, [], null, true)
  }
}
