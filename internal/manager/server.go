// Package manager implements the HTTPS control plane and local control socket.
package manager

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"time"

	"github.com/FireStarsSoft/Bored-Manager/internal/auth"
	"github.com/FireStarsSoft/Bored-Manager/internal/config"
	"github.com/FireStarsSoft/Bored-Manager/internal/events"
	"github.com/FireStarsSoft/Bored-Manager/internal/pki"
	"github.com/FireStarsSoft/Bored-Manager/internal/store"
)

// Server owns the web, agent and local Unix-socket listeners.
type Server struct {
	config      config.ManagerConfig
	store       *store.Store
	hub         *events.Hub
	ca          *pki.CertificateAuthority
	webCertPEM  []byte
	webSPKIPin  string
	webCurlPin  string
	webServer   *http.Server
	agentServer *http.Server
	logger      *slog.Logger
	dummyHash   string
	lastSeenMu  sync.RWMutex
	lastSeen    map[string]time.Time
}

// New validates identities and assembles the HTTP routes without binding ports.
func New(cfg config.ManagerConfig, database *store.Store, logger *slog.Logger) (*Server, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if logger == nil {
		logger = slog.Default()
	}
	dummyHash, err := auth.HashPassword("bored-manager-dummy-password")
	if err != nil {
		return nil, fmt.Errorf("initialize login timing defense: %w", err)
	}
	ca, err := pki.EnsureAgentCA(cfg.AgentCAPath, cfg.AgentCAKeyPath)
	if err != nil {
		return nil, fmt.Errorf("initialize agent CA: %w", err)
	}
	webCertPEM, err := pki.EnsureWebCertificate(cfg.WebCertificatePath, cfg.WebPrivateKeyPath, []string{"localhost", "127.0.0.1", "::1", cfg.BindAddress})
	if err != nil {
		return nil, fmt.Errorf("initialize web TLS: %w", err)
	}
	spki, err := pki.SPKIFingerprint(webCertPEM)
	if err != nil {
		return nil, err
	}
	curlPin, err := pki.CurlSPKIPin(webCertPEM)
	if err != nil {
		return nil, err
	}
	server := &Server{config: cfg, store: database, hub: events.New(database, cfg.EventBuffer), ca: ca, webCertPEM: webCertPEM, webSPKIPin: spki, webCurlPin: curlPin, logger: logger, dummyHash: dummyHash, lastSeen: make(map[string]time.Time)}
	webMux := http.NewServeMux()
	server.registerWebRoutes(webMux)
	agentMux := http.NewServeMux()
	server.registerAgentRoutes(agentMux)
	server.webServer = &http.Server{
		Addr: cfg.WebAddress(), Handler: server.securityHeaders(webMux), ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout: 30 * time.Second, WriteTimeout: 2 * time.Minute, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 1 << 20,
	}
	server.agentServer = &http.Server{
		Addr: net.JoinHostPort(cfg.BindAddress, strconv.Itoa(cfg.AgentPort)), Handler: server.securityHeaders(agentMux),
		ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 45 * time.Second, WriteTimeout: 2 * time.Minute, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 1 << 20,
	}
	return server, nil
}

// Run binds all listeners and blocks until context cancellation or a server error.
func (s *Server) Run(ctx context.Context) error {
	certificate, err := tls.LoadX509KeyPair(s.config.WebCertificatePath, s.config.WebPrivateKeyPath)
	if err != nil {
		return fmt.Errorf("load web keypair: %w", err)
	}
	clientCAs := x509.NewCertPool()
	if !clientCAs.AppendCertsFromPEM(s.ca.CertificatePEM) {
		return errors.New("load agent CA pool")
	}
	baseTLS := &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS13}
	s.webServer.TLSConfig = baseTLS.Clone()
	s.agentServer.TLSConfig = baseTLS.Clone()
	s.agentServer.TLSConfig.ClientCAs = clientCAs
	s.agentServer.TLSConfig.ClientAuth = tls.VerifyClientCertIfGiven

	errCh := make(chan error, 3)
	go func() {
		s.logger.Info("web listener starting", "address", s.webServer.Addr, "spki", s.webSPKIPin, "development_http", s.config.DevHTTP)
		var err error
		if s.config.DevHTTP {
			err = s.webServer.ListenAndServe()
		} else {
			err = s.webServer.ListenAndServeTLS("", "")
		}
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- fmt.Errorf("web listener: %w", err)
		}
	}()
	go func() {
		s.logger.Info("agent listener starting", "address", s.agentServer.Addr, "development_http", s.config.DevHTTP)
		var err error
		if s.config.DevHTTP {
			err = s.agentServer.ListenAndServe()
		} else {
			err = s.agentServer.ListenAndServeTLS("", "")
		}
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- fmt.Errorf("agent listener: %w", err)
		}
	}()
	if runtime.GOOS != "windows" {
		go func() {
			if err := s.serveControlSocket(ctx); err != nil && !errors.Is(err, http.ErrServerClosed) {
				errCh <- fmt.Errorf("control socket: %w", err)
			}
		}()
	}

	checkpoint := time.NewTicker(5 * time.Minute)
	expiry := time.NewTicker(time.Minute)
	defer checkpoint.Stop()
	defer expiry.Stop()
	for {
		select {
		case <-ctx.Done():
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			_ = s.webServer.Shutdown(shutdownCtx)
			_ = s.agentServer.Shutdown(shutdownCtx)
			return nil
		case err := <-errCh:
			return err
		case <-checkpoint.C:
			checkpointCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
			if err := s.store.Checkpoint(checkpointCtx); err != nil {
				s.logger.Warn("WAL checkpoint failed", "error", err)
			}
			cancel()
		case now := <-expiry.C:
			_, _ = s.store.ExpireEnrollments(ctx, now)
			_, _ = s.store.DeleteExpiredIdempotency(ctx, now)
		}
	}
}

func (s *Server) serveControlSocket(ctx context.Context) error {
	path := filepath.Join(s.config.RuntimeDir, "manager.sock")
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return fmt.Errorf("refusing to replace non-socket %s", path)
		}
		if err := os.Remove(path); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	listener, err := net.Listen("unix", path)
	if err != nil {
		return err
	}
	defer listener.Close()
	defer os.Remove(path)
	if err := os.Chmod(path, 0o660); err != nil {
		return err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("GET /api/v1/version", s.version)
	mux.HandleFunc("GET /api/v1/diagnostics", s.diagnostics)
	mux.HandleFunc("POST /api/v1/docker-hosts/local", s.registerLocalDocker)
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	return server.Serve(listener)
}

func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("X-Content-Type-Options", "nosniff")
		response.Header().Set("X-Frame-Options", "DENY")
		response.Header().Set("Referrer-Policy", "no-referrer")
		response.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		response.Header().Set("Content-Security-Policy", "default-src 'self'; connect-src 'self' wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'")
		if !s.config.DevHTTP {
			response.Header().Set("Strict-Transport-Security", "max-age=31536000")
		}
		next.ServeHTTP(response, request)
	})
}
