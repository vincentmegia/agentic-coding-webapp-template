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

// busRushLeaderboardLimit is the top-N size shown on the leaderboard.
const busRushLeaderboardLimit = 20

const (
	busRushScoreSubmitLimit  = 5
	busRushScoreSubmitWindow = time.Minute
)

// BusRushHandler serves /bus-rush and its two leaderboard routes. See
// docs/features/bus-rush.md's Routes/Handlers. Same shape as
// FishingGameHandler: the page has no DB read (player state is
// localStorage), the leaderboard loads via its own HTMX request.
type BusRushHandler struct {
	Renderer *Renderer
	Service  *service.BusRushService
	Version  string
	limiter  *scoreSubmitLimiter
}

// NewBusRushHandler constructs a BusRushHandler.
func NewBusRushHandler(renderer *Renderer, busRushService *service.BusRushService, version string) *BusRushHandler {
	return &BusRushHandler{
		Renderer: renderer,
		Service:  busRushService,
		Version:  version,
		limiter:  newScoreSubmitLimiter(busRushScoreSubmitLimit, busRushScoreSubmitWindow),
	}
}

// Index handles GET /bus-rush.
func (h *BusRushHandler) Index(w http.ResponseWriter, r *http.Request) {
	data := shellPageData(r, h.Version, "Bus Rush", false)
	data.ContentTemplate = "bus-rush-content"
	h.Renderer.Render(w, r, data)
}

// Leaderboard handles GET /bus-rush/leaderboard, returning the bare
// bus-rush-leaderboard fragment.
func (h *BusRushHandler) Leaderboard(w http.ResponseWriter, r *http.Request) {
	scores, err := h.Service.Leaderboard(r.Context(), busRushLeaderboardLimit)
	if err != nil {
		slog.Error("get bus rush leaderboard", "error", err)
		writeBusRushLeaderboardError(w)
		return
	}
	h.Renderer.RenderFragment(w, "bus-rush-leaderboard", scores)
}

// SubmitScore handles POST /bus-rush/score (form-encoded player_name,
// score, distance_meters) and returns the refreshed leaderboard fragment.
// Same CSRF gap as FishingGameHandler.SubmitScore — see its doc comment.
func (h *BusRushHandler) SubmitScore(w http.ResponseWriter, r *http.Request) {
	if !h.limiter.Allow(middleware.ClientKey(r)) {
		http.Error(w, "Too many submissions — please slow down and try again shortly.", http.StatusTooManyRequests)
		return
	}

	if err := r.ParseForm(); err != nil {
		http.Error(w, "Couldn't read that submission.", http.StatusBadRequest)
		return
	}

	playerName := r.FormValue("player_name")
	score, scoreErr := strconv.Atoi(r.FormValue("score"))
	distance, distanceErr := strconv.Atoi(r.FormValue("distance_meters"))
	if scoreErr != nil || distanceErr != nil {
		http.Error(w, "Score and distance must be whole numbers.", http.StatusBadRequest)
		return
	}

	if err := h.Service.SubmitScore(r.Context(), playerName, score, distance); err != nil {
		if isBusRushValidationError(err) {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		slog.Error("submit bus rush score", "error", err)
		writeBusRushLeaderboardError(w)
		return
	}

	scores, err := h.Service.Leaderboard(r.Context(), busRushLeaderboardLimit)
	if err != nil {
		slog.Error("get bus rush leaderboard after submit", "error", err)
		writeBusRushLeaderboardError(w)
		return
	}
	h.Renderer.RenderFragment(w, "bus-rush-leaderboard", scores)
}

// isBusRushValidationError reports whether err is a curated, user-facing
// validation sentinel rather than an internal failure.
func isBusRushValidationError(err error) bool {
	for _, sentinel := range []error{
		service.ErrBusRushPlayerNameRequired,
		service.ErrBusRushPlayerNameTooLong,
		service.ErrBusRushScoreOutOfRange,
		service.ErrBusRushDistanceOutOfRange,
	} {
		if errors.Is(err, sentinel) {
			return true
		}
	}
	return false
}

// writeBusRushLeaderboardError renders the leaderboard's error state. 200,
// not 5xx, so htmx swaps it in (see writeFishingLeaderboardError).
func writeBusRushLeaderboardError(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`<p id="bus-rush-leaderboard" class="rounded-card border border-line bg-surface px-4 py-3 text-sm text-muted">Couldn't load the leaderboard.</p>`))
}
