package main

import "testing"

func TestNormalizeDebianVersion(t *testing.T) {
	cases := map[string]string{"0.1.0~alpha.1-1": "0.1.0-alpha.1", "1.0.0-2": "1.0.0", "2:1.2.3~rc.1-4": "1.2.3-rc.1"}
	for input, want := range cases {
		if got := normalizeDebianVersion(input); got != want {
			t.Errorf("%s: got %s want %s", input, got, want)
		}
	}
}

func TestAddLocalDockerRejectsUnsupportedSocketBeforeConnecting(t *testing.T) {
	err := runDockerHost(options{}, []string{
		"add-local",
		"--socket", "/tmp/docker.sock",
		"--confirmation", "I UNDERSTAND DOCKER ACCESS IS ROOT-EQUIVALENT",
	})
	if err == nil || err.Error() != "v1 supports only the rootful Docker socket /var/run/docker.sock" {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestAddLocalDockerRequiresExactConfirmation(t *testing.T) {
	err := runDockerHost(options{}, []string{"add-local", "--confirmation", "yes"})
	if err == nil || err.Error() != "typed Docker root-equivalent confirmation did not match" {
		t.Fatalf("unexpected error: %v", err)
	}
}
