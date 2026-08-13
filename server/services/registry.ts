import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ModuleCatalog, RegistryEntry, RegistryFile } from '@shared/modules'
import { REGISTRY_VERSION } from '@shared/modules'
import { log } from '../log'
import { dataDir } from './store'

/**
 * The community catalog of reviewed modules: `registry/modules.json` on the
 * `main` branch of the configured update repo, cached locally so that every
 * module install/validate does not need a network round trip. See
 * module-installer.ts for how an archive's hash is checked against it, and
 * registry/README.md for the file's schema.
 */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000

const EMPTY_REGISTRY: RegistryFile = { registryVersion: REGISTRY_VERSION, modules: [] }

interface RegistryCache {
  fetchedAt: number
  url: string
  payload: RegistryFile
}

function cacheFile(): string {
  return join(dataDir(), 'registry-cache.json')
}

function registryUrl(repo: string): string {
  return `https://raw.githubusercontent.com/${repo}/main/registry/modules.json`
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * A community entry only needs to be trustworthy about the fields the
 * installer and the catalog UI actually act on; everything else falls back
 * to something harmless rather than dropping the whole entry, so one
 * malformed field in the catalog does not hide every module after it.
 */
function normalizeEntry(raw: unknown): RegistryEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const e = raw as Partial<RegistryEntry>
  if (typeof e.id !== 'string' || !e.id) return null
  if (typeof e.version !== 'string' || !e.version) return null
  if (typeof e.download !== 'string' || !e.download) return null
  if (typeof e.sha256 !== 'string' || !e.sha256) return null
  return {
    id: e.id,
    name: typeof e.name === 'string' && e.name ? e.name : e.id,
    description: typeof e.description === 'string' ? e.description : '',
    author: typeof e.author === 'string' ? e.author : '',
    homepage: typeof e.homepage === 'string' && e.homepage ? e.homepage : undefined,
    version: e.version,
    minAppVersion:
      typeof e.minAppVersion === 'string' && e.minAppVersion ? e.minAppVersion : undefined,
    download: e.download,
    sha256: e.sha256,
    verifiedAt: typeof e.verifiedAt === 'string' ? e.verifiedAt : ''
  }
}

/**
 * A payload that is not shaped like the schema this app reads is treated as
 * an empty catalog rather than an error - a stale/broken registry file must
 * never make module installs fail, only leave everything unverified.
 */
function parsePayload(raw: unknown): RegistryFile {
  if (typeof raw !== 'object' || raw === null) {
    log('[registry] catalog payload is not an object - treating it as empty')
    return EMPTY_REGISTRY
  }
  const r = raw as Partial<RegistryFile>
  if (r.registryVersion !== REGISTRY_VERSION) {
    log(
      `[registry] catalog registryVersion is ${JSON.stringify(r.registryVersion)}, this app reads ${REGISTRY_VERSION} - treating it as empty`
    )
    return EMPTY_REGISTRY
  }
  const modules = Array.isArray(r.modules)
    ? r.modules.map(normalizeEntry).filter((e): e is RegistryEntry => e !== null)
    : []
  return { registryVersion: REGISTRY_VERSION, modules }
}

function readCache(): RegistryCache | null {
  try {
    if (!existsSync(cacheFile())) return null
    const raw = JSON.parse(readFileSync(cacheFile(), 'utf8')) as Partial<RegistryCache>
    if (typeof raw.url !== 'string' || typeof raw.fetchedAt !== 'number' || !raw.payload) return null
    return { fetchedAt: raw.fetchedAt, url: raw.url, payload: parsePayload(raw.payload) }
  } catch {
    return null
  }
}

function writeCache(cache: RegistryCache): void {
  try {
    mkdirSync(dataDir(), { recursive: true })
    writeFileSync(cacheFile(), JSON.stringify(cache, null, 2), 'utf8')
  } catch {
    /* a read-only data folder must not stop the catalog from working this run */
  }
}

/**
 * The catalog for `repo`: from cache when it matches that repo's URL and is
 * younger than the TTL, otherwise freshly fetched. `force` skips the TTL
 * check (used by `modules:catalogRefresh`) but not the network - a failed
 * fetch still falls back to whatever is cached, even a stale or
 * different-repo copy, because "possibly out of date" beats "no catalog at
 * all" for deciding whether an archive is verified. `stale` tells the caller
 * which one happened.
 */
export async function getCatalog(repo: string, force = false): Promise<ModuleCatalog> {
  const url = registryUrl(repo)
  const cache = readCache()
  const fresh = !!cache && cache.url === url && Date.now() - cache.fetchedAt < CACHE_TTL_MS
  if (!force && cache && fresh) {
    return { entries: cache.payload.modules, fetchedAt: cache.fetchedAt, stale: false }
  }

  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'bored-manager' } })
    if (!res.ok) throw new Error(`GitHub returned ${res.status} for ${url}`)
    const payload = parsePayload(await res.json())
    const fetchedAt = Date.now()
    writeCache({ fetchedAt, url, payload })
    return { entries: payload.modules, fetchedAt, stale: false }
  } catch (err) {
    log(`[registry] could not fetch the module catalog: ${message(err)}`)
    if (cache) return { entries: cache.payload.modules, fetchedAt: cache.fetchedAt, stale: true }
    return { entries: [], fetchedAt: null, stale: true }
  }
}
