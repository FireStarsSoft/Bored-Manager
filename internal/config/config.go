// Package config contains environment-backed runtime configuration.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// ManagerConfig configures bored-managerd.
type ManagerConfig struct {
	BindAddress        string        `json:"bind_address"`
	WebPort            int           `json:"web_port"`
	AgentPort          int           `json:"agent_port"`
	StateDir           string        `json:"state_dir"`
	CacheDir           string        `json:"cache_dir"`
	RuntimeDir         string        `json:"runtime_dir"`
	WebDir             string        `json:"web_dir"`
	DatabasePath       string        `json:"database_path"`
	WebCertificatePath string        `json:"web_certificate_path"`
	WebPrivateKeyPath  string        `json:"web_private_key_path"`
	AgentCAPath        string        `json:"agent_ca_path"`
	AgentCAKeyPath     string        `json:"agent_ca_key_path"`
	CredentialsDir     string        `json:"-"`
	SessionIdle        time.Duration `json:"session_idle_nanoseconds"`
	SessionLifetime    time.Duration `json:"session_lifetime_nanoseconds"`
	DatabaseLimitBytes int64         `json:"database_limit_bytes"`
	EventBuffer        int           `json:"event_buffer"`
	DevHTTP            bool          `json:"dev_http"`
}

// LoadManager overlays an optional JSON file, then environment variables, on
// safe defaults. Environment variables always win.
func LoadManager() (ManagerConfig, error) {
	config := DefaultManager()
	if path := strings.TrimSpace(os.Getenv("BORED_MANAGER_CONFIG")); path != "" {
		contents, err := os.ReadFile(path)
		if err != nil {
			return ManagerConfig{}, fmt.Errorf("read manager config: %w", err)
		}
		if err := json.Unmarshal(contents, &config); err != nil {
			return ManagerConfig{}, fmt.Errorf("parse manager config: %w", err)
		}
		applyManagerEnvironment(&config)
	}
	return config, config.Validate()
}

// AgentConfig configures the root-running bored-agentd daemon. Enrollment
// pins are public trust material and may be stored in this root-owned file;
// private keys are generated locally and never leave StateDir.
type AgentConfig struct {
	ManagerURL      string        `json:"manager_url"`
	ManagerSPKIPin  string        `json:"manager_spki_pin"`
	Name            string        `json:"name"`
	StateDir        string        `json:"state_dir"`
	CertificatePath string        `json:"certificate_path"`
	PrivateKeyPath  string        `json:"private_key_path"`
	CAPath          string        `json:"ca_path"`
	Heartbeat       time.Duration `json:"-"`
}

// DefaultManager returns safe first-run defaults. The loopback bind is
// intentionally changed only by the authenticated setup flow.
func DefaultManager() ManagerConfig {
	state := envOr("BORED_MANAGER_STATE_DIR", "/var/lib/bored-manager")
	cache := envOr("BORED_MANAGER_CACHE_DIR", "/var/cache/bored-manager")
	runtimeDir := envOr("BORED_MANAGER_RUNTIME_DIR", "/run/bored-manager")
	return ManagerConfig{
		BindAddress:        envOr("BORED_MANAGER_BIND", "127.0.0.1"),
		WebPort:            envInt("BORED_MANAGER_WEB_PORT", 8443),
		AgentPort:          envInt("BORED_MANAGER_AGENT_PORT", 9443),
		StateDir:           state,
		CacheDir:           cache,
		RuntimeDir:         runtimeDir,
		WebDir:             envOr("BORED_MANAGER_WEB_DIR", "/usr/share/bored-manager/web"),
		DatabasePath:       envOr("BORED_MANAGER_DATABASE", filepath.Join(state, "manager.db")),
		WebCertificatePath: envOr("BORED_MANAGER_WEB_CERT", filepath.Join(state, "pki", "web.crt")),
		WebPrivateKeyPath:  envOr("BORED_MANAGER_WEB_KEY", filepath.Join(state, "pki", "web.key")),
		AgentCAPath:        envOr("BORED_MANAGER_AGENT_CA", filepath.Join(state, "pki", "agent-ca.crt")),
		AgentCAKeyPath:     envOr("BORED_MANAGER_AGENT_CA_KEY", credentialOr("agent-ca.key", filepath.Join(state, "pki", "agent-ca.key"))),
		CredentialsDir:     strings.TrimSpace(os.Getenv("CREDENTIALS_DIRECTORY")),
		SessionIdle:        envDuration("BORED_MANAGER_SESSION_IDLE", 30*time.Minute),
		SessionLifetime:    envDuration("BORED_MANAGER_SESSION_LIFETIME", 12*time.Hour),
		DatabaseLimitBytes: envInt64("BORED_MANAGER_DATABASE_LIMIT", 10<<30),
		EventBuffer:        envInt("BORED_MANAGER_EVENT_BUFFER", 1024),
		DevHTTP:            envBool("BORED_MANAGER_DEV_HTTP", false),
	}
}

// Validate rejects unsafe or internally inconsistent manager configuration.
func (c ManagerConfig) Validate() error {
	if net.ParseIP(c.BindAddress) == nil {
		return fmt.Errorf("invalid bind address %q", c.BindAddress)
	}
	if c.WebPort < 1024 || c.WebPort > 65535 || c.AgentPort < 1024 || c.AgentPort > 65535 {
		return errors.New("ports must be between 1024 and 65535")
	}
	if c.WebPort == c.AgentPort {
		return errors.New("web and agent ports must differ")
	}
	if c.SessionIdle <= 0 || c.SessionLifetime < c.SessionIdle {
		return errors.New("invalid session durations")
	}
	if c.DatabaseLimitBytes < 64<<20 {
		return errors.New("database limit must be at least 64 MiB")
	}
	if c.EventBuffer < 16 || c.EventBuffer > 4095 {
		return errors.New("event buffer must be between 16 and 4095 entries")
	}
	if c.CredentialsDir != "" && !filepath.IsAbs(c.CredentialsDir) {
		return errors.New("systemd credentials directory must be absolute")
	}
	return nil
}

// EnsureDirectories creates private runtime directories without broadening
// permissions on an existing installation.
func (c ManagerConfig) EnsureDirectories() error {
	for _, path := range []string{c.StateDir, c.CacheDir, c.RuntimeDir, filepath.Dir(c.WebCertificatePath), filepath.Dir(c.AgentCAPath)} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			return fmt.Errorf("create %s: %w", path, err)
		}
	}
	return nil
}

func (c ManagerConfig) WebAddress() string {
	return net.JoinHostPort(c.BindAddress, strconv.Itoa(c.WebPort))
}

// CredentialPath resolves a public credential reference only within the
// systemd-provided credentials directory. It never falls back to a home or
// state directory for SSH private keys.
func (c ManagerConfig) CredentialPath(reference string) (string, error) {
	if c.CredentialsDir == "" {
		return "", errors.New("systemd credentials are not configured")
	}
	if reference == "" || len(reference) > 128 || filepath.Base(reference) != reference || strings.Contains(reference, "..") {
		return "", errors.New("invalid systemd credential reference")
	}
	for _, character := range reference {
		if !(character == '.' || character == '_' || character == '-' || character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9') {
			return "", errors.New("invalid systemd credential reference")
		}
	}
	return filepath.Join(c.CredentialsDir, reference), nil
}

// DefaultAgent returns the packaged agent paths and a 15-second heartbeat.
func DefaultAgent() AgentConfig {
	state := envOr("BORED_AGENT_STATE_DIR", "/var/lib/bored-manager-agent")
	name, _ := os.Hostname()
	return AgentConfig{
		ManagerURL:      envOr("BORED_AGENT_MANAGER_URL", ""),
		ManagerSPKIPin:  envOr("BORED_AGENT_MANAGER_SPKI_PIN", ""),
		Name:            envOr("BORED_AGENT_NAME", name),
		StateDir:        state,
		CertificatePath: envOr("BORED_AGENT_CERT", filepath.Join(state, "identity.crt")),
		PrivateKeyPath:  envOr("BORED_AGENT_KEY", filepath.Join(state, "identity.key")),
		CAPath:          envOr("BORED_AGENT_CA", filepath.Join(state, "manager-ca.crt")),
		Heartbeat:       envDuration("BORED_AGENT_HEARTBEAT", 15*time.Second),
	}
}

// LoadAgent overlays an optional root-owned JSON file and then applies env.
func LoadAgent() (AgentConfig, error) {
	config := DefaultAgent()
	if path := strings.TrimSpace(os.Getenv("BORED_AGENT_CONFIG")); path != "" {
		contents, err := os.ReadFile(path)
		if err != nil {
			return AgentConfig{}, fmt.Errorf("read agent config: %w", err)
		}
		if err := json.Unmarshal(contents, &config); err != nil {
			return AgentConfig{}, fmt.Errorf("parse agent config: %w", err)
		}
		applyAgentEnvironment(&config)
	}
	return config, config.Validate()
}

func (c AgentConfig) Validate() error {
	if strings.TrimSpace(c.ManagerURL) == "" {
		return errors.New("manager URL is required")
	}
	if !strings.HasPrefix(c.ManagerURL, "https://") {
		return errors.New("manager URL must use HTTPS")
	}
	if strings.TrimSpace(c.ManagerSPKIPin) == "" {
		return errors.New("manager SPKI pin is required")
	}
	if strings.TrimSpace(c.Name) == "" {
		return errors.New("agent name is required")
	}
	if c.Heartbeat < 5*time.Second || c.Heartbeat > 5*time.Minute {
		return errors.New("heartbeat must be between 5 seconds and 5 minutes")
	}
	return nil
}

func (c AgentConfig) EnsureDirectories() error {
	return os.MkdirAll(c.StateDir, 0o700)
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func envInt(name string, fallback int) int {
	value, err := strconv.Atoi(os.Getenv(name))
	if err != nil {
		return fallback
	}
	return value
}

func envInt64(name string, fallback int64) int64 {
	value, err := strconv.ParseInt(os.Getenv(name), 10, 64)
	if err != nil {
		return fallback
	}
	return value
}

func envBool(name string, fallback bool) bool {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func envDuration(name string, fallback time.Duration) time.Duration {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func credentialOr(name, fallback string) string {
	if directory := strings.TrimSpace(os.Getenv("CREDENTIALS_DIRECTORY")); directory != "" {
		path := filepath.Join(directory, name)
		if _, err := os.Stat(path); err == nil {
			return path
		}
	}
	return fallback
}

func applyManagerEnvironment(config *ManagerConfig) {
	if value, ok := os.LookupEnv("BORED_MANAGER_BIND"); ok {
		config.BindAddress = value
	}
	if _, ok := os.LookupEnv("BORED_MANAGER_WEB_PORT"); ok {
		config.WebPort = envInt("BORED_MANAGER_WEB_PORT", config.WebPort)
	}
	if _, ok := os.LookupEnv("BORED_MANAGER_AGENT_PORT"); ok {
		config.AgentPort = envInt("BORED_MANAGER_AGENT_PORT", config.AgentPort)
	}
	if value, ok := os.LookupEnv("BORED_MANAGER_STATE_DIR"); ok {
		config.StateDir = value
	}
	if value, ok := os.LookupEnv("BORED_MANAGER_CACHE_DIR"); ok {
		config.CacheDir = value
	}
	if value, ok := os.LookupEnv("BORED_MANAGER_RUNTIME_DIR"); ok {
		config.RuntimeDir = value
	}
	if value, ok := os.LookupEnv("BORED_MANAGER_WEB_DIR"); ok {
		config.WebDir = value
	}
	if value, ok := os.LookupEnv("BORED_MANAGER_DATABASE"); ok {
		config.DatabasePath = value
	}
	if value, ok := os.LookupEnv("BORED_MANAGER_WEB_CERT"); ok {
		config.WebCertificatePath = value
	}
	if value, ok := os.LookupEnv("BORED_MANAGER_WEB_KEY"); ok {
		config.WebPrivateKeyPath = value
	}
	if value, ok := os.LookupEnv("BORED_MANAGER_AGENT_CA"); ok {
		config.AgentCAPath = value
	}
	if value, ok := os.LookupEnv("BORED_MANAGER_AGENT_CA_KEY"); ok {
		config.AgentCAKeyPath = value
	}
	if _, ok := os.LookupEnv("BORED_MANAGER_SESSION_IDLE"); ok {
		config.SessionIdle = envDuration("BORED_MANAGER_SESSION_IDLE", config.SessionIdle)
	}
	if _, ok := os.LookupEnv("BORED_MANAGER_SESSION_LIFETIME"); ok {
		config.SessionLifetime = envDuration("BORED_MANAGER_SESSION_LIFETIME", config.SessionLifetime)
	}
	if _, ok := os.LookupEnv("BORED_MANAGER_DATABASE_LIMIT"); ok {
		config.DatabaseLimitBytes = envInt64("BORED_MANAGER_DATABASE_LIMIT", config.DatabaseLimitBytes)
	}
	if _, ok := os.LookupEnv("BORED_MANAGER_EVENT_BUFFER"); ok {
		config.EventBuffer = envInt("BORED_MANAGER_EVENT_BUFFER", config.EventBuffer)
	}
	if _, ok := os.LookupEnv("BORED_MANAGER_DEV_HTTP"); ok {
		config.DevHTTP = envBool("BORED_MANAGER_DEV_HTTP", config.DevHTTP)
	}
}

func applyAgentEnvironment(config *AgentConfig) {
	if value, ok := os.LookupEnv("BORED_AGENT_MANAGER_URL"); ok {
		config.ManagerURL = value
	}
	if value, ok := os.LookupEnv("BORED_AGENT_MANAGER_SPKI_PIN"); ok {
		config.ManagerSPKIPin = value
	}
	if value, ok := os.LookupEnv("BORED_AGENT_NAME"); ok {
		config.Name = value
	}
	if value, ok := os.LookupEnv("BORED_AGENT_STATE_DIR"); ok {
		config.StateDir = value
	}
	if value, ok := os.LookupEnv("BORED_AGENT_CERT"); ok {
		config.CertificatePath = value
	}
	if value, ok := os.LookupEnv("BORED_AGENT_KEY"); ok {
		config.PrivateKeyPath = value
	}
	if value, ok := os.LookupEnv("BORED_AGENT_CA"); ok {
		config.CAPath = value
	}
	if _, ok := os.LookupEnv("BORED_AGENT_HEARTBEAT"); ok {
		config.Heartbeat = envDuration("BORED_AGENT_HEARTBEAT", config.Heartbeat)
	}
}
