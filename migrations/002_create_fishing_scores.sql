-- This table is the fishing game's public leaderboard only: voluntarily
-- submitted, already-finished round results (player_name, score,
-- depth_reached_miles). Per-player tokens, gear levels, and progress are
-- intentionally NOT stored here — they live in the browser's localStorage,
-- since this site has no visitor accounts to key server-side per-player
-- state on. See docs/features/fishing-game.md's Data Model section.

-- +goose Up
CREATE TABLE fishing_scores (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    player_name         TEXT NOT NULL,
    score               INT NOT NULL,
    depth_reached_miles INT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fishing_scores_player_name_length CHECK (char_length(player_name) BETWEEN 1 AND 20),
    CONSTRAINT fishing_scores_score_range CHECK (score BETWEEN 0 AND 999999),
    CONSTRAINT fishing_scores_depth_range CHECK (depth_reached_miles BETWEEN 0 AND 1000)
);

CREATE INDEX idx_fishing_scores_score ON fishing_scores (score DESC);

-- +goose Down
DROP INDEX idx_fishing_scores_score;
DROP TABLE fishing_scores;
