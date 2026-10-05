-- Bus Rush's public leaderboard: voluntarily submitted, finished-run
-- results. Tokens/upgrades live in the browser's localStorage, same as the
-- fishing game. See docs/features/bus-rush.md's Data Model.

-- +goose Up
CREATE TABLE bus_rush_scores (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    player_name     TEXT NOT NULL,
    score           INT NOT NULL,
    distance_meters INT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT bus_rush_scores_player_name_length CHECK (char_length(player_name) BETWEEN 1 AND 20),
    CONSTRAINT bus_rush_scores_score_range CHECK (score BETWEEN 0 AND 999999),
    CONSTRAINT bus_rush_scores_distance_range CHECK (distance_meters BETWEEN 0 AND 999999)
);

CREATE INDEX idx_bus_rush_scores_score ON bus_rush_scores (score DESC);

-- +goose Down
DROP INDEX idx_bus_rush_scores_score;
DROP TABLE bus_rush_scores;
