package platform

import "testing"

func TestCanonicalOSRelease(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name            string
		id              string
		versionID       string
		versionCodename string
		want            string
	}{
		{name: "Ubuntu 24.04", id: "ubuntu", versionID: "24.04", versionCodename: "noble", want: Ubuntu2404},
		{name: "Kali Rolling", id: "kali", versionID: "2026.2", versionCodename: "kali-rolling", want: KaliRolling},
		{name: "Kali without canonical codename", id: "kali", versionID: "2026.2", versionCodename: "", want: "kali-2026.2"},
		{name: "Debian derivative", id: "debian", versionID: "13", versionCodename: "trixie", want: "debian-13"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := CanonicalOSRelease(test.id, test.versionID, test.versionCodename); got != test.want {
				t.Fatalf("CanonicalOSRelease() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestHasExactSupportedOSReleases(t *testing.T) {
	t.Parallel()
	if !HasExactSupportedOSReleases([]string{KaliRolling, Ubuntu2404}) {
		t.Fatal("complete supported OS set was rejected")
	}
	for _, values := range [][]string{
		{Ubuntu2404},
		{KaliRolling, KaliRolling},
		{Ubuntu2404, "debian-13"},
		{Ubuntu2404, KaliRolling},
	} {
		if HasExactSupportedOSReleases(values) {
			t.Fatalf("invalid supported OS set was accepted: %v", values)
		}
	}
}
