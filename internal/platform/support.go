// Package platform defines the operating-system and architecture contract shared by
// installers, agents, API validation, and signed release metadata.
package platform

const (
	Ubuntu2404 = "ubuntu-24.04"
	KaliRolling = "kali-rolling"
	AMD64       = "amd64"
)

var supportedOSReleases = []string{KaliRolling, Ubuntu2404}

// SupportedOSReleases returns the canonical, sorted supported OS identifiers.
func SupportedOSReleases() []string {
	return append([]string(nil), supportedOSReleases...)
}

// IsSupportedOSRelease reports whether value is an exact supported OS identifier.
func IsSupportedOSRelease(value string) bool {
	switch value {
	case Ubuntu2404, KaliRolling:
		return true
	default:
		return false
	}
}

// HasExactSupportedOSReleases rejects partial, reordered, duplicate, unknown,
// or expanded compatibility declarations in signed metadata.
func HasExactSupportedOSReleases(values []string) bool {
	if len(values) != len(supportedOSReleases) {
		return false
	}
	for index, value := range values {
		if value != supportedOSReleases[index] {
			return false
		}
	}
	return true
}

// CanonicalOSRelease maps trusted /etc/os-release fields to the public API value.
// Kali uses kali-rolling as its OS codename for both the continuously updated
// branch and point-in-time snapshots derived from it.
func CanonicalOSRelease(id, versionID, versionCodename string) string {
	switch {
	case id == "ubuntu" && versionID == "24.04":
		return Ubuntu2404
	case id == "kali" && versionCodename == "kali-rolling":
		return KaliRolling
	case id == "":
		return "unknown"
	case versionID == "":
		return id + "-unknown"
	default:
		return id + "-" + versionID
	}
}
