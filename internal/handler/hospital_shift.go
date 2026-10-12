package handler

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/vincentmegia/vincentmegia/internal/middleware"
	"github.com/vincentmegia/vincentmegia/internal/service"
)

// hospitalLeaderboardLimit is the top-N size shown on the public
// leaderboard, same value as cookingLeaderboardLimit
// (docs/features/hospital-shift.md's Data Model mirrors cooking_scores).
const hospitalLeaderboardLimit = 20

// HospitalShiftHandler serves /hospital-shift and its two leaderboard routes.
// See docs/features/hospital-shift.md's Routes/Handlers.
type HospitalShiftHandler struct {
	Renderer *Renderer
	Service  *service.HospitalService
	// Version is injected the same way as CookingGameHandler.Version — the
	// footer version is shared shell state, not hospital-game-specific.
	Version string
	// limiter enforces docs/features/hospital-shift.md's Security
	// Considerations: "POST /hospital-shift/score is rate-limited per-IP via
	// a dedicated scoreSubmitLimiter instance (own limit/window, not
	// shared with the other two games' limiters)".
	limiter *scoreSubmitLimiter
}

// NewHospitalShiftHandler constructs a HospitalShiftHandler.
func NewHospitalShiftHandler(renderer *Renderer, hospitalService *service.HospitalService, version string) *HospitalShiftHandler {
	return &HospitalShiftHandler{
		Renderer: renderer,
		Service:  hospitalService,
		Version:  version,
		limiter:  newScoreSubmitLimiter(hospitalScoreSubmitLimit, hospitalScoreSubmitWindow),
	}
}

// Index handles GET /hospital-shift. There's no database fetch here: every
// player-specific value (Gard, current shift) loads client-side from
// localStorage, and the leaderboard itself loads via its own request
// (GET /hospital-shift/leaderboard), not inline — see
// docs/features/hospital-shift.md's Routes/Handlers table.
func (h *HospitalShiftHandler) Index(w http.ResponseWriter, r *http.Request) {
	data := shellPageData(r, h.Version, "Hospital Shift", false)
	data.ContentTemplate = "hospital-shift-content"
	h.Renderer.Render(w, r, data)
}

// Leaderboard handles GET /hospital-shift/leaderboard, returning the
// hospital-leaderboard fragment (innerHTML target, per the HTMX
// Interactions table). Always a bare fragment, never wrapped in the page
// shell.
func (h *HospitalShiftHandler) Leaderboard(w http.ResponseWriter, r *http.Request) {
	scores, err := h.Service.Leaderboard(r.Context(), hospitalLeaderboardLimit)
	if err != nil {
		slog.Error("get hospital leaderboard", "error", err)
		writeHospitalLeaderboardError(w)
		return
	}
	h.Renderer.RenderFragment(w, "hospital-leaderboard", scores)
}

// SubmitScore handles POST /hospital-shift/score: validates and inserts a
// leaderboard entry, then returns the refreshed fragment (outerHTML
// target, per the HTMX Interactions table) so a successful submission's
// own row is visible immediately.
//
// Request parsing: standard HTML form encoding
// (application/x-www-form-urlencoded), read via r.ParseForm()/
// r.FormValue — not JSON. Same reasoning as
// CookingGameHandler.SubmitScore's doc comment.
//
// TEMPORARY, matching CookingGameHandler.SubmitScore's exact same
// documented gap: no CSRF mechanism exists anywhere in this codebase yet
// (see PagesHandler.Logout's doc comment) — this route's exposure is
// identical to, not worse than, that already-accepted gap.
func (h *HospitalShiftHandler) SubmitScore(w http.ResponseWriter, r *http.Request) {
	if !h.limiter.Allow(middleware.ClientKey(r)) {
		http.Error(w, "Too many submissions — please slow down and try again shortly.", http.StatusTooManyRequests)
		return
	}

	if err := r.ParseForm(); err != nil {
		http.Error(w, "Couldn't read that submission.", http.StatusBadRequest)
		return
	}

	playerName := r.FormValue("player_name")
	totalEarnings, earningsErr := strconv.Atoi(r.FormValue("total_earnings"))
	shiftsCompleted, shiftsErr := strconv.Atoi(r.FormValue("shifts_completed"))
	if earningsErr != nil || shiftsErr != nil {
		http.Error(w, "Total earnings and shifts completed must be whole numbers.", http.StatusBadRequest)
		return
	}

	if err := h.Service.SubmitScore(r.Context(), playerName, totalEarnings, shiftsCompleted); err != nil {
		if isHospitalValidationError(err) {
			// A curated, user-facing sentinel from
			// service.ValidateHospitalScoreSubmission — safe to surface
			// directly, unlike a raw DB error.
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		// Anything else (e.g. a DB failure) is never shown to the client.
		slog.Error("submit hospital score", "error", err)
		writeHospitalLeaderboardError(w)
		return
	}

	scores, err := h.Service.Leaderboard(r.Context(), hospitalLeaderboardLimit)
	if err != nil {
		slog.Error("get hospital leaderboard after submit", "error", err)
		writeHospitalLeaderboardError(w)
		return
	}
	h.Renderer.RenderFragment(w, "hospital-leaderboard", scores)
}

// isHospitalValidationError reports whether err is one of
// service.ValidateHospitalScoreSubmission's sentinel errors, as opposed to
// an unexpected/internal failure (e.g. a DB error) that must not be shown
// to the client.
func isHospitalValidationError(err error) bool {
	for _, sentinel := range []error{
		service.ErrHospitalScorePlayerNameRequired,
		service.ErrHospitalScorePlayerNameTooLong,
		service.ErrHospitalScoreEarningsOutOfRange,
		service.ErrHospitalScoreShiftsOutOfRange,
	} {
		if errors.Is(err, sentinel) {
			return true
		}
	}
	return false
}

// writeHospitalLeaderboardError renders the "Leaderboard error" UI state
// (docs/features/hospital-shift.md's UI table): "Leaderboard fetch failure
// renders an inline error state in the fragment, same as
// writeCookingLeaderboardError's pattern." Kept as a small hand-written
// fragment (not a parsed template), matching that exact same reasoning.
func writeHospitalLeaderboardError(w http.ResponseWriter) {
	// 200, not 5xx — see writeCookingLeaderboardError's doc comment for why.
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`<p id="hospital-leaderboard" class="rounded-card border border-line bg-surface px-4 py-3 text-sm text-muted">Couldn't load the leaderboard.</p>`))
}

// hospitalScoreSubmitLimit/hospitalScoreSubmitWindow bound this feature's own
// scoreSubmitLimiter instance: at most this many POST /hospital-shift/score
// requests per source per window. Same coarse anti-spam values as
// cookingScoreSubmitLimit/cookingScoreSubmitWindow — a dedicated instance,
// not shared with the other games' limiters, per
// docs/features/hospital-shift.md's Security Considerations.
const (
	hospitalScoreSubmitLimit  = 5
	hospitalScoreSubmitWindow = time.Minute
)
