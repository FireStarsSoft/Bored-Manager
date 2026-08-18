#!/usr/bin/env node
// Record the version and hash of every module that ships with the app, into
// modules/modules.lock.json.
//
// The lock file answers two questions the app cannot answer on its own:
//
//   - which modules are "built in" (present in the lock) versus installed by
//     the user, which decides whether uninstalling one warns that the app
//     cannot put it back;
//   - what the files hashed to when the release was built, so a first start
//     can tell an untouched install from a modified one.
//
// Usage:
//   node scripts/modules-lock.mjs           write the lock file
//   node scripts/modules-lock.mjs --check   verify it matches, exit 1 if not
//
// The hash has to match server/services/modules-host.ts exactly: SHA-256 over
// every file in the module folder except `.dist/` (esbuild output, rebuilt on
// demand - see module-compiler.ts), sorted by relative path, hashing the path
// (NUL-terminated) before its bytes. CR bytes are dropped first so a Windows
// checkout and a Linux release hash the same.
import { createHash } from 'crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { dirname, join, relative, resolve, sep } from 'path'
import { fileURLToPath } from 'url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const modulesDir = join(repoRoot, 'modules')
const lockFile = join(modulesDir, 'modules.lock.json')
const check = process.argv.includes('--check')

/**
 * Modules compiled into the app but not treated as built-in (disabled by
 * default). Empty since Phase 3: Docker used to be excluded because shipping
 * it meant compiling it into the bundle whether anyone wanted it or not; now
 * every module is just a folder read at runtime, so it is as "built-in" as
 * any other default module - it simply starts disabled (module.json
 * defaultEnabled: false).
 */
const LOCK_EXCLUDE = new Set()

function listFiles(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.dist') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) listFiles(path, base, out)
    else if (entry.isFile()) out.push(relative(base, path).split(sep).join('/'))
  }
  return out
}

/** Drop CR so a Windows checkout hashes the same as Linux / a release zip. */
function fileBytesForHash(path) {
  const buf = readFileSync(path)
  return buf.includes(0x0d) ? Buffer.from(buf.filter((b) => b !== 0x0d)) : buf
}

function folderHash(dir) {
  const hash = createHash('sha256')
  for (const rel of listFiles(dir).sort()) {
    hash.update(rel)
    hash.update('\0')
    hash.update(fileBytesForHash(join(dir, rel)))
  }
  return hash.digest('hex')
}

if (!existsSync(modulesDir)) {
  console.error(`ERROR: ${modulesDir} does not exist.`)
  process.exit(1)
}

const modules = {}
const problems = []
for (const entry of readdirSync(modulesDir, { withFileTypes: true }).sort((a, b) =>
  a.name.localeCompare(b.name)
)) {
  if (!entry.isDirectory()) continue
  if (LOCK_EXCLUDE.has(entry.name)) continue
  const dir = join(modulesDir, entry.name)
  const manifestPath = join(dir, 'module.json')
  if (!existsSync(manifestPath)) {
    problems.push(`${entry.name}/ has no module.json`)
    continue
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (err) {
    problems.push(`${entry.name}/module.json is not valid JSON: ${err.message}`)
    continue
  }
  if (manifest.id !== entry.name) {
    problems.push(`${entry.name}/module.json declares id "${manifest.id}"`)
    continue
  }
  modules[entry.name] = { version: manifest.version, hash: folderHash(dir) }
}

if (problems.length) {
  console.error('ERROR: the modules folder is not consistent:')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}

const lock = { version: 1, modules }
const json = JSON.stringify(lock, null, 2) + '\n'

if (check) {
  const current = existsSync(lockFile) ? readFileSync(lockFile, 'utf8') : ''
  if (current !== json) {
    console.error('ERROR: modules/modules.lock.json is out of date.')
    console.error('       Run: node scripts/modules-lock.mjs')
    process.exit(1)
  }
  console.log(`modules.lock.json is up to date (${Object.keys(modules).length} modules).`)
} else {
  writeFileSync(lockFile, json, 'utf8')
  console.log(`Wrote ${lockFile}`)
  for (const [id, m] of Object.entries(modules)) {
    console.log(`  ${id.padEnd(12)} ${m.version.padEnd(8)} ${m.hash.slice(0, 12)}…`)
  }
}
