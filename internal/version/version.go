// Package version exposes build metadata shared by every Bored Manager binary.
package version

var (
	Version   = "0.1.0-dev"
	Commit    = "unknown"
	BuildTime = "unknown"
)

// Info is the stable JSON representation used by APIs and CLI output.
type Info struct {
	Version   string `json:"version"`
	Commit    string `json:"commit"`
	BuildTime string `json:"build_time"`
}

// Current returns the metadata injected by the release build.
func Current() Info {
	return Info{Version: Version, Commit: Commit, BuildTime: BuildTime}
}
