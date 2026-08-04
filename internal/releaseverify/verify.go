// Package releaseverify validates offline Ed25519 release signatures and hashes.
package releaseverify

import (
	"bufio"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// VerifyArtifact requires a valid signature over the exact SHA256SUMS bytes,
// a safe matching entry, and the corresponding artifact digest.
func VerifyArtifact(artifactPath, sumsPath, signaturePath, publicKeyPath string) error {
	artifactAbsolute, err := filepath.Abs(artifactPath)
	if err != nil {
		return err
	}
	sums, err := os.ReadFile(sumsPath)
	if err != nil {
		return fmt.Errorf("read checksums: %w", err)
	}
	if err := VerifyBytes(sums, signaturePath, publicKeyPath); err != nil {
		return fmt.Errorf("verify checksums: %w", err)
	}
	file, err := os.Open(artifactAbsolute)
	if err != nil {
		return err
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return err
	}
	return VerifyDigest(filepath.Base(artifactAbsolute), hex.EncodeToString(digest.Sum(nil)), sums)
}

// VerifyFile verifies an offline Ed25519 signature over the exact bytes of a
// file. Signatures may be raw 64-byte values or standard/raw-base64 text.
func VerifyFile(path, signaturePath, publicKeyPath string) error {
	contents, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read signed file: %w", err)
	}
	return VerifyBytes(contents, signaturePath, publicKeyPath)
}

// VerifyBytes verifies a detached offline Ed25519 signature.
func VerifyBytes(contents []byte, signaturePath, publicKeyPath string) error {
	signatureText, err := os.ReadFile(signaturePath)
	if err != nil {
		return fmt.Errorf("read signature: %w", err)
	}
	return VerifyBytesWithSignature(contents, signatureText, publicKeyPath)
}

// VerifyBytesWithSignature verifies exact content and signature bytes against
// a trusted public-key path. Callers that serve or parse signed metadata can
// retain these same bytes and avoid a path re-read race.
func VerifyBytesWithSignature(contents, signatureText []byte, publicKeyPath string) error {
	publicKey, err := readPublicKey(publicKeyPath)
	if err != nil {
		return err
	}
	signature := signatureText
	if len(signature) != ed25519.SignatureSize {
		signature, err = base64.StdEncoding.DecodeString(strings.TrimSpace(string(signatureText)))
		if err != nil {
			signature, err = base64.RawStdEncoding.DecodeString(strings.TrimSpace(string(signatureText)))
		}
	}
	if err != nil || len(signature) != ed25519.SignatureSize || !ed25519.Verify(publicKey, contents, signature) {
		return errors.New("invalid offline Ed25519 signature")
	}
	return nil
}

// VerifyDigest requires an exact safe filename record in already-authenticated
// SHA256SUMS bytes and compares it to a caller-computed artifact digest.
func VerifyDigest(filename, digest string, sums []byte) error {
	if filepath.Base(filename) != filename || strings.Contains(filename, "..") {
		return errors.New("unsafe artifact filename")
	}
	if len(digest) != sha256.Size*2 {
		return errors.New("invalid artifact digest")
	}
	if _, err := hex.DecodeString(digest); err != nil {
		return errors.New("invalid artifact digest")
	}
	want, found, err := checksumFor(sums, filename)
	if err != nil {
		return err
	}
	if !found {
		return errors.New("artifact is absent from signed SHA256SUMS")
	}
	if !strings.EqualFold(digest, want) {
		return errors.New("artifact checksum mismatch")
	}
	return nil
}

func checksumFor(contents []byte, filename string) (string, bool, error) {
	scanner := bufio.NewScanner(strings.NewReader(string(contents)))
	scanner.Buffer(make([]byte, 4096), 1<<20)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) != 2 || len(fields[0]) != 64 {
			return "", false, errors.New("malformed SHA256SUMS")
		}
		name := strings.TrimPrefix(fields[1], "*")
		if filepath.Base(name) != name || strings.Contains(name, "..") {
			return "", false, errors.New("unsafe filename in SHA256SUMS")
		}
		if name == filename {
			if _, err := hex.DecodeString(fields[0]); err != nil {
				return "", false, errors.New("invalid digest in SHA256SUMS")
			}
			return fields[0], true, nil
		}
	}
	return "", false, scanner.Err()
}

func readPublicKey(path string) (ed25519.PublicKey, error) {
	contents, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read release public key: %w", err)
	}
	if block, _ := pem.Decode(contents); block != nil {
		parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
		if err != nil {
			return nil, err
		}
		key, ok := parsed.(ed25519.PublicKey)
		if !ok {
			return nil, errors.New("release key is not Ed25519")
		}
		return key, nil
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(contents)))
	if err != nil {
		raw, err = base64.RawStdEncoding.DecodeString(strings.TrimSpace(string(contents)))
	}
	if err != nil || len(raw) != ed25519.PublicKeySize {
		return nil, errors.New("invalid release Ed25519 public key")
	}
	return ed25519.PublicKey(raw), nil
}
