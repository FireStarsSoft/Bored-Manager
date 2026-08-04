// Package updatehelper exposes a narrow privileged package-install service.
package updatehelper

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/FireStarsSoft/Bored-Manager/internal/releaseverify"
	"github.com/FireStarsSoft/Bored-Manager/internal/version"
)

type Request struct {
	Operation string `json:"operation"`
	Artifact  string `json:"artifact,omitempty"`
}
type Response struct {
	OK      bool   `json:"ok"`
	Status  string `json:"status"`
	Error   string `json:"error,omitempty"`
	Package string `json:"package,omitempty"`
	Version string `json:"version,omitempty"`
}

type Server struct {
	SocketPath    string
	StagingDir    string
	PublicKeyPath string
	SecureTempDir string
	ManagerUID    uint32
	ManagerGID    int
	operationMu   sync.Mutex
}

func Default() (*Server, error) {
	account, err := user.Lookup("bored-manager")
	if err != nil {
		return nil, fmt.Errorf("resolve bored-manager user: %w", err)
	}
	uid, err := strconv.ParseUint(account.Uid, 10, 32)
	if err != nil {
		return nil, err
	}
	group, err := user.LookupGroup("bored-manager")
	if err != nil {
		return nil, fmt.Errorf("resolve bored-manager group: %w", err)
	}
	gid, err := strconv.Atoi(group.Gid)
	if err != nil {
		return nil, err
	}
	return &Server{SocketPath: "/run/bored-manager/update-helper.sock", StagingDir: "/var/cache/bored-manager/staged", PublicKeyPath: "/usr/share/bored-manager/release-signing.pub", SecureTempDir: "/tmp", ManagerUID: uint32(uid), ManagerGID: gid}, nil
}

func (s *Server) Run(ctx context.Context) error {
	if err := os.MkdirAll(filepath.Dir(s.SocketPath), 0o750); err != nil {
		return err
	}
	if info, err := os.Lstat(s.SocketPath); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return errors.New("refusing to replace non-socket update helper path")
		}
		if err := os.Remove(s.SocketPath); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	listener, err := net.Listen("unix", s.SocketPath)
	if err != nil {
		return err
	}
	defer listener.Close()
	defer os.Remove(s.SocketPath)
	if err := os.Chmod(s.SocketPath, 0o660); err != nil {
		return err
	}
	if err := os.Chown(s.SocketPath, 0, s.ManagerGID); err != nil {
		return fmt.Errorf("assign update socket group: %w", err)
	}
	go func() { <-ctx.Done(); _ = listener.Close() }()
	for {
		connection, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		go s.handle(connection)
	}
}

func (s *Server) handle(connection net.Conn) {
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(2 * time.Minute))
	uid, err := peerUID(connection)
	if err != nil || uid != s.ManagerUID {
		_ = json.NewEncoder(connection).Encode(Response{OK: false, Status: "rejected", Error: "peer credentials rejected"})
		return
	}
	decoder := json.NewDecoder(bufio.NewReader(io.LimitReader(connection, 64<<10)))
	decoder.DisallowUnknownFields()
	var request Request
	if err := decoder.Decode(&request); err != nil {
		_ = json.NewEncoder(connection).Encode(Response{OK: false, Status: "rejected", Error: "invalid request"})
		return
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		_ = json.NewEncoder(connection).Encode(Response{OK: false, Status: "rejected", Error: "request must contain one JSON object"})
		return
	}
	response := s.execute(request)
	_ = json.NewEncoder(connection).Encode(response)
}

func (s *Server) execute(request Request) Response {
	if request.Operation == "status" {
		return Response{OK: true, Status: "ready", Version: version.Version}
	}
	if request.Operation != "install" && request.Operation != "rollback" && request.Operation != "verify" {
		return Response{OK: false, Status: "rejected", Error: "unsupported operation"}
	}
	s.operationMu.Lock()
	defer s.operationMu.Unlock()
	artifact, err := s.resolveArtifact(request.Artifact)
	if err != nil {
		return failure(err)
	}
	stableArtifact, cleanup, err := s.stabilizeArtifact(artifact)
	if err != nil {
		return failure(err)
	}
	defer cleanup()
	if err := releaseverify.VerifyArtifact(stableArtifact, filepath.Join(s.StagingDir, "SHA256SUMS"), filepath.Join(s.StagingDir, "SHA256SUMS.sig"), s.PublicKeyPath); err != nil {
		return failure(err)
	}
	packageName, packageVersion, architecture, err := inspectPackage(stableArtifact)
	if err != nil {
		return failure(err)
	}
	if packageName != "bored-manager" && packageName != "bored-manager-agent" {
		return failure(errors.New("package name is not allowed"))
	}
	if architecture != "amd64" {
		return failure(errors.New("package architecture is not amd64"))
	}
	if request.Operation == "verify" {
		return Response{OK: true, Status: "verified", Package: packageName, Version: packageVersion}
	}
	command := exec.Command("/usr/bin/dpkg", "--install", stableArtifact)
	command.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C", "LC_ALL=C"}
	output, err := command.CombinedOutput()
	if err != nil {
		return failure(fmt.Errorf("dpkg install failed: %w: %s", err, strings.TrimSpace(string(output))))
	}
	return Response{OK: true, Status: "installed", Package: packageName, Version: packageVersion}
}

// stabilizeArtifact pins a checked regular-file inode into a root-only
// directory. Signature and package inspection operate only on that immutable
// copy, closing the manager-writable staging-path TOCTOU window.
func (s *Server) stabilizeArtifact(source string) (string, func(), error) {
	operationDir, err := os.MkdirTemp(s.SecureTempDir, "operation-")
	if err != nil {
		return "", func() {}, err
	}
	cleanup := func() { _ = os.RemoveAll(operationDir) }
	if err := os.Chmod(operationDir, 0o700); err != nil {
		cleanup()
		return "", func() {}, err
	}
	destination := filepath.Join(operationDir, filepath.Base(source))
	if err := copyStableRegularFile(source, destination); err != nil {
		cleanup()
		return "", func() {}, err
	}
	return destination, cleanup, nil
}

func copyStableRegularFile(source, destination string) error {
	before, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 {
		return errors.New("artifact candidate is not a regular non-symlink file")
	}
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	opened, err := input.Stat()
	if err != nil {
		return err
	}
	if !opened.Mode().IsRegular() || !os.SameFile(before, opened) {
		return errors.New("artifact candidate changed while it was opened")
	}
	output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	removeDestination := true
	defer func() {
		_ = output.Close()
		if removeDestination {
			_ = os.Remove(destination)
		}
	}()
	if _, err := io.Copy(output, input); err != nil {
		return err
	}
	if err := output.Sync(); err != nil {
		return err
	}
	if err := output.Close(); err != nil {
		return err
	}
	removeDestination = false
	return nil
}

func (s *Server) resolveArtifact(name string) (string, error) {
	if name == "" || filepath.Base(name) != name || strings.Contains(name, "..") || !strings.HasSuffix(name, ".deb") {
		return "", errors.New("invalid artifact filename")
	}
	root, err := filepath.EvalSymlinks(s.StagingDir)
	if err != nil {
		return "", err
	}
	candidate, err := filepath.EvalSymlinks(filepath.Join(root, name))
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(root, candidate)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", errors.New("artifact escapes staging directory")
	}
	info, err := os.Stat(candidate)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", errors.New("artifact is not a regular file")
	}
	return candidate, nil
}

func inspectPackage(path string) (name, packageVersion, architecture string, err error) {
	field := func(fieldName string) (string, error) {
		command := exec.Command("/usr/bin/dpkg-deb", "--field", path, fieldName)
		command.Env = []string{"PATH=/usr/bin:/bin", "LANG=C", "LC_ALL=C"}
		output, commandErr := command.Output()
		if commandErr != nil {
			return "", fmt.Errorf("inspect Debian package field %s: %w", fieldName, commandErr)
		}
		return strings.TrimSpace(string(output)), nil
	}
	if name, err = field("Package"); err != nil {
		return "", "", "", err
	}
	if packageVersion, err = field("Version"); err != nil {
		return "", "", "", err
	}
	if architecture, err = field("Architecture"); err != nil {
		return "", "", "", err
	}
	if name == "" || packageVersion == "" || architecture == "" {
		return "", "", "", errors.New("Debian package metadata is incomplete")
	}
	return
}

func failure(err error) Response {
	digest := sha256.Sum256([]byte(err.Error()))
	return Response{OK: false, Status: "failed", Error: fmt.Sprintf("%s (error-id %x)", err, digest[:4])}
}
