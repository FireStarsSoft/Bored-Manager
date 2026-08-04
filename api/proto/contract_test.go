package proto

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTrafficClassesUseSeparateServices(t *testing.T) {
	t.Parallel()
	contracts := map[string][]string{
		"boredmanager/agent/v1/control.proto": {
			"service ControlService",
			"rpc Connect(stream AgentControlFrame) returns (stream ManagerControlFrame)",
		},
		"boredmanager/agent/v1/shell.proto": {
			"service ShellService",
			"rpc OpenShell(stream AgentShellFrame) returns (stream ManagerShellFrame)",
		},
		"boredmanager/agent/v1/artifact.proto": {
			"service ArtifactService",
			"rpc GetArtifact(ArtifactRequest) returns (stream ArtifactChunk)",
		},
	}
	for path, required := range contracts {
		path, required := path, required
		t.Run(filepath.Base(path), func(t *testing.T) {
			t.Parallel()
			content := readProtoFile(t, path)
			for _, declaration := range required {
				if !strings.Contains(content, declaration) {
					t.Errorf("%s does not declare %q", path, declaration)
				}
			}
		})
	}
}

func TestStreamingFramesCarryMetadata(t *testing.T) {
	t.Parallel()
	for _, path := range []string{
		"boredmanager/agent/v1/control.proto",
		"boredmanager/agent/v1/shell.proto",
		"boredmanager/agent/v1/artifact.proto",
	} {
		content := readProtoFile(t, path)
		if !strings.Contains(content, "FrameMetadata metadata = 1;") {
			t.Errorf("%s has no sequence/protocol metadata", path)
		}
	}
	common := readProtoFile(t, "boredmanager/agent/v1/common.proto")
	for _, field := range []string{
		"string protocol_version = 1;",
		"string agent_id = 2;",
		"uint64 sequence = 3;",
		"int64 sent_at_unix_ms = 4;",
	} {
		if !strings.Contains(common, field) {
			t.Errorf("FrameMetadata is missing %q", field)
		}
	}
}

func TestDurableJobStatesMatchPublicContract(t *testing.T) {
	t.Parallel()
	common := readProtoFile(t, "boredmanager/agent/v1/common.proto")
	for _, state := range []string{
		"QUEUED", "LEASED", "PREPARING", "READY", "COMMITTED",
		"RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED",
	} {
		if !strings.Contains(common, "JOB_TARGET_STATE_"+state) {
			t.Errorf("protobuf job state %s is missing", state)
		}
	}
}

func readProtoFile(t *testing.T, name string) string {
	t.Helper()
	content, err := os.ReadFile(filepath.Clean(name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(content)
}
