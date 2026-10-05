package service

import (
	"errors"
	"strings"
)

// Bounds from docs/features/bus-rush.md's Data Model — kept in sync with
// the bus_rush_scores table's CHECK constraints.
const (
	busRushPlayerNameMaxLen = 20
	busRushScoreMax         = 999999
	busRushDistanceMax      = 999999
)

var (
	ErrBusRushPlayerNameRequired = errors.New("player name is required")
	ErrBusRushPlayerNameTooLong  = errors.New("player name must be 20 characters or fewer")
	ErrBusRushScoreOutOfRange    = errors.New("score is out of the allowed range")
	ErrBusRushDistanceOutOfRange = errors.New("distance is out of the allowed range")
)

// ValidateBusRushScoreSubmission validates a POST /bus-rush/score
// submission: the name is trimmed and length-bounded, score and distance
// are bounded to the table's CHECK ranges. Not anti-cheat — the game runs
// client-side (docs/features/bus-rush.md's Scope). Returns the trimmed
// name to store.
func ValidateBusRushScoreSubmission(playerName string, score, distanceMeters int) (string, error) {
	trimmed := strings.TrimSpace(playerName)
	if trimmed == "" {
		return "", ErrBusRushPlayerNameRequired
	}
	if len([]rune(trimmed)) > busRushPlayerNameMaxLen {
		return "", ErrBusRushPlayerNameTooLong
	}
	if score < 0 || score > busRushScoreMax {
		return "", ErrBusRushScoreOutOfRange
	}
	if distanceMeters < 0 || distanceMeters > busRushDistanceMax {
		return "", ErrBusRushDistanceOutOfRange
	}
	return trimmed, nil
}
