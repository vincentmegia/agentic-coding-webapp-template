package repository

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/vincentmegia/vincentmegia/internal/model"
)

// FishingRepository reads and writes the fishing_scores table — the
// fishing game's public leaderboard. See docs/features/fishing-game.md's
// Data Model.
type FishingRepository struct {
	DB *sql.DB
}

// NewFishingRepository wraps an already-open database handle.
func NewFishingRepository(db *sql.DB) *FishingRepository {
	return &FishingRepository{DB: db}
}

// Insert stores one already-validated leaderboard submission. Callers
// (internal/service.FishingService) are responsible for bounds-checking
// playerName/score/depthReachedMiles before calling this — the table's
// own CHECK constraints are a backstop, not the primary validation layer
// (docs/features/fishing-game.md's Security Considerations).
func (repo *FishingRepository) Insert(ctx context.Context, playerName string, score, depthReachedMiles int) error {
	const query = `
		INSERT INTO fishing_scores (player_name, score, depth_reached_miles)
		VALUES ($1, $2, $3)`

	if _, err := repo.DB.ExecContext(ctx, query, playerName, score, depthReachedMiles); err != nil {
		return fmt.Errorf("insert fishing_scores: %w", err)
	}
	return nil
}

// TopScores fetches the top `limit` rows by score, descending — the same
// ordering idx_fishing_scores_score exists to serve.
func (repo *FishingRepository) TopScores(ctx context.Context, limit int) ([]model.FishingScore, error) {
	const query = `
		SELECT player_name, score, depth_reached_miles, created_at
		FROM fishing_scores
		ORDER BY score DESC
		LIMIT $1`

	rows, err := repo.DB.QueryContext(ctx, query, limit)
	if err != nil {
		return nil, fmt.Errorf("query fishing_scores: %w", err)
	}
	defer rows.Close()

	var scores []model.FishingScore
	for rows.Next() {
		var s model.FishingScore
		if err := rows.Scan(&s.PlayerName, &s.Score, &s.DepthReachedMiles, &s.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan fishing_scores row: %w", err)
		}
		scores = append(scores, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate fishing_scores: %w", err)
	}

	return scores, nil
}
