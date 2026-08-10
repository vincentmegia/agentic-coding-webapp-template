package service

import (
	"errors"
	"strings"
	"testing"
)

func TestValidateFishingScoreSubmission(t *testing.T) {
	tests := []struct {
		name              string
		playerName        string
		score             int
		depthReachedMiles int
		wantTrimmed       string
		wantErr           error
	}{
		{
			name:              "valid submission",
			playerName:        "Vince",
			score:             1200,
			depthReachedMiles: 450,
			wantTrimmed:       "Vince",
		},
		{
			name:              "player name is trimmed",
			playerName:        "  Vince  ",
			score:             0,
			depthReachedMiles: 0,
			wantTrimmed:       "Vince",
		},
		{
			name:              "empty player name",
			playerName:        "",
			score:             0,
			depthReachedMiles: 0,
			wantErr:           ErrFishingScorePlayerNameRequired,
		},
		{
			name:              "whitespace-only player name",
			playerName:        "   ",
			score:             0,
			depthReachedMiles: 0,
			wantErr:           ErrFishingScorePlayerNameRequired,
		},
		{
			name:              "player name at the 20-char boundary is valid",
			playerName:        strings.Repeat("a", 20),
			score:             0,
			depthReachedMiles: 0,
			wantTrimmed:       strings.Repeat("a", 20),
		},
		{
			name:              "player name over 20 chars",
			playerName:        strings.Repeat("a", 21),
			score:             0,
			depthReachedMiles: 0,
			wantErr:           ErrFishingScorePlayerNameTooLong,
		},
		{
			name:              "negative score",
			playerName:        "Vince",
			score:             -1,
			depthReachedMiles: 0,
			wantErr:           ErrFishingScoreOutOfRange,
		},
		{
			name:              "score at the max boundary is valid",
			playerName:        "Vince",
			score:             999999,
			depthReachedMiles: 0,
			wantTrimmed:       "Vince",
		},
		{
			name:              "score over the max",
			playerName:        "Vince",
			score:             1000000,
			depthReachedMiles: 0,
			wantErr:           ErrFishingScoreOutOfRange,
		},
		{
			name:              "negative depth",
			playerName:        "Vince",
			score:             0,
			depthReachedMiles: -1,
			wantErr:           ErrFishingScoreDepthOutOfRange,
		},
		{
			name:              "depth at the 1000-mile cap is valid",
			playerName:        "Vince",
			score:             0,
			depthReachedMiles: 1000,
			wantTrimmed:       "Vince",
		},
		{
			name:              "depth over the 1000-mile cap",
			playerName:        "Vince",
			score:             0,
			depthReachedMiles: 1001,
			wantErr:           ErrFishingScoreDepthOutOfRange,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ValidateFishingScoreSubmission(tt.playerName, tt.score, tt.depthReachedMiles)

			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
				return
			}

			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tt.wantTrimmed {
				t.Fatalf("trimmed name = %q, want %q", got, tt.wantTrimmed)
			}
		})
	}
}
