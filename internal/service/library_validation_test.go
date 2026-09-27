package service

import (
	"errors"
	"strings"
	"testing"
)

func TestValidateLibraryScoreSubmission(t *testing.T) {
	tests := []struct {
		name            string
		playerName      string
		totalEarnings   int
		shiftsCompleted int
		wantTrimmed     string
		wantErr         error
	}{
		{
			name:            "valid submission",
			playerName:      "Vince",
			totalEarnings:   80000,
			shiftsCompleted: 30,
			wantTrimmed:     "Vince",
		},
		{
			name:            "player name is trimmed",
			playerName:      "  Vince  ",
			totalEarnings:   0,
			shiftsCompleted: 1,
			wantTrimmed:     "Vince",
		},
		{
			name:            "empty player name",
			playerName:      "",
			totalEarnings:   0,
			shiftsCompleted: 1,
			wantErr:         ErrLibraryScorePlayerNameRequired,
		},
		{
			name:            "whitespace-only player name",
			playerName:      "   ",
			totalEarnings:   0,
			shiftsCompleted: 1,
			wantErr:         ErrLibraryScorePlayerNameRequired,
		},
		{
			name:            "player name at the 20-char boundary is valid",
			playerName:      strings.Repeat("a", 20),
			totalEarnings:   0,
			shiftsCompleted: 1,
			wantTrimmed:     strings.Repeat("a", 20),
		},
		{
			name:            "player name over 20 chars",
			playerName:      strings.Repeat("a", 21),
			totalEarnings:   0,
			shiftsCompleted: 1,
			wantErr:         ErrLibraryScorePlayerNameTooLong,
		},
		{
			name:            "negative earnings",
			playerName:      "Vince",
			totalEarnings:   -1,
			shiftsCompleted: 1,
			wantErr:         ErrLibraryScoreEarningsOutOfRange,
		},
		{
			name:            "earnings at the max boundary is valid",
			playerName:      "Vince",
			totalEarnings:   100000,
			shiftsCompleted: 1,
			wantTrimmed:     "Vince",
		},
		{
			name:            "earnings over the max",
			playerName:      "Vince",
			totalEarnings:   100001,
			shiftsCompleted: 1,
			wantErr:         ErrLibraryScoreEarningsOutOfRange,
		},
		{
			name:            "zero shifts completed is out of range",
			playerName:      "Vince",
			totalEarnings:   0,
			shiftsCompleted: 0,
			wantErr:         ErrLibraryScoreShiftsOutOfRange,
		},
		{
			name:            "shifts completed at the 30-shift cap is valid",
			playerName:      "Vince",
			totalEarnings:   0,
			shiftsCompleted: 30,
			wantTrimmed:     "Vince",
		},
		{
			name:            "shifts completed over the 30-shift cap",
			playerName:      "Vince",
			totalEarnings:   0,
			shiftsCompleted: 31,
			wantErr:         ErrLibraryScoreShiftsOutOfRange,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ValidateLibraryScoreSubmission(tt.playerName, tt.totalEarnings, tt.shiftsCompleted)

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
