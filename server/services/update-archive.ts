import { createHash } from 'crypto'
import { createReadStream, lstatSync, readFileSync, readdirSync } from 'fs'
import { join, relative, sep } from 'path'
import { MODULE_VERSION_PATTERN, compareVersions } from '@shared/modules'
import type { UpdateCheckItem, UpdateValidation } from '@shared/types'
import { isRecord } from '@shared/validation'

export const REQUIRED_UPDATE_ENTRIES: ReadonlyArray<{ path: string; directory?: boolean }> = [
  { path: 'package.json' },
  { path: 'package-lock.json' },
  { path: 'vite.config.ts' },
  { path: 'vite.config.server.ts' },
  { path: 'server/index.ts' },
  { path: 'server/ipc.ts' },
  { path: 'shared/types.ts' },
  { path: 'shared/modules.ts' },
  { path: 'src', directory: true },
  { path: 'src/index.html' },
  { path: 'modules', directory: true },
  { path: 'assets/icon.png' },
  { path: 'run.sh' },
  { path: 'install.sh' },
  { path: 'bored-manager' },
  { path: 'scripts/update.sh' }
]

export interface StructuralUpdateResult {
  /** Structural checks do not establish publisher identity or signed provenance. */
  provenance: 'structural-only'
  validation: UpdateValidation
}

export interface StructuralUpdateOptions {
  currentVersion: string
  checksumVerified?: boolean
}

function regularEntry(root: string, path: string, directory: boolean): boolean {
  try {
    const stat = lstatSync(join(root, path))
    if (stat.isSymbolicLink()) return false
    return directory ? stat.isDirectory() : stat.isFile()
  } catch {
    return false
  }
}

/** Reusable Node-side structural validation for WebUI today and CLI/shell later. */
export function validateUpdateTree(
  root: string | null,
  options: StructuralUpdateOptions
): StructuralUpdateResult {
  const checks: UpdateCheckItem[] = []
  const warnings = [
    'Structural validation does not prove publisher identity or signed provenance'
  ]
  if (!root) {
    checks.push({
      id: 'archive',
      label: 'Archive contains an app folder',
      ok: false,
      detail: 'No package.json was found at the archive root or its only top-level folder'
    })
    return {
      provenance: 'structural-only',
      validation: {
        status: 'error',
        currentVersion: options.currentVersion,
        checks,
        warnings
      }
    }
  }
  checks.push({ id: 'archive', label: 'Archive contains an app folder', ok: true })

  let manifest: Record<string, unknown> | null = null
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as unknown
    if (!isRecord(parsed)) throw new Error('package.json is not an object')
    manifest = parsed
    checks.push({ id: 'manifest', label: 'package.json is readable', ok: true })
  } catch {
    checks.push({
      id: 'manifest',
      label: 'package.json is readable',
      ok: false,
      detail: 'package.json is missing, malformed, or not an object'
    })
  }

  const name = manifest?.['name']
  checks.push({
    id: 'identity',
    label: 'Archive identifies exactly as Bored Manager',
    ok: name === 'bored-manager',
    detail: name === 'bored-manager' ? undefined : 'package.json name must be "bored-manager"'
  })

  const newVersion = typeof manifest?.['version'] === 'string' ? manifest['version'] : undefined
  const versionOk = newVersion !== undefined && MODULE_VERSION_PATTERN.test(newVersion)
  checks.push({
    id: 'version',
    label: 'Version is exact x.y.z semver',
    ok: versionOk,
    detail: versionOk
      ? `${options.currentVersion} -> ${newVersion}`
      : 'package.json version must contain only three numeric components'
  })
  if (versionOk && compareVersions(newVersion, options.currentVersion) <= 0) {
    warnings.push(
      compareVersions(newVersion, options.currentVersion) === 0
        ? `The archive has the installed version (${options.currentVersion})`
        : `The archive is older than the installed app (${newVersion} < ${options.currentVersion})`
    )
  }

  const missing = REQUIRED_UPDATE_ENTRIES.filter(
    (entry) => !regularEntry(root, entry.path, entry.directory === true)
  ).map((entry) => entry.path)
  checks.push({
    id: 'files',
    label: `Required regular files and directories are present (${REQUIRED_UPDATE_ENTRIES.length} checked)`,
    ok: missing.length === 0,
    detail: missing.length ? `missing or wrong type: ${missing.join(', ')}` : undefined
  })

  const scripts = isRecord(manifest?.['scripts']) ? manifest['scripts'] : {}
  const devDependencies = isRecord(manifest?.['devDependencies'])
    ? manifest['devDependencies']
    : {}
  const missingTools: string[] = []
  if (typeof scripts['build'] !== 'string' || !scripts['build']) missingTools.push('scripts.build')
  if (typeof devDependencies['vite'] !== 'string' || !devDependencies['vite']) {
    missingTools.push('devDependencies.vite')
  }
  if (typeof devDependencies['typescript'] !== 'string' || !devDependencies['typescript']) {
    missingTools.push('devDependencies.typescript')
  }
  checks.push({
    id: 'toolchain',
    label: 'Build toolchain is declared',
    ok: missingTools.length === 0,
    detail: missingTools.length ? `missing: ${missingTools.join(', ')}` : undefined
  })

  if (options.checksumVerified === true) {
    checks.push({
      id: 'checksum',
      label: 'SHA-256 matches the same-source sidecar',
      ok: true
    })
  } else {
    warnings.push('No valid same-source SHA-256 sidecar was available')
  }

  return {
    provenance: 'structural-only',
    validation: {
      status: checks.every((check) => check.ok) ? 'pass' : 'error',
      currentVersion: options.currentVersion,
      newVersion,
      checks,
      warnings
    }
  }
}

function listTreeFiles(root: string, directory = root, output: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error('staged update contains a symbolic link')
    if (entry.isDirectory()) listTreeFiles(root, full, output)
    else if (entry.isFile()) output.push(relative(root, full).split(sep).join('/'))
    else throw new Error('staged update contains a special file')
  }
  return output
}

/** Exact path-and-byte digest; no line-ending or metadata normalization. */
export async function digestUpdateTree(root: string): Promise<string> {
  const hash = createHash('sha256')
  for (const path of listTreeFiles(root).sort()) {
    hash.update(path)
    hash.update('\0')
    for await (const chunk of createReadStream(join(root, ...path.split('/')))) {
      hash.update(chunk as Buffer)
    }
    hash.update('\0')
  }
  return hash.digest('hex')
}
