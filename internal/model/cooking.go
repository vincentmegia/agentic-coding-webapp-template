package model

import "time"

// CookingScore is one cooking_scores row: a voluntarily-submitted,
// already-finished month result on the public leaderboard. See
// docs/features/cooking-game.md's Data Model. Per-player Gard/shop
// levels/in-progress shift live in the browser's localStorage instead —
// this is the only server-side state the feature adds.
type CookingScore struct {
	PlayerName      string
	TotalEarnings   int
	ShiftsCompleted int
	CreatedAt       time.Time
}
