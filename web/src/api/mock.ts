import type {
  Agent,
  Alert,
  ApiClient,
  DockerHost,
  EnrollmentRequest,
  FleetSummary,
  Job,
  Release,
  ServiceDefinition,
  Session,
  Settings,
  SetupInput,
  SetupStatus,
} from "../types";

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const wait = (ms = 90) => new Promise((resolve) => setTimeout(resolve, ms));

const serviceTemplates = [
  ["ssh", "OpenSSH", "9.6p1"],
  ["docker", "Docker Engine", "29.6.2"],
  ["node-exporter", "Node Exporter", "1.9.1"],
  ["postgresql", "PostgreSQL", "16.4"],
] as const;

const aliases = [
  "atlas-prod-01", "atlas-prod-02", "forge-build-01", "cache-east-01", "db-primary", "db-replica",
  "edge-gateway-01", "observability", "sandbox-01", "sandbox-02", "worker-blue-01", "worker-blue-02",
  "worker-green-01", "worker-green-02", "media-pipeline", "ci-runner-01", "ci-runner-02", "vpn-relay",
  "billing-worker", "archive-node", "staging-api-01", "staging-api-02", "qa-automation", "docs-preview",
];

const agents: Agent[] = aliases.map((alias, index) => {
  const presence = index === 3 || index === 19 ? "offline" : index === 7 || index === 21 ? "stale" : "online";
  return {
    id: `018f0f4c-${String(index + 1).padStart(4, "0")}-7a9b-a100-${String(991_000 + index)}`,
    shortId: `a${String(7_430 + index)}`,
    alias,
    host: index < 10 ? "dockyard-01" : index < 18 ? "dockyard-02" : "local",
    container: alias,
    presence,
    version: index % 9 === 0 ? "0.9.4" : "0.9.5",
    lastSeen: ago(presence === "online" ? index % 2 : presence === "stale" ? 3 : 42 + index),
    cpuPercent: 7 + ((index * 11) % 76),
    memoryPercent: 22 + ((index * 7) % 65),
    diskPercent: 31 + ((index * 3) % 53),
    networkRxKbps: 84 + index * 37,
    networkTxKbps: 42 + index * 19,
    tags: index % 3 === 0 ? ["production", "critical"] : index % 3 === 1 ? ["staging"] : ["worker"],
    alerts: presence === "online" && index % 6 !== 0 ? 0 : 1,
    services: serviceTemplates.slice(0, 3 + (index % 2)).map(([key, name, version], serviceIndex) => ({
      id: `${index}-${key}`,
      key,
      name,
      availability: index === 11 && serviceIndex === 2 ? "absent" : "installed",
      runtime: presence === "offline" ? "unknown" : index === 4 && serviceIndex === 3 ? "failed" : index === 7 && serviceIndex === 1 ? "inactive" : "active",
      health: presence !== "online" ? "not_configured" : index === 4 && serviceIndex === 3 ? "unhealthy" : index % 10 === 0 && serviceIndex === 2 ? "degraded" : "healthy",
      version: index === 11 && serviceIndex === 2 ? null : version,
      lastCheck: ago(presence === "online" ? 0.4 : 8 + index),
      lastTransition: ago(160 + index * 13),
      errorSummary: index === 4 && serviceIndex === 3 ? "systemd unit exited with status 1" : undefined,
    })),
  } satisfies Agent;
});

let enrollments: EnrollmentRequest[] = [
  {
    id: "enroll-7821", alias: "warehouse-scanner", sourceAddress: "10.24.8.41", requestedAt: ago(2), expiresAt: new Date(Date.now() + 8 * 60_000).toISOString(),
    fingerprint: "SHA256:4A:9D:31:7C:82:0B:BB:6E:91:2A:CF:45:F2:10:68:DE", verificationCode: "CINDER-47", os: "Ubuntu 24.04.3 LTS", architecture: "amd64", agentVersion: "0.9.5", replayProtected: true,
  },
  {
    id: "enroll-7820", alias: "lab-node-07", sourceAddress: "10.24.12.19", requestedAt: ago(6), expiresAt: new Date(Date.now() + 4 * 60_000).toISOString(),
    fingerprint: "SHA256:9F:28:64:0C:21:AF:79:D5:88:E1:B7:30:12:D3:4F:99", verificationCode: "ORBIT-12", os: "Ubuntu 24.04.3 LTS", architecture: "amd64", agentVersion: "0.9.5", replayProtected: true,
  },
];

const services: ServiceDefinition[] = [
  { id: "svc-ssh", key: "ssh", name: "OpenSSH", description: "Secure shell access and fallback transport", revision: 4, adapter: "systemd", assigned: 24, healthy: 20, supportedOs: "Ubuntu 24.04 / amd64", signed: true },
  { id: "svc-docker", key: "docker", name: "Docker Engine", description: "Container engine service and API health", revision: 7, adapter: "http", assigned: 24, healthy: 21, supportedOs: "Ubuntu 24.04 / amd64", signed: true },
  { id: "svc-node", key: "node-exporter", name: "Node Exporter", description: "Host metrics exporter", revision: 3, adapter: "http", assigned: 18, healthy: 16, supportedOs: "Ubuntu 24.04 / amd64", signed: true },
  { id: "svc-postgres", key: "postgresql", name: "PostgreSQL", description: "PostgreSQL server and readiness check", revision: 2, adapter: "command", assigned: 8, healthy: 7, supportedOs: "Ubuntu 24.04 / amd64", signed: true },
  { id: "svc-nginx", key: "nginx", name: "Nginx", description: "Reverse proxy process and HTTP probe", revision: 5, adapter: "http", assigned: 10, healthy: 10, supportedOs: "Ubuntu 24.04 / amd64", signed: true },
];

let dockerHosts: DockerHost[] = [
  { id: "host-local", name: "local", endpoint: "/var/run/docker.sock", transport: "local_unix", status: "connected", engineVersion: "29.6.2", apiVersion: "1.52", agents: 6, containers: 12, lastChecked: ago(0.2) },
  { id: "host-01", name: "dockyard-01", endpoint: "10.24.4.10:22", transport: "remote_ssh", status: "connected", engineVersion: "29.6.2", apiVersion: "1.52", agents: 10, containers: 18, lastChecked: ago(0.3), fingerprint: "SHA256:fRk3...3pw" },
  { id: "host-02", name: "dockyard-02", endpoint: "10.24.4.11:22", transport: "remote_ssh", status: "degraded", engineVersion: "28.5.1", apiVersion: "1.51", agents: 8, containers: 14, lastChecked: ago(4), fingerprint: "SHA256:T4gP...89x" },
];

let jobs: Job[] = [
  { id: "job-8d20", type: "command", summary: "Refresh package metadata", actor: "Morgan Lee", state: "running", targetCount: 12, succeeded: 7, failed: 0, createdAt: ago(2), duration: "1m 42s" },
  { id: "job-8d1f", type: "service", summary: "Restart node-exporter", actor: "Auto remediation", state: "succeeded", targetCount: 2, succeeded: 2, failed: 0, createdAt: ago(18), duration: "8s" },
  { id: "job-8d1e", type: "provision", summary: "Provision worker-green-02", actor: "Morgan Lee", state: "failed", targetCount: 1, succeeded: 0, failed: 1, createdAt: ago(43), duration: "4m 17s" },
  { id: "job-8d1d", type: "update", summary: "Agent 0.9.5 canary", actor: "Avery Chen", state: "succeeded", targetCount: 3, succeeded: 3, failed: 0, createdAt: ago(125), duration: "2m 09s" },
  { id: "job-8d1c", type: "backup", summary: "Scheduled manager backup", actor: "System", state: "succeeded", targetCount: 1, succeeded: 1, failed: 0, createdAt: ago(520), duration: "22s" },
];

const releases: Release[] = [
  { version: "0.9.5", channel: "beta", publishedAt: ago(360), current: true, signed: true, notes: "Pairing approval, Docker host preflight and dashboard resync improvements.", compatibleAgent: "0.9.x" },
  { version: "0.9.4", channel: "beta", publishedAt: ago(8_100), current: false, signed: true, notes: "Durable jobs and package rollback foundation.", compatibleAgent: "0.9.x" },
  { version: "0.8.2", channel: "alpha", publishedAt: ago(23_000), current: false, signed: true, notes: "First internal monitoring build.", compatibleAgent: "0.8.x" },
];

let alerts: Alert[] = [
  { id: "alert-51", severity: "critical", title: "PostgreSQL health check failed", source: "db-primary / PostgreSQL", firstSeen: ago(16), lastSeen: ago(1), count: 4, acknowledged: false },
  { id: "alert-50", severity: "warning", title: "Agent is offline", source: "cache-east-01", firstSeen: ago(56), lastSeen: ago(11), count: 3, acknowledged: false },
  { id: "alert-49", severity: "warning", title: "Docker API compatibility floor", source: "dockyard-02", firstSeen: ago(240), lastSeen: ago(4), count: 1, acknowledged: true },
];

let settings: Settings = {
  organizationName: "Northstar Lab", bindAddress: "0.0.0.0", webPort: 8443, agentPort: 9443, releaseChannel: "beta", retentionDays: 30, quotaGiB: 10, requireRootReauthentication: true,
};

const session: Session = {
  user: { id: "user-01", username: "morgan", displayName: "Morgan Lee", role: "admin" },
  expiresAt: new Date(Date.now() + 8 * 60 * 60_000).toISOString(),
};

export class MockApiClient implements ApiClient {
  private signedIn = false;

  async getSetupStatus(): Promise<SetupStatus> { await wait(); return { configured: true, version: "0.9.5-dev", serverFingerprint: "SHA256:21:8F:98:4C:6A:D1:39:B0:87:F2:2D:B3:2E:65:AA:11", localDocker: "available" }; }
  async completeSetup(_input: SetupInput) { await wait(250); this.signedIn = true; return session; }
  async getSession() { await wait(40); return this.signedIn ? session : null; }
  async login(username: string, password: string) { await wait(240); if (!username || !password) throw new Error("Enter your username and password."); this.signedIn = true; return session; }
  async reauthenticate(password: string) { await wait(120); if (!password) throw new Error("Enter your current password."); }
  async logout() { await wait(); this.signedIn = false; }
  async getFleetSummary(): Promise<FleetSummary> { await wait(); return { agents: { total: agents.length, online: agents.filter((a) => a.presence === "online").length, stale: agents.filter((a) => a.presence === "stale").length, offline: agents.filter((a) => a.presence === "offline").length }, services: { tracked: agents.reduce((sum, a) => sum + a.services.length, 0), healthy: agents.flatMap((a) => a.services).filter((s) => s.health === "healthy").length, degraded: agents.flatMap((a) => a.services).filter((s) => s.health === "degraded").length, unhealthy: agents.flatMap((a) => a.services).filter((s) => s.health === "unhealthy").length }, openAlerts: alerts.filter((a) => !a.acknowledged).length, activeJobs: jobs.filter((j) => ["queued", "leased", "preparing", "ready", "committed", "running"].includes(j.state)).length, cursor: "demo-00421" }; }
  async listAgents() { await wait(); return structuredClone(agents); }
  async getAgentInstallCommand() { await wait(); return { available: false, version: "0.9.5-dev", managerUrl: "https://bored-manager.local:8443", managerSpkiPin: "SHA256:21:8F:98:4C:6A:D1:39:B0:87:F2:2D:B3:2E:65:AA:11", command: "", reason: "Agent packages are not published for development builds." }; }
  async listEnrollments() { await wait(); return structuredClone(enrollments); }
  async decideEnrollment(id: string, _decision: "approve" | "reject", _confirmation: { verificationCode?: string; alias?: string; tags?: string[]; reason?: string }) { await wait(200); enrollments = enrollments.filter((item) => item.id !== id); }
  async listServices() { await wait(); return structuredClone(services); }
  async listDockerHosts() { await wait(); return structuredClone(dockerHosts); }
  async createDockerHost(input: { name: string; address: string; port: number; user: string; credentialRef: string; fingerprint: string; knownHostLine: string }) { await wait(250); const host: DockerHost = { id: `host-${Date.now()}`, name: input.name, endpoint: `${input.user}@${input.address}:${input.port}`, transport: "remote_ssh", status: "connected", engineVersion: "29.6.2", apiVersion: "1.52", agents: 0, containers: 0, lastChecked: new Date().toISOString(), fingerprint: input.fingerprint }; dockerHosts = [...dockerHosts, host]; return host; }
  async listJobs() { await wait(); return structuredClone(jobs); }
  async listReleases() { await wait(); return structuredClone(releases); }
  async listAlerts() { await wait(); return structuredClone(alerts); }
  async acknowledgeAlert(id: string) { await wait(); alerts = alerts.map((alert) => alert.id === id ? { ...alert, acknowledged: true } : alert); }
  async getSettings() { await wait(); return structuredClone(settings); }
  async updateSettings(input: Settings) { await wait(250); settings = structuredClone(input); return structuredClone(settings); }
  async runCommand(input: { targets: string[]; command: string; root: boolean }) { await wait(220); const job: Job = { id: `job-${Date.now().toString(16)}`, type: "command", summary: input.command, actor: session.user.displayName, state: "preparing", targetCount: input.targets.length, succeeded: 0, failed: 0, createdAt: new Date().toISOString(), duration: "0s" }; jobs = [job, ...jobs]; return job; }
}

export function createApiClient(): ApiClient {
  return new MockApiClient();
}
