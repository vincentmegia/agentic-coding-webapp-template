package model

import "time"

// BusRushScore is one bus_rush_scores row: a voluntarily-submitted,
// finished run on the public leaderboard. See docs/features/bus-rush.md's
// Data Model. Tokens/upgrade levels live in the browser's localStorage.
type BusRushScore struct {
	PlayerName     string
	Score          int
	DistanceMeters int
	CreatedAt      time.Time
}
