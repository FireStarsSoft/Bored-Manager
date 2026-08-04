package clienttls

import "testing"

func TestPinFormatsNormalizeEqually(t *testing.T) {
	hexPin := "00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF"
	curlPin := "sha256//ABEiM0RVZneImaq7zN3u/wARIjNEVWZ3iJmqu8zd7v8="
	if normalize(hexPin) != normalize(curlPin) {
		t.Fatalf("pin formats differ: %s != %s", normalize(hexPin), normalize(curlPin))
	}
}
