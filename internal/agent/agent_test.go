package agent

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/pem"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/FireStarsSoft/Bored-Manager/internal/pki"
)

func TestPendingEnrollmentPersistsAndMatchesLocalCSR(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	csr, err := createCSR("agent-one", privateKey)
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode([]byte(csr))
	digest := sha256.Sum256(block.Bytes)
	fingerprint := pki.Fingerprint(digest[:])
	created := enrollmentCreated{ID: "01890abc-def0-7123-8123-456789abcdef", Status: "pending_approval", Fingerprint: fingerprint, VerificationCode: pki.VerificationCode(fingerprint), ExpiresAt: time.Now().Add(10 * time.Minute).UTC()}
	if err := validateCreatedEnrollment(created, csr, time.Now()); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "pending-enrollment.json")
	if err := persistPendingEnrollment(path, created); err != nil {
		t.Fatal(err)
	}
	loaded, found, err := loadPendingEnrollment(path)
	if err != nil || !found || loaded.ID != created.ID || loaded.Fingerprint != created.Fingerprint {
		t.Fatalf("pending enrollment did not round trip: found=%v enrollment=%+v err=%v", found, loaded, err)
	}
	created.Fingerprint = "00:11"
	if err := validateCreatedEnrollment(created, csr, time.Now()); err == nil {
		t.Fatal("manager fingerprint mismatch was accepted")
	}
}

func TestCertificateValidRequiresConfiguredAgentCA(t *testing.T) {
	directory := t.TempDir()
	keyPath := filepath.Join(directory, "agent.key")
	certificatePath := filepath.Join(directory, "agent.crt")
	caPath := filepath.Join(directory, "ca.crt")
	caKeyPath := filepath.Join(directory, "ca.key")
	privateKey, err := loadOrCreateKey(keyPath)
	if err != nil {
		t.Fatal(err)
	}
	csrPEM, err := createCSR("agent-one", privateKey)
	if err != nil {
		t.Fatal(err)
	}
	csr, _, err := pki.ParseCSR(csrPEM)
	if err != nil {
		t.Fatal(err)
	}
	ca, err := pki.EnsureAgentCA(caPath, caKeyPath)
	if err != nil {
		t.Fatal(err)
	}
	certificatePEM, _, err := ca.SignAgentCSR(csr, "01890abc-def0-7123-8123-456789abcdef", 48*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(certificatePath, []byte(certificatePEM), 0o600); err != nil {
		t.Fatal(err)
	}
	if !certificateValid(certificatePath, keyPath, caPath) {
		t.Fatal("certificate signed by the configured CA was rejected")
	}
	otherCAPath := filepath.Join(directory, "other-ca.crt")
	if _, err := pki.EnsureAgentCA(otherCAPath, filepath.Join(directory, "other-ca.key")); err != nil {
		t.Fatal(err)
	}
	if certificateValid(certificatePath, keyPath, otherCAPath) {
		t.Fatal("certificate signed by another CA was accepted")
	}
}
