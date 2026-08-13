import type { OkResult, ProcessInfo } from '@shared/types'
import type { ModuleContext } from '@shared/modules'

// `ppid` is not shown as its own table column (see the spec) - it is there so
// the table's "by parent process" group mode (a tree via ppid -> pid) has
// something to match on, the same way `user` backs the "by user" group.
const LIST_CMD = `ps axo pid,ppid,user:20,pcpu,pmem,rss,stat,etime,comm,args --sort=-pcpu --no-headers | head -n 400`

export async function listProcesses(ctx: ModuleContext): Promise<ProcessInfo[]> {
  const res = await ctx.exec(LIST_CMD, { timeoutMs: 15000 })
  const procs: ProcessInfo[] = []
  for (const line of res.stdout.split('\n')) {
    if (!line.trim()) continue
    const m = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/
    )
    if (!m) continue
    const rssKb = parseInt(m[6], 10)
    procs.push({
      pid: parseInt(m[1], 10),
      ppid: parseInt(m[2], 10),
      user: m[3],
      cpu: parseFloat(m[4]),
      mem: parseFloat(m[5]),
      rssKb,
      rssBytes: rssKb * 1024,
      stat: m[7],
      etime: m[8],
      comm: m[9],
      args: m[10]
    })
  }
  return procs
}

export async function killProcess(
  ctx: ModuleContext,
  pid: number,
  signal: 'TERM' | 'KILL',
  asRoot: boolean
): Promise<OkResult> {
  if (!Number.isInteger(pid) || pid <= 1) return { ok: false, error: 'invalid pid' }
  const cmd = `kill -${signal} ${pid}`
  const res = asRoot ? await ctx.execSudo(cmd) : await ctx.exec(cmd)
  if (res.code === 0) return { ok: true }
  // Retry with sudo if a plain kill was denied.
  if (!asRoot && /not permitted|denied/i.test(res.stderr)) {
    const retry = await ctx.execSudo(cmd)
    return retry.code === 0
      ? { ok: true }
      : { ok: false, error: (retry.stderr || retry.stdout).trim() }
  }
  return { ok: false, error: (res.stderr || res.stdout).trim() || `exit code ${res.code}` }
}

export async function reniceProcess(
  ctx: ModuleContext,
  pid: number,
  nice: number
): Promise<OkResult> {
  if (!Number.isInteger(pid) || pid <= 1) return { ok: false, error: 'invalid pid' }
  const n = Math.max(-20, Math.min(19, Math.floor(nice)))
  const res = await ctx.execSudo(`renice -n ${n} -p ${pid}`)
  return res.code === 0
    ? { ok: true }
    : { ok: false, error: (res.stderr || res.stdout).trim() || `exit code ${res.code}` }
}
