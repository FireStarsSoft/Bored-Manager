/**
 * Resolving a GitHub repo to a downloadable zip. Shared by the app updater
 * (`updater.ts`, a fixed asset name pattern) and the module installer
 * (`module-installer.ts`, any single zip asset) - both need "latest release,
 * falling back to the source of the default branch" and neither should
 * reimplement the GitHub API calls.
 */

const GITHUB_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

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
  return { 'User-Agent': 'bored-manager' }
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

/** Source zip of the repo's default branch - always resolvable, release or not. */
export async function defaultBranchZipUrl(repo: string): Promise<string> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}`, { headers: githubHeaders() })
    if (res.ok) {
      const body = (await res.json()) as { default_branch?: string }
      if (typeof body.default_branch === 'string' && body.default_branch) {
        return `https://codeload.github.com/${repo}/zip/refs/heads/${body.default_branch}`
      }
    }
  } catch {
    /* fall through to the common default below */
  }
  return `https://codeload.github.com/${repo}/zip/refs/heads/main`
}

export interface GithubReleaseZip {
  url: string
  /** tag_name with a leading "v" stripped, "" when the release did not set one */
  version: string
  notes?: string
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
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: githubHeaders()
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GitHub returned ${res.status} for ${repo}`)
  const body = (await res.json()) as {
    tag_name?: string
    body?: string
    assets?: Array<{ name?: string; browser_download_url?: string }>
  }
  const version = String(body.tag_name ?? '').replace(/^v/i, '')
  const asset = (body.assets ?? []).find((a) => pickAsset(a.name ?? ''))
  const url = asset?.browser_download_url ?? (await defaultBranchZipUrl(repo))
  return { url, version, notes: typeof body.body === 'string' ? body.body : undefined }
}
