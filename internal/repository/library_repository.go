package repository

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/vincentmegia/vincentmegia/internal/model"
)

// LibraryRepository reads and writes the library_scores table — the
// Library Shift game's public leaderboard. See
// docs/features/library-game.md's Data Model. Mirrors CookingRepository's
// exact shape (same split, same reasoning).
//
// DB and ReadDB are separate handles, same split as CookingRepository/
// ResumeRepository (docs/features/resume.md's Security Considerations):
// Insert uses DB, TopScores uses ReadDB.
type LibraryRepository struct {
	DB     *sql.DB
	ReadDB *sql.DB
}

// NewLibraryRepository wraps two already-open database handles — db for
// writes, readDB for reads.
func NewLibraryRepository(db, readDB *sql.DB) *LibraryRepository {
	return &LibraryRepository{DB: db, ReadDB: readDB}
}

// Insert stores one already-validated leaderboard submission. Callers
// (internal/service.LibraryService) are responsible for bounds-checking
// playerName/totalEarnings/shiftsCompleted before calling this — the
// table's own CHECK constraints are a backstop, not the primary validation
// layer (docs/features/library-game.md's Security Considerations).
func (repo *LibraryRepository) Insert(ctx context.Context, playerName string, totalEarnings, shiftsCompleted int) error {
	const query = `
		INSERT INTO library_scores (player_name, total_earnings, shifts_completed)
		VALUES ($1, $2, $3)`

	if _, err := repo.DB.ExecContext(ctx, query, playerName, totalEarnings, shiftsCompleted); err != nil {
		return fmt.Errorf("insert library_scores: %w", err)
	}
	return nil
}

// TopScores fetches the top `limit` rows by total_earnings, descending —
// the same ordering idx_library_scores_earnings exists to serve.
// Read-only — uses ReadDB.
func (repo *LibraryRepository) TopScores(ctx context.Context, limit int) ([]model.LibraryScore, error) {
	const query = `
		SELECT player_name, total_earnings, shifts_completed, created_at
		FROM library_scores
		ORDER BY total_earnings DESC
		LIMIT $1`

	rows, err := repo.ReadDB.QueryContext(ctx, query, limit)
	if err != nil {
		return nil, fmt.Errorf("query library_scores: %w", err)
	}
	defer rows.Close()

	var scores []model.LibraryScore
	for rows.Next() {
		var s model.LibraryScore
		if err := rows.Scan(&s.PlayerName, &s.TotalEarnings, &s.ShiftsCompleted, &s.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan library_scores row: %w", err)
		}
		scores = append(scores, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate library_scores: %w", err)
	}

	return scores, nil
}
