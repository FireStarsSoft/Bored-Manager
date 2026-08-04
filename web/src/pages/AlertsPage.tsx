import { useState } from "react";
import { BellRing, Check, Filter, ShieldCheck } from "lucide-react";
import { useApi } from "../api/context";
import { useAsyncData } from "../hooks/useAsyncData";
import { dateTime } from "../lib/format";
import type { Alert } from "../types";
import { Badge, Button, EmptyState, ErrorPanel, LoadingPanel, PageHeader, Panel } from "../components/ui";

export function AlertsPage() {
  const api = useApi(); const resource = useAsyncData<Alert[]>((signal) => api.listAlerts(signal), [api]); const [showAcknowledged, setShowAcknowledged] = useState(true);
  async function acknowledge(id: string) { await api.acknowledgeAlert(id); resource.setData((current) => current?.map((alert) => alert.id === id ? { ...alert, acknowledged: true } : alert)); }
  const alerts = (resource.data ?? []).filter((alert) => showAcknowledged || !alert.acknowledged);
  return <div className="page"><PageHeader eyebrow="In-app signals" title="Alerts" description="Deduplicated fleet conditions that need an operator decision." actions={<Button variant="secondary" disabled={!import.meta.env.DEV}><ShieldCheck size={16} /> Acknowledge all read</Button>} />
    <Panel><div className="panel-heading"><div><h2>Open conditions</h2><p>Sorted by severity, then most recently observed.</p></div><label className="checkbox"><input type="checkbox" checked={showAcknowledged} onChange={(e) => setShowAcknowledged(e.target.checked)} /><span>Show acknowledged</span></label></div>
      {resource.loading ? <LoadingPanel label="Loading alerts" /> : resource.error ? <ErrorPanel message={resource.error} retry={resource.reload} /> : !alerts.length ? <EmptyState title={import.meta.env.DEV ? "All clear" : "Alerts are a pre-alpha capability"}>{import.meta.env.DEV ? "No unacknowledged alerts match this view." : "No alert status is inferred while monitoring, deduplication, persistence, and remediation acceptance tests remain incomplete."}</EmptyState> : <div className="alert-list">{alerts.map((alert) => <article key={alert.id} className={alert.acknowledged ? "acknowledged" : ""}><span className={`alert-symbol ${alert.severity}`}><BellRing size={18} /></span><div><header><Badge tone={alert.severity}>{alert.severity}</Badge>{alert.acknowledged && <Badge><Check size={12} /> acknowledged</Badge>}</header><h3>{alert.title}</h3><p>{alert.source}</p></div><dl><div><dt>Last seen</dt><dd>{dateTime(alert.lastSeen)}</dd></div><div><dt>Occurrences</dt><dd>{alert.count}</dd></div></dl>{!alert.acknowledged && <Button variant="secondary" onClick={() => acknowledge(alert.id)}><Check size={15} /> Acknowledge</Button>}</article>)}</div>}
    </Panel>
  </div>;
}
