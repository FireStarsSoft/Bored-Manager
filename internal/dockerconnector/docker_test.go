package dockerconnector

import (
	"crypto/ed25519"
	"crypto/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

func TestInvalidSSHTargetsRejected(t *testing.T) {
	identity := filepath.Join(t.TempDir(), "identity")
	if err := os.WriteFile(identity, []byte("not-used-by-validation"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, target := range []SSHTarget{
		{Address: "host", Port: 22, IdentityFile: identity},
		{User: "root", Address: "-oProxyCommand=bad", Port: 22, IdentityFile: identity},
		{User: "root", Address: "host command", Port: 22, IdentityFile: identity},
		{User: "root", Address: "host", Port: 0, IdentityFile: identity},
		{User: "root", Address: "host", Port: 22, IdentityFile: "relative-key"},
	} {
		if result := ProbeSSH(t.Context(), target, "/tmp/known_hosts"); result.Error == "" {
			t.Fatalf("accepted %+v", target)
		}
	}
}

func TestValidSSHTarget(t *testing.T) {
	identity := filepath.Join(t.TempDir(), "identity")
	if err := os.WriteFile(identity, []byte("not-used-by-validation"), 0o600); err != nil {
		t.Fatal(err)
	}
	target := SSHTarget{User: "docker-admin", Address: "host.example", Port: 2222, IdentityFile: identity}
	if err := target.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestParseKnownHostLineReturnsVerifiedAlgorithmAndFingerprint(t *testing.T) {
	public, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	key, err := ssh.NewPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	line := "docker.example.invalid " + strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key)))
	parsed, err := ParseKnownHostLine(line)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Algorithm != ssh.KeyAlgoED25519 || parsed.Fingerprint != ssh.FingerprintSHA256(key) {
		t.Fatalf("unexpected parsed host key: %+v", parsed)
	}
	if _, err := ParseKnownHostLine(line + "\n* " + strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key)))); err == nil {
		t.Fatal("multiple known_hosts lines were accepted")
	}
}
