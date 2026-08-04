package manager

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/FireStarsSoft/Bored-Manager/internal/releaseverify"
	"github.com/FireStarsSoft/Bored-Manager/internal/version"
)

var safeReleaseFilename = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]*$`)

type cachedAgentRelease struct {
	Version        string
	Directory      string
	AgentPackage   string
	AgentInstaller string
	AllowedAssets  map[string]cachedReleaseAsset
}

type cachedReleaseAsset struct {
	Path   string
	SHA256 string
	Size   int64
}

type cachedManifest struct {
	SchemaVersion int `json:"schema_version"`
	Release       struct {
		Version string `json:"version"`
		Tag     string `json:"tag"`
	} `json:"release"`
	Source struct {
		Repository string `json:"repository"`
	} `json:"source"`
	Compatibility struct {
		Ubuntu       string `json:"ubuntu"`
		Architecture string `json:"architecture"`
	} `json:"compatibility"`
	Artifacts []struct {
		Name      string `json:"name"`
		Kind      string `json:"kind"`
		SHA256    string `json:"sha256"`
		Size      int64  `json:"size"`
		Component string `json:"component"`
		Package   struct {
			Name         string `json:"name"`
			Version      string `json:"version"`
			Architecture string `json:"architecture"`
		} `json:"package"`
	} `json:"artifacts"`
}

func (s *Server) verifiedAgentRelease() (cachedAgentRelease, error) {
	currentVersion := strings.TrimSpace(version.Version)
	if currentVersion == "" || strings.Contains(currentVersion, "dev") || strings.Contains(currentVersion, "ci") {
		return cachedAgentRelease{}, errors.New("development builds do not expose release artifacts")
	}
	directory := filepath.Join(s.config.CacheDir, "releases", currentVersion)
	manifestPath := filepath.Join(directory, "release-manifest-v1.json")
	manifestSignaturePath := manifestPath + ".sig"
	checksumsPath := filepath.Join(directory, "SHA256SUMS")
	checksumsSignaturePath := checksumsPath + ".sig"
	publicKeyPath := "/usr/share/bored-manager/release-signing.pub"

	manifestBytes, err := readBoundedRegularFile(manifestPath, 4<<20)
	if err != nil {
		return cachedAgentRelease{}, fmt.Errorf("read cached release manifest: %w", err)
	}
	manifestSignature, err := readBoundedRegularFile(manifestSignaturePath, 1<<20)
	if err != nil {
		return cachedAgentRelease{}, fmt.Errorf("read cached release manifest signature: %w", err)
	}
	if err := releaseverify.VerifyBytesWithSignature(manifestBytes, manifestSignature, publicKeyPath); err != nil {
		return cachedAgentRelease{}, fmt.Errorf("verify cached release manifest: %w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(manifestBytes))
	var manifest cachedManifest
	if err := decoder.Decode(&manifest); err != nil {
		return cachedAgentRelease{}, fmt.Errorf("parse cached release manifest: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return cachedAgentRelease{}, errors.New("cached release manifest must contain one JSON object")
	}
	if manifest.SchemaVersion != 1 || manifest.Release.Version != currentVersion || manifest.Release.Tag != "v"+currentVersion {
		return cachedAgentRelease{}, errors.New("cached release version does not match the running manager")
	}
	if manifest.Source.Repository != "https://github.com/FireStarsSoft/Bored-Manager" || manifest.Compatibility.Ubuntu != "24.04" || manifest.Compatibility.Architecture != "amd64" {
		return cachedAgentRelease{}, errors.New("cached release source or platform is invalid")
	}

	allowed := make(map[string]cachedReleaseAsset)
	agentPackage := ""
	agentInstaller := ""
	foundChecksums := false
	checksumsDigest := ""
	checksumsSize := int64(0)
	seen := make(map[string]struct{}, len(manifest.Artifacts))
	for _, artifact := range manifest.Artifacts {
		if !safeReleaseFilename.MatchString(artifact.Name) || filepath.Base(artifact.Name) != artifact.Name {
			return cachedAgentRelease{}, errors.New("cached manifest contains an unsafe artifact name")
		}
		if _, exists := seen[artifact.Name]; exists {
			return cachedAgentRelease{}, errors.New("cached manifest contains duplicate artifacts")
		}
		seen[artifact.Name] = struct{}{}
		artifactPath := filepath.Join(directory, artifact.Name)
		if artifact.Name == "SHA256SUMS" && artifact.Kind == "checksums" {
			if err := verifyManifestArtifact(artifactPath, artifact.SHA256, artifact.Size); err != nil {
				return cachedAgentRelease{}, fmt.Errorf("verify cached checksums: %w", err)
			}
			foundChecksums = true
			checksumsDigest, checksumsSize = artifact.SHA256, artifact.Size
		}
		if artifact.Kind == "debian-package" && artifact.Package.Name == "bored-manager-agent" {
			if agentPackage != "" || artifact.Component != "agent" || artifact.Package.Architecture != "amd64" || artifact.Package.Version == "" {
				return cachedAgentRelease{}, errors.New("cached manifest has invalid agent package metadata")
			}
			if err := verifyManifestArtifact(artifactPath, artifact.SHA256, artifact.Size); err != nil {
				return cachedAgentRelease{}, fmt.Errorf("verify cached agent package: %w", err)
			}
			agentPackage = artifact.Name
			allowed[artifact.Name] = cachedReleaseAsset{Path: artifactPath, SHA256: artifact.SHA256, Size: artifact.Size}
		}
		if artifact.Kind == "installer" && artifact.Component == "agent" {
			if agentInstaller != "" || artifact.Name != "install-agent.sh" {
				return cachedAgentRelease{}, errors.New("cached manifest has invalid agent installer metadata")
			}
			if err := verifyManifestArtifact(artifactPath, artifact.SHA256, artifact.Size); err != nil {
				return cachedAgentRelease{}, fmt.Errorf("verify cached agent installer: %w", err)
			}
			agentInstaller = artifact.Name
			allowed[artifact.Name] = cachedReleaseAsset{Path: artifactPath, SHA256: artifact.SHA256, Size: artifact.Size}
		}
	}
	if !foundChecksums || agentPackage == "" || agentInstaller == "" {
		return cachedAgentRelease{}, errors.New("cached release lacks checksums, an agent package, or the agent installer")
	}
	checksumsBytes, err := readBoundedRegularFile(checksumsPath, 4<<20)
	if err != nil || int64(len(checksumsBytes)) != checksumsSize || sha256Hex(checksumsBytes) != checksumsDigest {
		return cachedAgentRelease{}, errors.New("cached checksums changed during verification")
	}
	checksumsSignature, err := readBoundedRegularFile(checksumsSignaturePath, 1<<20)
	if err != nil {
		return cachedAgentRelease{}, fmt.Errorf("read cached checksums signature: %w", err)
	}
	if err := releaseverify.VerifyBytesWithSignature(checksumsBytes, checksumsSignature, publicKeyPath); err != nil {
		return cachedAgentRelease{}, fmt.Errorf("verify cached checksums signature: %w", err)
	}
	if err := releaseverify.VerifyDigest(agentPackage, allowed[agentPackage].SHA256, checksumsBytes); err != nil {
		return cachedAgentRelease{}, fmt.Errorf("verify cached agent package checksums: %w", err)
	}
	if err := releaseverify.VerifyDigest(agentInstaller, allowed[agentInstaller].SHA256, checksumsBytes); err != nil {
		return cachedAgentRelease{}, fmt.Errorf("verify cached agent installer checksums: %w", err)
	}
	allowed["release-manifest-v1.json"] = cachedReleaseAsset{Path: manifestPath, SHA256: sha256Hex(manifestBytes), Size: int64(len(manifestBytes))}
	allowed["release-manifest-v1.json.sig"] = cachedReleaseAsset{Path: manifestSignaturePath, SHA256: sha256Hex(manifestSignature), Size: int64(len(manifestSignature))}
	allowed["SHA256SUMS"] = cachedReleaseAsset{Path: checksumsPath, SHA256: checksumsDigest, Size: checksumsSize}
	allowed["SHA256SUMS.sig"] = cachedReleaseAsset{Path: checksumsSignaturePath, SHA256: sha256Hex(checksumsSignature), Size: int64(len(checksumsSignature))}
	return cachedAgentRelease{Version: currentVersion, Directory: directory, AgentPackage: agentPackage, AgentInstaller: agentInstaller, AllowedAssets: allowed}, nil
}

func readBoundedRegularFile(path string, maximum int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > maximum {
		return nil, errors.New("signed metadata is not a bounded regular file")
	}
	contents, err := io.ReadAll(io.LimitReader(file, maximum+1))
	if err != nil {
		return nil, err
	}
	if int64(len(contents)) != info.Size() {
		return nil, errors.New("signed metadata changed while it was read")
	}
	return contents, nil
}

func sha256Hex(contents []byte) string {
	digest := sha256.Sum256(contents)
	return hex.EncodeToString(digest[:])
}

func verifyManifestArtifact(path, expectedDigest string, expectedSize int64) error {
	if len(expectedDigest) != 64 || expectedSize < 1 {
		return errors.New("manifest digest or size is invalid")
	}
	want, err := hex.DecodeString(expectedDigest)
	if err != nil || len(want) != sha256.Size {
		return errors.New("manifest digest is invalid")
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() != expectedSize {
		return errors.New("artifact type or size does not match the manifest")
	}
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return err
	}
	if !strings.EqualFold(hex.EncodeToString(digest.Sum(nil)), expectedDigest) {
		return errors.New("artifact digest does not match the manifest")
	}
	return nil
}

func (s *Server) serveAgentReleaseArtifact(response http.ResponseWriter, request *http.Request) {
	release, err := s.verifiedAgentRelease()
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "artifact_unavailable", "the matching verified agent release is not cached")
		return
	}
	if request.PathValue("tag") != "v"+release.Version {
		writeError(response, http.StatusNotFound, "artifact_not_found", "release artifact not found")
		return
	}
	name := request.PathValue("name")
	asset, allowed := release.AllowedAssets[name]
	if !allowed || filepath.Base(name) != name {
		writeError(response, http.StatusNotFound, "artifact_not_found", "release artifact not found")
		return
	}
	file, info, err := openVerifiedAsset(asset)
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "artifact_changed", "verified release artifact changed before delivery")
		return
	}
	defer file.Close()
	response.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	response.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, name))
	response.Header().Set("Content-Type", "application/octet-stream")
	http.ServeContent(response, request, name, info.ModTime(), file)
}

func openVerifiedAsset(asset cachedReleaseAsset) (*os.File, os.FileInfo, error) {
	before, err := os.Lstat(asset.Path)
	if err != nil || !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 {
		return nil, nil, errors.New("release artifact is not a regular non-symlink file")
	}
	file, err := os.Open(asset.Path)
	if err != nil {
		return nil, nil, err
	}
	failed := true
	defer func() {
		if failed {
			_ = file.Close()
		}
	}()
	info, err := file.Stat()
	if err != nil || !os.SameFile(before, info) || !info.Mode().IsRegular() || info.Size() != asset.Size {
		return nil, nil, errors.New("release artifact identity or size changed")
	}
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil || !strings.EqualFold(hex.EncodeToString(digest.Sum(nil)), asset.SHA256) {
		return nil, nil, errors.New("release artifact digest changed")
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return nil, nil, err
	}
	failed = false
	return file, info, nil
}
