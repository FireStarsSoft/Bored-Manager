package domain

import (
	"fmt"
	"net"
	"time"
)

type SSHHostKey struct {
	Algorithm   string `json:"algorithm"`
	Fingerprint string `json:"fingerprint"`
}

type DockerHost struct {
	ID                   string          `json:"docker_host_id"`
	Name                 string          `json:"name"`
	Transport            DockerTransport `json:"transport"`
	SocketPath           string          `json:"socket_path"`
	SSHAddress           string          `json:"ssh_address,omitempty"`
	SSHPort              uint16          `json:"ssh_port,omitempty"`
	SSHUser              string          `json:"ssh_user,omitempty"`
	SSHCredentialRef     string          `json:"ssh_credential_ref,omitempty"`
	SSHHostKey           *SSHHostKey     `json:"ssh_host_key,omitempty"`
	DockerVersion        string          `json:"docker_version,omitempty"`
	DockerAPIVersion     string          `json:"docker_api_version,omitempty"`
	Architecture         string          `json:"architecture,omitempty"`
	OSRelease            string          `json:"os_release,omitempty"`
	Healthy              bool            `json:"healthy"`
	LastPreflightAt      *time.Time      `json:"last_preflight_at,omitempty"`
	LastPreflightProblem *Problem        `json:"last_preflight_problem,omitempty"`
	CreatedAt            time.Time       `json:"created_at"`
	UpdatedAt            time.Time       `json:"updated_at"`
}

func (h DockerHost) Validate() error {
	validation := new(ValidationError)
	if err := ValidateUUIDv7(h.ID); err != nil {
		validation.add("docker_host_id", err.Error())
	}
	if err := validateName(h.Name, 128); err != nil {
		validation.add("name", err.Error())
	}
	if err := h.Transport.Validate(); err != nil {
		validation.add("transport", err.Error())
	}
	if h.SocketPath == "" || h.SocketPath[0] != '/' {
		validation.add("socket_path", "must be an absolute Unix socket path")
	}
	if h.Transport == DockerLocalUnix {
		if h.SSHAddress != "" || h.SSHPort != 0 || h.SSHUser != "" || h.SSHCredentialRef != "" || h.SSHHostKey != nil {
			validation.add("ssh_address", "SSH settings must be absent for local_unix")
		}
	} else if h.Transport == DockerRemoteSSH {
		if err := validateRequired(h.SSHAddress); err != nil {
			validation.add("ssh_address", err.Error())
		}
		if h.SSHPort == 0 {
			validation.add("ssh_port", "must be between 1 and 65535")
		}
		if err := validateRequired(h.SSHUser); err != nil {
			validation.add("ssh_user", err.Error())
		}
		if err := validateRequired(h.SSHCredentialRef); err != nil {
			validation.add("ssh_credential_ref", err.Error())
		}
		if h.SSHHostKey == nil {
			validation.add("ssh_host_key", "a pinned host key is required")
		} else {
			switch h.SSHHostKey.Algorithm {
			case "ssh-ed25519", "ecdsa-sha2-nistp256", "rsa-sha2-512":
			default:
				validation.add("ssh_host_key.algorithm", "must be an approved strong host-key algorithm")
			}
			if err := validateSSHHostKeyFingerprint(h.SSHHostKey.Fingerprint); err != nil {
				validation.add("ssh_host_key.fingerprint", err.Error())
			}
		}
	}
	if err := validateTimestamp(h.CreatedAt); err != nil {
		validation.add("created_at", err.Error())
	}
	if err := validateTimestamp(h.UpdatedAt); err != nil {
		validation.add("updated_at", err.Error())
	} else if h.UpdatedAt.Before(h.CreatedAt) {
		validation.add("updated_at", "must not precede created_at")
	}
	return validation.errOrNil()
}

type NetworkProfile struct {
	ID                string      `json:"network_profile_id"`
	Name              string      `json:"name"`
	Revision          uint32      `json:"revision"`
	Mode              NetworkMode `json:"mode"`
	DockerHostID      string      `json:"docker_host_id,omitempty"`
	DockerNetworkName string      `json:"docker_network_name"`
	Subnet            string      `json:"subnet,omitempty"`
	Gateway           string      `json:"gateway,omitempty"`
	IPRange           string      `json:"ip_range,omitempty"`
	ParentInterface   string      `json:"parent_interface,omitempty"`
	PluginName        string      `json:"plugin_name,omitempty"`
	PluginDigest      string      `json:"plugin_digest,omitempty"`
	EndpointHardLimit uint32      `json:"endpoint_hard_limit"`
	PublishedAt       *time.Time  `json:"published_at,omitempty"`
}

func (n NetworkProfile) Validate() error {
	validation := new(ValidationError)
	if err := ValidateUUIDv7(n.ID); err != nil {
		validation.add("network_profile_id", err.Error())
	}
	if err := validateName(n.Name, 128); err != nil {
		validation.add("name", err.Error())
	}
	if n.Revision == 0 {
		validation.add("revision", "must be at least 1")
	}
	if err := n.Mode.Validate(); err != nil {
		validation.add("mode", err.Error())
	}
	if err := ValidateSlug(n.DockerNetworkName); err != nil {
		validation.add("docker_network_name", err.Error())
	}
	if n.EndpointHardLimit == 0 || n.EndpointHardLimit > 800 {
		validation.add("endpoint_hard_limit", "must be between 1 and 800")
	}
	if n.Subnet != "" {
		if err := validateCIDR(n.Subnet); err != nil {
			validation.add("subnet", err.Error())
		}
	}
	if n.IPRange != "" {
		if err := validateCIDR(n.IPRange); err != nil {
			validation.add("ip_range", err.Error())
		} else if n.Subnet != "" {
			_, subnet, _ := net.ParseCIDR(n.Subnet)
			rangeIP, _, _ := net.ParseCIDR(n.IPRange)
			if subnet != nil && !subnet.Contains(rangeIP) {
				validation.add("ip_range", "must be contained by subnet")
			}
		}
	}
	if n.Gateway != "" {
		if err := validateIP(n.Gateway); err != nil {
			validation.add("gateway", err.Error())
		} else if n.Subnet != "" {
			_, subnet, _ := net.ParseCIDR(n.Subnet)
			if subnet != nil && !subnet.Contains(net.ParseIP(n.Gateway)) {
				validation.add("gateway", "must belong to subnet")
			}
		}
	}
	if n.Mode == NetworkMacvlan || n.Mode == NetworkIPvlan {
		if err := validateRequired(n.ParentInterface); err != nil {
			validation.add("parent_interface", err.Error())
		}
	}
	if n.Mode == NetworkDHCP {
		if err := validateRequired(n.PluginName); err != nil {
			validation.add("plugin_name", err.Error())
		}
		if err := ValidateSHA256Digest(n.PluginDigest); err != nil {
			validation.add("plugin_digest", err.Error())
		}
	}
	if (n.Mode == NetworkStatic || n.Mode == NetworkMacvlan || n.Mode == NetworkIPvlan) && n.Subnet == "" {
		validation.add("subnet", "is required for static_pool, macvlan, and ipvlan")
	}
	return validation.errOrNil()
}

type IPReservation struct {
	ID                string     `json:"ip_reservation_id"`
	NetworkProfileID  string     `json:"network_profile_id"`
	LogicalInstanceID string     `json:"logical_instance_id"`
	Address           string     `json:"address"`
	MACAddress        string     `json:"mac_address,omitempty"`
	AcquiredAt        time.Time  `json:"acquired_at"`
	ReleasedAt        *time.Time `json:"released_at,omitempty"`
}

type Template struct {
	ID              string    `json:"template_id"`
	Key             string    `json:"key"`
	DisplayName     string    `json:"display_name"`
	CurrentRevision uint32    `json:"current_revision"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

type TemplateRevision struct {
	ID                     string            `json:"template_revision_id"`
	TemplateID             string            `json:"template_id"`
	Revision               uint32            `json:"revision"`
	BaseImage              string            `json:"base_image"`
	BaseImageDigest        string            `json:"base_image_digest"`
	DerivedImageDigest     string            `json:"derived_image_digest,omitempty"`
	CPUQuota               float64           `json:"cpu_quota"`
	MemoryBytes            uint64            `json:"memory_bytes"`
	PidsLimit              int64             `json:"pids_limit"`
	Environment            map[string]string `json:"environment,omitempty"`
	ServiceRevisionIDs     []string          `json:"service_revision_ids"`
	NetworkProfileIDs      []string          `json:"network_profile_ids"`
	RequiredCapabilities   []string          `json:"required_capabilities,omitempty"`
	ReadOnlyRootFilesystem bool              `json:"read_only_root_filesystem"`
	PublishedAt            time.Time         `json:"published_at"`
}

func (t TemplateRevision) Validate() error {
	validation := new(ValidationError)
	if err := ValidateUUIDv7(t.ID); err != nil {
		validation.add("template_revision_id", err.Error())
	}
	if err := ValidateUUIDv7(t.TemplateID); err != nil {
		validation.add("template_id", err.Error())
	}
	if t.Revision == 0 {
		validation.add("revision", "must be at least 1")
	}
	if err := validateRequired(t.BaseImage); err != nil {
		validation.add("base_image", err.Error())
	}
	if err := ValidateSHA256Digest(t.BaseImageDigest); err != nil {
		validation.add("base_image_digest", err.Error())
	}
	if t.DerivedImageDigest != "" {
		if err := ValidateSHA256Digest(t.DerivedImageDigest); err != nil {
			validation.add("derived_image_digest", err.Error())
		}
	}
	if t.CPUQuota <= 0 {
		validation.add("cpu_quota", "must be greater than zero")
	}
	if t.MemoryBytes < 64*1024*1024 {
		validation.add("memory_bytes", "must be at least 64 MiB")
	}
	if t.PidsLimit < 16 {
		validation.add("pids_limit", "must be at least 16")
	}
	seenCapabilities := make(map[string]struct{}, len(t.RequiredCapabilities))
	for index, capability := range t.RequiredCapabilities {
		if capability == "SYS_ADMIN" || capability == "CAP_SYS_ADMIN" {
			validation.add(fmt.Sprintf("required_capabilities[%d]", index), "CAP_SYS_ADMIN is forbidden")
		}
		if _, exists := seenCapabilities[capability]; exists {
			validation.add(fmt.Sprintf("required_capabilities[%d]", index), "must be unique")
		}
		seenCapabilities[capability] = struct{}{}
	}
	for index, id := range t.ServiceRevisionIDs {
		if err := ValidateUUIDv7(id); err != nil {
			validation.add(fmt.Sprintf("service_revision_ids[%d]", index), err.Error())
		}
	}
	for index, id := range t.NetworkProfileIDs {
		if err := ValidateUUIDv7(id); err != nil {
			validation.add(fmt.Sprintf("network_profile_ids[%d]", index), err.Error())
		}
	}
	if err := validateTimestamp(t.PublishedAt); err != nil {
		validation.add("published_at", err.Error())
	}
	return validation.errOrNil()
}

type ReleaseArtifact struct {
	Name      string `json:"name"`
	MediaType string `json:"media_type"`
	Size      uint64 `json:"size"`
	SHA256    string `json:"sha256"`
	Signature string `json:"signature,omitempty"`
	URL       string `json:"url"`
}

type Release struct {
	ID                  string            `json:"release_id"`
	Version             string            `json:"version"`
	Channel             ReleaseChannel    `json:"channel"`
	ProtocolVersion     string            `json:"protocol_version"`
	MinimumAgentVersion string            `json:"minimum_agent_version"`
	ManifestVersion     uint32            `json:"manifest_version"`
	ManifestSHA256      string            `json:"manifest_sha256"`
	Artifacts           []ReleaseArtifact `json:"artifacts"`
	PublishedAt         time.Time         `json:"published_at"`
}

func (r Release) Validate() error {
	validation := new(ValidationError)
	if err := ValidateUUIDv7(r.ID); err != nil {
		validation.add("release_id", err.Error())
	}
	if !semverPattern.MatchString(r.Version) {
		validation.add("version", "must be a semantic version")
	}
	if err := r.Channel.Validate(); err != nil {
		validation.add("channel", err.Error())
	}
	if r.ManifestVersion != 1 {
		validation.add("manifest_version", "must be 1")
	}
	if err := ValidateSHA256Digest(r.ManifestSHA256); err != nil {
		validation.add("manifest_sha256", err.Error())
	}
	if len(r.Artifacts) == 0 {
		validation.add("artifacts", "must not be empty")
	}
	seenArtifacts := make(map[string]struct{}, len(r.Artifacts))
	for index, artifact := range r.Artifacts {
		if err := validateRequired(artifact.Name); err != nil {
			validation.add(fmt.Sprintf("artifacts[%d].name", index), err.Error())
		}
		if _, exists := seenArtifacts[artifact.Name]; exists {
			validation.add(fmt.Sprintf("artifacts[%d].name", index), "must be unique")
		}
		seenArtifacts[artifact.Name] = struct{}{}
		if artifact.Size == 0 {
			validation.add(fmt.Sprintf("artifacts[%d].size", index), "must be greater than zero")
		}
		if err := ValidateSHA256Digest(artifact.SHA256); err != nil {
			validation.add(fmt.Sprintf("artifacts[%d].sha256", index), err.Error())
		}
		if err := validateHTTPSURL(artifact.URL); err != nil {
			validation.add(fmt.Sprintf("artifacts[%d].url", index), err.Error())
		}
	}
	if err := validateTimestamp(r.PublishedAt); err != nil {
		validation.add("published_at", err.Error())
	}
	return validation.errOrNil()
}

type DiagnosticBundle struct {
	ID          string    `json:"diagnostic_id"`
	State       JobState  `json:"state"`
	Redacted    bool      `json:"redacted"`
	CreatedAt   time.Time `json:"created_at"`
	ExpiresAt   time.Time `json:"expires_at"`
	SizeBytes   uint64    `json:"size_bytes,omitempty"`
	SHA256      string    `json:"sha256,omitempty"`
	DownloadURL string    `json:"download_url,omitempty"`
	Problem     *Problem  `json:"problem,omitempty"`
}
