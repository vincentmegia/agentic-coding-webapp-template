// Package handler contains HTTP handlers: request parsing, input
// validation, calling services, and response rendering. See
// docs/skills/go-backend/SKILL.md "Handler".
package handler

import "net/http"

// Healthz reports whether the process can serve traffic. It is
// unauthenticated, dependency-light, and fast, per
// docs/skills/go-backend/SKILL.md "Health Checks". Once the app has a
// database, this should also verify connectivity.
func Healthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("ok"))
}
