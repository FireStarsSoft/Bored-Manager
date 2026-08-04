package releaseverify

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestVerifyArtifact(t *testing.T) {
	directory := t.TempDir()
	artifact := filepath.Join(directory, "bored-manager.deb")
	contents := []byte("package")
	if err := os.WriteFile(artifact, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(contents)
	sums := []byte(fmt.Sprintf("%x  bored-manager.deb\n", digest))
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	signature := ed25519.Sign(private, sums)
	paths := map[string][]byte{"SHA256SUMS": sums, "SHA256SUMS.sig": []byte(base64.StdEncoding.EncodeToString(signature)), "release.pub": []byte(base64.StdEncoding.EncodeToString(public))}
	for name, data := range paths {
		if err := os.WriteFile(filepath.Join(directory, name), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := VerifyArtifact(artifact, filepath.Join(directory, "SHA256SUMS"), filepath.Join(directory, "SHA256SUMS.sig"), filepath.Join(directory, "release.pub")); err != nil {
		t.Fatal(err)
	}
}

func TestVerifyFileAcceptsRawSignatureAndRejectsTampering(t *testing.T) {
	directory := t.TempDir()
	signedPath := filepath.Join(directory, "manifest.json")
	signaturePath := signedPath + ".sig"
	publicKeyPath := filepath.Join(directory, "release.pub")
	contents := []byte(`{"schema_version":1}` + "\n")
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(signedPath, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(signaturePath, ed25519.Sign(private, contents), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(publicKeyPath, []byte(base64.StdEncoding.EncodeToString(public)), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := VerifyFile(signedPath, signaturePath, publicKeyPath); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(signedPath, append(contents, ' '), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := VerifyFile(signedPath, signaturePath, publicKeyPath); err == nil {
		t.Fatal("tampered signed file was accepted")
	}
}
