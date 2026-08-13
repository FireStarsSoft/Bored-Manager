import type {
  ListeningPort,
  NetConnection,
  NetGeneralInfo,
  NetIfaceInfo,
  NetProtoStats,
  NetworkHistoryPoint,
  NetworkSnapshot,
  ProcNetUsage
} from '@shared/types'
import type { ModuleContext, ModulePoller } from '@shared/modules'
import { splitSections } from '@shared/shell'
import { MAX_CONNECTIONS, SS_CMD, parseSs, socketKey, splitAddr } from '@shared/ss'

const HISTORY_MS = 5 * 60 * 1000

/**
 * Every tick: byte counters and sockets. `ss -tunapi` is the core - every
 * TCP/UDP socket with owning process and per-socket byte counters, so
 * diffing between ticks gives per-connection and per-process bandwidth
 * without extra tools on the target.
 */
const FAST_CMD = [
  `echo '===DEV==='; cat /proc/net/dev`,
  `echo '===SS==='; ${SS_CMD}`,
  `echo '===SNMP==='; cat /proc/net/snmp 2>/dev/null`
].join('; ')

/**
 * Addresses, link speed, gateway and DNS: an interface does not get a new IP
 * or a new MTU between two ticks, so this part is cached and re-read on the
 * slow network interval instead of every second.
 */
const INVENTORY_CMD = [
  `echo '===ADDR==='; ip -j addr 2>/dev/null || true`,
  `echo '===LINKS==='; for d in /sys/class/net/*; do n=$(basename "$d"); ` +
    `echo "$n|$(cat "$d/operstate" 2>/dev/null)|$(cat "$d/speed" 2>/dev/null)|` +
    `$(cat "$d/address" 2>/dev/null)|$(cat "$d/mtu" 2>/dev/null)"; done`,
  `echo '===ROUTE==='; ip -j route show default 2>/dev/null || ip route show default 2>/dev/null || true`,
  `echo '===DNS==='; cat /etc/resolv.conf 2>/dev/null || true`
].join('; ')

// ---------- parsing helpers ----------

/** /proc/net/snmp: pairs of "Proto: names..." / "Proto: values..." lines. */
function parseSnmp(text: string): Record<string, Record<string, number>> {
  const tables: Record<string, Record<string, number>> = {}
  const lines = text.split('\n')
  for (let i = 0; i + 1 < lines.length; i++) {
    const h = lines[i].match(/^(\w+):\s+(.*)$/)
    const v = lines[i + 1].match(/^(\w+):\s+(.*)$/)
    if (!h || !v || h[1] !== v[1]) continue
    const keys = h[2].trim().split(/\s+/)
    const vals = v[2].trim().split(/\s+/)
    if (keys.length !== vals.length || !/^-?\d+$/.test(vals[0] ?? '')) continue
    const t = (tables[h[1]] ??= {})
    keys.forEach((k, j) => (t[k] = parseInt(vals[j], 10) || 0))
  }
  return tables
}

interface DevCounters {
  rxBytes: number
  rxPackets: number
  rxErrors: number
  rxDrops: number
  txBytes: number
  txPackets: number
  txErrors: number
  txDrops: number
}

function parseDev(text: string): Map<string, DevCounters> {
  const map = new Map<string, DevCounters>()
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([^\s:]+):\s*(.*)$/)
    if (!m) continue
    const f = m[2].trim().split(/\s+/)
    if (f.length < 12) continue
    map.set(m[1], {
      rxBytes: parseInt(f[0], 10) || 0,
      rxPackets: parseInt(f[1], 10) || 0,
      rxErrors: parseInt(f[2], 10) || 0,
      rxDrops: parseInt(f[3], 10) || 0,
      txBytes: parseInt(f[8], 10) || 0,
      txPackets: parseInt(f[9], 10) || 0,
      txErrors: parseInt(f[10], 10) || 0,
      txDrops: parseInt(f[11], 10) || 0
    })
  }
  return map
}

interface AddrDetails {
  mac: string
  mtu: number
  state: string
  ipv4: string[]
  ipv6: string[]
}

function parseAddrJson(text: string): Map<string, AddrDetails> {
  const map = new Map<string, AddrDetails>()
  try {
    const arr = JSON.parse(text) as Array<{
      ifname?: string
      address?: string
      mtu?: number
      operstate?: string
      addr_info?: Array<{ family?: string; local?: string }>
    }>
    if (!Array.isArray(arr)) return map
    for (const it of arr) {
      if (!it.ifname) continue
      map.set(it.ifname, {
        mac: it.address ?? '',
        mtu: it.mtu ?? 0,
        state: (it.operstate ?? '').toLowerCase(),
        ipv4: (it.addr_info ?? []).filter((a) => a.family === 'inet' && a.local).map((a) => a.local as string),
        ipv6: (it.addr_info ?? []).filter((a) => a.family === 'inet6' && a.local).map((a) => a.local as string)
      })
    }
  } catch {
    /* ip without -j support: interfaces still come from /proc/net/dev */
  }
  return map
}

/** Default route + resolv.conf, both part of the cached inventory. */
function parseGeneralInfo(routeText: string, dnsText: string): NetGeneralInfo {
  const info: NetGeneralInfo = { gateway: '', gatewayIface: '', dnsServers: [] }
  const routeRaw = routeText.trim()
  if (routeRaw) {
    try {
      const arr = JSON.parse(routeRaw) as Array<{ gateway?: string; dev?: string }>
      if (Array.isArray(arr) && arr[0]) {
        info.gateway = arr[0].gateway ?? ''
        info.gatewayIface = arr[0].dev ?? ''
      }
    } catch {
      const m = routeRaw.match(/default via (\S+)(?: dev (\S+))?/)
      if (m) {
        info.gateway = m[1]
        info.gatewayIface = m[2] ?? ''
      }
    }
  }
  for (const line of dnsText.split('\n')) {
    const m = line.match(/^\s*nameserver\s+(\S+)/)
    if (m) info.dnsServers.push(m[1])
  }
  return info
}

// ---------- service ----------

interface ConnPrev {
  acked: number
  received: number
}

interface LinkInfo {
  state: string
  speed: number | null
  mac: string
  mtu: number
}

/** Everything the fast tick reuses instead of re-reading. */
interface Inventory {
  t: number
  addr: Map<string, AddrDetails>
  links: Map<string, LinkInfo>
  info: NetGeneralInfo
}

export class NetworkService {
  history: NetworkHistoryPoint[] = []
  latest: NetworkSnapshot | null = null

  private prevT = 0
  private prevDev: Map<string, DevCounters> | null = null
  private prevConn = new Map<string, ConnPrev>()
  private prevSnmp: Record<string, Record<string, number>> | null = null
  private sessionRx = 0
  private sessionTx = 0
  private sessionByPid = new Map<number, { process: string; rx: number; tx: number }>()
  private inventory: Inventory | null = null
  private inventoryTtlMs = 60_000

  readonly poller: ModulePoller

  constructor(private ctx: ModuleContext) {
    this.poller = ctx.createPoller('detail', () => this.sample())
  }

  /** How old the cached interface inventory may get, in seconds (0 = never re-read). */
  configure(inventoryIntervalSec: number): void {
    this.inventoryTtlMs = Math.max(0, inventoryIntervalSec) * 1000
  }

  /** When the cached interface inventory was read, for the UI age label. */
  get inventoryAt(): number {
    return this.inventory?.t ?? 0
  }

  reset(): void {
    this.history = []
    this.latest = null
    this.prevT = 0
    this.prevDev = null
    this.prevConn = new Map()
    this.prevSnmp = null
    this.sessionRx = 0
    this.sessionTx = 0
    this.sessionByPid = new Map()
    this.inventory = null
  }

  dispose(): void {
    this.poller.stop()
  }

  private async sample(): Promise<void> {
    if (!this.ctx.connected) return
    const useSudo = this.ctx.hasSudo
    const t0 = Date.now()
    const stale =
      !this.inventory ||
      (this.inventoryTtlMs > 0 && t0 - this.inventory.t >= this.inventoryTtlMs)
    const cmd = stale ? `${INVENTORY_CMD}; ${FAST_CMD}` : FAST_CMD
    const res = useSudo
      ? await this.ctx.execSudo(cmd, { timeoutMs: 20000 })
      : await this.ctx.exec(cmd, { timeoutMs: 20000 })
    if (res.code !== 0 && !res.stdout) return
    const t = Date.now()
    const sec = splitSections(res.stdout)
    const dt = this.prevT ? Math.max((t - this.prevT) / 1000, 0.001) : 0

    // --- Interfaces ---
    const dev = parseDev(sec.get('DEV') ?? '')
    if (stale) {
      const links = new Map<string, LinkInfo>()
      for (const line of (sec.get('LINKS') ?? '').split('\n')) {
        const f = line.split('|')
        if (f.length < 5 || !f[0]) continue
        const speed = parseInt(f[2], 10)
        links.set(f[0], {
          state: f[1].toLowerCase(),
          speed: Number.isFinite(speed) && speed > 0 ? speed : null,
          mac: f[3],
          mtu: parseInt(f[4], 10) || 0
        })
      }
      this.inventory = {
        t,
        addr: parseAddrJson(sec.get('ADDR') ?? ''),
        links,
        info: parseGeneralInfo(sec.get('ROUTE') ?? '', sec.get('DNS') ?? '')
      }
    }
    const addr = this.inventory?.addr ?? new Map<string, AddrDetails>()
    const links = this.inventory?.links ?? new Map<string, LinkInfo>()
    const info: NetGeneralInfo =
      this.inventory?.info ?? { gateway: '', gatewayIface: '', dnsServers: [] }

    const ifaces: NetIfaceInfo[] = []
    let totalRxRate = 0
    let totalTxRate = 0
    for (const [name, cur] of dev) {
      const prev = this.prevDev?.get(name)
      const a = addr.get(name)
      const l = links.get(name)
      const rate = (now: number, before: number | undefined): number =>
        dt && before != null ? Math.max(0, (now - before) / dt) : 0
      const info: NetIfaceInfo = {
        name,
        state: a?.state || l?.state || 'unknown',
        mac: a?.mac || l?.mac || '',
        mtu: a?.mtu || l?.mtu || 0,
        speedMbps: l?.speed ?? null,
        ipv4: a?.ipv4 ?? [],
        ipv6: a?.ipv6 ?? [],
        rxRate: rate(cur.rxBytes, prev?.rxBytes),
        txRate: rate(cur.txBytes, prev?.txBytes),
        rxPktRate: rate(cur.rxPackets, prev?.rxPackets),
        txPktRate: rate(cur.txPackets, prev?.txPackets),
        rxTotal: cur.rxBytes,
        txTotal: cur.txBytes,
        rxErrors: cur.rxErrors,
        txErrors: cur.txErrors,
        rxDrops: cur.rxDrops,
        txDrops: cur.txDrops
      }
      ifaces.push(info)
      if (name !== 'lo') {
        totalRxRate += info.rxRate
        totalTxRate += info.txRate
        if (dt && this.prevDev?.get(name)) {
          this.sessionRx += Math.max(0, cur.rxBytes - (this.prevDev.get(name)?.rxBytes ?? cur.rxBytes))
          this.sessionTx += Math.max(0, cur.txBytes - (this.prevDev.get(name)?.txBytes ?? cur.txBytes))
        }
      }
    }
    ifaces.sort((x, y) => (x.name === 'lo' ? 1 : y.name === 'lo' ? -1 : x.name.localeCompare(y.name)))

    // --- Connections (+ per-connection rates from ss byte counters) ---
    const ssRecords = parseSs(sec.get('SS') ?? '')
    const nextConnPrev = new Map<string, ConnPrev>()
    const connections: NetConnection[] = []
    const listening: ListeningPort[] = []
    const pidDeltas = new Map<number, { process: string; rx: number; tx: number }>()

    for (const r of ssRecords) {
      const local = splitAddr(r.local)
      const peer = splitAddr(r.peer)
      const proto = local.v6 || peer.v6 ? `${r.proto}6` : r.proto
      const key = socketKey(r)

      let rxRate: number | null = null
      let txRate: number | null = null
      let rxDelta = 0
      let txDelta = 0
      if (r.bytesAcked != null || r.bytesReceived != null) {
        const prev = this.prevConn.get(key)
        nextConnPrev.set(key, { acked: r.bytesAcked ?? 0, received: r.bytesReceived ?? 0 })
        if (prev && dt) {
          rxDelta = Math.max(0, (r.bytesReceived ?? 0) - prev.received)
          txDelta = Math.max(0, (r.bytesAcked ?? 0) - prev.acked)
          rxRate = rxDelta / dt
          txRate = txDelta / dt
        } else {
          rxRate = 0
          txRate = 0
        }
      }

      if (r.state === 'LISTEN' || (r.proto === 'udp' && r.state === 'UNCONN')) {
        listening.push({
          id: `${proto}|${r.local}`,
          proto,
          addr: local.addr,
          port: local.port,
          pid: r.pid,
          process: r.process
        })
      }

      connections.push({
        id: key,
        proto,
        state: r.state,
        localAddr: local.addr,
        localPort: local.port,
        remoteAddr: peer.addr,
        remotePort: peer.port,
        pid: r.pid,
        process: r.process,
        rxRate,
        txRate,
        rxTotal: r.bytesReceived,
        txTotal: r.bytesAcked
      })

      if (rxDelta || txDelta) {
        const pid = r.pid ?? -1
        const d = pidDeltas.get(pid) ?? { process: r.process || '(no process info)', rx: 0, tx: 0 }
        d.rx += rxDelta
        d.tx += txDelta
        if (r.process) d.process = r.process
        pidDeltas.set(pid, d)
      }
    }
    this.prevConn = nextConnPrev

    // Session accounting per pid survives tab switches; reset on disconnect.
    for (const [pid, d] of pidDeltas) {
      const s = this.sessionByPid.get(pid) ?? { process: d.process, rx: 0, tx: 0 }
      s.rx += d.rx
      s.tx += d.tx
      if (d.process && d.process !== '(no process info)') s.process = d.process
      this.sessionByPid.set(pid, s)
    }

    // --- Per-process aggregation (current rates + session totals) ---
    const perPid = new Map<number, ProcNetUsage>()
    for (const c of connections) {
      const pid = c.pid ?? -1
      const entry = perPid.get(pid) ?? {
        pid,
        process: c.process || '(no process info)',
        connections: 0,
        rxRate: 0,
        txRate: 0,
        rxSession: 0,
        txSession: 0
      }
      entry.connections++
      entry.rxRate += c.rxRate ?? 0
      entry.txRate += c.txRate ?? 0
      if (c.process) entry.process = c.process
      perPid.set(pid, entry)
    }
    for (const [pid, s] of this.sessionByPid) {
      const entry = perPid.get(pid) ?? {
        pid,
        process: s.process,
        connections: 0,
        rxRate: 0,
        txRate: 0,
        rxSession: 0,
        txSession: 0
      }
      entry.rxSession = s.rx
      entry.txSession = s.tx
      perPid.set(pid, entry)
    }
    const processes = [...perPid.values()].sort(
      (a, b) => b.rxRate + b.txRate - (a.rxRate + a.txRate) || b.rxSession + b.txSession - (a.rxSession + a.txSession)
    )

    // --- Protocol stats (/proc/net/snmp deltas) ---
    const snmp = parseSnmp(sec.get('SNMP') ?? '')
    const tcp = snmp['Tcp'] ?? {}
    const udp = snmp['Udp'] ?? {}
    const prevTcp = this.prevSnmp?.['Tcp'] ?? {}
    const prevUdp = this.prevSnmp?.['Udp'] ?? {}
    const srate = (cur: number | undefined, before: number | undefined): number =>
      dt && cur != null && before != null ? Math.max(0, (cur - before) / dt) : 0
    const proto: NetProtoStats = {
      retransRate: srate(tcp['RetransSegs'], prevTcp['RetransSegs']),
      inSegRate: srate(tcp['InSegs'], prevTcp['InSegs']),
      outSegRate: srate(tcp['OutSegs'], prevTcp['OutSegs']),
      udpInRate: srate(udp['InDatagrams'], prevUdp['InDatagrams']),
      udpOutRate: srate(udp['OutDatagrams'], prevUdp['OutDatagrams']),
      retransTotal: tcp['RetransSegs'] ?? 0,
      udpErrorsTotal: udp['InErrors'] ?? 0
    }
    this.prevSnmp = snmp

    // Cap the connection table: keep the busiest sockets when a server has
    // thousands of them (IPC payload stays small, UI stays responsive).
    let capped = connections
    if (connections.length > MAX_CONNECTIONS) {
      capped = [...connections]
        .sort(
          (a, b) =>
            (b.rxRate ?? 0) + (b.txRate ?? 0) - ((a.rxRate ?? 0) + (a.txRate ?? 0)) ||
            (b.rxTotal ?? 0) + (b.txTotal ?? 0) - ((a.rxTotal ?? 0) + (a.txTotal ?? 0))
        )
        .slice(0, MAX_CONNECTIONS)
    }

    this.prevDev = dev
    this.prevT = t

    const snap: NetworkSnapshot = {
      t,
      sudo: useSudo,
      totalRxRate,
      totalTxRate,
      sessionRx: this.sessionRx,
      sessionTx: this.sessionTx,
      ifaces,
      connections: capped,
      processes,
      listening: listening.sort((a, b) => a.port - b.port),
      proto,
      info
    }
    this.latest = snap

    const ifaceRates: Record<string, { rx: number; tx: number }> = {}
    for (const i of ifaces) {
      if (i.name !== 'lo') ifaceRates[i.name] = { rx: i.rxRate, tx: i.txRate }
    }
    const point: NetworkHistoryPoint = {
      t,
      rx: totalRxRate,
      tx: totalTxRate,
      connCount: connections.length,
      ifaces: ifaceRates
    }
    this.history.push(point)
    const cutoff = t - HISTORY_MS
    while (this.history.length && this.history[0].t < cutoff) this.history.shift()
    this.ctx.addHistory({
      t,
      rx: Math.round(totalRxRate),
      tx: Math.round(totalTxRate),
      conn: connections.length
    })

    // Two streams on purpose: the page needs the full snapshot, the charts only
    // need a handful of numbers. Keeping five minutes of full snapshots in the
    // renderer would mean keeping thousands of connection rows alive.
    this.ctx.emit('snapshot', snap)
    this.ctx.emit('series', point)
  }
}
