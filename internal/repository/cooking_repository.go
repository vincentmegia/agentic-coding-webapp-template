package repository

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/vincentmegia/vincentmegia/internal/model"
)

// CookingRepository reads and writes the cooking_scores table — the
// Kitchen Shift game's public leaderboard. See
// docs/features/cooking-game.md's Data Model.
//
// DB and ReadDB are separate handles, same split as ResumeRepository
// (docs/features/resume.md's Security Considerations): Insert uses DB,
// TopScores uses ReadDB.
type CookingRepository struct {
	DB     *sql.DB
	ReadDB *sql.DB
}

// NewCookingRepository wraps two already-open database handles — db for
// writes, readDB for reads.
func NewCookingRepository(db, readDB *sql.DB) *CookingRepository {
	return &CookingRepository{DB: db, ReadDB: readDB}
}

// Insert stores one already-validated leaderboard submission. Callers
// (internal/service.CookingService) are responsible for bounds-checking
// playerName/totalEarnings/shiftsCompleted before calling this — the
// table's own CHECK constraints are a backstop, not the primary validation
// layer (docs/features/cooking-game.md's Security Considerations).
func (repo *CookingRepository) Insert(ctx context.Context, playerName string, totalEarnings, shiftsCompleted int) error {
	const query = `
		INSERT INTO cooking_scores (player_name, total_earnings, shifts_completed)
		VALUES ($1, $2, $3)`

	if _, err := repo.DB.ExecContext(ctx, query, playerName, totalEarnings, shiftsCompleted); err != nil {
		return fmt.Errorf("insert cooking_scores: %w", err)
	}
	return nil
}

// TopScores fetches the top `limit` rows by total_earnings, descending —
// the same ordering idx_cooking_scores_earnings exists to serve.
// Read-only — uses ReadDB.
func (repo *CookingRepository) TopScores(ctx context.Context, limit int) ([]model.CookingScore, error) {
	const query = `
		SELECT player_name, total_earnings, shifts_completed, created_at
		FROM cooking_scores
		ORDER BY total_earnings DESC
		LIMIT $1`

	rows, err := repo.ReadDB.QueryContext(ctx, query, limit)
	if err != nil {
		return nil, fmt.Errorf("query cooking_scores: %w", err)
	}
	defer rows.Close()

	var scores []model.CookingScore
	for rows.Next() {
		var s model.CookingScore
		if err := rows.Scan(&s.PlayerName, &s.TotalEarnings, &s.ShiftsCompleted, &s.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan cooking_scores row: %w", err)
		}
		scores = append(scores, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate cooking_scores: %w", err)
	}

	return scores, nil
}
