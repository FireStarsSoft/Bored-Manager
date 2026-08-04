//go:build !windows

package agent

import "syscall"

func diskUsage(path string) (total, free int64, ok bool) {
	var stat syscall.Statfs_t
	if syscall.Statfs(path, &stat) != nil {
		return 0, 0, false
	}
	return int64(stat.Blocks) * int64(stat.Bsize), int64(stat.Bavail) * int64(stat.Bsize), true
}
