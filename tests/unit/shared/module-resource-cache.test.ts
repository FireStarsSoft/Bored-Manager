import { describe, expect, it, vi } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import { moduleHarness } from '../../helpers/module-harness'
import activateNetwork from '../../../modules/network/main/index'
import activateContainer from '../../../modules/container/main/index'
import activateGpu from '../../../modules/gpu/main/index'
import activateSensors from '../../../modules/sensors/main/index'
import { GpuService } from '../../../modules/gpu/main/service'

describe('module read coalescing', () => {
  it('turns fourteen concurrent Network tuning bindings into one target probe', async () => {
    const harness = moduleHarness('network', () => ({ stdout: '', stderr: '', code: 0 }))
    activateNetwork(harness.ctx)
    const read = harness.handlers.get('netTunables')
    expect(read).toBeDefined()

    await Promise.all(Array.from({ length: 14 }, () => Promise.resolve(read!())))
    expect(harness.exec).toHaveBeenCalledTimes(1)
  })

  it('turns four concurrent Docker drawer bindings into one inspect command', async () => {
    const harness = moduleHarness('container', () => ({ stdout: '', stderr: '', code: 0 }))
    activateContainer(harness.ctx)
    const inspect = harness.handlers.get('inspect')
    expect(inspect).toBeDefined()

    await Promise.all(Array.from({ length: 4 }, () => Promise.resolve(inspect!('abc123'))))
    expect(harness.exec).toHaveBeenCalledTimes(1)
    expect(harness.exec.mock.calls[0]?.[0]).toContain('docker inspect')
  })

  it('queries the GPU UUID map once and reuses it on the next metric tick', async () => {
    const gpu =
      '0, Test GPU, 10, 20, 100, 1000, 50, 100, 200, 50, 250, 200, 30, 1000, 2000, Enabled, 555.1'
    let call = 0
    const harness = moduleHarness('gpu', () => {
      call++
      return {
        stdout:
          call === 1
            ? `${gpu}\n===PROCS===\nGPU-1, 123, worker, 64\n===UUID===\n0, GPU-1\n`
            : `${gpu}\n===PROCS===\nGPU-1, 123, worker, 64\n`,
        stderr: '',
        code: 0
      }
    })
    new GpuService(harness.ctx)

    await harness.ticks[0]()
    await harness.ticks[0]()

    expect(harness.exec).toHaveBeenCalledTimes(2)
    expect(harness.exec.mock.calls[0]?.[0]).toContain("echo '===UUID==='")
    expect(harness.exec.mock.calls[1]?.[0]).not.toContain("echo '===UUID==='")
  })
})

describe('GPU streaming metrics', () => {
  it('keeps one nvidia-smi process alive and samples process data per streamed batch', async () => {
    vi.useFakeTimers()
    const harness = moduleHarness('gpu', (command) => ({
      stdout: command.includes('--query-compute-apps')
        ? 'GPU-1, 123, worker, 64\n===UUID===\n0, GPU-1\n'
        : '',
      stderr: '',
      code: 0
    }), { mode: 'always' })
    const instance = activateGpu(harness.ctx)
    instance.applyPollers?.()
    await Promise.resolve()
    await Promise.resolve()

    expect(harness.stream.start).toHaveBeenCalledTimes(1)
    expect(harness.stream.start.mock.calls[0]?.[0]).toContain('-lms 2000')
    harness.stream.pushData(
      '0, Test GPU, 10, 20, 100, 1000, 50, 100, 200, 50, 250, 200, 30, 1000, 2000, Enabled, 555.1\n'
    )
    await vi.advanceTimersByTimeAsync(100)
    await Promise.resolve()
    await Promise.resolve()

    expect(harness.exec).toHaveBeenCalledTimes(1)
    expect(harness.exec.mock.calls[0]?.[0]).toContain('--query-compute-apps')
    expect(harness.emit).toHaveBeenCalledWith(
      'snapshot',
      expect.objectContaining({ available: true })
    )
    instance.dispose()
    expect(harness.stream.kill).toHaveBeenCalled()
  })

  it('backs off and permanently falls back after three consecutive stream failures', async () => {
    vi.useFakeTimers()
    const harness = moduleHarness(
      'gpu',
      () => ({ stdout: '', stderr: '', code: 0 }),
      { streamError: new Error('stream unavailable') }
    )
    const service = new GpuService(harness.ctx)

    service.poller.start(2_000)
    await Promise.resolve()
    await Promise.resolve()
    expect(harness.stream.start).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.resolve()
    expect(harness.stream.start).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2_000)
    await Promise.resolve()
    expect(harness.stream.start).toHaveBeenCalledTimes(3)
    expect(harness.pollers[0].start).toHaveBeenCalledWith(2_000)

    service.dispose()
  })

  it('drops an old stream sample after metrics are restarted', async () => {
    vi.useFakeTimers()
    let release!: (value: ModuleExecResult) => void
    const harness = moduleHarness(
      'gpu',
      (command) =>
        command.includes('--query-compute-apps')
          ? new Promise<ModuleExecResult>((resolve) => {
              release = resolve
            })
          : { stdout: '', stderr: '', code: 0 },
      { mode: 'always' }
    )
    const service = new GpuService(harness.ctx)
    service.poller.start(2_000)
    await Promise.resolve()
    await Promise.resolve()
    harness.stream.pushData(
      '0, Test GPU, 10, 20, 100, 1000, 50, 100, 200, 50, 250, 200, 30, 1000, 2000, Enabled, 555.1\n'
    )
    await vi.advanceTimersByTimeAsync(100)
    expect(harness.exec).toHaveBeenCalledTimes(1)

    service.poller.stop()
    service.poller.start(1_000)
    await Promise.resolve()
    release({
      stdout: 'GPU-1, 123, worker, 64\n===UUID===\n0, GPU-1\n',
      stderr: '',
      code: 0
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(harness.emit).not.toHaveBeenCalledWith(
      'snapshot',
      expect.anything()
    )
    service.dispose()
  })
})

describe('GPU auto-cap safety', () => {
  const savedCaps = {
    enabled: true,
    intervalSec: 10,
    trigger: 'docker',
    gpus: { '0': { idleCap: 100, runningCap: 200 } }
  }

  it('leaves caps unchanged when the busy-state probe fails', async () => {
    const harness = moduleHarness(
      'gpu',
      () => ({ stdout: '', stderr: 'docker unavailable', code: 1 }),
      { hostData: savedCaps }
    )
    const service = new GpuService(harness.ctx)
    service.applyAutoCap()
    await harness.ticks[1]()

    expect(
      harness.exec.mock.calls.some(([command]) => command.includes(' -pl '))
    ).toBe(false)
    service.dispose()
  })

  it('does not apply a stale busy result after the watcher is stopped', async () => {
    let release!: (value: ModuleExecResult) => void
    const harness = moduleHarness(
      'gpu',
      (command) =>
        command.includes('docker ps')
          ? new Promise<ModuleExecResult>((resolve) => {
              release = resolve
            })
          : { stdout: '', stderr: '', code: 0 },
      { hostData: savedCaps }
    )
    const service = new GpuService(harness.ctx)
    service.applyAutoCap()
    const tick = harness.ticks[1]()
    await Promise.resolve()
    const stopping = service.autoCapStop()
    release({ stdout: 'container-id', stderr: '', code: 0 })
    await Promise.all([tick, stopping])

    expect(
      harness.exec.mock.calls.some(([command]) => command.includes(' -pl '))
    ).toBe(false)
    service.dispose()
  })

  it('waits for an already-issued cap command before Stop resolves', async () => {
    let releaseCap!: (value: ModuleExecResult) => void
    const harness = moduleHarness(
      'gpu',
      (command) => {
        if (command.includes('docker ps')) {
          return { stdout: 'container-id', stderr: '', code: 0 }
        }
        if (command.includes(' -pl ')) {
          return new Promise<ModuleExecResult>((resolve) => {
            releaseCap = resolve
          })
        }
        return { stdout: '', stderr: '', code: 0 }
      },
      { hostData: savedCaps }
    )
    const service = new GpuService(harness.ctx)
    service.applyAutoCap()
    const tick = harness.ticks[1]()
    await Promise.resolve()
    await Promise.resolve()
    const stopping = service.autoCapStop()
    let stopped = false
    void stopping.then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)

    releaseCap({ stdout: '', stderr: '', code: 0 })
    await Promise.all([tick, stopping])
    expect(stopped).toBe(true)
    service.dispose()
  })
})

describe('module visibility gating', () => {
  it('stops hidden fast metrics but leaves slow and automation pollers independent', () => {
    const answer = () => ({ stdout: '', stderr: '', code: 0 })

    const sensors = moduleHarness('sensors', answer, { mode: 'tab', tabActive: false })
    activateSensors(sensors.ctx).applyPollers?.()
    expect(sensors.pollers[0].start).not.toHaveBeenCalled()
    expect(sensors.pollers[0].stop).toHaveBeenCalled()

    const container = moduleHarness('container', answer, {
      mode: 'tab',
      tabActive: false
    })
    activateContainer(container.ctx).applyPollers?.()
    expect(container.pollers[0].start).not.toHaveBeenCalled()
    expect(container.pollers[1].start).toHaveBeenCalledWith(60_000)

    const gpu = moduleHarness('gpu', answer, {
      mode: 'tab',
      tabActive: false,
      hostData: {
        enabled: true,
        intervalSec: 10,
        trigger: 'docker',
        gpus: { '0': { idleCap: 100, runningCap: 200 } }
      }
    })
    const gpuInstance = activateGpu(gpu.ctx)
    gpuInstance.applyPollers?.()
    expect(gpu.pollers[0].start).not.toHaveBeenCalled()
    expect(gpu.pollers[1].start).toHaveBeenCalledWith(10_000)
    gpuInstance.dispose()
  })
})
