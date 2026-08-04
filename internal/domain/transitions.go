package domain

import "fmt"

var jobTransitions = map[JobState]map[JobState]struct{}{
	JobQueued: {
		JobRunning: {}, JobCancelled: {}, JobExpired: {},
	},
	JobRunning: {
		JobSucceeded: {}, JobFailed: {}, JobCancelled: {}, JobExpired: {},
	},
	JobFailed: {
		JobQueued: {},
	},
	JobCancelled: {
		JobQueued: {},
	},
	JobExpired: {
		JobQueued: {},
	},
}

// CanTransitionJob reports whether an aggregate durable job transition is
// allowed. Failed, cancelled, and expired jobs may be explicitly reopened when
// a target creates a fresh attempt; succeeded jobs remain immutable.
func CanTransitionJob(from, to JobState) bool {
	if from.Validate() != nil || to.Validate() != nil || from == to {
		return false
	}
	_, allowed := jobTransitions[from][to]
	return allowed
}

func ValidateJobTransition(from, to JobState) error {
	if err := from.Validate(); err != nil {
		return fmt.Errorf("from: %w", err)
	}
	if err := to.Validate(); err != nil {
		return fmt.Errorf("to: %w", err)
	}
	if !CanTransitionJob(from, to) {
		return fmt.Errorf("job cannot transition from %q to %q", from, to)
	}
	return nil
}

var enrollmentTransitions = map[EnrollmentState]map[EnrollmentState]struct{}{
	EnrollmentPending: {
		EnrollmentApproved: {}, EnrollmentRejected: {}, EnrollmentExpired: {},
	},
	EnrollmentApproved: {
		EnrollmentRevoked: {},
	},
}

// CanTransitionEnrollment prevents approval after expiry/rejection and makes
// revocation irreversible.
func CanTransitionEnrollment(from, to EnrollmentState) bool {
	if from.Validate() != nil || to.Validate() != nil || from == to {
		return false
	}
	_, allowed := enrollmentTransitions[from][to]
	return allowed
}

var presenceTransitions = map[PresenceState]map[PresenceState]struct{}{
	PresencePending: {
		PresenceOnline: {}, PresenceOffline: {}, PresenceRevoked: {},
	},
	PresenceOnline: {
		PresenceStale: {}, PresenceOffline: {}, PresenceRevoked: {},
	},
	PresenceStale: {
		PresenceOnline: {}, PresenceOffline: {}, PresenceRevoked: {},
	},
	PresenceOffline: {
		PresenceOnline: {}, PresenceRevoked: {},
	},
}

// CanTransitionPresence captures connection-state changes; revoked is terminal.
func CanTransitionPresence(from, to PresenceState) bool {
	if from.Validate() != nil || to.Validate() != nil || from == to {
		return false
	}
	_, allowed := presenceTransitions[from][to]
	return allowed
}
