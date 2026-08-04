//go:build windows

package agent

func diskUsage(string) (int64, int64, bool) { return 0, 0, false }
