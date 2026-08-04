// Package dockerconnector probes Docker Engines without requiring Docker CLI.
package dockerconnector

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

// Probe is the non-secret result of checking an Engine endpoint.
type Probe struct {
	Available     bool   `json:"available"`
	Status        string `json:"status"`
	ServerVersion string `json:"server_version,omitempty"`
	APIVersion    string `json:"api_version,omitempty"`
	OS            string `json:"os,omitempty"`
	Architecture  string `json:"architecture,omitempty"`
	Error         string `json:"error,omitempty"`
}

// SSHTarget is a fully validated, non-secret SSH connection description. The
// identity file is a systemd credential path, never key material from an API.
type SSHTarget struct {
	User         string
	Address      string
	Port         int
	IdentityFile string
}

// Validate rejects values that could be interpreted as OpenSSH options or
// that depend on implicit client configuration.
func (t SSHTarget) Validate() error {
	if !validSSHUser(t.User) {
		return errors.New("invalid SSH user")
	}
	if !validSSHAddress(t.Address) {
		return errors.New("invalid SSH address")
	}
	if t.Port < 1 || t.Port > 65535 {
		return errors.New("invalid SSH port")
	}
	if !filepath.IsAbs(t.IdentityFile) {
		return errors.New("SSH identity must be an absolute systemd credential path")
	}
	info, err := os.Lstat(t.IdentityFile)
	if err != nil {
		return fmt.Errorf("inspect SSH identity credential: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("SSH identity credential must be a regular non-symlink file")
	}
	return nil
}

func validSSHUser(value string) bool {
	if value == "" || len(value) > 128 || strings.HasPrefix(value, "-") {
		return false
	}
	for index, character := range value {
		if !(character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9' || index > 0 && (character == '_' || character == '-')) {
			return false
		}
	}
	return true
}

func validSSHAddress(value string) bool {
	if value == "" || len(value) > 253 || strings.HasPrefix(value, "-") || strings.ContainsAny(value, "@/\\% \t\r\n") {
		return false
	}
	if net.ParseIP(value) != nil {
		return true
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

// ProbeLocal talks directly to the Engine HTTP API over a Unix socket.
func ProbeLocal(ctx context.Context, socketPath string) Probe {
	if runtime.GOOS == "windows" {
		return Probe{Status: "unavailable", Error: "Unix Docker sockets are supported only on Linux"}
	}
	if info, err := os.Stat(socketPath); err != nil {
		return Probe{Status: "unavailable", Error: err.Error()}
	} else if info.Mode()&os.ModeSocket == 0 {
		return Probe{Status: "unavailable", Error: "path is not a Unix socket"}
	}
	transport := &http.Transport{
		DisableCompression: true,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, "unix", socketPath)
		},
	}
	client := &http.Client{Transport: transport, Timeout: 5 * time.Second}
	defer transport.CloseIdleConnections()
	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker/_ping", nil)
	response, err := client.Do(request)
	if err != nil {
		return Probe{Status: "unavailable", Error: err.Error()}
	}
	body, _ := io.ReadAll(io.LimitReader(response.Body, 64))
	response.Body.Close()
	if response.StatusCode != http.StatusOK || strings.TrimSpace(string(body)) != "OK" {
		return Probe{Status: "unavailable", Error: fmt.Sprintf("Docker _ping returned %s", response.Status)}
	}
	request, _ = http.NewRequestWithContext(ctx, http.MethodGet, "http://docker/version", nil)
	response, err = client.Do(request)
	if err != nil {
		return Probe{Status: "unavailable", Error: err.Error()}
	}
	defer response.Body.Close()
	var version struct {
		Version    string
		APIVersion string
		Os         string
		Arch       string
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&version) != nil {
		return Probe{Available: true, Status: "reachable", Error: "Docker version metadata was unavailable"}
	}
	return Probe{Available: true, Status: "healthy", ServerVersion: version.Version, APIVersion: version.APIVersion, OS: version.Os, Architecture: version.Arch}
}

// HostKey is public key metadata extracted from an exact known_hosts line.
type HostKey struct {
	Algorithm   string
	Fingerprint string
}

// ParseKnownHostLine validates caller-supplied known_hosts material. The key
// is never learned on first use.
func ParseKnownHostLine(line string) (HostKey, error) {
	if strings.ContainsAny(line, "\r\n\x00") {
		return HostKey{}, errors.New("expected exactly one OpenSSH known_hosts line")
	}
	fields := strings.Fields(strings.TrimSpace(line))
	if len(fields) < 3 || strings.HasPrefix(fields[0], "#") {
		return HostKey{}, errors.New("expected one OpenSSH known_hosts line")
	}
	publicKey, _, _, _, err := ssh.ParseAuthorizedKey([]byte(strings.Join(fields[1:], " ")))
	if err != nil {
		return HostKey{}, fmt.Errorf("parse SSH host key: %w", err)
	}
	algorithm := publicKey.Type()
	if algorithm == ssh.KeyAlgoRSA {
		algorithm = ssh.KeyAlgoRSASHA512
	}
	if algorithm != ssh.KeyAlgoED25519 && algorithm != ssh.KeyAlgoECDSA256 && algorithm != ssh.KeyAlgoRSASHA512 {
		return HostKey{}, fmt.Errorf("unsupported SSH host-key algorithm %q", algorithm)
	}
	return HostKey{Algorithm: algorithm, Fingerprint: ssh.FingerprintSHA256(publicKey)}, nil
}

// ValidateKnownHostLine returns the fingerprint for legacy callers.
func ValidateKnownHostLine(line string) (string, error) {
	key, err := ParseKnownHostLine(line)
	return key.Fingerprint, err
}

// WriteKnownHost atomically creates a private host-specific known_hosts file.
func WriteKnownHost(directory, hostID, line string) (string, string, error) {
	fingerprint, err := ValidateKnownHostLine(line)
	if err != nil {
		return "", "", err
	}
	if strings.ContainsAny(hostID, `/\\`) || hostID == "" {
		return "", "", errors.New("invalid host ID")
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", "", err
	}
	path := filepath.Join(directory, hostID+".known_hosts")
	temporary, err := os.CreateTemp(directory, ".known-host-")
	if err != nil {
		return "", "", err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err == nil {
		_, err = temporary.WriteString(strings.TrimSpace(line) + "\n")
	}
	closeErr := temporary.Close()
	if err != nil {
		return "", "", err
	}
	if closeErr != nil {
		return "", "", closeErr
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return "", "", err
	}
	return path, fingerprint, nil
}

// ProbeSSH invokes the system OpenSSH client with an explicit credential,
// strict host-key checking, disabled password/agent authentication, and no
// client configuration files or forwarding.
func ProbeSSH(ctx context.Context, target SSHTarget, knownHostsPath string) Probe {
	if err := target.Validate(); err != nil {
		return Probe{Status: "unavailable", Error: err.Error()}
	}
	if !filepath.IsAbs(knownHostsPath) {
		return Probe{Status: "unavailable", Error: "known_hosts path must be absolute"}
	}
	sshAddress := target.Address
	if ip := net.ParseIP(target.Address); ip != nil && ip.To4() == nil {
		sshAddress = "[" + target.Address + "]"
	}
	destination := target.User + "@" + sshAddress
	command := exec.CommandContext(ctx, "ssh",
		"-F", "/dev/null",
		"-o", "BatchMode=yes",
		"-o", "StrictHostKeyChecking=yes",
		"-o", "UserKnownHostsFile="+knownHostsPath,
		"-o", "GlobalKnownHostsFile=/dev/null",
		"-o", "IdentitiesOnly=yes",
		"-o", "IdentityAgent=none",
		"-o", "PasswordAuthentication=no",
		"-o", "KbdInteractiveAuthentication=no",
		"-o", "ForwardAgent=no",
		"-o", "ClearAllForwardings=yes",
		"-o", "PermitLocalCommand=no",
		"-o", "ConnectTimeout=5",
		"-i", target.IdentityFile,
		"-p", strconv.Itoa(target.Port),
		destination, "docker --host unix:///var/run/docker.sock version --format '{{json .Server}}'")
	output, err := command.Output()
	if err != nil {
		message := err.Error()
		if exitErr, ok := err.(*exec.ExitError); ok {
			message = strings.TrimSpace(string(exitErr.Stderr))
			if message == "" {
				message = exitErr.Error()
			}
		}
		return Probe{Status: "unavailable", Error: message}
	}
	var server struct {
		Version    string
		APIVersion string
		Os         string
		Arch       string
	}
	if err := json.Unmarshal(output, &server); err != nil {
		return Probe{Available: true, Status: "reachable", Error: "invalid Docker version response"}
	}
	return Probe{Available: true, Status: "healthy", ServerVersion: server.Version, APIVersion: server.APIVersion, OS: server.Os, Architecture: server.Arch}
}
