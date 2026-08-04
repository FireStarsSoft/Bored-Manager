package openapiv1

import (
	"bufio"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestOpenAPIHasRequiredResourceSurfaces(t *testing.T) {
	t.Parallel()
	spec := readContractFile(t, "openapi.yaml")

	requiredPaths := []string{
		"/health:",
		"/version:",
		"/setup:",
		"/auth/login:",
		"/auth/reauthenticate:",
		"/agents:",
		"/agents/install-command:",
		"/enrollment-requests:",
		"/enrollment-requests/{enrollment_id}/status:",
		"/service-definitions:",
		"/service-assignments:",
		"/jobs:",
		"/docker-hosts:",
		"/docker-hosts/local/discovery:",
		"/templates:",
		"/network-profiles:",
		"/releases:",
		"/diagnostics:",
		"/events:",
		"/artifacts/releases/{tag}/{name}:",
	}
	for _, path := range requiredPaths {
		if !strings.Contains(spec, "  "+path) {
			t.Errorf("OpenAPI contract is missing %s", path)
		}
	}

	operationPattern := regexp.MustCompile(`(?m)^      operationId: ([A-Za-z][A-Za-z0-9]+)$`)
	seen := make(map[string]struct{})
	for _, match := range operationPattern.FindAllStringSubmatch(spec, -1) {
		if _, exists := seen[match[1]]; exists {
			t.Errorf("duplicate operationId %q", match[1])
		}
		seen[match[1]] = struct{}{}
	}
	if len(seen) < 40 {
		t.Errorf("contract unexpectedly small: found %d operations", len(seen))
	}
}

func TestAllExternalComponentReferencesResolve(t *testing.T) {
	t.Parallel()
	spec := readContractFile(t, "openapi.yaml")
	components := readContractFile(t, "components.yaml")

	refPattern := regexp.MustCompile(`components\.yaml#/components/(?:schemas|responses|parameters|headers)/([A-Za-z0-9]+)`)
	definitionPattern := regexp.MustCompile(`(?m)^    ([A-Za-z0-9]+):`)
	definitions := make(map[string]struct{})
	for _, match := range definitionPattern.FindAllStringSubmatch(components, -1) {
		definitions[match[1]] = struct{}{}
	}
	for _, match := range refPattern.FindAllStringSubmatch(spec, -1) {
		if _, exists := definitions[match[1]]; !exists {
			t.Errorf("unresolved external component reference %q", match[1])
		}
	}
}

func TestSecurityInvariantsAreDeclared(t *testing.T) {
	t.Parallel()
	spec := readContractFile(t, "openapi.yaml")
	components := readContractFile(t, "components.yaml")
	for _, required := range []string{
		"name: X-CSRF-Token",
		"name: Idempotency-Key",
		"Secure, HttpOnly, SameSite=Strict",
		"enum: [I UNDERSTAND DOCKER ACCESS IS ROOT-EQUIVALENT]",
		"x-forbidden-values: [SYS_ADMIN, CAP_SYS_ADMIN]",
		"bored-manager enrollment status:{enrollment_id}",
		"default: bored-manager.local:8443",
	} {
		if !strings.Contains(spec+components, required) {
			t.Errorf("contract is missing security invariant %q", required)
		}
	}
}

func TestSupportedPlatformContractIncludesKali(t *testing.T) {
	t.Parallel()
	components := readContractFile(t, "components.yaml")
	if !strings.Contains(components, "enum: [ubuntu-24.04, kali-rolling]") {
		t.Fatal("platform enum does not include Ubuntu 24.04 and Kali Rolling")
	}
	if !strings.Contains(components, "os_releases:") {
		t.Fatal("service revision contract does not expose os_releases")
	}
	if strings.Contains(components, "ubuntu_releases") {
		t.Fatal("legacy Ubuntu-only service revision field remains in the contract")
	}
}

func TestEveryPublicRuntimeRouteIsDeclared(t *testing.T) {
	t.Parallel()
	spec := readContractFile(t, "openapi.yaml")
	routes, err := os.ReadFile(filepath.Join("..", "..", "..", "internal", "manager", "routes.go"))
	if err != nil {
		t.Fatalf("read manager routes: %v", err)
	}

	operations := make(map[string]struct{})
	currentPath := ""
	methodPattern := regexp.MustCompile(`^    (get|post|put|patch|delete|head|options):`)
	scanner := bufio.NewScanner(strings.NewReader(spec))
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "  /") && strings.HasSuffix(line, ":") {
			currentPath = strings.TrimSuffix(strings.TrimSpace(line), ":")
			continue
		}
		if currentPath == "" {
			continue
		}
		if match := methodPattern.FindStringSubmatch(line); match != nil {
			operations[strings.ToUpper(match[1])+" "+normalizePathParameters(currentPath)] = struct{}{}
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}

	runtimePattern := regexp.MustCompile(`mux\.HandleFunc\("([A-Z]+) (/api/v1[^" ]+)"`)
	for _, match := range runtimePattern.FindAllStringSubmatch(string(routes), -1) {
		operation := match[1] + " " + normalizePathParameters(strings.TrimPrefix(match[2], "/api/v1"))
		if _, ok := operations[operation]; !ok {
			t.Errorf("public runtime route is absent from OpenAPI: %s", operation)
		}
	}
}

func normalizePathParameters(path string) string {
	return regexp.MustCompile(`\{[^}]+\}`).ReplaceAllString(path, "{}")
}

func readContractFile(t *testing.T, name string) string {
	t.Helper()
	content, err := os.ReadFile(filepath.Clean(name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(content)
}
