export type Presence = "online" | "stale" | "offline";
export type Availability = "unsupported" | "absent" | "installed" | "unknown";
export type RuntimeState = "active" | "inactive" | "starting" | "failed" | "unknown";
export type HealthState = "healthy" | "degraded" | "unhealthy" | "not_configured";
export type Severity = "critical" | "warning" | "info" | "success" | "neutral";

export interface SetupStatus {
  configured: boolean;
  version: string;
  serverFingerprint: string;
  localDocker: "available" | "unavailable" | "permission_denied" | "unknown";
  bindAddress?: string;
  webPort?: number;
  agentPort?: number;
}

export interface SetupInput {
  username: string;
  password: string;
  displayName: string;
  bindAddress: string;
  webPort: number;
  agentPort: number;
  registerLocalDocker: boolean;
  dockerRiskAccepted: boolean;
}

export interface Session {
  user: { id: string; username: string; displayName: string; role: "admin" | "operator" | "viewer" };
  expiresAt: string;
}

export interface ServiceObservation {
  id: string;
  key: string;
  name: string;
  availability: Availability;
  runtime: RuntimeState;
  health: HealthState;
  version: string | null;
  lastCheck: string;
  lastTransition: string;
  errorSummary?: string;
}

export interface Agent {
  id: string;
  shortId: string;
  alias: string;
  host: string;
  container: string;
  presence: Presence;
  version: string;
  lastSeen: string;
  cpuPercent: number;
  memoryPercent: number;
  diskPercent: number;
  networkRxKbps: number;
  networkTxKbps: number;
  tags: string[];
  services: ServiceObservation[];
  alerts: number;
}

export interface EnrollmentRequest {
  id: string;
  alias: string;
  sourceAddress: string;
  requestedAt: string;
  expiresAt: string;
  fingerprint: string;
  verificationCode: string;
  os: string;
  architecture: string;
  agentVersion: string;
  replayProtected: boolean;
}

export interface AgentInstallCommand {
  available: boolean;
  version: string;
  managerUrl: string;
  managerSpkiPin: string;
  command: string;
  reason: string;
}

export interface ServiceDefinition {
  id: string;
  key: string;
  name: string;
  description: string;
  revision: number;
  adapter: "systemd" | "process" | "tcp" | "http" | "command";
  assigned: number;
  healthy: number;
  supportedOs: string;
  signed: boolean;
}

export interface DockerHost {
  id: string;
  name: string;
  endpoint: string;
  transport: "local_unix" | "remote_ssh";
  status: "connected" | "degraded" | "offline";
  engineVersion: string;
  apiVersion: string;
  agents: number;
  containers: number;
  lastChecked: string;
  fingerprint?: string;
}

export type JobState = "queued" | "leased" | "preparing" | "ready" | "committed" | "running" | "succeeded" | "failed" | "cancelled" | "expired";

export interface Job {
  id: string;
  type: "service" | "command" | "provision" | "update" | "backup";
  summary: string;
  actor: string;
  state: JobState;
  targetCount: number;
  succeeded: number;
  failed: number;
  createdAt: string;
  duration: string;
}

export interface Release {
  version: string;
  channel: "stable" | "beta" | "alpha";
  publishedAt: string;
  current: boolean;
  signed: boolean;
  notes: string;
  compatibleAgent: string;
}

export interface Alert {
  id: string;
  severity: Exclude<Severity, "success" | "neutral">;
  title: string;
  source: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
  acknowledged: boolean;
}

export interface FleetSummary {
  agents: { total: number; online: number; stale: number; offline: number };
  services: { tracked: number; healthy: number; degraded: number; unhealthy: number };
  openAlerts: number;
  activeJobs: number;
  cursor: string;
}

export interface Settings {
  organizationName: string;
  bindAddress: string;
  webPort: number;
  agentPort: number;
  releaseChannel: "stable" | "beta";
  retentionDays: number;
  quotaGiB: number;
  requireRootReauthentication: boolean;
}

export interface ApiErrorShape {
  code: string;
  message: string;
  correlationId?: string;
  fieldErrors?: Record<string, string>;
}

export type LiveEvent =
  | { type: "agent.updated"; cursor: string; agent: Agent }
  | { type: "alert.created"; cursor: string; alert: Alert }
  | { type: "job.updated"; cursor: string; job: Job }
  | { type: "resync_required"; cursor?: string; reason: "cursor_expired" | "buffer_overflow" | "server_restart" };

export interface ApiClient {
  getSetupStatus(signal?: AbortSignal): Promise<SetupStatus>;
  completeSetup(input: SetupInput): Promise<Session>;
  getSession(signal?: AbortSignal): Promise<Session | null>;
  login(username: string, password: string): Promise<Session>;
  reauthenticate(password: string): Promise<void>;
  logout(): Promise<void>;
  getFleetSummary(signal?: AbortSignal): Promise<FleetSummary>;
  listAgents(signal?: AbortSignal): Promise<Agent[]>;
  getAgentInstallCommand(signal?: AbortSignal): Promise<AgentInstallCommand>;
  listEnrollments(signal?: AbortSignal): Promise<EnrollmentRequest[]>;
  decideEnrollment(id: string, decision: "approve" | "reject", confirmation: { verificationCode?: string; alias?: string; tags?: string[]; reason?: string }): Promise<void>;
  listServices(signal?: AbortSignal): Promise<ServiceDefinition[]>;
  listDockerHosts(signal?: AbortSignal): Promise<DockerHost[]>;
  createDockerHost(input: { name: string; address: string; port: number; user: string; credentialRef: string; fingerprint: string; knownHostLine: string }): Promise<DockerHost>;
  listJobs(signal?: AbortSignal): Promise<Job[]>;
  listReleases(signal?: AbortSignal): Promise<Release[]>;
  listAlerts(signal?: AbortSignal): Promise<Alert[]>;
  acknowledgeAlert(id: string): Promise<void>;
  getSettings(signal?: AbortSignal): Promise<Settings>;
  updateSettings(input: Settings): Promise<Settings>;
  runCommand(input: { targets: string[]; command: string; root: boolean }): Promise<Job>;
}
