import type {
  Agent,
  Alert,
  ApiClient,
  ApiErrorShape,
  DockerHost,
  EnrollmentRequest,
  FleetSummary,
  Job,
  JobState,
  Release,
  ServiceDefinition,
  ServiceObservation,
  Session,
  Settings,
  SetupInput,
  SetupStatus,
} from "../types";

export class ApiError extends Error {
  readonly code: string;
  readonly correlationId?: string;
  readonly fieldErrors?: Record<string, string>;

  constructor(value: ApiErrorShape, status?: number) {
    super(value.message);
    this.name = "ApiError";
    this.code = value.code || `HTTP_${status ?? 500}`;
    this.correlationId = value.correlationId;
    this.fieldErrors = value.fieldErrors;
  }
}

type RequestOptions = Omit<RequestInit, "body"> & { body?: unknown };
type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value !== null && typeof value === "object" ? value as RecordValue : {};
const string = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;
const number = (value: unknown, fallback = 0) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
const timestamp = (value: unknown) => string(value) || new Date(0).toISOString();

function sessionFrom(value: unknown): Session {
  const root = object(value);
  const admin = object(root.user ?? root.admin);
  const username = string(admin.username, "admin");
  return {
    user: {
      id: String(admin.user_id ?? admin.id ?? username),
      username,
      displayName: string(admin.display_name ?? admin.displayName, username),
      role: string(admin.role) === "viewer" ? "viewer" : string(admin.role) === "operator" ? "operator" : "admin",
    },
    expiresAt: timestamp(root.expires_at ?? root.expiresAt) || new Date(Date.now() + 8 * 60 * 60_000).toISOString(),
  };
}

function serviceFrom(value: unknown, index: number): ServiceObservation {
  const raw = object(value);
  return {
    id: string(raw.id, string(raw.key, `service-${index}`)), key: string(raw.key, `service-${index}`), name: string(raw.name, string(raw.key, "Service")),
    availability: (["unsupported", "absent", "installed", "unknown"].includes(string(raw.availability)) ? raw.availability : "unknown") as ServiceObservation["availability"],
    runtime: (["active", "inactive", "starting", "failed", "unknown"].includes(string(raw.runtime)) ? raw.runtime : "unknown") as ServiceObservation["runtime"],
    health: (["healthy", "degraded", "unhealthy", "not_configured"].includes(string(raw.health)) ? raw.health : "not_configured") as ServiceObservation["health"],
    version: string(raw.version) || null, lastCheck: timestamp(raw.last_check ?? raw.lastCheck), lastTransition: timestamp(raw.last_transition ?? raw.lastTransition), errorSummary: string(raw.error_summary ?? raw.errorSummary) || undefined,
  };
}

function agentFrom(value: unknown): Agent {
  const raw = object(value);
  const inventory = object(raw.inventory);
  const metrics = object(inventory.metrics);
  const rawStatus = string(raw.presence ?? raw.status);
  const lastSeen = timestamp(raw.last_seen_at ?? raw.last_seen ?? raw.lastSeen ?? raw.enrolled_at ?? raw.created_at);
  const seenAge = Date.now() - new Date(lastSeen).getTime();
  const hasLastSeen = Boolean(raw.last_seen_at ?? raw.last_seen ?? raw.lastSeen);
  const presence: Agent["presence"] = raw.revoked_at || rawStatus === "revoked" || !hasLastSeen ? "offline" : rawStatus === "online" && seenAge < 45_000 ? "online" : rawStatus === "stale" || seenAge < 180_000 ? "stale" : "offline";
  const serviceValues = Array.isArray(inventory.services) ? inventory.services : [];
  const id = string(raw.agent_id ?? raw.id, crypto.randomUUID());
  return {
    id, shortId: id.length > 8 ? id.slice(-8) : id, alias: string(raw.alias ?? raw.name, string(inventory.hostname, "Unnamed agent")),
    host: string(inventory.docker_host ?? inventory.host, "Unassigned"), container: string(inventory.container_name ?? inventory.hostname, string(raw.name, "unknown")),
    presence, version: string(raw.version ?? inventory.agent_version, "unknown"), lastSeen,
    cpuPercent: number(metrics.cpu_percent ?? inventory.cpu_percent), memoryPercent: number(metrics.memory_percent ?? inventory.memory_percent), diskPercent: number(metrics.disk_percent ?? inventory.disk_percent),
    networkRxKbps: number(metrics.network_rx_kbps), networkTxKbps: number(metrics.network_tx_kbps), tags: Array.isArray(inventory.tags) ? inventory.tags.map(String) : [],
    services: serviceValues.map(serviceFrom), alerts: number(raw.alerts),
  };
}

function enrollmentFrom(value: unknown): EnrollmentRequest {
  const raw = object(value); const inventory = object(raw.inventory);
  return {
    id: string(raw.enrollment_id ?? raw.id), alias: string(raw.agent_name ?? raw.alias, string(inventory.hostname, "Unnamed agent")), sourceAddress: string(raw.source_address ?? raw.source_ip ?? raw.sourceAddress, "unknown"),
    requestedAt: timestamp(raw.requested_at ?? raw.created_at ?? raw.requestedAt), expiresAt: timestamp(raw.expires_at ?? raw.expiresAt), fingerprint: string(raw.csr_fingerprint ?? raw.fingerprint), verificationCode: string(raw.verification_code ?? raw.verificationCode),
    os: string(inventory.os_release ?? inventory.os ?? inventory.os_name, "ubuntu-24.04"), architecture: string(inventory.architecture ?? inventory.arch, "amd64"), agentVersion: string(raw.version ?? raw.agent_version ?? inventory.agent_version, "unknown"), replayProtected: true,
  };
}

function dockerHostFrom(value: unknown): DockerHost {
	const raw = object(value); const kind = string(raw.kind ?? raw.transport); const status = string(raw.status); const hostKey = object(raw.ssh_host_key);
	return {
		id: string(raw.id ?? raw.docker_host_id), name: string(raw.name), endpoint: string(raw.endpoint, string(raw.ssh_address)), transport: kind === "local" || kind === "local_unix" ? "local_unix" : "remote_ssh",
		status: raw.healthy === true || ["connected", "ok", "available", "healthy"].includes(status) ? "connected" : status === "degraded" || status === "reachable" ? "degraded" : "offline",
		engineVersion: string(raw.docker_version ?? raw.engineVersion, "unknown"), apiVersion: string(raw.api_version ?? raw.apiVersion, "-"), agents: number(raw.agents), containers: number(raw.containers),
		lastChecked: timestamp(raw.last_checked_at ?? raw.last_preflight_at ?? raw.lastChecked), fingerprint: string(hostKey.fingerprint ?? raw.ssh_host_key ?? raw.fingerprint) || undefined,
	};
}

function jobFrom(value: unknown): Job {
  const raw = object(value); const state = string(raw.state, "queued") as JobState;
  return { id: string(raw.id ?? raw.job_id), type: (["service", "command", "provision", "update", "backup"].includes(string(raw.type ?? raw.job_type)) ? string(raw.type ?? raw.job_type) : "command") as Job["type"], summary: string(raw.summary, string(raw.type, "Job")), actor: string(raw.actor, "System"), state, targetCount: number(raw.target_count ?? raw.targetCount), succeeded: number(raw.succeeded), failed: number(raw.failed), createdAt: timestamp(raw.created_at ?? raw.createdAt), duration: string(raw.duration, "-") };
}

function releaseFrom(value: unknown): Release {
  const raw = object(value); const channel = string(raw.channel);
  return { version: string(raw.version), channel: (channel === "stable" || channel === "alpha" ? channel : "beta"), publishedAt: timestamp(raw.published_at ?? raw.publishedAt), current: Boolean(raw.current ?? raw.installed), signed: Boolean(raw.signed ?? raw.signature_verified), notes: string(raw.notes, "Verified release package."), compatibleAgent: string(raw.compatible_agent ?? raw.compatibleAgent, "N / N-1") };
}

export class HttpApiClient implements ApiClient {
  private csrfToken = "";
  constructor(private readonly baseUrl = "") {}

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const headers = new Headers(options.headers);
    headers.set("Accept", "application/json");
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (options.method && !["GET", "HEAD", "OPTIONS"].includes(options.method.toUpperCase()) && this.csrfToken) headers.set("X-CSRF-Token", this.csrfToken);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/v1${path}`, { ...options, credentials: "same-origin", headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    } catch {
      throw new ApiError({ code: "NETWORK_UNAVAILABLE", message: "The manager API is not reachable." });
    }
    if (response.status === 204) return undefined as T;
    const value = (await response.json().catch(() => ({}))) as T | (ApiErrorShape & { error?: string; detail?: string; title?: string; csrf_token?: string });
    if (!response.ok) {
      const shape = value as ApiErrorShape & { error?: string; detail?: string; title?: string };
      throw new ApiError({ code: shape.code || `HTTP_${response.status}`, message: shape.message || shape.detail || shape.error || shape.title || "The request could not be completed.", correlationId: shape.correlationId ?? response.headers.get("X-Correlation-ID") ?? undefined, fieldErrors: shape.fieldErrors }, response.status);
    }
    const token = string(object(value).csrf_token);
    if (token) this.csrfToken = token;
    return value as T;
  }

  private async optionalItems(path: string, signal?: AbortSignal): Promise<unknown[]> {
    try {
      const response = object(await this.request<unknown>(path, { signal }));
      for (const key of ["items", "agents", "enrollment_requests", "service_definitions", "docker_hosts", "jobs", "releases", "alerts"]) {
        if (Array.isArray(response[key])) return response[key] as unknown[];
      }
      return [];
    }
    catch (error) { if (error instanceof ApiError && ["HTTP_404", "HTTP_405", "not_found"].includes(error.code)) return []; throw error; }
  }

  async getSetupStatus(signal?: AbortSignal): Promise<SetupStatus> {
    const raw = object(await this.request<unknown>("/setup", { signal }));
    return { configured: raw.required === false || raw.configured === true || raw.setup_required === false, version: string(raw.version, "pre-alpha"), serverFingerprint: string(raw.certificate_fingerprint ?? raw.web_spki_fingerprint ?? raw.serverFingerprint, "Fingerprint generated during setup"), localDocker: raw.local_docker_registered === true ? "available" : raw.local_docker_detected === true ? "available" : "unknown", bindAddress: string(raw.https_listen_address ?? raw.bind_address) || undefined, webPort: number(raw.https_port ?? raw.web_port) || undefined, agentPort: number(raw.grpc_port ?? raw.agent_port) || undefined };
  }
  async completeSetup(input: SetupInput) {
    const value = await this.request<unknown>("/setup", { method: "POST", body: { username: input.username, display_name: input.displayName, password: input.password, https_listen_address: input.bindAddress, https_port: input.webPort, grpc_listen_address: input.bindAddress, grpc_port: input.agentPort, register_local_docker: input.registerLocalDocker, docker_risk_confirmation: input.registerLocalDocker && input.dockerRiskAccepted ? "I UNDERSTAND DOCKER ACCESS IS ROOT-EQUIVALENT" : "" } });
    return sessionFrom(value);
  }
  async getSession(signal?: AbortSignal) { try { return sessionFrom(await this.request<unknown>("/auth/session", { signal })); } catch (error) { if (error instanceof ApiError && ["authentication_required", "invalid_session", "session_expired", "HTTP_401"].includes(error.code)) return null; throw error; } }
  async login(username: string, password: string) { return sessionFrom(await this.request<unknown>("/auth/login", { method: "POST", body: { username, password } })); }
  reauthenticate(password: string) { return this.request<void>("/auth/reauthenticate", { method: "POST", body: { password } }); }
  logout() { return this.request<void>("/auth/session", { method: "DELETE" }); }
  async listAgents(signal?: AbortSignal) { return (await this.optionalItems("/agents", signal)).map(agentFrom); }
  async getAgentInstallCommand(signal?: AbortSignal) { const raw = object(await this.request<unknown>("/agents/install-command", { signal })); return { available: Boolean(raw.available), version: string(raw.version), managerUrl: string(raw.manager_url), managerSpkiPin: string(raw.manager_spki_pin), command: string(raw.command), reason: string(raw.reason) }; }
  async getFleetSummary(signal?: AbortSignal): Promise<FleetSummary> {
    try {
      const raw = object(await this.request<unknown>("/overview", { signal }));
      const rawAgents = object(raw.agents); const rawServices = object(raw.services);
      if (!raw.agents || !raw.services) throw new ApiError({ code: "CAPABILITY_NOT_AVAILABLE", message: "The overview snapshot is not available yet." });
      return { agents: { total: number(rawAgents.total), online: number(rawAgents.online), stale: number(rawAgents.stale), offline: number(rawAgents.offline) }, services: { tracked: number(rawServices.tracked), healthy: number(rawServices.healthy), degraded: number(rawServices.degraded), unhealthy: number(rawServices.unhealthy) }, openAlerts: number(raw.openAlerts ?? raw.open_alerts), activeJobs: number(raw.activeJobs ?? raw.active_jobs), cursor: string(raw.cursor, "0") };
    }
    catch (error) {
      if (!(error instanceof ApiError) || !["HTTP_404", "not_found", "CAPABILITY_NOT_AVAILABLE"].includes(error.code)) throw error;
      const fleet = await this.listAgents(signal); const observations = fleet.flatMap((agent) => agent.services);
      return { agents: { total: fleet.length, online: fleet.filter((a) => a.presence === "online").length, stale: fleet.filter((a) => a.presence === "stale").length, offline: fleet.filter((a) => a.presence === "offline").length }, services: { tracked: observations.length, healthy: observations.filter((s) => s.health === "healthy").length, degraded: observations.filter((s) => s.health === "degraded").length, unhealthy: observations.filter((s) => s.health === "unhealthy").length }, openAlerts: 0, activeJobs: 0, cursor: "0" };
    }
  }
  async listEnrollments(signal?: AbortSignal) { return (await this.optionalItems("/enrollment-requests", signal)).map(enrollmentFrom); }
  decideEnrollment(id: string, decision: "approve" | "reject", confirmation: { verificationCode?: string; alias?: string; tags?: string[]; reason?: string }) { return this.request<void>(`/enrollment-requests/${encodeURIComponent(id)}/${decision}`, { method: "POST", body: decision === "approve" ? { verification_code: confirmation.verificationCode, alias: confirmation.alias, tags: confirmation.tags ?? [] } : { reason: confirmation.reason || "Rejected after operator review" } }); }
  async listServices(signal?: AbortSignal) { return (await this.optionalItems("/service-definitions?limit=250", signal)).map((value) => { const raw = object(value); return { id: string(raw.id), key: string(raw.key), name: string(raw.name), description: string(raw.description), revision: number(raw.revision), adapter: string(raw.adapter, "command"), assigned: number(raw.assigned), healthy: number(raw.healthy), supportedOs: string(raw.supported_os, "Ubuntu 24.04 / amd64"), signed: Boolean(raw.signed) } as ServiceDefinition; }); }
  async listDockerHosts(signal?: AbortSignal) { return (await this.optionalItems("/docker-hosts", signal)).map(dockerHostFrom); }
  async createDockerHost(input: { name: string; address: string; port: number; user: string; credentialRef: string; fingerprint: string; knownHostLine: string }) {
    const algorithm = input.knownHostLine.trim().split(/\s+/)[1] || "ssh-ed25519";
    const response = object(await this.request<unknown>("/docker-hosts", {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: {
        name: input.name,
        transport: "remote_ssh",
        socket_path: "/var/run/docker.sock",
        ssh_address: input.address,
        ssh_port: input.port,
        ssh_user: input.user,
        ssh_credential_ref: input.credentialRef,
        known_host_line: input.knownHostLine,
        ssh_host_key: { algorithm, fingerprint: input.fingerprint },
      },
    }));
    return dockerHostFrom(response.host ?? response);
  }
  async listJobs(signal?: AbortSignal) { return (await this.optionalItems("/jobs?limit=100", signal)).map(jobFrom); }
  async listReleases(signal?: AbortSignal) { return (await this.optionalItems("/releases", signal)).map(releaseFrom); }
  async listAlerts(signal?: AbortSignal) { return (await this.optionalItems("/alerts?state=open", signal)).map((value) => { const raw = object(value); return { id: string(raw.id), severity: string(raw.severity) === "critical" ? "critical" : string(raw.severity) === "info" ? "info" : "warning", title: string(raw.title), source: string(raw.source), firstSeen: timestamp(raw.first_seen), lastSeen: timestamp(raw.last_seen), count: number(raw.count, 1), acknowledged: Boolean(raw.acknowledged) } as Alert; }); }
  acknowledgeAlert(id: string) { return this.request<void>(`/alerts/${encodeURIComponent(id)}/acknowledge`, { method: "POST" }); }
  async getSettings(signal?: AbortSignal): Promise<Settings> { try { const raw = object(await this.request<unknown>("/settings", { signal })); if (!raw.organizationName && !raw.organization_name) throw new ApiError({ code: "CAPABILITY_NOT_AVAILABLE", message: "Settings editing is not available in this pre-alpha manager. Use the installed configuration file and restart the service." }); return { organizationName: string(raw.organizationName ?? raw.organization_name), bindAddress: string(raw.bindAddress ?? raw.bind_address), webPort: number(raw.webPort ?? raw.web_port), agentPort: number(raw.agentPort ?? raw.agent_port), releaseChannel: string(raw.releaseChannel ?? raw.release_channel) === "beta" ? "beta" : "stable", retentionDays: number(raw.retentionDays ?? raw.retention_days, 30), quotaGiB: number(raw.quotaGiB ?? raw.quota_gib, 10), requireRootReauthentication: raw.requireRootReauthentication !== false && raw.require_root_reauthentication !== false }; } catch (error) { if (error instanceof ApiError && ["HTTP_404", "not_found", "CAPABILITY_NOT_AVAILABLE"].includes(error.code)) throw new ApiError({ code: "CAPABILITY_NOT_AVAILABLE", message: "Settings editing is not available in this pre-alpha manager. Use the installed configuration file and restart the service." }); throw error; } }
  updateSettings(input: Settings) { return this.request<Settings>("/settings", { method: "PUT", body: input }); }
  async runCommand(input: { targets: string[]; command: string; root: boolean }) { return jobFrom(await this.request<unknown>("/jobs", { method: "POST", body: { job_type: "command", targets: input.targets, input: { command: input.command, root: input.root }, idempotency_key: crypto.randomUUID() } })); }
}
