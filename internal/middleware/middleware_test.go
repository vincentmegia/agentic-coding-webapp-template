package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClientKey_FallsBackToRemoteAddrWhenMiddlewareDidNotRun(t *testing.T) {
	// Mirrors a handler test that calls a handler directly without going
	// through the middleware chain (see internal/handler's fishing_game_test.go
	// et al.) — ClientKey must still behave like the pre-ClientIP
	// r.RemoteAddr-trimming logic in that case.
	tests := []struct{ remoteAddr, want string }{
		{"192.0.2.1:54321", "192.0.2.1"},
		{"192.0.2.1:12345", "192.0.2.1"},
		{"[2001:db8::1]:443", "[2001:db8::1]"},
		{"192.0.2.1", "192.0.2.1"},
	}
	for _, tt := range tests {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.RemoteAddr = tt.remoteAddr
		if got := ClientKey(req); got != tt.want {
			t.Errorf("ClientKey(%q) = %q, want %q", tt.remoteAddr, got, tt.want)
		}
	}
}

func TestClientKey_FallsBackIgnoresXForwardedForWhenMiddlewareDidNotRun(t *testing.T) {
	// Without ClientIP's middleware in the chain, X-Forwarded-For must
	// never be consulted — a caller invoking ClientKey with no established
	// trust decision must get the always-safe RemoteAddr-only behavior.
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "192.0.2.1:54321"
	req.Header.Set("X-Forwarded-For", "203.0.113.9")
	if got, want := ClientKey(req), "192.0.2.1"; got != want {
		t.Errorf("ClientKey() = %q, want %q", got, want)
	}
}

func TestClientIP_UntrustedIgnoresXForwardedFor(t *testing.T) {
	var seen string
	h := ClientIP(false)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = ClientKey(r)
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "192.0.2.1:54321"
	req.Header.Set("X-Forwarded-For", "203.0.113.9")
	h.ServeHTTP(httptest.NewRecorder(), req)

	if seen != "192.0.2.1" {
		t.Errorf("ClientKey() = %q, want %q (RemoteAddr, X-Forwarded-For ignored)", seen, "192.0.2.1")
	}
}

func TestClientIP_TrustedUsesLastXForwardedForEntry(t *testing.T) {
	var seen string
	h := ClientIP(true)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = ClientKey(r)
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	// RemoteAddr is the trusted proxy's own address; the header's last
	// entry is what that proxy appended for the real client, per
	// ClientIP's doc comment on how Render appends this header.
	req.RemoteAddr = "10.0.0.1:443"
	req.Header.Set("X-Forwarded-For", "203.0.113.9, 198.51.100.5")
	h.ServeHTTP(httptest.NewRecorder(), req)

	if seen != "198.51.100.5" {
		t.Errorf("ClientKey() = %q, want %q (last X-Forwarded-For entry)", seen, "198.51.100.5")
	}
}

func TestClientIP_TrustedFallsBackWhenHeaderAbsent(t *testing.T) {
	var seen string
	h := ClientIP(true)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = ClientKey(r)
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "192.0.2.1:54321"
	h.ServeHTTP(httptest.NewRecorder(), req)

	if seen != "192.0.2.1" {
		t.Errorf("ClientKey() = %q, want %q (RemoteAddr fallback)", seen, "192.0.2.1")
	}
}
