-- This table is the Kitchen Shift game's public leaderboard only:
-- voluntarily submitted, already-finished month results (player_name,
-- total_earnings in Gard, shifts_completed). Per-player Gard, shop levels,
-- and in-progress-shift state are intentionally NOT stored here — they live
-- in the browser's localStorage, since this site has no visitor accounts to
-- key server-side per-player state on. See docs/features/cooking-game.md's
-- Data Model section.

-- +goose Up
CREATE TABLE cooking_scores (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    player_name      TEXT NOT NULL,
    total_earnings   INT NOT NULL,
    shifts_completed INT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cooking_scores_player_name_length CHECK (char_length(player_name) BETWEEN 1 AND 20),
    CONSTRAINT cooking_scores_earnings_range CHECK (total_earnings BETWEEN 0 AND 100000),
    CONSTRAINT cooking_scores_shifts_range CHECK (shifts_completed BETWEEN 1 AND 20)
);

CREATE INDEX idx_cooking_scores_earnings ON cooking_scores (total_earnings DESC);

-- +goose Down
DROP INDEX idx_cooking_scores_earnings;
DROP TABLE cooking_scores;
