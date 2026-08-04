import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "../router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Activity, AlertTriangle, BellRing, Bot, ChevronDown, ChevronRight, ChevronsUpDown, CircleCheck, Filter, Gauge, MoreHorizontal, Search, Server, X } from "lucide-react";
import { useApi } from "../api/context";
import { LiveEventsClient, type LiveState } from "../api/live";
import { useAsyncData } from "../hooks/useAsyncData";
import { compactNumber, relativeTime } from "../lib/format";
import type { Agent, Alert, FleetSummary } from "../types";
import { Badge, Button, EmptyState, ErrorPanel, LoadingPanel, MetricCard, PageHeader, Panel, StatusBadge } from "../components/ui";

interface FleetData { summary: FleetSummary; agents: Agent[]; alerts: Alert[] }

const severityScore = (agent: Agent) => agent.presence === "offline" ? 0 : agent.services.some((service) => service.health === "unhealthy" || service.runtime === "failed") ? 1 : agent.presence === "stale" ? 2 : agent.services.some((service) => service.health === "degraded") ? 3 : 4;

function MiniGauge({ value, danger = false }: { value: number; danger?: boolean }) {
  return <span className={`mini-gauge ${danger || value > 85 ? "danger" : value > 70 ? "warning" : ""}`}><i style={{ width: `${Math.min(100, value)}%` }} /><b>{value}%</b></span>;
}

export function OverviewPage() {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [presence, setPresence] = useState("all");
  const [sort, setSort] = useState("severity");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Agent>();
  const [liveState, setLiveState] = useState<LiveState>(import.meta.env.DEV ? "live" : "connecting");
  const scrollRef = useRef<HTMLDivElement>(null);
  const resource = useAsyncData<FleetData>((signal) => Promise.all([api.getFleetSummary(signal), api.listAgents(signal), api.listAlerts(signal)]).then(([summary, agents, alerts]) => ({ summary, agents, alerts })), [api]);

  useEffect(() => {
    if (resource.data && expanded.size === 0) setExpanded(new Set(resource.data.agents.map((agent) => agent.id)));
  }, [resource.data]);

  useEffect(() => {
    if (!resource.data || import.meta.env.DEV) return;
    const live = new LiveEventsClient(import.meta.env.VITE_WS_URL || undefined);
    return live.connect({
      cursor: resource.data.summary.cursor,
      onState: setLiveState,
      onEvent: (event) => {
        if (event.type === "agent.updated") resource.setData((current) => current ? { ...current, agents: current.agents.map((agent) => agent.id === event.agent.id ? event.agent : agent) } : current);
      },
      onResync: async () => { resource.reload(); return resource.data?.summary.cursor ?? ""; },
    });
  }, [resource.data?.summary.cursor]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const result = (resource.data?.agents ?? []).filter((agent) => {
      const matchesText = !needle || [agent.alias, agent.id, agent.host, agent.container, ...agent.tags, ...agent.services.map((service) => service.name)].some((value) => value.toLowerCase().includes(needle));
      return matchesText && (presence === "all" || agent.presence === presence);
    });
    return [...result].sort((a, b) => sort === "severity" ? severityScore(a) - severityScore(b) : sort === "last_seen" ? new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime() : b.cpuPercent - a.cpuPercent);
  }, [query, presence, sort, resource.data?.agents]);

  const virtualizer = useVirtualizer({ count: filtered.length, getScrollElement: () => scrollRef.current, estimateSize: (index) => expanded.has(filtered[index]?.id) ? 78 + (filtered[index]?.services.length ?? 0) * 48 : 78, overscan: 5, getItemKey: (index) => filtered[index]?.id ?? index });

  function toggle(id: string) {
    setExpanded((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
    window.requestAnimationFrame(() => virtualizer.measure());
  }

  if (resource.loading && !resource.data) return <LoadingPanel label="Loading fleet overview" />;
  if (resource.error && !resource.data) return <ErrorPanel message={resource.error} retry={resource.reload} />;
  const summary = resource.data!.summary;

  return (
    <div className="page overview-page">
      <PageHeader eyebrow="Fleet command" title="Good morning, Morgan." description="Your fleet is stable. Two items need a closer look." actions={<><span className={`live-pill live-${liveState}`}><i />{import.meta.env.DEV ? "Demo data" : liveState}</span><Button variant="secondary"><Activity size={16} /> Run health scan</Button></>} />
      <section className="metrics-grid" aria-label="Fleet summary">
        <MetricCard label="Fleet presence" value={`${summary.agents.online}/${summary.agents.total}`} detail={<><span className="good">{summary.agents.online} online</span><span>{summary.agents.stale} stale / {summary.agents.offline} offline</span></>} tone="success" icon={<Bot size={18} />} />
        <MetricCard label="Service health" value={summary.services.tracked ? `${Math.round(summary.services.healthy / summary.services.tracked * 100)}%` : "-"} detail={<><span className="good">{summary.services.healthy} healthy</span><span>{summary.services.degraded} degraded / {summary.services.unhealthy} failed</span></>} tone="info" icon={<Gauge size={18} />} />
        <MetricCard label="Open alerts" value={resource.data!.alerts.filter((alert) => !alert.acknowledged).length} detail={<><span className="bad">{resource.data!.alerts.filter((alert) => alert.severity === "critical" && !alert.acknowledged).length} critical</span><span>{resource.data!.alerts.filter((alert) => alert.severity === "warning" && !alert.acknowledged).length} warning</span></>} tone="critical" icon={<BellRing size={18} />} />
        <MetricCard label="Active jobs" value={summary.activeJobs} detail={<><span className="info">7 of 12 complete</span><span>No failures</span></>} tone="warning" icon={<Activity size={18} />} />
      </section>

      {resource.data!.alerts.length > 0 && <Panel className="attention-panel">
        <div className="attention-heading"><span><AlertTriangle size={17} /></span><div><strong>Needs attention</strong><p>Prioritized by impact and recurrence</p></div></div>
        {resource.data!.alerts.slice(0, 2).map((alert) => <div className="attention-item" key={alert.id}><Badge tone={alert.severity}>{alert.severity}</Badge><div><strong>{alert.title}</strong><span>{alert.source} / {alert.count} occurrence{alert.count === 1 ? "" : "s"}</span></div><time>{relativeTime(alert.lastSeen)}</time><button>Review</button></div>)}
      </Panel>}

      <Panel className="fleet-panel">
        <div className="panel-heading"><div><h2>Fleet services</h2><p>Each row is one immutable agent identity and its tracked services.</p></div><div className="fleet-count"><CircleCheck size={15} /> {filtered.length} agents</div></div>
        <div className="fleet-toolbar">
          <label className="table-search"><Search size={16} /><input value={query} onChange={(event) => { setQuery(event.target.value); setParams(event.target.value ? { q: event.target.value } : {}); }} placeholder="Search alias, UUID, host, service..." aria-label="Search fleet table" />{query && <button aria-label="Clear search" onClick={() => { setQuery(""); setParams({}); }}><X size={14} /></button>}</label>
          <label className="select-control"><Filter size={15} /><span>Presence</span><select value={presence} onChange={(event) => setPresence(event.target.value)}><option value="all">All</option><option value="online">Online</option><option value="stale">Stale</option><option value="offline">Offline</option></select></label>
          <label className="select-control"><ChevronsUpDown size={15} /><span>Sort</span><select value={sort} onChange={(event) => setSort(event.target.value)}><option value="severity">Severity</option><option value="last_seen">Last seen</option><option value="cpu">CPU usage</option></select></label>
          <Button variant="ghost" onClick={() => setExpanded(expanded.size ? new Set() : new Set(filtered.map((a) => a.id)))}>{expanded.size ? "Collapse all" : "Expand all"}</Button>
        </div>
        <div className="fleet-table-head" aria-hidden="true"><span>Agent / service</span><span>Status</span><span>CPU</span><span>Memory</span><span>Version</span><span>Last check</span><span /></div>
        {filtered.length === 0 ? <EmptyState title="No matching agents">Try a different name, tag, service or presence filter.</EmptyState> : (
          <div className="fleet-scroll" ref={scrollRef} role="table" aria-label="Agent and service health">
            <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
              {virtualizer.getVirtualItems().map((item) => {
                const agent = filtered[item.index];
                const isExpanded = expanded.has(agent.id);
                return (
                  <div key={agent.id} ref={virtualizer.measureElement} data-index={item.index} className={`agent-group presence-${agent.presence}`} style={{ position: "absolute", transform: `translateY(${item.start}px)`, width: "100%" }} role="rowgroup">
                    <div className="agent-row" role="row">
                      <span className="row-primary"><button className="expand-button" onClick={() => toggle(agent.id)} aria-expanded={isExpanded} aria-label={`${isExpanded ? "Collapse" : "Expand"} ${agent.alias}`}>{isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</button><span className={`presence-dot ${agent.presence}`} /><span><strong>{agent.alias}</strong><small>{agent.host} / {agent.container} / {agent.shortId}</small></span></span>
                      <span><StatusBadge value={agent.presence} /></span><span><MiniGauge value={agent.cpuPercent} /></span><span><MiniGauge value={agent.memoryPercent} /></span><span className="mono">v{agent.version}</span><span className="muted">{relativeTime(agent.lastSeen)}</span><button className="row-menu" aria-label={`Actions for ${agent.alias}`} onClick={() => setSelected(agent)}><MoreHorizontal size={17} /></button>
                    </div>
                    {isExpanded && agent.services.map((service) => <div className="service-row" role="row" key={service.id}><span className="row-primary"><i className="tree-line" /><span><strong>{service.name}</strong><small>{service.errorSummary || service.key}</small></span></span><span><StatusBadge value={service.runtime === "failed" ? "failed" : service.health} /></span><span className="muted">{service.availability}</span><span className="muted">{service.runtime}</span><span className="mono">{service.version ?? "-"}</span><span className="muted">{relativeTime(service.lastCheck)}</span><button className="row-menu" aria-label={`Actions for ${service.name}`}><MoreHorizontal size={17} /></button></div>)}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <div className="table-footnote"><Server size={14} /> Rendering {virtualizer.getVirtualItems().length} of {filtered.length} row groups / {compactNumber(summary.services.tracked)} observations tracked</div>
      </Panel>
      {selected && <aside className="detail-drawer" aria-label={`${selected.alias} details`}><header><div><p className="eyebrow">Agent details</p><h2>{selected.alias}</h2></div><button aria-label="Close details" onClick={() => setSelected(undefined)}><X size={19} /></button></header><div className="drawer-presence"><StatusBadge value={selected.presence} /><span>Last heartbeat {relativeTime(selected.lastSeen)}</span></div><dl><div><dt>Identity</dt><dd className="mono">{selected.id}</dd></div><div><dt>Docker host</dt><dd>{selected.host}</dd></div><div><dt>Container</dt><dd>{selected.container}</dd></div><div><dt>Agent version</dt><dd>{selected.version}</dd></div><div><dt>Network</dt><dd>RX {selected.networkRxKbps} / TX {selected.networkTxKbps} Kbps</dd></div></dl><h3>Inventory</h3><div className="resource-bars"><label>CPU <MiniGauge value={selected.cpuPercent} /></label><label>Memory <MiniGauge value={selected.memoryPercent} /></label><label>Disk <MiniGauge value={selected.diskPercent} /></label></div><h3>Tags</h3><div className="tag-list">{selected.tags.map((tag) => <Badge key={tag}>{tag}</Badge>)}</div><footer><Button variant="secondary">Open terminal</Button><Button>View full details</Button></footer></aside>}
    </div>
  );
}
