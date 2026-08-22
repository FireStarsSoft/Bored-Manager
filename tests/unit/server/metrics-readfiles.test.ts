import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'
import type { ReadFileResult } from '../../../server/executors/types'
import type { ConnectionManager } from '../../../server/connection'
import { SystemMetricsService } from '../../../server/services/metrics'
import { withFakeClock } from '../../helpers/fake-clock'

const COMMAND =
  "echo '===STAT==='; cat /proc/stat; " +
  "echo '===MEM==='; cat /proc/meminfo; " +
  "echo '===NET==='; cat /proc/net/dev; " +
  "echo '===DISK==='; cat /proc/diskstats; " +
  "echo '===UPTIME==='; cat /proc/uptime; " +
  "echo '===LOAD==='; cat /proc/loadavg; " +
  "echo '===HOST==='; hostname"

const first = {
  '/proc/stat': 'cpu 100 0 100 800 0 0 0 0\ncpu0 100 0 100 800 0 0 0 0\n',
  '/proc/meminfo':
    'MemTotal: 1000 kB\nMemAvailable: 400 kB\nSwapTotal: 200 kB\nSwapFree: 150 kB\n',
  '/proc/net/dev':
    'Inter-| Receive | Transmit\nlo: 10 0 0 0 0 0 0 0 20 0 0 0 0 0 0 0\neth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0\n',
  '/proc/diskstats': '8 0 sda 1 0 10 0 1 0 20 0 0 0 0\n',
  '/proc/uptime': '100.00 50.00\n',
  '/proc/loadavg': '0.10 0.20 0.30 1/10 1\n'
}

const second = {
  ...first,
  '/proc/stat': 'cpu 150 0 150 900 0 0 0 0\ncpu0 150 0 150 900 0 0 0 0\n',
  '/proc/net/dev':
    'Inter-| Receive | Transmit\nlo: 10 0 0 0 0 0 0 0 20 0 0 0 0 0 0 0\neth0: 3000 0 0 0 0 0 0 0 5000 0 0 0 0 0 0 0\n',
  '/proc/diskstats': '8 0 sda 1 0 14 0 1 0 26 0 0 0 0\n',
  '/proc/uptime': '101.00 50.00\n'
}

type ProcFiles = typeof first

function asSections(files: ProcFiles): string {
  return [
    `===STAT===\n${files['/proc/stat']}`,
    `===MEM===\n${files['/proc/meminfo']}`,
    `===NET===\n${files['/proc/net/dev']}`,
    `===DISK===\n${files['/proc/diskstats']}`,
    `===UPTIME===\n${files['/proc/uptime']}`,
    `===LOAD===\n${files['/proc/loadavg']}`,
    '===HOST===\nbench-host\n'
  ].join('')
}

async function sample(service: SystemMetricsService): Promise<void> {
  await (
    service as unknown as {
      sample(): Promise<void>
    }
  ).sample()
}

describe('SystemMetricsService local file fast path', () => {
  it('matches the shell parser and preserves the SSH composite command', async () => {
    await withFakeClock(1_000, async () => {
      const directSets = [first, second]
      let directIndex = 0
      const directExec = vi.fn(async (_command: string, _options?: unknown) => ({
        stdout: 'bench-host\n',
        stderr: '',
        code: 0
      }))
      const directTarget = {
        connected: true,
        readFiles: vi.fn(async (paths: string[]): Promise<ReadFileResult[]> => {
          const files = directSets[directIndex++]
          return paths.map((path) => ({
            path,
            ok: path in files,
            text: files[path as keyof ProcFiles] ?? ''
          }))
        }),
        exec: directExec
      } as unknown as ConnectionManager

      const shellOutputs = [asSections(first), asSections(second)]
      const shellExec = vi.fn(async (_command: string) => ({
        stdout: shellOutputs.shift() ?? '',
        stderr: '',
        code: 0
      }))
      const shellTarget = {
        connected: true,
        readFiles: vi.fn(async () => null),
        exec: shellExec
      } as unknown as ConnectionManager

      const directSnapshots: unknown[] = []
      const shellSnapshots: unknown[] = []
      const direct = new SystemMetricsService((value) => directSnapshots.push(value), directTarget)
      const shell = new SystemMetricsService((value) => shellSnapshots.push(value), shellTarget)

      await sample(direct)
      await sample(shell)
      vi.setSystemTime(2_000)
      await sample(direct)
      await sample(shell)

      expect(directSnapshots).toEqual(shellSnapshots)
      expect(directExec).toHaveBeenCalledTimes(1)
      expect(directExec).toHaveBeenCalledWith('hostname', {
        timeoutMs: 15_000,
        maxOutputBytes: 64 * 1024
      })
      expect(shellExec).toHaveBeenCalledTimes(2)
      expect(shellExec.mock.calls.map(([command]) => command)).toEqual([COMMAND, COMMAND])
    })
  })

  it('suppresses the first cumulative-rate sample after collectors are re-enabled', async () => {
    await withFakeClock(1_000, async () => {
      const huge = {
        ...second,
        '/proc/stat':
          'cpu 5000 0 5000 10000 0 0 0 0\ncpu0 5000 0 5000 10000 0 0 0 0\n',
        '/proc/net/dev':
          'eth0: 1000000 0 0 0 0 0 0 0 2000000 0 0 0 0 0 0 0\n',
        '/proc/diskstats': '8 0 sda 1 0 10000 0 1 0 20000 0 0 0 0\n',
        '/proc/uptime': '103.00 50.00\n'
      }
      const afterHuge = {
        ...huge,
        '/proc/stat':
          'cpu 5050 0 5050 10100 0 0 0 0\ncpu0 5050 0 5050 10100 0 0 0 0\n',
        '/proc/net/dev':
          'eth0: 1002000 0 0 0 0 0 0 0 2003000 0 0 0 0 0 0 0\n',
        '/proc/diskstats': '8 0 sda 1 0 10004 0 1 0 20006 0 0 0 0\n',
        '/proc/uptime': '104.00 50.00\n'
      }
      const sets = [first, second, second, huge, afterHuge]
      let at = 0
      const target = {
        connected: true,
        readFiles: vi.fn(async (paths: string[]): Promise<ReadFileResult[]> => {
          const files = sets[at++]
          return paths.map((path) => ({
            path,
            ok: true,
            text: files[path as keyof ProcFiles] ?? ''
          }))
        }),
        exec: vi.fn(async () => ({ stdout: 'bench-host\n', stderr: '', code: 0 }))
      } as unknown as ConnectionManager
      const snapshots: Array<{
        cpu: { total: number }
        netRx: number
        netTx: number
        diskRead: number
        diskWrite: number
      }> = []
      const service = new SystemMetricsService(
        (snapshot) => snapshots.push(snapshot),
        target
      )

      await sample(service)
      vi.setSystemTime(2_000)
      await sample(service)
      service.configure({
        ...DEFAULT_SETTINGS.collectors,
        cpu: false,
        network: false,
        disk: false
      })
      vi.setSystemTime(3_000)
      await sample(service)
      service.configure(DEFAULT_SETTINGS.collectors)
      vi.setSystemTime(4_000)
      await sample(service)
      expect(snapshots.at(-1)).toMatchObject({
        cpu: { total: 0 },
        netRx: 0,
        netTx: 0,
        diskRead: 0,
        diskWrite: 0
      })

      vi.setSystemTime(5_000)
      await sample(service)
      expect(snapshots.at(-1)).toMatchObject({
        cpu: { total: 50 },
        netRx: 2_000,
        netTx: 3_000,
        diskRead: 2_048,
        diskWrite: 3_072
      })
    })
  })
})
