-- v3.14 round tiers: the Kitchen Shift month grew from 20 to 30 shifts (see
-- docs/features/cooking-game.md and cooking-game-food-server-leveling.md),
-- so a legitimate final-month submission can now report shifts_completed
-- up to 30, and — since the per-shift payout formula (rules.js's
-- shiftPaycheck) is unchanged — total_earnings up to 30 * 4,000 = 120,000
-- rather than the old 20 * 4,000 = 80,000. Both CHECK constraints widen to
-- match, keeping the same ~25% headroom above their new theoretical max
-- the original bounds had (100,000 vs 80,000).

-- +goose Up
ALTER TABLE cooking_scores DROP CONSTRAINT cooking_scores_earnings_range;
ALTER TABLE cooking_scores ADD CONSTRAINT cooking_scores_earnings_range CHECK (total_earnings BETWEEN 0 AND 150000);

ALTER TABLE cooking_scores DROP CONSTRAINT cooking_scores_shifts_range;
ALTER TABLE cooking_scores ADD CONSTRAINT cooking_scores_shifts_range CHECK (shifts_completed BETWEEN 1 AND 30);

-- +goose Down
ALTER TABLE cooking_scores DROP CONSTRAINT cooking_scores_shifts_range;
ALTER TABLE cooking_scores ADD CONSTRAINT cooking_scores_shifts_range CHECK (shifts_completed BETWEEN 1 AND 20);

ALTER TABLE cooking_scores DROP CONSTRAINT cooking_scores_earnings_range;
ALTER TABLE cooking_scores ADD CONSTRAINT cooking_scores_earnings_range CHECK (total_earnings BETWEEN 0 AND 100000);
