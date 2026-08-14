#!/usr/bin/env node
// Run every shipped module's ui/*.json through the same validator the installer
// uses, so a spec that names a method or stream the manifest does not declare is
// caught here instead of on the page.
//
// Usage: npx tsx scripts/check-specs.mjs   (tsx, because the validator is TS)
import { existsSync, readFileSync, readdirSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { specProblems } from '../shared/module-ui.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let failed = 0
for (const entry of readdirSync(join(repoRoot, 'modules'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const dir = join(repoRoot, 'modules', entry.name)
  const manifestPath = join(dir, 'module.json')
  if (!existsSync(manifestPath)) continue
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const kind of ['pages', 'widgets']) {
    const specDir = join(dir, 'ui', kind)
    if (!existsSync(specDir)) continue
    for (const file of readdirSync(specDir)) {
      if (!file.endsWith('.json')) continue
      const where = `${entry.name}/ui/${kind}/${file}`
      let spec
      try {
        spec = JSON.parse(readFileSync(join(specDir, file), 'utf8'))
      } catch (err) {
        console.error(`${where}: not valid JSON: ${err.message}`)
        failed++
        continue
      }
      const problems = specProblems(spec, manifest)
      if (problems.length) {
        failed++
        console.error(`${where}:`)
        for (const problem of problems) console.error(`  - ${problem}`)
      } else {
        console.log(`ok ${where}`)
      }
    }
  }
}

if (failed) {
  console.error(`\n${failed} spec file(s) have problems.`)
  process.exit(1)
}
