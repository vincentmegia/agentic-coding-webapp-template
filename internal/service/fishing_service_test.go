package service

import (
	"context"
	"errors"
	"testing"

	"github.com/vincentmegia/vincentmegia/internal/model"
)

// fakeFishingRepository is an in-memory stand-in for
// *repository.FishingRepository, satisfying the fishingRepository
// interface fishing_service.go declares — no real Postgres connection
// needed to exercise FishingService's own logic. Mirrors the
// house convention of testing services against a minimal fake rather than
// a real DB (see internal/handler/template_test.go's fixture-based
// approach for the analogous idea one layer up).
type fakeFishingRepository struct {
	scores      []model.FishingScore
	insertErr   error
	topErr      error
	insertCalls int
}

func (f *fakeFishingRepository) Insert(ctx context.Context, playerName string, score, depthReachedMiles int) error {
	f.insertCalls++
	if f.insertErr != nil {
		return f.insertErr
	}
	f.scores = append(f.scores, model.FishingScore{
		PlayerName:        playerName,
		Score:             score,
		DepthReachedMiles: depthReachedMiles,
	})
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

// TestFishingService_SubmitScore_Valid verifies a valid submission is
// trimmed by ValidateFishingScoreSubmission and reaches the repository
// exactly once with the trimmed name.
func TestFishingService_SubmitScore_Valid(t *testing.T) {
	repo := &fakeFishingRepository{}
	svc := &FishingService{Repo: repo}

	if err := svc.SubmitScore(context.Background(), "  Vince  ", 1200, 450); err != nil {
		t.Fatalf("SubmitScore: unexpected error: %v", err)
	}

	if repo.insertCalls != 1 {
		t.Fatalf("insert calls = %d, want 1", repo.insertCalls)
	}
	if got, want := repo.scores[0].PlayerName, "Vince"; got != want {
		t.Errorf("stored player name = %q, want %q (trimmed)", got, want)
	}
	if got, want := repo.scores[0].Score, 1200; got != want {
		t.Errorf("stored score = %d, want %d", got, want)
	}
	if got, want := repo.scores[0].DepthReachedMiles, 450; got != want {
		t.Errorf("stored depth = %d, want %d", got, want)
	}
}

// TestFishingService_SubmitScore_ValidationRejected verifies an
// out-of-bounds submission is rejected by ValidateFishingScoreSubmission
// and never reaches the repository's Insert at all — the validation
// error is returned unchanged.
func TestFishingService_SubmitScore_ValidationRejected(t *testing.T) {
	tests := []struct {
		name              string
		playerName        string
		score             int
		depthReachedMiles int
		wantErr           error
	}{
		{"blank name", "", 100, 50, ErrFishingScorePlayerNameRequired},
		{"name too long", "this-name-is-way-too-long-for-the-limit", 100, 50, ErrFishingScorePlayerNameTooLong},
		{"score out of range", "Vince", 1_000_000, 50, ErrFishingScoreOutOfRange},
		{"depth out of range", "Vince", 100, 1001, ErrFishingScoreDepthOutOfRange},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repo := &fakeFishingRepository{}
			svc := &FishingService{Repo: repo}

			err := svc.SubmitScore(context.Background(), tt.playerName, tt.score, tt.depthReachedMiles)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if repo.insertCalls != 0 {
				t.Errorf("insert calls = %d, want 0 (validation should reject before reaching the repository)", repo.insertCalls)
			}
		})
	}
}

// TestFishingService_SubmitScore_RepositoryError verifies a repository
// failure (e.g. a DB error) is wrapped and returned, not swallowed, and
// is distinguishable from a validation error (the handler relies on this
// to decide 400 vs. a generic error state).
func TestFishingService_SubmitScore_RepositoryError(t *testing.T) {
	repoErr := errors.New("connection refused")
	repo := &fakeFishingRepository{insertErr: repoErr}
	svc := &FishingService{Repo: repo}

	err := svc.SubmitScore(context.Background(), "Vince", 100, 50)
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	if errors.Is(err, ErrFishingScorePlayerNameRequired) || errors.Is(err, ErrFishingScoreOutOfRange) {
		t.Errorf("repository error should not be mistaken for a validation sentinel: %v", err)
	}
	if !errors.Is(err, repoErr) {
		t.Errorf("err = %v, want it to wrap %v", err, repoErr)
	}
}

// TestFishingService_Leaderboard verifies Leaderboard delegates to
// TopScores with the requested limit.
func TestFishingService_Leaderboard(t *testing.T) {
	repo := &fakeFishingRepository{
		scores: []model.FishingScore{
			{PlayerName: "Alice", Score: 900, DepthReachedMiles: 800},
			{PlayerName: "Bob", Score: 500, DepthReachedMiles: 400},
		},
	}
	svc := &FishingService{Repo: repo}

	got, err := svc.Leaderboard(context.Background(), 1)
	if err != nil {
		t.Fatalf("Leaderboard: unexpected error: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("len(got) = %d, want 1", len(got))
	}
	if got[0].PlayerName != "Alice" {
		t.Errorf("got[0].PlayerName = %q, want %q", got[0].PlayerName, "Alice")
	}
}

// TestFishingService_Leaderboard_Empty verifies an empty result set is
// returned as-is (nil/empty slice), not an error — the "no scores yet"
// UI state is the handler/template's job, not the service's.
func TestFishingService_Leaderboard_Empty(t *testing.T) {
	repo := &fakeFishingRepository{}
	svc := &FishingService{Repo: repo}

	got, err := svc.Leaderboard(context.Background(), 20)
	if err != nil {
		t.Fatalf("Leaderboard: unexpected error: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("len(got) = %d, want 0", len(got))
	}
}
