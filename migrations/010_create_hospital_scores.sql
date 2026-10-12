-- Hospital Shift's public leaderboard, mirroring library_scores
-- (docs/features/hospital-shift.md's Data Model): voluntarily submitted,
-- already-finished run results only. Per-player Gard and in-progress shift
-- state live in the browser's localStorage (`hospital-game:v1`).
--
-- total_earnings allows up to 300000 rather than library_scores' 100000:
-- 30 clean shifts at the 4000 Gard base plus discharge/step bonuses can
-- pass 100000, and a legitimate best run shouldn't be rejected.

-- +goose Up
CREATE TABLE hospital_scores (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    player_name      TEXT NOT NULL,
    total_earnings   INT NOT NULL,
    shifts_completed INT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hospital_scores_player_name_length CHECK (char_length(player_name) BETWEEN 1 AND 20),
    CONSTRAINT hospital_scores_earnings_range CHECK (total_earnings BETWEEN 0 AND 300000),
    CONSTRAINT hospital_scores_shifts_range CHECK (shifts_completed BETWEEN 1 AND 30)
);

CREATE INDEX idx_hospital_scores_earnings ON hospital_scores (total_earnings DESC);

-- +goose Down
DROP INDEX idx_hospital_scores_earnings;
DROP TABLE hospital_scores;
