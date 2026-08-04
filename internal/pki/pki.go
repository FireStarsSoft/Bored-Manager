// Package pki owns the local certificate authorities and enrollment proofs.
package pki

import (
	"crypto"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base32"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// CertificateAuthority is a parsed signing authority.
type CertificateAuthority struct {
	Certificate    *x509.Certificate
	PrivateKey     crypto.Signer
	CertificatePEM []byte
}

// EnsureAgentCA loads or creates the private agent CA. A partial keypair is
// rejected so an operator cannot accidentally rotate agent trust.
func EnsureAgentCA(certificatePath, privateKeyPath string) (*CertificateAuthority, error) {
	certPEM, certErr := os.ReadFile(certificatePath)
	keyPEM, keyErr := os.ReadFile(privateKeyPath)
	if certErr == nil && keyErr == nil {
		return parseCA(certPEM, keyPEM)
	}
	if !errors.Is(certErr, os.ErrNotExist) || !errors.Is(keyErr, os.ErrNotExist) {
		return nil, fmt.Errorf("agent CA is incomplete or unreadable (certificate: %v, key: %v)", certErr, keyErr)
	}
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate CA key: %w", err)
	}
	now := time.Now().UTC()
	template := &x509.Certificate{
		SerialNumber:          randomSerial(),
		Subject:               pkix.Name{CommonName: "Bored Manager Agent CA", Organization: []string{"FireStarsSoft"}},
		NotBefore:             now.Add(-5 * time.Minute),
		NotAfter:              now.AddDate(10, 0, 0),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, privateKey.Public(), privateKey)
	if err != nil {
		return nil, fmt.Errorf("create CA certificate: %w", err)
	}
	certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyDER, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		return nil, fmt.Errorf("marshal CA key: %w", err)
	}
	keyPEM = pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
	if err := writePrivatePair(certificatePath, privateKeyPath, certPEM, keyPEM); err != nil {
		return nil, err
	}
	return parseCA(certPEM, keyPEM)
}

// EnsureWebCertificate loads or creates the web server's self-signed
// certificate. Its SPKI fingerprint is shown during first-run setup.
func EnsureWebCertificate(certificatePath, privateKeyPath string, hosts []string) ([]byte, error) {
	certPEM, certErr := os.ReadFile(certificatePath)
	keyPEM, keyErr := os.ReadFile(privateKeyPath)
	if certErr == nil && keyErr == nil {
		certificate, signer, err := parseIdentity(certPEM, keyPEM)
		if err != nil {
			return nil, fmt.Errorf("parse web TLS identity: %w", err)
		}
		if certificate.NotAfter.After(time.Now().Add(30*24*time.Hour)) && certificateCovers(certificate, hosts) {
			return certPEM, nil
		}
		// Reissue with the existing key so out-of-band SPKI pins remain stable
		// after an administrator changes the bind address or TLS name.
		certPEM, err = issueWebCertificate(signer, hosts)
		if err != nil {
			return nil, err
		}
		if err := os.WriteFile(certificatePath, certPEM, 0o644); err != nil {
			return nil, err
		}
		return certPEM, nil
	}
	if !errors.Is(certErr, os.ErrNotExist) || !errors.Is(keyErr, os.ErrNotExist) {
		return nil, fmt.Errorf("web TLS identity is incomplete or unreadable (certificate: %v, key: %v)", certErr, keyErr)
	}
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	certPEM, err = issueWebCertificate(privateKey, hosts)
	if err != nil {
		return nil, err
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		return nil, err
	}
	keyPEM = pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
	if err := writePrivatePair(certificatePath, privateKeyPath, certPEM, keyPEM); err != nil {
		return nil, err
	}
	return certPEM, nil
}

func issueWebCertificate(privateKey crypto.Signer, hosts []string) ([]byte, error) {
	now := time.Now().UTC()
	template := &x509.Certificate{SerialNumber: randomSerial(), Subject: pkix.Name{CommonName: "Bored Manager"}, NotBefore: now.Add(-5 * time.Minute), NotAfter: now.AddDate(2, 0, 0), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	for _, host := range hosts {
		host = strings.TrimSpace(host)
		if ip := net.ParseIP(host); ip != nil {
			template.IPAddresses = append(template.IPAddresses, ip)
		} else if host != "" {
			template.DNSNames = append(template.DNSNames, host)
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, privateKey.Public(), privateKey)
	if err != nil {
		return nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), nil
}

func parseIdentity(certPEM, keyPEM []byte) (*x509.Certificate, crypto.Signer, error) {
	certBlock, _ := pem.Decode(certPEM)
	keyBlock, _ := pem.Decode(keyPEM)
	if certBlock == nil || keyBlock == nil {
		return nil, nil, errors.New("invalid identity PEM")
	}
	certificate, err := x509.ParseCertificate(certBlock.Bytes)
	if err != nil {
		return nil, nil, err
	}
	parsed, err := x509.ParsePKCS8PrivateKey(keyBlock.Bytes)
	if err != nil {
		return nil, nil, err
	}
	signer, ok := parsed.(crypto.Signer)
	if !ok {
		return nil, nil, errors.New("private key does not implement crypto.Signer")
	}
	certificatePublic, err := x509.MarshalPKIXPublicKey(certificate.PublicKey)
	if err != nil {
		return nil, nil, err
	}
	signerPublic, err := x509.MarshalPKIXPublicKey(signer.Public())
	if err != nil {
		return nil, nil, err
	}
	if !strings.EqualFold(fmt.Sprintf("%x", certificatePublic), fmt.Sprintf("%x", signerPublic)) {
		return nil, nil, errors.New("certificate and private key do not match")
	}
	return certificate, signer, nil
}

func certificateCovers(certificate *x509.Certificate, hosts []string) bool {
	for _, host := range hosts {
		host = strings.TrimSpace(host)
		if host == "" {
			continue
		}
		if err := certificate.VerifyHostname(host); err != nil {
			return false
		}
	}
	return true
}

// ParseCSR validates a PEM CSR and returns it with a stable SHA-256 fingerprint.
func ParseCSR(csrPEM string) (*x509.CertificateRequest, string, error) {
	block, rest := pem.Decode([]byte(csrPEM))
	if block == nil || block.Type != "CERTIFICATE REQUEST" || len(strings.TrimSpace(string(rest))) != 0 {
		return nil, "", errors.New("expected exactly one PEM certificate request")
	}
	csr, err := x509.ParseCertificateRequest(block.Bytes)
	if err != nil {
		return nil, "", fmt.Errorf("parse CSR: %w", err)
	}
	if err := csr.CheckSignature(); err != nil {
		return nil, "", fmt.Errorf("verify CSR: %w", err)
	}
	if _, ok := csr.PublicKey.(ed25519.PublicKey); !ok {
		return nil, "", fmt.Errorf("unsupported enrollment key type %T; Ed25519 is required", csr.PublicKey)
	}
	digest := sha256.Sum256(csr.RawSubjectPublicKeyInfo)
	return csr, Fingerprint(digest[:]), nil
}

// SignAgentCSR issues a short-lived mTLS client certificate for an approved agent.
func (ca *CertificateAuthority) SignAgentCSR(csr *x509.CertificateRequest, agentID string, validity time.Duration) (certificatePEM string, serial string, err error) {
	if validity <= 0 || validity > 397*24*time.Hour {
		return "", "", errors.New("invalid agent certificate validity")
	}
	now := time.Now().UTC()
	serialNumber := randomSerial()
	template := &x509.Certificate{
		SerialNumber: serialNumber,
		Subject:      pkix.Name{CommonName: agentID, Organization: []string{"Bored Manager Agents"}},
		NotBefore:    now.Add(-2 * time.Minute),
		NotAfter:     now.Add(validity),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
		DNSNames:     []string{agentID},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, ca.Certificate, csr.PublicKey, ca.PrivateKey)
	if err != nil {
		return "", "", fmt.Errorf("sign agent certificate: %w", err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), serialNumber.Text(16), nil
}

// VerificationCode is deliberately short and must be compared with the code
// displayed by the agent over a separate trusted channel.
func VerificationCode(fingerprint string) string {
	digest := sha256.Sum256([]byte(fingerprint))
	encoded := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(digest[:5])
	return encoded[:4] + "-" + encoded[4:8]
}

// VerifyEnrollmentProof verifies a challenge signature using the CSR public key.
func VerifyEnrollmentProof(csr *x509.CertificateRequest, requestID, encodedSignature string) error {
	signature, err := base64.RawStdEncoding.DecodeString(encodedSignature)
	if err != nil {
		return errors.New("invalid enrollment proof encoding")
	}
	message := []byte("bored-manager enrollment status:" + requestID)
	switch publicKey := csr.PublicKey.(type) {
	case ed25519.PublicKey:
		if !ed25519.Verify(publicKey, message, signature) {
			return errors.New("invalid enrollment proof")
		}
	default:
		return fmt.Errorf("unsupported enrollment key type %T; Ed25519 is required", csr.PublicKey)
	}
	return nil
}

// SPKIFingerprint returns the SHA-256 pin for a PEM certificate.
func SPKIFingerprint(certificatePEM []byte) (string, error) {
	block, _ := pem.Decode(certificatePEM)
	if block == nil || block.Type != "CERTIFICATE" {
		return "", errors.New("invalid certificate PEM")
	}
	certificate, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(certificate.RawSubjectPublicKeyInfo)
	return Fingerprint(digest[:]), nil
}

// CurlSPKIPin returns curl's sha256//BASE64 representation for installers.
func CurlSPKIPin(certificatePEM []byte) (string, error) {
	block, _ := pem.Decode(certificatePEM)
	if block == nil || block.Type != "CERTIFICATE" {
		return "", errors.New("invalid certificate PEM")
	}
	certificate, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(certificate.RawSubjectPublicKeyInfo)
	return "sha256//" + base64.StdEncoding.EncodeToString(digest[:]), nil
}

// Fingerprint renders bytes in the conventional colon-separated uppercase form.
func Fingerprint(raw []byte) string {
	encoded := strings.ToUpper(fmt.Sprintf("%x", raw))
	var result strings.Builder
	for index := 0; index < len(encoded); index += 2 {
		if index > 0 {
			result.WriteByte(':')
		}
		result.WriteString(encoded[index : index+2])
	}
	return result.String()
}

func parseCA(certPEM, keyPEM []byte) (*CertificateAuthority, error) {
	certBlock, _ := pem.Decode(certPEM)
	keyBlock, _ := pem.Decode(keyPEM)
	if certBlock == nil || certBlock.Type != "CERTIFICATE" || keyBlock == nil || keyBlock.Type != "PRIVATE KEY" {
		return nil, errors.New("invalid CA PEM data")
	}
	certificate, err := x509.ParseCertificate(certBlock.Bytes)
	if err != nil {
		return nil, err
	}
	key, err := x509.ParsePKCS8PrivateKey(keyBlock.Bytes)
	if err != nil {
		return nil, err
	}
	signer, ok := key.(crypto.Signer)
	if !ok || !certificate.IsCA {
		return nil, errors.New("invalid CA certificate or key")
	}
	publicKey, ok := certificate.PublicKey.(ed25519.PublicKey)
	if !ok || !publicKey.Equal(signer.Public()) {
		return nil, errors.New("CA certificate and private key do not match")
	}
	return &CertificateAuthority{Certificate: certificate, PrivateKey: signer, CertificatePEM: certPEM}, nil
}

func writePrivatePair(certPath, keyPath string, certPEM, keyPEM []byte) error {
	if err := os.MkdirAll(filepath.Dir(certPath), 0o700); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(keyPath), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(keyPath, keyPEM, 0o600); err != nil {
		return fmt.Errorf("write private key: %w", err)
	}
	if err := os.WriteFile(certPath, certPEM, 0o644); err != nil {
		return fmt.Errorf("write certificate: %w", err)
	}
	return nil
}

func randomSerial() *big.Int {
	limit := new(big.Int).Lsh(big.NewInt(1), 128)
	serial, err := rand.Int(rand.Reader, limit)
	if err != nil {
		panic("cryptographic random source unavailable: " + err.Error())
	}
	return serial
}
