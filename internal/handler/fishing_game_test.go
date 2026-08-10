package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/vincentmegia/vincentmegia/internal/model"
	"github.com/vincentmegia/vincentmegia/internal/service"
)

// fakeFishingRepository is an in-memory stand-in used to exercise
// FishingGameHandler without a real Postgres connection — same idea as
// internal/service/fishing_service_test.go's fake, duplicated here since
// it implements an unexported interface local to the service package
// (service.FishingService's Repo field) that this package can satisfy
// structurally but not name.
type fakeFishingRepository struct {
	scores    []model.FishingScore
	insertErr error
	topErr    error
}

func (f *fakeFishingRepository) Insert(ctx context.Context, playerName string, score, depthReachedMiles int) error {
	if f.insertErr != nil {
		return f.insertErr
	}
	f.scores = append(f.scores, model.FishingScore{PlayerName: playerName, Score: score, DepthReachedMiles: depthReachedMiles})
	return nil
}

func (f *fakeFishingRepository) TopScores(ctx context.Context, limit int) ([]model.FishingScore, error) {
	if f.topErr != nil {
		return nil, f.topErr
	}
	if len(f.scores) <= limit {
		return f.scores, nil
	}
	return f.scores[:limit], nil
}

func newTestFishingHandler(t *testing.T, repo *fakeFishingRepository) *FishingGameHandler {
	t.Helper()
	tmpl, err := LoadTemplates("../../web/templates")
	if err != nil {
		t.Fatalf("LoadTemplates: %v", err)
	}
	return &FishingGameHandler{
		Renderer: NewRenderer(tmpl),
		Service:  &service.FishingService{Repo: repo},
		Version:  "dev",
		limiter:  newScoreSubmitLimiter(fishingScoreSubmitLimit, fishingScoreSubmitWindow),
	}
}

// TestFishingGameHandler_Leaderboard_Empty verifies the "no scores yet"
// UI state (docs/features/fishing-game.md's UI table) renders when the
// leaderboard has no entries.
func TestFishingGameHandler_Leaderboard_Empty(t *testing.T) {
	h := newTestFishingHandler(t, &fakeFishingRepository{})

	rec := httptest.NewRecorder()
	h.Leaderboard(rec, httptest.NewRequest(http.MethodGet, "/fishing-game/leaderboard", nil))

	out := rec.Body.String()
	if !strings.Contains(out, "No scores yet") {
		t.Errorf("empty leaderboard missing empty-state copy\n--- output ---\n%s", out)
	}
	if !strings.Contains(out, `id="fishing-leaderboard"`) {
		t.Errorf("leaderboard fragment missing its #fishing-leaderboard id\n--- output ---\n%s", out)
	}
}

// TestFishingGameHandler_Leaderboard_Populated verifies populated entries
// render, and that a player_name containing HTML/script-like content is
// rendered as literal text (auto-escaping regression test, per the
// Testing Plan's explicit XSS item) — never executed or unescaped.
func TestFishingGameHandler_Leaderboard_Populated(t *testing.T) {
	repo := &fakeFishingRepository{
		scores: []model.FishingScore{
			{PlayerName: "Vince", Score: 1200, DepthReachedMiles: 450, CreatedAt: time.Now()},
			{PlayerName: `<script>alert(1)</script>`, Score: 900, DepthReachedMiles: 300, CreatedAt: time.Now()},
		},
	}
	h := newTestFishingHandler(t, repo)

	rec := httptest.NewRecorder()
	h.Leaderboard(rec, httptest.NewRequest(http.MethodGet, "/fishing-game/leaderboard", nil))

	out := rec.Body.String()
	for _, want := range []string{"Vince", "1200 pts", "450 mi", "&lt;script&gt;alert(1)&lt;/script&gt;"} {
		if !strings.Contains(out, want) {
			t.Errorf("leaderboard missing %q\n--- output ---\n%s", want, out)
		}
	}
	if strings.Contains(out, "<script>alert(1)</script>") {
		t.Errorf("leaderboard rendered a raw, unescaped <script> tag from player_name — XSS regression\n--- output ---\n%s", out)
	}
}

// TestFishingGameHandler_SubmitScore_Valid verifies a valid submission
// inserts and re-renders the leaderboard fragment with the new entry
// included.
func TestFishingGameHandler_SubmitScore_Valid(t *testing.T) {
	repo := &fakeFishingRepository{}
	h := newTestFishingHandler(t, repo)

	form := url.Values{"player_name": {"Vince"}, "score": {"1200"}, "depth_reached_miles": {"450"}}
	req := httptest.NewRequest(http.MethodPost, "/fishing-game/score", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.RemoteAddr = "203.0.113.10:12345"

	rec := httptest.NewRecorder()
	h.SubmitScore(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body: %s", rec.Code, rec.Body.String())
	}
	if len(repo.scores) != 1 {
		t.Fatalf("repo.scores len = %d, want 1", len(repo.scores))
	}
	if !strings.Contains(rec.Body.String(), "Vince") {
		t.Errorf("response missing the newly submitted entry\n--- output ---\n%s", rec.Body.String())
	}
}

// TestFishingGameHandler_SubmitScore_ValidationRejected verifies an
// out-of-range submission never reaches the repository and gets a 400
// with a clear inline error, not a raw DB error.
func TestFishingGameHandler_SubmitScore_ValidationRejected(t *testing.T) {
	repo := &fakeFishingRepository{}
	h := newTestFishingHandler(t, repo)

	form := url.Values{"player_name": {""}, "score": {"100"}, "depth_reached_miles": {"50"}}
	req := httptest.NewRequest(http.MethodPost, "/fishing-game/score", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.RemoteAddr = "203.0.113.11:12345"

	rec := httptest.NewRecorder()
	h.SubmitScore(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body: %s", rec.Code, rec.Body.String())
	}
	if len(repo.scores) != 0 {
		t.Errorf("repo.scores len = %d, want 0 (validation should reject before the repository)", len(repo.scores))
	}
	if strings.Contains(rec.Body.String(), "sql") || strings.Contains(rec.Body.String(), "constraint") {
		t.Errorf("error body looks like a raw DB error, not a validation message: %s", rec.Body.String())
	}
}

// TestFishingGameHandler_SubmitScore_OutOfRangeScore verifies the
// handler's own numeric bounds are enforced via the service (not just
// non-numeric input) — same coarse sanity bound as the DB CHECK
// constraint.
func TestFishingGameHandler_SubmitScore_OutOfRangeScore(t *testing.T) {
	repo := &fakeFishingRepository{}
	h := newTestFishingHandler(t, repo)

	form := url.Values{"player_name": {"Vince"}, "score": {strconv.Itoa(1_000_000)}, "depth_reached_miles": {"50"}}
	req := httptest.NewRequest(http.MethodPost, "/fishing-game/score", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.RemoteAddr = "203.0.113.12:12345"

	rec := httptest.NewRecorder()
	h.SubmitScore(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body: %s", rec.Code, rec.Body.String())
	}
	if len(repo.scores) != 0 {
		t.Errorf("repo.scores len = %d, want 0", len(repo.scores))
	}
}

// TestFishingGameHandler_SubmitScore_RateLimited verifies rapid repeated
// submissions from the same source are rejected once the per-IP limit is
// exhausted (docs/features/fishing-game.md's Testing Plan: "Rate limiting
// ... rejects rapid repeated submissions from the same source").
func TestFishingGameHandler_SubmitScore_RateLimited(t *testing.T) {
	repo := &fakeFishingRepository{}
	h := newTestFishingHandler(t, repo)

	form := url.Values{"player_name": {"Vince"}, "score": {"100"}, "depth_reached_miles": {"50"}}
	remoteAddr := "203.0.113.13:12345"

	var lastCode int
	for i := 0; i < fishingScoreSubmitLimit+1; i++ {
		req := httptest.NewRequest(http.MethodPost, "/fishing-game/score", strings.NewReader(form.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.RemoteAddr = remoteAddr
		rec := httptest.NewRecorder()
		h.SubmitScore(rec, req)
		lastCode = rec.Code
	}

	if lastCode != http.StatusTooManyRequests {
		t.Errorf("status of the request beyond the limit = %d, want %d", lastCode, http.StatusTooManyRequests)
	}
	if len(repo.scores) != fishingScoreSubmitLimit {
		t.Errorf("repo.scores len = %d, want %d (the rate-limited request must not have reached the repository)", len(repo.scores), fishingScoreSubmitLimit)
	}

	// A different source is unaffected by another IP's limit.
	req := httptest.NewRequest(http.MethodPost, "/fishing-game/score", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.RemoteAddr = "198.51.100.20:54321"
	rec := httptest.NewRecorder()
	h.SubmitScore(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("a different source's request status = %d, want 200, body: %s", rec.Code, rec.Body.String())
	}
}

// TestFishingGameHandler_Index verifies GET /fishing-game renders the
// shared generic placeholder (same pattern as PagesHandler.Projects/
// Blogs) since the real page shell is a separate, not-yet-built task.
func TestFishingGameHandler_Index(t *testing.T) {
	h := newTestFishingHandler(t, &fakeFishingRepository{})

	rec := httptest.NewRecorder()
	h.Index(rec, httptest.NewRequest(http.MethodGet, "/fishing-game", nil))

	out := rec.Body.String()
	if rec.Code != 0 && rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body: %s", rec.Code, out)
	}
	if !strings.Contains(out, "Fishing Game") {
		t.Errorf("index missing title/content\n--- output ---\n%s", out)
	}
	assertMainContentContainer(t, out)
}
