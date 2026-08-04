package release

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

func TestReleaseManifestExampleMatchesSchema(t *testing.T) {
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
	if err := schema.Validate(example); err != nil {
		t.Fatalf("release manifest example does not match schema: %v", err)
	}
}
