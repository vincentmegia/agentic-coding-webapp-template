package service

import (
	"errors"
	"strings"
)

// Bounds from docs/features/cooking-game.md's Data Model — kept in sync
// with the cooking_scores table's CHECK constraints. Server-side
// validation exists so an out-of-range request gets a clear 4xx here
// rather than a raw DB constraint-violation error (see that doc's
// Security Considerations).
const (
	cookingScorePlayerNameMaxLen = 20
	cookingScoreEarningsMax      = 100000
	cookingScoreShiftsMin        = 1
	cookingScoreShiftsMax        = 20
)

var (
	ErrCookingScorePlayerNameRequired = errors.New("player name is required")
	ErrCookingScorePlayerNameTooLong  = errors.New("player name must be 20 characters or fewer")
	ErrCookingScoreEarningsOutOfRange = errors.New("total earnings is out of the allowed range")
	ErrCookingScoreShiftsOutOfRange   = errors.New("shifts completed is out of the allowed range")
)

// ValidateCookingScoreSubmission validates a leaderboard submission
// (POST /kitchen-shift/score) per docs/features/cooking-game.md's Security
// Considerations: player_name is trimmed and length-bounded,
// total_earnings and shifts_completed are bounded to the same coarse
// sanity range as the cooking_scores table's CHECK constraints. This is
// not anti-cheat — the game simulation is entirely client-side (see that
// doc's Scope) — it only rejects obviously-impossible submissions before
// they reach Postgres. Returns the trimmed player name to store on
// success.
func ValidateCookingScoreSubmission(playerName string, totalEarnings, shiftsCompleted int) (string, error) {
	trimmed := strings.TrimSpace(playerName)
	if trimmed == "" {
		return "", ErrCookingScorePlayerNameRequired
	}
	if len([]rune(trimmed)) > cookingScorePlayerNameMaxLen {
		return "", ErrCookingScorePlayerNameTooLong
	}
	if totalEarnings < 0 || totalEarnings > cookingScoreEarningsMax {
		return "", ErrCookingScoreEarningsOutOfRange
	}
	if shiftsCompleted < cookingScoreShiftsMin || shiftsCompleted > cookingScoreShiftsMax {
		return "", ErrCookingScoreShiftsOutOfRange
	}
	return trimmed, nil
}
