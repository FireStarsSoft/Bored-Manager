package store

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSetupSessionAndEvents(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "manager.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	setup, err := db.IsSetup(ctx)
	if err != nil || setup {
		t.Fatalf("unexpected setup state: %v %v", setup, err)
	}
	admin, err := db.CreateInitialAdmin(ctx, "admin", "Administrator", "encoded-password", map[string]string{"web_port": "8443"})
	if err != nil {
		t.Fatal(err)
	}
	if value, ok, err := db.Setting(ctx, "web_port"); err != nil || !ok || value != "8443" {
		t.Fatalf("setup setting was not committed with admin: value=%q ok=%v err=%v", value, ok, err)
	}
	now := time.Now().UTC()
	if err := db.CreateSession(ctx, Session{TokenHash: "token", CSRFHash: "csrf", AdminID: admin.ID, CreatedAt: now, LastSeenAt: now, ExpiresAt: now.Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Session(ctx, "token"); err != nil {
		t.Fatal(err)
	}
	event, err := db.AppendEvent(ctx, "agent.changed", json.RawMessage(`{"ok":true}`))
	if err != nil || event.Cursor == 0 {
		t.Fatalf("append event: %v", err)
	}
	encoded, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	var envelope map[string]any
	if err := json.Unmarshal(encoded, &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope["cursor"] != "1" || envelope["type"] != "agent.changed" || envelope["occurred_at"] == nil || envelope["created_at"] != nil {
		t.Fatalf("event does not use the canonical cursor envelope: %s", encoded)
	}
	events, _, err := db.EventsSince(ctx, 0, 10)
	if err != nil || len(events) != 1 {
		t.Fatalf("read events: %v %+v", err, events)
	}
}

func TestInitialSetupRollsBackAsOneTransaction(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "manager.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	if _, err := db.CreateInitialAdmin(ctx, "admin", "Administrator", "hash", map[string]string{"": "invalid"}); err == nil {
		t.Fatal("setup with an invalid setting key succeeded")
	}
	if setup, err := db.IsSetup(ctx); err != nil || setup {
		t.Fatalf("failed setup left a partial administrator: setup=%v err=%v", setup, err)
	}
}

func TestWriteAfterCloseFailsWithoutBlocking(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "manager.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := db.SetSetting(ctx, "after-close", "no"); !errors.Is(err, ErrClosed) {
		t.Fatalf("got %v, want ErrClosed", err)
	}
}

func TestEnrollmentDuplicateProtection(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "manager.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	now := time.Now().UTC()
	request := Enrollment{ID: "one", AgentName: "agent", CSRPEM: "pem", Fingerprint: "fp", VerificationCode: "ABCD-EFGH", SourceIP: "127.0.0.1", Inventory: json.RawMessage(`{}`), Version: "dev", CreatedAt: now, ExpiresAt: now.Add(10 * time.Minute)}
	if err := db.CreateEnrollment(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	request.ID = "two"
	if err := db.CreateEnrollment(context.Background(), request); err == nil {
		t.Fatal("duplicate enrollment was accepted")
	}
}

func TestAgentRevocationIsAuditedAndIdempotent(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "manager.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	admin, err := db.CreateInitialAdmin(ctx, "admin", "Administrator", "hash", nil)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	enrollment := Enrollment{ID: "enrollment", AgentName: "agent", CSRPEM: "pem", Fingerprint: "fingerprint", VerificationCode: "ABCD-EFGH", SourceIP: "127.0.0.1", Inventory: json.RawMessage(`{}`), Version: "dev", CreatedAt: now, ExpiresAt: now.Add(10 * time.Minute)}
	if err := db.CreateEnrollment(ctx, enrollment); err != nil {
		t.Fatal(err)
	}
	agent := Agent{ID: "agent-id", Name: "agent", Fingerprint: enrollment.Fingerprint, Version: enrollment.Version, Inventory: enrollment.Inventory}
	if err := db.ApproveEnrollment(ctx, enrollment.ID, admin.ID, agent, "certificate", "serial"); err != nil {
		t.Fatal(err)
	}
	revoked, changed, err := db.RevokeAgent(ctx, agent.ID, "compromised host", admin.ID, "revoke-key-001")
	if err != nil || !changed {
		t.Fatalf("first revocation: changed=%v err=%v", changed, err)
	}
	if revoked.RevokedAt == nil || revoked.RevocationReason != "compromised host" || revoked.RevokedBy == nil || *revoked.RevokedBy != admin.ID {
		t.Fatalf("revocation audit fields were not populated: %+v", revoked)
	}
	replayed, changed, err := db.RevokeAgent(ctx, agent.ID, "compromised host", admin.ID, "revoke-key-001")
	if err != nil || changed || replayed.RevokedAt == nil {
		t.Fatalf("idempotent replay: changed=%v err=%v agent=%+v", changed, err, replayed)
	}
	if _, _, err := db.RevokeAgent(ctx, agent.ID, "different intent", admin.ID, "revoke-key-002"); !errors.Is(err, ErrConflict) {
		t.Fatalf("different revocation intent returned %v, want ErrConflict", err)
	}
}

func TestDockerHostMutationReplaysExactCommittedResponse(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "manager.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()
	host := DockerHost{ID: "01890abc-def0-7123-8123-456789abcdef", Name: "remote", Kind: "ssh", Endpoint: "docker-admin@192.0.2.10:22", Status: "healthy", CreatedAt: now}
	response := json.RawMessage(`{"docker_host_id":"01890abc-def0-7123-8123-456789abcdef"}`)
	key := "docker-create-001"
	hash := strings.Repeat("a", 64)
	if err := db.UpsertDockerHostIdempotent(ctx, host, key, "docker-host.create.remote-ssh", hash, 201, response, now); err != nil {
		t.Fatal(err)
	}
	replay, found, err := db.ReplayIdempotency(ctx, key, "docker-host.create.remote-ssh", hash, now.Add(time.Hour))
	if err != nil || !found || replay.StatusCode != 201 || string(replay.Response) != string(response) {
		t.Fatalf("unexpected replay: found=%v replay=%+v err=%v", found, replay, err)
	}
	if _, _, err := db.ReplayIdempotency(ctx, key, "docker-host.create.remote-ssh", strings.Repeat("b", 64), now.Add(time.Hour)); !errors.Is(err, ErrConflict) {
		t.Fatalf("key reuse returned %v, want ErrConflict", err)
	}
	if _, found, err := db.ReplayIdempotency(ctx, key, "docker-host.create.remote-ssh", hash, now.Add(25*time.Hour)); err != nil || found {
		t.Fatalf("expired idempotency record replayed: found=%v err=%v", found, err)
	}
}

func TestOnlineBackup(t *testing.T) {
	directory := t.TempDir()
	db, err := Open(filepath.Join(directory, "manager.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.CreateInitialAdmin(context.Background(), "admin", "Administrator", "hash", nil); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(directory, "backup.db")
	if err := db.Backup(context.Background(), destination); err != nil {
		t.Fatal(err)
	}
	backup, err := Open(destination)
	if err != nil {
		t.Fatal(err)
	}
	defer backup.Close()
	setup, err := backup.IsSetup(context.Background())
	if err != nil || !setup {
		t.Fatalf("backup is invalid: setup=%v err=%v", setup, err)
	}
}
