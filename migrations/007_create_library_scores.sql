-- Library Shift's public leaderboard, mirroring cooking_scores exactly
-- (docs/features/library-game.md's Data Model): voluntarily submitted,
-- already-finished run results only (player_name, total_earnings in Gard,
-- shifts_completed). Per-player Gard, shelf/book layout, and in-progress
-- shift state are intentionally NOT stored here — they live in the
-- browser's localStorage (the `library-game:v1` key), since this site has
-- no visitor accounts to key server-side per-player state on.
--
-- Numbered 007, not the doc's illustrative "005" — 005/006 were already
-- taken by 005_create_landing_content.sql/006_add_resume_authoring.sql by
-- the time this was implemented; the doc was written before those landed.
--
-- shifts_completed's range is 1-30 (not cooking_scores' 1-20 at its
-- original migration, nor its current widened 1-30 — see migration 004):
-- Library Shift always runs a fixed 30-shift month, per this doc's Scope.

-- +goose Up
CREATE TABLE library_scores (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    player_name      TEXT NOT NULL,
    total_earnings   INT NOT NULL,
    shifts_completed INT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT library_scores_player_name_length CHECK (char_length(player_name) BETWEEN 1 AND 20),
    CONSTRAINT library_scores_earnings_range CHECK (total_earnings BETWEEN 0 AND 100000),
    CONSTRAINT library_scores_shifts_range CHECK (shifts_completed BETWEEN 1 AND 30)
);

CREATE INDEX idx_library_scores_earnings ON library_scores (total_earnings DESC);

-- +goose Down
DROP INDEX idx_library_scores_earnings;
DROP TABLE library_scores;
