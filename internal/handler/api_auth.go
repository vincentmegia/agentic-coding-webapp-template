package handler

import (
	"crypto/subtle"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/vincentmegia/vincentmegia/internal/middleware"
)

// authFailureLimit/authFailureWindow bound how many failed bearer-token
// attempts one source may make per window before being refused outright.
// This is a brute-force speed bump on a single-caller internal API
// (docs/features/landing-content-api.md's Auth section), not a general
// traffic limiter: successful requests are never counted, so the one
// legitimate caller can't rate-limit itself no matter how busy it is.
const (
	authFailureLimit  = 10
	authFailureWindow = time.Minute
)

// RequireAPIToken authenticates a machine caller by shared bearer token.
//
// Deliberately NOT requireOwnerAuth: that helper 302-redirects to /login,
// which is right for a browser and wrong for an API client — an HTTP
// library would silently follow the redirect and get an HTML page with a
// 200, turning "your credentials are wrong" into a confusing parse error.
// Every failure here is a JSON 401 with no redirect.
//
// token is the already-validated config value; the caller registers these
// routes only when it is non-empty (see cmd/server/main.go's newMux), so
// this middleware never has to decide whether an empty token means "allow
// everything".
func RequireAPIToken(token string, limiter *authFailureLimiter, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !limiter.Allow(middleware.ClientKey(r)) {
			writeAPIError(w, http.StatusTooManyRequests, "rate_limited",
				"Too many failed authentication attempts. Try again shortly.")
			return
		}

		presented, ok := bearerToken(r)
		// Compare even when the header was missing or malformed, against
		// the same token, so a rejected request costs the same time
		// regardless of *why* it was rejected — an early return on a
		// missing header would leak, through timing, whether a supplied
		// token was well-formed but wrong.
		valid := subtle.ConstantTimeCompare([]byte(presented), []byte(token)) == 1
		if !ok || !valid {
			limiter.RecordFailure(middleware.ClientKey(r))
			// Never log the presented token, in full or in part — only
			// that a failure happened, and from where.
			slog.Warn("landing api auth failed",
				"request_id", middleware.RequestIDFromContext(r.Context()),
				"path", r.URL.Path,
				"remote", middleware.ClientKey(r),
			)
			writeAPIError(w, http.StatusUnauthorized, "unauthorized",
				"Missing or invalid API token.")
			return
		}

		next.ServeHTTP(w, r)
	})
}

// bearerToken extracts the credential from an "Authorization: Bearer <t>"
// header. The scheme match is case-insensitive per RFC 7235; the token
// itself is not.
func bearerToken(r *http.Request) (string, bool) {
	header := r.Header.Get("Authorization")
	if header == "" {
		return "", false
	}
	scheme, credential, found := strings.Cut(header, " ")
	if !found || !strings.EqualFold(scheme, "Bearer") {
		return "", false
	}
	credential = strings.TrimSpace(credential)
	if credential == "" {
		return "", false
	}
	return credential, true
}

// authFailureLimiter is a small in-memory, fixed-window, per-key limiter
// counting only authentication *failures*.
//
// Same shape and same caveats as fishing_game.go's scoreSubmitLimiter:
// this app runs as a single process (see cmd/server/main.go), so in-memory
// state is sufficient; behind multiple replicas each would keep its own
// counts and the effective limit would multiply. That's an accepted
// tradeoff for a speed bump whose real backstop is the token's own
// entropy, not this counter.
type authFailureLimiter struct {
	mu       sync.Mutex
	limit    int
	window   time.Duration
	attempts map[string]*failureWindow
}

type failureWindow struct {
	count     int
	windowEnd time.Time
}

// NewAuthFailureLimiter builds a limiter with this package's standard
// bounds, for cmd/server to hand to RequireAPIToken. One limiter is shared
// across every API route so an attacker can't multiply their budget by
// spreading attempts over different endpoints.
func NewAuthFailureLimiter() *authFailureLimiter {
	return newAuthFailureLimiter(authFailureLimit, authFailureWindow)
}

// newAuthFailureLimiter builds a limiter allowing limit failures per
// window per key. Unexported so tests can use tighter bounds than the
// package defaults.
func newAuthFailureLimiter(limit int, window time.Duration) *authFailureLimiter {
	return &authFailureLimiter{
		limit:    limit,
		window:   window,
		attempts: make(map[string]*failureWindow),
	}
}

// Allow reports whether key is currently under its failure budget.
func (l *authFailureLimiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	entry, ok := l.attempts[key]
	if !ok || time.Now().After(entry.windowEnd) {
		return true
	}
	return entry.count < l.limit
}

// RecordFailure counts one failed attempt against key, starting a fresh
// window if the previous one has expired.
func (l *authFailureLimiter) RecordFailure(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	entry, ok := l.attempts[key]
	if !ok || now.After(entry.windowEnd) {
		l.attempts[key] = &failureWindow{count: 1, windowEnd: now.Add(l.window)}
		// Opportunistically drop expired entries so a stream of failures
		// from many sources can't grow this map without bound.
		l.evictExpiredLocked(now)
		return
	}
	entry.count++
}

// evictExpiredLocked removes entries whose window has closed. Callers must
// hold l.mu.
func (l *authFailureLimiter) evictExpiredLocked(now time.Time) {
	for key, entry := range l.attempts {
		if now.After(entry.windowEnd) {
			delete(l.attempts, key)
		}
	}
}
