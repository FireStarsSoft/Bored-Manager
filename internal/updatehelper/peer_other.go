//go:build !linux

package updatehelper

import (
	"errors"
	"net"
)

func peerUID(net.Conn) (uint32, error) {
	return 0, errors.New("SO_PEERCRED update helper is supported only on Linux")
}
