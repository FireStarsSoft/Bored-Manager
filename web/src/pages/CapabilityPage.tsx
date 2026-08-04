import type { LucideIcon } from "lucide-react";
import { ArrowRight, Boxes, CheckCircle2, DatabaseBackup, Layers3, Network, Plus, ShieldCheck } from "lucide-react";
import { Badge, Button, EmptyState, PageHeader, Panel } from "../components/ui";

const content = {
  networks: {
    eyebrow: "Address management", title: "Network profiles", description: "Reserve identity before execution and detect conflicts before a container starts.", icon: Network,
    cards: [["management-bridge", "Bridge / 10.24.0.0/20", "248 / 4094 free", "healthy"], ["production-macvlan", "macvlan / 10.40.8.0/24", "87 / 252 free", "healthy"], ["lab-static", "Bridge / 172.22.0.0/24", "193 / 252 free", "review"]],
  },
  templates: {
    eyebrow: "Reproducible systems", title: "Templates", description: "Pin image digests, services, resource limits and network identity in immutable revisions.", icon: Layers3,
    cards: [["Ubuntu worker", "ubuntu@sha256:2f...a91 / revision 12", "18 instances", "signed"], ["PostgreSQL node", "ubuntu@sha256:2f...a91 / revision 6", "8 instances", "signed"], ["Build runner", "ubuntu@sha256:7c...31b / revision 3", "4 instances", "draft"]],
  },
  audit: {
    eyebrow: "Recovery & accountability", title: "Audit & backups", description: "Review security events and keep version-matched, online SQLite backups ready.", icon: DatabaseBackup,
    cards: [["Automatic backup", "Today at 02:00 / 182 MiB", "verified", "healthy"], ["Agent enrollment approved", "Morgan Lee / warehouse-scanner", "8 minutes ago", "signed"], ["Root batch command", "Avery Chen / 4 immutable targets", "Yesterday", "review"]],
  },
} as const;

export function CapabilityPage({ kind }: { kind: keyof typeof content }) {
  const item = content[kind]; const Icon = item.icon as LucideIcon;
  return <div className="page"><PageHeader eyebrow={item.eyebrow} title={item.title} description={item.description} actions={<Button><Plus size={16} /> {kind === "networks" ? "New profile" : kind === "templates" ? "Create template" : "Create backup"}</Button>} />
    {!import.meta.env.DEV ? <Panel><EmptyState title={`${item.title} is a pre-alpha capability`}>The navigation and operating model are ready. Live data will appear here when this manager stage exposes its API.</EmptyState></Panel> : <>
    <div className="capability-hero"><span><Icon size={25} /></span><div><strong>{kind === "audit" ? "Last backup verified" : "All preflight checks passing"}</strong><p>{kind === "networks" ? "No duplicate reservations or overlapping pools detected." : kind === "templates" ? "Every active revision is pinned by digest and signed." : "Database integrity and encrypted credentials passed recovery validation."}</p></div><Badge tone="success"><CheckCircle2 size={12} /> healthy</Badge></div>
    <div className="capability-grid">{item.cards.map(([title, detail, stat, state]) => <Panel className="capability-card" key={title}><header><span><Icon size={19} /></span><Badge tone={state === "review" || state === "draft" ? "warning" : "success"}>{state}</Badge></header><h2>{title}</h2><p>{detail}</p><footer><strong>{stat}</strong><button aria-label={`Open ${title}`}><ArrowRight size={16} /></button></footer></Panel>)}</div>
    <Panel className="roadmap-note"><span><ShieldCheck size={20} /></span><div><h2>Guardrails are always enforced</h2><p>{kind === "networks" ? "Profiles reserve an address before create; failures release it only after ownership is verified." : kind === "templates" ? "Private keys, agent UUIDs and enrollment challenges are never baked into derived images." : "Backups are created with SQLite Online Backup API and validated before they become a restore point."}</p></div></Panel></>}
  </div>;
}
