package manager

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func (s *Server) registerWebRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("GET /readyz", s.health)
	mux.HandleFunc("GET /api/v1/health", s.apiHealth)
	mux.HandleFunc("GET /api/v1/version", s.version)
	mux.HandleFunc("GET /api/v1/setup", s.apiSetupStatus)
	mux.HandleFunc("POST /api/v1/setup", s.setup)
	mux.HandleFunc("POST /api/v1/auth/login", s.login)
	mux.HandleFunc("DELETE /api/v1/auth/session", s.withAdmin(s.logout))
	mux.HandleFunc("GET /api/v1/auth/session", s.withAdmin(s.session))
	mux.HandleFunc("POST /api/v1/auth/reauthenticate", s.withAdmin(s.reauthenticate))
	mux.HandleFunc("GET /api/v1/agents", s.withAdmin(s.agents))
	mux.HandleFunc("GET /api/v1/agents/install-command", s.withAdmin(s.agentInstallCommand))
	mux.HandleFunc("POST /api/v1/agents/{id}/revoke", s.withAdmin(s.revokeAgent))
	mux.HandleFunc("GET /api/v1/enrollment-requests", s.withAdmin(s.enrollmentRequests))
	mux.HandleFunc("POST /api/v1/enrollment-requests/{id}/approve", s.withAdmin(s.approveEnrollment))
	mux.HandleFunc("POST /api/v1/enrollment-requests/{id}/reject", s.withAdmin(s.rejectEnrollment))
	mux.HandleFunc("GET /api/v1/docker-hosts", s.withAdmin(s.dockerHosts))
	mux.HandleFunc("POST /api/v1/docker-hosts", s.withAdmin(s.registerRemoteDocker))
	mux.HandleFunc("GET /api/v1/docker-hosts/local/discovery", s.withAdmin(s.discoverLocalDocker))
	mux.HandleFunc("GET /api/v1/events", s.withAdmin(s.hub.ServeWebSocket))
	mux.Handle("/", s.spaHandler())
}

func (s *Server) registerAgentRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("POST /api/v1/enrollment-requests", s.createEnrollment)
	mux.HandleFunc("POST /api/v1/enrollment-requests/{id}/status", s.enrollmentStatus)
	mux.HandleFunc("GET /api/v1/artifacts/releases/{tag}/{name}", s.serveAgentReleaseArtifact)
	mux.HandleFunc("POST /agent/v1/heartbeat", s.heartbeat)
}

func (s *Server) spaHandler() http.Handler {
	files := http.Dir(s.config.WebDir)
	fileServer := http.FileServer(files)
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet && request.Method != http.MethodHead {
			http.NotFound(response, request)
			return
		}
		cleaned := filepath.Clean(strings.TrimPrefix(request.URL.Path, "/"))
		if cleaned == "." {
			cleaned = "index.html"
		}
		if info, err := os.Stat(filepath.Join(s.config.WebDir, cleaned)); err == nil && !info.IsDir() {
			fileServer.ServeHTTP(response, request)
			return
		}
		index := filepath.Join(s.config.WebDir, "index.html")
		if _, err := os.Stat(index); err == nil {
			http.ServeFile(response, request, index)
			return
		}
		response.Header().Set("Content-Type", "text/html; charset=utf-8")
		response.WriteHeader(http.StatusServiceUnavailable)
		_, _ = response.Write([]byte("<!doctype html><title>Bored Manager</title><h1>Bored Manager</h1><p>The Web UI bundle is not installed. Use <code>bmctl diagnostics</code>.</p>"))
	})
}
