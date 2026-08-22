import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetSecretKeyCacheForTests, ensureSecretKey } from '../../../server/services/secret'
import { resetStoreCacheForTests } from '../../../server/services/store'
import { createTestTempDir, type TestTempDir } from '../../helpers/temp-dir'

const execFileAsync = promisify(execFile)

describe.sequential('secret key persistence', () => {
  let temp: TestTempDir

  beforeEach(() => {
    temp = createTestTempDir('secret')
    vi.stubEnv('BM_APP_ROOT', temp.path)
    resetStoreCacheForTests()
    resetSecretKeyCacheForTests()
  })

  afterEach(() => {
    resetSecretKeyCacheForTests()
    resetStoreCacheForTests()
    temp.cleanup()
  })

  it('uses exclusive creation safely across racing processes', async () => {
    const source =
      "import { ensureSecretKey } from './server/services/secret.ts';" +
      "process.stdout.write(ensureSecretKey().toString('hex'))"
    const run = () =>
      execFileAsync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', source],
        {
          cwd: process.cwd(),
          env: { ...process.env, BM_APP_ROOT: temp.path }
        }
      )

    const results = await Promise.all([run(), run(), run(), run()])
    const keys = results.map(({ stdout }) => stdout.trim())
    expect(new Set(keys).size).toBe(1)
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(join(temp.path, 'data', 'secret.key')).toString('hex')).toBe(keys[0])
  }, 20_000)

  it('preserves and rejects a malformed existing key', () => {
    const file = join(temp.path, 'data', 'secret.key')
    mkdirSync(join(temp.path, 'data'), { recursive: true })
    const malformed = Buffer.from([1, 2, 3, 4])
    writeFileSync(file, malformed)

    expect(() => ensureSecretKey()).toThrow(/malformed or unreadable/)
    expect(readFileSync(file)).toEqual(malformed)
  })
})
