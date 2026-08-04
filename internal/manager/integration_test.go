package manager

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"
	"time"

	openapiv1 "github.com/FireStarsSoft/Bored-Manager/api/gen/openapi"
	"github.com/FireStarsSoft/Bored-Manager/internal/config"
	"github.com/FireStarsSoft/Bored-Manager/internal/store"
)

type generatedClientSecurity string

func (s generatedClientSecurity) SessionCookie(context.Context, openapiv1.OperationName, *openapiv1.Client) (openapiv1.SessionCookie, error) {
	return openapiv1.SessionCookie{APIKey: string(s)}, nil
}

func TestSetupEnrollmentApprovalAndHeartbeat(t *testing.T) {
	directory := t.TempDir()
	cfg := config.DefaultManager()
	cfg.StateDir = directory
	cfg.CacheDir = filepath.Join(directory, "cache")
	cfg.RuntimeDir = filepath.Join(directory, "run")
	cfg.WebDir = filepath.Join(directory, "web")
	cfg.DatabasePath = filepath.Join(directory, "manager.db")
	cfg.WebCertificatePath = filepath.Join(directory, "pki", "web.crt")
	cfg.WebPrivateKeyPath = filepath.Join(directory, "pki", "web.key")
	cfg.AgentCAPath = filepath.Join(directory, "pki", "agent-ca.crt")
	cfg.AgentCAKeyPath = filepath.Join(directory, "pki", "agent-ca.key")
	cfg.DevHTTP = true
	if err := cfg.EnsureDirectories(); err != nil {
		t.Fatal(err)
	}
	database, err := store.Open(cfg.DatabasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	server, err := New(cfg, database, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	web := httptest.NewServer(server.webServer.Handler)
	defer web.Close()
	agentAPI := httptest.NewServer(server.agentServer.Handler)
	defer agentAPI.Close()
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}
	contractClient, err := openapiv1.NewClient(web.URL+"/api/v1", nil)
	if err != nil {
		t.Fatal(err)
	}
	setupStatus, err := contractClient.GetSetupStatus(context.Background())
	if err != nil {
		t.Fatalf("generated OpenAPI client could not decode setup status: %v", err)
	}
	if !setupStatus.Required {
		t.Fatal("fresh manager should require setup")
	}
	versionInfo, err := contractClient.GetVersion(context.Background())
	if err != nil {
		t.Fatalf("generated OpenAPI client could not decode version metadata: %v", err)
	}
	if versionInfo.Component != openapiv1.ManagerVersionInfoComponentBoredManagerd || versionInfo.API != openapiv1.ManagerVersionInfoAPIV1 || len(versionInfo.AgentCompatibility) != 2 {
		t.Fatalf("unexpected version metadata: %+v", versionInfo)
	}

	privilegedPort := requestJSON(t, client, http.MethodPost, web.URL+"/api/v1/setup", map[string]any{"username": "admin", "display_name": "Test Administrator", "password": "Strong-password-123", "https_listen_address": "127.0.0.1", "https_port": 443, "grpc_listen_address": "127.0.0.1", "grpc_port": 9443, "register_local_docker": false, "docker_risk_confirmation": ""}, "")
	if privilegedPort.StatusCode != http.StatusBadRequest {
		t.Fatalf("setup accepted a privileged port: %s", privilegedPort.Status)
	}
	privilegedPort.Body.Close()

	setupResponse := requestJSON(t, client, http.MethodPost, web.URL+"/api/v1/setup", map[string]any{"username": "admin", "display_name": "Test Administrator", "password": "Strong-password-123", "https_listen_address": "127.0.0.1", "https_port": 8443, "grpc_listen_address": "127.0.0.1", "grpc_port": 9443, "register_local_docker": false, "docker_risk_confirmation": ""}, "")
	if setupResponse.StatusCode != http.StatusCreated {
		t.Fatalf("setup returned %s: %s", setupResponse.Status, string(readBody(setupResponse)))
	}
	var setupResult struct {
		SessionID string `json:"session_id"`
		CSRFToken string `json:"csrf_token"`
		User      struct {
			UserID      string `json:"user_id"`
			DisplayName string `json:"display_name"`
			Role        string `json:"role"`
		} `json:"user"`
	}
	decodeBody(t, setupResponse, &setupResult)
	if setupResult.SessionID == "" || setupResult.CSRFToken == "" || setupResult.User.UserID == "" || setupResult.User.DisplayName != "Test Administrator" || setupResult.User.Role != "admin" {
		t.Fatalf("setup returned an incomplete canonical session: %+v", setupResult)
	}
	webURL, _ := url.Parse(web.URL)
	var sessionToken string
	for _, cookie := range jar.Cookies(webURL) {
		if cookie.Name == "bm_session" {
			sessionToken = cookie.Value
		}
	}
	if sessionToken == "" {
		t.Fatal("setup did not establish the session cookie required by generated clients")
	}
	authedContractClient, err := openapiv1.NewClient(web.URL+"/api/v1", generatedClientSecurity(sessionToken), openapiv1.WithClient(http.DefaultClient))
	if err != nil {
		t.Fatal(err)
	}
	installCommandResult, err := authedContractClient.GetAgentInstallCommand(context.Background())
	if err != nil {
		t.Fatalf("generated OpenAPI client could not decode agent install metadata: %v", err)
	}
	installCommand, ok := installCommandResult.(*openapiv1.AgentInstallCommand)
	if !ok || installCommand.Available || installCommand.ManagerSpkiPin == "" {
		t.Fatalf("unexpected development agent install metadata: %#v", installCommandResult)
	}
	loginResult, err := contractClient.Login(context.Background(), &openapiv1.LoginRequest{Username: "admin", Password: "Strong-password-123"})
	if err != nil {
		t.Fatalf("generated OpenAPI client could not decode login response: %v", err)
	}
	loginSession, ok := loginResult.(*openapiv1.SessionHeaders)
	if !ok || loginSession.Response.User.Username != "admin" || loginSession.Response.User.Role != openapiv1.RoleAdmin {
		t.Fatalf("generated OpenAPI client returned an unexpected login session: %#v", loginResult)
	}

	_, privateKey, _ := ed25519.GenerateKey(rand.Reader)
	csrDER, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: "test-agent"}}, privateKey)
	if err != nil {
		t.Fatal(err)
	}
	csrPEM := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csrDER}))
	inventory := map[string]any{"hostname": "agent-one", "os_release": "ubuntu-24.04", "architecture": "amd64", "kernel_version": "test", "agent_version": "0.1.0-dev", "systemd_version": "255", "machine_id_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "cpu_count": 2, "memory_bytes": uint64(1 << 30), "disk_bytes": uint64(10 << 30), "addresses": []string{"192.0.2.20"}}
	enrollmentResponse := requestJSON(t, http.DefaultClient, http.MethodPost, agentAPI.URL+"/api/v1/enrollment-requests", map[string]any{"name": "test-agent", "csr_pem": csrPEM, "inventory": inventory, "version": "0.1.0-dev"}, "")
	if enrollmentResponse.StatusCode != http.StatusAccepted {
		t.Fatalf("enroll returned %s: %s", enrollmentResponse.Status, string(readBody(enrollmentResponse)))
	}
	var enrollment struct {
		ID               string `json:"enrollment_id"`
		VerificationCode string `json:"verification_code"`
	}
	decodeBody(t, enrollmentResponse, &enrollment)
	if enrollment.ID == "" {
		t.Fatal("missing enrollment ID")
	}

	reauthResponse := requestJSON(t, client, http.MethodPost, web.URL+"/api/v1/auth/reauthenticate", map[string]string{"password": "Strong-password-123"}, setupResult.CSRFToken)
	if reauthResponse.StatusCode != http.StatusOK {
		t.Fatalf("reauth returned %s: %s", reauthResponse.Status, string(readBody(reauthResponse)))
	}
	reauthResponse.Body.Close()
	approvalResponse := requestJSON(t, client, http.MethodPost, web.URL+"/api/v1/enrollment-requests/"+enrollment.ID+"/approve", map[string]any{"verification_code": enrollment.VerificationCode, "alias": "test-agent", "tags": []string{}}, setupResult.CSRFToken)
	if approvalResponse.StatusCode != http.StatusOK {
		t.Fatalf("approve returned %s: %s", approvalResponse.Status, string(readBody(approvalResponse)))
	}
	approvalResponse.Body.Close()
	proof := base64.RawStdEncoding.EncodeToString(ed25519.Sign(privateKey, []byte("bored-manager enrollment status:"+enrollment.ID)))
	statusResponse := requestJSON(t, http.DefaultClient, http.MethodPost, agentAPI.URL+"/api/v1/enrollment-requests/"+enrollment.ID+"/status", map[string]string{"proof": proof}, "")
	if statusResponse.StatusCode != http.StatusOK {
		t.Fatalf("status returned %s: %s", statusResponse.Status, string(readBody(statusResponse)))
	}
	var status struct {
		Agent struct {
			ID string `json:"agent_id"`
		} `json:"agent"`
		CertificatePEM string `json:"certificate_chain_pem"`
	}
	decodeBody(t, statusResponse, &status)
	if status.Agent.ID == "" || status.CertificatePEM == "" {
		t.Fatalf("unexpected enrollment status: %+v", status)
	}
	certificateBlock, _ := pem.Decode([]byte(status.CertificatePEM))
	certificate, err := x509.ParseCertificate(certificateBlock.Bytes)
	if err != nil {
		t.Fatal(err)
	}

	heartbeatBody, _ := json.Marshal(map[string]any{"version": "0.1.0-dev", "inventory": inventory})
	heartbeatRequest := httptest.NewRequest(http.MethodPost, "https://manager/agent/v1/heartbeat", bytes.NewReader(heartbeatBody))
	heartbeatRequest.Header.Set("Content-Type", "application/json")
	heartbeatRequest.TLS = &tls.ConnectionState{PeerCertificates: []*x509.Certificate{certificate}, VerifiedChains: [][]*x509.Certificate{{certificate, server.ca.Certificate}}}
	heartbeatRecorder := httptest.NewRecorder()
	server.heartbeat(heartbeatRecorder, heartbeatRequest)
	if heartbeatRecorder.Code != http.StatusOK {
		t.Fatalf("heartbeat returned %d: %s", heartbeatRecorder.Code, heartbeatRecorder.Body.String())
	}

	agentsResponse := requestJSON(t, client, http.MethodGet, web.URL+"/api/v1/agents", nil, "")
	if agentsResponse.StatusCode != http.StatusOK {
		t.Fatalf("agents returned %s", agentsResponse.Status)
	}
	var agents struct {
		Agents []struct {
			ID       string `json:"agent_id"`
			Presence string `json:"presence"`
		} `json:"agents"`
	}
	decodeBody(t, agentsResponse, &agents)
	if len(agents.Agents) != 1 || agents.Agents[0].Presence != "online" {
		t.Fatalf("unexpected agents: %+v", agents.Agents)
	}
	contractAgents, err := authedContractClient.ListAgents(context.Background(), openapiv1.ListAgentsParams{})
	if err != nil {
		t.Fatalf("generated OpenAPI client could not decode agents: %v", err)
	}
	agentList, ok := contractAgents.(*openapiv1.AgentList)
	if !ok || len(agentList.Agents) != 1 || agentList.Agents[0].Presence != openapiv1.PresenceStateOnline {
		t.Fatalf("unexpected generated agent list: %#v", contractAgents)
	}
	enrollmentList, err := authedContractClient.ListEnrollmentRequests(context.Background(), openapiv1.ListEnrollmentRequestsParams{})
	if err != nil || enrollmentList == nil {
		t.Fatalf("generated OpenAPI client could not decode enrollment list: value=%#v err=%v", enrollmentList, err)
	}
	badRevocation := requestJSONWithHeaders(t, client, http.MethodPost, web.URL+"/api/v1/agents/"+status.Agent.ID+"/revoke", map[string]string{"reason": "test revocation", "confirmation": "REVOKE wrong-agent"}, map[string]string{"X-CSRF-Token": setupResult.CSRFToken, "Idempotency-Key": "revoke-test-001"})
	if badRevocation.StatusCode != http.StatusConflict {
		t.Fatalf("bad typed revocation confirmation returned %s: %s", badRevocation.Status, string(readBody(badRevocation)))
	}
	badRevocation.Body.Close()
	cursorBeforeRevocation, err := database.LatestEventCursor(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	revocationRequest := &openapiv1.RevokeAgentRequest{Reason: "test revocation", Confirmation: "REVOKE " + status.Agent.ID}
	revocationParams := openapiv1.RevokeAgentParams{AgentID: agentList.Agents[0].AgentID, XCSRFToken: setupResult.CSRFToken, IdempotencyKey: "revoke-test-001"}
	revocationResult, err := authedContractClient.RevokeAgent(context.Background(), revocationRequest, revocationParams)
	if err != nil {
		t.Fatalf("generated OpenAPI client could not revoke the agent: %v", err)
	}
	revokedAgent, ok := revocationResult.(*openapiv1.Agent)
	if !ok || revokedAgent.Presence != openapiv1.PresenceStateRevoked || !revokedAgent.RevokedAt.Set || revokedAgent.RevokedAt.Null {
		t.Fatalf("unexpected revocation result: %#v", revocationResult)
	}
	cursorAfterRevocation, _ := database.LatestEventCursor(context.Background())
	if cursorAfterRevocation != cursorBeforeRevocation+1 {
		t.Fatalf("revocation published %d events, want one", cursorAfterRevocation-cursorBeforeRevocation)
	}
	if _, err := authedContractClient.RevokeAgent(context.Background(), revocationRequest, revocationParams); err != nil {
		t.Fatalf("idempotent revocation replay failed: %v", err)
	}
	cursorAfterReplay, _ := database.LatestEventCursor(context.Background())
	if cursorAfterReplay != cursorAfterRevocation {
		t.Fatalf("idempotent revocation replay published another event: before=%d after=%d", cursorAfterRevocation, cursorAfterReplay)
	}
	revokedHeartbeat := httptest.NewRecorder()
	revokedHeartbeatRequest := httptest.NewRequest(http.MethodPost, "https://manager/agent/v1/heartbeat", bytes.NewReader(heartbeatBody))
	revokedHeartbeatRequest.Header.Set("Content-Type", "application/json")
	revokedHeartbeatRequest.TLS = heartbeatRequest.TLS
	server.heartbeat(revokedHeartbeat, revokedHeartbeatRequest)
	if revokedHeartbeat.Code != http.StatusUnauthorized {
		t.Fatalf("revoked agent heartbeat returned %d: %s", revokedHeartbeat.Code, revokedHeartbeat.Body.String())
	}
	dockerCheckedAt := time.Now().UTC()
	dockerHost := store.DockerHost{ID: "0198a0d4-83c0-7000-8000-000000000002", Name: "local", Kind: "local", Endpoint: "unix:///var/run/docker.sock", Status: "healthy", DockerVersion: "29.6.2", LastCheckedAt: &dockerCheckedAt, CreatedAt: dockerCheckedAt}
	dockerInput := dockerHostCreateInput{Name: "local", Transport: "local_unix", SocketPath: "/var/run/docker.sock", RootEquivalentConfirmation: "I UNDERSTAND DOCKER ACCESS IS ROOT-EQUIVALENT"}
	dockerHash, err := canonicalIntentHash(dockerInput)
	if err != nil {
		t.Fatal(err)
	}
	dockerResponse, _ := json.Marshal(dockerHostView(dockerHost))
	dockerResponse = append(dockerResponse, '\n')
	if err := database.UpsertDockerHostIdempotent(context.Background(), dockerHost, "docker-test-001", "docker-host.create.local-unix", dockerHash, http.StatusCreated, dockerResponse, dockerCheckedAt); err != nil {
		t.Fatal(err)
	}
	replayedDocker := requestJSONWithHeaders(t, client, http.MethodPost, web.URL+"/api/v1/docker-hosts", dockerInput, map[string]string{"X-CSRF-Token": setupResult.CSRFToken, "Idempotency-Key": "docker-test-001"})
	if replayedDocker.StatusCode != http.StatusCreated || replayedDocker.Header.Get("Idempotency-Replayed") != "true" {
		t.Fatalf("Docker replay returned %s replay=%q: %s", replayedDocker.Status, replayedDocker.Header.Get("Idempotency-Replayed"), string(readBody(replayedDocker)))
	}
	replayedDocker.Body.Close()
	dockerInput.Name = "different-intent"
	conflictingDocker := requestJSONWithHeaders(t, client, http.MethodPost, web.URL+"/api/v1/docker-hosts", dockerInput, map[string]string{"X-CSRF-Token": setupResult.CSRFToken, "Idempotency-Key": "docker-test-001"})
	if conflictingDocker.StatusCode != http.StatusConflict {
		t.Fatalf("Docker idempotency conflict returned %s: %s", conflictingDocker.Status, string(readBody(conflictingDocker)))
	}
	conflictingDocker.Body.Close()
	dockerHostList, err := authedContractClient.ListDockerHosts(context.Background(), openapiv1.ListDockerHostsParams{})
	if err != nil || dockerHostList == nil || len(dockerHostList.DockerHosts) != 1 || dockerHostList.DockerHosts[0].Transport != openapiv1.DockerTransportLocalUnix {
		t.Fatalf("generated OpenAPI client could not decode Docker host list: value=%#v err=%v", dockerHostList, err)
	}
}

func requestJSON(t *testing.T, client *http.Client, method, url string, body any, csrf string) *http.Response {
	return requestJSONWithHeaders(t, client, method, url, body, map[string]string{"X-CSRF-Token": csrf})
}

func requestJSONWithHeaders(t *testing.T, client *http.Client, method, url string, body any, headers map[string]string) *http.Response {
	t.Helper()
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(context.Background(), method, url, reader)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	for name, value := range headers {
		if value != "" {
			request.Header.Set(name, value)
		}
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}
func decodeBody(t *testing.T, response *http.Response, destination any) {
	t.Helper()
	defer response.Body.Close()
	if err := json.NewDecoder(response.Body).Decode(destination); err != nil {
		t.Fatal(err)
	}
}
func readBody(response *http.Response) []byte {
	defer response.Body.Close()
	contents, _ := io.ReadAll(response.Body)
	return contents
}
