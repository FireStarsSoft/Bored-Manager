import { describe, expect, it } from 'vitest'
import { moduleHarness } from '../../helpers/module-harness'
import activateNetwork from '../../../modules/network/main/index'
import { effectiveNetRules } from '../../../modules/network/main/rules'
import { planFor } from '../../../modules/network/main/tunables'

const CURRENT = {
  'net.ipv4.neigh.default.gc_thresh3': '64',
  'net.ipv4.neigh.default.gc_thresh2': '32',
  'net.ipv4.neigh.default.gc_thresh1': '16',
  'fs.file-max': '1000',
  'fs.nr_open': '1024',
  'fs.inotify.max_user_watches': '100',
  'fs.inotify.max_user_instances': '128',
  'net.core.somaxconn': '128'
}

describe('planFor', () => {
  it('raises neighbour and file limits for 100 addresses and leaves conntrack alone', () => {
    const planned = planFor(100, CURRENT)
    expect(Number(planned['net.ipv4.neigh.default.gc_thresh3'])).toBe(256)
    expect(Number(planned['fs.file-max'])).toBeGreaterThan(1000)
    expect(planned['net.netfilter.nf_conntrack_max']).toBeUndefined()
  })

  it('raises conntrack only at 1000 addresses when the kernel has that key', () => {
    const planned = planFor(1000, { ...CURRENT, 'net.netfilter.nf_conntrack_max': '1000' })
    expect(Number(planned['net.netfilter.nf_conntrack_max'])).toBeGreaterThanOrEqual(262144)
  })

  it('proposes nothing when the kernel reported no keys', () => {
    expect(planFor(100, {})).toEqual({})
  })

  it('keeps a current value that is already higher than the formula', () => {
    const planned = planFor(100, { ...CURRENT, 'net.ipv4.neigh.default.gc_thresh3': '4096' })
    expect(planned['net.ipv4.neigh.default.gc_thresh3']).toBe('4096')
  })
})

describe('effectiveNetRules', () => {
  it('ignores unknown keys and non-numeric overrides', () => {
    const harness = moduleHarness('network', () => ({ stdout: '', stderr: '', code: 0 }))
    harness.ctx.configGet = () => ({ rules: { maxGcThresh3: 'nope', unknown: 1, maxFileMax: 99 } })
    expect(effectiveNetRules(harness.ctx)).toMatchObject({
      maxGcThresh3: 1_000_000,
      maxFileMax: 99
    })
  })
})

describe('network handlers', () => {
  it('refuses planCheck when targetIps is missing or below 1', async () => {
    const harness = moduleHarness('network', () => ({ stdout: '', stderr: '', code: 0 }))
    activateNetwork(harness.ctx)
    const planCheck = harness.handlers.get('planCheck')!
    await expect(planCheck({ targetIps: 0 })).resolves.toMatchObject({ ok: false })
    await expect(planCheck({})).resolves.toMatchObject({ ok: false })
    await expect(planCheck({ targetIps: Number.NaN })).resolves.toMatchObject({ ok: false })
    expect(harness.exec).not.toHaveBeenCalled()
  })

  it('refuses planApply without a token', async () => {
    const harness = moduleHarness('network', () => ({ stdout: '', stderr: '', code: 0 }))
    activateNetwork(harness.ctx)
    const result = await harness.handlers.get('planApply')!({})
    expect(result).toMatchObject({ ok: false })
    expect(harness.exec.mock.calls.some(([cmd]) => String(cmd).includes('sysctl'))).toBe(false)
  })

  it('refuses killProcess for pid 1, 0 and a fraction', async () => {
    const harness = moduleHarness('network', () => ({ stdout: '', stderr: '', code: 0 }))
    activateNetwork(harness.ctx)
    const kill = harness.handlers.get('killProcess')!
    await expect(kill(1)).resolves.toEqual({ ok: false, error: 'invalid pid' })
    await expect(kill(0)).resolves.toEqual({ ok: false, error: 'invalid pid' })
    await expect(kill(1.2)).resolves.toEqual({ ok: false, error: 'invalid pid' })
    expect(harness.exec).not.toHaveBeenCalled()
  })

  it('emits kill -TERM for a valid pid', async () => {
    const harness = moduleHarness('network', () => ({ stdout: '', stderr: '', code: 0 }))
    activateNetwork(harness.ctx)
    await expect(harness.handlers.get('killProcess')!(9)).resolves.toEqual({ ok: true })
    expect(harness.exec).toHaveBeenCalledWith('kill -TERM 9')
  })
})
