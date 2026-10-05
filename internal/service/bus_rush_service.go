package service

import (
	"context"
	"fmt"

	"github.com/vincentmegia/vincentmegia/internal/model"
	"github.com/vincentmegia/vincentmegia/internal/repository"
)

// busRushRepository is the subset of *repository.BusRushRepository this
// service depends on, so tests can substitute an in-memory fake.
type busRushRepository interface {
	Insert(ctx context.Context, playerName string, score, distanceMeters int) error
	TopScores(ctx context.Context, limit int) ([]model.BusRushScore, error)
}

// BusRushService wraps a BusRushRepository with the leaderboard's business
// logic. See docs/features/bus-rush.md.
type BusRushService struct {
	Repo busRushRepository
}

// NewBusRushService wraps a BusRushRepository.
func NewBusRushService(repo *repository.BusRushRepository) *BusRushService {
	return &BusRushService{Repo: repo}
}

// SubmitScore validates a submission before inserting it; an invalid one
// never reaches the repository, and its validation error is returned
// unchanged so the handler can answer 400.
func (s *BusRushService) SubmitScore(ctx context.Context, playerName string, score, distanceMeters int) error {
	trimmed, err := ValidateBusRushScoreSubmission(playerName, score, distanceMeters)
	if err != nil {
		return err
	}
	if err := s.Repo.Insert(ctx, trimmed, score, distanceMeters); err != nil {
		return fmt.Errorf("insert bus rush score: %w", err)
	}
	return nil
}

// Leaderboard fetches the top `limit` entries, score descending.
func (s *BusRushService) Leaderboard(ctx context.Context, limit int) ([]model.BusRushScore, error) {
	scores, err := s.Repo.TopScores(ctx, limit)
	if err != nil {
		return nil, fmt.Errorf("get bus rush leaderboard: %w", err)
	}
	return scores, nil
}
