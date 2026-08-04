package config

import "testing"

func TestManagerConfigValidation(t *testing.T) {
	cfg := DefaultManager()
	cfg.StateDir = t.TempDir()
	cfg.CacheDir = t.TempDir()
	cfg.RuntimeDir = t.TempDir()
	cfg.DatabasePath = cfg.StateDir + "/manager.db"
	if err := cfg.Validate(); err != nil {
		t.Fatalf("default config should validate: %v", err)
	}
	cfg.WebPort = 443
	if err := cfg.Validate(); err == nil {
		t.Fatal("privileged manager port was accepted without a service capability")
	}
	cfg = DefaultManager()
	cfg.BindAddress = "not-an-ip"
	if err := cfg.Validate(); err == nil {
		t.Fatal("invalid address was accepted")
	}
	cfg = DefaultManager()
	for _, size := range []int{0, 15, 4096, 1 << 30} {
		cfg.EventBuffer = size
		if err := cfg.Validate(); err == nil {
			t.Fatalf("event buffer size %d was accepted", size)
		}
	}
}

func TestCredentialPathCannotEscapeSystemdDirectory(t *testing.T) {
	cfg := DefaultManager()
	cfg.CredentialsDir = t.TempDir()
	path, err := cfg.CredentialPath("ssh-dockyard-01.key")
	if err != nil || path == "" {
		t.Fatalf("valid credential reference failed: path=%q err=%v", path, err)
	}
	for _, reference := range []string{"", "../key", "nested/key", "key..backup", "-bad key"} {
		if _, err := cfg.CredentialPath(reference); err == nil {
			t.Fatalf("accepted unsafe credential reference %q", reference)
		}
	}
}
