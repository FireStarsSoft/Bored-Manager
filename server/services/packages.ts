import type {
  OkResult,
  PackageHistoryEntry,
  PackageInfo,
  PackageManager,
  PackageSearchResult,
  PackagesOverview,
  PkgAction,
  PkgActionState,
  UpgradablePackage
} from '@shared/types'
import { shQuote, splitSections } from '@shared/shell'
import { connection } from '../connection'
import type { StreamHandle } from '../executors/types'
import { registry } from '../session-registry'

/** Conservative allow-list for package names passed to shell commands. */
const PKG_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9+._:@-]*$/

const EMPTY_OVERVIEW: PackagesOverview = {
  manager: 'none',
  installedCount: 0,
  upgradableCount: 0,
  lastListUpdate: null,
  totalInstalledSizeKb: null,
  installed: [],
  upgradable: [],
  history: []
}

// ---------- apt parsing ----------

function parseAptInstalled(text: string): { list: PackageInfo[]; sizeKb: number } {
  const list: PackageInfo[] = []
  let sizeKb = 0
  for (const line of text.split('\n')) {
    const f = line.split('\t')
    if (f.length < 2 || !f[0]) continue
    const kb = parseInt(f[3] ?? '', 10) || 0
    sizeKb += kb
    list.push({
      name: f[0],
      version: f[1] ?? '',
      arch: f[2] ?? '',
      sizeKb: kb,
      summary: f[4] ?? ''
    })
  }
  return { list, sizeKb }
}

function parseAptUpgradable(text: string): UpgradablePackage[] {
  const list: UpgradablePackage[] = []
  for (const line of text.split('\n')) {
    // nano/noble-updates 7.2-2ubuntu0.1 amd64 [upgradable from: 7.2-2]
    const m = line.match(/^(\S+?)\/(\S+)\s+(\S+)\s+\S+(?:\s+\[upgradable from:\s+([^\]]+)\])?/)
    if (!m || m[1] === 'Listing...') continue
    list.push({ name: m[1], repo: m[2], newVersion: m[3], currentVersion: m[4] ?? '' })
  }
  return list
}

function parseAptHistory(text: string): PackageHistoryEntry[] {
  const entries: PackageHistoryEntry[] = []
  for (const block of text.split(/\n\s*\n/)) {
    const date = block.match(/^Start-Date:\s*(.+)$/m)?.[1]?.trim()
    if (!date) continue
    const kinds: string[] = []
    const names: string[] = []
    for (const kind of ['Install', 'Upgrade', 'Remove', 'Purge', 'Downgrade'] as const) {
      const m = block.match(new RegExp(`^${kind}:\\s*(.+)$`, 'm'))
      if (!m) continue
      kinds.push(kind)
      // "htop:amd64 (3.3.0-4), curl:amd64 (8.5.0-2, 8.5.0-3)" -> names only
      for (const part of m[1].split(/\),?\s*/)) {
        const name = part.trim().split(/[\s(]/)[0]
        if (name) names.push(name)
      }
    }
    if (!kinds.length) continue
    const packages = names.slice(0, 12).join(', ') + (names.length > 12 ? `, +${names.length - 12} more` : '')
    entries.push({ date, action: kinds.join(' + '), packages })
  }
  return entries.reverse().slice(0, 15)
}

// ---------- dnf / pacman parsing ----------

function parseRpmInstalled(text: string): { list: PackageInfo[]; sizeKb: number } {
  const list: PackageInfo[] = []
  let sizeKb = 0
  for (const line of text.split('\n')) {
    const f = line.split('\t')
    if (f.length < 2 || !f[0]) continue
    const kb = Math.round((parseInt(f[3] ?? '', 10) || 0) / 1024)
    sizeKb += kb
    list.push({ name: f[0], version: f[1] ?? '', arch: f[2] ?? '', sizeKb: kb, summary: '' })
  }
  return { list, sizeKb }
}

function parseDnfUpgradable(text: string): UpgradablePackage[] {
  const list: UpgradablePackage[] = []
  for (const line of text.split('\n')) {
    // name.arch    1.2.3-1.fc40    updates
    const m = line.match(/^(\S+)\.(\S+)\s+(\S+)\s+(\S+)\s*$/)
    if (!m || m[1] === 'Obsoleting') continue
    list.push({ name: m[1], currentVersion: '', newVersion: m[3], repo: m[4] })
  }
  return list
}

function parsePacmanInstalled(text: string): PackageInfo[] {
  const list: PackageInfo[] = []
  for (const line of text.split('\n')) {
    const m = line.match(/^(\S+)\s+(\S+)\s*$/)
    if (m) list.push({ name: m[1], version: m[2], arch: '', sizeKb: 0, summary: '' })
  }
  return list
}

function parsePacmanUpgradable(text: string): UpgradablePackage[] {
  const list: UpgradablePackage[] = []
  for (const line of text.split('\n')) {
    const m = line.match(/^(\S+)\s+(\S+)\s+->\s+(\S+)\s*$/)
    if (m) list.push({ name: m[1], currentVersion: m[2], newVersion: m[3], repo: '' })
  }
  return list
}

function parsePacmanHistory(text: string): PackageHistoryEntry[] {
  const entries: PackageHistoryEntry[] = []
  for (const line of text.split('\n')) {
    const m = line.match(/^\[([^\]]+)\]\s+\[ALPM\]\s+(installed|upgraded|removed)\s+(\S+)\s*(.*)$/)
    if (m) {
      entries.push({
        date: m[1],
        action: m[2][0].toUpperCase() + m[2].slice(1),
        packages: `${m[3]} ${m[4]}`.trim()
      })
    }
  }
  return entries.reverse().slice(0, 15)
}

// ---------- service ----------

export class PackagesService {
  private manager: PackageManager | null = null
  private action: { handle: StreamHandle; registryId: string } | null = null
  private state: PkgActionState = { running: false }

  constructor(
    private emitLog: (data: string) => void,
    private emitState: (state: PkgActionState) => void
  ) {}

  reset(): void {
    this.manager = null
    this.cancelAction()
    this.state = { running: false }
  }

  getState(): PkgActionState {
    return this.state
  }

  /** Detect the target's package manager once per connection. */
  private async detect(): Promise<PackageManager> {
    if (this.manager) return this.manager
    if (!connection.connected) return 'none'
    const res = await connection.exec(
      `command -v apt-get >/dev/null 2>&1 && echo apt; ` +
        `command -v dnf >/dev/null 2>&1 && echo dnf; ` +
        `command -v pacman >/dev/null 2>&1 && echo pacman; true`,
      { timeoutMs: 10000 }
    )
    const found = res.stdout.split('\n').map((s) => s.trim())
    this.manager = found.includes('apt')
      ? 'apt'
      : found.includes('dnf')
        ? 'dnf'
        : found.includes('pacman')
          ? 'pacman'
          : 'none'
    return this.manager
  }

  async overview(): Promise<PackagesOverview> {
    const manager = await this.detect()
    if (manager === 'none' || !connection.connected) return { ...EMPTY_OVERVIEW, manager }

    if (manager === 'apt') {
      const cmd = [
        `echo '===INSTALLED==='; dpkg-query -W -f='` +
          '${Package}\\t${Version}\\t${Architecture}\\t${Installed-Size}\\t${binary:Summary}\\n' +
          `' 2>/dev/null`,
        `echo '===UPGRADABLE==='; apt list --upgradable 2>/dev/null`,
        `echo '===STAMP==='; stat -c %Y /var/lib/apt/periodic/update-success-stamp 2>/dev/null || stat -c %Y /var/lib/apt/lists 2>/dev/null`,
        `echo '===HISTORY==='; tail -n 600 /var/log/apt/history.log 2>/dev/null`
      ].join('; ')
      const res = await connection.exec(cmd, { timeoutMs: 60000 })
      const sec = splitSections(res.stdout)
      const { list, sizeKb } = parseAptInstalled(sec.get('INSTALLED') ?? '')
      const upgradable = parseAptUpgradable(sec.get('UPGRADABLE') ?? '')
      const stamp = parseInt((sec.get('STAMP') ?? '').trim(), 10)
      return {
        manager,
        installedCount: list.length,
        upgradableCount: upgradable.length,
        lastListUpdate: Number.isFinite(stamp) && stamp > 0 ? stamp * 1000 : null,
        totalInstalledSizeKb: sizeKb,
        installed: list.sort((a, b) => a.name.localeCompare(b.name)),
        upgradable,
        history: parseAptHistory(sec.get('HISTORY') ?? '')
      }
    }

    if (manager === 'dnf') {
      const cmd = [
        `echo '===INSTALLED==='; rpm -qa --qf '%{NAME}\\t%{VERSION}-%{RELEASE}\\t%{ARCH}\\t%{SIZE}\\n' 2>/dev/null`,
        `echo '===UPGRADABLE==='; dnf -q check-update 2>/dev/null || true`
      ].join('; ')
      const res = await connection.exec(cmd, { timeoutMs: 120000 })
      const sec = splitSections(res.stdout)
      const { list, sizeKb } = parseRpmInstalled(sec.get('INSTALLED') ?? '')
      const upgradable = parseDnfUpgradable(sec.get('UPGRADABLE') ?? '')
      return {
        manager,
        installedCount: list.length,
        upgradableCount: upgradable.length,
        lastListUpdate: null,
        totalInstalledSizeKb: sizeKb,
        installed: list.sort((a, b) => a.name.localeCompare(b.name)),
        upgradable,
        history: []
      }
    }

    // pacman
    const cmd = [
      `echo '===INSTALLED==='; pacman -Q 2>/dev/null`,
      `echo '===UPGRADABLE==='; pacman -Qu 2>/dev/null || true`,
      `echo '===HISTORY==='; tail -n 400 /var/log/pacman.log 2>/dev/null`
    ].join('; ')
    const res = await connection.exec(cmd, { timeoutMs: 60000 })
    const sec = splitSections(res.stdout)
    const installed = parsePacmanInstalled(sec.get('INSTALLED') ?? '')
    const upgradable = parsePacmanUpgradable(sec.get('UPGRADABLE') ?? '')
    return {
      manager,
      installedCount: installed.length,
      upgradableCount: upgradable.length,
      lastListUpdate: null,
      totalInstalledSizeKb: null,
      installed,
      upgradable,
      history: parsePacmanHistory(sec.get('HISTORY') ?? '')
    }
  }

  async search(query: string): Promise<PackageSearchResult[]> {
    const manager = await this.detect()
    const q = query.trim()
    if (manager === 'none' || !q || q.length > 100) return []
    const quoted = shQuote(q)

    if (manager === 'apt') {
      const res = await connection.exec(`apt-cache search -- ${quoted} 2>/dev/null | head -n 60`, {
        timeoutMs: 30000
      })
      return res.stdout
        .split('\n')
        .map((l) => l.match(/^(\S+)\s+-\s+(.*)$/))
        .filter((m): m is RegExpMatchArray => !!m)
        .map((m) => ({ name: m[1], summary: m[2] }))
    }

    if (manager === 'dnf') {
      const res = await connection.exec(`dnf -q search -- ${quoted} 2>/dev/null | head -n 60`, {
        timeoutMs: 60000
      })
      return res.stdout
        .split('\n')
        .map((l) => l.match(/^(\S+?)\.\S+\s*:\s*(.*)$/))
        .filter((m): m is RegExpMatchArray => !!m)
        .map((m) => ({ name: m[1], summary: m[2] }))
    }

    const res = await connection.exec(`pacman -Ss -- ${quoted} 2>/dev/null | head -n 120`, {
      timeoutMs: 30000
    })
    const out: PackageSearchResult[] = []
    const lines = res.stdout.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\S+\/(\S+)\s+\S+/)
      if (m) out.push({ name: m[1], summary: (lines[i + 1] ?? '').trim() })
    }
    return out.slice(0, 60)
  }

  /** Build the shell command for an action on the detected manager. */
  private actionCmd(manager: PackageManager, action: PkgAction, pkg?: string): string | null {
    const p = pkg ? shQuote(pkg) : ''
    if (manager === 'apt') {
      const apt = 'DEBIAN_FRONTEND=noninteractive apt-get -y'
      switch (action) {
        case 'update':
          return 'apt-get update'
        case 'upgradeAll':
          return `${apt} upgrade`
        case 'upgrade':
          return p ? `${apt} install --only-upgrade -- ${p}` : null
        case 'install':
          return p ? `${apt} install -- ${p}` : null
        case 'remove':
          return p ? `${apt} remove -- ${p}` : null
        case 'purge':
          return p ? `${apt} purge -- ${p}` : null
        case 'autoremove':
          return `${apt} autoremove`
      }
    }
    if (manager === 'dnf') {
      switch (action) {
        case 'update':
          return 'dnf -y makecache'
        case 'upgradeAll':
          return 'dnf -y upgrade'
        case 'upgrade':
          return p ? `dnf -y upgrade -- ${p}` : null
        case 'install':
          return p ? `dnf -y install -- ${p}` : null
        case 'remove':
        case 'purge':
          return p ? `dnf -y remove -- ${p}` : null
        case 'autoremove':
          return 'dnf -y autoremove'
      }
    }
    if (manager === 'pacman') {
      switch (action) {
        case 'update':
          return 'pacman -Sy --noconfirm'
        case 'upgradeAll':
          return 'pacman -Syu --noconfirm'
        case 'upgrade':
        case 'install':
          return p ? `pacman -S --noconfirm --needed ${p}` : null
        case 'remove':
          return p ? `pacman -R --noconfirm ${p}` : null
        case 'purge':
          return p ? `pacman -Rns --noconfirm ${p}` : null
        case 'autoremove':
          return `pacman -Qtdq | xargs -r pacman -Rns --noconfirm`
      }
    }
    return null
  }

  /**
   * Run a package operation as root, streaming its output to the renderer.
   * Only one operation can run at a time.
   */
  async runAction(action: PkgAction, pkg?: string): Promise<OkResult> {
    if (this.state.running) return { ok: false, error: 'another package operation is running' }
    if (!connection.connected) return { ok: false, error: 'not connected' }
    if (pkg != null && !PKG_NAME_RE.test(pkg)) return { ok: false, error: 'invalid package name' }
    const manager = await this.detect()
    if (manager === 'none') return { ok: false, error: 'no supported package manager found' }
    const cmd = this.actionCmd(manager, action, pkg)
    if (!cmd) return { ok: false, error: 'invalid action' }

    try {
      const handle = await connection.streamSudo(`${cmd} 2>&1`)
      const registryId = registry.register(`packages:${action}`, () => handle.kill())
      this.action = { handle, registryId }
      this.state = { running: true, action, target: pkg }
      this.emitState(this.state)
      this.emitLog(`$ ${cmd}\n`)
      handle.onData((d) => this.emitLog(d))
      handle.onExit((code) => {
        registry.unregister(registryId)
        this.action = null
        this.state = { running: false, action, target: pkg, exitCode: code }
        this.emitLog(`\n[finished with exit code ${code ?? '?'}]\n`)
        this.emitState(this.state)
      })
      return { ok: true }
    } catch (err) {
      this.state = { running: false, action, target: pkg, exitCode: null }
      return { ok: false, error: String(err) }
    }
  }

  cancelAction(): void {
    if (!this.action) return
    registry.unregister(this.action.registryId)
    try {
      this.action.handle.kill()
    } catch {
      /* ignore */
    }
    this.action = null
    if (this.state.running) {
      this.state = { ...this.state, running: false, exitCode: null }
      this.emitState(this.state)
    }
  }
}
