import { describe, expect, it } from 'vitest'
import { moduleHarness } from '../../helpers/module-harness'
import { killProcess, parseProcessList, reniceProcess } from '../../../modules/processes/main/service'

const PS = [
  '    1     0 root      0.0  0.1  1234 Ss   2-03:04:05 systemd /sbin/init',
  '   42     1 alice    12.5  3.2  4096 Sl     01:02:03 node /usr/bin/node app.js --watch',
  'PID PPID USER',
  '',
  '   not a process line'
].join('\n')

describe('parseProcessList', () => {
  it('parses pid, parent, user, cpu, rss and args that contain spaces', () => {
    const rows = parseProcessList(PS)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      pid: 1,
      ppid: 0,
      user: 'root',
      cpu: 0,
      rssKb: 1234,
      rssBytes: 1234 * 1024,
      comm: 'systemd',
      args: '/sbin/init'
    })
    expect(rows[1]).toMatchObject({
      pid: 42,
      ppid: 1,
      user: 'alice',
      cpu: 12.5,
      mem: 3.2,
      comm: 'node',
      args: '/usr/bin/node app.js --watch'
    })
  })

  it('skips the header, blanks and garbage', () => {
    expect(parseProcessList('')).toEqual([])
    expect(parseProcessList('   \nPID USER\n')).toEqual([])
  })
})

describe('killProcess / reniceProcess', () => {
  it('refuses pid 1, 0 and a non-integer without exec', async () => {
    const harness = moduleHarness('processes', () => ({ stdout: '', stderr: '', code: 0 }))
    await expect(killProcess(harness.ctx, 1, 'TERM', false)).resolves.toEqual({
      ok: false,
      error: 'invalid pid'
    })
    await expect(killProcess(harness.ctx, 0, 'TERM', false)).resolves.toEqual({
      ok: false,
      error: 'invalid pid'
    })
    await expect(killProcess(harness.ctx, 1.5, 'TERM', false)).resolves.toEqual({
      ok: false,
      error: 'invalid pid'
    })
    expect(harness.exec).not.toHaveBeenCalled()
  })

  it('refuses a signal that is not TERM or KILL', async () => {
    const harness = moduleHarness('processes', () => ({ stdout: '', stderr: '', code: 0 }))
    await expect(killProcess(harness.ctx, 9, 'HUP' as 'TERM', false)).resolves.toEqual({
      ok: false,
      error: 'invalid signal'
    })
    expect(harness.exec).not.toHaveBeenCalled()
  })

  it('runs kill -TERM for a valid pid', async () => {
    const harness = moduleHarness('processes', () => ({ stdout: '', stderr: '', code: 0 }))
    await expect(killProcess(harness.ctx, 9, 'TERM', false)).resolves.toEqual({ ok: true })
    expect(harness.exec).toHaveBeenCalledWith('kill -TERM 9')
  })

  it('retries with sudo when a plain kill is not permitted', async () => {
    const harness = moduleHarness('processes', (command) =>
      command.includes('kill') && !harness.exec.mock.calls.some(([c]) => c === command)
        ? { stdout: '', stderr: 'Operation not permitted', code: 1 }
        : { stdout: '', stderr: '', code: 0 }
    )
    const first = harness.exec
    first.mockImplementationOnce(async () => ({
      stdout: '',
      stderr: 'Operation not permitted',
      code: 1
    }))
    first.mockImplementationOnce(async () => ({ stdout: '', stderr: '', code: 0 }))
    await expect(killProcess(harness.ctx, 9, 'TERM', false)).resolves.toEqual({ ok: true })
    expect(harness.exec).toHaveBeenCalledTimes(2)
  })

  it('clamps renice to [-20, 19]', async () => {
    const harness = moduleHarness('processes', () => ({ stdout: '', stderr: '', code: 0 }))
    await reniceProcess(harness.ctx, 9, 99)
    expect(harness.exec).toHaveBeenCalledWith('renice -n 19 -p 9')
    await reniceProcess(harness.ctx, 9, -99)
    expect(harness.exec).toHaveBeenCalledWith('renice -n -20 -p 9')
  })

  it('refuses to renice pid 1', async () => {
    const harness = moduleHarness('processes', () => ({ stdout: '', stderr: '', code: 0 }))
    await expect(reniceProcess(harness.ctx, 1, 0)).resolves.toEqual({
      ok: false,
      error: 'invalid pid'
    })
    expect(harness.exec).not.toHaveBeenCalled()
  })
})
