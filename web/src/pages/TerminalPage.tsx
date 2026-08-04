import { useMemo, useState, type FormEvent } from "react";
import { AlertTriangle, Bot, Check, ChevronDown, CircleStop, Clock3, Command, Play, RotateCcw, Search, ShieldAlert, SquareTerminal } from "lucide-react";
import { useApi } from "../api/context";
import { useAsyncData } from "../hooks/useAsyncData";
import type { Agent } from "../types";
import { Badge, Button, EmptyState, ErrorPanel, LoadingPanel, PageHeader, Panel, StatusBadge, Toast } from "../components/ui";

type ConsoleLine = { source: string; tone?: "error" | "muted" | "success"; text: string };

export function TerminalPage() {
  const api = useApi();
  const agents = useAsyncData<Agent[]>((signal) => api.listAgents(signal), [api]);
  const [mode, setMode] = useState<"single" | "batch">("batch");
  const [targets, setTargets] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [command, setCommand] = useState("systemctl --failed --no-legend");
  const [root, setRoot] = useState(false);
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<ConsoleLine[]>([
    { source: "system", tone: "muted", text: "Commands are prepared on every target before the execution barrier commits." },
    { source: "system", tone: "muted", text: "Select one or more online agents to begin." },
  ]);
  const [notice, setNotice] = useState<string>();
  const visible = useMemo(() => (agents.data ?? []).filter((agent) => agent.presence === "online" && (!filter || `${agent.alias} ${agent.host}`.toLowerCase().includes(filter.toLowerCase()))), [agents.data, filter]);

  if (!import.meta.env.DEV) {
    return <div className="page terminal-page"><PageHeader eyebrow="Interactive operations" title="Terminal & batch" description="Separate PTY and durable batch execution are blocked until their security and cleanup gates pass." /><Panel><EmptyState title="Terminal execution is unavailable in this pre-alpha">This production build does not submit commands. Use the documented systemd and bmctl diagnostics procedures while the PTY, reauthentication, cancellation, output-bounding, and orphan-process acceptance tests remain incomplete.</EmptyState></Panel></div>;
  }

  function toggle(id: string) { setTargets((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else if (mode === "single") return new Set([id]); else next.add(id); return next; }); }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!command.trim() || !targets.size) return;
    setRunning(true); const selected = (agents.data ?? []).filter((agent) => targets.has(agent.id));
    setLines((current) => [...current, { source: "operator", text: `$ ${command}` }, ...selected.map((agent) => ({ source: agent.alias, tone: "muted" as const, text: "preparing..." }))]);
    try {
      const job = await api.runCommand({ targets: [...targets], command, root });
      window.setTimeout(() => {
        const output = selected.flatMap<ConsoleLine>((agent, index) => index === 1
          ? [{ source: agent.alias, tone: "error", text: "[!] backup.timer loaded failed failed" }, { source: agent.alias, tone: "error", text: "exit 1 / 284 ms" }]
          : [{ source: agent.alias, tone: "success", text: "No failed units." }, { source: agent.alias, tone: "muted", text: "exit 0 / 193 ms" }]);
        setLines((current) => [...current, ...output, { source: "system", tone: "muted", text: `Job ${job.id} committed to ${selected.length} target${selected.length === 1 ? "" : "s"}.` }]);
      }, 350);
      window.setTimeout(() => setRunning(false), 500);
    } catch (cause) { setLines((current) => [...current, { source: "system", tone: "error", text: cause instanceof Error ? cause.message : "Command failed." }]); setRunning(false); }
  }
  return <div className="page terminal-page"><PageHeader eyebrow="Interactive operations" title="Terminal & batch" description="Run complete commands across immutable target snapshots - never broadcast individual keystrokes." actions={<div className="root-toggle"><ShieldAlert size={16} /><span>Root mode</span><button role="switch" aria-checked={root} className={root ? "on" : ""} onClick={() => { setRoot((v) => !v); if (!root) setNotice("Root execution will require re-authentication before commit."); }}><i /></button></div>} />
    {root && <div className="security-callout root-warning"><AlertTriangle size={19} /><div><strong>Root mode is armed</strong><p>The target snapshot and full command will require a second confirmation. No transcript is retained.</p></div></div>}
    <div className="terminal-layout"><Panel className="target-panel"><header><div><h2>Targets</h2><Badge tone="info">{targets.size}/{mode === "single" ? 1 : 200}</Badge></div><div className="segmented"><button className={mode === "single" ? "active" : ""} onClick={() => { setMode("single"); setTargets(new Set()); }}>Single</button><button className={mode === "batch" ? "active" : ""} onClick={() => setMode("batch")}>Batch</button></div></header><label className="table-search"><Search size={15} /><input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter online agents..." aria-label="Filter terminal targets" /></label>{agents.loading ? <LoadingPanel label="Loading targets" /> : agents.error ? <ErrorPanel message={agents.error} retry={agents.reload} /> : <div className="target-list"><button className="target-select-all" onClick={() => setTargets(targets.size === visible.length ? new Set() : new Set(visible.map((a) => a.id)))}><span>{targets.size === visible.length && visible.length ? <Check size={13} /> : null}</span>Select all visible</button>{visible.map((agent) => <button key={agent.id} className={targets.has(agent.id) ? "selected" : ""} onClick={() => toggle(agent.id)}><span className="target-check">{targets.has(agent.id) && <Check size={13} />}</span><i><Bot size={16} /></i><span><strong>{agent.alias}</strong><small>{agent.host} / {agent.shortId}</small></span><StatusBadge value={agent.presence} /></button>)}</div>}</Panel>
      <Panel className="console-panel"><header><div><span className="terminal-dots"><i /><i /><i /></span><strong>{mode === "batch" ? "Batch console" : "Interactive console"}</strong><Badge tone={root ? "critical" : "neutral"}>{root ? "root" : "bored-shell"}</Badge></div><div><button aria-label="Clear console" onClick={() => setLines([])}><RotateCcw size={15} /></button><button aria-label="Stop command" disabled={!running} onClick={() => setRunning(false)}><CircleStop size={16} /></button></div></header><div className="console-output" role="log" aria-live="polite">{lines.map((line, index) => <div className={line.tone ?? ""} key={`${index}-${line.source}`}><span>[{line.source}]</span><pre>{line.text}</pre></div>)}</div><form className="command-bar" onSubmit={submit}><span><Command size={17} /></span><input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="Enter one complete command..." aria-label="Command" /><Button type="submit" busy={running} disabled={!targets.size || !command.trim()}><Play size={15} /> Run on {targets.size || 0}</Button></form><footer><span><Clock3 size={14} /> 30m idle timeout</span><span><SquareTerminal size={14} /> UTF-8 / ANSI / Ctrl-C</span><span>{targets.size} immutable target{targets.size === 1 ? "" : "s"}</span></footer></Panel></div>
    {notice && <Toast title="Elevated execution" message={notice} onClose={() => setNotice(undefined)} />}
  </div>;
}
