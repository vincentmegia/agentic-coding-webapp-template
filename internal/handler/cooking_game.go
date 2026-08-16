package handler

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/vincentmegia/vincentmegia/internal/service"
)

// cookingLeaderboardLimit is the top-N size shown on the public
// leaderboard (docs/features/cooking-game.md's Business Rules: "top N
// (e.g. 20) by total_earnings, descending").
const cookingLeaderboardLimit = 20

// CookingGameHandler serves /kitchen-shift and its two leaderboard routes.
// See docs/features/cooking-game.md's Routes/Handlers.
type CookingGameHandler struct {
	Renderer *Renderer
	Service  *service.CookingService
	// Version is injected the same way as FishingGameHandler.Version — the
	// footer version is shared shell state, not cooking-game-specific.
	Version string
	// limiter enforces docs/features/cooking-game.md's Security
	// Considerations: "POST /kitchen-shift/score rate-limited (e.g.
	// per-IP)". Reuses scoreSubmitLimiter (internal/handler/fishing_game.go)
	// with its own limit/window, not a shared instance — each feature's
	// leaderboard gets an independent rate budget.
	limiter *scoreSubmitLimiter
}

// NewCookingGameHandler constructs a CookingGameHandler.
func NewCookingGameHandler(renderer *Renderer, cookingService *service.CookingService, version string) *CookingGameHandler {
	return &CookingGameHandler{
		Renderer: renderer,
		Service:  cookingService,
		Version:  version,
		limiter:  newScoreSubmitLimiter(cookingScoreSubmitLimit, cookingScoreSubmitWindow),
	}
}

// Index handles GET /kitchen-shift. There's no database fetch here: every
// player-specific value (Gard, shop levels, current shift) loads
// client-side from localStorage, and the leaderboard itself loads via its
// own request (GET /kitchen-shift/leaderboard), not inline — see
// docs/features/cooking-game.md's Routes/Handlers table.
func (h *CookingGameHandler) Index(w http.ResponseWriter, r *http.Request) {
	data := shellPageData(r, h.Version, "Kitchen Shift", false)
	data.ContentTemplate = "cooking-game-content"
	h.Renderer.Render(w, r, data)
}

// Leaderboard handles GET /kitchen-shift/leaderboard, returning the
// cooking-leaderboard fragment (innerHTML target, per the HTMX
// Interactions table). Always a bare fragment, never wrapped in the page
// shell.
func (h *CookingGameHandler) Leaderboard(w http.ResponseWriter, r *http.Request) {
	scores, err := h.Service.Leaderboard(r.Context(), cookingLeaderboardLimit)
	if err != nil {
		slog.Error("get cooking leaderboard", "error", err)
		writeCookingLeaderboardError(w)
		return
	}
	h.Renderer.RenderFragment(w, "cooking-leaderboard", scores)
}

// SubmitScore handles POST /kitchen-shift/score: validates and inserts a
// leaderboard entry, then returns the refreshed fragment (outerHTML
// target, per the HTMX Interactions table) so a successful submission's
// own row is visible immediately.
//
// Request parsing: standard HTML form encoding
// (application/x-www-form-urlencoded), read via r.ParseForm()/
// r.FormValue — not JSON. Same reasoning as
// FishingGameHandler.SubmitScore's doc comment.
//
// TEMPORARY, matching FishingGameHandler.SubmitScore's exact same
// documented gap: no CSRF mechanism exists anywhere in this codebase yet
// (see PagesHandler.Logout's doc comment) — this route's exposure is
// identical to, not worse than, that already-accepted gap.
func (h *CookingGameHandler) SubmitScore(w http.ResponseWriter, r *http.Request) {
	if !h.limiter.Allow(r.RemoteAddr) {
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
		if isCookingValidationError(err) {
			// A curated, user-facing sentinel from
			// service.ValidateCookingScoreSubmission — safe to surface
			// directly, unlike a raw DB error.
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		// Anything else (e.g. a DB failure) is never shown to the client.
		slog.Error("submit cooking score", "error", err)
		writeCookingLeaderboardError(w)
		return
	}

	scores, err := h.Service.Leaderboard(r.Context(), cookingLeaderboardLimit)
	if err != nil {
		slog.Error("get cooking leaderboard after submit", "error", err)
		writeCookingLeaderboardError(w)
		return
	}
	h.Renderer.RenderFragment(w, "cooking-leaderboard", scores)
}

// isCookingValidationError reports whether err is one of
// service.ValidateCookingScoreSubmission's sentinel errors, as opposed to
// an unexpected/internal failure (e.g. a DB error) that must not be shown
// to the client.
func isCookingValidationError(err error) bool {
	for _, sentinel := range []error{
		service.ErrCookingScorePlayerNameRequired,
		service.ErrCookingScorePlayerNameTooLong,
		service.ErrCookingScoreEarningsOutOfRange,
		service.ErrCookingScoreShiftsOutOfRange,
	} {
		if errors.Is(err, sentinel) {
			return true
		}
	}
	return false
}

// writeCookingLeaderboardError renders the "Leaderboard error" UI state
// (docs/features/cooking-game.md's UI table): "a generic 'couldn't load
// the leaderboard' message; the rest of the page still works." Kept as a
// small hand-written fragment (not a parsed template), matching
// writeFishingLeaderboardError's exact same reasoning.
func writeCookingLeaderboardError(w http.ResponseWriter) {
	// 200, not 5xx — see writeFishingLeaderboardError's doc comment for why.
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`<p id="cooking-leaderboard" class="rounded-card border border-line bg-surface px-4 py-3 text-sm text-muted">Couldn't load the leaderboard.</p>`))
}

// cookingScoreSubmitLimit/cookingScoreSubmitWindow bound this feature's
// scoreSubmitLimiter instance: at most this many
// POST /kitchen-shift/score requests per source per window. Same coarse
// anti-spam values as fishingScoreSubmitLimit/fishingScoreSubmitWindow
// (internal/handler/fishing_game.go), not tuned against real traffic.
const (
	cookingScoreSubmitLimit  = 5
	cookingScoreSubmitWindow = time.Minute
)
