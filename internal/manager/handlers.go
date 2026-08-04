package manager

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/FireStarsSoft/Bored-Manager/internal/auth"
	"github.com/FireStarsSoft/Bored-Manager/internal/dockerconnector"
	"github.com/FireStarsSoft/Bored-Manager/internal/domain"
	"github.com/FireStarsSoft/Bored-Manager/internal/pki"
	"github.com/FireStarsSoft/Bored-Manager/internal/store"
	"github.com/FireStarsSoft/Bored-Manager/internal/version"
)

func (s *Server) health(response http.ResponseWriter, request *http.Request) {
	ctx, cancel := context.WithTimeout(request.Context(), 2*time.Second)
	defer cancel()
	if err := s.store.Ping(ctx); err != nil {
		writeError(response, http.StatusServiceUnavailable, "database_unavailable", "database health check failed")
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"status": "ok", "version": version.Current(), "time": time.Now().UTC()})
}

func (s *Server) apiHealth(response http.ResponseWriter, request *http.Request) {
	ctx, cancel := context.WithTimeout(request.Context(), 2*time.Second)
	defer cancel()
	status := "ok"
	databaseStatus := "ok"
	if err := s.store.Ping(ctx); err != nil {
		status = "degraded"
		databaseStatus = "unavailable"
	}
	cursor, _ := s.store.LatestEventCursor(ctx)
	code := http.StatusOK
	if status != "ok" {
		code = http.StatusServiceUnavailable
	}
	writeJSON(response, code, map[string]any{"status": status, "version": version.Version, "database": databaseStatus, "event_cursor": strconv.FormatInt(cursor, 10), "checked_at": time.Now().UTC()})
}

func (s *Server) version(response http.ResponseWriter, _ *http.Request) {
	writeJSON(response, http.StatusOK, map[string]any{"component": "bored-managerd", "version": version.Current(), "api": "v1", "agent_compatibility": []string{"N", "N-1"}})
}

func (s *Server) apiSetupStatus(response http.ResponseWriter, request *http.Request) {
	setup, err := s.store.IsSetup(request.Context())
	if err != nil {
		writeError(response, http.StatusInternalServerError, "database_error", "could not read setup state")
		return
	}
	local := dockerconnector.ProbeLocal(request.Context(), "/var/run/docker.sock")
	registered := false
	if hosts, err := s.store.DockerHosts(request.Context()); err == nil {
		for _, host := range hosts {
			if host.Kind == "local" {
				registered = true
				break
			}
		}
	}
	writeJSON(response, http.StatusOK, map[string]any{"required": !setup, "https_listen_address": s.config.BindAddress, "https_port": s.config.WebPort, "grpc_listen_address": s.config.BindAddress, "grpc_port": s.config.AgentPort, "certificate_fingerprint": s.webSPKIPin, "local_docker_detected": local.Available, "local_docker_registered": registered})
}

func (s *Server) setup(response http.ResponseWriter, request *http.Request) {
	if ip := net.ParseIP(remoteIP(request)); ip == nil || !ip.IsLoopback() {
		writeError(response, http.StatusForbidden, "loopback_required", "initial setup is available only from the local machine")
		return
	}
	var input struct {
		Username                string `json:"username"`
		DisplayName             string `json:"display_name"`
		Password                string `json:"password"`
		BindAddress             string `json:"bind_address"`
		WebPort                 int    `json:"web_port"`
		AgentPort               int    `json:"agent_port"`
		LocalDockerConfirmation string `json:"local_docker_confirmation"`
		HTTPSListenAddress      string `json:"https_listen_address"`
		HTTPSPort               int    `json:"https_port"`
		GRPCListenAddress       string `json:"grpc_listen_address"`
		GRPCPort                int    `json:"grpc_port"`
		RegisterLocalDocker     bool   `json:"register_local_docker"`
		DockerRiskConfirmation  string `json:"docker_risk_confirmation"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	canonicalSetup := input.HTTPSListenAddress != "" || input.GRPCListenAddress != ""
	if !canonicalSetup && strings.TrimSpace(input.DisplayName) == "" {
		input.DisplayName = input.Username
	}
	if input.BindAddress == "" {
		input.BindAddress = input.HTTPSListenAddress
	}
	if input.WebPort == 0 {
		input.WebPort = input.HTTPSPort
	}
	if input.AgentPort == 0 {
		input.AgentPort = input.GRPCPort
	}
	if input.LocalDockerConfirmation == "" && input.RegisterLocalDocker {
		input.LocalDockerConfirmation = input.DockerRiskConfirmation
	}
	if canonicalSetup && (!safeName(input.DisplayName, 128) || input.GRPCListenAddress != input.HTTPSListenAddress) {
		writeError(response, http.StatusBadRequest, "invalid_setup_identity", "display name is required and v1 Web/agent bind addresses must match")
		return
	}
	if !validUsername(input.Username) {
		writeError(response, http.StatusBadRequest, "invalid_username", "username contains unsupported characters")
		return
	}
	if len(input.Password) < 14 || len(input.Password) > 1024 {
		writeError(response, http.StatusBadRequest, "weak_password", "password must contain 14 to 1024 characters")
		return
	}
	passwordHash, err := auth.HashPassword(input.Password)
	if err != nil {
		writeError(response, http.StatusBadRequest, "weak_password", err.Error())
		return
	}
	if input.BindAddress == "" {
		input.BindAddress = s.config.BindAddress
	}
	if net.ParseIP(input.BindAddress) == nil {
		writeError(response, http.StatusBadRequest, "invalid_bind_address", "bind address must be an IP address")
		return
	}
	if input.WebPort == 0 {
		input.WebPort = s.config.WebPort
	}
	if input.AgentPort == 0 {
		input.AgentPort = s.config.AgentPort
	}
	if input.WebPort < 1024 || input.WebPort > 65535 || input.AgentPort < 1024 || input.AgentPort > 65535 || input.WebPort == input.AgentPort {
		writeError(response, http.StatusBadRequest, "invalid_ports", "web and agent ports must be distinct unprivileged TCP ports from 1024 through 65535")
		return
	}
	if input.RegisterLocalDocker && input.LocalDockerConfirmation != "I UNDERSTAND DOCKER ACCESS IS ROOT-EQUIVALENT" {
		writeError(response, http.StatusBadRequest, "docker_confirmation_failed", "typed Docker root-equivalent confirmation did not match")
		return
	}
	if input.LocalDockerConfirmation != "" && input.LocalDockerConfirmation != "I UNDERSTAND DOCKER ACCESS IS ROOT-EQUIVALENT" {
		writeError(response, http.StatusBadRequest, "docker_confirmation_failed", "typed Docker root-equivalent confirmation did not match")
		return
	}
	localDocker := dockerconnector.Probe{Status: "not_requested"}
	if input.LocalDockerConfirmation != "" {
		localDocker = dockerconnector.ProbeLocal(request.Context(), "/var/run/docker.sock")
		if !localDocker.Available {
			writeError(response, http.StatusUnprocessableEntity, "docker_unavailable", "local Docker is not accessible to bored-managerd; complete setup without registration or configure the reviewed socket-group workflow first")
			return
		}
	}
	admin, err := s.store.CreateInitialAdmin(request.Context(), input.Username, input.DisplayName, passwordHash, map[string]string{
		"bind_address": input.BindAddress,
		"web_port":     strconv.Itoa(input.WebPort),
		"agent_port":   strconv.Itoa(input.AgentPort),
	})
	if err != nil {
		if errors.Is(err, store.ErrConflict) {
			writeError(response, http.StatusConflict, "already_configured", "initial setup is already complete")
		} else {
			writeError(response, http.StatusInternalServerError, "database_error", "could not create administrator")
		}
		return
	}
	if input.LocalDockerConfirmation != "" {
		if localDocker.Available {
			now := time.Now().UTC()
			if hostID, idErr := s.localDockerHostID(request.Context()); idErr == nil {
				err = s.store.UpsertDockerHost(request.Context(), store.DockerHost{ID: hostID, Name: "Local Docker Engine", Kind: "local", Endpoint: "unix:///var/run/docker.sock", Status: localDocker.Status, DockerVersion: localDocker.ServerVersion, LastCheckedAt: &now, CreatedAt: now})
				if err != nil {
					s.logger.Warn("initial local Docker registration failed", "error", err)
				}
			} else {
				s.logger.Warn("initial local Docker identity could not be resolved", "error", idErr)
			}
		}
	}
	token, csrf, session, err := s.newSession(request.Context(), admin)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "session_error", "administrator was created but login failed")
		return
	}
	setSessionCookies(response, token, csrf, session.ExpiresAt, s.config.DevHTTP)
	writeJSON(response, http.StatusCreated, sessionResponse(admin, session, csrf))
}

func (s *Server) login(response http.ResponseWriter, request *http.Request) {
	var input struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	admin, err := s.store.AdminByUsername(request.Context(), strings.TrimSpace(input.Username))
	passwordHash := admin.PasswordHash
	if err != nil {
		passwordHash = s.dummyHash
	}
	if !auth.VerifyPassword(passwordHash, input.Password) || err != nil {
		writeError(response, http.StatusUnauthorized, "invalid_credentials", "invalid username or password")
		return
	}
	token, csrf, session, err := s.newSession(request.Context(), admin)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "session_error", "could not create session")
		return
	}
	setSessionCookies(response, token, csrf, session.ExpiresAt, s.config.DevHTTP)
	writeJSON(response, http.StatusOK, sessionResponse(admin, session, csrf))
}

func (s *Server) logout(response http.ResponseWriter, request *http.Request) {
	if cookie, err := request.Cookie("bm_session"); err == nil {
		_ = s.store.DeleteSession(request.Context(), auth.DigestToken(cookie.Value))
	}
	clearSessionCookies(response, s.config.DevHTTP)
	response.WriteHeader(http.StatusNoContent)
}

func (s *Server) session(response http.ResponseWriter, request *http.Request) {
	session := currentSession(request)
	admin, err := s.store.AdminByUsername(request.Context(), session.Username)
	if err != nil {
		writeError(response, http.StatusUnauthorized, "invalid_session", "session user no longer exists")
		return
	}
	csrf := ""
	if cookie, err := request.Cookie("bm_csrf"); err == nil {
		csrf = cookie.Value
	}
	writeJSON(response, http.StatusOK, sessionResponse(admin, session, csrf))
}

func (s *Server) reauthenticate(response http.ResponseWriter, request *http.Request) {
	var input struct {
		Password string `json:"password"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	admin := currentAdmin(request)
	record, err := s.store.AdminByUsername(request.Context(), admin.Username)
	if err != nil || !auth.VerifyPassword(record.PasswordHash, input.Password) {
		writeError(response, http.StatusUnauthorized, "invalid_credentials", "administrator password is incorrect")
		return
	}
	session := currentSession(request)
	until := time.Now().UTC().Add(5 * time.Minute)
	if err := s.store.MarkSessionReauthenticated(request.Context(), session.TokenHash, until); err != nil {
		writeError(response, http.StatusUnauthorized, "invalid_session", "session is no longer active")
		return
	}
	session.ReauthenticatedUntil = &until
	csrf := ""
	if cookie, err := request.Cookie("bm_csrf"); err == nil {
		csrf = cookie.Value
	}
	writeJSON(response, http.StatusOK, sessionResponse(record, session, csrf))
}

func (s *Server) createEnrollment(response http.ResponseWriter, request *http.Request) {
	var input struct {
		Name      string          `json:"name"`
		CSRPEM    string          `json:"csr_pem"`
		Inventory json.RawMessage `json:"inventory"`
		Version   string          `json:"version"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if !safeName(input.Name, 128) {
		writeError(response, http.StatusBadRequest, "invalid_name", "agent name is invalid")
		return
	}
	if len(input.CSRPEM) > 64<<10 {
		writeError(response, http.StatusRequestEntityTooLarge, "csr_too_large", "CSR exceeds 64 KiB")
		return
	}
	_, fingerprint, err := pki.ParseCSR(input.CSRPEM)
	if err != nil {
		writeError(response, http.StatusBadRequest, "invalid_csr", err.Error())
		return
	}
	if len(input.Inventory) == 0 {
		input.Inventory = json.RawMessage(`{}`)
	}
	if !json.Valid(input.Inventory) || len(input.Inventory) > 256<<10 {
		writeError(response, http.StatusBadRequest, "invalid_inventory", "inventory must be valid JSON no larger than 256 KiB")
		return
	}
	if err := validateAgentInventory(input.Inventory); err != nil {
		writeError(response, http.StatusUnprocessableEntity, "unsupported_inventory", err.Error())
		return
	}
	source := remoteIP(request)
	count, err := s.store.EnrollmentRateCount(request.Context(), source, time.Now().Add(-time.Hour))
	if err != nil {
		writeError(response, http.StatusInternalServerError, "database_error", "could not rate-limit request")
		return
	}
	if count >= 10 {
		writeError(response, http.StatusTooManyRequests, "rate_limited", "too many enrollment requests from this source")
		return
	}
	id, err := randomID("enr_")
	if err != nil {
		writeError(response, http.StatusInternalServerError, "random_error", "could not create request")
		return
	}
	now := time.Now().UTC()
	enrollment := store.Enrollment{ID: id, AgentName: strings.TrimSpace(input.Name), CSRPEM: input.CSRPEM, Fingerprint: fingerprint, VerificationCode: pki.VerificationCode(fingerprint), SourceIP: source, Inventory: input.Inventory, Version: input.Version, Status: "pending_approval", CreatedAt: now, ExpiresAt: now.Add(10 * time.Minute)}
	if err := s.store.CreateEnrollment(request.Context(), enrollment); err != nil {
		if errors.Is(err, store.ErrConflict) {
			writeError(response, http.StatusConflict, "duplicate_request", err.Error())
		} else {
			writeError(response, http.StatusInternalServerError, "database_error", "could not persist enrollment request")
		}
		return
	}
	_, _ = s.hub.Publish(request.Context(), "enrollment.changed", enrollmentView(enrollment))
	writeJSON(response, http.StatusAccepted, enrollmentView(enrollment))
}

func (s *Server) enrollmentStatus(response http.ResponseWriter, request *http.Request) {
	id := request.PathValue("id")
	var input struct {
		Proof string `json:"proof"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	enrollment, err := s.store.Enrollment(request.Context(), id)
	if err != nil {
		writeError(response, http.StatusNotFound, "not_found", "enrollment request not found")
		return
	}
	csr, _, err := pki.ParseCSR(enrollment.CSRPEM)
	if err != nil || pki.VerifyEnrollmentProof(csr, id, input.Proof) != nil {
		writeError(response, http.StatusForbidden, "invalid_proof", "enrollment proof was rejected")
		return
	}
	if enrollment.Status == "pending_approval" && time.Now().After(enrollment.ExpiresAt) {
		_, _ = s.store.ExpireEnrollments(request.Context(), time.Now())
		enrollment.Status = "expired"
	}
	if enrollment.Status == "pending_approval" {
		response.Header().Set("Retry-After", "3")
		writeJSON(response, http.StatusAccepted, enrollmentView(enrollment))
		return
	}
	if enrollment.Status != "approved" {
		writeError(response, http.StatusConflict, "enrollment_"+enrollment.Status, "enrollment request is "+enrollment.Status)
		return
	}
	agent, err := s.store.AgentBySerial(request.Context(), enrollment.CertificateSerial)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "identity_missing", "approved agent identity is missing")
		return
	}
	certificateBlock, _ := pem.Decode([]byte(enrollment.CertificatePEM))
	if certificateBlock == nil || certificateBlock.Type != "CERTIFICATE" {
		writeError(response, http.StatusInternalServerError, "certificate_invalid", "issued certificate is invalid")
		return
	}
	certificate, err := x509.ParseCertificate(certificateBlock.Bytes)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "certificate_invalid", "issued certificate is invalid")
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"agent": agentView(agent), "certificate_chain_pem": enrollment.CertificatePEM, "manager_ca_pem": string(s.ca.CertificatePEM), "certificate_not_after": certificate.NotAfter})
}

func (s *Server) enrollmentRequests(response http.ResponseWriter, request *http.Request) {
	requests, err := s.store.PendingEnrollments(request.Context())
	if err != nil {
		writeError(response, http.StatusInternalServerError, "database_error", "could not list enrollment requests")
		return
	}
	views := make([]any, 0, len(requests))
	for _, item := range requests {
		views = append(views, enrollmentView(item))
	}
	cursor, _ := s.store.LatestEventCursor(request.Context())
	writeJSON(response, http.StatusOK, map[string]any{"enrollment_requests": views, "page": map[string]any{"event_cursor": strconv.FormatInt(cursor, 10)}})
}

func (s *Server) approveEnrollment(response http.ResponseWriter, request *http.Request) {
	id := request.PathValue("id")
	var input struct {
		VerificationCode  string   `json:"verification_code"`
		Alias             string   `json:"alias"`
		Tags              []string `json:"tags"`
		LogicalInstanceID string   `json:"logical_instance_id"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	enrollment, err := s.store.Enrollment(request.Context(), id)
	if err != nil {
		writeError(response, http.StatusNotFound, "not_found", "enrollment request not found")
		return
	}
	admin := currentAdmin(request)
	session := currentSession(request)
	if session.ReauthenticatedUntil == nil || session.ReauthenticatedUntil.Before(time.Now()) {
		writeError(response, http.StatusForbidden, "reauthentication_required", "administrator reauthentication is required")
		return
	}
	if input.VerificationCode != enrollment.VerificationCode {
		writeError(response, http.StatusForbidden, "verification_failed", "verification code is incorrect")
		return
	}
	if input.Alias == "" {
		input.Alias = enrollment.AgentName
	}
	if !safeName(input.Alias, 128) || len(input.Tags) > 64 {
		writeError(response, http.StatusBadRequest, "invalid_identity", "agent alias or tags are invalid")
		return
	}
	csr, _, err := pki.ParseCSR(enrollment.CSRPEM)
	if err != nil {
		writeError(response, http.StatusConflict, "invalid_csr", "stored CSR is invalid")
		return
	}
	agentID, err := randomID("agt_")
	if err != nil {
		writeError(response, http.StatusInternalServerError, "random_error", "could not create agent identity")
		return
	}
	certificate, serial, err := s.ca.SignAgentCSR(csr, agentID, 90*24*time.Hour)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "pki_error", "could not issue agent certificate")
		return
	}
	agent := store.Agent{ID: agentID, Name: input.Alias, Fingerprint: enrollment.Fingerprint, Version: enrollment.Version, Status: "approved", Inventory: enrollment.Inventory}
	if err := s.store.ApproveEnrollment(request.Context(), id, admin.ID, agent, certificate, serial); err != nil {
		if errors.Is(err, store.ErrConflict) {
			writeError(response, http.StatusConflict, "not_pending", err.Error())
		} else {
			writeError(response, http.StatusInternalServerError, "database_error", "could not approve request")
		}
		return
	}
	approved, _ := s.store.Enrollment(request.Context(), id)
	_, _ = s.hub.Publish(request.Context(), "enrollment.changed", enrollmentView(approved))
	writeJSON(response, http.StatusOK, enrollmentView(approved))
}

func (s *Server) rejectEnrollment(response http.ResponseWriter, request *http.Request) {
	id := request.PathValue("id")
	admin := currentAdmin(request)
	var input struct {
		Reason string `json:"reason"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	session := currentSession(request)
	if session.ReauthenticatedUntil == nil || session.ReauthenticatedUntil.Before(time.Now()) {
		writeError(response, http.StatusForbidden, "reauthentication_required", "administrator reauthentication is required")
		return
	}
	if strings.TrimSpace(input.Reason) == "" || len(input.Reason) > 512 {
		writeError(response, http.StatusBadRequest, "invalid_reason", "a rejection reason is required")
		return
	}
	if err := s.store.RejectEnrollment(request.Context(), id, admin.ID, strings.TrimSpace(input.Reason)); err != nil {
		writeError(response, http.StatusConflict, "not_pending", "request is not pending")
		return
	}
	rejected, _ := s.store.Enrollment(request.Context(), id)
	_, _ = s.hub.Publish(request.Context(), "enrollment.changed", enrollmentView(rejected))
	writeJSON(response, http.StatusOK, enrollmentView(rejected))
}

func enrollmentView(enrollment store.Enrollment) map[string]any {
	view := map[string]any{"enrollment_id": enrollment.ID, "state": enrollment.Status, "csr_fingerprint": enrollment.Fingerprint, "verification_code": enrollment.VerificationCode, "source_address": enrollment.SourceIP, "inventory": json.RawMessage(enrollment.Inventory), "requested_at": enrollment.CreatedAt, "expires_at": enrollment.ExpiresAt}
	if enrollment.ReviewedAt != nil {
		view["reviewed_at"] = *enrollment.ReviewedAt
	}
	if enrollment.DecisionReason != "" {
		view["decision_reason"] = enrollment.DecisionReason
	}
	if enrollment.AgentID != "" {
		view["agent_id"] = enrollment.AgentID
	}
	return view
}

func agentView(agent store.Agent) map[string]any {
	presence := agent.Status
	if presence == "approved" {
		presence = "pending"
	}
	return map[string]any{"agent_id": agent.ID, "logical_instance_id": agent.ID, "alias": agent.Name, "tags": []string{}, "presence": presence, "protocol_version": agent.Version, "certificate_serial": agent.CertificateSerial, "inventory": json.RawMessage(agent.Inventory), "last_sequence": 0, "last_seen_at": agent.LastSeen, "enrolled_at": agent.CreatedAt, "revoked_at": agent.RevokedAt}
}

func (s *Server) agents(response http.ResponseWriter, request *http.Request) {
	agents, err := s.store.Agents(request.Context())
	if err != nil {
		writeError(response, http.StatusInternalServerError, "database_error", "could not list agents")
		return
	}
	if agents == nil {
		agents = []store.Agent{}
	}
	s.lastSeenMu.RLock()
	for index := range agents {
		if value, ok := s.lastSeen[agents[index].ID]; ok {
			agents[index].LastSeen = &value
			if time.Since(value) < 45*time.Second && agents[index].RevokedAt == nil {
				agents[index].Status = "online"
			}
		}
	}
	s.lastSeenMu.RUnlock()
	views := make([]any, 0, len(agents))
	for _, agent := range agents {
		views = append(views, agentView(agent))
	}
	cursor, _ := s.store.LatestEventCursor(request.Context())
	writeJSON(response, http.StatusOK, map[string]any{"agents": views, "page": map[string]any{"event_cursor": strconv.FormatInt(cursor, 10)}})
}

func (s *Server) agentInstallCommand(response http.ResponseWriter, request *http.Request) {
	host := request.Host
	if parsedHost, _, err := net.SplitHostPort(request.Host); err == nil {
		host = parsedHost
	}
	host = strings.Trim(host, "[]")
	if net.ParseIP(host) == nil && !validDNSName(host) {
		writeError(response, http.StatusBadRequest, "invalid_host", "request Host cannot be used for an agent endpoint")
		return
	}
	managerURL := "https://" + net.JoinHostPort(host, strconv.Itoa(s.config.AgentPort))
	verifiedRelease, releaseErr := s.verifiedAgentRelease()
	available := releaseErr == nil
	result := map[string]any{"available": available, "version": version.Version, "manager_url": managerURL, "manager_spki_pin": s.webCurlPin}
	if !available {
		result["reason"] = "No locally cached, offline-signed agent release corresponds to this manager build."
		writeJSON(response, http.StatusOK, result)
		return
	}
	installerURL := managerURL + "/api/v1/artifacts/releases/v" + verifiedRelease.Version + "/" + verifiedRelease.AgentInstaller
	command := buildAgentInstallCommand(installerURL, managerURL, s.webCurlPin, verifiedRelease.Version)
	result["command"] = command
	writeJSON(response, http.StatusOK, result)
}

func buildAgentInstallCommand(installerURL, managerURL, pin, releaseVersion string) string {
	return `tmp="$(mktemp)" && { curl --proto '=https' --tlsv1.2 --insecure --pinnedpubkey ` + shellQuote(pin) + ` -f --retry 3 -o "$tmp" ` + shellQuote(installerURL) + ` && bash "$tmp" --manager-url ` + shellQuote(managerURL) + ` --manager-spki-pin ` + shellQuote(pin) + ` --version ` + shellQuote(releaseVersion) + `; rc=$?; rm -f "$tmp"; (exit "$rc"); }`
}

func validDNSName(value string) bool {
	if value == "" || len(value) > 253 {
		return false
	}
	for _, label := range strings.Split(value, ".") {
		if label == "" || len(label) > 63 || strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
			return false
		}
		for _, character := range label {
			if !(character == '-' || character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9') {
				return false
			}
		}
	}
	return true
}
func validUsername(value string) bool {
	if value == "" || len(value) > 63 {
		return false
	}
	for index, character := range value {
		if !(character >= 'a' && character <= 'z' || character >= '0' && character <= '9' || index > 0 && (character == '.' || character == '_' || character == '-')) {
			return false
		}
	}
	return true
}
func shellQuote(value string) string { return "'" + strings.ReplaceAll(value, "'", `'"'"'`) + "'" }

func (s *Server) revokeAgent(response http.ResponseWriter, request *http.Request) {
	id := request.PathValue("id")
	var input struct {
		Reason       string `json:"reason"`
		Confirmation string `json:"confirmation"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	session := currentSession(request)
	if session.ReauthenticatedUntil == nil || session.ReauthenticatedUntil.Before(time.Now()) {
		writeError(response, http.StatusForbidden, "reauthentication_required", "administrator reauthentication is required")
		return
	}
	input.Reason = strings.TrimSpace(input.Reason)
	if input.Reason == "" || len(input.Reason) > 512 {
		writeError(response, http.StatusBadRequest, "invalid_reason", "a revocation reason containing at most 512 characters is required")
		return
	}
	if input.Confirmation != "REVOKE "+id {
		writeError(response, http.StatusConflict, "confirmation_failed", "confirmation must exactly match REVOKE followed by the agent ID")
		return
	}
	idempotencyKey := request.Header.Get("Idempotency-Key")
	if len(idempotencyKey) < 8 || len(idempotencyKey) > 128 || strings.TrimSpace(idempotencyKey) != idempotencyKey {
		writeError(response, http.StatusBadRequest, "idempotency_key_required", "Idempotency-Key must contain 8 to 128 non-padded characters")
		return
	}
	revoked, changed, err := s.store.RevokeAgent(request.Context(), id, input.Reason, currentAdmin(request).ID, idempotencyKey)
	if errors.Is(err, store.ErrNotFound) {
		writeError(response, http.StatusNotFound, "not_found", "agent not found")
		return
	}
	if errors.Is(err, store.ErrConflict) {
		writeError(response, http.StatusConflict, "already_revoked", "agent was already revoked by another request")
		return
	}
	if err != nil {
		writeError(response, http.StatusInternalServerError, "database_error", "could not revoke agent")
		return
	}
	if changed {
		_, _ = s.hub.Publish(request.Context(), "agent.changed", agentView(revoked))
	}
	writeJSON(response, http.StatusOK, agentView(revoked))
}

func (s *Server) heartbeat(response http.ResponseWriter, request *http.Request) {
	if request.TLS == nil || len(request.TLS.VerifiedChains) == 0 || len(request.TLS.PeerCertificates) == 0 {
		writeError(response, http.StatusUnauthorized, "client_certificate_required", "valid agent client certificate required")
		return
	}
	certificate := request.TLS.PeerCertificates[0]
	if certificate.ExtKeyUsage != nil && !containsUsage(certificate.ExtKeyUsage, x509.ExtKeyUsageClientAuth) {
		writeError(response, http.StatusUnauthorized, "invalid_certificate", "certificate is not valid for client authentication")
		return
	}
	agent, err := s.store.AgentBySerial(request.Context(), certificate.SerialNumber.Text(16))
	if err != nil || agent.RevokedAt != nil || certificate.Subject.CommonName != agent.ID {
		writeError(response, http.StatusUnauthorized, "revoked_or_unknown", "agent certificate is revoked or unknown")
		return
	}
	var input struct {
		Version   string          `json:"version"`
		Inventory json.RawMessage `json:"inventory"`
		Services  json.RawMessage `json:"services"`
		Metrics   json.RawMessage `json:"metrics"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if len(input.Inventory) == 0 {
		input.Inventory = json.RawMessage(`{}`)
	}
	if err := validateAgentInventory(input.Inventory); err != nil {
		writeError(response, http.StatusUnprocessableEntity, "unsupported_inventory", err.Error())
		return
	}
	now := time.Now().UTC()
	s.lastSeenMu.Lock()
	s.lastSeen[agent.ID] = now
	s.lastSeenMu.Unlock()
	if err := s.store.RecordHeartbeat(request.Context(), agent.ID, input.Version, input.Inventory, now); err != nil {
		writeError(response, http.StatusInternalServerError, "database_error", "could not record heartbeat")
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"status": "accepted", "server_time": now, "next_heartbeat_seconds": 15})
}

func containsUsage(usages []x509.ExtKeyUsage, want x509.ExtKeyUsage) bool {
	for _, usage := range usages {
		if usage == want {
			return true
		}
	}
	return false
}

func validateAgentInventory(raw json.RawMessage) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var inventory domain.Inventory
	if err := decoder.Decode(&inventory); err != nil {
		return fmt.Errorf("invalid inventory: %w", err)
	}
	if err := inventory.Validate(); err != nil {
		return fmt.Errorf("unsupported inventory: %w", err)
	}
	return nil
}

func (s *Server) discoverLocalDocker(response http.ResponseWriter, request *http.Request) {
	writeJSON(response, http.StatusOK, dockerconnector.ProbeLocal(request.Context(), "/var/run/docker.sock"))
}

func canonicalIntentHash(value any) (string, error) {
	contents, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return sha256Hex(contents), nil
}

func (s *Server) replayIdempotent(response http.ResponseWriter, request *http.Request, key, operation, requestHash string) bool {
	replay, found, err := s.store.ReplayIdempotency(request.Context(), key, operation, requestHash, time.Now())
	if errors.Is(err, store.ErrConflict) {
		writeError(response, http.StatusConflict, "idempotency_conflict", "Idempotency-Key was already used for another intent")
		return true
	}
	if err != nil {
		writeError(response, http.StatusInternalServerError, "database_error", "could not read idempotency state")
		return true
	}
	if !found {
		return false
	}
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Idempotency-Replayed", "true")
	response.WriteHeader(replay.StatusCode)
	_, _ = response.Write(replay.Response)
	return true
}

func (s *Server) localDockerHostID(ctx context.Context) (string, error) {
	hosts, err := s.store.DockerHosts(ctx)
	if err != nil {
		return "", err
	}
	for _, host := range hosts {
		if host.Kind == "local" {
			if err := domain.ValidateUUIDv7(host.ID); err != nil {
				return "", fmt.Errorf("stored local Docker host ID is invalid: %w", err)
			}
			return host.ID, nil
		}
	}
	return randomID("docker_host")
}

func dockerHostView(host store.DockerHost) map[string]any {
	updatedAt := host.CreatedAt
	if host.LastCheckedAt != nil {
		updatedAt = *host.LastCheckedAt
	}
	view := map[string]any{
		"docker_host_id": host.ID,
		"name":           host.Name,
		"socket_path":    "/var/run/docker.sock",
		"docker_version": host.DockerVersion,
		"healthy":        host.Status == "healthy",
		"created_at":     host.CreatedAt,
		"updated_at":     updatedAt,
	}
	if host.LastCheckedAt != nil {
		view["last_preflight_at"] = *host.LastCheckedAt
	}
	if host.Kind == "local" {
		view["transport"] = "local_unix"
		return view
	}
	view["transport"] = "remote_ssh"
	if user, addressPort, ok := strings.Cut(host.Endpoint, "@"); ok {
		view["ssh_user"] = user
		if address, portText, err := net.SplitHostPort(addressPort); err == nil {
			view["ssh_address"] = address
			if port, err := strconv.Atoi(portText); err == nil {
				view["ssh_port"] = port
			}
		}
	}
	if algorithm, fingerprint, ok := strings.Cut(host.SSHHostKey, "\t"); ok {
		view["ssh_host_key"] = map[string]string{"algorithm": algorithm, "fingerprint": fingerprint}
	}
	return view
}

func (s *Server) registerLocalDocker(response http.ResponseWriter, request *http.Request) {
	var input struct {
		Name                       string `json:"name"`
		SocketPath                 string `json:"socket_path"`
		Confirmation               string `json:"confirmation"`
		RootEquivalentConfirmation string `json:"root_equivalent_confirmation"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if input.Confirmation == "" {
		input.Confirmation = input.RootEquivalentConfirmation
	}
	s.createLocalDocker(response, request, input.Name, input.SocketPath, input.Confirmation, "", "")
}

type dockerHostKeyInput struct {
	Algorithm   string `json:"algorithm"`
	Fingerprint string `json:"fingerprint"`
}

type dockerHostCreateInput struct {
	Name                       string             `json:"name"`
	Transport                  string             `json:"transport"`
	SocketPath                 string             `json:"socket_path"`
	SSHAddress                 string             `json:"ssh_address"`
	SSHPort                    int                `json:"ssh_port"`
	SSHUser                    string             `json:"ssh_user"`
	SSHCredentialRef           string             `json:"ssh_credential_ref"`
	KnownHostLine              string             `json:"known_host_line"`
	RootEquivalentConfirmation string             `json:"root_equivalent_confirmation"`
	SSHHostKey                 dockerHostKeyInput `json:"ssh_host_key"`
}

func (s *Server) createLocalDocker(response http.ResponseWriter, request *http.Request, name, socketPath, confirmation, idempotencyKey, requestHash string) {
	if confirmation != "I UNDERSTAND DOCKER ACCESS IS ROOT-EQUIVALENT" {
		writeError(response, http.StatusBadRequest, "confirmation_failed", "typed root-equivalent confirmation did not match")
		return
	}
	if socketPath == "" {
		socketPath = "/var/run/docker.sock"
	}
	if socketPath != "/var/run/docker.sock" {
		writeError(response, http.StatusBadRequest, "unsupported_socket", "v1 supports only /var/run/docker.sock")
		return
	}
	if name == "" {
		name = "local"
	}
	if !safeName(name, 128) {
		writeError(response, http.StatusBadRequest, "invalid_name", "host name is invalid")
		return
	}
	const operation = "docker-host.create.local-unix"
	if idempotencyKey != "" && s.replayIdempotent(response, request, idempotencyKey, operation, requestHash) {
		return
	}
	probe := dockerconnector.ProbeLocal(request.Context(), socketPath)
	if !probe.Available {
		writeJSON(response, http.StatusServiceUnavailable, probe)
		return
	}
	now := time.Now().UTC()
	hostID, err := s.localDockerHostID(request.Context())
	if err != nil {
		writeError(response, http.StatusInternalServerError, "database_error", "could not resolve local Docker identity")
		return
	}
	host := store.DockerHost{ID: hostID, Name: name, Kind: "local", Endpoint: "unix://" + socketPath, Status: probe.Status, DockerVersion: probe.ServerVersion, LastCheckedAt: &now, CreatedAt: now}
	view := dockerHostView(host)
	encodedView, err := json.Marshal(view)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "encoding_error", "could not encode Docker host")
		return
	}
	encodedView = append(encodedView, '\n')
	if idempotencyKey != "" {
		err = s.store.UpsertDockerHostIdempotent(request.Context(), host, idempotencyKey, operation, requestHash, http.StatusCreated, encodedView, now)
	} else {
		err = s.store.UpsertDockerHost(request.Context(), host)
	}
	if err != nil {
		if idempotencyKey != "" && s.replayIdempotent(response, request, idempotencyKey, operation, requestHash) {
			return
		}
		writeError(response, http.StatusInternalServerError, "database_error", "could not register Docker Engine")
		return
	}
	_, _ = s.hub.Publish(request.Context(), "docker_host.changed", view)
	writeJSON(response, http.StatusCreated, view)
}

func (s *Server) registerRemoteDocker(response http.ResponseWriter, request *http.Request) {
	idempotencyKey := request.Header.Get("Idempotency-Key")
	if len(idempotencyKey) < 8 || len(idempotencyKey) > 128 || strings.TrimSpace(idempotencyKey) != idempotencyKey {
		writeError(response, http.StatusBadRequest, "idempotency_key_required", "Idempotency-Key must contain 8 to 128 characters")
		return
	}
	var input dockerHostCreateInput
	if err := decodeJSON(response, request, &input); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if input.Transport == "local_unix" {
		if input.Name == "" {
			input.Name = "local"
		}
		if input.SocketPath == "" {
			input.SocketPath = "/var/run/docker.sock"
		}
		requestHash, err := canonicalIntentHash(input)
		if err != nil {
			writeError(response, http.StatusInternalServerError, "encoding_error", "could not encode Docker host intent")
			return
		}
		s.createLocalDocker(response, request, input.Name, input.SocketPath, input.RootEquivalentConfirmation, idempotencyKey, requestHash)
		return
	}
	if !safeName(input.Name, 128) {
		writeError(response, http.StatusBadRequest, "invalid_name", "host name is invalid")
		return
	}
	if input.Transport != "remote_ssh" {
		writeError(response, http.StatusBadRequest, "unsupported_transport", "this endpoint requires remote_ssh transport")
		return
	}
	if input.SocketPath == "" {
		input.SocketPath = "/var/run/docker.sock"
	}
	if input.SocketPath != "/var/run/docker.sock" {
		writeError(response, http.StatusBadRequest, "unsupported_socket", "v1 remote Docker supports only /var/run/docker.sock")
		return
	}
	if input.SSHPort == 0 {
		input.SSHPort = 22
	}
	if len(input.KnownHostLine) < 64 || len(input.KnownHostLine) > 16384 {
		writeError(response, http.StatusBadRequest, "invalid_host_key", "known_hosts line must contain 64 to 16384 characters")
		return
	}
	hostKey, err := dockerconnector.ParseKnownHostLine(input.KnownHostLine)
	if err != nil {
		writeError(response, http.StatusBadRequest, "invalid_host_key", err.Error())
		return
	}
	if input.SSHHostKey.Fingerprint == "" || input.SSHHostKey.Fingerprint != hostKey.Fingerprint {
		writeError(response, http.StatusBadRequest, "host_key_mismatch", fmt.Sprintf("supplied key fingerprint is %s", hostKey.Fingerprint))
		return
	}
	if input.SSHHostKey.Algorithm == "" || input.SSHHostKey.Algorithm != hostKey.Algorithm {
		writeError(response, http.StatusBadRequest, "host_key_algorithm_mismatch", fmt.Sprintf("known_hosts key algorithm is %s", hostKey.Algorithm))
		return
	}
	requestHash, err := canonicalIntentHash(input)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "encoding_error", "could not encode Docker host intent")
		return
	}
	const operation = "docker-host.create.remote-ssh"
	if s.replayIdempotent(response, request, idempotencyKey, operation, requestHash) {
		return
	}
	credentialPath, err := s.config.CredentialPath(input.SSHCredentialRef)
	if err != nil {
		writeError(response, http.StatusUnprocessableEntity, "credential_unavailable", "load the named SSH key as an encrypted systemd credential before registering the host")
		return
	}
	target := dockerconnector.SSHTarget{User: input.SSHUser, Address: input.SSHAddress, Port: input.SSHPort, IdentityFile: credentialPath}
	if err := target.Validate(); err != nil {
		writeError(response, http.StatusUnprocessableEntity, "invalid_ssh_target", err.Error())
		return
	}
	id, err := randomID("dkr_")
	if err != nil {
		writeError(response, http.StatusInternalServerError, "random_error", "could not create host")
		return
	}
	knownHostsPath, _, err := dockerconnector.WriteKnownHost(filepath.Join(s.config.StateDir, "ssh", "known_hosts.d"), id, input.KnownHostLine)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "host_key_write_failed", "could not store host key")
		return
	}
	probeCtx, cancel := context.WithTimeout(request.Context(), 15*time.Second)
	defer cancel()
	probe := dockerconnector.ProbeSSH(probeCtx, target, knownHostsPath)
	if !probe.Available || probe.Status != "healthy" {
		_ = os.Remove(knownHostsPath)
		writeError(response, http.StatusUnprocessableEntity, "docker_preflight_failed", "strict SSH/Docker preflight did not return a healthy Engine")
		return
	}
	now := time.Now().UTC()
	endpoint := input.SSHUser + "@" + net.JoinHostPort(input.SSHAddress, strconv.Itoa(input.SSHPort))
	host := store.DockerHost{ID: id, Name: input.Name, Kind: "ssh", Endpoint: endpoint, SSHHostKey: hostKey.Algorithm + "\t" + hostKey.Fingerprint, SSHCredential: input.SSHCredentialRef, Status: probe.Status, DockerVersion: probe.ServerVersion, LastCheckedAt: &now, CreatedAt: now}
	view := dockerHostView(host)
	encodedView, err := json.Marshal(view)
	if err != nil {
		_ = os.Remove(knownHostsPath)
		writeError(response, http.StatusInternalServerError, "encoding_error", "could not encode Docker host")
		return
	}
	encodedView = append(encodedView, '\n')
	if err := s.store.UpsertDockerHostIdempotent(request.Context(), host, idempotencyKey, operation, requestHash, http.StatusCreated, encodedView, now); err != nil {
		_ = os.Remove(knownHostsPath)
		if s.replayIdempotent(response, request, idempotencyKey, operation, requestHash) {
			return
		}
		writeError(response, http.StatusInternalServerError, "database_error", "could not register Docker host")
		return
	}
	_, _ = s.hub.Publish(request.Context(), "docker_host.changed", view)
	writeJSON(response, http.StatusCreated, view)
}

func (s *Server) dockerHosts(response http.ResponseWriter, request *http.Request) {
	hosts, err := s.store.DockerHosts(request.Context())
	if err != nil {
		writeError(response, http.StatusInternalServerError, "database_error", "could not list Docker hosts")
		return
	}
	views := make([]any, 0, len(hosts))
	for _, host := range hosts {
		views = append(views, dockerHostView(host))
	}
	cursor, _ := s.store.LatestEventCursor(request.Context())
	writeJSON(response, http.StatusOK, map[string]any{"docker_hosts": views, "page": map[string]any{"event_cursor": strconv.FormatInt(cursor, 10)}})
}

func (s *Server) diagnostics(response http.ResponseWriter, request *http.Request) {
	high, low := s.store.QueueDepth()
	databaseSize := int64(0)
	walSize := int64(0)
	if info, err := os.Stat(s.config.DatabasePath); err == nil {
		databaseSize = info.Size()
	}
	if info, err := os.Stat(s.config.DatabasePath + "-wal"); err == nil {
		walSize = info.Size()
	}
	agents, _ := s.store.Agents(request.Context())
	hosts, _ := s.store.DockerHosts(request.Context())
	writeJSON(response, http.StatusOK, map[string]any{
		"status": "ok", "version": version.Current(), "go": runtime.Version(), "os": runtime.GOOS, "architecture": runtime.GOARCH,
		"database":     map[string]any{"path": s.config.DatabasePath, "bytes": databaseSize, "wal_bytes": walSize, "quota_bytes": s.config.DatabaseLimitBytes},
		"writer_queue": map[string]int{"critical": high, "telemetry": low}, "agents": len(agents), "docker_hosts": len(hosts),
		"listeners":            map[string]any{"web_port": s.config.WebPort, "agent_port": s.config.AgentPort, "control_socket": filepath.Join(s.config.RuntimeDir, "manager.sock")},
		"web_spki_fingerprint": s.webSPKIPin,
	})
}
