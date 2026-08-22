import { describe, expect, it } from 'vitest'
import { moduleHarness } from '../../helpers/module-harness'
import { GpuService } from '../../../modules/gpu/main/service'

const GPU_ROW =
  '0, Test GPU, 10, 20, 100, 1000, 50, 100, 200, 50, 250, 200, 30, 1000, 2000, Enabled, 555.1'

async function withSnapshot(
  hostData: unknown = null
): Promise<{ service: GpuService; harness: ReturnType<typeof moduleHarness> }> {
  const harness = moduleHarness(
    'gpu',
    () => ({
      stdout: `${GPU_ROW}\n===PROCS===\nGPU-1, 123, worker, 64\n===UUID===\n0, GPU-1\n`,
      stderr: '',
      code: 0
    }),
    { hostData: hostData ?? null }
  )
  const service = new GpuService(harness.ctx)
  await harness.ticks[0]()
  return { service, harness }
}

describe('GPU validation', () => {
  it('refuses killProcess for pid 1, 0 and a non-number', async () => {
    const harness = moduleHarness('gpu', () => ({ stdout: '', stderr: '', code: 0 }))
    const service = new GpuService(harness.ctx)
    await expect(service.killProcess(1)).resolves.toEqual({ ok: false, error: 'invalid pid' })
    await expect(service.killProcess(0)).resolves.toEqual({ ok: false, error: 'invalid pid' })
    await expect(service.killProcess(Number.NaN)).resolves.toEqual({
      ok: false,
      error: 'invalid pid'
    })
    expect(harness.exec).not.toHaveBeenCalled()
  })

  it('refuses setPowerLimit when there is no GPU reading', async () => {
    const harness = moduleHarness('gpu', () => ({ stdout: '', stderr: '', code: 0 }))
    const service = new GpuService(harness.ctx)
    await expect(service.setPowerLimit(0, 200)).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/no GPU reading yet/i)
    })
    expect(harness.exec.mock.calls.some(([cmd]) => String(cmd).includes(' -pl '))).toBe(false)
  })

  it('enforces the reported watt range and refuses zero', async () => {
    const { service, harness } = await withSnapshot()
    await expect(service.setPowerLimit(0, 49)).resolves.toMatchObject({ ok: false })
    await expect(service.setPowerLimit(0, 300)).resolves.toMatchObject({ ok: false })
    await expect(service.setPowerLimit(0, 0)).resolves.toMatchObject({ ok: false })
    harness.exec.mockClear()
    await expect(service.setPowerLimit(0, 200)).resolves.toMatchObject({ ok: true })
    expect(harness.exec.mock.calls.some(([cmd]) => String(cmd).includes('-pl 200'))).toBe(true)
  })

  it('refuses persistence and clock changes for an unknown index', async () => {
    const { service, harness } = await withSnapshot()
    harness.exec.mockClear()
    await expect(service.setPersistence(9, true)).resolves.toMatchObject({ ok: false })
    await expect(service.lockClocks(9, 300, 1500)).resolves.toMatchObject({ ok: false })
    await expect(service.resetClocks(9)).resolves.toMatchObject({ ok: false })
    expect(harness.exec).not.toHaveBeenCalled()
  })

  it('refuses autoCapConfigure bounds and an unknown trigger', async () => {
    const harness = moduleHarness('gpu', () => ({ stdout: '', stderr: '', code: 0 }))
    const service = new GpuService(harness.ctx)
    await expect(service.autoCapConfigure(1, 'docker')).resolves.toMatchObject({ ok: false })
    await expect(service.autoCapConfigure(10, 'containers')).resolves.toMatchObject({ ok: false })
    await expect(service.autoCapConfigure(10, 'gpu')).resolves.toMatchObject({ ok: true })
  })

  it('drops garbage GPU indexes from the saved auto-cap file', () => {
    const harness = moduleHarness('gpu', () => ({ stdout: '', stderr: '', code: 0 }), {
      hostData: {
        enabled: true,
        gpus: {
          '-1': { idleCap: 100, runningCap: 200 },
          foo: { idleCap: 100, runningCap: 200 },
          '0': { idleCap: 0, runningCap: 200 }
        }
      }
    })
    const service = new GpuService(harness.ctx)
    service.applyAutoCap()
    const status = service.getAutoCapStatus()
    expect(status.enabled).toBe(false)
    expect(status.gpus).toHaveLength(0)
  })

  it('treats a stored unknown trigger as docker', () => {
    const harness = moduleHarness('gpu', () => ({ stdout: '', stderr: '', code: 0 }), {
      hostData: { enabled: false, trigger: 'nope', gpus: { '0': { idleCap: 100, runningCap: 200 } } }
    })
    const service = new GpuService(harness.ctx)
    service.applyAutoCap()
    expect(service.getAutoCapStatus().trigger).toBe('docker')
  })

  it('refuses autoCapStart when no GPU has caps', async () => {
    const harness = moduleHarness('gpu', () => ({ stdout: '', stderr: '', code: 0 }))
    const service = new GpuService(harness.ctx)
    await expect(service.autoCapStart()).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/No GPU has caps/)
    })
  })

  it('refuses autoCapClear for an index that is not watched', async () => {
    const harness = moduleHarness('gpu', () => ({ stdout: '', stderr: '', code: 0 }))
    const service = new GpuService(harness.ctx)
    await expect(service.autoCapClear(99)).resolves.toMatchObject({ ok: false })
  })
})
