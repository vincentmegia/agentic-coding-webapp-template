// Pure, canvas-independent game-logic functions for Library Shift
// (docs/features/library-game.md's Business Rules / Validation).
//
// This module has NO DOM/canvas/localStorage/timer dependencies on purpose,
// so it can be unit-tested with `node --test` and imported unchanged by the
// canvas game loop (library-game.js, owned by a different agent). It
// mirrors Kitchen Shift's rules.js shape directly (web/static/js/cooking/
// rules.js) — same "named, tunable constants with a doc comment explaining
// the number" convention, same round-tier structure, same shiftPaycheck
// shape. All numeric constants below are illustrative/tunable per the
// feature doc ("exact... difficulty curve... left as implementation-time
// tuning") — what is NOT optional is the *shape* of each rule.

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

/**
 * Shifts per month/run — the doc's own "30 shifts... in three 10-shift
 * tiers," reusing Kitchen Shift's SHIFTS_PER_MONTH number directly rather
 * than picking a different one (doc's Business Rules: "reused directly").
 */
export const SHIFTS_PER_MONTH = 30;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clampShift(shiftNumber) {
  const shift = Number.isFinite(shiftNumber) ? Math.floor(shiftNumber) : 1;
  return clamp(shift, 1, SHIFTS_PER_MONTH);
}

// ---------------------------------------------------------------------------
// 1. Round tiers — Tier 1 (1-10), Tier 2 (11-20), Tier 3 (21-30), each with
//    its own shift-clock budget and Return Cart/fine/borrow-request volume
//    (doc's Business Rules: "Shift tiers"). Clock seconds reuse Kitchen
//    Shift's own 300/180/120s tier shape as a starting point per the build
//    brief; volumes are new to this game (Kitchen Shift's tiers grow table
//    count, this game grows queue volume instead, so there's no KS number
//    to reuse there).
// ---------------------------------------------------------------------------

/** Three difficulty bands per run — same framing as Kitchen Shift's ROUND_TIER_COUNT. */
export const ROUND_TIER_COUNT = 3;

/** Shifts per tier (30 shifts / 3 tiers). */
export const ROUND_TIER_SHIFT_SPAN = 10;

/**
 * Each tier's real-time shift-clock budget, in seconds. Deliberately NOT
 * Kitchen Shift's own 300/180/120s tier numbers — the doc's Business Rules
 * are explicit that those were only a *structural* starting reference
 * (shrinking per tier), not values to copy: Kitchen Shift compresses a full
 * day into that budget, which reads as very fast, and the user explicitly
 * asked this game's clock not "go so fast." 600/480/360s (10/8/6 real
 * minutes) still shrinks per tier for difficulty, just from a much higher
 * floor, so the 15-in-game-hour day (see SHIFT_START_MINUTES/
 * SHIFT_END_MINUTES below) advances at a noticeably slower, more readable
 * pace.
 */
export const ROUND_TIER_CLOCK_SECONDS = [600, 480, 360];

/**
 * Books delivered to the Return Cart over the course of one shift, per
 * tier — grows across the run so the shelving loop gets busier even as the
 * clock shrinks.
 */
export const ROUND_TIER_RETURN_VOLUME = [6, 10, 16];

/** Fine-paying patrons arriving at the Fines Counter over one shift, per tier (once fines have started — see finesStartShiftForSeed). v2.8: raised from [2, 4, 6] — early shifts felt empty (user: "when doe sthe costermers come??? i cant see them"). */
export const ROUND_TIER_FINE_VOLUME = [4, 6, 9];

/** Borrow-request patrons arriving at the Front Desk over one shift, per tier. v2.8: raised from [2, 4, 6], same reason. */
export const ROUND_TIER_BORROW_VOLUME = [5, 8, 12];

/** The first borrow patron of every shift arrives within this window (seconds after the shift starts), so there's always someone early instead of a multi-minute wait. */
export const FIRST_BORROW_ARRIVAL_SECONDS = [5, 20];

/**
 * Which difficulty tier a given shift number falls in.
 *
 * @param {number} shiftNumber - 1..SHIFTS_PER_MONTH (out-of-range/non-finite clamped).
 * @returns {number} 1..ROUND_TIER_COUNT.
 */
export function roundTier(shiftNumber) {
  const shift = clampShift(shiftNumber);
  return clamp(Math.ceil(shift / ROUND_TIER_SHIFT_SPAN), 1, ROUND_TIER_COUNT);
}

/**
 * The shift-clock countdown, in seconds, for whichever tier `shiftNumber`
 * falls in.
 *
 * @param {number} shiftNumber
 * @returns {number}
 */
export function shiftClockSecondsForShift(shiftNumber) {
  return ROUND_TIER_CLOCK_SECONDS[roundTier(shiftNumber) - 1];
}

/**
 * How many books arrive on the Return Cart this shift.
 *
 * @param {number} shiftNumber
 * @returns {number}
 */
export function returnVolumeForShift(shiftNumber) {
  return ROUND_TIER_RETURN_VOLUME[roundTier(shiftNumber) - 1];
}

/**
 * How many fine-paying patrons arrive this shift: the tier's volume, or 0
 * before this month's `finesStartShift` (see `finesStartShiftForSeed` —
 * since v2.4 fines don't begin until a shift rolled in 5–8). Omitting
 * `finesStartShift` means no gate (shift 1 onward).
 *
 * @param {number} shiftNumber
 * @param {number} [finesStartShift=1]
 * @returns {number}
 */
export function fineVolumeForShift(shiftNumber, finesStartShift = 1) {
  if (clampShift(shiftNumber) < finesStartShift) return 0;
  return ROUND_TIER_FINE_VOLUME[roundTier(shiftNumber) - 1];
}

/**
 * How many borrow-request patrons arrive this shift.
 *
 * @param {number} shiftNumber
 * @returns {number}
 */
export function borrowVolumeForShift(shiftNumber) {
  return ROUND_TIER_BORROW_VOLUME[roundTier(shiftNumber) - 1];
}

// ---------------------------------------------------------------------------
// 1.5. In-game clock display — the library's shift day runs 8:00 AM to
//      11:00 PM (15 in-game hours), mapped linearly onto the real-time
//      shift-clock countdown (whichever ROUND_TIER_CLOCK_SECONDS budget
//      applies), same `inGameTimeLabel`-style approach as Kitchen Shift's
//      own clock display so "a third of the shift clock left" always means
//      one specific in-game time, not two numbers that could drift apart.
// ---------------------------------------------------------------------------

/** The library's opening time, in minutes since midnight: 8:00 AM. */
export const SHIFT_START_MINUTES = 8 * 60;
/** The library's closing time, in minutes since midnight: 11:00 PM — the moment the closing wait begins. */
export const SHIFT_END_MINUTES = 23 * 60;

/**
 * Formats the current in-game library time from how many real seconds are
 * left on the shift clock.
 *
 * @param {number} clockSecondsRemaining - as tracked by engine-state.js's `ShiftState.clockSeconds` (negative/non-finite treated as `totalClockSeconds`, i.e. "shift just started").
 * @param {number} totalClockSeconds - this shift's full countdown length (rules.js's shiftClockSecondsForShift(shiftNumber); non-positive/non-finite falls back to Tier 1's budget).
 * @returns {string} e.g. "8:00 AM", "3:30 PM", "11:00 PM".
 */
export function inGameTimeLabel(clockSecondsRemaining, totalClockSeconds) {
  const total = Number.isFinite(totalClockSeconds) && totalClockSeconds > 0 ? totalClockSeconds : ROUND_TIER_CLOCK_SECONDS[0];
  const remaining = Number.isFinite(clockSecondsRemaining) ? clamp(clockSecondsRemaining, 0, total) : total;
  const elapsedFraction = 1 - remaining / total;
  const totalMinutes = Math.round(SHIFT_START_MINUTES + elapsedFraction * (SHIFT_END_MINUTES - SHIFT_START_MINUTES));

  const hour24 = Math.floor(totalMinutes / 60) % 24;
  const minute = totalMinutes % 60;
  const period = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;

  return `${hour12}:${String(minute).padStart(2, '0')} ${period}`;
}

// ---------------------------------------------------------------------------
// 2. Karen's shift — a one-time scripted patron, chosen once per save as
//    randomInt(10, 15) at month start, re-rolled on "Start New Month" (doc's
//    Business Rules: "Karen shift"). Unlike Kitchen Shift's KAREN_SHIFT_NUMBER
//    (a fixed constant), this game's spec calls for a *randomized* shift
//    number that must still be *stable* across a page reload mid-run — so
//    it can't be re-rolled with plain Math.random() on every read. Instead
//    it's derived deterministically from a `seed` the caller draws once at
//    month start (e.g. `Date.now()`) and stores in the save alongside it;
//    calling this function again with the same seed always reproduces the
//    same shift number, but a fresh "Start New Month" seed reproduces a
//    (likely) different one. This file has no RNG of its own elsewhere
//    (every other formula here is a pure function of its inputs, same
//    convention as cooking/rules.js) — this is the one exception, and it's
//    a deterministic hash rather than a live Math.random() call for exactly
//    that reason.
// ---------------------------------------------------------------------------

/** Karen's shift is randomInt(10, 15) — the doc's own range. */
export const KAREN_SHIFT_MIN = 10;
export const KAREN_SHIFT_MAX = 15;

/**
 * A small, fast, deterministic PRNG (mulberry32) — not cryptographic, just
 * needs to spread a 32-bit seed evenly across [0, 1) so
 * `karenShiftForSeed` doesn't visibly favor one end of its range.
 *
 * @param {number} seed - a 32-bit integer (values outside that range wrap via `>>> 0`).
 * @returns {() => number} a function producing the next value in [0, 1) on each call.
 */
function mulberry32(seed) {
  let t = seed >>> 0;
  return function next() {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministically derives Karen's shift number for a given save seed.
 * The same seed always returns the same shift number; a different seed
 * (drawn fresh on "Start New Month") is very likely to return a different
 * one.
 *
 * @param {number} seed - e.g. `Date.now()` at month start, stored in the save (non-finite treated as 0).
 * @returns {number} an integer in [KAREN_SHIFT_MIN, KAREN_SHIFT_MAX].
 */
export function karenShiftForSeed(seed) {
  const value = Number.isFinite(seed) ? Math.floor(seed) : 0;
  const roll = mulberry32(value)();
  const span = KAREN_SHIFT_MAX - KAREN_SHIFT_MIN + 1;
  return KAREN_SHIFT_MIN + Math.min(span - 1, Math.floor(roll * span));
}

/** Earliest/latest shift fine-paying patrons can start arriving (v2.4: "let fines customers come in around shift 5-8"). */
export const FINES_START_SHIFT_MIN = 5;
export const FINES_START_SHIFT_MAX = 8;

/**
 * Deterministically derives the shift fines start on for a save seed, the
 * same shape as `karenShiftForSeed` (and from the same per-month seed), but
 * from an independent stream, so the two rolls aren't correlated.
 *
 * @param {number} seed - the save's month seed (non-finite treated as 0).
 * @returns {number} an integer in [FINES_START_SHIFT_MIN, FINES_START_SHIFT_MAX].
 */
export function finesStartShiftForSeed(seed) {
  const value = Number.isFinite(seed) ? Math.floor(seed) : 0;
  const roll = mulberry32((value ^ 0x9e3779b9) >>> 0)();
  const span = FINES_START_SHIFT_MAX - FINES_START_SHIFT_MIN + 1;
  return FINES_START_SHIFT_MIN + Math.min(span - 1, Math.floor(roll * span));
}

/** How long the player has to respond to Karen's scripted event before it auto-resolves as mishandled (engine-state.js's startKarenEvent/tickKarenEvent). Short — she's not here to wait — but long enough to walk over from wherever the player is. */
export const KAREN_EVENT_TIMER_SECONDS = 12;

/** The overdue fine Karen owes, banked as Gard only if the player successfully collects it (engine-state.js's resolveKarenEvent('collectFine')). */
export const KAREN_FINE_AMOUNT_GARD = 60;

/**
 * Library mood lost if Karen's event is mishandled (she leaves without
 * paying) — bigger than a normal mistake's LIBRARY_MOOD_DRAIN_PER_MISTAKE
 * (below), reflecting how much more disruptive her scripted outburst is
 * than an ordinary missed shelving/fine/checkout.
 */
export const KAREN_MOOD_PENALTY = 50;

/** Her opening line, shown the moment her scripted event starts. */
export const KAREN_LINE = "THIS FINE IS RIDICULOUS, I'M NOT PAYING IT";

// ---------------------------------------------------------------------------
// 3. Book genres/shelves — every returned or requested book belongs to
//    exactly one of these, matched by color-coded call number (doc's Scope:
//    "matched by a genre/color-coded call number").
// ---------------------------------------------------------------------------

/** Every genre/shelf a book can belong to, with the color its call-number label/shelf renders in. */
export const GENRES = [
  { id: 'mystery', name: 'Mystery', color: '#4a4e69' },
  { id: 'romance', name: 'Romance', color: '#d6336c' },
  { id: 'scifi', name: 'Sci-Fi', color: '#1c7ed6' },
  { id: 'kids', name: 'Kids', color: '#f2a72c' },
  { id: 'reference', name: 'Reference', color: '#5a9b5a' },
];

/**
 * Looks up a genre by id.
 *
 * @param {string} genreId
 * @returns {{id: string, name: string, color: string} | null}
 */
export function findGenre(genreId) {
  return GENRES.find((g) => g.id === genreId) ?? null;
}

// ---------------------------------------------------------------------------
// 4. Coin Hunt — a configurable fraction of returned books trigger the
//    hidden-object minigame instead of a plain Shelf Skill-Check (doc's
//    Business Rules: "Coin Hunt frequency... a configurable fraction... not
//    hardcoded inline").
// ---------------------------------------------------------------------------

/** ~1 in 5 returned books are Coin Hunt books (doc's own "e.g. ~1 in 5" figure). */
export const COIN_HUNT_FREQUENCY = 0.2;

/**
 * Whether a returned book is a Coin Hunt book. This file has no RNG of its
 * own (see rules.js's section 2 comment) — the caller draws `randomRoll`
 * from `[0, 1)` itself once per book and passes it in.
 *
 * @param {number} randomRoll - in [0, 1); out-of-range/non-finite defaults to "not a Coin Hunt book."
 * @returns {boolean}
 */
export function isCoinHuntBook(randomRoll) {
  return Number.isFinite(randomRoll) && randomRoll >= 0 && randomRoll < COIN_HUNT_FREQUENCY;
}

/** Gard value of a single found coin/bill inside a Coin Hunt book. */
export const COIN_HUNT_ITEM_VALUE_GARD = 25;

/** How many coins/bills a Coin Hunt book's scene hides, by default (the rendering layer may scatter a different count; this is the baseline the value above is tuned against). */
export const COIN_HUNT_ITEMS_PER_BOOK = 4;

// ---------------------------------------------------------------------------
// 5. Fines — Gard-only (doc: "for the fines its gard only"), a per-patron
//    amount in a tunable range.
// ---------------------------------------------------------------------------

export const FINE_AMOUNT_MIN_GARD = 20;
export const FINE_AMOUNT_MAX_GARD = 80;

/**
 * A patron's fine amount for a given random roll, linearly interpolated
 * across [FINE_AMOUNT_MIN_GARD, FINE_AMOUNT_MAX_GARD]. Same "caller draws
 * the roll, this file just maps it" shape as `isCoinHuntBook`.
 *
 * @param {number} randomRoll - in [0, 1); out-of-range/non-finite clamped/defaulted to the midpoint.
 * @returns {number} a whole-Gard amount.
 */
export function fineAmountForRoll(randomRoll) {
  const roll = Number.isFinite(randomRoll) ? clamp(randomRoll, 0, 1) : 0.5;
  return Math.round(FINE_AMOUNT_MIN_GARD + roll * (FINE_AMOUNT_MAX_GARD - FINE_AMOUNT_MIN_GARD));
}

// ---------------------------------------------------------------------------
// 6. Shift paycheck — same shape as Kitchen Shift's shiftPaycheck: a base
//    amount minus a flat per-mistake penalty, floored above zero, never a
//    hard game-over (doc's Business Rules: "Payout").
// ---------------------------------------------------------------------------

/** A clean shift's Gard payout, before any per-mistake penalty or bonuses. Matches Kitchen Shift's SHIFT_PAYCHECK_FULL — Gard is a currency shared across this site's games, so the two payouts are deliberately on the same scale. */
export const SHIFT_PAYCHECK_FULL = 4000;

/** Gard deducted per mistake (a failed Shelf/Checkout Skill-Check, a failed Fines Sort, or a borrow request that ran out of patience). */
export const SHIFT_PAYCHECK_PENALTY_PER_MISTAKE = 500;

/** The floor a shift's base payout can never drop below, regardless of mistake count. Coin Hunt/fines/Karen bonuses (bonusGard, engine-state.js) are added on top of this floor, not folded into it. */
export const SHIFT_PAYCHECK_MIN = 500;

/**
 * A shift's base Gard payout (before Coin Hunt/fines/Karen bonuses):
 * SHIFT_PAYCHECK_FULL minus SHIFT_PAYCHECK_PENALTY_PER_MISTAKE per mistake,
 * floored at SHIFT_PAYCHECK_MIN.
 *
 * @param {number} mistakeCount - 0 or more (negative/non-finite treated as 0).
 * @returns {number}
 */
export function shiftPaycheck(mistakeCount) {
  const mistakes = Number.isFinite(mistakeCount) && mistakeCount > 0 ? mistakeCount : 0;
  return Math.max(SHIFT_PAYCHECK_MIN, SHIFT_PAYCHECK_FULL - mistakes * SHIFT_PAYCHECK_PENALTY_PER_MISTAKE);
}

/**
 * Sums a run's worth of per-shift total payouts (base + bonuses) into the
 * run total — mirrors Kitchen Shift's monthTotal.
 *
 * @param {number[]} shiftPayouts
 * @returns {number}
 */
export function monthTotal(shiftPayouts) {
  return Array.isArray(shiftPayouts) ? shiftPayouts.reduce((sum, p) => sum + (Number.isFinite(p) ? p : 0), 0) : 0;
}

/**
 * How long the Boss's Office stays locked/non-interactive after the shift
 * clock hits 11:00 PM, before the boss lets the player in to collect the
 * paycheck (doc's Business Rules: "Closing wait" — engine-state.js's
 * 'closing-wait' phase).
 */
export const CLOSING_WAIT_SECONDS = 20;

// ---------------------------------------------------------------------------
// 7. Skill-check timing bar — shared by the Shelf Skill-Check and Checkout
//    Skill-Check (doc: "both are the same timing-bar mechanic... share one
//    formula/threshold set between them unless there's a reason not to" —
//    there isn't one, so this section is the single shared definition).
//    Same binary-success-zone shape as Kitchen Shift's cookSuccessZone/
//    isCookSuccess/cookSweepSpeed, with no gear-driven zone-widening (this
//    game has no gear/shop system in v1 per the doc's Out of scope) — the
//    zone width is a flat constant instead.
// ---------------------------------------------------------------------------

/** The timing bar's success window width, as a fraction of the full 0..1 sweep, centered at 0.5. No gear widens it (this game has no shop/gear system in v1). */
export const SKILL_CHECK_ZONE_WIDTH = 0.2;

/**
 * The shared Shelf/Checkout Skill-Check success zone.
 *
 * @returns {{start: number, end: number, width: number}}
 */
export function skillCheckSuccessZone(scale = 1) {
  const width = SKILL_CHECK_ZONE_WIDTH * (Number.isFinite(scale) && scale > 0 ? scale : 1);
  return { start: 0.5 - width / 2, end: 0.5 + width / 2, width };
}

/**
 * Whether a sweep sample lands inside the success zone.
 *
 * @param {number} gaugePosition - 0..1 sweep position at the moment of interaction.
 * @param {{start: number, end: number}} [zone] - defaults to skillCheckSuccessZone().
 * @returns {boolean}
 */
export function isSkillCheckSuccess(gaugePosition, zone = skillCheckSuccessZone()) {
  return Number.isFinite(gaugePosition) && gaugePosition >= zone.start && gaugePosition <= zone.end;
}

const SKILL_CHECK_SWEEP_SPEED_BASE = 0.6;
const SKILL_CHECK_SWEEP_SPEED_MAX = 1.6;
const SKILL_CHECK_SWEEP_SHIFT_SATURATION = 12;

/**
 * How fast the skill-check gauge sweeps (fraction of the 0..1 range per
 * second), ramping up with shift number — same asymptotic-approach shape
 * as Kitchen Shift's cookSweepSpeed, shared by both the Shelf and Checkout
 * Skill-Checks.
 *
 * @param {number} shiftNumber - 1..SHIFTS_PER_MONTH.
 * @returns {number}
 */
export function skillCheckSweepSpeed(shiftNumber) {
  const shift = clampShift(shiftNumber) - 1;
  const headroom = SKILL_CHECK_SWEEP_SPEED_MAX - SKILL_CHECK_SWEEP_SPEED_BASE;
  const ramp = 1 - Math.exp(-shift / SKILL_CHECK_SWEEP_SHIFT_SATURATION);
  return clamp(SKILL_CHECK_SWEEP_SPEED_BASE + headroom * ramp, SKILL_CHECK_SWEEP_SPEED_BASE, SKILL_CHECK_SWEEP_SPEED_MAX);
}

// ---------------------------------------------------------------------------
// 8. Borrow-request patience — the "Find the Book" search step's patience
//    budget (doc: "Failing either step costs the patron's patience"),
//    same decreasing-with-shift-number ramp shape as Kitchen Shift's
//    customerPatienceSeconds.
// ---------------------------------------------------------------------------

// v2.7: raised from 40/18 — the old floor (~11 s at low mood) wasn't
// enough to walk upstairs and back (user: the patron "dissapears and i
// didnt get the book").
export const BORROW_PATIENCE_BASE_SECONDS = 60;
export const BORROW_PATIENCE_MIN_SECONDS = 30;
const BORROW_PATIENCE_SHIFT_SATURATION = 10;

/**
 * Seconds a borrow-request patron waits during the Find the Book search
 * before leaving (a mistake) — decreasing with shift number, same shape as
 * Kitchen Shift's customerPatienceSeconds.
 *
 * @param {number} shiftNumber - 1..SHIFTS_PER_MONTH.
 * @returns {number}
 */
export function borrowPatienceSeconds(shiftNumber) {
  const shift = clampShift(shiftNumber) - 1;
  const headroom = BORROW_PATIENCE_BASE_SECONDS - BORROW_PATIENCE_MIN_SECONDS;
  const ramp = 1 - Math.exp(-shift / BORROW_PATIENCE_SHIFT_SATURATION);
  return clamp(BORROW_PATIENCE_BASE_SECONDS - headroom * ramp, BORROW_PATIENCE_MIN_SECONDS, BORROW_PATIENCE_BASE_SECONDS);
}

// ---------------------------------------------------------------------------
// 9. Library mood — this game's restaurant-mood-equivalent stat (doc's
//    Karen-event line: "draining a restaurant-mood-equivalent stat").
//    Same shape as Kitchen Shift's reputation (rules.js section 10) exactly:
//    starts full every shift, only ever moves on a mistake (never passively),
//    and scales patron patience via a linear multiplier down to a floor.
// ---------------------------------------------------------------------------

/** Library mood starts here every shift — a clean shift never touches it. */
export const LIBRARY_MOOD_MAX = 100;

/** Mood lost per ordinary mistake (a failed Shelf/Checkout Skill-Check, a failed Fines Sort, or a borrow request that ran out of patience) — four mistakes bottoms it out, same shape as Kitchen Shift's REPUTATION_DRAIN_PER_MISTAKE. */
export const LIBRARY_MOOD_DRAIN_PER_MISTAKE = 25;

/** Patience multiplier floor at 0 mood — shorter-fused patrons, not instant walkouts. */
const LIBRARY_MOOD_MIN_PATIENCE_MULTIPLIER = 0.6;

/**
 * Clamps a proposed library-mood value into `[0, LIBRARY_MOOD_MAX]`.
 *
 * @param {number} mood
 * @returns {number}
 */
export function clampLibraryMood(mood) {
  return clamp(Number.isFinite(mood) ? mood : 0, 0, LIBRARY_MOOD_MAX);
}

/**
 * Patron patience multiplier for the library's current mood: 1.0 at full
 * mood, linearly down to LIBRARY_MOOD_MIN_PATIENCE_MULTIPLIER at 0 —
 * mirrors Kitchen Shift's patienceMultiplierForReputation exactly.
 *
 * @param {number} mood - 0..LIBRARY_MOOD_MAX (out-of-range/non-finite clamped).
 * @returns {number}
 */
export function patienceMultiplierForLibraryMood(mood) {
  const fraction = clampLibraryMood(mood) / LIBRARY_MOOD_MAX;
  return LIBRARY_MOOD_MIN_PATIENCE_MULTIPLIER + (1 - LIBRARY_MOOD_MIN_PATIENCE_MULTIPLIER) * fraction;
}

// ---------------------------------------------------------------------------
// 10. Player Sanity + Coffee Machine (doc's Scope/Business Rules addition
//     of the same name) — a shift-long *player* stat, distinct from
//     libraryMood (section 9) exactly the way Kitchen Shift keeps its own
//     Sanity (that game's rules.js section 9) separate from Reputation
//     (section 10): this drains passively every second of play and takes an
//     extra hit on every mistake, while libraryMood only ever moves on a
//     mistake. Ported from Kitchen Shift verbatim — same constants, same
//     shape, same "low sanity slows the player down, never anything
//     harsher" posture — since the doc asks for the identical mechanic, not
//     a reinvented one. The Coffee Machine restores it — since v2.2 by a
//     graded amount via the Coffee Pour minigame (section 11 below,
//     engine-state.js's brewCoffee), originally an instant full refill.
// ---------------------------------------------------------------------------

/** Sanity starts here every shift. */
export const SANITY_MAX = 100;

/** Passive drain per real second of the shift clock, whether or not anything goes wrong. */
export const SANITY_DRAIN_PER_SECOND = SANITY_MAX / 150;

/** Extra one-time drain on top of the passive rate for each mistake (a failed Shelf/Checkout Skill-Check, a failed Fines Sort, a borrow request that ran out of patience, or a mishandled Karen event). */
export const SANITY_DRAIN_PER_UPSET = 15;

/** Walking speed multiplier floor at 0 sanity — tired, not stuck. */
const SANITY_MIN_WALK_MULTIPLIER = 0.6;

/**
 * Clamps a proposed sanity value into `[0, SANITY_MAX]`.
 *
 * @param {number} sanity
 * @returns {number}
 */
export function clampSanity(sanity) {
  return clamp(Number.isFinite(sanity) ? sanity : 0, 0, SANITY_MAX);
}

/**
 * Walking speed multiplier for the player's current sanity: 1.0 at full
 * sanity, linearly down to `SANITY_MIN_WALK_MULTIPLIER` at 0 — tired legs,
 * not a hard stop. Mirrors Kitchen Shift's walkSpeedMultiplierForSanity
 * exactly.
 *
 * @param {number} sanity - 0..SANITY_MAX (out-of-range/non-finite clamped).
 * @returns {number}
 */
export function walkSpeedMultiplierForSanity(sanity) {
  const fraction = clampSanity(sanity) / SANITY_MAX;
  return SANITY_MIN_WALK_MULTIPLIER + (1 - SANITY_MIN_WALK_MULTIPLIER) * fraction;
}

// ---------------------------------------------------------------------------
// 11. Coffee Pour minigame (doc's v2.2 addition) — the Coffee Machine no
//     longer restores Sanity instantly: the player holds to pour coffee
//     into a cup and releases inside a target band. The result is graded,
//     and every grade still restores *some* Sanity (the user picked
//     "graded, never zero"), so a sloppy pour is a smaller reward, never a
//     punishment. Overfilling past the brim spills and ends the pour
//     automatically.
// ---------------------------------------------------------------------------

/** Seconds of holding it takes to fill the cup from empty (0) to the brim (1). */
export const COFFEE_POUR_SECONDS_TO_BRIM = 2.2;

/** Width of the target band, as a fraction of the cup's height. */
export const COFFEE_POUR_BAND_WIDTH = 0.12;

/** How far outside the band (either side) a release still counts as 'good'. */
export const COFFEE_POUR_GOOD_MARGIN = 0.1;

/** Gard tip for a perfect pour, added to the shift's bonusGard. */
export const COFFEE_PERFECT_TIP_GARD = 10;

/**
 * Sanity change per grade (added to current Sanity, clamped to
 * [0, SANITY_MAX]). v2.19: a spill now splashes hot coffee all over you
 * (user: "when it spills it spills onto you and drains 50 of your
 * sanity") — previously +40, the same as a sloppy pour.
 */
export const COFFEE_SANITY_RESTORE = {
  perfect: SANITY_MAX,
  good: 70,
  sloppy: 40,
  spilled: -50,
};

/**
 * The target band for one pour. `roll` in [0, 1) slides the band's center
 * between 62% and 86% full so it isn't the same line every visit.
 *
 * @param {number} roll
 * @returns {{low: number, high: number}}
 */
export function coffeePourTargetBand(roll) {
  const r = clamp(Number.isFinite(roll) ? roll : 0, 0, 1);
  const center = 0.62 + r * 0.24;
  return { low: center - COFFEE_POUR_BAND_WIDTH / 2, high: center + COFFEE_POUR_BAND_WIDTH / 2 };
}

/**
 * Grades a finished pour: 'spilled' at or past the brim, 'perfect' inside
 * the band, 'good' within COFFEE_POUR_GOOD_MARGIN of it, else 'sloppy'.
 *
 * @param {number} fill - 0 (empty) .. 1 (brim).
 * @param {{low: number, high: number}} band
 * @returns {'perfect' | 'good' | 'sloppy' | 'spilled'}
 */
export function gradeCoffeePour(fill, band) {
  const f = Number.isFinite(fill) ? fill : 0;
  if (f >= 1) return 'spilled';
  if (f >= band.low && f <= band.high) return 'perfect';
  if (f >= band.low - COFFEE_POUR_GOOD_MARGIN && f <= band.high + COFFEE_POUR_GOOD_MARGIN) return 'good';
  return 'sloppy';
}

// ---------------------------------------------------------------------------
// 12. Count the Till minigame (v2.4) — fine payments are collected at the
//     Fines Counter (Fines Sort) and carried to the Front Desk, where the
//     player counts the exact amount into the till by tapping coin/bill
//     denominations. Going over the amount is a miscount (a mistake; the
//     count resets and the player keeps carrying the payment to retry).
// ---------------------------------------------------------------------------

/** Coin/bill denominations offered in the till, in Gard. Every whole amount in [FINE_AMOUNT_MIN_GARD, FINE_AMOUNT_MAX_GARD] is reachable. */
export const TILL_DENOMINATIONS = [1, 5, 10, 20];

/**
 * Compares a running till count against the fine owed.
 *
 * @param {number} total
 * @param {number} target
 * @returns {'exact' | 'under' | 'over'}
 */
export function tillCountResult(total, target) {
  if (total === target) return 'exact';
  return total < target ? 'under' : 'over';
}

// ---------------------------------------------------------------------------
// 13. Star rating (v2.9) — "a rating bar when a costumer is left waiting
//     too long you lose 1 and half stars". Every queued patron (borrow or
//     fine) has a wait timer; one that runs out walks out, as does a borrow
//     patron whose search-phase patience runs out. Each walk-out costs
//     RATING_PENALTY_PER_WALKOUT stars. The shift's rating (starts at
//     RATING_MAX) scales the whole paycheck at payout. Separate from Library
//     Mood, which still tracks mistakes and scales patience.
// ---------------------------------------------------------------------------

/** Stars at the start of every shift. */
export const RATING_MAX = 5;

/** Stars lost each time a patron walks out after waiting too long. */
export const RATING_PENALTY_PER_WALKOUT = 1.5;

/**
 * Clamps a rating into `[0, RATING_MAX]`.
 *
 * @param {number} rating
 * @returns {number}
 */
export function clampRating(rating) {
  return clamp(Number.isFinite(rating) ? rating : 0, 0, RATING_MAX);
}

/**
 * The paycheck multiplier for a shift's final rating: rating ÷ RATING_MAX
 * (5★ = full pay, 3.5★ = 70%, 0★ = nothing).
 *
 * @param {number} rating
 * @returns {number}
 */
export function paycheckMultiplierForRating(rating) {
  return clampRating(rating) / RATING_MAX;
}

const QUEUE_WAIT_BASE_SECONDS = 90;
const QUEUE_WAIT_MIN_SECONDS = 45;
const QUEUE_WAIT_SHIFT_SATURATION = 10;

/**
 * Seconds a patron will wait *in line* (Front Desk borrow queue or Fines
 * Counter queue) before walking out — before anyone starts helping them.
 * Decreases with shift number, same shape as borrowPatienceSeconds;
 * engine-state.js also scales it by Library Mood at arrival.
 *
 * @param {number} shiftNumber
 * @returns {number}
 */
export function queueWaitSecondsForShift(shiftNumber) {
  const shift = clampShift(shiftNumber) - 1;
  const headroom = QUEUE_WAIT_BASE_SECONDS - QUEUE_WAIT_MIN_SECONDS;
  const ramp = 1 - Math.exp(-shift / QUEUE_WAIT_SHIFT_SATURATION);
  return clamp(QUEUE_WAIT_BASE_SECONDS - headroom * ramp, QUEUE_WAIT_MIN_SECONDS, QUEUE_WAIT_BASE_SECONDS);
}

// ---------------------------------------------------------------------------
// 14. Reading Nook (v2.10) — "a reading a book system to increase your
//     mood". Reading a short book (a page-turning minigame) at the 2nd
//     Floor's Reading Nook restores Library Mood, then the nook cools down.
//     The shift clock and patron timers keep running while you read, so
//     it's a trade-off against patrons waiting.
// ---------------------------------------------------------------------------

/** Library Mood restored by finishing a book (clamped to LIBRARY_MOOD_MAX). */
export const READING_MOOD_RESTORE = 20;

/** Seconds after a finished book before the nook can be used again. */
export const READING_COOLDOWN_SECONDS = 45;

/** Two-page spreads in one reading session (each story in stories.js has 2 × this many pages). */
export const READING_PAGES = 6;

/**
 * Minimum seconds on each spread before it can be turned. v2.11: the
 * pages hold real story text now, read at the player's own pace, so this
 * is only an anti-skip floor (was 1.4 s of auto-"reading" faux lines).
 */
export const READING_SECONDS_PER_PAGE = 2.5;

// ---------------------------------------------------------------------------
// 15. Hallucinations (v2.16) — "when sanity drops to 0 I want to have
//     hallucinations to scare the player and the work drops". They creep
//     in below HALLUCINATION_START_SANITY and are at full strength at 0.
//     Intensity (0..1) drives the scare visuals (library-game.js) and the
//     work penalties here: shaky hands (narrower, faster skill checks),
//     dropped books, ghost patrons that startle you, and a pay cut for
//     time spent at 0 Sanity. Coffee ends them by restoring Sanity.
// ---------------------------------------------------------------------------

/** Hallucinations begin below this much Sanity. */
export const HALLUCINATION_START_SANITY = 25;

/**
 * 0 at or above HALLUCINATION_START_SANITY, rising linearly to 1 at 0 Sanity.
 *
 * @param {number} sanity
 * @returns {number}
 */
export function hallucinationIntensity(sanity) {
  const s = clampSanity(sanity);
  if (s >= HALLUCINATION_START_SANITY) return 0;
  return (HALLUCINATION_START_SANITY - s) / HALLUCINATION_START_SANITY;
}

/** Shaky hands at full intensity: skill-check gold zone shrinks to this fraction... */
export const SHAKY_HANDS_MIN_ZONE_SCALE = 0.5;
/** ...and the marker sweeps this much faster. */
export const SHAKY_HANDS_MAX_SWEEP_MULTIPLIER = 1.6;

/** Skill-check zone width multiplier for a hallucination intensity (1 = normal). */
export function shakyHandsZoneScale(intensity) {
  const i = clamp(Number.isFinite(intensity) ? intensity : 0, 0, 1);
  return 1 - (1 - SHAKY_HANDS_MIN_ZONE_SCALE) * i;
}

/** Skill-check sweep-speed multiplier for a hallucination intensity (1 = normal). */
export function shakyHandsSweepMultiplier(intensity) {
  const i = clamp(Number.isFinite(intensity) ? intensity : 0, 0, 1);
  return 1 + (SHAKY_HANDS_MAX_SWEEP_MULTIPLIER - 1) * i;
}

/** Chance per second, at full intensity, that a carried book slips back onto the Return Cart. */
export const BOOK_DROP_CHANCE_PER_SECOND = 0.06;

/** Sanity lost when you walk up to a ghost patron and find no one there. */
export const HALLUCINATION_STARTLE_SANITY = 5;

/** Pay cut per full 10 seconds spent at 0 Sanity... */
export const ZERO_SANITY_PAY_CUT_PER_10S = 0.02;
/** ...capped at this much. */
export const ZERO_SANITY_PAY_CUT_MAX = 0.3;

/**
 * Paycheck multiplier for time spent at 0 Sanity this shift (1 = no cut).
 *
 * @param {number} zeroSanitySeconds
 * @returns {number}
 */
export function hallucinationPayMultiplier(zeroSanitySeconds) {
  const seconds = Number.isFinite(zeroSanitySeconds) && zeroSanitySeconds > 0 ? zeroSanitySeconds : 0;
  return 1 - Math.min(ZERO_SANITY_PAY_CUT_MAX, Math.floor(seconds / 10) * ZERO_SANITY_PAY_CUT_PER_10S);
}

// ---------------------------------------------------------------------------
// 16. Zero-Mood penalties (v2.17) — "add [a] penalty" for Library Mood at
//     0. While Mood sits at 0: the boss docks pay (like time at 0 Sanity),
//     the longest-waiting patron in line storms out every
//     ZERO_MOOD_STORM_OUT_SECONDS (a walk-out: −1.5★), and a complaint
//     letter costs COMPLAINT_GARD every COMPLAINT_INTERVAL_SECONDS.
// ---------------------------------------------------------------------------

/** Pay cut per full 10 s at 0 Mood, capped at ZERO_MOOD_PAY_CUT_MAX. */
export const ZERO_MOOD_PAY_CUT_PER_10S = 0.02;
export const ZERO_MOOD_PAY_CUT_MAX = 0.3;

/**
 * Paycheck multiplier for time spent at 0 Library Mood this shift (1 = no cut).
 *
 * @param {number} zeroMoodSeconds
 * @returns {number}
 */
export function moodPayMultiplier(zeroMoodSeconds) {
  const seconds = Number.isFinite(zeroMoodSeconds) && zeroMoodSeconds > 0 ? zeroMoodSeconds : 0;
  return 1 - Math.min(ZERO_MOOD_PAY_CUT_MAX, Math.floor(seconds / 10) * ZERO_MOOD_PAY_CUT_PER_10S);
}

/** At 0 Mood, a waiting patron storms out every this many seconds. */
export const ZERO_MOOD_STORM_OUT_SECONDS = 20;

/** At 0 Mood, a complaint letter arrives every this many seconds... */
export const COMPLAINT_INTERVAL_SECONDS = 30;
/** ...each costing this much Gard off the paycheck. */
export const COMPLAINT_GARD = 25;

// ---------------------------------------------------------------------------
// 17. Shelving incentives (v2.18) — "what happens when I leave the library
//     books" (answer: nothing, and shelving only risked a mistake). Now:
//     every shelved book earns a small tip, a cart piled past
//     MESSY_CART_THRESHOLD drains Library Mood while it stays messy, and
//     books still unshelved at closing are docked from the paycheck.
// ---------------------------------------------------------------------------

/** Gard tip for each book shelved (skill check or Coin Hunt). */
export const SHELVED_BOOK_TIP_GARD = 5;

/** Gard docked at payout for each book left unshelved at closing (on the cart or still in hand). */
export const UNSHELVED_BOOK_PENALTY_GARD = 10;

/** More books than this on the Return Cart counts as a messy library... */
export const MESSY_CART_THRESHOLD = 8;
/** ...draining this much Library Mood per second while it stays that way. */
export const MESSY_CART_MOOD_DRAIN_PER_SECOND = 0.25;
