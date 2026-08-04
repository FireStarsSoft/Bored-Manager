package domain

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

var targetTransitions = map[JobTargetState]map[JobTargetState]struct{}{
	TargetQueued: {
		TargetLeased: {}, TargetCancelled: {}, TargetExpired: {},
	},
	TargetLeased: {
		TargetPreparing: {}, TargetCancelled: {}, TargetExpired: {},
	},
	TargetPreparing: {
		TargetReady: {}, TargetFailed: {}, TargetCancelled: {}, TargetExpired: {},
	},
	TargetReady: {
		TargetCommitted: {}, TargetFailed: {}, TargetCancelled: {}, TargetExpired: {},
	},
	TargetCommitted: {
		TargetRunning: {}, TargetSucceeded: {}, TargetFailed: {}, TargetCancelled: {}, TargetExpired: {},
	},
	TargetRunning: {
		TargetSucceeded: {}, TargetFailed: {}, TargetCancelled: {}, TargetExpired: {},
	},
}

// CanTransitionTarget reports whether a durable target may move from one state
// to another. Terminal states are immutable. A lost lease first becomes
// expired; retry then creates a new queued attempt with a new idempotency key.
func CanTransitionTarget(from, to JobTargetState) bool {
	if from.Validate() != nil || to.Validate() != nil || from == to || from.Terminal() {
		return false
	}
	_, ok := targetTransitions[from][to]
	return ok
}

// ValidateTargetTransition returns an actionable error for an invalid state
// transition and is suitable for API conflict responses.
func ValidateTargetTransition(from, to JobTargetState) error {
	if err := from.Validate(); err != nil {
		return fmt.Errorf("from: %w", err)
	}
	if err := to.Validate(); err != nil {
		return fmt.Errorf("to: %w", err)
	}
	if !CanTransitionTarget(from, to) {
		return fmt.Errorf("job target cannot transition from %q to %q", from, to)
	}
	return nil
}

// Job is a durable, auditable operation whose targets have independent leases.
type Job struct {
	ID             string          `json:"job_id"`
	Type           JobType         `json:"job_type"`
	State          JobState        `json:"state"`
	RequestedBy    string          `json:"requested_by"`
	IdempotencyKey string          `json:"idempotency_key"`
	Parameters     json.RawMessage `json:"parameters,omitempty"`
	CreatedAt      time.Time       `json:"created_at"`
	StartedAt      *time.Time      `json:"started_at,omitempty"`
	FinishedAt     *time.Time      `json:"finished_at,omitempty"`
	Targets        []JobTarget     `json:"targets,omitempty"`
}

func (j Job) Validate() error {
	validation := new(ValidationError)
	if err := ValidateUUIDv7(j.ID); err != nil {
		validation.add("job_id", err.Error())
	}
	if err := j.Type.Validate(); err != nil {
		validation.add("job_type", err.Error())
	}
	if err := j.State.Validate(); err != nil {
		validation.add("state", err.Error())
	}
	if err := validateRequired(j.RequestedBy); err != nil {
		validation.add("requested_by", err.Error())
	}
	if len(j.IdempotencyKey) < 8 || len(j.IdempotencyKey) > 128 {
		validation.add("idempotency_key", "must contain 8-128 bytes")
	}
	if err := validateTimestamp(j.CreatedAt); err != nil {
		validation.add("created_at", err.Error())
	}
	if j.StartedAt != nil && j.StartedAt.Before(j.CreatedAt) {
		validation.add("started_at", "must not precede created_at")
	}
	if j.FinishedAt != nil {
		if j.StartedAt == nil {
			validation.add("finished_at", "requires started_at")
		} else if j.FinishedAt.Before(*j.StartedAt) {
			validation.add("finished_at", "must not precede started_at")
		}
	}
	switch j.State {
	case JobQueued:
		if j.StartedAt != nil || j.FinishedAt != nil {
			validation.add("state", "queued jobs must not have execution timestamps")
		}
	case JobRunning:
		if j.StartedAt == nil || j.FinishedAt != nil {
			validation.add("state", "running jobs require started_at and no finished_at")
		}
	case JobSucceeded, JobFailed, JobCancelled, JobExpired:
		if j.StartedAt == nil || j.FinishedAt == nil {
			validation.add("state", "terminal jobs require started_at and finished_at")
		}
	}
	if len(j.Targets) == 0 {
		validation.add("targets", "must contain at least one target")
	}
	seenTargets := make(map[string]struct{}, len(j.Targets))
	for index, target := range j.Targets {
		if err := target.Validate(); err != nil {
			validation.add(fmt.Sprintf("targets[%d]", index), err.Error())
		}
		if _, exists := seenTargets[target.TargetID]; exists {
			validation.add(fmt.Sprintf("targets[%d].target_id", index), "must be unique within the job")
		}
		seenTargets[target.TargetID] = struct{}{}
	}
	return validation.errOrNil()
}

// JobTarget is one independently leased execution in a durable job.
type JobTarget struct {
	TargetID       string          `json:"target_id"`
	State          JobTargetState  `json:"state"`
	Attempt        uint32          `json:"attempt"`
	IdempotencyKey string          `json:"idempotency_key"`
	LeaseID        string          `json:"lease_id,omitempty"`
	LeaseExpiresAt *time.Time      `json:"lease_expires_at,omitempty"`
	PreparedAt     *time.Time      `json:"prepared_at,omitempty"`
	CommittedAt    *time.Time      `json:"committed_at,omitempty"`
	StartedAt      *time.Time      `json:"started_at,omitempty"`
	FinishedAt     *time.Time      `json:"finished_at,omitempty"`
	ExitCode       *int32          `json:"exit_code,omitempty"`
	Result         json.RawMessage `json:"result,omitempty"`
	Error          *Problem        `json:"error,omitempty"`
}

func (t JobTarget) Validate() error {
	validation := new(ValidationError)
	if err := validateRequired(t.TargetID); err != nil {
		validation.add("target_id", err.Error())
	}
	if err := t.State.Validate(); err != nil {
		validation.add("state", err.Error())
	}
	if t.Attempt == 0 {
		validation.add("attempt", "must be at least 1")
	}
	if len(t.IdempotencyKey) < 8 || len(t.IdempotencyKey) > 128 {
		validation.add("idempotency_key", "must contain 8-128 bytes")
	}
	requiresLease := t.State == TargetLeased || t.State == TargetPreparing || t.State == TargetReady ||
		t.State == TargetCommitted || t.State == TargetRunning
	if requiresLease {
		if err := ValidateUUIDv7(t.LeaseID); err != nil {
			validation.add("lease_id", err.Error())
		}
		if t.LeaseExpiresAt == nil || t.LeaseExpiresAt.IsZero() {
			validation.add("lease_expires_at", "is required while a lease is active")
		}
	}
	if t.State == TargetQueued && (t.LeaseID != "" || t.LeaseExpiresAt != nil) {
		validation.add("lease_id", "queued targets must not retain a lease")
	}
	if t.State.Terminal() && t.FinishedAt == nil {
		validation.add("finished_at", "is required for terminal states")
	}
	if !t.State.Terminal() && t.FinishedAt != nil {
		validation.add("finished_at", "is only allowed for terminal states")
	}
	if t.ExitCode != nil && t.State != TargetSucceeded && t.State != TargetFailed && t.State != TargetCancelled {
		validation.add("exit_code", "is only allowed for executed terminal targets")
	}
	if t.State == TargetReady && t.PreparedAt == nil {
		validation.add("prepared_at", "is required for ready targets")
	}
	if (t.State == TargetCommitted || t.State == TargetRunning) && (t.PreparedAt == nil || t.CommittedAt == nil) {
		validation.add("committed_at", "committed and running targets require prepared_at and committed_at")
	}
	if t.State == TargetRunning && t.StartedAt == nil {
		validation.add("started_at", "is required for running targets")
	}
	return validation.errOrNil()
}

// NextAttempt returns a clean queued retry while preserving resource identity.
func (t JobTarget) NextAttempt(idempotencyKey string) (JobTarget, error) {
	if t.State != TargetFailed && t.State != TargetCancelled && t.State != TargetExpired {
		return JobTarget{}, errors.New("only a failed, cancelled, or expired target can be retried")
	}
	if len(idempotencyKey) < 8 || len(idempotencyKey) > 128 {
		return JobTarget{}, errors.New("idempotency key must contain 8-128 bytes")
	}
	return JobTarget{
		TargetID:       t.TargetID,
		State:          TargetQueued,
		Attempt:        t.Attempt + 1,
		IdempotencyKey: idempotencyKey,
	}, nil
}
