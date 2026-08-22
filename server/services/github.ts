/**
 * Resolving a GitHub repo to a downloadable zip. Shared by the app updater
 * (`updater.ts`, a fixed asset name pattern) and the module installer
 * (`module-installer.ts`, any single zip asset) - both need "latest release,
 * falling back to the source of the default branch" and neither should
 * reimplement the GitHub API calls.
 */

const GITHUB_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
export const GITHUB_API_TIMEOUT_MS = 15_000
export const GITHUB_API_MAX_BYTES = 4 * 1024 * 1024

export function isGithubRepoName(value: string): boolean {
  return GITHUB_REPO_PATTERN.test(value)
}

/**
 * `owner/repo` as-is; a `github.com/owner/repo[.git][/...]` URL (with or
 * without a scheme) has the two path segments pulled out. Anything else is
 * not a GitHub repo reference, and this returns null rather than guessing.
 */
export function parseGithubRepo(input: string): string | null {
  const trimmed = input.trim()
  if (isGithubRepoName(trimmed)) return trimmed
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
    if (!/(^|\.)github\.com$/i.test(url.hostname)) return null
    const [owner, repo] = url.pathname.split('/').filter(Boolean)
    if (!owner || !repo) return null
    const name = `${owner}/${repo.replace(/\.git$/i, '')}`
    return isGithubRepoName(name) ? name : null
  } catch {
    return null
  }
}

function githubHeaders(): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'bored-manager',
    'X-GitHub-Api-Version': '2022-11-28'
  }
}

async function githubBody(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    if (!/^(0|[1-9]\d*)$/.test(declared) || Number(declared) > GITHUB_API_MAX_BYTES) {
      throw new Error('GitHub response exceeds the API byte limit')
    }
  }
  if (!response.body) return null

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > GITHUB_API_MAX_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error('GitHub response exceeds the API byte limit')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString('utf8')
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('GitHub returned malformed JSON')
  }
}

async function githubFailure(response: Response, repo: string, operation: string): Promise<Error> {
  let detail = ''
  try {
    const body = await githubBody(response)
    if (
      typeof body === 'object' &&
      body !== null &&
      'message' in body &&
      typeof body.message === 'string' &&
      body.message.trim()
    ) {
      detail = `: ${body.message.trim()}`
    }
  } catch {
    /* status and headers still provide a useful error */
  }
  const remaining = response.headers.get('x-ratelimit-remaining')
  const reset = response.headers.get('x-ratelimit-reset')
  const rate =
    (response.status === 403 || response.status === 429) && remaining === '0'
      ? ` (GitHub API rate limit exhausted${reset ? `; reset ${reset}` : ''})`
      : ''
  return new Error(`GitHub ${operation} failed for ${repo}: ${response.status}${detail}${rate}`)
}

async function githubJson<T>(repo: string, path: string, operation: string): Promise<T | null> {
  if (!isGithubRepoName(repo)) throw new Error(`"${repo}" is not a valid GitHub repository`)
  const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    headers: githubHeaders(),
    signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS)
  })
  if (response.status === 404) return null
  if (!response.ok) throw await githubFailure(response, repo, operation)
  try {
    return (await githubBody(response)) as T
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`GitHub response failed while trying to ${operation} for ${repo}: ${detail}`)
  }
}

/**
 * True for a URL that serves a zip: either a literal `.zip` path, or
 * codeload's own shape, where the format is a path segment rather than an
 * extension (`codeload.github.com/<owner>/<repo>/zip/<ref>`) - the reliable
 * way to fetch a repo archive server-side; `github.com/.../archive/*.zip`
 * needs a browser session and does not answer a plain fetch.
 */
export function looksLikeZipUrl(url: URL): boolean {
  if (url.pathname.toLowerCase().endsWith('.zip')) return true
  return url.hostname === 'codeload.github.com' && /\/zip\//i.test(url.pathname)
}

/** Source zip of the repository's declared default branch. */
export async function defaultBranchZipUrl(repo: string): Promise<string> {
  const body = await githubJson<{ default_branch?: unknown }>(
    repo,
    '',
    'default-branch lookup'
  )
  if (!body) throw new Error(`GitHub repository ${repo} was not found`)
  if (typeof body.default_branch !== 'string' || !body.default_branch.trim()) {
    throw new Error(`GitHub did not provide a default branch for ${repo}`)
  }
  return `https://codeload.github.com/${repo}/zip/refs/heads/${encodeURIComponent(body.default_branch)}`
}

export interface GithubReleaseZip {
  url: string
  /** tag_name with a leading "v" stripped, "" when the release did not set one */
  version: string
  notes?: string
  /** True when `pickAsset` found a release asset; false when `url` is the branch zip. */
  matched: boolean
}

/**
 * The latest release's zip, or null when the repo has no release yet (not an
 * error - the caller falls back to `defaultBranchZipUrl`). `pickAsset`
 * chooses which attached asset is the right one; a release with no matching
 * asset still resolves (to the default branch's source zip) rather than
 * being treated as "no release".
 */
export async function latestReleaseZip(
  repo: string,
  pickAsset: (assetName: string) => boolean = (name) => name.toLowerCase().endsWith('.zip')
): Promise<GithubReleaseZip | null> {
  const body = await githubJson<{
    tag_name?: unknown
    body?: unknown
    assets?: unknown
  }>(repo, '/releases/latest', 'latest-release lookup')
  if (!body) return null
  const assets = Array.isArray(body.assets)
    ? (body.assets as Array<{ name?: unknown; browser_download_url?: unknown }>)
    : []
  const matches = assets.filter(
    (asset) => typeof asset.name === 'string' && pickAsset(asset.name)
  )
  if (matches.length > 1) {
    const names = matches.map((asset) => String(asset.name)).join(', ')
    throw new Error(`GitHub release for ${repo} has multiple matching ZIP assets: ${names}`)
  }
  const version = typeof body.tag_name === 'string' ? body.tag_name.replace(/^v/i, '') : ''
  const notes = typeof body.body === 'string' ? body.body : undefined
  const asset = matches[0]
  if (asset) {
    if (
      typeof asset.browser_download_url !== 'string' ||
      !asset.browser_download_url.trim()
    ) {
      throw new Error(`matching GitHub release asset "${String(asset.name)}" has no download URL`)
    }
    return { url: asset.browser_download_url, version, notes, matched: true }
  }
  return { url: await defaultBranchZipUrl(repo), version, notes, matched: false }
}
