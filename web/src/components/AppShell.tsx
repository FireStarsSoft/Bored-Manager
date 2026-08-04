import { useState, type PropsWithChildren } from "react";
import { NavLink, useLocation, useNavigate } from "../router";
import {
  Activity,
  Bell,
  Blocks,
  Bot,
  Boxes,
  ChevronLeft,
  Command,
  DatabaseBackup,
  Layers3,
  LayoutDashboard,
  LogOut,
  Menu,
  Network,
  PackageCheck,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  SquareTerminal,
  X,
} from "lucide-react";
import { useApi } from "../api/context";
import type { Session } from "../types";
import { Brand } from "./ui";

const primaryNav = [
  ["/overview", "Overview", LayoutDashboard],
  ["/agents", "Agents", Bot],
  ["/services", "Services", Blocks],
  ["/docker-hosts", "Docker hosts", Server],
] as const;

const operationsNav = [
  ["/networks", "Networks", Network],
  ["/templates", "Templates", Layers3],
  ["/jobs", "Jobs", Activity],
  ["/terminal", "Terminal & batch", SquareTerminal],
  ["/alerts", "Alerts", Bell],
] as const;

const systemNav = [
  ["/releases", "Releases", PackageCheck],
  ["/audit", "Audit & backups", DatabaseBackup],
  ["/settings", "Settings", Settings2],
] as const;

function Navigation({ close }: { close(): void }) {
  const item = ([path, label, Icon]: (typeof primaryNav)[number] | (typeof operationsNav)[number] | (typeof systemNav)[number]) => (
    <NavLink key={path} to={path} onClick={close} className={({ isActive }) => isActive ? "nav-item active" : "nav-item"}>
      <Icon size={18} aria-hidden="true" /><span>{label}</span>
    </NavLink>
  );
  return <nav aria-label="Main navigation"><div className="nav-group">{primaryNav.map(item)}</div><p>Operations</p><div className="nav-group">{operationsNav.map(item)}</div><p>System</p><div className="nav-group">{systemNav.map(item)}</div></nav>;
}

export function AppShell({ session, version, onLogout, children }: PropsWithChildren<{ session: Session; version: string; onLogout(): void }>) {
  const api = useApi();
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [query, setQuery] = useState("");

  async function logout() {
    await api.logout().catch(() => undefined);
    onLogout();
  }

  function submitSearch(event: React.FormEvent) {
    event.preventDefault();
    if (query.trim()) navigate(`/overview?q=${encodeURIComponent(query.trim())}`);
  }

  return (
    <div className={`app-layout ${collapsed ? "sidebar-collapsed" : ""}`}>
      {mobileOpen && <button className="nav-scrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}
      <aside className={`sidebar ${mobileOpen ? "mobile-open" : ""}`}>
        <div className="sidebar-brand"><Brand compact={collapsed} /><button className="mobile-close" aria-label="Close navigation" onClick={() => setMobileOpen(false)}><X size={20} /></button></div>
        <Navigation close={() => setMobileOpen(false)} />
        <button className="collapse-button" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}><ChevronLeft size={16} /><span>Collapse sidebar</span></button>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <button className="menu-button" aria-label="Open navigation" onClick={() => setMobileOpen(true)}><Menu size={20} /></button>
          <form className="global-search" role="search" onSubmit={submitSearch}><Search size={17} aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search fleet" placeholder="Search agents, services, jobs..." /><kbd>Ctrl K</kbd></form>
          <div className="topbar-actions">
            <span className="connection-chip"><i /> Authenticated</span>
            <button className="icon-button" aria-label="Open command palette"><Command size={18} /></button>
            <NavLink to="/alerts" className="icon-button" aria-label="Open alerts"><Bell size={18} /></NavLink>
            <div className="user-menu">
              <span>{session.user.displayName.split(" ").map((part) => part[0]).join("")}</span>
              <div><strong>{session.user.displayName}</strong><small>{session.user.role}</small></div>
              <button aria-label="Sign out" onClick={logout}><LogOut size={16} /></button>
            </div>
          </div>
        </header>
        <main id="main-content" key={location.pathname}>{children}</main>
        <footer className="app-footer"><span><ShieldCheck size={14} /> Session protected</span><span>Bored Manager {version}</span></footer>
      </div>
    </div>
  );
}
