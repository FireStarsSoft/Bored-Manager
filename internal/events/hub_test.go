package events

import (
	"crypto/tls"
	"net/http"
	"testing"
)

func TestOriginAllowedRequiresExactHostAndTransportScheme(t *testing.T) {
	tests := []struct {
		name      string
		request   string
		origin    string
		tls       bool
		permitted bool
	}{
		{name: "https exact", request: "https://manager.example:8443/api/v1/events", origin: "https://manager.example:8443", tls: true, permitted: true},
		{name: "http dev exact", request: "http://127.0.0.1:8443/api/v1/events", origin: "http://127.0.0.1:8443", permitted: true},
		{name: "missing", request: "https://manager.example:8443/api/v1/events", tls: true},
		{name: "downgrade", request: "https://manager.example:8443/api/v1/events", origin: "http://manager.example:8443", tls: true},
		{name: "wrong host", request: "https://manager.example:8443/api/v1/events", origin: "https://attacker.example:8443", tls: true},
		{name: "wrong port", request: "https://manager.example:8443/api/v1/events", origin: "https://manager.example:9443", tls: true},
		{name: "userinfo", request: "https://manager.example:8443/api/v1/events", origin: "https://user@manager.example:8443", tls: true},
		{name: "path", request: "https://manager.example:8443/api/v1/events", origin: "https://manager.example:8443/path", tls: true},
		{name: "query", request: "https://manager.example:8443/api/v1/events", origin: "https://manager.example:8443?x=1", tls: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request, err := http.NewRequest(http.MethodGet, test.request, nil)
			if err != nil {
				t.Fatal(err)
			}
			if test.tls {
				request.TLS = &tls.ConnectionState{}
			}
			if test.origin != "" {
				request.Header.Set("Origin", test.origin)
			}
			if got := originAllowed(request); got != test.permitted {
				t.Fatalf("originAllowed=%v, want %v", got, test.permitted)
			}
		})
	}
}
