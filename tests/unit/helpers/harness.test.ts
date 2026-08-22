import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeExecutor } from '../../helpers/fake-executor'
import { withFakeClock } from '../../helpers/fake-clock'
import { createTestTempDir } from '../../helpers/temp-dir'

describe('test harness helpers', () => {
  it('uses and removes an OS temp directory', () => {
    const dir = createTestTempDir('helper')
    const file = join(dir.path, 'fixture.txt')
    writeFileSync(file, 'fixture', 'utf8')
    expect(existsSync(file)).toBe(true)
    dir.cleanup()
    expect(existsSync(dir.path)).toBe(false)
  })

  it('restores fake time after an action', async () => {
    const before = Date.now()
    await withFakeClock('2025-01-02T03:04:05Z', () => {
      expect(new Date().toISOString()).toBe('2025-01-02T03:04:05.000Z')
    })
    expect(Date.now()).toBeGreaterThanOrEqual(before)
  })

  it('records injected executor calls without running commands', async () => {
    const executor = new FakeExecutor((command) => ({
      stdout: `fake:${command}`,
      stderr: '',
      code: 0
    }))
    await expect(executor.exec('uname -a', { timeoutMs: 100 })).resolves.toMatchObject({
      stdout: 'fake:uname -a',
      code: 0
    })
    expect(executor.execCalls).toEqual([
      { command: 'uname -a', options: { timeoutMs: 100 } }
    ])
  })
})
