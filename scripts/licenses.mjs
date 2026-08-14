#!/usr/bin/env node
// Write src/generated/licenses.json from the production dependencies listed
// in package.json. The About card in Settings imports that file so the UI
// can name every library that actually ships with the app - not the
// transitive tree, and not devDependencies.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const pkgPath = join(repoRoot, 'package.json')
const nodeModules = join(repoRoot, 'node_modules')
const outDir = join(repoRoot, 'src', 'generated')
const outFile = join(outDir, 'licenses.json')

if (!existsSync(nodeModules)) {
  console.error('ERROR: node_modules is missing - run npm install first')
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const names = Object.keys(pkg.dependencies ?? {}).sort((a, b) => a.localeCompare(b))

function licenseOf(meta) {
  if (typeof meta.license === 'string' && meta.license.trim()) return meta.license.trim()
  if (meta.license && typeof meta.license === 'object' && typeof meta.license.type === 'string') {
    return meta.license.type
  }
  if (Array.isArray(meta.licenses)) {
    return meta.licenses
      .map((entry) => (typeof entry === 'string' ? entry : entry?.type))
      .filter(Boolean)
      .join(' OR ')
  }
  return ''
}

const rows = []
for (const name of names) {
  const metaPath = join(nodeModules, name, 'package.json')
  if (!existsSync(metaPath)) {
    console.error(`ERROR: ${name} is not in node_modules - run npm install first`)
    process.exit(1)
  }
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  rows.push({
    name,
    version: typeof meta.version === 'string' ? meta.version : '',
    license: licenseOf(meta),
    homepage: typeof meta.homepage === 'string' ? meta.homepage : ''
  })
}

mkdirSync(outDir, { recursive: true })
writeFileSync(outFile, `${JSON.stringify(rows, null, 2)}\n`)
console.log(`wrote ${rows.length} packages to ${outFile}`)
