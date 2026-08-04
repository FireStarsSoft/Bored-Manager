import { useEffect, useMemo, useState } from "react";
import { Navigate, Route, Routes } from "./router";
import { ApiContext } from "./api/context";
import { HttpApiClient } from "./api/client";
import { MockApiClient } from "./api/mock";
import { AppShell } from "./components/AppShell";
import { ErrorPanel, LoadingPanel } from "./components/ui";
import { AgentsPage } from "./pages/AgentsPage";
import { AlertsPage } from "./pages/AlertsPage";
import { CapabilityPage } from "./pages/CapabilityPage";
import { DockerHostsPage } from "./pages/DockerHostsPage";
import { JobsPage } from "./pages/JobsPage";
import { LoginPage } from "./pages/LoginPage";
import { OverviewPage } from "./pages/OverviewPage";
import { ReleasesPage } from "./pages/ReleasesPage";
import { ServicesPage } from "./pages/ServicesPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SetupPage } from "./pages/SetupPage";
import { TerminalPage } from "./pages/TerminalPage";
import type { ApiClient, Session, SetupStatus } from "./types";

export function App({ client }: { client?: ApiClient }) {
  const api = useMemo<ApiClient>(() => client ?? (import.meta.env.VITE_API_MODE === "mock" || (import.meta.env.DEV && import.meta.env.VITE_API_MODE !== "live") ? new MockApiClient() : new HttpApiClient(import.meta.env.VITE_API_BASE_URL || "")), [client]);
  const [status, setStatus] = useState<SetupStatus>();
  const [session, setSession] = useState<Session | null>();
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError(undefined);
    api.getSetupStatus(controller.signal)
      .then(async (value) => { setStatus(value); setSession(value.configured ? await api.getSession(controller.signal) : null); })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "The manager is unavailable."));
    return () => controller.abort();
  }, [api, revision]);

  return <ApiContext.Provider value={api}>{error ? <div className="boot-screen"><ErrorPanel message={error} retry={() => setRevision((v) => v + 1)} /></div> : !status || session === undefined ? <div className="boot-screen"><LoadingPanel label="Securing your workspace" /></div> : !status.configured ? <SetupPage status={status} onComplete={setSession} /> : !session ? <LoginPage status={status} onAuthenticated={setSession} /> : <AppShell session={session} version={status.version} onLogout={() => setSession(null)}><Routes><Route path="/overview" element={<OverviewPage />} /><Route path="/agents" element={<AgentsPage />} /><Route path="/services" element={<ServicesPage />} /><Route path="/docker-hosts" element={<DockerHostsPage />} /><Route path="/networks" element={<CapabilityPage kind="networks" />} /><Route path="/templates" element={<CapabilityPage kind="templates" />} /><Route path="/jobs" element={<JobsPage />} /><Route path="/terminal" element={<TerminalPage />} /><Route path="/alerts" element={<AlertsPage />} /><Route path="/releases" element={<ReleasesPage />} /><Route path="/audit" element={<CapabilityPage kind="audit" />} /><Route path="/settings" element={<SettingsPage />} /><Route path="*" element={<Navigate to="/overview" replace />} /></Routes></AppShell>}</ApiContext.Provider>;
}
