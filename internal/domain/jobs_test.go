package domain

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

const (
	testJobID   = "01890abc-def0-7123-8123-456789abcdef"
	testLeaseID = "01890abc-def0-7456-9123-456789abcdef"
)

func TestJobTargetTransitions(t *testing.T) {
	t.Parallel()

	allowed := [][2]JobTargetState{
		{TargetQueued, TargetLeased},
		{TargetQueued, TargetCancelled},
		{TargetQueued, TargetExpired},
		{TargetLeased, TargetPreparing},
		{TargetPreparing, TargetReady},
		{TargetReady, TargetCommitted},
		{TargetCommitted, TargetRunning},
		{TargetCommitted, TargetSucceeded},
		{TargetRunning, TargetSucceeded},
		{TargetRunning, TargetFailed},
		{TargetRunning, TargetCancelled},
		{TargetRunning, TargetExpired},
	}

	for _, transition := range allowed {
		transition := transition
		t.Run(string(transition[0])+"_to_"+string(transition[1]), func(t *testing.T) {
			t.Parallel()
			if !CanTransitionTarget(transition[0], transition[1]) {
				t.Fatalf("expected %s -> %s to be allowed", transition[0], transition[1])
			}
			if err := ValidateTargetTransition(transition[0], transition[1]); err != nil {
				t.Fatalf("unexpected transition error: %v", err)
			}
		})
	}

	denied := [][2]JobTargetState{
		{TargetQueued, TargetRunning},
		{TargetLeased, TargetReady},
		{TargetPreparing, TargetCommitted},
		{TargetReady, TargetRunning},
		{TargetRunning, TargetQueued},
		{TargetLeased, TargetQueued},
		{TargetSucceeded, TargetQueued},
		{TargetFailed, TargetLeased},
		{TargetCancelled, TargetCancelled},
		{JobTargetState("invented"), TargetQueued},
	}
	for _, transition := range denied {
		if CanTransitionTarget(transition[0], transition[1]) {
			t.Errorf("expected %s -> %s to be denied", transition[0], transition[1])
		}
		if err := ValidateTargetTransition(transition[0], transition[1]); err == nil {
			t.Errorf("expected %s -> %s to return an error", transition[0], transition[1])
		}
	}
}

func TestJobTargetTransitionMatrixIsClosed(t *testing.T) {
	t.Parallel()
	states := []JobTargetState{
		TargetQueued, TargetLeased, TargetPreparing, TargetReady, TargetCommitted,
		TargetRunning, TargetSucceeded, TargetFailed, TargetCancelled, TargetExpired,
	}
	for _, from := range states {
		for _, to := range states {
			_, expected := targetTransitions[from][to]
			if from == to || from.Terminal() {
				expected = false
			}
			if actual := CanTransitionTarget(from, to); actual != expected {
				t.Errorf("CanTransitionTarget(%q, %q) = %v, want %v", from, to, actual, expected)
			}
		}
	}
}

func TestAggregateAndIdentityTransitions(t *testing.T) {
	t.Parallel()
	jobCases := []struct {
		from, to JobState
		allowed  bool
	}{
		{JobQueued, JobRunning, true},
		{JobQueued, JobCancelled, true},
		{JobRunning, JobSucceeded, true},
		{JobRunning, JobFailed, true},
		{JobFailed, JobQueued, true},
		{JobExpired, JobQueued, true},
		{JobSucceeded, JobRunning, false},
		{JobQueued, JobSucceeded, false},
	}
	for _, test := range jobCases {
		if actual := CanTransitionJob(test.from, test.to); actual != test.allowed {
			t.Errorf("CanTransitionJob(%q, %q) = %v, want %v", test.from, test.to, actual, test.allowed)
		}
	}

	if !CanTransitionEnrollment(EnrollmentPending, EnrollmentApproved) {
		t.Error("pending enrollment must be approvable")
	}
	if CanTransitionEnrollment(EnrollmentExpired, EnrollmentApproved) {
		t.Error("expired enrollment must never be approvable")
	}
	if !CanTransitionEnrollment(EnrollmentApproved, EnrollmentRevoked) {
		t.Error("approved enrollment must be revocable")
	}
	if CanTransitionEnrollment(EnrollmentRevoked, EnrollmentPending) {
		t.Error("revoked enrollment must be terminal")
	}

	if !CanTransitionPresence(PresenceOnline, PresenceStale) ||
		!CanTransitionPresence(PresenceStale, PresenceOnline) {
		t.Error("online/stale presence must recover in either direction")
	}
	if CanTransitionPresence(PresenceRevoked, PresenceOnline) {
		t.Error("revoked presence must be terminal")
	}
}

func TestJobTargetValidateLeaseInvariants(t *testing.T) {
	t.Parallel()
	now := time.Now().UTC()
	valid := JobTarget{
		TargetID:       "agent:" + testJobID,
		State:          TargetRunning,
		Attempt:        1,
		IdempotencyKey: "job-target-attempt-1",
		LeaseID:        testLeaseID,
		LeaseExpiresAt: ptrTime(now.Add(time.Minute)),
		PreparedAt:     ptrTime(now.Add(-2 * time.Second)),
		CommittedAt:    ptrTime(now.Add(-time.Second)),
		StartedAt:      &now,
	}
	if err := valid.Validate(); err != nil {
		t.Fatalf("valid target rejected: %v", err)
	}

	invalid := valid
	invalid.LeaseID = ""
	invalid.LeaseExpiresAt = nil
	invalid.FinishedAt = &now
	err := invalid.Validate()
	if !IsValidationError(err) {
		t.Fatalf("expected ValidationError, got %T (%v)", err, err)
	}
	if !strings.Contains(err.Error(), "lease_id") || !strings.Contains(err.Error(), "finished_at") {
		t.Fatalf("expected lease and terminal violations, got %v", err)
	}
}

func TestJobTargetNextAttempt(t *testing.T) {
	t.Parallel()
	now := time.Now().UTC()
	previous := JobTarget{
		TargetID:       "agent:" + testJobID,
		State:          TargetFailed,
		Attempt:        3,
		IdempotencyKey: "attempt-three",
		FinishedAt:     &now,
	}
	next, err := previous.NextAttempt("attempt-four")
	if err != nil {
		t.Fatalf("NextAttempt failed: %v", err)
	}
	if next.State != TargetQueued || next.Attempt != 4 || next.TargetID != previous.TargetID {
		t.Fatalf("unexpected retry target: %#v", next)
	}
	if next.LeaseID != "" || next.FinishedAt != nil || next.Error != nil {
		t.Fatalf("retry leaked prior execution state: %#v", next)
	}

	previous.State = TargetRunning
	if _, err := previous.NextAttempt("attempt-four"); err == nil {
		t.Fatal("expected retry of nonterminal target to fail")
	}
}

func TestJobValidationRejectsDuplicateTargets(t *testing.T) {
	t.Parallel()
	now := time.Now().UTC()
	target := JobTarget{
		TargetID:       "agent:" + testJobID,
		State:          TargetQueued,
		Attempt:        1,
		IdempotencyKey: "target-attempt-1",
	}
	job := Job{
		ID:             testJobID,
		Type:           JobCommand,
		State:          JobQueued,
		RequestedBy:    "admin",
		IdempotencyKey: "request-idempotency-key",
		CreatedAt:      now,
		Targets:        []JobTarget{target, target},
	}
	if err := job.Validate(); err == nil || !strings.Contains(err.Error(), "unique") {
		t.Fatalf("expected duplicate target violation, got %v", err)
	}
}

func TestEventCursorJSONUsesString(t *testing.T) {
	t.Parallel()
	cursor := EventCursor(9007199254740993)
	encoded, err := json.Marshal(cursor)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `"9007199254740993"` {
		t.Fatalf("cursor lost string encoding: %s", encoded)
	}
	var decoded EventCursor
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded != cursor {
		t.Fatalf("round trip mismatch: got %d, want %d", decoded, cursor)
	}
	if err := json.Unmarshal([]byte(`9007199254740993`), &decoded); err == nil {
		t.Fatal("numeric event cursor must be rejected")
	}
}

func TestEventEnvelopeResyncValidation(t *testing.T) {
	t.Parallel()
	payload, err := json.Marshal(ResyncRequired{Reason: ResyncBufferOverrun, LatestCursor: 42})
	if err != nil {
		t.Fatal(err)
	}
	event := EventEnvelope{
		Cursor:     41,
		Type:       EventResyncRequired,
		OccurredAt: time.Now().UTC(),
		Payload:    payload,
	}
	if err := event.Validate(); err != nil {
		t.Fatalf("valid resync event rejected: %v", err)
	}
	event.ResourceID = "should-not-be-set"
	if err := event.Validate(); err == nil {
		t.Fatal("expected resource-bound resync event to be rejected")
	}
}

func ptrTime(value time.Time) *time.Time { return &value }
