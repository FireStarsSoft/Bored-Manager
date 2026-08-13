import * as React from 'react'
import { ArrowRight, Cpu, HardDrive, ListTree, MemoryStick, Network, Server, Timer } from 'lucide-react'
import type { HistoryPoint, OverviewLayoutItem, ServiceEntry, SystemSnapshot } from '@shared/types'
import { SYSTEM_HISTORY_STREAM } from '@shared/types'
import { useApp } from '@/state/store'
import { useWindowedSeries } from '@/lib/history'
import { modulePageTab, useModuleSpecs } from '@/lib/module-registry'
import { useModuleEnabled } from '@/lib/modules'
import { collectOverviewWidgets } from '@/lib/overview-widgets'
import { StatCard, TopConsumers } from '@/components/StatCard'
import { DragHandle, SectionCard } from '@/components/SectionCard'
import { IntervalBadge } from '@/components/IntervalBadge'
import { WindowPicker, useOverviewWindow } from '@/components/WindowPicker'
import { OverviewGrid, type GridBreakpoint, type OverviewCard } from '@/components/OverviewGrid'
import { MeterBar, type ChartPoint } from '@/components/charts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatBytes, formatInterval, formatPct, formatRate, formatUptime } from '@/lib/utils'

/** Sparklines are ~250px wide; more points than that is wasted work. */
const CARD_POINTS = 180

/** Stable identity, so "no settings yet" does not look like a change. */
const EMPTY_WIDGETS: Record<string, boolean> = {}

const liveCpu = (s: SystemSnapshot): ChartPoint => ({ t: s.t, cpu: s.cpu.total })
const liveMem = (s: SystemSnapshot): ChartPoint => ({
  t: s.t,
  mem: s.mem.total ? (s.mem.used / s.mem.total) * 100 : 0
})
const liveNet = (s: SystemSnapshot): ChartPoint => ({ t: s.t, rx: s.netRx, tx: s.netTx })
const liveDisk = (s: SystemSnapshot): ChartPoint => ({
  t: s.t,
  read: s.diskRead,
  write: s.diskWrite
})

const storedCpu = (p: HistoryPoint): ChartPoint => ({ t: p.t, cpu: p.cpu ?? 0 })
const storedMem = (p: HistoryPoint): ChartPoint => ({
  t: p.t,
  mem: p.memTotal ? (p.memUsed / p.memTotal) * 100 : 0
})
const storedNet = (p: HistoryPoint): ChartPoint => ({ t: p.t, rx: p.netRx ?? 0, tx: p.netTx ?? 0 })
const storedDisk = (p: HistoryPoint): ChartPoint => ({
  t: p.t,
  read: p.diskRead ?? 0,
  write: p.diskWrite ?? 0
})

// Each card subscribes to just the slice it needs, so a network tick does
// not re-render an unrelated card.

const PerCoreCard = React.memo(function PerCoreCard(): React.JSX.Element {
  const perCore = useApp((s) => s.system.at(-1)?.cpu.perCore) ?? []
  return (
    <SectionCard title="Per-core CPU" icon={Cpu} iconClass="text-metric-cpu" fast="system">
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        {perCore.map((pct, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span className="w-7 shrink-0 text-right text-[0.65rem] text-muted-foreground">{i}</span>
            <MeterBar pct={pct} color="cpu" />
            <span className="w-8 shrink-0 text-[0.65rem] text-muted-foreground">{pct.toFixed(0)}%</span>
          </div>
        ))}
        {perCore.length === 0 &&
          Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-3.5 w-full" />)}
      </div>
    </SectionCard>
  )
})

const LoadUptimeCard = React.memo(function LoadUptimeCard(): React.JSX.Element {
  const cur = useApp((s) => s.system.at(-1))
  return (
    <SectionCard title="Load & uptime" icon={Timer} iconClass="text-primary" fast="system">
      <div className="grid grid-cols-3 gap-2 text-center">
        {(cur?.load ?? [0, 0, 0]).map((l, i) => (
          <div key={i} className="rounded-md bg-muted py-2">
            <div className="text-sm font-semibold">{l.toFixed(2)}</div>
            <div className="text-[0.65rem] text-muted-foreground">{['1 min', '5 min', '15 min'][i]}</div>
          </div>
        ))}
      </div>
      <div className="mt-2 text-xs text-muted-foreground">
        {cur ? (
          `Uptime: ${formatUptime(cur.uptimeSec)} · host ${cur.hostname}`
        ) : (
          <Skeleton className="h-4 w-44" />
        )}
      </div>
    </SectionCard>
  )
})

const TopProcessesCard = React.memo(function TopProcessesCard(): React.JSX.Element {
  const top = useApp((s) => s.topNow)
  const setActiveTab = useApp((s) => s.setActiveTab)
  const hasProcesses = useApp((s) => s.enabledModules.includes('processes'))
  const byPid = new Map(top?.memory.map((m) => [m.pid, m.value]) ?? [])
  return (
    <SectionCard
      title="Top processes"
      icon={ListTree}
      iconClass="text-metric-cpu"
      fast="processes"
      onClick={hasProcesses ? () => setActiveTab(modulePageTab('processes', 'main')) : undefined}
    >
      <div className="flex flex-col gap-1">
        {(top?.cpu ?? []).slice(0, 5).map((p) => (
          <div key={p.pid} className="flex items-center gap-2 text-xs">
            <span className="w-12 shrink-0 text-muted-foreground mono">{p.pid}</span>
            <span className="min-w-0 flex-1 truncate">{p.name}</span>
            <span className="w-14 shrink-0 text-right text-metric-cpu">{formatPct(p.value)}</span>
            <span className="w-16 shrink-0 text-right text-metric-mem">
              {byPid.has(p.pid) ? formatBytes(byPid.get(p.pid) as number) : '—'}
            </span>
          </div>
        ))}
        {!top?.cpu.length &&
          Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-4 w-full" />)}
      </div>
    </SectionCard>
  )
})

/** Visual treatment per ServiceEntry.kind - self stands out, the rest are neutral-ish. */
const SERVICE_KIND_BADGE: Record<
  ServiceEntry['kind'],
  { label: string; variant: 'secondary' | 'success' | 'warning' | 'default' }
> = {
  self: { label: 'self', variant: 'default' },
  poller: { label: 'poller', variant: 'secondary' },
  stream: { label: 'stream', variant: 'success' },
  shell: { label: 'shell', variant: 'warning' }
}

function ServiceRow({ entry }: { entry: ServiceEntry }): React.JSX.Element {
  const badge = SERVICE_KIND_BADGE[entry.kind]
  return (
    <div className="flex items-center gap-1.5 text-[0.7rem]">
      <Badge variant={badge.variant} className="h-4 w-11 shrink-0 justify-center px-1">
        {badge.label}
      </Badge>
      <Tooltip>
        <TooltipTrigger className="min-w-0 flex-1 truncate text-left">{entry.label}</TooltipTrigger>
        <TooltipContent>{entry.command ?? entry.label}</TooltipContent>
      </Tooltip>
      <span className="w-12 shrink-0 truncate text-right text-muted-foreground">{entry.owner}</span>
      {entry.kind === 'poller' ? (
        <Tooltip>
          <TooltipTrigger className="w-10 shrink-0 text-right text-muted-foreground">
            ~{formatPct(entry.estCostPct ?? 0)}
          </TooltipTrigger>
          <TooltipContent>
            Estimated from the tick's own duration, not a real CPU reading
          </TooltipContent>
        </Tooltip>
      ) : (
        <span className="w-10 shrink-0 text-right font-medium">
          {entry.cpu != null ? formatPct(entry.cpu) : '—'}
        </span>
      )}
      <span className="w-12 shrink-0 text-right font-medium">
        {entry.memBytes != null ? formatBytes(entry.memBytes) : '—'}
      </span>
      <span className="w-8 shrink-0 text-right text-muted-foreground">
        {entry.intervalMs != null ? formatInterval(entry.intervalMs / 1000) : '—'}
      </span>
    </div>
  )
}

/**
 * What Bored Manager itself is running - the server process, every poller
 * (app or module), and any live stream/terminal - alongside what the target
 * machine is doing. Links to the Processes module's Sub services page, which
 * shows every entry instead of just the busiest few.
 */
const AppServicesCard = React.memo(function AppServicesCard(): React.JSX.Element {
  const snap = useApp((s) => s.servicesNow)
  const setActiveTab = useApp((s) => s.setActiveTab)
  const hasProcesses = useModuleEnabled('processes')
  const self = snap?.entries.find((e) => e.kind === 'self')
  const rows = React.useMemo(
    () => (snap ? [...snap.entries].sort((a, b) => (b.cpu ?? -1) - (a.cpu ?? -1)).slice(0, 8) : []),
    [snap]
  )

  return (
    <SectionCard title="App services" icon={Server} iconClass="text-primary" fast="system">
      {!snap ? (
        <div className="flex flex-col gap-1.5">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
      ) : (
        <>
          <div className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{snap.entries.length}</span> services · CPU{' '}
            <span className="font-medium text-foreground">{formatPct(snap.totalCpu)}</span> · RAM{' '}
            <span className="font-medium text-foreground">{formatBytes(snap.totalMemBytes)}</span>
            {self && (
              <span>
                {' '}
                (self {formatPct(self.cpu ?? 0)} · {formatBytes(self.memBytes ?? 0)})
              </span>
            )}
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-[0.6rem] uppercase tracking-wide text-muted-foreground/70">
            <span className="w-11 shrink-0">Kind</span>
            <span className="min-w-0 flex-1">Name</span>
            <span className="w-12 shrink-0 text-right">Owner</span>
            <span className="w-10 shrink-0 text-right">CPU</span>
            <span className="w-12 shrink-0 text-right">RAM</span>
            <span className="w-8 shrink-0 text-right">Tick</span>
          </div>
          <div className="mt-1 flex flex-col gap-1">
            {rows.map((e) => (
              <ServiceRow key={e.id} entry={e} />
            ))}
          </div>
        </>
      )}
      {hasProcesses && (
        <>
          <Separator className="mt-2" />
          <Button
            variant="link"
            size="xs"
            className="mt-1 ml-auto"
            onClick={(e) => {
              e.stopPropagation()
              setActiveTab(modulePageTab('processes', 'subservices'))
            }}
          >
            Details <ArrowRight aria-hidden />
          </Button>
        </>
      )}
    </SectionCard>
  )
})

export function OverviewTab({ active }: { active: boolean }): React.JSX.Element {
  const system = useApp((s) => s.system)
  const top = useApp((s) => s.topNow)
  const settings = useApp((s) => s.settings)
  const enabledIds = useApp((s) => s.enabledModules)
  const updateSettings = useApp((s) => s.updateSettings)
  const setActiveTab = useApp((s) => s.setActiveTab)
  const setOverviewWindow = useApp((s) => s.setOverviewWindow)
  const specsList = useModuleSpecs((s) => s.list)
  const win = useOverviewWindow()

  const curSys = system.at(-1)

  const cpuLive = React.useMemo(() => system.map(liveCpu), [system])
  const memLive = React.useMemo(() => system.map(liveMem), [system])
  const netLive = React.useMemo(() => system.map(liveNet), [system])
  const diskLive = React.useMemo(() => system.map(liveDisk), [system])

  const stream = SYSTEM_HISTORY_STREAM
  const cpuData = useWindowedSeries(stream, win, cpuLive, storedCpu, CARD_POINTS)
  const memData = useWindowedSeries(stream, win, memLive, storedMem, CARD_POINTS)
  const netData = useWindowedSeries(stream, win, netLive, storedNet, CARD_POINTS)
  const diskData = useWindowedSeries(stream, win, diskLive, storedDisk, CARD_POINTS)

  const col = settings?.collectors
  const memPct = curSys?.mem.total ? (curSys.mem.used / curSys.mem.total) * 100 : 0

  /**
   * A click handler only when that page exists. These four cards belong to the
   * app but link to a module's detail page, so with the module disabled there
   * is nowhere to go - and a card that looks clickable but does nothing is
   * worse than one that does not offer.
   */
  const linkTo = (moduleId: string, pageId: string): (() => void) | undefined =>
    enabledIds.includes(moduleId) ? () => setActiveTab(modulePageTab(moduleId, pageId)) : undefined

  const saveLayout = React.useCallback(
    (breakpoint: GridBreakpoint, items: OverviewLayoutItem[]) => {
      const cur = useApp.getState().settings
      if (!cur) return
      void updateSettings({ overviewLayout: { ...cur.overviewLayout, [breakpoint]: items } })
    },
    [updateSettings]
  )

  /**
   * The app's own cards, in the order they appear by default. Everything a
   * module contributes is merged in below, sorted by the `order` it declared.
   */
  const coreCards: Array<{ id: string; order: number; node: React.ReactNode }> = []
  const pushCore = (id: string, order: number, node: React.ReactNode): void => {
    coreCards.push({ id, order, node })
  }

  if (col?.cpu !== false) {
    pushCore(
      'cpu',
      1,
      <StatCard
        title="CPU"
        icon={Cpu}
        color="cpu"
        handle={<DragHandle />}
        badge={<IntervalBadge fast="system" />}
        value={`${(curSys?.cpu.total ?? 0).toFixed(0)}%`}
        sub={
          curSys
            ? `${curSys.cpu.perCore.length} cores · load ${curSys.load[0].toFixed(2)}`
            : 'waiting for data…'
        }
        data={cpuData}
        series={[{ key: 'cpu', color: 'cpu', name: 'CPU %' }]}
        max={100}
        formatValue={formatPct}
        onClick={linkTo('processes', 'main')}
      >
        <TopConsumers entries={top?.cpu} format={formatPct} color="cpu" />
      </StatCard>
    )
  }
  if (col?.memory !== false) {
    pushCore(
      'memory',
      2,
      <StatCard
        title="Memory"
        icon={MemoryStick}
        color="mem"
        handle={<DragHandle />}
        badge={<IntervalBadge fast="system" />}
        value={`${memPct.toFixed(0)}%`}
        sub={
          curSys
            ? `${formatBytes(curSys.mem.used)} / ${formatBytes(curSys.mem.total)}` +
              (curSys.mem.swapTotal > 0 ? ` · swap ${formatBytes(curSys.mem.swapUsed)}` : '')
            : 'waiting for data…'
        }
        data={memData}
        series={[{ key: 'mem', color: 'mem', name: 'Memory %' }]}
        max={100}
        formatValue={formatPct}
        onClick={linkTo('processes', 'main')}
      >
        <TopConsumers entries={top?.memory} format={formatBytes} color="mem" />
      </StatCard>
    )
  }
  if (col?.network !== false) {
    pushCore(
      'network',
      5,
      <StatCard
        title="Network"
        icon={Network}
        color="net"
        handle={<DragHandle />}
        badge={<IntervalBadge fast="system" />}
        value={curSys ? formatRate(curSys.netRx + curSys.netTx) : '…'}
        sub={curSys ? `↓ ${formatRate(curSys.netRx)} · ↑ ${formatRate(curSys.netTx)}` : undefined}
        data={netData}
        series={[
          { key: 'rx', color: 'download', name: '↓ Download' },
          { key: 'tx', color: 'upload', name: '↑ Upload' }
        ]}
        formatValue={formatRate}
        onClick={linkTo('network', 'traffic')}
      >
        <TopConsumers
          entries={top?.network}
          format={formatRate}
          color="net"
          emptyText={
            top
              ? 'No per-process traffic this tick (rates come from TCP sockets; other users need sudo)'
              : undefined
          }
        />
      </StatCard>
    )
  }
  if (col?.disk !== false) {
    pushCore(
      'disk',
      6,
      <StatCard
        title="Disk I/O"
        icon={HardDrive}
        color="disk"
        handle={<DragHandle />}
        badge={<IntervalBadge fast="system" />}
        value={curSys ? formatRate(curSys.diskRead + curSys.diskWrite) : '…'}
        sub={
          curSys
            ? `read ${formatRate(curSys.diskRead)} · write ${formatRate(curSys.diskWrite)}`
            : undefined
        }
        data={diskData}
        series={[
          { key: 'read', color: 'disk', name: 'Read' },
          { key: 'write', color: 'warning', name: 'Write' }
        ]}
        formatValue={formatRate}
        onClick={linkTo('disk', 'devices')}
      >
        <TopConsumers
          entries={top?.disk}
          format={formatRate}
          color="disk"
          emptyText={
            top
              ? 'No process I/O this tick - cache hits, kernel writeback and other users are not attributed to a process'
              : undefined
          }
        />
      </StatCard>
    )
  }

  const widgets = settings?.overviewWidgets ?? EMPTY_WIDGETS
  const on = (id: string, defaultEnabled = false): boolean => widgets[id] ?? defaultEnabled
  if (on('appServices', true)) pushCore('appServices', 7, <AppServicesCard />)
  if (on('perCoreCpu') && col?.cpu !== false) pushCore('perCoreCpu', 10, <PerCoreCard />)
  if (on('loadUptime')) pushCore('loadUptime', 40, <LoadUptimeCard />)
  if (on('topProcesses')) pushCore('topProcesses', 50, <TopProcessesCard />)

  const moduleCards = collectOverviewWidgets(enabledIds, widgets, specsList, active)
  const cards: OverviewCard[] = [...coreCards, ...moduleCards]
    .sort((a, b) => a.order - b.order)
    .map(({ id, node }) => ({ id, node }))

  return (
    <div className="h-full overflow-y-auto p-3">
      {/* The page name is in the header bar now, so this row only carries what
          is specific to the machine and the chart range. */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 text-xs text-muted-foreground">
          {curSys ? (
            <>
              <span className="font-medium text-foreground">{curSys.hostname}</span> · up{' '}
              {formatUptime(curSys.uptimeSec)}
            </>
          ) : (
            <Skeleton className="h-4 w-40" />
          )}
        </div>
        <WindowPicker value={win} onChange={setOverviewWindow} />
      </div>

      <OverviewGrid cards={cards} saved={settings?.overviewLayout} onSaveLayout={saveLayout} />
    </div>
  )
}
