package service

import (
	"errors"
	"strings"
)

// Bounds from docs/features/fishing-game.md's Data Model — kept in sync
// with the fishing_scores table's CHECK constraints. Server-side validation
// exists so an out-of-range request gets a clear 4xx here rather than a raw
// DB constraint-violation error (see that doc's Security Considerations).
const (
	fishingScorePlayerNameMaxLen = 20
	fishingScoreMax              = 999999
	fishingScoreDepthMaxMiles    = 1000
)

var (
	ErrFishingScorePlayerNameRequired = errors.New("player name is required")
	ErrFishingScorePlayerNameTooLong  = errors.New("player name must be 20 characters or fewer")
	ErrFishingScoreOutOfRange         = errors.New("score is out of the allowed range")
	ErrFishingScoreDepthOutOfRange    = errors.New("depth reached is out of the allowed range")
)

// ValidateFishingScoreSubmission validates a leaderboard submission
// (POST /fishing-game/score) per docs/features/fishing-game.md's Security
// Considerations: player_name is trimmed and length-bounded, score and
// depth_reached_miles are bounded to the same coarse sanity range as the
// fishing_scores table's CHECK constraints. This is not anti-cheat — the
// game simulation is entirely client-side (see that doc's Scope) — it only
// rejects obviously-impossible submissions before they reach Postgres.
// Returns the trimmed player name to store on success.
func ValidateFishingScoreSubmission(playerName string, score, depthReachedMiles int) (string, error) {
	trimmed := strings.TrimSpace(playerName)
	if trimmed == "" {
		return "", ErrFishingScorePlayerNameRequired
	}
	if len([]rune(trimmed)) > fishingScorePlayerNameMaxLen {
		return "", ErrFishingScorePlayerNameTooLong
	}
	if score < 0 || score > fishingScoreMax {
		return "", ErrFishingScoreOutOfRange
	}
	if depthReachedMiles < 0 || depthReachedMiles > fishingScoreDepthMaxMiles {
		return "", ErrFishingScoreDepthOutOfRange
	}
	return trimmed, nil
}
