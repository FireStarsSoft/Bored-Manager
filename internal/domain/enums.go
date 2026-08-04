package domain

import "fmt"

type PresenceState string

const (
	PresencePending PresenceState = "pending"
	PresenceOnline  PresenceState = "online"
	PresenceStale   PresenceState = "stale"
	PresenceOffline PresenceState = "offline"
	PresenceRevoked PresenceState = "revoked"
)

func (s PresenceState) Validate() error {
	switch s {
	case PresencePending, PresenceOnline, PresenceStale, PresenceOffline, PresenceRevoked:
		return nil
	default:
		return fmt.Errorf("unknown presence state %q", s)
	}
}

type EnrollmentState string

const (
	EnrollmentPending  EnrollmentState = "pending_approval"
	EnrollmentApproved EnrollmentState = "approved"
	EnrollmentRejected EnrollmentState = "rejected"
	EnrollmentExpired  EnrollmentState = "expired"
	EnrollmentRevoked  EnrollmentState = "revoked"
)

func (s EnrollmentState) Validate() error {
	switch s {
	case EnrollmentPending, EnrollmentApproved, EnrollmentRejected, EnrollmentExpired, EnrollmentRevoked:
		return nil
	default:
		return fmt.Errorf("unknown enrollment state %q", s)
	}
}

type InstallationState string

const (
	InstallationUnsupported  InstallationState = "unsupported"
	InstallationNotInstalled InstallationState = "not_installed"
	InstallationInstalled    InstallationState = "installed"
	InstallationUnknown      InstallationState = "unknown"
)

func (s InstallationState) Validate() error {
	switch s {
	case InstallationUnsupported, InstallationNotInstalled, InstallationInstalled, InstallationUnknown:
		return nil
	default:
		return fmt.Errorf("unknown installation state %q", s)
	}
}

type EnablementState string

const (
	EnablementEnabled  EnablementState = "enabled"
	EnablementDisabled EnablementState = "disabled"
	EnablementStatic   EnablementState = "static"
	EnablementMasked   EnablementState = "masked"
	EnablementUnknown  EnablementState = "unknown"
)

func (s EnablementState) Validate() error {
	switch s {
	case EnablementEnabled, EnablementDisabled, EnablementStatic, EnablementMasked, EnablementUnknown:
		return nil
	default:
		return fmt.Errorf("unknown enablement state %q", s)
	}
}

type RuntimeState string

const (
	RuntimeActive   RuntimeState = "active"
	RuntimeInactive RuntimeState = "inactive"
	RuntimeStarting RuntimeState = "starting"
	RuntimeFailed   RuntimeState = "failed"
	RuntimeUnknown  RuntimeState = "unknown"
)

func (s RuntimeState) Validate() error {
	switch s {
	case RuntimeActive, RuntimeInactive, RuntimeStarting, RuntimeFailed, RuntimeUnknown:
		return nil
	default:
		return fmt.Errorf("unknown runtime state %q", s)
	}
}

type HealthState string

const (
	HealthHealthy   HealthState = "healthy"
	HealthUnhealthy HealthState = "unhealthy"
	HealthDegraded  HealthState = "degraded"
	HealthUnknown   HealthState = "unknown"
	HealthNotSet    HealthState = "not_configured"
)

func (s HealthState) Validate() error {
	switch s {
	case HealthHealthy, HealthUnhealthy, HealthDegraded, HealthUnknown, HealthNotSet:
		return nil
	default:
		return fmt.Errorf("unknown health state %q", s)
	}
}

type JobType string

const (
	JobCommand   JobType = "command"
	JobService   JobType = "service"
	JobProvision JobType = "provision"
	JobUpdate    JobType = "update"
	JobBackup    JobType = "backup"
	JobRestore   JobType = "restore"
	JobPurge     JobType = "purge"
)

func (t JobType) Validate() error {
	switch t {
	case JobCommand, JobService, JobProvision, JobUpdate, JobBackup, JobRestore, JobPurge:
		return nil
	default:
		return fmt.Errorf("unknown job type %q", t)
	}
}

type JobState string

const (
	JobQueued    JobState = "queued"
	JobRunning   JobState = "running"
	JobSucceeded JobState = "succeeded"
	JobFailed    JobState = "failed"
	JobCancelled JobState = "cancelled"
	JobExpired   JobState = "expired"
)

func (s JobState) Validate() error {
	switch s {
	case JobQueued, JobRunning, JobSucceeded, JobFailed, JobCancelled, JobExpired:
		return nil
	default:
		return fmt.Errorf("unknown job state %q", s)
	}
}

type JobTargetState string

const (
	TargetQueued    JobTargetState = "queued"
	TargetLeased    JobTargetState = "leased"
	TargetPreparing JobTargetState = "preparing"
	TargetReady     JobTargetState = "ready"
	TargetCommitted JobTargetState = "committed"
	TargetRunning   JobTargetState = "running"
	TargetSucceeded JobTargetState = "succeeded"
	TargetFailed    JobTargetState = "failed"
	TargetCancelled JobTargetState = "cancelled"
	TargetExpired   JobTargetState = "expired"
)

func (s JobTargetState) Validate() error {
	switch s {
	case TargetQueued, TargetLeased, TargetPreparing, TargetReady, TargetCommitted, TargetRunning,
		TargetSucceeded, TargetFailed, TargetCancelled, TargetExpired:
		return nil
	default:
		return fmt.Errorf("unknown job target state %q", s)
	}
}

func (s JobTargetState) Terminal() bool {
	switch s {
	case TargetSucceeded, TargetFailed, TargetCancelled, TargetExpired:
		return true
	default:
		return false
	}
}

type DockerTransport string

const (
	DockerLocalUnix DockerTransport = "local_unix"
	DockerRemoteSSH DockerTransport = "remote_ssh"
)

func (t DockerTransport) Validate() error {
	switch t {
	case DockerLocalUnix, DockerRemoteSSH:
		return nil
	default:
		return fmt.Errorf("unknown Docker transport %q", t)
	}
}

type NetworkMode string

const (
	NetworkBridge  NetworkMode = "bridge"
	NetworkStatic  NetworkMode = "static_pool"
	NetworkMacvlan NetworkMode = "macvlan"
	NetworkIPvlan  NetworkMode = "ipvlan"
	NetworkDHCP    NetworkMode = "external_dhcp"
)

func (m NetworkMode) Validate() error {
	switch m {
	case NetworkBridge, NetworkStatic, NetworkMacvlan, NetworkIPvlan, NetworkDHCP:
		return nil
	default:
		return fmt.Errorf("unknown network mode %q", m)
	}
}

type ReleaseChannel string

const (
	ReleaseStable ReleaseChannel = "stable"
	ReleaseBeta   ReleaseChannel = "beta"
	ReleaseAlpha  ReleaseChannel = "alpha"
)

func (c ReleaseChannel) Validate() error {
	switch c {
	case ReleaseStable, ReleaseBeta, ReleaseAlpha:
		return nil
	default:
		return fmt.Errorf("unknown release channel %q", c)
	}
}
