package release

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

func TestReleaseManifestExampleMatchesSchema(t *testing.T) {
	schema, example := loadSchemaAndExample(t)
	if err := schema.Validate(example); err != nil {
		t.Fatalf("release manifest example does not match schema: %v", err)
	}
}

func TestReleaseManifestRequiresCompletePlatformSet(t *testing.T) {
	schema, example := loadSchemaAndExample(t)
	compatibility := example.(map[string]any)["compatibility"].(map[string]any)
	for name, operatingSystems := range map[string][]any{
		"missing Kali":       {"ubuntu-24.04"},
		"missing Ubuntu":     {"kali-rolling"},
		"duplicate platform": {"kali-rolling", "kali-rolling"},
		"unknown platform":   {"kali-rolling", "debian-13"},
		"noncanonical order": {"ubuntu-24.04", "kali-rolling"},
	} {
		t.Run(name, func(t *testing.T) {
			compatibility["operating_systems"] = operatingSystems
			if err := schema.Validate(example); err == nil {
				t.Fatal("invalid platform set matched release manifest schema")
			}
		})
	}
}

func loadSchemaAndExample(t *testing.T) (*jsonschema.Schema, any) {
	t.Helper()
	compiler := jsonschema.NewCompiler()
	schema, err := compiler.Compile("release-manifest-v1.schema.json")
	if err != nil {
		t.Fatalf("compile release manifest schema: %v", err)
	}
	contents, err := os.ReadFile("release-manifest-v1.example.json")
	if err != nil {
		t.Fatal(err)
	}
	var example any
	if err := json.Unmarshal(contents, &example); err != nil {
		t.Fatalf("decode release manifest example: %v", err)
	}
	return schema, example
}
