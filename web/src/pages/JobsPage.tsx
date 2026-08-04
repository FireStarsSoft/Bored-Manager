import { useMemo, useState } from "react";
import { Activity, CheckCircle2, CircleX, Clock3, Filter, RefreshCcw, Search } from "lucide-react";
import { useApi } from "../api/context";
import { useAsyncData } from "../hooks/useAsyncData";
import { dateTime } from "../lib/format";
import type { Job } from "../types";
import { Badge, Button, EmptyState, ErrorPanel, LoadingPanel, PageHeader, Panel, StatusBadge } from "../components/ui";

export function JobsPage() {
  const api = useApi(); const resource = useAsyncData<Job[]>((signal) => api.listJobs(signal), [api]);
  const [state, setState] = useState("all"); const [query, setQuery] = useState("");
  const jobs = useMemo(() => (resource.data ?? []).filter((job) => (state === "all" || job.state === state) && (!query || `${job.id} ${job.summary} ${job.actor}`.toLowerCase().includes(query.toLowerCase()))), [resource.data, query, state]);
  return <div className="page"><PageHeader eyebrow="Durable execution" title="Jobs" description="Every action has immutable targets, per-target state and bounded output." actions={<Button variant="secondary" onClick={resource.reload}><RefreshCcw size={16} /> Refresh</Button>} />
    <section className="summary-strip"><span><Activity size={17} /><strong>{resource.data?.filter((j) => ["running", "preparing", "ready"].includes(j.state)).length ?? 0}</strong> active</span><span><CheckCircle2 size={17} /><strong>{resource.data?.filter((j) => j.state === "succeeded").length ?? 0}</strong> succeeded</span><span><CircleX size={17} /><strong>{resource.data?.filter((j) => j.state === "failed").length ?? 0}</strong> failed</span><span><Clock3 size={17} /><strong>{import.meta.env.DEV ? "2s demo" : "--"}</strong> {import.meta.env.DEV ? "batch p95 skew" : "not certified"}</span></section>
    <Panel><div className="panel-heading"><div><h2>Execution history</h2><p>Newest jobs first. Select a row for target attempts and output.</p></div><div className="compact-filters"><label className="table-search"><Search size={16} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search jobs..." aria-label="Search jobs" /></label><label className="select-control"><Filter size={15} /><select value={state} onChange={(e) => setState(e.target.value)} aria-label="Filter job state"><option value="all">All states</option><option value="running">Running</option><option value="succeeded">Succeeded</option><option value="failed">Failed</option><option value="cancelled">Cancelled</option></select></label></div></div>
      {resource.loading ? <LoadingPanel label="Loading jobs" /> : resource.error ? <ErrorPanel message={resource.error} retry={resource.reload} /> : !jobs.length ? <EmptyState title={resource.data?.length ? "No matching jobs" : "Jobs are a pre-alpha capability"}>{resource.data?.length ? "Change the state filter or search." : "Durable execution history will appear here when the job API is enabled."}</EmptyState> : <div className="data-table jobs-table"><div className="data-table-head"><span>Job</span><span>Type</span><span>State</span><span>Targets</span><span>Progress</span><span>Created</span><span>Duration</span></div>{jobs.map((job) => { const complete = job.succeeded + job.failed; return <button className="data-row" key={job.id}><span><strong>{job.summary}</strong><small className="mono">{job.id} / {job.actor}</small></span><span><Badge>{job.type}</Badge></span><span><StatusBadge value={job.state} /></span><span>{job.targetCount}</span><span className="job-progress"><i><b style={{ width: `${job.targetCount ? complete / job.targetCount * 100 : 0}%` }} /></i><small>{complete}/{job.targetCount}</small></span><span><strong>{dateTime(job.createdAt)}</strong></span><span>{job.duration}</span></button>; })}</div>}
    </Panel>
  </div>;
}
