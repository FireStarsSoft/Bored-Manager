import type { ButtonHTMLAttributes, HTMLAttributes, PropsWithChildren, ReactNode } from "react";
import { AlertTriangle, Check, Inbox, LoaderCircle, X } from "lucide-react";
import type { Severity } from "../types";

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand" aria-label="Bored Manager">
      <span className="brand-mark" aria-hidden="true"><i /><b>BM</b></span>
      {!compact && <span className="brand-copy"><strong>Bored Manager</strong><small>Fleet operations</small></span>}
    </div>
  );
}

export function Button({ variant = "primary", busy, children, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; busy?: boolean }) {
  return (
    <button className={`button button-${variant} ${className}`} disabled={props.disabled || busy} {...props}>
      {busy && <LoaderCircle className="spin" size={16} aria-hidden="true" />}
      {children}
    </button>
  );
}

export function Badge({ tone = "neutral", children, dot = false }: PropsWithChildren<{ tone?: Severity; dot?: boolean }>) {
  return <span className={`badge badge-${tone}`}>{dot && <i aria-hidden="true" />}{children}</span>;
}

export function StatusBadge({ value }: { value: string }) {
  const normalized = value.replaceAll("_", " ");
  const tone: Severity = ["online", "active", "healthy", "connected", "succeeded", "installed", "signed", "live"].includes(value)
    ? "success"
    : ["offline", "failed", "unhealthy", "critical", "expired"].includes(value)
      ? "critical"
      : ["stale", "degraded", "warning", "inactive", "reconnecting", "preparing"].includes(value)
        ? "warning"
        : ["running", "ready", "committed", "leased", "connecting"].includes(value)
          ? "info"
          : "neutral";
  return <Badge tone={tone} dot>{normalized}</Badge>;
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description: string; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1><p>{description}</p></div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function MetricCard({ label, value, detail, tone = "neutral", icon }: { label: string; value: string | number; detail: ReactNode; tone?: Severity; icon: ReactNode }) {
  return (
    <article className={`metric-card metric-${tone}`}>
      <div className="metric-top"><span>{label}</span><i>{icon}</i></div>
      <strong>{value}</strong>
      <div className="metric-detail">{detail}</div>
    </article>
  );
}

export function EmptyState({ title, children, action }: PropsWithChildren<{ title: string; action?: ReactNode }>) {
  return <div className="empty-state"><span><Inbox size={22} /></span><h3>{title}</h3><p>{children}</p>{action}</div>;
}

export function LoadingPanel({ label = "Loading workspace" }: { label?: string }) {
  return <div className="loading-panel" role="status"><LoaderCircle className="spin" size={20} /><span>{label}</span></div>;
}

export function ErrorPanel({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="error-panel" role="alert"><AlertTriangle size={20} /><div><strong>Something needs attention</strong><p>{message}</p></div>{retry && <Button variant="secondary" onClick={retry}>Try again</Button>}</div>;
}

export function Toast({ tone = "success", title, message, onClose }: { tone?: "success" | "critical"; title: string; message: string; onClose(): void }) {
  return <div className={`toast toast-${tone}`} role="status">{tone === "success" ? <Check size={18} /> : <AlertTriangle size={18} />}<div><strong>{title}</strong><span>{message}</span></div><button aria-label="Close notification" onClick={onClose}><X size={16} /></button></div>;
}

export function Panel({ className = "", ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={`panel ${className}`} {...props} />;
}
