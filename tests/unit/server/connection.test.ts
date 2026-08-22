import { describe, expect, it, vi } from 'vitest'
import type { ConnectionConfig } from '@shared/types'
import {
  ConnectionCancelledError,
  ConnectionManager
} from '../../../server/connection'
import type { ExecOptions, ExecResult } from '../../../server/executors/types'
import { FakeExecutor } from '../../helpers/fake-executor'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', code: 0 })
const fail = (stderr = 'failed'): ExecResult => ({ stdout: '', stderr, code: 1 })

function config(host: string, sudoPassword?: string): ConnectionConfig {
  return {
    mode: 'ssh',
    host,
    port: 22,
    username: 'tester',
    sudoPassword
  }
}

class LossExecutor extends FakeExecutor {
  private readonly lost = new Set<() => void>()

  onConnectionLost(cb: () => void): void {
    this.lost.add(cb)
  }

  lose(): void {
    for (const cb of this.lost) cb()
  }
}

function healthy(
  answer?: (command: string, options?: ExecOptions) => ExecResult | Promise<ExecResult>
): LossExecutor {
  return new LossExecutor(
    answer ??
      ((command) =>
        command === 'id -u && uname -s'
          ? ok('1000\nLinux\n')
          : ok())
  )
}

describe('ConnectionManager generations and capability probes', () => {
  it('lets the newest A/B candidate win and disposes the stale candidate', async () => {
    const aProbe = deferred<ExecResult>()
    const bProbe = deferred<ExecResult>()
    const a = healthy((command) =>
      command === 'id -u && uname -s' ? aProbe.promise : ok()
    )
    const b = healthy((command) =>
      command === 'id -u && uname -s' ? bProbe.promise : ok()
    )
    const manager = new ConnectionManager({
      createSsh: (cfg) => (cfg.host === 'a' ? a : b)
    })

    const connectingA = manager.connect(config('a'))
    await Promise.resolve()
    const connectingB = manager.connect(config('b'))
    await Promise.resolve()
    bProbe.resolve(ok('1000\nLinux\n'))
    await expect(connectingB).resolves.toMatchObject({ sudoState: 'passwordless' })
    expect(manager.current).toBe(b)

    aProbe.resolve(ok('1000\nLinux\n'))
    await expect(connectingA).rejects.toBeInstanceOf(ConnectionCancelledError)
    expect(a.disposed).toBe(true)
    expect(b.disposed).toBe(false)
    expect(manager.current).toBe(b)
  })

  it('cancels and disposes a handshake that completes after disconnect', async () => {
    const candidateReady = deferred<LossExecutor>()
    const candidate = healthy()
    const manager = new ConnectionManager({
      createSsh: () => candidateReady.promise
    })

    const connecting = manager.connect(config('slow'))
    const disconnecting = manager.disconnect()
    candidateReady.resolve(candidate)

    await expect(connecting).rejects.toBeInstanceOf(ConnectionCancelledError)
    await disconnecting
    expect(candidate.disposed).toBe(true)
    expect(manager.current).toBeNull()
    expect(manager.phase).toBe('idle')
  })

  it('keeps the healthy current connection when a replacement probe fails', async () => {
    const current = healthy()
    const failed = healthy((command) =>
      command === 'id -u && uname -s' ? fail('probe failed') : ok()
    )
    const manager = new ConnectionManager({
      createSsh: (cfg) => (cfg.host === 'current' ? current : failed)
    })

    await manager.connect(config('current'))
    await expect(manager.connect(config('failed'))).rejects.toThrow(/probe failed/)
    expect(manager.current).toBe(current)
    expect(manager.status().host).toBe('current')
    expect(current.disposed).toBe(false)
    expect(failed.disposed).toBe(true)
  })

  it('runs old-host teardown only after the replacement is ready and before swap', async () => {
    const ready = deferred<ExecResult>()
    const current = healthy()
    const replacement = healthy((command) =>
      command === 'id -u && uname -s' ? ready.promise : ok()
    )
    const manager = new ConnectionManager({
      createSsh: (cfg) => (cfg.host === 'current' ? current : replacement)
    })
    await manager.connect(config('current'))
    const beforeSwap = vi.fn(() => {
      expect(manager.current).toBe(current)
    })
    manager.setBeforeSwap(beforeSwap)

    const connecting = manager.connect(config('replacement'))
    await Promise.resolve()
    expect(manager.current).toBe(current)
    expect(beforeSwap).not.toHaveBeenCalled()
    ready.resolve(ok('1000\nLinux\n'))
    await connecting

    expect(beforeSwap).toHaveBeenCalledOnce()
    expect(manager.current).toBe(replacement)
    expect(current.disposed).toBe(true)
  })

  it('ignores an old executor loss after swap and emits current loss once', async () => {
    const first = healthy()
    const second = healthy()
    const lost = vi.fn()
    const manager = new ConnectionManager({
      createSsh: (cfg) => (cfg.host === 'first' ? first : second)
    })
    manager.onConnectionLost(lost)

    await manager.connect(config('first'))
    await manager.connect(config('second'))
    first.lose()
    expect(manager.current).toBe(second)
    expect(lost).not.toHaveBeenCalled()

    second.lose()
    second.lose()
    expect(manager.current).toBeNull()
    expect(manager.status()).toEqual({ connected: false })
    expect(lost).toHaveBeenCalledTimes(1)
  })

  it('keeps rejected sudo credentials out of capability state', async () => {
    const executor = healthy((command) => {
      if (command === 'id -u && uname -s') return ok('1000\nLinux\n')
      if (command === 'sudo -n true') return fail('password required')
      if (command === "sudo -S -k -p '' true") return fail('sorry')
      return ok()
    })
    const manager = new ConnectionManager({ createSsh: () => executor })

    const outcome = await manager.connect(config('sudo-reject', 'wrong-secret'))

    expect(outcome).toMatchObject({
      sudoState: 'none',
      sudoPasswordRejected: true,
      warning: expect.stringContaining('rejected')
    })
    expect(manager.status()).toMatchObject({ isRoot: false, hasSudo: false })
    expect(
      executor.execCalls.find((call) => call.command === "sudo -S -k -p '' true")
        ?.options?.stdin
    ).toBe('wrong-secret\n')
  })

  it('detects passwordless sudo without submitting the supplied password', async () => {
    const executor = healthy((command) => {
      if (command === 'id -u && uname -s') return ok('1000\nLinux\n')
      if (command === 'sudo -n true') return ok()
      return fail()
    })
    const manager = new ConnectionManager({ createSsh: () => executor })

    await expect(manager.connect(config('sudo-n', 'unneeded'))).resolves.toMatchObject({
      sudoState: 'passwordless',
      sudoPasswordRejected: false
    })
    expect(manager.status()).toMatchObject({ isRoot: false, hasSudo: true })
    expect(executor.execCalls.map((call) => call.command)).not.toContain(
      "sudo -S -k -p '' true"
    )
  })

  it('rejects a successful shell probe from a non-Linux target', async () => {
    const executor = healthy((command) =>
      command === 'id -u && uname -s' ? ok('1000\nFreeBSD\n') : ok()
    )
    const manager = new ConnectionManager({ createSsh: () => executor })

    await expect(manager.connect(config('bsd'))).rejects.toThrow(/must be Linux/)
    expect(executor.disposed).toBe(true)
    expect(manager.current).toBeNull()
  })
})
