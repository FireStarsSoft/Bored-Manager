package manager

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/FireStarsSoft/Bored-Manager/internal/store"
)

func TestWriteErrorUsesProblemDetails(t *testing.T) {
	recorder := httptest.NewRecorder()
	writeError(recorder, http.StatusUnauthorized, "invalid_session", "session is invalid")

	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusUnauthorized)
	}
	if contentType := recorder.Header().Get("Content-Type"); !strings.HasPrefix(contentType, "application/problem+json") {
		t.Fatalf("Content-Type = %q", contentType)
	}
	var problem apiError
	if err := json.NewDecoder(recorder.Body).Decode(&problem); err != nil {
		t.Fatal(err)
	}
	if problem.Type != "/api/v1/problems/invalid_session" || problem.Title != "Unauthorized" || problem.Status != http.StatusUnauthorized || problem.Detail != "session is invalid" || problem.Code != "invalid_session" {
		t.Fatalf("unexpected problem details: %+v", problem)
	}
}

func TestAgentInstallCommandPinsTheManagerArtifactEndpoint(t *testing.T) {
	managerURL := "https://manager.example.invalid:9443"
	pin := "sha256//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
	installerURL := managerURL + "/api/v1/artifacts/releases/v1.2.3/install-agent.sh"
	command := buildAgentInstallCommand(installerURL, managerURL, pin, "1.2.3")
	for _, required := range []string{"--insecure --pinnedpubkey", shellQuote(pin), shellQuote(installerURL), "--manager-url " + shellQuote(managerURL), "--version '1.2.3'"} {
		if !strings.Contains(command, required) {
			t.Fatalf("agent install command is missing %q: %s", required, command)
		}
	}
	if strings.Contains(command, "github.com") {
		t.Fatalf("manager SPKI pin must not be applied to a GitHub TLS endpoint: %s", command)
	}
}

func TestDockerHostViewMatchesThePublicContract(t *testing.T) {
	created := time.Date(2026, 8, 4, 0, 0, 0, 0, time.UTC)
	checked := created.Add(time.Minute)
	view := dockerHostView(store.DockerHost{
		ID: "0198a0d4-83c0-7000-8000-000000000001", Name: "remote", Kind: "ssh",
		Endpoint: "operator@[2001:db8::10]:2222", SSHHostKey: "ssh-ed25519\tSHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		Status: "healthy", DockerVersion: "29.6.2", CreatedAt: created, LastCheckedAt: &checked,
	})
	for _, required := range []string{"docker_host_id", "name", "transport", "socket_path", "healthy", "created_at", "updated_at", "ssh_host_key"} {
		if _, ok := view[required]; !ok {
			t.Fatalf("canonical Docker host is missing %q: %+v", required, view)
		}
	}
	if view["transport"] != "remote_ssh" || view["ssh_address"] != "2001:db8::10" || view["ssh_port"] != 2222 || view["ssh_user"] != "operator" {
		t.Fatalf("remote endpoint was not normalized: %+v", view)
	}
	if _, legacy := view["id"]; legacy {
		t.Fatalf("legacy Docker host field leaked into public API: %+v", view)
	}
}
