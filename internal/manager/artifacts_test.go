package manager

import (
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestOpenVerifiedAssetServesOnlyPinnedBytes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "install-agent.sh")
	contents := []byte("#!/usr/bin/env bash\nexit 0\n")
	if err := os.WriteFile(path, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	asset := cachedReleaseAsset{Path: path, SHA256: sha256Hex(contents), Size: int64(len(contents))}
	file, _, err := openVerifiedAsset(asset)
	if err != nil {
		t.Fatal(err)
	}
	served, err := io.ReadAll(file)
	file.Close()
	if err != nil || string(served) != string(contents) {
		t.Fatalf("unexpected served bytes %q: %v", served, err)
	}
	if err := os.WriteFile(path, []byte("#!/usr/bin/env bash\necho tampered\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if file, _, err := openVerifiedAsset(asset); err == nil {
		file.Close()
		t.Fatal("artifact changed after verification was accepted")
	}
}

func TestOpenVerifiedAssetRejectsSymlink(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "target.sh")
	link := filepath.Join(directory, "install-agent.sh")
	contents := []byte("signed")
	if err := os.WriteFile(target, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks are unavailable on this test host: %v", err)
	}
	if file, _, err := openVerifiedAsset(cachedReleaseAsset{Path: link, SHA256: sha256Hex(contents), Size: int64(len(contents))}); err == nil {
		file.Close()
		t.Fatal("symlink release artifact was accepted")
	}
}
