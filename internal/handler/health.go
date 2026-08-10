package handler

import (
	"context"
	"database/sql"
	"log/slog"
	"net/http"
	"time"
)

// HealthHandler reports whether the process can serve traffic, including
// database connectivity. Replaces the old dependency-free Healthz function
// now that the app has a database (docs/features/resume.md's Data Model —
// the first feature requiring one). See
// docs/skills/go-backend/SKILL.md "Health Checks".
type HealthHandler struct {
	DB *sql.DB
}

// NewHealthHandler constructs a HealthHandler.
func NewHealthHandler(db *sql.DB) *HealthHandler {
	return &HealthHandler{DB: db}
}

// Index handles GET /healthz. The response body never carries the
// underlying driver error, connection string, or host — an unauthenticated
// public endpoint must not hand out infrastructure detail (see
// docs/features/resume.md's Security Considerations).
func (h *HealthHandler) Index(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")

	if err := h.DB.PingContext(ctx); err != nil {
		slog.Error("healthz: database unreachable", "error", err)
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Write([]byte("unavailable"))
		return
	}

	w.WriteHeader(http.StatusOK)
	w.Write([]byte("ok"))
}
