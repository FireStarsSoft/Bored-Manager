package updatehelper

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestStabilizeArtifactPinsPrivateCopy(t *testing.T) {
	directory := t.TempDir()
	staging := filepath.Join(directory, "staging")
	secure := filepath.Join(directory, "secure")
	if err := os.MkdirAll(staging, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(secure, 0o700); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(staging, "bored-manager.deb")
	if err := os.WriteFile(source, []byte("signed package bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	server := &Server{SecureTempDir: secure}
	stable, cleanup, err := server.stabilizeArtifact(source)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	if err := os.WriteFile(source, []byte("attacker replacement"), 0o600); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(stable)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != "signed package bytes" {
		t.Fatalf("stable artifact changed with manager staging: %q", contents)
	}
	if info, err := os.Stat(stable); err != nil || runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("stable artifact is not private: info=%v err=%v", info, err)
	}
}

func TestCopyStableRegularFileRejectsSymlink(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "target.deb")
	link := filepath.Join(directory, "link.deb")
	if err := os.WriteFile(target, []byte("package"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks are unavailable on this test host: %v", err)
	}
	if err := copyStableRegularFile(link, filepath.Join(directory, "copy.deb")); err == nil {
		t.Fatal("symlink artifact was accepted")
	}
}

func TestResolveArtifactRejectsTraversal(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("v1 artifact resolution is certified only on Linux")
	}
	directory := t.TempDir()
	staging := filepath.Join(directory, "staging")
	if err := os.MkdirAll(staging, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(staging, "manager.deb"), []byte("package"), 0o600); err != nil {
		t.Fatal(err)
	}
	server := &Server{StagingDir: staging}
	if resolved, err := server.resolveArtifact("manager.deb"); err != nil || resolved != filepath.Join(staging, "manager.deb") {
		t.Fatalf("safe artifact did not resolve: path=%q err=%v", resolved, err)
	}
	for _, name := range []string{"../manager.deb", "subdir/manager.deb", "manager.txt", ""} {
		if _, err := server.resolveArtifact(name); err == nil {
			t.Fatalf("unsafe artifact name %q was accepted", name)
		}
	}
}
