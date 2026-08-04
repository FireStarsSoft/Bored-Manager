import { useMemo, useState } from "react";
import { AlertTriangle, Bot, Check, Copy, Fingerprint, MoreHorizontal, PackageOpen, Plus, Search, ShieldCheck, X } from "lucide-react";
import { useApi } from "../api/context";
import { useAsyncData } from "../hooks/useAsyncData";
import { dateTime, relativeTime } from "../lib/format";
import type { Agent, AgentInstallCommand, EnrollmentRequest } from "../types";
import { Badge, Button, EmptyState, ErrorPanel, LoadingPanel, PageHeader, Panel, StatusBadge, Toast } from "../components/ui";

export function AgentsPage() {
  const api = useApi();
  const [tab, setTab] = useState<"fleet" | "pending">("fleet");
  const [query, setQuery] = useState("");
  const [decision, setDecision] = useState<{ request: EnrollmentRequest; type: "approve" | "reject" }>();
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [rejectionReason, setRejectionReason] = useState("Identity could not be verified out of band");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [installOpen, setInstallOpen] = useState(false);
  const [installLoading, setInstallLoading] = useState(false);
  const [installError, setInstallError] = useState<string>();
  const [install, setInstall] = useState<AgentInstallCommand>();
  const agents = useAsyncData<Agent[]>((signal) => api.listAgents(signal), [api]);
  const pending = useAsyncData<EnrollmentRequest[]>((signal) => api.listEnrollments(signal), [api]);
  const filtered = useMemo(() => (agents.data ?? []).filter((agent) => !query || `${agent.alias} ${agent.id} ${agent.host} ${agent.tags.join(" ")}`.toLowerCase().includes(query.toLowerCase())), [agents.data, query]);

  async function decide() {
    if (!decision) return;
    setBusy(true);
    try {
      await api.reauthenticate(password);
      await api.decideEnrollment(decision.request.id, decision.type, { verificationCode: decision.type === "approve" ? code : undefined, alias: decision.type === "approve" ? decision.request.alias : undefined, tags: decision.type === "approve" ? [] : undefined, reason: decision.type === "reject" ? rejectionReason : undefined });
      setNotice(`${decision.request.alias} was ${decision.type === "approve" ? "approved" : "rejected"}.`);
      setDecision(undefined); setCode(""); setPassword(""); setRejectionReason("Identity could not be verified out of band"); pending.reload();
    } finally { setBusy(false); }
  }

  async function openInstall() {
    setInstallOpen(true); setInstallLoading(true); setInstallError(undefined);
    try { setInstall(await api.getAgentInstallCommand()); }
    catch (cause) { setInstallError(cause instanceof Error ? cause.message : "The install command is unavailable."); }
    finally { setInstallLoading(false); }
  }

  return (
    <div className="page">
      <PageHeader eyebrow="Identity & access" title="Agents" description="Manage immutable agent identities and approve new enrollment requests." actions={<Button onClick={openInstall}><Plus size={16} /> Install an agent</Button>} />
      <div className="tab-bar" role="tablist"><button role="tab" aria-selected={tab === "fleet"} className={tab === "fleet" ? "active" : ""} onClick={() => setTab("fleet")}>Fleet <span>{agents.data?.length ?? "-"}</span></button><button role="tab" aria-selected={tab === "pending"} className={tab === "pending" ? "active" : ""} onClick={() => setTab("pending")}>Pending approval <span className={(pending.data?.length ?? 0) > 0 ? "attention" : ""}>{pending.data?.length ?? "-"}</span></button></div>
      {tab === "fleet" && <Panel>
        <div className="panel-heading"><div><h2>Enrolled identities</h2><p>Reinstalling an agent creates a new identity; history remains linked.</p></div><label className="table-search"><Search size={16} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search agents..." aria-label="Search agents" /></label></div>
        {agents.loading ? <LoadingPanel label="Loading agents" /> : agents.error ? <ErrorPanel message={agents.error} retry={agents.reload} /> : filtered.length === 0 ? <EmptyState title="No agents found">Try a different search or install a new agent.</EmptyState> : <div className="data-table agent-list"><div className="data-table-head"><span>Identity</span><span>Presence</span><span>Docker host</span><span>Resources</span><span>Version</span><span>Last seen</span><span /></div>{filtered.map((agent) => <div className="data-row" key={agent.id}><span className="identity-cell"><i className={`agent-avatar ${agent.presence}`}><Bot size={17} /></i><span><strong>{agent.alias}</strong><small>{agent.shortId} / {agent.tags.join(", ")}</small></span></span><span><StatusBadge value={agent.presence} /></span><span><strong>{agent.host}</strong><small>{agent.container}</small></span><span><strong>{agent.cpuPercent}% CPU</strong><small>{agent.memoryPercent}% memory / {agent.diskPercent}% disk</small></span><span className="mono">v{agent.version}</span><span><strong>{relativeTime(agent.lastSeen)}</strong><small>{agent.services.length} services tracked</small></span><button className="row-menu" aria-label={`Actions for ${agent.alias}`}><MoreHorizontal size={17} /></button></div>)}</div>}
      </Panel>}
      {tab === "pending" && <>
        <div className="security-callout"><ShieldCheck size={20} /><div><strong>Verify out of band before approval</strong><p>Compare the fingerprint or short code on the target machine. Approval issues a client certificate immediately.</p></div></div>
        {pending.loading ? <LoadingPanel label="Loading enrollment requests" /> : pending.error ? <ErrorPanel message={pending.error} retry={pending.reload} /> : !pending.data?.length ? <Panel><EmptyState title="No pending requests">New CSR-based enrollment attempts appear here for ten minutes.</EmptyState></Panel> : <div className="enrollment-grid">{pending.data.map((request) => <Panel className="enrollment-card" key={request.id}><header><div><span className="request-icon"><Fingerprint size={20} /></span><div><h2>{request.alias}</h2><p>{request.sourceAddress} / {request.agentVersion}</p></div></div><Badge tone="warning" dot>Expires {relativeTime(request.expiresAt)}</Badge></header><dl><div><dt>Inventory</dt><dd>{request.os} / {request.architecture}</dd></div><div><dt>Requested</dt><dd>{dateTime(request.requestedAt)}</dd></div><div><dt>CSR fingerprint</dt><dd className="copy-value"><code>{request.fingerprint}</code><button aria-label="Copy fingerprint" onClick={() => navigator.clipboard?.writeText(request.fingerprint)}><Copy size={15} /></button></dd></div><div><dt>Verification code</dt><dd className="verify-code">{request.verificationCode}</dd></div></dl><footer><Button variant="danger" onClick={() => setDecision({ request, type: "reject" })}>Reject</Button><Button onClick={() => setDecision({ request, type: "approve" })}><Check size={16} /> Verify & approve</Button></footer></Panel>)}</div>}
      </>}
      {decision && <div className="modal-backdrop" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="decision-title"><header><div><p className="eyebrow">Enrollment decision</p><h2 id="decision-title">{decision.type === "approve" ? "Approve" : "Reject"} {decision.request.alias}?</h2></div><button aria-label="Close dialog" onClick={() => setDecision(undefined)}><X size={19} /></button></header>{decision.type === "approve" ? <><p>On the target machine, confirm the fingerprint then enter the short verification code exactly as shown.</p><div className="fingerprint-confirm"><Fingerprint size={17} /><code>{decision.request.fingerprint}</code></div><label>Verification code<input autoFocus value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="CINDER-47" /></label></> : <><p>This request will be invalidated immediately. The agent must generate a fresh key and CSR before trying again.</p><label>Rejection reason<input value={rejectionReason} onChange={(e) => setRejectionReason(e.target.value)} maxLength={160} /></label></>}<label>Re-enter your password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label><div className="security-caption"><ShieldCheck size={16} /> Password verification opens a server-side reauthentication window for five minutes.</div><footer><Button variant="ghost" onClick={() => setDecision(undefined)}>Cancel</Button><Button variant={decision.type === "approve" ? "primary" : "danger"} busy={busy} disabled={!password || (decision.type === "approve" ? code !== decision.request.verificationCode : !rejectionReason.trim())} onClick={decide}>{decision.type === "approve" ? "Approve identity" : "Reject request"}</Button></footer></section></div>}
      {installOpen && <div className="modal-backdrop"><section className="modal install-modal" role="dialog" aria-modal="true" aria-labelledby="install-title"><header><div><p className="eyebrow">Pinned agent bootstrap</p><h2 id="install-title">Install an agent</h2></div><button aria-label="Close dialog" onClick={() => setInstallOpen(false)}><X size={19} /></button></header>{installLoading ? <LoadingPanel label="Preparing a version-pinned command" /> : installError ? <ErrorPanel message={installError} retry={openInstall} /> : install?.available ? <><p>Run this command on a supported Ubuntu 24.04 or Kali Rolling amd64 target. It verifies the exact release package and pins this manager identity.</p><dl className="install-meta"><div><dt>Agent version</dt><dd>{install.version}</dd></div><div><dt>Manager</dt><dd>{install.managerUrl}</dd></div><div><dt>SPKI pin</dt><dd className="mono">{install.managerSpkiPin}</dd></div></dl><div className="command-copy"><code>{install.command}</code><Button variant="secondary" onClick={() => { navigator.clipboard?.writeText(install.command); setNotice("Pinned agent install command copied."); }}><Copy size={15} /> Copy</Button></div><div className="security-caption"><ShieldCheck size={16} /> The command contains no bearer token. Approval still happens in this console.</div></> : <div className="install-unavailable"><span><AlertTriangle size={21} /></span><div><h3>No runnable package yet</h3><p>{install?.reason || "Agent packages are not available for this development build."}</p></div></div>}<footer><Button variant="ghost" onClick={() => setInstallOpen(false)}>Close</Button>{install?.available && <Button onClick={() => setTab("pending")}><PackageOpen size={15} /> View pending approvals</Button>}</footer></section></div>}
      {notice && <Toast title="Enrollment updated" message={notice} onClose={() => setNotice(undefined)} />}
    </div>
  );
}
