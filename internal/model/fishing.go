package model

import "time"

// FishingScore is one fishing_scores row: a voluntarily-submitted,
// already-finished round result on the public leaderboard. See
// docs/features/fishing-game.md's Data Model. Per-player tokens/gear/best
// live in the browser's localStorage instead — this is the only
// server-side state the feature adds.
type FishingScore struct {
	PlayerName        string
	Score             int
	DepthReachedMiles int
	CreatedAt         time.Time
}
