package service

import (
	"context"
	"errors"
	"testing"

	"github.com/vincentmegia/vincentmegia/internal/model"
)

// fakeCookingRepository is an in-memory stand-in for
// *repository.CookingRepository, satisfying the cookingRepository
// interface cooking_service.go declares — no real Postgres connection
// needed to exercise CookingService's own logic. Mirrors
// fakeFishingRepository's exact pattern (fishing_service_test.go).
type fakeCookingRepository struct {
	scores      []model.CookingScore
	insertErr   error
	topErr      error
	insertCalls int
}

func (f *fakeCookingRepository) Insert(ctx context.Context, playerName string, totalEarnings, shiftsCompleted int) error {
	f.insertCalls++
	if f.insertErr != nil {
		return f.insertErr
	}
	f.scores = append(f.scores, model.CookingScore{
		PlayerName:      playerName,
		TotalEarnings:   totalEarnings,
		ShiftsCompleted: shiftsCompleted,
	})
	return nil
}

func (f *fakeCookingRepository) TopScores(ctx context.Context, limit int) ([]model.CookingScore, error) {
	if f.topErr != nil {
		return nil, f.topErr
	}
	if len(f.scores) <= limit {
		return f.scores, nil
	}
	return f.scores[:limit], nil
}

// TestCookingService_SubmitScore_Valid verifies a valid submission is
// trimmed by ValidateCookingScoreSubmission and reaches the repository
// exactly once with the trimmed name.
func TestCookingService_SubmitScore_Valid(t *testing.T) {
	repo := &fakeCookingRepository{}
	svc := &CookingService{Repo: repo}

	if err := svc.SubmitScore(context.Background(), "  Vince  ", 80000, 20); err != nil {
		t.Fatalf("SubmitScore: unexpected error: %v", err)
	}

	if repo.insertCalls != 1 {
		t.Fatalf("insert calls = %d, want 1", repo.insertCalls)
	}
	if got, want := repo.scores[0].PlayerName, "Vince"; got != want {
		t.Errorf("stored player name = %q, want %q (trimmed)", got, want)
	}
	if got, want := repo.scores[0].TotalEarnings, 80000; got != want {
		t.Errorf("stored total earnings = %d, want %d", got, want)
	}
	if got, want := repo.scores[0].ShiftsCompleted, 20; got != want {
		t.Errorf("stored shifts completed = %d, want %d", got, want)
	}
}

// TestCookingService_SubmitScore_ValidationRejected verifies an
// out-of-bounds submission is rejected by ValidateCookingScoreSubmission
// and never reaches the repository's Insert at all.
func TestCookingService_SubmitScore_ValidationRejected(t *testing.T) {
	tests := []struct {
		name            string
		playerName      string
		totalEarnings   int
		shiftsCompleted int
		wantErr         error
	}{
		{"blank name", "", 1000, 5, ErrCookingScorePlayerNameRequired},
		{"name too long", "this-name-is-way-too-long-for-the-limit", 1000, 5, ErrCookingScorePlayerNameTooLong},
		{"earnings out of range", "Vince", 200_000, 5, ErrCookingScoreEarningsOutOfRange},
		{"shifts out of range", "Vince", 1000, 21, ErrCookingScoreShiftsOutOfRange},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repo := &fakeCookingRepository{}
			svc := &CookingService{Repo: repo}

			err := svc.SubmitScore(context.Background(), tt.playerName, tt.totalEarnings, tt.shiftsCompleted)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if repo.insertCalls != 0 {
				t.Errorf("insert calls = %d, want 0 (validation should reject before reaching the repository)", repo.insertCalls)
			}
		})
	}
}

// TestCookingService_SubmitScore_RepositoryError verifies a repository
// failure is wrapped and returned, not swallowed, and is distinguishable
// from a validation error.
func TestCookingService_SubmitScore_RepositoryError(t *testing.T) {
	repoErr := errors.New("connection refused")
	repo := &fakeCookingRepository{insertErr: repoErr}
	svc := &CookingService{Repo: repo}

	err := svc.SubmitScore(context.Background(), "Vince", 1000, 5)
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	if errors.Is(err, ErrCookingScorePlayerNameRequired) || errors.Is(err, ErrCookingScoreEarningsOutOfRange) {
		t.Errorf("repository error should not be mistaken for a validation sentinel: %v", err)
	}
	if !errors.Is(err, repoErr) {
		t.Errorf("err = %v, want it to wrap %v", err, repoErr)
	}
}

// TestCookingService_Leaderboard verifies Leaderboard delegates to
// TopScores with the requested limit.
func TestCookingService_Leaderboard(t *testing.T) {
	repo := &fakeCookingRepository{
		scores: []model.CookingScore{
			{PlayerName: "Alice", TotalEarnings: 80000, ShiftsCompleted: 20},
			{PlayerName: "Bob", TotalEarnings: 60000, ShiftsCompleted: 20},
		},
	}
	svc := &CookingService{Repo: repo}

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

// TestCookingService_Leaderboard_Empty verifies an empty result set is
// returned as-is (nil/empty slice), not an error.
func TestCookingService_Leaderboard_Empty(t *testing.T) {
	repo := &fakeCookingRepository{}
	svc := &CookingService{Repo: repo}

	got, err := svc.Leaderboard(context.Background(), 20)
	if err != nil {
		t.Fatalf("Leaderboard: unexpected error: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("len(got) = %d, want 0", len(got))
	}
}
