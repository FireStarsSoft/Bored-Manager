import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalExecutor } from '../../../server/executors/local'
import { withTestTempDir } from '../../helpers/temp-dir'

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly stdin = {
    write: vi.fn(() => true),
    end: vi.fn()
  }
  readonly kill = vi.fn(() => true)

  constructor(readonly pid: number) {
    super()
  }

  spawned(): void {
    this.emit('spawn')
  }

  failed(error = new Error('spawn failed')): void {
    this.emit('error', error)
  }

  closed(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('close', code, signal)
  }

  asChild(): ChildProcess {
    return this as unknown as ChildProcess
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('LocalExecutor child lifecycle', () => {
  it('reads bounded local files without spawning and reports unavailable paths', async () => {
    await withTestTempDir(async (dir) => {
      const file = join(dir, 'sample.txt')
      const missing = join(dir, 'missing.txt')
      writeFileSync(file, Buffer.alloc(2 * 1024 * 1024 + 32, 0x61))
      const spawn = vi.fn()
      const executor = new LocalExecutor({ spawn })

      const results = await executor.readFiles([file, missing])
      expect(spawn).not.toHaveBeenCalled()
      expect(results[0]).toMatchObject({ path: file, ok: true })
      expect(Buffer.byteLength(results[0].text)).toBe(2 * 1024 * 1024)
      expect(results[1]).toEqual({ path: missing, ok: false, text: '' })

      await executor.dispose()
      await expect(executor.readFiles([file])).resolves.toEqual([
        { path: file, ok: false, text: '' }
      ])
    }, 'local-read-files')
  })

  it('decodes split UTF-8 and enforces a combined output ceiling', async () => {
    const utf8Child = new FakeChild(101)
    const overflowChild = new FakeChild(102)
    const children = [utf8Child, overflowChild]
    const killProcess = vi.fn(() => true)
    const executor = new LocalExecutor({
      spawn: () => children.shift()!.asChild(),
      killProcess,
      killGraceMs: 10,
      loadPty: () => null
    })

    const split = executor.exec('split', { timeoutMs: 0, maxOutputBytes: 1024 })
    const euro = Buffer.from('€')
    utf8Child.stdout.emit('data', euro.subarray(0, 1))
    utf8Child.stdout.emit('data', euro.subarray(1))
    utf8Child.closed(0)
    await expect(split).resolves.toMatchObject({ stdout: '€', code: 0 })

    const overflow = executor.exec('overflow', {
      timeoutMs: 0,
      maxOutputBytes: 1024
    })
    overflowChild.stdout.emit('data', Buffer.alloc(800, 0x61))
    overflowChild.stderr.emit('data', Buffer.alloc(300, 0x62))
    expect(killProcess).toHaveBeenCalledWith(-102, 'SIGTERM')
    overflowChild.closed(null, 'SIGTERM')
    const result = await overflow
    expect(result.code).toBe(125)
    expect(result.stderr).toContain('[overflow]')
    expect(Buffer.byteLength(result.stdout + result.stderr.replace('\n[overflow]', ''))).toBe(
      1024
    )
  })

  it('terminates the detached process group TERM then KILL and waits for close', async () => {
    vi.useFakeTimers()
    const child = new FakeChild(201)
    const killProcess = vi.fn(() => true)
    const executor = new LocalExecutor({
      spawn: () => child.asChild(),
      killProcess,
      killGraceMs: 10
    })

    let settled = false
    const result = executor.exec('hang', { timeoutMs: 5 }).then((value) => {
      settled = true
      return value
    })
    await vi.advanceTimersByTimeAsync(5)
    expect(killProcess).toHaveBeenCalledWith(-201, 'SIGTERM')
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(10)
    expect(killProcess).toHaveBeenCalledWith(-201, 'SIGKILL')
    expect(settled).toBe(false)

    child.closed(null, 'SIGKILL')
    await expect(result).resolves.toMatchObject({
      code: 124,
      signal: 'SIGKILL',
      stderr: expect.stringContaining('[timeout]')
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('tracks one-shot commands and waits for them during idempotent disposal', async () => {
    const child = new FakeChild(301)
    const killProcess = vi.fn(() => true)
    const executor = new LocalExecutor({
      spawn: () => child.asChild(),
      killProcess,
      killGraceMs: 10
    })
    const command = executor.exec('long-running', { timeoutMs: 0 })

    const firstDispose = executor.dispose()
    const secondDispose = executor.dispose()
    expect(secondDispose).toBe(firstDispose)
    expect(killProcess).toHaveBeenCalledWith(-301, 'SIGTERM')
    child.closed(null, 'SIGTERM')

    await firstDispose
    await expect(command).resolves.toMatchObject({
      code: 130,
      stderr: expect.stringContaining('[cancelled]')
    })
  })

  it('rejects fallback spawn errors and exposes non-resizable PTY capability', async () => {
    const failed = new FakeChild(401)
    const fallback = new FakeChild(402)
    const children = [failed, fallback]
    const executor = new LocalExecutor({
      spawn: () => children.shift()!.asChild(),
      killProcess: vi.fn(() => true),
      loadPty: () => null,
      killGraceMs: 10
    })

    const stream = executor.stream('bad')
    failed.failed()
    failed.closed(127)
    await expect(stream).rejects.toThrow(/spawn failed/)

    const shellPromise = executor.shell(80, 24)
    fallback.spawned()
    const shell = await shellPromise
    expect(shell.resizeSupported).toBe(false)
    expect(shell.diagnostic).toMatch(/resize is unavailable/)
    shell.kill()
    fallback.closed(null, 'SIGTERM')
    await executor.dispose()
  })
})
