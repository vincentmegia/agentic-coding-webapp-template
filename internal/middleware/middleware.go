// Package middleware provides cross-cutting HTTP concerns (panic recovery,
// request IDs, logging, security headers) composed around the application's
// handlers. See docs/skills/go-backend/SKILL.md "Middleware".
package middleware

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// requestIDKey is the context key under which the request ID is stored.
type requestIDKey struct{}

// clientIPKey is the context key under which ClientIP's middleware stores
// the resolved client identifier — see ClientKey.
type clientIPKey struct{}

// ClientIP returns middleware that resolves the address identifying a
// request's origin — used by every in-process rate limiter
// (internal/handler's api_auth.go/fishing_game.go/cooking_game.go) — and
// attaches it to the request context for ClientKey to read.
//
// When trustProxyHeaders is false (the default, and the only safe choice
// for a deployment not behind a known reverse proxy), the result is
// always r.RemoteAddr with its port stripped.
//
// When true, the last entry of the X-Forwarded-For header is used
// instead, if present. Enable this ONLY when the app is deployed behind
// exactly one trusted reverse proxy known to append the real client
// address as that header's last hop (this app's Render deployment does).
// Without such a proxy in front, or behind a proxy that doesn't control
// this header, X-Forwarded-For is attacker-supplied: a client could set
// it to a fresh value on every request to dodge a limiter entirely, or to
// a fixed value shared with other requests to collapse everyone into (or
// exhaust) one bucket — exactly the failure mode trusting it is meant to
// fix, just moved rather than closed. cfg.Config.TrustProxyHeaders is the
// one place this gets decided, at startup, not per-request.
func ClientIP(trustProxyHeaders bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := context.WithValue(r.Context(), clientIPKey{}, resolveClientIP(r, trustProxyHeaders))
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// ClientKey returns the request's resolved client identifier: the value
// ClientIP's middleware attached to the context, or — if that middleware
// did not run, as in a handler test that invokes the handler directly —
// the same RemoteAddr-only fallback ClientIP uses when trustProxyHeaders
// is false. Callers needing a per-caller rate-limit key should use this
// instead of reading r.RemoteAddr directly, so every limiter in the app
// agrees on one definition of "caller" and honors TRUST_PROXY_HEADERS
// automatically rather than each reimplementing the same trust decision.
func ClientKey(r *http.Request) string {
	if ip, ok := r.Context().Value(clientIPKey{}).(string); ok {
		return ip
	}
	return resolveClientIP(r, false)
}

func resolveClientIP(r *http.Request, trustProxyHeaders bool) string {
	if trustProxyHeaders {
		if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
			parts := strings.Split(fwd, ",")
			if last := strings.TrimSpace(parts[len(parts)-1]); last != "" {
				return last
			}
		}
	}
	return hostOnly(r.RemoteAddr)
}

// hostOnly strips the ":port" suffix from a host:port address (as found
// in r.RemoteAddr) — the port differs per connection even from the same
// caller, so keeping it would put every retry in its own bucket.
func hostOnly(addr string) string {
	if idx := strings.LastIndex(addr, ":"); idx != -1 {
		return addr[:idx]
	}
	return addr
}

// RequestIDFromContext returns the request ID associated with ctx, or ""
// if none is present.
func RequestIDFromContext(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey{}).(string)
	return id
}

// Recover catches panics from downstream handlers so a single failing
// request cannot crash the process.
func Recover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if err := recover(); err != nil {
				slog.Error("panic recovered",
					"error", err,
					"request_id", RequestIDFromContext(r.Context()),
				)
				http.Error(w, "internal server error", http.StatusInternalServerError)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// RequestID generates a random ID for each incoming request and attaches it
// to the request context so downstream layers (handlers, logging) can
// correlate their output. It also echoes the ID back as a response header.
func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := newRequestID()
		ctx := context.WithValue(r.Context(), requestIDKey{}, id)
		w.Header().Set("X-Request-ID", id)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func newRequestID() string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		// crypto/rand failing is effectively unrecoverable, but a missing
		// request ID is not worth crashing the request over.
		return "unknown"
	}
	return hex.EncodeToString(buf)
}

// statusRecorder wraps http.ResponseWriter to capture the status code
// written, so Logging can report it after the handler has run.
type statusRecorder struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (rec *statusRecorder) WriteHeader(status int) {
	if !rec.wroteHeader {
		rec.status = status
		rec.wroteHeader = true
	}
	rec.ResponseWriter.WriteHeader(status)
}

func (rec *statusRecorder) Write(b []byte) (int, error) {
	if !rec.wroteHeader {
		rec.status = http.StatusOK
		rec.wroteHeader = true
	}
	return rec.ResponseWriter.Write(b)
}

// Logging logs one structured line per request: method, path, status,
// duration, and request ID, per docs/skills/go-backend/SKILL.md "Logging".
func Logging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w}

		next.ServeHTTP(rec, r)

		slog.Info("http_request",
			"operation", r.Method+" "+r.URL.Path,
			"request_id", RequestIDFromContext(r.Context()),
			"status", rec.status,
			"duration", time.Since(start),
		)
	})
}

// SecurityHeaders sets response security headers on every response, per
// docs/skills/go-backend/SKILL.md "Security Headers". The CSP is
// intentionally strict: this app serves only same-origin static assets and
// server-rendered HTML, with no inline scripts or styles.
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
		next.ServeHTTP(w, r)
	})
}

// Chain composes middleware around a base handler, applying them in the
// order given so that the first middleware listed is outermost.
func Chain(h http.Handler, mw ...func(http.Handler) http.Handler) http.Handler {
	for i := len(mw) - 1; i >= 0; i-- {
		h = mw[i](h)
	}
	return h
}
