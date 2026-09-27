package model

import "time"

// LibraryScore is one library_scores row: a voluntarily-submitted,
// already-finished 30-shift run result on the public leaderboard. See
// docs/features/library-game.md's Data Model. Per-player Gard/shelf state/
// in-progress shift live in the browser's localStorage instead — this is
// the only server-side state the feature adds. Mirrors model.CookingScore
// exactly (same shape, same reasoning).
type LibraryScore struct {
	PlayerName      string
	TotalEarnings   int
	ShiftsCompleted int
	CreatedAt       time.Time
}
