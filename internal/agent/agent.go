// Package agent implements enrollment and the resource-efficient host daemon.
package agent

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/FireStarsSoft/Bored-Manager/internal/clienttls"
	"github.com/FireStarsSoft/Bored-Manager/internal/config"
	"github.com/FireStarsSoft/Bored-Manager/internal/pki"
	"github.com/FireStarsSoft/Bored-Manager/internal/version"
)

type enrollmentCreated struct {
	ID               string    `json:"enrollment_id"`
	Status           string    `json:"state"`
	Fingerprint      string    `json:"csr_fingerprint"`
	VerificationCode string    `json:"verification_code"`
	ExpiresAt        time.Time `json:"expires_at"`
}
type enrollmentStatus struct {
	ID     string `json:"enrollment_id"`
	Status string `json:"state"`
	Agent  struct {
		ID string `json:"agent_id"`
	} `json:"agent"`
	CertificatePEM   string    `json:"certificate_chain_pem"`
	CACertificatePEM string    `json:"manager_ca_pem"`
	ExpiresAt        time.Time `json:"expires_at"`
}

type managerHTTPError struct {
	StatusCode int
	Code       string
	Message    string
}

func (e *managerHTTPError) Error() string {
	return fmt.Sprintf("manager returned HTTP %d (%s): %s", e.StatusCode, e.Code, e.Message)
}

// Daemon owns the local identity and heartbeat lifecycle.
type Daemon struct {
	config     config.AgentConfig
	logger     *slog.Logger
	privateKey ed25519.PrivateKey
}

func New(cfg config.AgentConfig, logger *slog.Logger) (*Daemon, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if logger == nil {
		logger = slog.Default()
	}
	if err := cfg.EnsureDirectories(); err != nil {
		return nil, err
	}
	key, err := loadOrCreateKey(cfg.PrivateKeyPath)
	if err != nil {
		return nil, err
	}
	return &Daemon{config: cfg, logger: logger, privateKey: key}, nil
}

// Run enrolls if necessary, then sends bounded heartbeats until cancellation.
func (d *Daemon) Run(ctx context.Context) error {
	if err := d.ensureCertificate(ctx); err != nil {
		return err
	}
	if err := d.sendHeartbeat(ctx); err != nil {
		d.logger.Warn("initial heartbeat failed", "error", err)
	}
	ticker := time.NewTicker(d.config.Heartbeat)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if err := d.sendHeartbeat(ctx); err != nil {
				d.logger.Warn("heartbeat failed", "error", err)
			}
		}
	}
}

func (d *Daemon) ensureCertificate(ctx context.Context) error {
	pendingPath := filepath.Join(d.config.StateDir, "pending-enrollment.json")
	if certificateValid(d.config.CertificatePath, d.config.PrivateKeyPath, d.config.CAPath) {
		_ = os.Remove(pendingPath)
		return nil
	}
	created, found, err := loadPendingEnrollment(pendingPath)
	if err != nil {
		return fmt.Errorf("load pending enrollment: %w", err)
	}
	if found && time.Now().After(created.ExpiresAt) {
		_ = os.Remove(pendingPath)
		found = false
	}
	if !found {
		csrPEM, err := createCSR(d.config.Name, d.privateKey)
		if err != nil {
			return err
		}
		inventory, _ := collectInventory(ctx)
		if _, err := d.postPinned(ctx, "/api/v1/enrollment-requests", map[string]any{"name": d.config.Name, "csr_pem": csrPEM, "inventory": inventory, "version": version.Version}, &created, nil); err != nil {
			return fmt.Errorf("create enrollment request: %w", err)
		}
		if err := validateCreatedEnrollment(created, csrPEM, time.Now()); err != nil {
			return fmt.Errorf("manager returned invalid enrollment metadata: %w", err)
		}
		if err := persistPendingEnrollment(pendingPath, created); err != nil {
			return fmt.Errorf("persist pending enrollment: %w", err)
		}
	} else {
		d.logger.Warn("resuming pending agent enrollment", "request_id", created.ID, "expires_at", created.ExpiresAt)
	}
	d.logger.Warn("agent awaits explicit manager approval", "request_id", created.ID, "verification_code", created.VerificationCode, "csr_fingerprint", created.Fingerprint, "expires_at", created.ExpiresAt)
	proof := base64.RawStdEncoding.EncodeToString(ed25519.Sign(d.privateKey, []byte("bored-manager enrollment status:"+created.ID)))
	for {
		if time.Now().After(created.ExpiresAt) {
			_ = os.Remove(pendingPath)
			return errors.New("enrollment request expired; restart the agent to create a new request")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(3 * time.Second):
		}
		var status enrollmentStatus
		statusCode, err := d.postPinned(ctx, "/api/v1/enrollment-requests/"+url.PathEscape(created.ID)+"/status", map[string]string{"proof": proof}, &status, nil)
		if err != nil {
			var managerError *managerHTTPError
			if errors.As(err, &managerError) {
				if managerError.Code == "enrollment_rejected" {
					_ = os.Remove(pendingPath)
					return errors.New("enrollment request was rejected")
				}
				if managerError.Code == "enrollment_expired" {
					_ = os.Remove(pendingPath)
					return errors.New("enrollment request expired")
				}
				if managerError.Code == "not_found" {
					_ = os.Remove(pendingPath)
					return errors.New("pending enrollment no longer exists on the manager")
				}
			}
			d.logger.Warn("enrollment status check failed", "error", err)
			continue
		}
		if statusCode == http.StatusAccepted {
			continue
		}
		if statusCode == http.StatusOK {
			if err := persistIdentity(d.config, status.CertificatePEM, status.CACertificatePEM); err != nil {
				return err
			}
			if err := os.Remove(pendingPath); err != nil && !errors.Is(err, os.ErrNotExist) {
				return fmt.Errorf("remove completed enrollment state: %w", err)
			}
			d.logger.Info("agent enrollment approved", "agent_id", status.Agent.ID)
			return nil
		}
		return fmt.Errorf("unexpected enrollment status response %d", statusCode)
	}
}

func validateCreatedEnrollment(created enrollmentCreated, csrPEM string, now time.Time) error {
	if created.ID == "" || created.Status != "pending_approval" {
		return errors.New("missing pending request identity")
	}
	if !created.ExpiresAt.After(now) || created.ExpiresAt.After(now.Add(15*time.Minute)) {
		return errors.New("request expiry is outside the allowed enrollment window")
	}
	block, rest := pem.Decode([]byte(csrPEM))
	if block == nil || block.Type != "CERTIFICATE REQUEST" || len(bytes.TrimSpace(rest)) != 0 {
		return errors.New("local CSR cannot be fingerprinted")
	}
	digest := sha256.Sum256(block.Bytes)
	fingerprint := pki.Fingerprint(digest[:])
	if created.Fingerprint != fingerprint || created.VerificationCode != pki.VerificationCode(fingerprint) {
		return errors.New("CSR fingerprint or verification code does not match the local key")
	}
	return nil
}

func persistPendingEnrollment(path string, enrollment enrollmentCreated) error {
	contents, err := json.Marshal(enrollment)
	if err != nil {
		return err
	}
	return atomicWrite(path, append(contents, '\n'), 0o600)
}

func loadPendingEnrollment(path string) (enrollmentCreated, bool, error) {
	contents, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return enrollmentCreated{}, false, nil
	}
	if err != nil {
		return enrollmentCreated{}, false, err
	}
	decoder := json.NewDecoder(bytes.NewReader(contents))
	decoder.DisallowUnknownFields()
	var enrollment enrollmentCreated
	if err := decoder.Decode(&enrollment); err != nil {
		return enrollmentCreated{}, false, err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return enrollmentCreated{}, false, errors.New("pending enrollment must contain one JSON object")
	}
	if enrollment.ID == "" || enrollment.Status != "pending_approval" || enrollment.Fingerprint == "" || enrollment.VerificationCode == "" || enrollment.ExpiresAt.IsZero() {
		return enrollmentCreated{}, false, errors.New("pending enrollment is incomplete")
	}
	return enrollment, true, nil
}

func (d *Daemon) sendHeartbeat(ctx context.Context) error {
	identity, err := tls.LoadX509KeyPair(d.config.CertificatePath, d.config.PrivateKeyPath)
	if err != nil {
		return err
	}
	inventory, services := collectInventory(ctx)
	metrics := collectMetrics()
	var result map[string]any
	_, err = d.postPinned(ctx, "/agent/v1/heartbeat", map[string]any{"version": version.Version, "inventory": inventory, "services": services, "metrics": metrics}, &result, &identity)
	return err
}

func (d *Daemon) postPinned(ctx context.Context, path string, input, output any, identity *tls.Certificate) (int, error) {
	body, err := json.Marshal(input)
	if err != nil {
		return 0, err
	}
	tlsConfig, err := clienttls.PinnedConfig(d.config.ManagerSPKIPin, identity)
	if err != nil {
		return 0, err
	}
	transport := &http.Transport{TLSClientConfig: tlsConfig, DisableCompression: true, ForceAttemptHTTP2: true}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 30 * time.Second}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(d.config.ManagerURL, "/")+path, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "bored-agentd/"+version.Version)
	response, err := client.Do(request)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		var problem struct {
			Code   string `json:"code"`
			Error  string `json:"error"`
			Detail string `json:"detail"`
			Title  string `json:"title"`
		}
		_ = json.Unmarshal(raw, &problem)
		message := problem.Detail
		if message == "" {
			message = problem.Error
		}
		if message == "" {
			message = problem.Title
		}
		return response.StatusCode, &managerHTTPError{StatusCode: response.StatusCode, Code: problem.Code, Message: message}
	}
	if output == nil {
		return response.StatusCode, nil
	}
	return response.StatusCode, json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(output)
}

func loadOrCreateKey(path string) (ed25519.PrivateKey, error) {
	contents, err := os.ReadFile(path)
	if err == nil {
		block, _ := pem.Decode(contents)
		if block == nil {
			return nil, errors.New("invalid agent private key PEM")
		}
		parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		if err != nil {
			return nil, err
		}
		key, ok := parsed.(ed25519.PrivateKey)
		if !ok {
			return nil, errors.New("agent key must be Ed25519")
		}
		return key, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, err
	}
	if err := atomicWrite(path, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600); err != nil {
		return nil, err
	}
	return key, nil
}

func createCSR(name string, key ed25519.PrivateKey) (string, error) {
	der, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: name, Organization: []string{"Bored Manager Agents"}}}, key)
	if err != nil {
		return "", err
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der})), nil
}

func certificateValid(certificatePath, keyPath, caPath string) bool {
	identity, err := tls.LoadX509KeyPair(certificatePath, keyPath)
	if err != nil || len(identity.Certificate) == 0 {
		return false
	}
	certificate, err := x509.ParseCertificate(identity.Certificate[0])
	if err != nil || !time.Now().Add(24*time.Hour).Before(certificate.NotAfter) {
		return false
	}
	caPEM, err := os.ReadFile(caPath)
	if err != nil {
		return false
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caPEM) {
		return false
	}
	_, err = certificate.Verify(x509.VerifyOptions{Roots: roots, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}, CurrentTime: time.Now()})
	return err == nil
}

func persistIdentity(cfg config.AgentConfig, certificatePEM, caPEM string) error {
	block, _ := pem.Decode([]byte(certificatePEM))
	if block == nil {
		return errors.New("manager returned invalid agent certificate")
	}
	certificate, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return err
	}
	key, err := loadOrCreateKey(cfg.PrivateKeyPath)
	if err != nil {
		return err
	}
	publicKey, ok := certificate.PublicKey.(ed25519.PublicKey)
	if !ok || !publicKey.Equal(key.Public()) {
		return errors.New("issued certificate does not match local private key")
	}
	caBlock, _ := pem.Decode([]byte(caPEM))
	if caBlock == nil {
		return errors.New("manager returned invalid CA certificate")
	}
	ca, err := x509.ParseCertificate(caBlock.Bytes)
	if err != nil || !ca.IsCA {
		return errors.New("manager returned invalid agent CA")
	}
	pool := x509.NewCertPool()
	pool.AddCert(ca)
	if _, err := certificate.Verify(x509.VerifyOptions{Roots: pool, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}); err != nil {
		return fmt.Errorf("verify issued certificate: %w", err)
	}
	if err := atomicWrite(cfg.CAPath, []byte(caPEM), 0o644); err != nil {
		return err
	}
	return atomicWrite(cfg.CertificatePath, []byte(certificatePEM), 0o644)
}

func atomicWrite(path string, contents []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".identity-")
	if err != nil {
		return err
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	if err := file.Chmod(mode); err == nil {
		_, err = file.Write(contents)
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(temporary, path)
}

func collectInventory(ctx context.Context) (map[string]any, []string) {
	hostname, _ := os.Hostname()
	inventory := map[string]any{"hostname": hostname, "os_release": "unknown", "architecture": runtime.GOARCH, "kernel_version": commandFirstLine(ctx, "uname", "-r"), "agent_version": version.Version, "systemd_version": commandFirstLine(ctx, "systemd", "--version"), "cpu_count": runtime.NumCPU(), "addresses": hostAddresses()}
	if contents, err := os.ReadFile("/etc/os-release"); err == nil {
		release := parseOSRelease(string(contents))
		if release["ID"] == "ubuntu" && release["VERSION_ID"] == "24.04" {
			inventory["os_release"] = "ubuntu-24.04"
		} else {
			inventory["os_release"] = release["ID"] + "-" + release["VERSION_ID"]
		}
	}
	machineID, _ := os.ReadFile("/etc/machine-id")
	if len(bytes.TrimSpace(machineID)) == 0 {
		machineID = []byte(hostname)
	}
	machineDigest := sha256.Sum256(bytes.TrimSpace(machineID))
	inventory["machine_id_hash"] = fmt.Sprintf("%x", machineDigest)
	if contents, err := os.ReadFile("/proc/meminfo"); err == nil {
		if value := firstKilobytes(string(contents), "MemTotal:"); value > 0 {
			inventory["memory_bytes"] = value * 1024
		}
	}
	if total, free, ok := diskUsage("/"); ok {
		inventory["disk_bytes"] = total
		_ = free
	}
	services := runningServices(ctx)
	return inventory, services
}

func commandFirstLine(ctx context.Context, name string, args ...string) string {
	commandCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	output, err := exec.CommandContext(commandCtx, name, args...).Output()
	if err != nil {
		return "unknown"
	}
	line, _, _ := strings.Cut(strings.TrimSpace(string(output)), "\n")
	return line
}
func hostAddresses() []string {
	interfaces, err := net.Interfaces()
	if err != nil {
		return []string{}
	}
	result := []string{}
	for _, networkInterface := range interfaces {
		addresses, _ := networkInterface.Addrs()
		for _, address := range addresses {
			value := address.String()
			if host, _, err := net.ParseCIDR(value); err == nil {
				value = host.String()
			}
			if ip := net.ParseIP(value); ip != nil && !ip.IsLoopback() {
				result = append(result, ip.String())
			}
		}
	}
	return result
}

func collectMetrics() map[string]any {
	metrics := map[string]any{"observed_at": time.Now().UTC()}
	if contents, err := os.ReadFile("/proc/loadavg"); err == nil {
		fields := strings.Fields(string(contents))
		if len(fields) >= 3 {
			metrics["load_1"], _ = strconv.ParseFloat(fields[0], 64)
			metrics["load_5"], _ = strconv.ParseFloat(fields[1], 64)
			metrics["load_15"], _ = strconv.ParseFloat(fields[2], 64)
		}
	}
	if contents, err := os.ReadFile("/proc/meminfo"); err == nil {
		total := firstKilobytes(string(contents), "MemTotal:")
		available := firstKilobytes(string(contents), "MemAvailable:")
		metrics["memory_used_bytes"] = (total - available) * 1024
	}
	return metrics
}

func runningServices(ctx context.Context) []string {
	commandCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(commandCtx, "systemctl", "list-units", "--type=service", "--state=running", "--no-legend", "--no-pager", "--plain").Output()
	if err != nil {
		return []string{}
	}
	lines := strings.Split(string(output), "\n")
	result := make([]string, 0, len(lines))
	for _, line := range lines {
		fields := strings.Fields(line)
		if len(fields) > 0 && strings.HasSuffix(fields[0], ".service") {
			result = append(result, fields[0])
			if len(result) >= 500 {
				break
			}
		}
	}
	return result
}

func parseOSRelease(contents string) map[string]string {
	result := map[string]string{}
	for _, line := range strings.Split(contents, "\n") {
		key, value, ok := strings.Cut(line, "=")
		if ok && (key == "ID" || key == "VERSION_ID" || key == "PRETTY_NAME") {
			result[key] = strings.Trim(value, "\"")
		}
	}
	return result
}
func firstKilobytes(contents, prefix string) int64 {
	for _, line := range strings.Split(contents, "\n") {
		if strings.HasPrefix(line, prefix) {
			fields := strings.Fields(line)
			if len(fields) > 1 {
				value, _ := strconv.ParseInt(fields[1], 10, 64)
				return value
			}
		}
	}
	return 0
}
