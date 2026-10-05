package repository

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/vincentmegia/vincentmegia/internal/model"
)

// BusRushRepository reads and writes the bus_rush_scores table — Bus
// Rush's public leaderboard. See docs/features/bus-rush.md's Data Model.
// Same DB/ReadDB split as FishingRepository.
type BusRushRepository struct {
	DB     *sql.DB
	ReadDB *sql.DB
}

// NewBusRushRepository wraps two already-open database handles — db for
// writes, readDB for reads.
func NewBusRushRepository(db, readDB *sql.DB) *BusRushRepository {
	return &BusRushRepository{DB: db, ReadDB: readDB}
}

// Insert stores one already-validated leaderboard submission. The table's
// CHECK constraints are a backstop; service.ValidateBusRushScoreSubmission
// is the primary validation layer.
func (repo *BusRushRepository) Insert(ctx context.Context, playerName string, score, distanceMeters int) error {
	const query = `
		INSERT INTO bus_rush_scores (player_name, score, distance_meters)
		VALUES ($1, $2, $3)`
	if _, err := repo.DB.ExecContext(ctx, query, playerName, score, distanceMeters); err != nil {
		return fmt.Errorf("insert bus_rush_scores: %w", err)
	}
	return nil
}

// TopScores fetches the top `limit` rows by score, descending. Read-only —
// uses ReadDB.
func (repo *BusRushRepository) TopScores(ctx context.Context, limit int) ([]model.BusRushScore, error) {
	const query = `
		SELECT player_name, score, distance_meters, created_at
		FROM bus_rush_scores
		ORDER BY score DESC
		LIMIT $1`

	rows, err := repo.ReadDB.QueryContext(ctx, query, limit)
	if err != nil {
		return nil, fmt.Errorf("query bus_rush_scores: %w", err)
	}
	defer rows.Close()

	var scores []model.BusRushScore
	for rows.Next() {
		var s model.BusRushScore
		if err := rows.Scan(&s.PlayerName, &s.Score, &s.DistanceMeters, &s.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan bus_rush_scores row: %w", err)
		}
		scores = append(scores, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate bus_rush_scores: %w", err)
	}
	return scores, nil
}
