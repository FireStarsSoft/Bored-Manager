package domain

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestValidateUUIDv7(t *testing.T) {
	t.Parallel()
	for _, value := range []string{
		"01890abc-def0-7123-8123-456789abcdef",
		"ffffffff-ffff-7fff-bfff-ffffffffffff",
	} {
		if err := ValidateUUIDv7(value); err != nil {
			t.Errorf("valid UUIDv7 %q rejected: %v", value, err)
		}
	}
	for _, value := range []string{
		"01890ABC-def0-7123-8123-456789abcdef",
		"01890abc-def0-4123-8123-456789abcdef",
		"01890abc-def0-7123-7123-456789abcdef",
		"not-a-uuid",
	} {
		if err := ValidateUUIDv7(value); err == nil {
			t.Errorf("invalid UUIDv7 %q accepted", value)
		}
	}
}

func TestEnrollmentDisplayIdentifiers(t *testing.T) {
	t.Parallel()
	fingerprint := strings.TrimSuffix(strings.Repeat("AB:", 32), ":")
	if err := validateFingerprint(fingerprint); err != nil {
		t.Fatalf("canonical fingerprint rejected: %v", err)
	}
	if err := validateFingerprint(strings.ToLower(fingerprint)); err == nil {
		t.Fatal("lowercase fingerprint must be rejected to keep one display representation")
	}
	if err := validateVerificationCode("ABCD-EFGH"); err != nil {
		t.Fatalf("4-4 base32 verification code rejected: %v", err)
	}
	if err := validateVerificationCode("ABCD-EFG9"); err == nil {
		t.Fatal("non-RFC4648 base32 digit must be rejected")
	}
}

func TestEnrollmentJSONNeverReturnsCSR(t *testing.T) {
	t.Parallel()
	request := EnrollmentRequest{
		ID:     "01890abc-def0-7123-8123-456789abcdef",
		CSRPEM: "-----BEGIN CERTIFICATE REQUEST-----secret-material",
	}
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "CERTIFICATE REQUEST") || strings.Contains(string(encoded), "csr_pem") {
		t.Fatalf("enrollment response leaked CSR: %s", encoded)
	}
}

func TestObservedServiceStateAxisConsistency(t *testing.T) {
	t.Parallel()
	now := time.Now().UTC()
	state := ObservedServiceState{
		AgentID:             "01890abc-def0-7123-8123-456789abcdef",
		ServiceDefinitionID: "01890abc-def0-7456-9123-456789abcdef",
		Installation:        InstallationNotInstalled,
		Enablement:          EnablementUnknown,
		Runtime:             RuntimeActive,
		Health:              HealthHealthy,
		CheckedAt:           now,
		TransitionedAt:      now.Add(-time.Minute),
	}
	err := state.Validate()
	if err == nil || !strings.Contains(err.Error(), "runtime") || !strings.Contains(err.Error(), "health") {
		t.Fatalf("expected inconsistent axes to fail, got %v", err)
	}

	state.Installation = InstallationInstalled
	state.Enablement = EnablementEnabled
	if err := state.Validate(); err != nil {
		t.Fatalf("valid observed state rejected: %v", err)
	}
}

func TestDockerHostRequiresStrictSSHIdentity(t *testing.T) {
	t.Parallel()
	now := time.Now().UTC()
	host := DockerHost{
		ID:         "01890abc-def0-7123-8123-456789abcdef",
		Name:       "production-a",
		Transport:  DockerRemoteSSH,
		SocketPath: "/var/run/docker.sock",
		SSHAddress: "192.0.2.10",
		SSHPort:    22,
		SSHUser:    "docker-admin",
		CreatedAt:  now,
		UpdatedAt:  now,
	}
	if err := host.Validate(); err == nil || !strings.Contains(err.Error(), "ssh_host_key") {
		t.Fatalf("expected missing host key to fail, got %v", err)
	}
	host.SSHCredentialRef = "systemd-credential:ssh-prod-a"
	host.SSHHostKey = &SSHHostKey{Algorithm: "ssh-ed25519", Fingerprint: "SHA256:" + strings.Repeat("A", 43)}
	if err := host.Validate(); err != nil {
		t.Fatalf("strict remote host rejected: %v", err)
	}

	local := host
	local.Transport = DockerLocalUnix
	if err := local.Validate(); err == nil {
		t.Fatal("local transport with SSH settings must be rejected")
	}
}

func TestNetworkProfileDHCPRequiresPinnedPlugin(t *testing.T) {
	t.Parallel()
	profile := NetworkProfile{
		ID:                "01890abc-def0-7123-8123-456789abcdef",
		Name:              "dhcp-lan",
		Revision:          1,
		Mode:              NetworkDHCP,
		DockerNetworkName: "dhcp-lan",
		EndpointHardLimit: 500,
		PluginName:        "vendor/example:latest",
	}
	if err := profile.Validate(); err == nil || !strings.Contains(err.Error(), "plugin_digest") {
		t.Fatalf("expected unpinned plugin to fail, got %v", err)
	}
	profile.PluginDigest = "sha256:" + strings.Repeat("a", 64)
	if err := profile.Validate(); err != nil {
		t.Fatalf("pinned DHCP profile rejected: %v", err)
	}
}

func TestTemplateRevisionRejectsSYSADMIN(t *testing.T) {
	t.Parallel()
	revision := TemplateRevision{
		ID:                   "01890abc-def0-7123-8123-456789abcdef",
		TemplateID:           "01890abc-def0-7456-9123-456789abcdef",
		Revision:             1,
		BaseImage:            "ubuntu:24.04",
		BaseImageDigest:      "sha256:" + strings.Repeat("b", 64),
		CPUQuota:             1,
		MemoryBytes:          128 * 1024 * 1024,
		PidsLimit:            128,
		RequiredCapabilities: []string{"CHOWN", "SYS_ADMIN"},
		PublishedAt:          time.Now().UTC(),
	}
	if err := revision.Validate(); err == nil || !strings.Contains(err.Error(), "SYS_ADMIN") {
		t.Fatalf("expected forbidden capability to fail, got %v", err)
	}
	revision.RequiredCapabilities = []string{"CHOWN"}
	if err := revision.Validate(); err != nil {
		t.Fatalf("least-privilege template rejected: %v", err)
	}
}
