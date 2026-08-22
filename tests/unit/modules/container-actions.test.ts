import { describe, expect, it } from 'vitest'
import { moduleHarness } from '../../helpers/module-harness'
import { IncusCli } from '../../../modules/container/main/incus'
import { RuntimeInstaller } from '../../../modules/container/main/install'
import { ContainerService } from '../../../modules/container/main/service'

describe('container refuse-unknown', () => {
  it('refuses a bad docker id and an unknown action without exec', async () => {
    const harness = moduleHarness('container', () => ({ stdout: '', stderr: '', code: 0 }))
    const service = new ContainerService(harness.ctx)
    await expect(service.containerAction('abc; rm -rf /', 'kill')).resolves.toEqual({
      ok: false,
      error: 'invalid container id'
    })
    await expect(service.containerAction('ok', 'rm -rf' as 'kill')).resolves.toEqual({
      ok: false,
      error: 'invalid container action'
    })
    expect(harness.exec).not.toHaveBeenCalled()
  })

  it('refuses a bad Incus name and an unknown instance action', async () => {
    const harness = moduleHarness('container', () => ({ stdout: '', stderr: '', code: 0 }))
    const incus = new IncusCli(harness.ctx)
    await expect(incus.action('bad_name', 'start')).resolves.toEqual({
      ok: false,
      error: 'invalid instance name'
    })
    await expect(incus.action('ok', 'freeze' as 'start')).resolves.toEqual({
      ok: false,
      error: 'invalid instance action'
    })
    expect(harness.exec).not.toHaveBeenCalled()
  })

  it('refuses a custom install command that contains a newline', async () => {
    const harness = moduleHarness(
      'container',
      () => ({
        stdout: '===MANAGER===\napt-get\n===DOCKER===\nno\n===INCUS===\nno\n===SYSTEMD===\nyes\n',
        stderr: '',
        code: 0
      }),
      { hasSudo: true }
    )
    const installer = new RuntimeInstaller(harness.ctx)
    const report = await installer.check('docker', { mode: 'custom', command: 'apt\nreboot' })
    expect(report.ok).toBe(false)
    expect(report.findings.some((f) => f.label.includes('single line'))).toBe(true)
  })

  it('does not start an install stream when apply has no token', async () => {
    const harness = moduleHarness('container', () => ({ stdout: '', stderr: '', code: 0 }), {
      hasSudo: true
    })
    const installer = new RuntimeInstaller(harness.ctx)
    const result = await installer.apply({})
    expect(result.ok).toBe(false)
    expect(harness.stream.start).not.toHaveBeenCalled()
  })
})
