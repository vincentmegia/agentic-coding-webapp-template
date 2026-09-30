package main

import (
	"database/sql"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// lazyDB returns a *sql.DB that never connects. database/sql opens
// connections lazily, so this is enough to build the full mux — every
// assertion below is about routing and auth, both of which happen before
// any query is issued. That keeps this file runnable with no Postgres,
// unlike e2e_test.go.
func lazyDB(t *testing.T) *sql.DB {
	t.Helper()
	conn, err := sql.Open("pgx", "postgres://unused:unused@127.0.0.1:1/unused")
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

func testMux(t *testing.T, token string) *http.ServeMux {
	t.Helper()
	chdirRepoRoot(t)
	mux, err := newMux(lazyDB(t), lazyDB(t), token)
	if err != nil {
		t.Fatalf("newMux: %v", err)
	}
	return mux
}

// TestLandingAPIDisabledWithoutToken is the fail-closed guarantee: with no
// LANDING_API_TOKEN configured, the API must not exist at all rather than
// exist unauthenticated. A regression here would silently publish an
// unauthenticated content-write API.
func TestLandingAPIDisabledWithoutToken(t *testing.T) {
	mux := testMux(t, "")

	paths := []string{
		landingAPIPrefix + "/hero",
		landingAPIPrefix + "/carousel",
		landingAPIPrefix + "/selected-work",
		landingAPIPrefix + "/carousel/1",
	}
	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, path, nil)
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)

			if rec.Code != http.StatusNotFound {
				t.Errorf("status = %d, want 404 (API should be unregistered)", rec.Code)
			}
		})
	}
}

// TestLandingAPIRequiresTokenOnEveryRoute walks every registered endpoint
// and asserts an unauthenticated call is refused. This is the check that
// catches a future route added without its RequireAPIToken wrapper — the
// specific mistake the per-route wrapping in registerLandingAPI is
// designed to make visible.
func TestLandingAPIRequiresTokenOnEveryRoute(t *testing.T) {
	mux := testMux(t, testLandingAPIToken)

	routes := []struct{ method, path string }{
		{http.MethodGet, landingAPIPrefix + "/hero"},
		{http.MethodPut, landingAPIPrefix + "/hero"},
		{http.MethodGet, landingAPIPrefix + "/carousel"},
		{http.MethodPost, landingAPIPrefix + "/carousel"},
		{http.MethodPut, landingAPIPrefix + "/carousel/order"},
		{http.MethodGet, landingAPIPrefix + "/carousel/1"},
		{http.MethodPut, landingAPIPrefix + "/carousel/1"},
		{http.MethodDelete, landingAPIPrefix + "/carousel/1"},
		{http.MethodGet, landingAPIPrefix + "/selected-work"},
		{http.MethodPost, landingAPIPrefix + "/selected-work"},
		{http.MethodPut, landingAPIPrefix + "/selected-work/order"},
		{http.MethodGet, landingAPIPrefix + "/selected-work/1"},
		{http.MethodPut, landingAPIPrefix + "/selected-work/1"},
		{http.MethodDelete, landingAPIPrefix + "/selected-work/1"},
	}

	for i, route := range routes {
		t.Run(route.method+" "+route.path, func(t *testing.T) {
			req := httptest.NewRequest(route.method, route.path, strings.NewReader("{}"))
			req.Header.Set("Content-Type", "application/json")
			// Each case gets its own source address. Without this, all
			// fourteen failures share one rate-limit bucket and the later
			// ones come back 429 instead of 401 — which is the limiter
			// working correctly, but it would mask what this test is
			// actually checking. The limiter's own behavior is covered by
			// TestAuthFailureLimiter in internal/handler.
			req.RemoteAddr = fmt.Sprintf("192.0.2.%d:12345", i+1)
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)

			if rec.Code != http.StatusUnauthorized {
				t.Errorf("status = %d, want 401", rec.Code)
			}
			if !strings.Contains(rec.Body.String(), `"error":"unauthorized"`) {
				t.Errorf("body = %q, want the JSON unauthorized envelope", rec.Body.String())
			}
		})
	}
}

// TestLandingAPIRoutePrecedence is the test the design calls for by name:
// "/carousel/order" and "/carousel/{id}" both match a two-segment path, and
// Go 1.22+ ServeMux is expected to prefer the literal segment. Getting this
// wrong would make one of the two routes permanently unreachable, which is
// the kind of thing a comment cannot enforce.
//
// Uses mux.Handler to read back the matched pattern rather than executing
// the handler, so this asserts routing directly and needs no database.
func TestLandingAPIRoutePrecedence(t *testing.T) {
	mux := testMux(t, testLandingAPIToken)

	tests := []struct {
		name        string
		method      string
		path        string
		wantPattern string
	}{
		{
			name:        "carousel order beats the id wildcard",
			method:      http.MethodPut,
			path:        landingAPIPrefix + "/carousel/order",
			wantPattern: "PUT " + landingAPIPrefix + "/carousel/order",
		},
		{
			name:        "numeric carousel id still reaches the id route",
			method:      http.MethodPut,
			path:        landingAPIPrefix + "/carousel/12",
			wantPattern: "PUT " + landingAPIPrefix + "/carousel/{id}",
		},
		{
			name:        "selected-work order beats the id wildcard",
			method:      http.MethodPut,
			path:        landingAPIPrefix + "/selected-work/order",
			wantPattern: "PUT " + landingAPIPrefix + "/selected-work/order",
		},
		{
			name:        "numeric selected-work id still reaches the id route",
			method:      http.MethodPut,
			path:        landingAPIPrefix + "/selected-work/34",
			wantPattern: "PUT " + landingAPIPrefix + "/selected-work/{id}",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(tt.method, tt.path, nil)
			_, pattern := mux.Handler(req)
			if pattern != tt.wantPattern {
				t.Errorf("matched pattern = %q, want %q", pattern, tt.wantPattern)
			}
		})
	}
}

// TestLandingAPIUnknownPathReturnsJSON checks that a typo'd path under the
// API prefix gets the JSON envelope rather than ServeMux's plain-text 404,
// so HQ can parse every response from this prefix uniformly.
func TestLandingAPIUnknownPathReturnsJSON(t *testing.T) {
	mux := testMux(t, testLandingAPIToken)

	req := httptest.NewRequest(http.MethodGet, landingAPIPrefix+"/carousel/1/nonsense", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"error":"not_found"`) {
		t.Errorf("body = %q, want the JSON not_found envelope", rec.Body.String())
	}
}

// TestSiteRoutesUnaffectedByAPIToken guards against the API registration
// accidentally shadowing or disturbing the existing site routes.
func TestSiteRoutesUnaffectedByAPIToken(t *testing.T) {
	for _, token := range []string{"", testLandingAPIToken} {
		mux := testMux(t, token)
		req := httptest.NewRequest(http.MethodGet, "/settings/content", nil)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)

		// Unauthenticated, so this must still redirect to /login exactly
		// as before — the HTML editor's contract is unchanged by the API.
		if rec.Code != http.StatusFound {
			t.Errorf("token=%q: /settings/content status = %d, want 302", token, rec.Code)
		}
	}
}
