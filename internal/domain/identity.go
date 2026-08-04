package domain

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/FireStarsSoft/Bored-Manager/internal/platform"
)

type Role string

const (
	RoleAdmin    Role = "admin"
	RoleOperator Role = "operator"
	RoleViewer   Role = "viewer"
)

func (r Role) Validate() error {
	switch r {
	case RoleAdmin, RoleOperator, RoleViewer:
		return nil
	default:
		return fmt.Errorf("unknown role %q", r)
	}
}

type User struct {
	ID          string     `json:"user_id"`
	Username    string     `json:"username"`
	DisplayName string     `json:"display_name"`
	Role        Role       `json:"role"`
	DisabledAt  *time.Time `json:"disabled_at,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
}

func (u User) Validate() error {
	validation := new(ValidationError)
	if err := ValidateUUIDv7(u.ID); err != nil {
		validation.add("user_id", err.Error())
	}
	if err := ValidateSlug(u.Username); err != nil {
		validation.add("username", err.Error())
	}
	if err := validateName(u.DisplayName, 128); err != nil {
		validation.add("display_name", err.Error())
	}
	if err := u.Role.Validate(); err != nil {
		validation.add("role", err.Error())
	}
	if err := validateTimestamp(u.CreatedAt); err != nil {
		validation.add("created_at", err.Error())
	}
	if err := validateTimestamp(u.UpdatedAt); err != nil {
		validation.add("updated_at", err.Error())
	}
	if !u.CreatedAt.IsZero() && u.UpdatedAt.Before(u.CreatedAt) {
		validation.add("updated_at", "must not precede created_at")
	}
	return validation.errOrNil()
}

type Session struct {
	ID                   string     `json:"session_id"`
	User                 User       `json:"user"`
	CSRFToken            string     `json:"csrf_token"`
	CreatedAt            time.Time  `json:"created_at"`
	ExpiresAt            time.Time  `json:"expires_at"`
	ReauthenticatedUntil *time.Time `json:"reauthenticated_until,omitempty"`
}

type SetupStatus struct {
	Required               bool       `json:"required"`
	CompletedAt            *time.Time `json:"completed_at,omitempty"`
	HTTPSListenAddress     string     `json:"https_listen_address"`
	HTTPSPort              uint16     `json:"https_port"`
	GRPCListenAddress      string     `json:"grpc_listen_address"`
	GRPCPort               uint16     `json:"grpc_port"`
	CertificateFingerprint string     `json:"certificate_fingerprint"`
	LocalDockerDetected    bool       `json:"local_docker_detected"`
	LocalDockerRegistered  bool       `json:"local_docker_registered"`
}

// Inventory is the stable subset agents provide during pairing and heartbeat.
type Inventory struct {
	Hostname       string            `json:"hostname"`
	OSRelease      string            `json:"os_release"`
	Architecture   string            `json:"architecture"`
	KernelVersion  string            `json:"kernel_version"`
	AgentVersion   string            `json:"agent_version"`
	SystemdVersion string            `json:"systemd_version"`
	MachineIDHash  string            `json:"machine_id_hash"`
	CPUCount       uint32            `json:"cpu_count"`
	MemoryBytes    uint64            `json:"memory_bytes"`
	DiskBytes      uint64            `json:"disk_bytes"`
	Addresses      []string          `json:"addresses"`
	Labels         map[string]string `json:"labels,omitempty"`
}

func (i Inventory) Validate() error {
	validation := new(ValidationError)
	if err := validateName(i.Hostname, 253); err != nil {
		validation.add("hostname", err.Error())
	}
	if !platform.IsSupportedOSRelease(i.OSRelease) {
		validation.add("os_release", "must be ubuntu-24.04 or kali-rolling")
	}
	if i.Architecture != platform.AMD64 {
		validation.add("architecture", "must be amd64")
	}
	if err := validateRequired(i.AgentVersion); err != nil {
		validation.add("agent_version", err.Error())
	}
	if i.CPUCount == 0 {
		validation.add("cpu_count", "must be greater than zero")
	}
	if i.MemoryBytes == 0 {
		validation.add("memory_bytes", "must be greater than zero")
	}
	if i.DiskBytes == 0 {
		validation.add("disk_bytes", "must be greater than zero")
	}
	if len(i.Addresses) > 64 {
		validation.add("addresses", "must contain at most 64 entries")
	}
	for index, address := range i.Addresses {
		if err := validateIP(address); err != nil {
			validation.add(fmt.Sprintf("addresses[%d]", index), err.Error())
		}
	}
	if len(i.Labels) > 64 {
		validation.add("labels", "must contain at most 64 entries")
	}
	return validation.errOrNil()
}

type LogicalInstance struct {
	ID                 string     `json:"logical_instance_id"`
	Alias              string     `json:"alias"`
	Tags               []string   `json:"tags"`
	CurrentAgentID     string     `json:"current_agent_id,omitempty"`
	TemplateRevisionID string     `json:"template_revision_id,omitempty"`
	CreatedAt          time.Time  `json:"created_at"`
	UpdatedAt          time.Time  `json:"updated_at"`
	DeletedAt          *time.Time `json:"deleted_at,omitempty"`
}

func (l LogicalInstance) Validate() error {
	validation := new(ValidationError)
	if err := ValidateUUIDv7(l.ID); err != nil {
		validation.add("logical_instance_id", err.Error())
	}
	if err := validateName(l.Alias, 128); err != nil {
		validation.add("alias", err.Error())
	}
	if err := validateTags(l.Tags); err != nil {
		validation.add("tags", err.Error())
	}
	if l.CurrentAgentID != "" {
		if err := ValidateUUIDv7(l.CurrentAgentID); err != nil {
			validation.add("current_agent_id", err.Error())
		}
	}
	return validation.errOrNil()
}

type Agent struct {
	ID                string        `json:"agent_id"`
	LogicalInstanceID string        `json:"logical_instance_id"`
	SupersedesAgentID string        `json:"supersedes_agent_id,omitempty"`
	Alias             string        `json:"alias"`
	Tags              []string      `json:"tags"`
	Presence          PresenceState `json:"presence"`
	ProtocolVersion   string        `json:"protocol_version"`
	CertificateSerial string        `json:"certificate_serial"`
	Inventory         Inventory     `json:"inventory"`
	LastSequence      uint64        `json:"last_sequence"`
	LastSeenAt        *time.Time    `json:"last_seen_at,omitempty"`
	EnrolledAt        time.Time     `json:"enrolled_at"`
	RevokedAt         *time.Time    `json:"revoked_at,omitempty"`
	RevocationReason  string        `json:"revocation_reason,omitempty"`
}

func (a Agent) Validate() error {
	validation := new(ValidationError)
	if err := ValidateUUIDv7(a.ID); err != nil {
		validation.add("agent_id", err.Error())
	}
	if err := ValidateUUIDv7(a.LogicalInstanceID); err != nil {
		validation.add("logical_instance_id", err.Error())
	}
	if a.SupersedesAgentID != "" {
		if err := ValidateUUIDv7(a.SupersedesAgentID); err != nil {
			validation.add("supersedes_agent_id", err.Error())
		}
		if a.SupersedesAgentID == a.ID {
			validation.add("supersedes_agent_id", "must not equal agent_id")
		}
	}
	if err := validateName(a.Alias, 128); err != nil {
		validation.add("alias", err.Error())
	}
	if err := validateTags(a.Tags); err != nil {
		validation.add("tags", err.Error())
	}
	if err := a.Presence.Validate(); err != nil {
		validation.add("presence", err.Error())
	}
	if err := validateRequired(a.ProtocolVersion); err != nil {
		validation.add("protocol_version", err.Error())
	}
	if err := validateRequired(a.CertificateSerial); err != nil {
		validation.add("certificate_serial", err.Error())
	}
	if err := a.Inventory.Validate(); err != nil {
		validation.add("inventory", err.Error())
	}
	if a.Presence == PresenceOnline && a.LastSeenAt == nil {
		validation.add("last_seen_at", "is required for online agents")
	}
	if a.Presence == PresenceRevoked && a.RevokedAt == nil {
		validation.add("revoked_at", "is required for revoked agents")
	}
	if a.Presence != PresenceRevoked && a.RevokedAt != nil {
		validation.add("revoked_at", "is only allowed for revoked agents")
	}
	if err := validateTimestamp(a.EnrolledAt); err != nil {
		validation.add("enrolled_at", err.Error())
	}
	if a.LastSeenAt != nil && a.LastSeenAt.Before(a.EnrolledAt) {
		validation.add("last_seen_at", "must not precede enrolled_at")
	}
	return validation.errOrNil()
}

type EnrollmentRequest struct {
	ID                   string          `json:"enrollment_id"`
	State                EnrollmentState `json:"state"`
	CSRPEM               string          `json:"-"`
	CSRFingerprint       string          `json:"csr_fingerprint"`
	VerificationCode     string          `json:"verification_code"`
	SourceAddress        string          `json:"source_address"`
	Inventory            Inventory       `json:"inventory"`
	ProvisionChallengeID string          `json:"provision_challenge_id,omitempty"`
	RequestedAt          time.Time       `json:"requested_at"`
	ExpiresAt            time.Time       `json:"expires_at"`
	ReviewedAt           *time.Time      `json:"reviewed_at,omitempty"`
	ReviewedBy           string          `json:"reviewed_by,omitempty"`
	DecisionReason       string          `json:"decision_reason,omitempty"`
	AgentID              string          `json:"agent_id,omitempty"`
}

func (e EnrollmentRequest) Validate() error {
	validation := new(ValidationError)
	if err := ValidateUUIDv7(e.ID); err != nil {
		validation.add("enrollment_id", err.Error())
	}
	if err := e.State.Validate(); err != nil {
		validation.add("state", err.Error())
	}
	if err := validateFingerprint(e.CSRFingerprint); err != nil {
		validation.add("csr_fingerprint", err.Error())
	}
	if err := validateVerificationCode(e.VerificationCode); err != nil {
		validation.add("verification_code", err.Error())
	}
	if err := validateIP(e.SourceAddress); err != nil {
		validation.add("source_address", err.Error())
	}
	if err := e.Inventory.Validate(); err != nil {
		validation.add("inventory", err.Error())
	}
	if err := validateTimestamp(e.RequestedAt); err != nil {
		validation.add("requested_at", err.Error())
	}
	if e.ExpiresAt.Sub(e.RequestedAt) <= 0 || e.ExpiresAt.Sub(e.RequestedAt) > 10*time.Minute {
		validation.add("expires_at", "must be after requested_at and no more than 10 minutes later")
	}
	if e.State == EnrollmentPending && e.ReviewedAt != nil {
		validation.add("reviewed_at", "must be absent while pending")
	}
	if e.State == EnrollmentApproved {
		if e.ReviewedAt == nil || e.ReviewedBy == "" || e.AgentID == "" {
			validation.add("reviewed_at", "approved enrollment requires reviewer, review time, and agent_id")
		}
		if e.ReviewedBy != "" {
			if err := ValidateUUIDv7(e.ReviewedBy); err != nil {
				validation.add("reviewed_by", err.Error())
			}
		}
		if e.AgentID != "" {
			if err := ValidateUUIDv7(e.AgentID); err != nil {
				validation.add("agent_id", err.Error())
			}
		}
	}
	return validation.errOrNil()
}

type ProvisionChallenge struct {
	ID                string     `json:"challenge_id"`
	JobID             string     `json:"job_id"`
	LogicalInstanceID string     `json:"logical_instance_id"`
	ImageDigest       string     `json:"image_digest"`
	SecretHash        string     `json:"secret_hash"`
	ExpiresAt         time.Time  `json:"expires_at"`
	ConsumedAt        *time.Time `json:"consumed_at,omitempty"`
}

// AgentSnapshot is the REST snapshot payload paired with an event cursor.
type AgentSnapshot struct {
	Agents           []Agent                `json:"agents"`
	LogicalInstances []LogicalInstance      `json:"logical_instances"`
	ObservedServices []ObservedServiceState `json:"observed_services"`
	Page             CursorPage             `json:"page"`
}

// JSONClone validates that public domain values retain standard JSON semantics.
// It is intentionally generic enough for adapters without introducing a codec.
func JSONClone[T any](value T) (T, error) {
	var cloned T
	encoded, err := json.Marshal(value)
	if err != nil {
		return cloned, err
	}
	err = json.Unmarshal(encoded, &cloned)
	return cloned, err
}
