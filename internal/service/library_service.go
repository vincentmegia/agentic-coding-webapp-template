package service

import (
	"context"
	"fmt"

	"github.com/vincentmegia/vincentmegia/internal/model"
	"github.com/vincentmegia/vincentmegia/internal/repository"
)

// libraryRepository is the subset of *repository.LibraryRepository this
// service depends on, declared here (not in internal/repository) so tests
// can substitute an in-memory fake without a real database — see
// docs/skills/go-backend/SKILL.md "Service"/"Testability".
// *repository.LibraryRepository satisfies this implicitly.
type libraryRepository interface {
	Insert(ctx context.Context, playerName string, totalEarnings, shiftsCompleted int) error
	TopScores(ctx context.Context, limit int) ([]model.LibraryScore, error)
}

// LibraryService wraps a LibraryRepository with the Library Shift
// leaderboard's business logic: validating a submission before it ever
// reaches Postgres. See docs/features/library-game.md.
type LibraryService struct {
	Repo libraryRepository
}

// NewLibraryService wraps a LibraryRepository.
func NewLibraryService(repo *repository.LibraryRepository) *LibraryService {
	return &LibraryService{Repo: repo}
}

// SubmitScore validates a leaderboard submission via
// ValidateLibraryScoreSubmission (docs/features/library-game.md's Security
// Considerations) before inserting it — an invalid submission never
// reaches the repository. Returns the validation error unchanged on
// failure so the handler can render a clear 4xx rather than a raw DB
// constraint-violation error.
func (s *LibraryService) SubmitScore(ctx context.Context, playerName string, totalEarnings, shiftsCompleted int) error {
	trimmed, err := ValidateLibraryScoreSubmission(playerName, totalEarnings, shiftsCompleted)
	if err != nil {
		return err
	}
	if err := s.Repo.Insert(ctx, trimmed, totalEarnings, shiftsCompleted); err != nil {
		return fmt.Errorf("insert library score: %w", err)
	}
	return nil
}

// Leaderboard fetches the top `limit` leaderboard entries, total_earnings
// descending.
func (s *LibraryService) Leaderboard(ctx context.Context, limit int) ([]model.LibraryScore, error) {
	scores, err := s.Repo.TopScores(ctx, limit)
	if err != nil {
		return nil, fmt.Errorf("get library leaderboard: %w", err)
	}
	return scores, nil
}
