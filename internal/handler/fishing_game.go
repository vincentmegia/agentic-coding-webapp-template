package handler

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/vincentmegia/vincentmegia/internal/service"
)

// fishingLeaderboardLimit is the top-N size shown on the public
// leaderboard (docs/features/fishing-game.md's Business Rules: "top N
// (e.g. 20) by score, descending").
const fishingLeaderboardLimit = 20

// FishingGameHandler serves /fishing-game and its two leaderboard routes.
// See docs/features/fishing-game.md's Routes/Handlers.
type FishingGameHandler struct {
	Renderer *Renderer
	Service  *service.FishingService
	// Version is injected the same way as PagesHandler.Version/
	// ResumeHandler.Version (see their doc comments) — the footer version
	// is shared shell state, not fishing-game-specific.
	Version string
	// limiter enforces docs/features/fishing-game.md's Security
	// Considerations: "POST /fishing-game/score should be rate-limited
	// (e.g. per-IP) to prevent a script from flooding the leaderboard with
	// junk entries". See scoreSubmitLimiter's doc comment for its scope.
	limiter *scoreSubmitLimiter
}

// NewFishingGameHandler constructs a FishingGameHandler.
func NewFishingGameHandler(renderer *Renderer, fishingService *service.FishingService, version string) *FishingGameHandler {
	return &FishingGameHandler{
		Renderer: renderer,
		Service:  fishingService,
		Version:  version,
		limiter:  newScoreSubmitLimiter(fishingScoreSubmitLimit, fishingScoreSubmitWindow),
	}
}

// Index handles GET /fishing-game.
//
// Renders the real page content (web/templates/pages/fishing-game.html —
// canvas, HUD, start/round-over/shop overlays, leaderboard placeholder) now
// that it exists (feature breakdown task #4). Unlike ResumeHandler.Index,
// there's no database fetch here: every player-specific value (tokens, gear,
// best score/depth) loads client-side from localStorage, and the
// leaderboard itself loads via its own request (GET /fishing-game/
// leaderboard), not inline — see docs/features/fishing-game.md's Routes/
// Handlers table. So this handler only needs to set ContentTemplate and
// render, same as ResumeHandler.Index but with nothing extra to pass in
// PageData.
func (h *FishingGameHandler) Index(w http.ResponseWriter, r *http.Request) {
	data := shellPageData(r, h.Version, "Fishing Game", false)
	data.ContentTemplate = "fishing-game-content"
	h.Renderer.Render(w, r, data)
}

// Leaderboard handles GET /fishing-game/leaderboard, returning the
// fishing-leaderboard fragment (innerHTML target, per the HTMX
// Interactions table). Always a bare fragment, never wrapped in the page
// shell — see Renderer.RenderFragment's doc comment for why this differs
// from Index/Renderer.Render.
func (h *FishingGameHandler) Leaderboard(w http.ResponseWriter, r *http.Request) {
	scores, err := h.Service.Leaderboard(r.Context(), fishingLeaderboardLimit)
	if err != nil {
		// Never expose the raw error to the client, per
		// docs/skills/go-backend/SKILL.md "Errors" — and per this doc's
		// "Leaderboard error" UI state, a generic inline message, not a
		// blank fragment or a raw error string.
		slog.Error("get fishing leaderboard", "error", err)
		writeFishingLeaderboardError(w)
		return
	}
	h.Renderer.RenderFragment(w, "fishing-leaderboard", scores)
}

// SubmitScore handles POST /fishing-game/score: validates and inserts a
// leaderboard entry, then returns the refreshed fragment (outerHTML
// target, per the HTMX Interactions table) so a successful submission's
// own row is visible immediately.
//
// Request parsing: standard HTML form encoding
// (application/x-www-form-urlencoded), read via r.ParseForm()/
// r.FormValue — not JSON. The only realistic client here is an HTMX
// hx-post on a plain <form> (docs/features/fishing-game.md's HTMX
// Interactions: "Submit to leaderboard" on the round-over screen), and
// that's exactly what a form submit sends by default with no extra JS
// needed to serialize a JSON body — consistent with htmx-ui's "avoid
// unnecessary JavaScript" principle.
//
// TEMPORARY, matching PagesHandler.Logout's exact same documented gap:
// there is no CSRF mechanism anywhere in this codebase yet — it is
// explicitly deferred to a not-yet-built auth feature, tied to session
// infrastructure that doesn't exist (see PagesHandler.Logout's doc
// comment). This route is not CSRF-safe until that infra lands; do not
// consider it protected in the meantime. (docs/features/fishing-game.md's
// Security Considerations calls for CSRF coverage "same as POST /logout" —
// this route's exposure is therefore identical to, not worse than, an
// already-accepted gap elsewhere in the app.)
func (h *FishingGameHandler) SubmitScore(w http.ResponseWriter, r *http.Request) {
	if !h.limiter.Allow(r.RemoteAddr) {
		http.Error(w, "Too many submissions — please slow down and try again shortly.", http.StatusTooManyRequests)
		return
	}

	if err := r.ParseForm(); err != nil {
		http.Error(w, "Couldn't read that submission.", http.StatusBadRequest)
		return
	}

	playerName := r.FormValue("player_name")
	score, scoreErr := strconv.Atoi(r.FormValue("score"))
	depth, depthErr := strconv.Atoi(r.FormValue("depth_reached_miles"))
	if scoreErr != nil || depthErr != nil {
		http.Error(w, "Score and depth must be whole numbers.", http.StatusBadRequest)
		return
	}

	if err := h.Service.SubmitScore(r.Context(), playerName, score, depth); err != nil {
		if isFishingValidationError(err) {
			// A curated, user-facing sentinel from
			// service.ValidateFishingScoreSubmission — safe to surface
			// directly, unlike a raw DB error (docs/features/
			// fishing-game.md's Security Considerations: "a bad request
			// gets a clear 4xx rather than a raw constraint-violation
			// error").
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		// Anything else (e.g. a DB failure) is never shown to the client.
		slog.Error("submit fishing score", "error", err)
		writeFishingLeaderboardError(w)
		return
	}

	scores, err := h.Service.Leaderboard(r.Context(), fishingLeaderboardLimit)
	if err != nil {
		slog.Error("get fishing leaderboard after submit", "error", err)
		writeFishingLeaderboardError(w)
		return
	}
	h.Renderer.RenderFragment(w, "fishing-leaderboard", scores)
}

// isFishingValidationError reports whether err is one of
// service.ValidateFishingScoreSubmission's sentinel errors, as opposed to
// an unexpected/internal failure (e.g. a DB error) that must not be shown
// to the client.
func isFishingValidationError(err error) bool {
	for _, sentinel := range []error{
		service.ErrFishingScorePlayerNameRequired,
		service.ErrFishingScorePlayerNameTooLong,
		service.ErrFishingScoreOutOfRange,
		service.ErrFishingScoreDepthOutOfRange,
	} {
		if errors.Is(err, sentinel) {
			return true
		}
	}
	return false
}

// writeFishingLeaderboardError renders the "Leaderboard error" UI state
// (docs/features/fishing-game.md's UI table): "a generic 'couldn't load
// the leaderboard' message; the rest of the page (game, shop) still
// works." Kept as a small hand-written fragment (not a parsed template)
// since it's a single static string with no dynamic data to escape, and
// carries the same #fishing-leaderboard id so a subsequent outerHTML/
// innerHTML swap target still resolves correctly.
func writeFishingLeaderboardError(w http.ResponseWriter) {
	// 200, not 5xx: htmx only swaps a response's content into the DOM on a
	// 2xx status by default, and this fragment's whole purpose is to be
	// swapped in as the visible "couldn't load" state rather than left for
	// an htmx:responseError handler this codebase doesn't wire up.
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`<p id="fishing-leaderboard" class="rounded-card border border-line bg-surface px-4 py-3 text-sm text-muted">Couldn't load the leaderboard.</p>`))
}

// fishingScoreSubmitLimit/fishingScoreSubmitWindow bound the rate limiter
// below: at most this many POST /fishing-game/score requests per source
// per window. Values are a coarse anti-spam speed bump (docs/features/
// fishing-game.md's Security Considerations: "the concern here is
// nuisance/pollution, not high-value fraud"), not tuned against real
// traffic.
const (
	fishingScoreSubmitLimit  = 5
	fishingScoreSubmitWindow = time.Minute
)

// scoreSubmitLimiter is a small in-memory, fixed-window, per-key rate
// limiter for POST /fishing-game/score.
//
// Deliberately simple and self-contained: this app runs as a single
// process today (see cmd/server/main.go), so in-memory state is an
// honestly-scoped choice, not a shortcut standing in for real
// infrastructure. Two concrete limitations follow from that and are
// intentionally not addressed here:
//   - State resets on every process restart, so a restart briefly resets
//     everyone's limit.
//   - It is per-process, not shared, so it stops being an accurate limit
//     the moment this app runs as more than one instance (e.g. behind a
//     load balancer). Revisit with a shared store (e.g. Redis) if/when
//     that becomes true.
//
// It also never evicts stale entries, so its memory grows with the number
// of distinct source addresses seen over the process's lifetime — fine for
// this feature's expected traffic, worth revisiting if it ever isn't.
type scoreSubmitLimiter struct {
	mu      sync.Mutex
	limit   int
	window  time.Duration
	entries map[string]*submitWindow
}

type submitWindow struct {
	count      int
	windowEnds time.Time
}

// newScoreSubmitLimiter constructs a limiter allowing at most limit
// requests per key per window.
func newScoreSubmitLimiter(limit int, window time.Duration) *scoreSubmitLimiter {
	return &scoreSubmitLimiter{
		limit:   limit,
		window:  window,
		entries: make(map[string]*submitWindow),
	}
}

// Allow reports whether a request from key (e.g. r.RemoteAddr) may
// proceed, consuming one slot in its current window if so.
func (l *scoreSubmitLimiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	w, ok := l.entries[key]
	if !ok || now.After(w.windowEnds) {
		l.entries[key] = &submitWindow{count: 1, windowEnds: now.Add(l.window)}
		return true
	}
	if w.count >= l.limit {
		return false
	}
	w.count++
	return true
}
