package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const testToken = "test-token-0123456789abcdef0123456789abcdef"

// okHandler records whether the protected handler was reached at all —
// the thing that actually matters for an auth test.
func okHandler(reached *bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		*reached = true
		w.WriteHeader(http.StatusOK)
	}
}

func TestRequireAPIToken(t *testing.T) {
	tests := []struct {
		name          string
		authorization string
		wantStatus    int
		wantReached   bool
	}{
		{
			name:          "valid token passes through",
			authorization: "Bearer " + testToken,
			wantStatus:    http.StatusOK,
			wantReached:   true,
		},
		{
			name:          "scheme is matched case-insensitively per RFC 7235",
			authorization: "bearer " + testToken,
			wantStatus:    http.StatusOK,
			wantReached:   true,
		},
		{
			name:          "missing header is rejected",
			authorization: "",
			wantStatus:    http.StatusUnauthorized,
		},
		{
			name:          "wrong token is rejected",
			authorization: "Bearer " + strings.Repeat("z", len(testToken)),
			wantStatus:    http.StatusUnauthorized,
		},
		{
			name:          "correct token under the wrong scheme is rejected",
			authorization: "Basic " + testToken,
			wantStatus:    http.StatusUnauthorized,
		},
		{
			name:          "bare token with no scheme is rejected",
			authorization: testToken,
			wantStatus:    http.StatusUnauthorized,
		},
		{
			name:          "empty credential is rejected",
			authorization: "Bearer ",
			wantStatus:    http.StatusUnauthorized,
		},
		{
			// Guards against a prefix comparison sneaking in where a
			// full-equality one belongs.
			name:          "token prefix is rejected",
			authorization: "Bearer " + testToken[:len(testToken)-1],
			wantStatus:    http.StatusUnauthorized,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reached := false
			h := RequireAPIToken(testToken, NewAuthFailureLimiter(), okHandler(&reached))

			req := httptest.NewRequest(http.MethodGet, "/api/internal/v1/landing/hero", nil)
			if tt.authorization != "" {
				req.Header.Set("Authorization", tt.authorization)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)

			if rec.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d", rec.Code, tt.wantStatus)
			}
			if reached != tt.wantReached {
				t.Errorf("handler reached = %v, want %v", reached, tt.wantReached)
			}
			if tt.wantStatus == http.StatusUnauthorized {
				if body := rec.Body.String(); !strings.Contains(body, `"error":"unauthorized"`) {
					t.Errorf("body = %q, want the JSON unauthorized envelope", body)
				}
				// A redirect here would be the requireOwnerAuth bug this
				// middleware exists to avoid — an API client would follow
				// it and get HTML with a 200.
				if loc := rec.Header().Get("Location"); loc != "" {
					t.Errorf("unexpected redirect to %q — API auth must never redirect", loc)
				}
			}
		})
	}
}

// TestRequireAPITokenNeverLeaksToken guards the "never log or echo the
// token" rule at the response boundary: no rejection may quote back what
// was presented, or reveal the expected value.
func TestRequireAPITokenNeverLeaksToken(t *testing.T) {
	const presented = "wrong-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	reached := false
	h := RequireAPIToken(testToken, NewAuthFailureLimiter(), okHandler(&reached))

	req := httptest.NewRequest(http.MethodGet, "/api/internal/v1/landing/hero", nil)
	req.Header.Set("Authorization", "Bearer "+presented)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	body := rec.Body.String()
	if strings.Contains(body, presented) {
		t.Error("response echoed the presented token")
	}
	if strings.Contains(body, testToken) {
		t.Error("response leaked the expected token")
	}
}

// TestAuthFailureLimiter checks the three properties the rate limiter
// actually needs: failures accumulate, success is never counted against
// the caller, and the window expires.
func TestAuthFailureLimiter(t *testing.T) {
	t.Run("blocks after the limit is reached", func(t *testing.T) {
		limiter := newAuthFailureLimiter(3, time.Minute)
		const key = "10.0.0.1"

		for i := 0; i < 3; i++ {
			if !limiter.Allow(key) {
				t.Fatalf("attempt %d blocked before the limit", i+1)
			}
			limiter.RecordFailure(key)
		}
		if limiter.Allow(key) {
			t.Error("limiter allowed a 4th attempt past a limit of 3")
		}
	})

	t.Run("keys are tracked independently", func(t *testing.T) {
		limiter := newAuthFailureLimiter(1, time.Minute)
		limiter.RecordFailure("10.0.0.1")
		if !limiter.Allow("10.0.0.2") {
			t.Error("one source's failures blocked a different source")
		}
	})

	t.Run("window expiry restores the budget", func(t *testing.T) {
		limiter := newAuthFailureLimiter(1, time.Millisecond)
		const key = "10.0.0.1"
		limiter.RecordFailure(key)
		if limiter.Allow(key) {
			t.Fatal("limiter allowed an attempt inside a spent window")
		}
		time.Sleep(5 * time.Millisecond)
		if !limiter.Allow(key) {
			t.Error("limiter did not reset after its window expired")
		}
	})

	t.Run("successful requests never consume budget", func(t *testing.T) {
		// The legitimate caller must not be able to rate-limit itself, no
		// matter how many requests it makes.
		limiter := newAuthFailureLimiter(2, time.Minute)
		h := RequireAPIToken(testToken, limiter, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))

		for i := 0; i < 10; i++ {
			req := httptest.NewRequest(http.MethodGet, "/api/internal/v1/landing/hero", nil)
			req.Header.Set("Authorization", "Bearer "+testToken)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("request %d: status = %d, want 200", i+1, rec.Code)
			}
		}
	})

	t.Run("exhausted budget returns 429 rather than 401", func(t *testing.T) {
		limiter := newAuthFailureLimiter(1, time.Minute)
		h := RequireAPIToken(testToken, limiter, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))

		send := func() int {
			req := httptest.NewRequest(http.MethodGet, "/api/internal/v1/landing/hero", nil)
			req.Header.Set("Authorization", "Bearer nope")
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			return rec.Code
		}

		if got := send(); got != http.StatusUnauthorized {
			t.Fatalf("first failure status = %d, want 401", got)
		}
		if got := send(); got != http.StatusTooManyRequests {
			t.Errorf("second failure status = %d, want 429", got)
		}
	})
}

func TestBearerToken(t *testing.T) {
	tests := []struct {
		header string
		want   string
		wantOK bool
	}{
		{"Bearer abc", "abc", true},
		{"bearer abc", "abc", true},
		{"BEARER abc", "abc", true},
		{"Bearer  abc  ", "abc", true},
		{"", "", false},
		{"abc", "", false},
		{"Basic abc", "", false},
		{"Bearer", "", false},
		{"Bearer ", "", false},
	}

	for _, tt := range tests {
		t.Run(tt.header, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			if tt.header != "" {
				req.Header.Set("Authorization", tt.header)
			}
			got, ok := bearerToken(req)
			if ok != tt.wantOK || got != tt.want {
				t.Errorf("bearerToken(%q) = (%q, %v), want (%q, %v)", tt.header, got, ok, tt.want, tt.wantOK)
			}
		})
	}
}

func TestClientKey(t *testing.T) {
	// Ports must be stripped, or every retry from one attacker would land
	// in a fresh bucket and the limiter would never engage.
	tests := []struct{ remoteAddr, want string }{
		{"192.0.2.1:54321", "192.0.2.1"},
		{"192.0.2.1:12345", "192.0.2.1"},
		{"[2001:db8::1]:443", "[2001:db8::1]"},
		{"192.0.2.1", "192.0.2.1"},
	}
	for _, tt := range tests {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.RemoteAddr = tt.remoteAddr
		if got := clientKey(req); got != tt.want {
			t.Errorf("clientKey(%q) = %q, want %q", tt.remoteAddr, got, tt.want)
		}
	}
}
