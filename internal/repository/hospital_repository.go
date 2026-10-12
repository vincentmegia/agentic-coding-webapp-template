package repository

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/vincentmegia/vincentmegia/internal/model"
)

// HospitalRepository reads and writes the hospital_scores table — the
// Hospital Shift game's public leaderboard. See
// docs/features/hospital-shift.md's Data Model. Mirrors CookingRepository's
// exact shape (same split, same reasoning).
//
// DB and ReadDB are separate handles, same split as CookingRepository/
// ResumeRepository (docs/features/resume.md's Security Considerations):
// Insert uses DB, TopScores uses ReadDB.
type HospitalRepository struct {
	DB     *sql.DB
	ReadDB *sql.DB
}

// NewHospitalRepository wraps two already-open database handles — db for
// writes, readDB for reads.
func NewHospitalRepository(db, readDB *sql.DB) *HospitalRepository {
	return &HospitalRepository{DB: db, ReadDB: readDB}
}

// Insert stores one already-validated leaderboard submission. Callers
// (internal/service.HospitalService) are responsible for bounds-checking
// playerName/totalEarnings/shiftsCompleted before calling this — the
// table's own CHECK constraints are a backstop, not the primary validation
// layer (docs/features/hospital-shift.md's Security Considerations).
func (repo *HospitalRepository) Insert(ctx context.Context, playerName string, totalEarnings, shiftsCompleted int) error {
	const query = `
		INSERT INTO hospital_scores (player_name, total_earnings, shifts_completed)
		VALUES ($1, $2, $3)`

	if _, err := repo.DB.ExecContext(ctx, query, playerName, totalEarnings, shiftsCompleted); err != nil {
		return fmt.Errorf("insert hospital_scores: %w", err)
	}
	return nil
}

// TopScores fetches the top `limit` rows by total_earnings, descending —
// the same ordering idx_hospital_scores_earnings exists to serve.
// Read-only — uses ReadDB.
func (repo *HospitalRepository) TopScores(ctx context.Context, limit int) ([]model.HospitalScore, error) {
	const query = `
		SELECT player_name, total_earnings, shifts_completed, created_at
		FROM hospital_scores
		ORDER BY total_earnings DESC
		LIMIT $1`

	rows, err := repo.ReadDB.QueryContext(ctx, query, limit)
	if err != nil {
		return nil, fmt.Errorf("query hospital_scores: %w", err)
	}
	defer rows.Close()

	var scores []model.HospitalScore
	for rows.Next() {
		var s model.HospitalScore
		if err := rows.Scan(&s.PlayerName, &s.TotalEarnings, &s.ShiftsCompleted, &s.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan hospital_scores row: %w", err)
		}
		scores = append(scores, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate hospital_scores: %w", err)
	}

	return scores, nil
}
