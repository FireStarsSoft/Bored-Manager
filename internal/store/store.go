// Package store provides Bored Manager's durable SQLite state. All mutations
// pass through one bounded writer with high- and low-priority queues.
package store

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"modernc.org/sqlite"
)

var (
	ErrNotFound = errors.New("not found")
	ErrConflict = errors.New("conflict")
	ErrClosed   = errors.New("store is closed")
)

type priority uint8

const (
	priorityHigh priority = iota
	priorityLow
)

type writeResult struct {
	value any
	err   error
}

type writeRequest struct {
	ctx      context.Context
	priority priority
	fn       func(*sql.Tx) (any, error)
	raw      func(*sql.DB) (any, error)
	result   chan writeResult
}

// Store wraps the read pool and the single serialized writer.
type Store struct {
	db        *sql.DB
	high      chan writeRequest
	low       chan writeRequest
	stop      chan struct{}
	done      chan struct{}
	closeOnce sync.Once
	lifecycle sync.RWMutex
	closed    atomic.Bool
}

// Open initializes and migrates a manager database.
func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create database directory: %w", err)
	}
	dsn := "file:" + filepath.ToSlash(path) + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(ON)&_pragma=synchronous(NORMAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	db.SetMaxOpenConns(8)
	db.SetMaxIdleConns(4)
	db.SetConnMaxLifetime(30 * time.Minute)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate database: %w", err)
	}
	if err := applyCompatibilityMigrations(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("apply compatibility migrations: %w", err)
	}
	store := &Store{
		db:   db,
		high: make(chan writeRequest, 256),
		low:  make(chan writeRequest, 1024),
		stop: make(chan struct{}),
		done: make(chan struct{}),
	}
	go store.writer()
	return store, nil
}

func applyCompatibilityMigrations(database *sql.DB) error {
	migrations := []struct{ table, column, declaration string }{
		{"sessions", "reauthenticated_until", "ALTER TABLE sessions ADD COLUMN reauthenticated_until INTEGER"},
		{"enrollment_requests", "decision_reason", "ALTER TABLE enrollment_requests ADD COLUMN decision_reason TEXT NOT NULL DEFAULT ''"},
		{"docker_hosts", "ssh_credential_ref", "ALTER TABLE docker_hosts ADD COLUMN ssh_credential_ref TEXT NOT NULL DEFAULT ''"},
		{"admins", "display_name", "ALTER TABLE admins ADD COLUMN display_name TEXT NOT NULL DEFAULT ''"},
		{"admins", "role", "ALTER TABLE admins ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'"},
		{"admins", "updated_at", "ALTER TABLE admins ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0"},
		{"agents", "revocation_reason", "ALTER TABLE agents ADD COLUMN revocation_reason TEXT NOT NULL DEFAULT ''"},
		{"agents", "revoked_by", "ALTER TABLE agents ADD COLUMN revoked_by INTEGER REFERENCES admins(id)"},
		{"agents", "revocation_idempotency_key", "ALTER TABLE agents ADD COLUMN revocation_idempotency_key TEXT NOT NULL DEFAULT ''"},
	}
	for _, migration := range migrations {
		exists, err := columnExists(database, migration.table, migration.column)
		if err != nil {
			return err
		}
		if !exists {
			if _, err := database.Exec(migration.declaration); err != nil {
				return err
			}
		}
	}
	_, err := database.Exec(`
		INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(2,unixepoch());
		INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(3,unixepoch());
		UPDATE admins SET display_name=username WHERE display_name='';
		UPDATE admins SET updated_at=created_at WHERE updated_at=0;
		INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(4,unixepoch());
		UPDATE docker_hosts SET id='018f0000-0000-7000-8000-000000000001' WHERE id='local';
		INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(5,unixepoch());
		CREATE UNIQUE INDEX IF NOT EXISTS agent_revocation_idempotency
			ON agents(revocation_idempotency_key) WHERE revocation_idempotency_key<>'';
		INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(6,unixepoch());
		CREATE TABLE IF NOT EXISTS idempotency_records(
			idempotency_key TEXT PRIMARY KEY, operation TEXT NOT NULL, request_hash TEXT NOT NULL,
			status_code INTEGER NOT NULL, response_json TEXT NOT NULL, created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idempotency_expiry ON idempotency_records(expires_at);
		INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(7,unixepoch());`)
	return err
}

func columnExists(database *sql.DB, table, column string) (bool, error) {
	rows, err := database.Query(`PRAGMA table_info(` + table + `)`)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var index int
		var name, dataType string
		var notNull, primaryKey int
		var defaultValue any
		if err := rows.Scan(&index, &name, &dataType, &notNull, &defaultValue, &primaryKey); err != nil {
			return false, err
		}
		if name == column {
			return true, nil
		}
	}
	return false, rows.Err()
}

// Close drains the active mutation and closes the database.
func (s *Store) Close() error {
	var err error
	s.closeOnce.Do(func() {
		s.lifecycle.Lock()
		s.closed.Store(true)
		close(s.stop)
		s.lifecycle.Unlock()
		<-s.done
		err = s.db.Close()
	})
	return err
}

// Ping confirms the read pool can reach SQLite.
func (s *Store) Ping(ctx context.Context) error { return s.db.PingContext(ctx) }

// QueueDepth reports high and telemetry writer pressure for diagnostics.
func (s *Store) QueueDepth() (high, low int) { return len(s.high), len(s.low) }

// Setting returns a non-secret runtime setting.
func (s *Store) Setting(ctx context.Context, key string) (string, bool, error) {
	var value string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM settings WHERE key=?`, key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return value, err == nil, err
}

// SetSetting persists non-secret configuration through the priority writer.
func (s *Store) SetSetting(ctx context.Context, key, value string) error {
	if strings.TrimSpace(key) == "" {
		return errors.New("setting key is required")
	}
	_, err := s.write(ctx, priorityHigh, func(tx *sql.Tx) (any, error) {
		_, err := tx.ExecContext(ctx, `INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, key, value, unix(time.Now()))
		return nil, err
	})
	return err
}

func (s *Store) writer() {
	defer close(s.done)
	for {
		var request writeRequest
		var ok bool
		// Always give identity, job and security mutations priority.
		select {
		case request, ok = <-s.high:
			if !ok {
				return
			}
		default:
			select {
			case <-s.stop:
				return
			case request, ok = <-s.high:
				if !ok {
					return
				}
			case request, ok = <-s.low:
				if !ok {
					return
				}
			}
		}
		if err := request.ctx.Err(); err != nil {
			request.result <- writeResult{err: err}
			continue
		}
		if request.raw != nil {
			value, err := request.raw(s.db)
			request.result <- writeResult{value: value, err: err}
			continue
		}
		tx, err := s.db.BeginTx(request.ctx, nil)
		if err != nil {
			request.result <- writeResult{err: err}
			continue
		}
		value, err := request.fn(tx)
		if err == nil {
			err = tx.Commit()
		} else {
			_ = tx.Rollback()
		}
		request.result <- writeResult{value: value, err: err}
	}
}

func (s *Store) writeRaw(ctx context.Context, p priority, fn func(*sql.DB) (any, error)) (any, error) {
	s.lifecycle.RLock()
	defer s.lifecycle.RUnlock()
	if s.closed.Load() {
		return nil, ErrClosed
	}
	request := writeRequest{ctx: ctx, priority: p, raw: fn, result: make(chan writeResult, 1)}
	queue := s.high
	if p == priorityLow {
		queue = s.low
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-s.stop:
		return nil, ErrClosed
	case queue <- request:
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case result := <-request.result:
		return result.value, result.err
	}
}

func (s *Store) write(ctx context.Context, p priority, fn func(*sql.Tx) (any, error)) (any, error) {
	s.lifecycle.RLock()
	defer s.lifecycle.RUnlock()
	if s.closed.Load() {
		return nil, ErrClosed
	}
	request := writeRequest{ctx: ctx, priority: p, fn: fn, result: make(chan writeResult, 1)}
	queue := s.high
	if p == priorityLow {
		queue = s.low
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-s.stop:
		return nil, ErrClosed
	case queue <- request:
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case result := <-request.result:
		return result.value, result.err
	}
}

// Admin is an authenticated manager administrator.
type Admin struct {
	ID           int64     `json:"id"`
	Username     string    `json:"username"`
	DisplayName  string    `json:"display_name"`
	Role         string    `json:"role"`
	PasswordHash string    `json:"-"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

func (s *Store) IsSetup(ctx context.Context) (bool, error) {
	var count int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM admins`).Scan(&count)
	return count > 0, err
}

func (s *Store) CreateInitialAdmin(ctx context.Context, username, displayName, passwordHash string, settings map[string]string) (Admin, error) {
	username = strings.TrimSpace(username)
	displayName = strings.TrimSpace(displayName)
	if username == "" || displayName == "" || passwordHash == "" {
		return Admin{}, errors.New("username, display name and password hash are required")
	}
	value, err := s.write(ctx, priorityHigh, func(tx *sql.Tx) (any, error) {
		var count int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM admins`).Scan(&count); err != nil {
			return nil, err
		}
		if count != 0 {
			return nil, fmt.Errorf("%w: initial setup is already complete", ErrConflict)
		}
		now := time.Now().UTC()
		result, err := tx.ExecContext(ctx, `INSERT INTO admins(username,display_name,role,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?)`, username, displayName, "admin", passwordHash, unix(now), unix(now))
		if err != nil {
			return nil, err
		}
		for key, setting := range settings {
			if strings.TrimSpace(key) == "" {
				return nil, errors.New("setup setting key is required")
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, key, setting, unix(now)); err != nil {
				return nil, err
			}
		}
		id, err := result.LastInsertId()
		return Admin{ID: id, Username: username, DisplayName: displayName, Role: "admin", PasswordHash: passwordHash, CreatedAt: now, UpdatedAt: now}, err
	})
	if err != nil {
		return Admin{}, err
	}
	return value.(Admin), nil
}

func (s *Store) AdminByUsername(ctx context.Context, username string) (Admin, error) {
	var admin Admin
	var created, updated int64
	err := s.db.QueryRowContext(ctx, `SELECT id,username,display_name,role,password_hash,created_at,updated_at FROM admins WHERE username=?`, username).
		Scan(&admin.ID, &admin.Username, &admin.DisplayName, &admin.Role, &admin.PasswordHash, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return Admin{}, ErrNotFound
	}
	admin.CreatedAt = fromUnix(created)
	admin.UpdatedAt = fromUnix(updated)
	return admin, err
}

// Session stores only digests of browser credentials.
type Session struct {
	TokenHash            string
	CSRFHash             string
	AdminID              int64
	Username             string
	CreatedAt            time.Time
	LastSeenAt           time.Time
	ExpiresAt            time.Time
	ReauthenticatedUntil *time.Time
}

func (s *Store) CreateSession(ctx context.Context, session Session) error {
	_, err := s.write(ctx, priorityHigh, func(tx *sql.Tx) (any, error) {
		_, err := tx.ExecContext(ctx, `INSERT INTO sessions(token_hash,csrf_hash,admin_id,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,?)`,
			session.TokenHash, session.CSRFHash, session.AdminID, unix(session.CreatedAt), unix(session.LastSeenAt), unix(session.ExpiresAt))
		return nil, err
	})
	return err
}

func (s *Store) Session(ctx context.Context, tokenHash string) (Session, error) {
	var session Session
	var created, seen, expires int64
	var reauthenticated sql.NullInt64
	err := s.db.QueryRowContext(ctx, `SELECT s.token_hash,s.csrf_hash,s.admin_id,a.username,s.created_at,s.last_seen_at,s.expires_at,s.reauthenticated_until
		FROM sessions s JOIN admins a ON a.id=s.admin_id WHERE s.token_hash=?`, tokenHash).
		Scan(&session.TokenHash, &session.CSRFHash, &session.AdminID, &session.Username, &created, &seen, &expires, &reauthenticated)
	if errors.Is(err, sql.ErrNoRows) {
		return Session{}, ErrNotFound
	}
	session.CreatedAt, session.LastSeenAt, session.ExpiresAt = fromUnix(created), fromUnix(seen), fromUnix(expires)
	if reauthenticated.Valid {
		value := fromUnix(reauthenticated.Int64)
		session.ReauthenticatedUntil = &value
	}
	return session, err
}

func (s *Store) MarkSessionReauthenticated(ctx context.Context, tokenHash string, until time.Time) error {
	_, err := s.write(ctx, priorityHigh, func(tx *sql.Tx) (any, error) {
		result, err := tx.ExecContext(ctx, `UPDATE sessions SET reauthenticated_until=? WHERE token_hash=? AND expires_at>?`, unix(until), tokenHash, unix(time.Now()))
		if err != nil {
			return nil, err
		}
		changed, _ := result.RowsAffected()
		if changed != 1 {
			return nil, ErrNotFound
		}
		return nil, nil
	})
	return err
}

func (s *Store) TouchSession(ctx context.Context, tokenHash string, now time.Time) error {
	_, err := s.write(ctx, priorityLow, func(tx *sql.Tx) (any, error) {
		_, err := tx.ExecContext(ctx, `UPDATE sessions SET last_seen_at=? WHERE token_hash=?`, unix(now), tokenHash)
		return nil, err
	})
	return err
}

func (s *Store) DeleteSession(ctx context.Context, tokenHash string) error {
	_, err := s.write(ctx, priorityHigh, func(tx *sql.Tx) (any, error) {
		_, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash=?`, tokenHash)
		return nil, err
	})
	return err
}

// Enrollment is a time-limited CSR approval request.
type Enrollment struct {
	ID                string          `json:"id"`
	AgentName         string          `json:"agent_name"`
	CSRPEM            string          `json:"-"`
	Fingerprint       string          `json:"fingerprint"`
	VerificationCode  string          `json:"verification_code"`
	SourceIP          string          `json:"source_ip"`
	Inventory         json.RawMessage `json:"inventory"`
	Version           string          `json:"version"`
	Status            string          `json:"status"`
	CreatedAt         time.Time       `json:"created_at"`
	ExpiresAt         time.Time       `json:"expires_at"`
	ReviewedAt        *time.Time      `json:"reviewed_at,omitempty"`
	ReviewedBy        *int64          `json:"reviewed_by,omitempty"`
	AgentID           string          `json:"agent_id,omitempty"`
	CertificatePEM    string          `json:"-"`
	CertificateSerial string          `json:"-"`
	DecisionReason    string          `json:"decision_reason,omitempty"`
}

func (s *Store) EnrollmentRateCount(ctx context.Context, sourceIP string, since time.Time) (int, error) {
	var count int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM enrollment_requests WHERE source_ip=? AND created_at>=?`, sourceIP, unix(since)).Scan(&count)
	return count, err
}

func (s *Store) CreateEnrollment(ctx context.Context, enrollment Enrollment) error {
	if !json.Valid(enrollment.Inventory) {
		return errors.New("inventory must be valid JSON")
	}
	_, err := s.write(ctx, priorityHigh, func(tx *sql.Tx) (any, error) {
		var duplicate int
		if err := tx.QueryRowContext(ctx, `SELECT
			(SELECT COUNT(*) FROM enrollment_requests WHERE fingerprint=? AND status='pending_approval' AND expires_at>?) +
			(SELECT COUNT(*) FROM agents WHERE fingerprint=?)`, enrollment.Fingerprint, unix(time.Now()), enrollment.Fingerprint).Scan(&duplicate); err != nil {
			return nil, err
		}
		if duplicate != 0 {
			return nil, fmt.Errorf("%w: this enrollment key is already pending or has been used", ErrConflict)
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO enrollment_requests
			(id,agent_name,csr_pem,fingerprint,verification_code,source_ip,inventory_json,agent_version,status,created_at,expires_at)
			VALUES(?,?,?,?,?,?,?,?,?,?,?)`, enrollment.ID, enrollment.AgentName, enrollment.CSRPEM, enrollment.Fingerprint,
			enrollment.VerificationCode, enrollment.SourceIP, string(enrollment.Inventory), enrollment.Version, "pending_approval", unix(enrollment.CreatedAt), unix(enrollment.ExpiresAt))
		return nil, err
	})
	return err
}

func scanEnrollment(scanner interface{ Scan(...any) error }) (Enrollment, error) {
	var enrollment Enrollment
	var inventory string
	var created, expires int64
	var reviewed sql.NullInt64
	var reviewedBy sql.NullInt64
	err := scanner.Scan(&enrollment.ID, &enrollment.AgentName, &enrollment.CSRPEM, &enrollment.Fingerprint,
		&enrollment.VerificationCode, &enrollment.SourceIP, &inventory, &enrollment.Version, &enrollment.Status,
		&created, &expires, &reviewed, &reviewedBy, &enrollment.AgentID, &enrollment.CertificatePEM, &enrollment.CertificateSerial, &enrollment.DecisionReason)
	if err != nil {
		return Enrollment{}, err
	}
	enrollment.Inventory = json.RawMessage(inventory)
	enrollment.CreatedAt, enrollment.ExpiresAt = fromUnix(created), fromUnix(expires)
	if reviewed.Valid {
		value := fromUnix(reviewed.Int64)
		enrollment.ReviewedAt = &value
	}
	if reviewedBy.Valid {
		enrollment.ReviewedBy = &reviewedBy.Int64
	}
	return enrollment, nil
}

const enrollmentColumns = `id,agent_name,csr_pem,fingerprint,verification_code,source_ip,inventory_json,agent_version,status,created_at,expires_at,reviewed_at,reviewed_by,COALESCE(agent_id,''),COALESCE(certificate_pem,''),COALESCE(certificate_serial,''),COALESCE(decision_reason,'')`

func (s *Store) Enrollment(ctx context.Context, id string) (Enrollment, error) {
	enrollment, err := scanEnrollment(s.db.QueryRowContext(ctx, `SELECT `+enrollmentColumns+` FROM enrollment_requests WHERE id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Enrollment{}, ErrNotFound
	}
	return enrollment, err
}

func (s *Store) PendingEnrollments(ctx context.Context) ([]Enrollment, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+enrollmentColumns+` FROM enrollment_requests WHERE status='pending_approval' ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []Enrollment
	for rows.Next() {
		enrollment, err := scanEnrollment(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, enrollment)
	}
	return result, rows.Err()
}

// ApproveEnrollment atomically approves the request and creates its agent identity.
func (s *Store) ApproveEnrollment(ctx context.Context, requestID string, reviewerID int64, agent Agent, certificatePEM, serial string) error {
	_, err := s.write(ctx, priorityHigh, func(tx *sql.Tx) (any, error) {
		var status string
		var expires int64
		if err := tx.QueryRowContext(ctx, `SELECT status,expires_at FROM enrollment_requests WHERE id=?`, requestID).Scan(&status, &expires); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return nil, ErrNotFound
			}
			return nil, err
		}
		if status != "pending_approval" || expires <= unix(time.Now()) {
			return nil, fmt.Errorf("%w: request is not pending", ErrConflict)
		}
		now := time.Now().UTC()
		if _, err := tx.ExecContext(ctx, `INSERT INTO agents(id,name,certificate_serial,certificate_pem,fingerprint,agent_version,status,inventory_json,created_at)
			VALUES(?,?,?,?,?,?,?,?,?)`, agent.ID, agent.Name, serial, certificatePEM, agent.Fingerprint, agent.Version, "approved", string(agent.Inventory), unix(now)); err != nil {
			return nil, err
		}
		result, err := tx.ExecContext(ctx, `UPDATE enrollment_requests SET status='approved',reviewed_at=?,reviewed_by=?,agent_id=?,certificate_pem=?,certificate_serial=? WHERE id=? AND status='pending_approval'`,
			unix(now), reviewerID, agent.ID, certificatePEM, serial, requestID)
		if err != nil {
			return nil, err
		}
		changed, _ := result.RowsAffected()
		if changed != 1 {
			return nil, fmt.Errorf("%w: enrollment changed concurrently", ErrConflict)
		}
		return nil, nil
	})
	return err
}

func (s *Store) RejectEnrollment(ctx context.Context, requestID string, reviewerID int64, reason string) error {
	_, err := s.write(ctx, priorityHigh, func(tx *sql.Tx) (any, error) {
		result, err := tx.ExecContext(ctx, `UPDATE enrollment_requests SET status='rejected',reviewed_at=?,reviewed_by=?,decision_reason=? WHERE id=? AND status='pending_approval'`, unix(time.Now()), reviewerID, reason, requestID)
		if err != nil {
			return nil, err
		}
		changed, _ := result.RowsAffected()
		if changed != 1 {
			return nil, fmt.Errorf("%w: request is not pending", ErrConflict)
		}
		return nil, nil
	})
	return err
}

func (s *Store) ExpireEnrollments(ctx context.Context, now time.Time) (int64, error) {
	value, err := s.write(ctx, priorityHigh, func(tx *sql.Tx) (any, error) {
		result, err := tx.ExecContext(ctx, `UPDATE enrollment_requests SET status='expired' WHERE status='pending_approval' AND expires_at<=?`, unix(now))
		if err != nil {
			return int64(0), err
		}
		return result.RowsAffected()
	})
	if err != nil {
		return 0, err
	}
	return value.(int64), nil
}

// Agent is an enrolled daemon identity.
type Agent struct {
	ID                       string          `json:"id"`
	Name                     string          `json:"name"`
	CertificateSerial        string          `json:"certificate_serial,omitempty"`
	Fingerprint              string          `json:"fingerprint"`
	Version                  string          `json:"version"`
	Status                   string          `json:"status"`
	Inventory                json.RawMessage `json:"inventory"`
	LastSeen                 *time.Time      `json:"last_seen,omitempty"`
	CreatedAt                time.Time       `json:"created_at"`
	RevokedAt                *time.Time      `json:"revoked_at,omitempty"`
	RevocationReason         string          `json:"-"`
	RevokedBy                *int64          `json:"-"`
	RevocationIdempotencyKey string          `json:"-"`
}

const agentColumns = `id,name,certificate_serial,fingerprint,agent_version,status,inventory_json,last_seen,created_at,revoked_at,COALESCE(revocation_reason,''),revoked_by,COALESCE(revocation_idempotency_key,'')`

func scanAgent(scanner interface{ Scan(...any) error }) (Agent, error) {
	var agent Agent
	var inventory string
	var lastSeen, revoked, revokedBy sql.NullInt64
	var created int64
	err := scanner.Scan(&agent.ID, &agent.Name, &agent.CertificateSerial, &agent.Fingerprint, &agent.Version, &agent.Status, &inventory, &lastSeen, &created, &revoked, &agent.RevocationReason, &revokedBy, &agent.RevocationIdempotencyKey)
	if err != nil {
		return Agent{}, err
	}
	agent.Inventory, agent.CreatedAt = json.RawMessage(inventory), fromUnix(created)
	if lastSeen.Valid {
		value := fromUnix(lastSeen.Int64)
		agent.LastSeen = &value
	}
	if revoked.Valid {
		value := fromUnix(revoked.Int64)
		agent.RevokedAt = &value
	}
	if revokedBy.Valid {
		agent.RevokedBy = &revokedBy.Int64
	}
	return agent, nil
}

func (s *Store) Agents(ctx context.Context) ([]Agent, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+agentColumns+` FROM agents ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []Agent
	for rows.Next() {
		agent, err := scanAgent(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, agent)
	}
	return result, rows.Err()
}

func (s *Store) AgentBySerial(ctx context.Context, serial string) (Agent, error) {
	agent, err := scanAgent(s.db.QueryRowContext(ctx, `SELECT `+agentColumns+` FROM agents WHERE certificate_serial=?`, serial))
	if errors.Is(err, sql.ErrNoRows) {
		return Agent{}, ErrNotFound
	}
	return agent, err
}

func (s *Store) AgentByID(ctx context.Context, id string) (Agent, error) {
	agent, err := scanAgent(s.db.QueryRowContext(ctx, `SELECT `+agentColumns+` FROM agents WHERE id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Agent{}, ErrNotFound
	}
	return agent, err
}

// RecordHeartbeat persists inventory and last_seen at most once a minute. The
// caller may keep more frequent heartbeat timestamps in memory.
func (s *Store) RecordHeartbeat(ctx context.Context, agentID, version string, inventory json.RawMessage, now time.Time) error {
	if !json.Valid(inventory) {
		return errors.New("invalid inventory JSON")
	}
	_, err := s.write(ctx, priorityLow, func(tx *sql.Tx) (any, error) {
		result, err := tx.ExecContext(ctx, `UPDATE agents SET status='online',agent_version=?,inventory_json=?,last_seen=?
			WHERE id=? AND revoked_at IS NULL AND (last_seen IS NULL OR last_seen<=?)`, version, string(inventory), unix(now), agentID, unix(now.Add(-time.Minute)))
		if err != nil {
			return nil, err
		}
		changed, _ := result.RowsAffected()
		if changed == 0 {
			var valid int
			if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM agents WHERE id=? AND revoked_at IS NULL`, agentID).Scan(&valid); err != nil {
				return nil, err
			}
			if valid == 0 {
				return nil, ErrNotFound
			}
		}
		return nil, nil
	})
	return err
}

func (s *Store) RevokeAgent(ctx context.Context, agentID, reason string, reviewerID int64, idempotencyKey string) (Agent, bool, error) {
	reason = strings.TrimSpace(reason)
	if reason == "" || len(reason) > 512 {
		return Agent{}, false, errors.New("revocation reason must contain 1 to 512 characters")
	}
	if len(idempotencyKey) < 8 || len(idempotencyKey) > 128 {
		return Agent{}, false, errors.New("invalid revocation idempotency key")
	}
	value, err := s.write(ctx, priorityHigh, func(tx *sql.Tx) (any, error) {
		agent, err := scanAgent(tx.QueryRowContext(ctx, `SELECT `+agentColumns+` FROM agents WHERE id=?`, agentID))
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		if err != nil {
			return nil, err
		}
		if agent.RevokedAt != nil {
			if agent.RevocationIdempotencyKey == idempotencyKey {
				return struct {
					Agent   Agent
					Changed bool
				}{Agent: agent}, nil
			}
			return nil, fmt.Errorf("%w: agent is already revoked", ErrConflict)
		}
		now := time.Now().UTC()
		_, err = tx.ExecContext(ctx, `UPDATE agents SET status='revoked',revoked_at=?,revocation_reason=?,revoked_by=?,revocation_idempotency_key=? WHERE id=? AND revoked_at IS NULL`, unix(now), reason, reviewerID, idempotencyKey, agentID)
		if err != nil {
			return nil, err
		}
		agent.Status = "revoked"
		agent.RevokedAt = &now
		agent.RevocationReason = reason
		agent.RevokedBy = &reviewerID
		agent.RevocationIdempotencyKey = idempotencyKey
		return struct {
			Agent   Agent
			Changed bool
		}{Agent: agent, Changed: true}, nil
	})
	if err != nil {
		return Agent{}, false, err
	}
	result := value.(struct {
		Agent   Agent
		Changed bool
	})
	return result.Agent, result.Changed, nil
}

// DockerHost describes a local socket or strict-host-key SSH connector.
type DockerHost struct {
	ID            string     `json:"id"`
	Name          string     `json:"name"`
	Kind          string     `json:"kind"`
	Endpoint      string     `json:"endpoint"`
	SSHHostKey    string     `json:"ssh_host_key,omitempty"`
	SSHCredential string     `json:"-"`
	Status        string     `json:"status"`
	DockerVersion string     `json:"docker_version,omitempty"`
	LastCheckedAt *time.Time `json:"last_checked_at,omitempty"`
	CreatedAt     time.Time  `json:"created_at"`
}

func (s *Store) UpsertDockerHost(ctx context.Context, host DockerHost) error {
	if host.Kind != "local" && host.Kind != "ssh" {
		return errors.New("Docker host kind must be local or ssh")
	}
	_, err := s.write(ctx, priorityHigh, func(tx *sql.Tx) (any, error) {
		return nil, upsertDockerHostTx(ctx, tx, host)
	})
	return err
}

func upsertDockerHostTx(ctx context.Context, tx *sql.Tx, host DockerHost) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO docker_hosts(id,name,kind,endpoint,ssh_host_key,ssh_credential_ref,status,docker_version,last_checked_at,created_at)
		VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,endpoint=excluded.endpoint,ssh_host_key=excluded.ssh_host_key,ssh_credential_ref=excluded.ssh_credential_ref,status=excluded.status,docker_version=excluded.docker_version,last_checked_at=excluded.last_checked_at`,
		host.ID, host.Name, host.Kind, host.Endpoint, host.SSHHostKey, host.SSHCredential, host.Status, host.DockerVersion, nullableUnix(host.LastCheckedAt), unix(host.CreatedAt))
	return err
}

// IdempotencyReplay is the exact response committed for a prior mutation.
type IdempotencyReplay struct {
	StatusCode int
	Response   json.RawMessage
}

// ReplayIdempotency returns a prior response, or ErrConflict when a key was
// reused for another intent. Expired records are replaced only by a later
// atomic commit.
func (s *Store) ReplayIdempotency(ctx context.Context, key, operation, requestHash string, now time.Time) (IdempotencyReplay, bool, error) {
	var storedOperation, storedHash, response string
	var status int
	var expires int64
	err := s.db.QueryRowContext(ctx, `SELECT operation,request_hash,status_code,response_json,expires_at FROM idempotency_records WHERE idempotency_key=?`, key).
		Scan(&storedOperation, &storedHash, &status, &response, &expires)
	if errors.Is(err, sql.ErrNoRows) || err == nil && expires <= unix(now) {
		return IdempotencyReplay{}, false, nil
	}
	if err != nil {
		return IdempotencyReplay{}, false, err
	}
	if storedOperation != operation || storedHash != requestHash {
		return IdempotencyReplay{}, false, fmt.Errorf("%w: idempotency key belongs to another intent", ErrConflict)
	}
	if status < 100 || status > 599 || !json.Valid([]byte(response)) {
		return IdempotencyReplay{}, false, errors.New("stored idempotency response is invalid")
	}
	return IdempotencyReplay{StatusCode: status, Response: json.RawMessage(response)}, true, nil
}

// UpsertDockerHostIdempotent commits the host and its exact replay response in
// one transaction. The key is retained for at least 24 hours by the caller.
func (s *Store) UpsertDockerHostIdempotent(ctx context.Context, host DockerHost, key, operation, requestHash string, statusCode int, response json.RawMessage, now time.Time) error {
	if host.Kind != "local" && host.Kind != "ssh" {
		return errors.New("Docker host kind must be local or ssh")
	}
	if len(key) < 8 || len(key) > 128 || strings.TrimSpace(key) != key || operation == "" || len(operation) > 128 {
		return errors.New("invalid idempotency identity")
	}
	if len(requestHash) != 64 {
		return errors.New("invalid idempotency request hash")
	}
	if _, err := hex.DecodeString(requestHash); err != nil {
		return errors.New("invalid idempotency request hash")
	}
	if statusCode < 100 || statusCode > 599 || !json.Valid(response) || len(response) > 1<<20 {
		return errors.New("invalid idempotency response")
	}
	_, err := s.write(ctx, priorityHigh, func(tx *sql.Tx) (any, error) {
		if _, err := tx.ExecContext(ctx, `DELETE FROM idempotency_records WHERE idempotency_key=? AND expires_at<=?`, key, unix(now)); err != nil {
			return nil, err
		}
		if err := upsertDockerHostTx(ctx, tx, host); err != nil {
			return nil, err
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO idempotency_records(idempotency_key,operation,request_hash,status_code,response_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?)`, key, operation, requestHash, statusCode, string(response), unix(now), unix(now.Add(24*time.Hour)))
		return nil, err
	})
	return err
}

func (s *Store) DeleteExpiredIdempotency(ctx context.Context, now time.Time) (int64, error) {
	value, err := s.write(ctx, priorityLow, func(tx *sql.Tx) (any, error) {
		result, err := tx.ExecContext(ctx, `DELETE FROM idempotency_records WHERE expires_at<=?`, unix(now))
		if err != nil {
			return int64(0), err
		}
		return result.RowsAffected()
	})
	if err != nil {
		return 0, err
	}
	return value.(int64), nil
}

func (s *Store) DockerHosts(ctx context.Context) ([]DockerHost, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,name,kind,endpoint,ssh_host_key,ssh_credential_ref,status,docker_version,last_checked_at,created_at FROM docker_hosts ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []DockerHost
	for rows.Next() {
		var host DockerHost
		var checked sql.NullInt64
		var created int64
		if err := rows.Scan(&host.ID, &host.Name, &host.Kind, &host.Endpoint, &host.SSHHostKey, &host.SSHCredential, &host.Status, &host.DockerVersion, &checked, &created); err != nil {
			return nil, err
		}
		host.CreatedAt = fromUnix(created)
		if checked.Valid {
			value := fromUnix(checked.Int64)
			host.LastCheckedAt = &value
		}
		result = append(result, host)
	}
	return result, rows.Err()
}

// Event is a persisted cursor-addressable state change.
type Event struct {
	Cursor    int64           `json:"-"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
	CreatedAt time.Time       `json:"-"`
}

func (e Event) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		Cursor     string          `json:"cursor"`
		Type       string          `json:"type"`
		OccurredAt time.Time       `json:"occurred_at"`
		Payload    json.RawMessage `json:"payload,omitempty"`
	}{Cursor: strconv.FormatInt(e.Cursor, 10), Type: e.Type, OccurredAt: e.CreatedAt, Payload: e.Payload})
}

func (s *Store) AppendEvent(ctx context.Context, eventType string, payload json.RawMessage) (Event, error) {
	if !json.Valid(payload) {
		return Event{}, errors.New("invalid event payload")
	}
	value, err := s.write(ctx, priorityHigh, func(tx *sql.Tx) (any, error) {
		now := time.Now().UTC()
		result, err := tx.ExecContext(ctx, `INSERT INTO events(event_type,payload_json,created_at) VALUES(?,?,?)`, eventType, string(payload), unix(now))
		if err != nil {
			return nil, err
		}
		cursor, err := result.LastInsertId()
		return Event{Cursor: cursor, Type: eventType, Payload: payload, CreatedAt: now}, err
	})
	if err != nil {
		return Event{}, err
	}
	return value.(Event), nil
}

func (s *Store) EventsSince(ctx context.Context, cursor int64, limit int) ([]Event, int64, error) {
	if limit < 1 || limit > 4096 {
		limit = 1024
	}
	var minimum sql.NullInt64
	if err := s.db.QueryRowContext(ctx, `SELECT MIN(cursor) FROM events`).Scan(&minimum); err != nil {
		return nil, 0, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT cursor,event_type,payload_json,created_at FROM events WHERE cursor>? ORDER BY cursor LIMIT ?`, cursor, limit)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var result []Event
	for rows.Next() {
		var event Event
		var payload string
		var created int64
		if err := rows.Scan(&event.Cursor, &event.Type, &payload, &created); err != nil {
			return nil, 0, err
		}
		event.Payload, event.CreatedAt = json.RawMessage(payload), fromUnix(created)
		result = append(result, event)
	}
	minimumCursor := int64(0)
	if minimum.Valid {
		minimumCursor = minimum.Int64
	}
	return result, minimumCursor, rows.Err()
}

func (s *Store) LatestEventCursor(ctx context.Context) (int64, error) {
	var cursor int64
	err := s.db.QueryRowContext(ctx, `SELECT COALESCE(MAX(cursor),0) FROM events`).Scan(&cursor)
	return cursor, err
}

// Checkpoint performs a bounded passive WAL checkpoint.
func (s *Store) Checkpoint(ctx context.Context) error {
	_, err := s.writeRaw(ctx, priorityLow, func(database *sql.DB) (any, error) {
		_, err := database.ExecContext(ctx, `PRAGMA wal_checkpoint(PASSIVE)`)
		return nil, err
	})
	return err
}

// Backup creates a consistent snapshot with SQLite's online backup API. The
// operation is placed on the sole-writer queue and never overwrites a backup.
func (s *Store) Backup(ctx context.Context, destination string) error {
	if !filepath.IsAbs(destination) {
		return errors.New("backup destination must be absolute")
	}
	if _, err := os.Stat(destination); err == nil {
		return errors.New("backup destination already exists")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return err
	}
	_, err := s.writeRaw(ctx, priorityHigh, func(database *sql.DB) (any, error) {
		connection, err := database.Conn(ctx)
		if err != nil {
			return nil, err
		}
		defer connection.Close()
		err = connection.Raw(func(driverConnection any) error {
			backuper, ok := driverConnection.(interface {
				NewBackup(string) (*sqlite.Backup, error)
			})
			if !ok {
				return errors.New("SQLite driver does not expose online backup API")
			}
			backup, err := backuper.NewBackup(destination)
			if err != nil {
				return err
			}
			for more := true; more; {
				if err := ctx.Err(); err != nil {
					_ = backup.Finish()
					return err
				}
				more, err = backup.Step(128)
				if err != nil {
					_ = backup.Finish()
					return err
				}
			}
			return backup.Finish()
		})
		return nil, err
	})
	return err
}

func unix(value time.Time) int64     { return value.UTC().Unix() }
func fromUnix(value int64) time.Time { return time.Unix(value, 0).UTC() }
func nullableUnix(value *time.Time) any {
	if value == nil {
		return nil
	}
	return unix(*value)
}

const schema = `
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1,unixepoch());
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS admins(
	 id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
	 display_name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','operator','viewer')),
	 password_hash TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
 token_hash TEXT PRIMARY KEY, csrf_hash TEXT NOT NULL, admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
	 created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, reauthenticated_until INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS enrollment_requests(
 id TEXT PRIMARY KEY, agent_name TEXT NOT NULL, csr_pem TEXT NOT NULL, fingerprint TEXT NOT NULL,
 verification_code TEXT NOT NULL, source_ip TEXT NOT NULL, inventory_json TEXT NOT NULL, agent_version TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending_approval','approved','rejected','expired')),
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, reviewed_at INTEGER, reviewed_by INTEGER REFERENCES admins(id),
 agent_id TEXT, certificate_pem TEXT, certificate_serial TEXT, decision_reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS enrollment_pending ON enrollment_requests(status,expires_at);
CREATE INDEX IF NOT EXISTS enrollment_source ON enrollment_requests(source_ip,created_at);
CREATE TABLE IF NOT EXISTS agents(
 id TEXT PRIMARY KEY, name TEXT NOT NULL, certificate_serial TEXT NOT NULL UNIQUE, certificate_pem TEXT NOT NULL,
 fingerprint TEXT NOT NULL UNIQUE, agent_version TEXT NOT NULL, status TEXT NOT NULL,
	 inventory_json TEXT NOT NULL, last_seen INTEGER, created_at INTEGER NOT NULL, revoked_at INTEGER,
	 revocation_reason TEXT NOT NULL DEFAULT '', revoked_by INTEGER REFERENCES admins(id),
	 revocation_idempotency_key TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS agent_status ON agents(status,last_seen);
CREATE UNIQUE INDEX IF NOT EXISTS agent_revocation_idempotency
	ON agents(revocation_idempotency_key) WHERE revocation_idempotency_key<>'';
CREATE TABLE IF NOT EXISTS docker_hosts(
 id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN ('local','ssh')),
 endpoint TEXT NOT NULL, ssh_host_key TEXT NOT NULL DEFAULT '', ssh_credential_ref TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
 docker_version TEXT NOT NULL DEFAULT '', last_checked_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS idempotency_records(
 idempotency_key TEXT PRIMARY KEY, operation TEXT NOT NULL, request_hash TEXT NOT NULL,
 status_code INTEGER NOT NULL, response_json TEXT NOT NULL, created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idempotency_expiry ON idempotency_records(expires_at);
CREATE TABLE IF NOT EXISTS service_definitions(
 id TEXT PRIMARY KEY, name TEXT NOT NULL, catalog_digest TEXT NOT NULL, definition_json TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs(
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, requested_by INTEGER REFERENCES admins(id), idempotency_key TEXT NOT NULL UNIQUE,
 payload_json TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS job_targets(
 job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, target_id TEXT NOT NULL, state TEXT NOT NULL,
 lease_id TEXT, lease_expires_at INTEGER, attempt INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT NOT NULL UNIQUE,
 output TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL,
 PRIMARY KEY(job_id,target_id)
);
CREATE INDEX IF NOT EXISTS target_leases ON job_targets(state,lease_expires_at);
CREATE TABLE IF NOT EXISTS service_state(
 agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, service_id TEXT NOT NULL,
 state_json TEXT NOT NULL, observed_at INTEGER NOT NULL, PRIMARY KEY(agent_id,service_id)
);
CREATE TABLE IF NOT EXISTS metric_aggregates(
 agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, metric TEXT NOT NULL, bucket_seconds INTEGER NOT NULL,
 bucket_at INTEGER NOT NULL, minimum REAL NOT NULL, maximum REAL NOT NULL, average REAL NOT NULL, samples INTEGER NOT NULL,
 PRIMARY KEY(agent_id,metric,bucket_seconds,bucket_at)
);
CREATE TABLE IF NOT EXISTS events(
 cursor INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_created ON events(created_at);
CREATE TABLE IF NOT EXISTS update_markers(
 id TEXT PRIMARY KEY, from_version TEXT NOT NULL, to_version TEXT NOT NULL, state TEXT NOT NULL,
 backup_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
`
