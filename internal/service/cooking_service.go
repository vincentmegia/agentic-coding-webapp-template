package service

import (
	"context"
	"fmt"

	"github.com/vincentmegia/vincentmegia/internal/model"
	"github.com/vincentmegia/vincentmegia/internal/repository"
)

// cookingRepository is the subset of *repository.CookingRepository this
// service depends on, declared here (not in internal/repository) so tests
// can substitute an in-memory fake without a real database — see
// docs/skills/go-backend/SKILL.md "Service"/"Testability".
// *repository.CookingRepository satisfies this implicitly.
type cookingRepository interface {
	Insert(ctx context.Context, playerName string, totalEarnings, shiftsCompleted int) error
	TopScores(ctx context.Context, limit int) ([]model.CookingScore, error)
}

// CookingService wraps a CookingRepository with the Kitchen Shift
// leaderboard's business logic: validating a submission before it ever
// reaches Postgres. See docs/features/cooking-game.md.
type CookingService struct {
	Repo cookingRepository
}

// NewCookingService wraps a CookingRepository.
func NewCookingService(repo *repository.CookingRepository) *CookingService {
	return &CookingService{Repo: repo}
}

// SubmitScore validates a leaderboard submission via
// ValidateCookingScoreSubmission (docs/features/cooking-game.md's Security
// Considerations) before inserting it — an invalid submission never
// reaches the repository. Returns the validation error unchanged on
// failure so the handler can render a clear 4xx rather than a raw DB
// constraint-violation error.
func (s *CookingService) SubmitScore(ctx context.Context, playerName string, totalEarnings, shiftsCompleted int) error {
	trimmed, err := ValidateCookingScoreSubmission(playerName, totalEarnings, shiftsCompleted)
	if err != nil {
		return err
	}
	if err := s.Repo.Insert(ctx, trimmed, totalEarnings, shiftsCompleted); err != nil {
		return fmt.Errorf("insert cooking score: %w", err)
	}
	return nil
}

// Leaderboard fetches the top `limit` leaderboard entries, total_earnings
// descending.
func (s *CookingService) Leaderboard(ctx context.Context, limit int) ([]model.CookingScore, error) {
	scores, err := s.Repo.TopScores(ctx, limit)
	if err != nil {
		return nil, fmt.Errorf("get cooking leaderboard: %w", err)
	}
	return scores, nil
}
