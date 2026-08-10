// Pure, canvas-independent game-logic functions for the Fishing Game
// (docs/features/fishing-game.md's Business Rules / Validation).
//
// This module has NO DOM/canvas/localStorage/timer dependencies on purpose,
// so it can be unit-tested with `node --test` and imported unchanged by the
// canvas game loop (a separate task). All numeric constants below are
// illustrative/tunable per the feature doc ("tune during build") — what is
// NOT optional is the *shape* of each rule: caps, resets, and the
// depth-band/streak interplay described in the doc.

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

/** Streak multiplier never goes below this, regardless of input. */
export const STREAK_MULTIPLIER_BASE = 1.0;

/** Streak multiplier gain per 10 hit-free depth-miles. */
export const STREAK_MULTIPLIER_STEP = 0.05;

/** Streak multiplier hard cap (doc: "capped around 2.5x"). */
export const STREAK_MULTIPLIER_MAX = 2.5;

/** The depth-band / fish table from the doc's Business Rules section. */
export const FISH_BANDS = [
  { min: 0, max: 100, fish: [
    { name: 'Sardine', points: 10 },
    { name: 'Anchovy', points: 15 },
  ] },
  { min: 100, max: 300, fish: [
    { name: 'Mackerel', points: 30 },
    { name: 'Clownfish', points: 40 },
  ] },
  { min: 300, max: 600, fish: [
    { name: 'Tuna', points: 75 },
    { name: 'Swordfish', points: 100 },
  ] },
  { min: 600, max: 900, fish: [
    { name: 'Anglerfish', points: 200 },
    { name: 'Giant Squid', points: 300 },
  ] },
  { min: 900, max: 1000, fish: [
    { name: 'Golden Koi', points: 750, rare: true },
  ] },
];

/** Absolute game depth cap (doc: "1000 miles is the hard maximum"). */
export const DEPTH_CAP_MILES = 1000;

// ---------------------------------------------------------------------------
// 1. streakMultiplier
// ---------------------------------------------------------------------------

/**
 * The no-hit streak multiplier, driven purely by depth-miles descended since
 * the last hazard hit (NOT raw on-screen path length — the doc is explicit
 * that weaving side-to-side must not build streak faster than descending in
 * a straight line; it's the caller's job to feed depth-miles here, not
 * pixels/frames travelled).
 *
 * Shape (fixed by the doc): starts at 1.0x, gains +0.05x per 10 hit-free
 * miles, caps at 2.5x. A hit resets the caller's tracked
 * `milesSinceLastHit` to 0 — this function is stateless and just recomputes
 * the multiplier from that value every time it's called.
 *
 * @param {number} milesSinceLastHit - depth-miles descended since the last
 *   hazard hit (or round start). Negative/non-finite input is treated as 0.
 * @returns {number} multiplier in [STREAK_MULTIPLIER_BASE, STREAK_MULTIPLIER_MAX]
 */
export function streakMultiplier(milesSinceLastHit) {
  const miles = Number.isFinite(milesSinceLastHit) && milesSinceLastHit > 0
    ? milesSinceLastHit
    : 0;

  const steps = Math.floor(miles / 10);
  const raw = STREAK_MULTIPLIER_BASE + steps * STREAK_MULTIPLIER_STEP;

  return Math.min(raw, STREAK_MULTIPLIER_MAX);
}

// ---------------------------------------------------------------------------
// 2. fishSpawnPool
// ---------------------------------------------------------------------------

/** Base spawn weight for the lower-point fish in the current depth band. */
const BASE_LOW_TIER_WEIGHT = 60;

/** Base spawn weight for the higher-point fish in the current depth band. */
const BASE_HIGH_TIER_WEIGHT = 40;

/**
 * At max streak, the low-tier fish's weight shrinks by this fraction (but
 * never below MIN_FISH_WEIGHT) — streak biases toward the top of the pool
 * without making the low-tier fish "effectively extinct" (an open question
 * the doc explicitly flags as worth playtesting).
 */
const LOW_TIER_STREAK_DECAY = 0.5;

/** At max streak, the high-tier fish's weight grows by this fraction. */
const HIGH_TIER_STREAK_BOOST = 1.5;

/**
 * At max streak, how much weight the *next* band's lowest-tier fish gets,
 * letting it "start appearing a little early" per the doc. At streak 1.0x
 * (no streak bonus yet) this is 0 — no early preview.
 */
const NEXT_BAND_PREVIEW_MAX_WEIGHT = 15;

/** Weight floor so no fish in the reachable pool ever hits exactly zero. */
const MIN_FISH_WEIGHT = 5;

/** Weight for a band's sole fish (currently only the 900-1000mi Golden Koi band). */
const SINGLE_FISH_BAND_WEIGHT = 100;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function findBandIndex(depthMiles) {
  const depth = clamp(
    Number.isFinite(depthMiles) ? depthMiles : 0,
    0,
    DEPTH_CAP_MILES,
  );

  const index = FISH_BANDS.findIndex((band) => (
    depth >= band.min && (depth < band.max || band.max === DEPTH_CAP_MILES)
  ));

  // Defensive fallback: depth is clamped into [0, 1000] above, and the bands
  // above cover that whole range, so this should be unreachable.
  return index === -1 ? FISH_BANDS.length - 1 : index;
}

/**
 * The weighted pool of catchable fish for the player's current moment:
 * current depth band, shaped further by the no-hit streak multiplier.
 *
 * Shape (fixed by the doc):
 *  - The pool is drawn from the current depth band's fish.
 *  - Higher streak biases weight toward the top (higher-point) fish of the
 *    reachable pool, without the lower-tier fish's weight hitting zero.
 *  - Higher streak also lets the *next* band's lowest-tier fish start
 *    appearing with small, streak-increasing weight, even though raw depth
 *    hasn't reached that band yet.
 *  - The last band (900-1000mi, Golden Koi) has only one fish — no "next
 *    band" preview applies there.
 *
 * Callers do their own weighted-random selection over the returned pool;
 * this function only computes the weights.
 *
 * @param {number} depthMiles - current depth in miles.
 * @param {number} streak - the current streak multiplier, as returned by
 *   `streakMultiplier()` (i.e. already in [1.0, 2.5]). Values outside that
 *   range are clamped defensively.
 * @returns {{name: string, points: number, weight: number, rare?: boolean}[]}
 */
export function fishSpawnPool(depthMiles, streakMultiplierValue) {
  const streak = clamp(
    Number.isFinite(streakMultiplierValue) ? streakMultiplierValue : STREAK_MULTIPLIER_BASE,
    STREAK_MULTIPLIER_BASE,
    STREAK_MULTIPLIER_MAX,
  );
  const streakFactor = (streak - STREAK_MULTIPLIER_BASE)
    / (STREAK_MULTIPLIER_MAX - STREAK_MULTIPLIER_BASE);

  const bandIndex = findBandIndex(depthMiles);
  const band = FISH_BANDS[bandIndex];
  const sortedFish = [...band.fish].sort((a, b) => a.points - b.points);

  const pool = [];

  if (sortedFish.length === 1) {
    // Single-fish band (Golden Koi): nothing to bias between tiers, and
    // there is no next band to preview.
    const only = sortedFish[0];
    pool.push({ ...only, weight: SINGLE_FISH_BAND_WEIGHT });
    return pool;
  }

  const [lowTier, highTier] = sortedFish;

  const lowWeight = Math.max(
    MIN_FISH_WEIGHT,
    BASE_LOW_TIER_WEIGHT * (1 - LOW_TIER_STREAK_DECAY * streakFactor),
  );
  const highWeight = BASE_HIGH_TIER_WEIGHT * (1 + HIGH_TIER_STREAK_BOOST * streakFactor);

  pool.push({ ...lowTier, weight: lowWeight });
  pool.push({ ...highTier, weight: highWeight });

  const nextBand = FISH_BANDS[bandIndex + 1];
  if (nextBand && streakFactor > 0) {
    const nextLowTier = [...nextBand.fish].sort((a, b) => a.points - b.points)[0];
    const previewWeight = NEXT_BAND_PREVIEW_MAX_WEIGHT * streakFactor;
    pool.push({ ...nextLowTier, weight: previewWeight });
  }

  return pool;
}

// ---------------------------------------------------------------------------
// 3. descentSpeed
// ---------------------------------------------------------------------------

/** Speed at depth=0, elapsed=0 (arbitrary game units, e.g. px/frame at 60fps). */
const DESCENT_SPEED_BASE = 1.0;

/** Documented hard ceiling — both ramps approach this but never exceed it. */
const DESCENT_SPEED_MAX = 5.0;

/**
 * Controls how quickly the depth ramp saturates. Larger = slower approach to
 * max. Picked so a "small step every 100 miles" (per the doc) is visible
 * early (e.g. ~40% of the depth ramp's headroom used up by 300mi) while
 * still asymptoting well before the 1000mi depth cap.
 */
const DEPTH_SATURATION_MILES = 400;

/**
 * Controls how quickly the elapsed-time ramp saturates, in seconds. Picked
 * so the "slow continuous ramp" is felt within a couple of minutes, which is
 * a plausible round length for this arcade game.
 */
const TIME_SATURATION_SECONDS = 120;

/** Share of the max-speed headroom attributable to depth vs. elapsed time. */
const DEPTH_RAMP_WEIGHT = 0.6;
const TIME_RAMP_WEIGHT = 0.4;

/**
 * Descent speed as a function of current depth and elapsed round time.
 *
 * Shape (fixed by the doc, this was an explicit gap-fix over a prior
 * uncapped draft): increases gradually with both `depthMiles` and
 * `elapsedSeconds` independently, but the *combined* speed approaches
 * `DESCENT_SPEED_MAX` asymptotically and can never reach or exceed it, no
 * matter how large the inputs get (long/deep runs get harder, never
 * unplayable/glitchy).
 *
 * Formula: each axis contributes via a saturating exponential
 * `1 - exp(-x / saturationConstant)`, which is 0 at x=0 and approaches (but
 * never reaches) 1 as x grows — so each axis's contribution to speed is
 * strictly less than its weighted share of the max-speed headroom, and the
 * two contributions are weighted to sum to at most that full headroom.
 * That guarantees `speed < DESCENT_SPEED_MAX` for every finite input.
 *
 * @param {number} depthMiles - current depth in miles (negative clamps to 0).
 * @param {number} elapsedSeconds - elapsed round time in seconds (negative clamps to 0).
 * @returns {number} speed in [DESCENT_SPEED_BASE, DESCENT_SPEED_MAX] — the
 *   asymptote is mathematically only ever approached, but the return value
 *   is defensively clamped so it can never be observed to exceed the max.
 */
export function descentSpeed(depthMiles, elapsedSeconds) {
  const depth = Number.isFinite(depthMiles) && depthMiles > 0 ? depthMiles : 0;
  const elapsed = Number.isFinite(elapsedSeconds) && elapsedSeconds > 0 ? elapsedSeconds : 0;

  const headroom = DESCENT_SPEED_MAX - DESCENT_SPEED_BASE;

  const depthRamp = 1 - Math.exp(-depth / DEPTH_SATURATION_MILES);
  const timeRamp = 1 - Math.exp(-elapsed / TIME_SATURATION_SECONDS);

  const speed = DESCENT_SPEED_BASE
    + headroom * DEPTH_RAMP_WEIGHT * depthRamp
    + headroom * TIME_RAMP_WEIGHT * timeRamp;

  // Defensive clamp: the formula above already guarantees speed stays in
  // range for finite input, but guard explicitly against exceeding the
  // documented max (e.g. from unexpected floating-point edge cases).
  return clamp(speed, DESCENT_SPEED_BASE, DESCENT_SPEED_MAX);
}

// ---------------------------------------------------------------------------
// 4. roundTokens
// ---------------------------------------------------------------------------

/** Score-to-token conversion rate: floor(score / this). */
const TOKENS_PER_SCORE_DIVISOR = 20;

/** Bonus tokens per full 100-mile depth band reached during the round. */
const MILESTONE_BONUS_PER_BAND = 5;

/** Depth-band size for the milestone bonus, matching the fish-band width. */
const MILESTONE_BAND_MILES = 100;

/**
 * Converts a finished round's score and depth reached into fishing tokens.
 *
 * Shape (fixed by the doc): tokens = floor(score / divisor) + a milestone
 * bonus for each full 100-mile depth band reached this round. Awarded once,
 * at round end only (the doc: "no partial credit for an abandoned round") —
 * enforcing "round end only" is the caller's responsibility (this function
 * just computes the amount for a finished round); this function always
 * returns a sane non-negative integer even for score=0/depth=0.
 *
 * @param {number} score - final round score (negative/non-finite treated as 0).
 * @param {number} depthReachedMiles - depth reached this round, miles
 *   (clamped into [0, DEPTH_CAP_MILES], matching the game's own depth cap).
 * @returns {number} whole number of tokens, >= 0.
 */
export function roundTokens(score, depthReachedMiles) {
  const safeScore = Number.isFinite(score) && score > 0 ? score : 0;
  const safeDepth = clamp(
    Number.isFinite(depthReachedMiles) ? depthReachedMiles : 0,
    0,
    DEPTH_CAP_MILES,
  );

  const baseTokens = Math.floor(safeScore / TOKENS_PER_SCORE_DIVISOR);
  const bandsReached = Math.floor(safeDepth / MILESTONE_BAND_MILES);
  const milestoneTokens = bandsReached * MILESTONE_BONUS_PER_BAND;

  return Math.max(0, baseTokens + milestoneTokens);
}
