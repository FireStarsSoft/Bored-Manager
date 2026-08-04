package domain

import (
	"fmt"
	"time"
)

type ServiceActionType string

const (
	ServiceInstall   ServiceActionType = "install"
	ServiceUninstall ServiceActionType = "uninstall"
	ServiceStart     ServiceActionType = "start"
	ServiceStop      ServiceActionType = "stop"
	ServiceRestart   ServiceActionType = "restart"
	ServiceUpdate    ServiceActionType = "update"
	ServiceCheck     ServiceActionType = "check"
)

func (a ServiceActionType) Validate() error {
	switch a {
	case ServiceInstall, ServiceUninstall, ServiceStart, ServiceStop, ServiceRestart, ServiceUpdate, ServiceCheck:
		return nil
	default:
		return fmt.Errorf("unknown service action %q", a)
	}
}

type ServiceDefinition struct {
	ID              string    `json:"service_definition_id"`
	Key             string    `json:"key"`
	DisplayName     string    `json:"display_name"`
	Description     string    `json:"description,omitempty"`
	CurrentRevision uint32    `json:"current_revision"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

func (s ServiceDefinition) Validate() error {
	validation := new(ValidationError)
	if err := ValidateUUIDv7(s.ID); err != nil {
		validation.add("service_definition_id", err.Error())
	}
	if err := ValidateSlug(s.Key); err != nil {
		validation.add("key", err.Error())
	}
	if err := validateName(s.DisplayName, 128); err != nil {
		validation.add("display_name", err.Error())
	}
	if len(s.Description) > 2048 {
		validation.add("description", "must be at most 2048 bytes")
	}
	if s.CurrentRevision == 0 {
		validation.add("current_revision", "must be at least 1")
	}
	if err := validateTimestamp(s.CreatedAt); err != nil {
		validation.add("created_at", err.Error())
	}
	if err := validateTimestamp(s.UpdatedAt); err != nil {
		validation.add("updated_at", err.Error())
	} else if s.UpdatedAt.Before(s.CreatedAt) {
		validation.add("updated_at", "must not precede created_at")
	}
	return validation.errOrNil()
}

type ServiceCheckSpec struct {
	Type             string            `json:"type"`
	IntervalSeconds  uint32            `json:"interval_seconds"`
	TimeoutSeconds   uint32            `json:"timeout_seconds"`
	FailureThreshold uint32            `json:"failure_threshold"`
	Configuration    map[string]string `json:"configuration,omitempty"`
}

type ServiceActionSpec struct {
	Type             ServiceActionType `json:"type"`
	Script           string            `json:"script"`
	TimeoutSeconds   uint32            `json:"timeout_seconds"`
	AllowedExitCodes []int32           `json:"allowed_exit_codes,omitempty"`
	RequiresRoot     bool              `json:"requires_root"`
}

type ServiceRevision struct {
	ID                  string              `json:"service_revision_id"`
	ServiceDefinitionID string              `json:"service_definition_id"`
	Revision            uint32              `json:"revision"`
	OSReleases          []string            `json:"os_releases"`
	Architectures       []string            `json:"architectures"`
	SystemdUnit         string              `json:"systemd_unit,omitempty"`
	VersionCommand      string              `json:"version_command,omitempty"`
	Checks              []ServiceCheckSpec  `json:"checks"`
	Actions             []ServiceActionSpec `json:"actions"`
	Signature           string              `json:"signature"`
	PublishedAt         time.Time           `json:"published_at"`
}

func (s ServiceRevision) Validate() error {
	validation := new(ValidationError)
	if err := ValidateUUIDv7(s.ID); err != nil {
		validation.add("service_revision_id", err.Error())
	}
	if err := ValidateUUIDv7(s.ServiceDefinitionID); err != nil {
		validation.add("service_definition_id", err.Error())
	}
	if s.Revision == 0 {
		validation.add("revision", "must be at least 1")
	}
	if len(s.OSReleases) == 0 {
		validation.add("os_releases", "must not be empty")
	}
	if len(s.Architectures) == 0 {
		validation.add("architectures", "must not be empty")
	}
	if len(s.Checks) > 16 {
		validation.add("checks", "must contain at most 16 checks")
	}
	for index, check := range s.Checks {
		switch check.Type {
		case "systemd", "process", "tcp", "http", "command":
		default:
			validation.add(fmt.Sprintf("checks[%d].type", index), "must be systemd, process, tcp, http, or command")
		}
		if check.IntervalSeconds < 5 || check.IntervalSeconds > 3600 {
			validation.add(fmt.Sprintf("checks[%d].interval_seconds", index), "must be between 5 and 3600")
		}
		if check.TimeoutSeconds == 0 || check.TimeoutSeconds > 300 || check.TimeoutSeconds >= check.IntervalSeconds {
			validation.add(fmt.Sprintf("checks[%d].timeout_seconds", index), "must be between 1 and 300 and less than interval_seconds")
		}
		if check.FailureThreshold == 0 || check.FailureThreshold > 20 {
			validation.add(fmt.Sprintf("checks[%d].failure_threshold", index), "must be between 1 and 20")
		}
		if len(check.Configuration) > 64 {
			validation.add(fmt.Sprintf("checks[%d].configuration", index), "must contain at most 64 entries")
		}
	}
	seenActions := make(map[ServiceActionType]struct{}, len(s.Actions))
	for index, action := range s.Actions {
		if err := action.Type.Validate(); err != nil {
			validation.add(fmt.Sprintf("actions[%d].type", index), err.Error())
		}
		if _, exists := seenActions[action.Type]; exists {
			validation.add(fmt.Sprintf("actions[%d].type", index), "must be unique")
		}
		seenActions[action.Type] = struct{}{}
		if len(action.Script) == 0 || len(action.Script) > 64*1024 {
			validation.add(fmt.Sprintf("actions[%d].script", index), "must contain 1-65536 bytes")
		}
		if action.TimeoutSeconds == 0 || action.TimeoutSeconds > 3600 {
			validation.add(fmt.Sprintf("actions[%d].timeout_seconds", index), "must be between 1 and 3600")
		}
	}
	if err := validateRequired(s.Signature); err != nil {
		validation.add("signature", err.Error())
	}
	if err := validateTimestamp(s.PublishedAt); err != nil {
		validation.add("published_at", err.Error())
	}
	return validation.errOrNil()
}

type ServiceAssignment struct {
	ID                string     `json:"service_assignment_id"`
	ServiceRevisionID string     `json:"service_revision_id"`
	ScopeType         string     `json:"scope_type"`
	ScopeID           string     `json:"scope_id"`
	ExcludedAgentIDs  []string   `json:"excluded_agent_ids,omitempty"`
	CreatedAt         time.Time  `json:"created_at"`
	DisabledAt        *time.Time `json:"disabled_at,omitempty"`
}

type ObservedServiceState struct {
	AgentID              string            `json:"agent_id"`
	ServiceDefinitionID  string            `json:"service_definition_id"`
	ServiceRevisionID    string            `json:"service_revision_id,omitempty"`
	Installation         InstallationState `json:"installation"`
	Enablement           EnablementState   `json:"enablement"`
	Runtime              RuntimeState      `json:"runtime"`
	Health               HealthState       `json:"health"`
	Version              string            `json:"version,omitempty"`
	SystemdActiveState   string            `json:"systemd_active_state,omitempty"`
	SystemdSubState      string            `json:"systemd_sub_state,omitempty"`
	CheckedAt            time.Time         `json:"checked_at"`
	TransitionedAt       time.Time         `json:"transitioned_at"`
	StateDurationSeconds uint64            `json:"state_duration_seconds"`
	ErrorSummary         string            `json:"error_summary,omitempty"`
}

func (s ObservedServiceState) Validate() error {
	validation := new(ValidationError)
	if err := ValidateUUIDv7(s.AgentID); err != nil {
		validation.add("agent_id", err.Error())
	}
	if err := ValidateUUIDv7(s.ServiceDefinitionID); err != nil {
		validation.add("service_definition_id", err.Error())
	}
	if err := s.Installation.Validate(); err != nil {
		validation.add("installation", err.Error())
	}
	if err := s.Enablement.Validate(); err != nil {
		validation.add("enablement", err.Error())
	}
	if err := s.Runtime.Validate(); err != nil {
		validation.add("runtime", err.Error())
	}
	if err := s.Health.Validate(); err != nil {
		validation.add("health", err.Error())
	}
	if s.Installation == InstallationUnsupported || s.Installation == InstallationNotInstalled {
		if s.Runtime == RuntimeActive || s.Runtime == RuntimeStarting {
			validation.add("runtime", "cannot be active or starting when the service is unsupported or not installed")
		}
	}
	if s.Installation != InstallationInstalled && s.Health == HealthHealthy {
		validation.add("health", "cannot be healthy when the service is not installed")
	}
	if len(s.ErrorSummary) > 1024 {
		validation.add("error_summary", "must be at most 1024 bytes")
	}
	if s.TransitionedAt.After(s.CheckedAt) {
		validation.add("transitioned_at", "must not follow checked_at")
	}
	if err := validateTimestamp(s.CheckedAt); err != nil {
		validation.add("checked_at", err.Error())
	}
	if err := validateTimestamp(s.TransitionedAt); err != nil {
		validation.add("transitioned_at", err.Error())
	}
	return validation.errOrNil()
}
