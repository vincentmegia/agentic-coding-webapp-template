package service

import (
	"context"
	"fmt"

	"github.com/vincentmegia/vincentmegia/internal/model"
	"github.com/vincentmegia/vincentmegia/internal/repository"
)

// hospitalRepository is the subset of *repository.HospitalRepository this
// service depends on, declared here (not in internal/repository) so tests
// can substitute an in-memory fake without a real database — see
// docs/skills/go-backend/SKILL.md "Service"/"Testability".
// *repository.HospitalRepository satisfies this implicitly.
type hospitalRepository interface {
	Insert(ctx context.Context, playerName string, totalEarnings, shiftsCompleted int) error
	TopScores(ctx context.Context, limit int) ([]model.HospitalScore, error)
}

// HospitalService wraps a HospitalRepository with the Hospital Shift
// leaderboard's business logic: validating a submission before it ever
// reaches Postgres. See docs/features/hospital-shift.md.
type HospitalService struct {
	Repo hospitalRepository
}

// NewHospitalService wraps a HospitalRepository.
func NewHospitalService(repo *repository.HospitalRepository) *HospitalService {
	return &HospitalService{Repo: repo}
}

// SubmitScore validates a leaderboard submission via
// ValidateHospitalScoreSubmission (docs/features/hospital-shift.md's Security
// Considerations) before inserting it — an invalid submission never
// reaches the repository. Returns the validation error unchanged on
// failure so the handler can render a clear 4xx rather than a raw DB
// constraint-violation error.
func (s *HospitalService) SubmitScore(ctx context.Context, playerName string, totalEarnings, shiftsCompleted int) error {
	trimmed, err := ValidateHospitalScoreSubmission(playerName, totalEarnings, shiftsCompleted)
	if err != nil {
		return err
	}
	if err := s.Repo.Insert(ctx, trimmed, totalEarnings, shiftsCompleted); err != nil {
		return fmt.Errorf("insert hospital score: %w", err)
	}
	return nil
}

// Leaderboard fetches the top `limit` leaderboard entries, total_earnings
// descending.
func (s *HospitalService) Leaderboard(ctx context.Context, limit int) ([]model.HospitalScore, error) {
	scores, err := s.Repo.TopScores(ctx, limit)
	if err != nil {
		return nil, fmt.Errorf("get hospital leaderboard: %w", err)
	}
	return scores, nil
}
