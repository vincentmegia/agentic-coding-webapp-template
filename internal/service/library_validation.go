package service

import (
	"errors"
	"strings"
)

// Bounds from docs/features/library-game.md's Data Model — kept in sync
// with the library_scores table's CHECK constraints. Server-side
// validation exists so an out-of-range request gets a clear 4xx here
// rather than a raw DB constraint-violation error (see that doc's
// Security Considerations). Mirrors cooking_validation.go's exact pattern.
const (
	libraryScorePlayerNameMaxLen = 20
	libraryScoreEarningsMax      = 100000
	libraryScoreShiftsMin        = 1
	libraryScoreShiftsMax        = 30
)

var (
	ErrLibraryScorePlayerNameRequired = errors.New("player name is required")
	ErrLibraryScorePlayerNameTooLong  = errors.New("player name must be 20 characters or fewer")
	ErrLibraryScoreEarningsOutOfRange = errors.New("total earnings is out of the allowed range")
	ErrLibraryScoreShiftsOutOfRange   = errors.New("shifts completed is out of the allowed range")
)

// ValidateLibraryScoreSubmission validates a leaderboard submission
// (POST /library-game/score) per docs/features/library-game.md's Security
// Considerations: player_name is trimmed and length-bounded,
// total_earnings and shifts_completed are bounded to the same coarse
// sanity range as the library_scores table's CHECK constraints. This is
// not anti-cheat — the game simulation is entirely client-side (see that
// doc's Scope) — it only rejects obviously-impossible submissions before
// they reach Postgres. Returns the trimmed player name to store on
// success.
func ValidateLibraryScoreSubmission(playerName string, totalEarnings, shiftsCompleted int) (string, error) {
	trimmed := strings.TrimSpace(playerName)
	if trimmed == "" {
		return "", ErrLibraryScorePlayerNameRequired
	}
	if len([]rune(trimmed)) > libraryScorePlayerNameMaxLen {
		return "", ErrLibraryScorePlayerNameTooLong
	}
	if totalEarnings < 0 || totalEarnings > libraryScoreEarningsMax {
		return "", ErrLibraryScoreEarningsOutOfRange
	}
	if shiftsCompleted < libraryScoreShiftsMin || shiftsCompleted > libraryScoreShiftsMax {
		return "", ErrLibraryScoreShiftsOutOfRange
	}
	return trimmed, nil
}
