package service

import (
	"context"
	"fmt"

	"github.com/vincentmegia/vincentmegia/internal/model"
	"github.com/vincentmegia/vincentmegia/internal/repository"
)

// fishingRepository is the subset of *repository.FishingRepository this
// service depends on, declared here (not in internal/repository) so tests
// can substitute an in-memory fake without a real database — see
// docs/skills/go-backend/SKILL.md "Service"/"Testability".
// *repository.FishingRepository satisfies this implicitly.
type fishingRepository interface {
	Insert(ctx context.Context, playerName string, score, depthReachedMiles int) error
	TopScores(ctx context.Context, limit int) ([]model.FishingScore, error)
}

// FishingService wraps a FishingRepository with the fishing-game
// leaderboard's business logic: validating a submission before it ever
// reaches Postgres. See docs/features/fishing-game.md.
type FishingService struct {
	Repo fishingRepository
}

// NewFishingService wraps a FishingRepository.
func NewFishingService(repo *repository.FishingRepository) *FishingService {
	return &FishingService{Repo: repo}
}

// SubmitScore validates a leaderboard submission via
// ValidateFishingScoreSubmission (docs/features/fishing-game.md's Security
// Considerations) before inserting it — an invalid submission never
// reaches the repository. Returns the validation error unchanged on
// failure so the handler can render a clear 4xx rather than a raw DB
// constraint-violation error.
func (s *FishingService) SubmitScore(ctx context.Context, playerName string, score, depthReachedMiles int) error {
	trimmed, err := ValidateFishingScoreSubmission(playerName, score, depthReachedMiles)
	if err != nil {
		return err
	}
	if err := s.Repo.Insert(ctx, trimmed, score, depthReachedMiles); err != nil {
		return fmt.Errorf("insert fishing score: %w", err)
	}
	return nil
}

// Leaderboard fetches the top `limit` leaderboard entries, score
// descending.
func (s *FishingService) Leaderboard(ctx context.Context, limit int) ([]model.FishingScore, error) {
	scores, err := s.Repo.TopScores(ctx, limit)
	if err != nil {
		return nil, fmt.Errorf("get fishing leaderboard: %w", err)
	}
	return scores, nil
}
