package pki

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"path/filepath"
	"testing"
	"time"
)

func TestEnrollmentCSRAndProof(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: "test-agent"}}, privateKey)
	if err != nil {
		t.Fatal(err)
	}
	csrPEM := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der}))
	csr, fingerprint, err := ParseCSR(csrPEM)
	if err != nil || fingerprint == "" || !publicKey.Equal(csr.PublicKey) {
		t.Fatalf("parse CSR: %v", err)
	}
	requestID := "request-1"
	signature := ed25519.Sign(privateKey, []byte("bored-manager enrollment status:"+requestID))
	if err := VerifyEnrollmentProof(csr, requestID, base64.RawStdEncoding.EncodeToString(signature)); err != nil {
		t.Fatal(err)
	}
}

func TestEnrollmentRejectsNonEd25519CSR(t *testing.T) {
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: "wrong-key-agent"}}, privateKey)
	if err != nil {
		t.Fatal(err)
	}
	csrPEM := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der}))
	if _, _, err := ParseCSR(csrPEM); err == nil {
		t.Fatal("ECDSA enrollment CSR was accepted")
	}
}

func TestCreateCAAndIssueAgentCertificate(t *testing.T) {
	directory := t.TempDir()
	ca, err := EnsureAgentCA(filepath.Join(directory, "ca.crt"), filepath.Join(directory, "ca.key"))
	if err != nil {
		t.Fatal(err)
	}
	_, privateKey, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{}, privateKey)
	csr, _ := x509.ParseCertificateRequest(der)
	certificate, serial, err := ca.SignAgentCSR(csr, "agent-1", 24*time.Hour)
	if err != nil || certificate == "" || serial == "" {
		t.Fatalf("issue certificate: %v", err)
	}
}

func TestWebCertificateReissueKeepsSPKI(t *testing.T) {
	directory := t.TempDir()
	certificatePath := filepath.Join(directory, "web.crt")
	keyPath := filepath.Join(directory, "web.key")
	first, err := EnsureWebCertificate(certificatePath, keyPath, []string{"127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	firstPin, _ := SPKIFingerprint(first)
	second, err := EnsureWebCertificate(certificatePath, keyPath, []string{"127.0.0.1", "192.0.2.10"})
	if err != nil {
		t.Fatal(err)
	}
	secondPin, _ := SPKIFingerprint(second)
	if firstPin != secondPin {
		t.Fatal("SPKI changed during certificate reissue")
	}
	block, _ := pem.Decode(second)
	certificate, _ := x509.ParseCertificate(block.Bytes)
	if err := certificate.VerifyHostname("192.0.2.10"); err != nil {
		t.Fatal(err)
	}
}
