import { describe, expect, it, vi } from 'vitest'
import type { ConnectionConfig } from '@shared/types'
import { ConnectionManager } from '../../../server/connection'
import { MachinePool } from '../../../server/machines'
import { FakeExecutor } from '../../helpers/fake-executor'

function config(host: string, port = 22): ConnectionConfig {
  return { mode: 'ssh', host, port, username: 'tester' }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function healthy(kind: 'local' | 'ssh' = 'ssh'): FakeExecutor {
  return new FakeExecutor(
    (command) =>
      command === 'id -u && uname -s'
        ? { stdout: '1000\nLinux\n', stderr: '', code: 0 }
        : { stdout: '', stderr: '', code: 0 },
    kind
  )
}

class LossExecutor extends FakeExecutor {
  private callback: (() => void) | null = null

  onConnectionLost(callback: () => void): void {
    this.callback = callback
  }

  lose(): void {
    this.callback?.()
  }
}

describe('MachinePool', () => {
  it('keeps two executors and their contexts alive independently', async () => {
    const executors = new Map([
      ['alpha', healthy()],
      ['beta', healthy()]
    ])
    const pool = new MachinePool({
      createManager: () =>
        new ConnectionManager({
          createSsh: (cfg) => executors.get(cfg.host!)!
        })
    })

    const [alpha, beta] = await Promise.all([
      pool.connect(config('alpha')),
      pool.connect(config('beta'))
    ])

    expect(alpha.machine).not.toBe(beta.machine)
    expect(pool.list().map((machine) => machine.machineId).sort()).toEqual([
      'tester@alpha',
      'tester@beta'
    ])
    expect(alpha.machine.manager.current).toBe(executors.get('alpha'))
    expect(beta.machine.manager.current).toBe(executors.get('beta'))
  })

  it('disconnects one target without disposing the other', async () => {
    const alpha = healthy()
    const beta = healthy()
    const pool = new MachinePool({
      createManager: () =>
        new ConnectionManager({
          createSsh: (cfg) => (cfg.host === 'alpha' ? alpha : beta)
        })
    })
    await pool.connect(config('alpha'))
    await pool.connect(config('beta'))

    await pool.disconnect('tester@alpha')

    expect(alpha.disposed).toBe(true)
    expect(beta.disposed).toBe(false)
    expect(pool.list()).toHaveLength(1)
    expect(pool.list()[0]?.machineId).toBe('tester@beta')
  })

  it('reconnects the same machine id in place and runs its scoped teardown hook', async () => {
    const first = healthy()
    const replacement = healthy()
    let attempt = 0
    const beforeSwap = vi.fn()
    const pool = new MachinePool({
      createManager: () =>
        new ConnectionManager({
          createSsh: () => (attempt++ === 0 ? first : replacement)
        }),
      onBeforeSwap: beforeSwap
    })
    const original = await pool.connect(config('alpha', 22))
    expect(pool.list()[0]?.revision).toBe(1)

    const reconnected = await pool.connect(config('alpha', 2222))

    expect(reconnected.machine).toBe(original.machine)
    expect(pool.list()[0]?.revision).toBe(2)
    expect(reconnected.machine.config.port).toBe(2222)
    expect(beforeSwap).toHaveBeenCalledOnce()
    expect(first.disposed).toBe(true)
    expect(replacement.disposed).toBe(false)
  })

  it('keeps the shared context when a newer same-id connect supersedes the first', async () => {
    const replacement = deferred<FakeExecutor>()
    let attempt = 0
    const pool = new MachinePool({
      createManager: () =>
        new ConnectionManager({
          createSsh: (_cfg, signal) => {
            if (attempt++ > 0) return replacement.promise
            return new Promise<FakeExecutor>((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(new Error('aborted')), {
                once: true
              })
            })
          }
        })
    })

    const first = pool.connect(config('alpha'))
    await Promise.resolve()
    const second = pool.connect(config('alpha'))
    await expect(first).rejects.toThrow(/superseded|cancelled/)
    expect(pool.get('tester@alpha')).toBeDefined()

    const executor = healthy()
    replacement.resolve(executor)
    await expect(second).resolves.toMatchObject({
      machine: { id: 'tester@alpha' }
    })
    expect(pool.get('tester@alpha')?.manager.current).toBe(executor)
  })

  it('removes only the SSH target whose executor reports a loss', async () => {
    const lost = new LossExecutor((command) =>
      command === 'id -u && uname -s'
        ? { stdout: '1000\nLinux\n', stderr: '', code: 0 }
        : { stdout: '', stderr: '', code: 0 }
    )
    const stable = healthy()
    const onLost = vi.fn()
    const pool = new MachinePool({
      createManager: () =>
        new ConnectionManager({
          createSsh: (cfg) => (cfg.host === 'alpha' ? lost : stable)
        }),
      onLost
    })
    await pool.connect(config('alpha'))
    await pool.connect(config('beta'))

    lost.lose()

    expect(onLost).toHaveBeenCalledOnce()
    expect(pool.get('tester@alpha')).toBeUndefined()
    expect(pool.get('tester@beta')?.manager.connected).toBe(true)
  })
})
