// Package clienttls implements exact SPKI pinning for bootstrap connections.
package clienttls

import (
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"

	"github.com/FireStarsSoft/Bored-Manager/internal/pki"
)

// PinnedConfig verifies the leaf SubjectPublicKeyInfo against an out-of-band
// SHA-256 fingerprint. Standard chain verification is intentionally replaced
// only for the self-signed bootstrap endpoint.
func PinnedConfig(pin string, certificate *tls.Certificate) (*tls.Config, error) {
	want := normalize(pin)
	if want == "" {
		return nil, errors.New("manager SPKI pin is required")
	}
	config := &tls.Config{MinVersion: tls.VersionTLS13, InsecureSkipVerify: true} // verification is performed below
	if certificate != nil {
		config.Certificates = []tls.Certificate{*certificate}
	}
	config.VerifyConnection = func(state tls.ConnectionState) error {
		if len(state.PeerCertificates) == 0 {
			return errors.New("manager did not present a certificate")
		}
		digest := sha256.Sum256(state.PeerCertificates[0].RawSubjectPublicKeyInfo)
		got := normalize(pki.Fingerprint(digest[:]))
		if subtle.ConstantTimeCompare([]byte(got), []byte(want)) != 1 {
			return errors.New("manager SPKI fingerprint mismatch")
		}
		return nil
	}
	return config, nil
}

func normalize(value string) string {
	value = strings.TrimSpace(value)
	if strings.HasPrefix(strings.ToLower(value), "sha256//") {
		raw, err := base64.StdEncoding.DecodeString(value[len("sha256//"):])
		if err == nil && len(raw) == sha256.Size {
			return strings.ToUpper(hex.EncodeToString(raw))
		}
	}
	value = strings.ToUpper(value)
	value = strings.TrimPrefix(value, "SHA256:")
	value = strings.ReplaceAll(value, ":", "")
	return value
}
