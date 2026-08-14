#!/usr/bin/env node
// Compile every shipped module's main half with the app's own compiler, so a
// disallowed import or a syntax error shows up here instead of at activation.
//
// Usage: npx tsx scripts/compile-modules.mjs
import { existsSync, readdirSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { compileModuleAt } from '../server/services/module-compiler.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let failed = 0
for (const entry of readdirSync(join(repoRoot, 'modules'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const dir = join(repoRoot, 'modules', entry.name)
  if (!existsSync(join(dir, 'module.json'))) continue
  try {
    await compileModuleAt(dir, join(dir, '.dist', 'main.mjs'))
    console.log(`ok ${entry.name}`)
  } catch (err) {
    failed++
    console.error(`${entry.name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

if (failed) process.exit(1)
