/**
 * The kernel limits that decide how many containers a machine can actually
 * hold: the neighbour (ARP) table, file descriptors, inotify watches and
 * conntrack. Every one of them fails the same unhelpful way when it runs out -
 * something stops resolving, or opening, or watching - so this page is about
 * showing where each limit is and how close the machine is to it.
 *
 * Anything written goes both to the running kernel (`sysctl -w`) and to a file
 * this module owns under /etc/sysctl.d, so it survives a reboot and can be
 * read back to show what is persisted versus what is merely live.
 */
import type { ModuleCheckFinding, ModuleCheckReport } from '@shared/check'
import { createCheckSession } from '@shared/check'
import type { ModuleContext } from '@shared/modules'
import type { OkResult } from '@shared/types'
import { splitSections } from '@shared/shell'
import { DEFAULT_NET_RULES, effectiveNetRules, type NetRules } from './rules'

/** The file this module writes. Nothing else should be editing it. */
export const SYSCTL_FILE = '/etc/sysctl.d/99-bored-manager.conf'
const SYSCTL_HEADER = '# Managed by Bored Manager - do not edit'

/** Every key the page reads or writes, in the order the sections show them. */
export const TUNABLE_KEYS = [
  'net.ipv4.neigh.default.gc_thresh1',
  'net.ipv4.neigh.default.gc_thresh2',
  'net.ipv4.neigh.default.gc_thresh3',
  'net.ipv6.neigh.default.gc_thresh1',
  'net.ipv6.neigh.default.gc_thresh2',
  'net.ipv6.neigh.default.gc_thresh3',
  'fs.file-max',
  'fs.nr_open',
  'fs.inotify.max_user_watches',
  'fs.inotify.max_user_instances',
  'fs.inotify.max_queued_events',
  'net.core.somaxconn',
  'net.core.netdev_max_backlog',
  'net.ipv4.ip_local_port_range',
  'net.netfilter.nf_conntrack_max'
] as const

export type TunableKey = (typeof TUNABLE_KEYS)[number]

/** `ip_local_port_range` is two numbers; everything else is one. */
const TEXT_KEYS: ReadonlySet<string> = new Set(['net.ipv4.ip_local_port_range'])

export interface NetTunables {
  /** What the running kernel reports, keyed by sysctl name. */
  current: Record<string, string>
  /** What SYSCTL_FILE says, so the page can show live-but-not-persisted values. */
  persisted: Record<string, string>
  usage: {
    neighEntries4: number
    neighEntries6: number
    /** Percentages are worked out here: a `meter` block cannot bind a moving max. */
    neighUsagePct: number
    filesOpen: number
    fdUsagePct: number
    conntrackCount: number
    conntrackUsagePct: number
    /** `ulimit -n` for the connected user, which no sysctl reports. */
    fdSoftLimit: number
  }
  /** False when nothing can be written, which the page says up front. */
  sudo: boolean
}

// Read through /proc/sys rather than the sysctl binary: it lives in /sbin,
// which is not on every non-root user's PATH, and a key the kernel does not
// have simply reads back empty instead of writing to stderr.
const PROBE_CMD = [
  `echo '===SYSCTLKEYS==='; for k in ${TUNABLE_KEYS.join(' ')}; do ` +
    `echo "$k=$(cat /proc/sys/$(echo $k | tr . /) 2>/dev/null | tr '\\t' ' ')"; done`,
  `echo '===FILENR==='; cat /proc/sys/fs/file-nr 2>/dev/null`,
  `echo '===NEIGH4==='; ip -4 neigh 2>/dev/null | wc -l`,
  `echo '===NEIGH6==='; ip -6 neigh 2>/dev/null | wc -l`,
  `echo '===CONNTRACK==='; cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null`,
  `echo '===ULIMIT==='; sh -c 'ulimit -n' 2>/dev/null`,
  `echo '===PERSISTED==='; cat ${SYSCTL_FILE} 2>/dev/null`
].join('; ')

function toNumber(value: string | undefined): number {
  const n = Number(String(value ?? '').trim())
  return Number.isFinite(n) ? n : 0
}

function pct(used: number, limit: number): number {
  if (!limit || limit <= 0) return 0
  return Math.round((used / limit) * 1000) / 10
}

/** `key=value` lines, which is both how the probe reports and how the file stores them. */
function parseKeyValues(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const eq = s.indexOf('=')
    if (eq <= 0) continue
    const key = s.slice(0, eq).trim()
    const value = s.slice(eq + 1).trim()
    // A key the kernel does not have reads back empty; showing "" is better
    // than showing a zero somebody might act on.
    if (value) out[key] = normalizeValue(value)
  }
  return out
}

/** `sysctl -n` prints the port range tab-separated; the file wants spaces. */
function normalizeValue(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export class NetTunablesService {
  private planSession = createCheckSession<Record<string, string>>()
  private manualSession = createCheckSession<Record<string, string>>()
  private rulesSession = createCheckSession<Record<string, number>>()

  constructor(private ctx: ModuleContext) {}

  async read(): Promise<NetTunables> {
    const res = await this.ctx.exec(PROBE_CMD, { timeoutMs: 30000 })
    const s = splitSections(res.stdout)
    const current = parseKeyValues(s.get('SYSCTLKEYS') ?? '')
    const persisted = parseKeyValues(s.get('PERSISTED') ?? '')

    // /proc/sys/fs/file-nr is "allocated free max"; the first number is what is
    // in use, and it is the only place the kernel reports that.
    const fileNr = (s.get('FILENR') ?? '').trim().split(/\s+/)
    const filesOpen = toNumber(fileNr[0])
    const fileMax = toNumber(current['fs.file-max'])
    const neighEntries4 = toNumber(s.get('NEIGH4'))
    const neighEntries6 = toNumber(s.get('NEIGH6'))
    const gcThresh3 = toNumber(current['net.ipv4.neigh.default.gc_thresh3'])
    const conntrackCount = toNumber(s.get('CONNTRACK'))
    const conntrackMax = toNumber(current['net.netfilter.nf_conntrack_max'])

    return {
      current,
      persisted,
      usage: {
        neighEntries4,
        neighEntries6,
        neighUsagePct: pct(neighEntries4, gcThresh3),
        filesOpen,
        fdUsagePct: pct(filesOpen, fileMax),
        conntrackCount,
        conntrackUsagePct: pct(conntrackCount, conntrackMax),
        fdSoftLimit: toNumber(s.get('ULIMIT'))
      },
      sudo: this.ctx.hasSudo
    }
  }

  // ---------- Scale for N addresses ----------

  /**
   * Work out what the limits would have to be for a given number of container
   * addresses. Every formula only ever raises a value: a machine that is
   * already tuned higher than this suggests should not be pulled back down by
   * asking a question about it.
   */
  async planCheck(input: unknown): Promise<ModuleCheckReport> {
    const target = Math.trunc(Number((input as Record<string, unknown>)?.['targetIps']))
    if (!Number.isFinite(target) || target < 1) {
      return { ok: false, findings: [{ level: 'error', label: 'Enter how many container addresses to plan for' }] }
    }
    const state = await this.read()
    const findings: ModuleCheckFinding[] = []
    if (!state.sudo) {
      findings.push({
        level: 'error',
        label: 'Changing kernel limits needs sudo',
        detail: 'Reconnect with a sudo password, or as root, to apply anything from this page.'
      })
    }

    const proposed = planFor(target, state.current)
    const changes = Object.entries(proposed).filter(([key, value]) => value !== state.current[key])
    if (changes.length === 0) {
      findings.push({ level: 'pass', label: `This machine is already set up for ${target} addresses` })
      return { ok: false, findings }
    }
    for (const [key, value] of changes) {
      findings.push({
        level: 'info',
        label: `${key}: ${state.current[key] || 'unset'} → ${value}`
      })
    }

    // Every one of these limits is memory the kernel will actually allocate if
    // it gets used, which is the part a number on its own does not convey.
    const neigh = toNumber(proposed['net.ipv4.neigh.default.gc_thresh3']) * 512
    const conntrack = toNumber(proposed['net.netfilter.nf_conntrack_max']) * 320
    const watches = toNumber(proposed['fs.inotify.max_user_watches']) * 1024
    findings.push({
      level: 'warning',
      label: 'These are ceilings, and reaching them costs kernel memory',
      detail:
        `Roughly ${formatBytes(neigh)} of neighbour entries, ${formatBytes(conntrack)} of conntrack ` +
        `and ${formatBytes(watches)} of inotify watches if every one is used.`
    })
    findings.push({
      level: 'pass',
      label: `${changes.length} value(s) will be written to the kernel and to ${SYSCTL_FILE}`
    })

    const ok = !findings.some((f) => f.level === 'error')
    if (!ok) return { ok, findings }
    return { ok, token: this.planSession.issue(input, Object.fromEntries(changes)), findings }
  }

  async planApply(payload: unknown): Promise<OkResult> {
    const taken = takeToken(this.planSession, payload)
    if (!taken) return { ok: false, error: 'that check has expired or the form changed - check again' }
    return this.write(taken)
  }

  // ---------- One value at a time ----------

  async tunablesCheck(input: unknown): Promise<ModuleCheckReport> {
    const rules = effectiveNetRules(this.ctx)
    const state = await this.read()
    const values = (input as Record<string, unknown>) ?? {}
    const findings: ModuleCheckFinding[] = []
    const wanted: Record<string, string> = {}

    if (!state.sudo) {
      findings.push({ level: 'error', label: 'Changing kernel limits needs sudo' })
    }

    for (const key of TUNABLE_KEYS) {
      const raw = values[key]
      const asText = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw)
      if (!asText) continue
      if (TEXT_KEYS.has(key)) {
        const parts = asText.split(/\s+/).map(Number)
        if (parts.length !== 2 || parts.some((n) => !Number.isInteger(n))) {
          findings.push({ level: 'error', label: `${key} must be two numbers, "low high"` })
          continue
        }
        const [low, high] = parts
        if (low < 1024 || low >= high || high > 65535) {
          findings.push({
            level: 'error',
            label: `${key} must satisfy 1024 ≤ low < high ≤ 65535`,
            detail: `You entered ${low} ${high}.`
          })
          continue
        }
        wanted[key] = `${low} ${high}`
        continue
      }
      const value = Number(asText)
      if (!Number.isInteger(value)) {
        findings.push({ level: 'error', label: `${key}: "${asText}" is not a whole number` })
        continue
      }
      const ceiling = ceilingFor(key, rules)
      if (value < 128 || value > ceiling) {
        findings.push({
          level: 'error',
          label: `${key} must be between 128 and ${ceiling}`,
          detail: 'The upper bound is a module rule you can change below.'
        })
        continue
      }
      wanted[key] = String(value)
    }

    findings.push(...this.crossChecks(wanted, state))

    const changes = Object.entries(wanted).filter(([key, value]) => value !== state.current[key])
    if (changes.length === 0 && !findings.some((f) => f.level === 'error')) {
      findings.push({ level: 'pass', label: 'Nothing would change' })
      return { ok: false, findings }
    }
    for (const [key, value] of changes) {
      findings.push({ level: 'info', label: `${key}: ${state.current[key] || 'unset'} → ${value}` })
    }

    const ok = !findings.some((f) => f.level === 'error')
    if (!ok) return { ok, findings }
    return { ok, token: this.manualSession.issue(input, Object.fromEntries(changes)), findings }
  }

  async tunablesApply(payload: unknown): Promise<OkResult> {
    const taken = takeToken(this.manualSession, payload)
    if (!taken) return { ok: false, error: 'that check has expired or the form changed - check again' }
    return this.write(taken)
  }

  /** The rules that involve more than one field, or the machine's current load. */
  private crossChecks(wanted: Record<string, string>, state: NetTunables): ModuleCheckFinding[] {
    const out: ModuleCheckFinding[] = []
    for (const family of ['ipv4', 'ipv6'] as const) {
      const value = (n: 1 | 2 | 3): number =>
        toNumber(wanted[`net.${family}.neigh.default.gc_thresh${n}`] ?? state.current[`net.${family}.neigh.default.gc_thresh${n}`])
      const [t1, t2, t3] = [value(1), value(2), value(3)]
      if (t1 && t2 && t3 && !(t1 < t2 && t2 < t3)) {
        out.push({
          level: 'error',
          label: `${family} neighbour thresholds must increase: gc_thresh1 < gc_thresh2 < gc_thresh3`,
          detail: `Would be ${t1}, ${t2}, ${t3}.`
        })
      }
    }
    const fileMax = toNumber(wanted['fs.file-max'])
    if (fileMax && fileMax < state.usage.filesOpen * 2) {
      out.push({
        level: 'warning',
        label: `fs.file-max of ${fileMax} is less than twice what is open right now`,
        detail: `${state.usage.filesOpen} file descriptors are in use.`
      })
    }
    const conntrack = toNumber(wanted['net.netfilter.nf_conntrack_max'])
    if (conntrack && conntrack < state.usage.conntrackCount * 2) {
      out.push({
        level: 'warning',
        label: `nf_conntrack_max of ${conntrack} is less than twice the current count`,
        detail: `${state.usage.conntrackCount} connections are tracked right now.`
      })
    }
    if (wanted['fs.file-max'] || wanted['fs.nr_open']) {
      out.push({
        level: 'info',
        label: 'systemd services have their own descriptor limit',
        detail:
          `The kernel limit is not what a unit gets: set DefaultLimitNOFILE in /etc/systemd/system.conf ` +
          `(or LimitNOFILE on the unit) to raise it. This page does not change that file.`
      })
    }
    return out
  }

  // ---------- Writing ----------

  /**
   * Set each value on the running kernel, then rewrite the whole managed file
   * from what was already persisted plus what just changed - so the file always
   * says exactly what this module has ever applied, and nothing else.
   */
  private async write(changes: Record<string, string>): Promise<OkResult> {
    if (!this.ctx.hasSudo) return { ok: false, error: 'changing kernel limits needs sudo' }
    const failures: string[] = []
    for (const [key, value] of Object.entries(changes)) {
      if (!TUNABLE_KEYS.includes(key as TunableKey)) continue
      if (!/^[\d ]+$/.test(value)) {
        failures.push(`${key}: refused a value that is not numeric`)
        continue
      }
      const res = await this.ctx.execSudo(`sysctl -w ${key}="${value}"`, { timeoutMs: 20000 })
      if (res.code !== 0) failures.push(`${key}: ${(res.stderr || res.stdout).trim() || `exit ${res.code}`}`)
    }

    const state = await this.read()
    const merged = { ...state.persisted, ...changes }
    const body = [
      SYSCTL_HEADER,
      `# Written ${new Date().toISOString()}`,
      ...Object.entries(merged).map(([key, value]) => `${key} = ${value}`),
      ''
    ].join('\n')
    // tee reads the file from stdin, so the content never has to survive being
    // quoted into a command line.
    const written = await this.ctx.execSudo(`tee ${SYSCTL_FILE} >/dev/null`, {
      stdin: body,
      timeoutMs: 20000
    })
    if (written.code !== 0) {
      failures.push(`could not write ${SYSCTL_FILE}: ${(written.stderr || written.stdout).trim()}`)
    } else {
      const reloaded = await this.ctx.execSudo(`sysctl -p ${SYSCTL_FILE}`, { timeoutMs: 20000 })
      if (reloaded.code !== 0) {
        failures.push(`${SYSCTL_FILE} was written but sysctl -p rejected it: ${(reloaded.stderr || reloaded.stdout).trim()}`)
      }
    }

    if (failures.length) return { ok: false, error: failures.join('; ') }
    this.ctx.log(`applied ${Object.keys(changes).length} kernel limit(s) and persisted them to ${SYSCTL_FILE}`)
    return { ok: true, data: `${Object.keys(changes).length}` }
  }

  // ---------- Validation bounds ----------

  rulesEffective(): Record<string, string> {
    const rules = effectiveNetRules(this.ctx)
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(rules)) {
      const isDefault = value === DEFAULT_NET_RULES[key as keyof NetRules]
      out[key] = `${value} (${isDefault ? 'default' : 'custom'})`
    }
    return out
  }

  rulesCheck(input: unknown): ModuleCheckReport {
    const values = (input as Record<string, unknown>) ?? {}
    const findings: ModuleCheckFinding[] = []
    const overrides: Record<string, number> = {}
    const bounds: Record<string, { min: number; max: number }> = {
      maxGcThresh3: { min: 1024, max: 16_000_000 },
      maxFileMax: { min: 65_536, max: 500_000_000 },
      maxInotifyWatches: { min: 8192, max: 100_000_000 }
    }
    for (const [key, bound] of Object.entries(bounds)) {
      const raw = values[key]
      const asText = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw)
      if (!asText) continue
      const value = Number(asText)
      if (!Number.isInteger(value) || value < bound.min || value > bound.max) {
        findings.push({
          level: 'error',
          label: `${key} must be a whole number between ${bound.min} and ${bound.max}`
        })
        continue
      }
      overrides[key] = value
    }
    findings.push({
      level: 'pass',
      label: Object.keys(overrides).length
        ? `${Object.keys(overrides).length} bound(s) will be overridden`
        : 'Every bound will be back at its default'
    })
    const ok = !findings.some((f) => f.level === 'error')
    if (!ok) return { ok, findings }
    return { ok, token: this.rulesSession.issue(input, overrides), findings }
  }

  rulesApply(payload: unknown): OkResult {
    const taken = takeToken(this.rulesSession, payload)
    if (!taken) return { ok: false, error: 'that check has expired or the form changed - check again' }
    this.ctx.configSet({ rules: taken })
    this.ctx.log(`validation bounds saved: ${Object.keys(taken).join(', ') || 'none'}`)
    return { ok: true }
  }

  rulesReset(): OkResult {
    this.ctx.configSet({ rules: {} })
    this.ctx.log('validation bounds cleared')
    return { ok: true }
  }
}

function takeToken<T>(
  session: { take(token: string, values: unknown): { payload: T } | null },
  payload: unknown
): T | null {
  const p = payload as { token?: unknown; values?: unknown } | null
  const token = typeof p?.token === 'string' ? p.token : ''
  return session.take(token, p?.values)?.payload ?? null
}

function ceilingFor(key: string, rules: ReturnType<typeof effectiveNetRules>): number {
  if (key.includes('neigh')) return rules.maxGcThresh3
  if (key === 'fs.file-max' || key === 'fs.nr_open') return rules.maxFileMax
  if (key.startsWith('fs.inotify')) return rules.maxInotifyWatches
  return rules.maxGcThresh3
}

/** Round up to the next power of two, which is what the neighbour table likes. */
function nextPow2(value: number): number {
  let n = 1
  while (n < value) n *= 2
  return n
}

/**
 * The proposals, all of them max(current, …) so a machine already tuned higher
 * keeps what it has. Two addresses per container is the working assumption:
 * one entry for the container and one for whatever it talks to.
 */
export function planFor(targetIps: number, current: Record<string, string>): Record<string, string> {
  const now = (key: string): number => toNumber(current[key])
  const thresh3 = Math.max(now('net.ipv4.neigh.default.gc_thresh3'), nextPow2(2 * targetIps), targetIps >= 1000 ? 16384 : 0)
  const out: Record<string, string> = {
    'net.ipv4.neigh.default.gc_thresh3': String(thresh3),
    'net.ipv4.neigh.default.gc_thresh2': String(Math.floor(thresh3 / 2)),
    'net.ipv4.neigh.default.gc_thresh1': String(Math.floor(thresh3 / 4)),
    'fs.file-max': String(Math.max(now('fs.file-max'), 100 * targetIps + 65536)),
    'fs.nr_open': String(Math.max(now('fs.nr_open'), 1048576)),
    'fs.inotify.max_user_watches': String(Math.max(now('fs.inotify.max_user_watches'), 65536 + 128 * targetIps)),
    'fs.inotify.max_user_instances': String(Math.max(now('fs.inotify.max_user_instances'), 1024)),
    'net.core.somaxconn': String(Math.max(now('net.core.somaxconn'), 4096))
  }
  if (targetIps >= 1000 && current['net.netfilter.nf_conntrack_max']) {
    out['net.netfilter.nf_conntrack_max'] = String(
      Math.max(now('net.netfilter.nf_conntrack_max'), 262144)
    )
  }
  // Only offer to change what the kernel actually has; a key that reads back
  // empty is one this machine does not support.
  for (const key of Object.keys(out)) {
    if (current[key] === undefined) delete out[key]
  }
  return out
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let n = value
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}
