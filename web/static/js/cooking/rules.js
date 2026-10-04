// Pure, canvas-independent game-logic functions for Kitchen Shift
// (docs/features/cooking-game.md's Business Rules / Validation).
//
// This module has NO DOM/canvas/localStorage/timer dependencies on purpose,
// so it can be unit-tested with `node --test` and imported unchanged by the
// canvas game loop (cooking-game.js). All numeric constants below are
// illustrative/tunable per the feature doc ("tune during build") — what is
// NOT optional is the *shape* of each rule: the paycheck's binary
// upset/no-upset outcome, the "bands grow, never shrink" recipe unlock
// shape, and the ramp directions described in the doc.

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

/**
 * Shifts per month. v3.14: raised from 20 to 30 (doc: "30 shifts = one
 * month, in three 10-shift round tiers") so the month divides evenly into
 * the three round tiers below (section 11) — 30 was already this game's
 * physical table count, so a "max of 30" now describes both dimensions.
 */
export const SHIFTS_PER_MONTH = 30;

/** A clean shift's Gard payout, before any per-mistake penalty (doc's Shift paycheck rule). */
export const SHIFT_PAYCHECK_FULL = 4000;

/**
 * v3.11: Gard deducted per mistake (a missed order or a wrong-dish serve),
 * replacing the old flat "4,000 unless anything went wrong, then 2,000"
 * split — see rules.js's shiftPaycheck() and the food-server rules doc.
 */
export const SHIFT_PAYCHECK_PENALTY_PER_MISTAKE = 500;

/** The floor a shift's payout can never drop below, regardless of mistake count — this game never pays 0 for a completed shift. */
export const SHIFT_PAYCHECK_MIN = 500;

/**
 * Physical tables on the floor plan — the hard cap on simultaneous orders
 * regardless of gear. 30, not 4 — the user asked for a much bigger dining
 * room once the game moved to a bigger, click-driven floor plan; see
 * floor-plan.js's 6x5 table grid.
 */
export const PHYSICAL_TABLE_COUNT = 30;

/**
 * Legacy fixed per-shift countdown, in seconds — no longer what an actual
 * shift runs on (see `shiftClockSecondsForShift`, section 11: the
 * countdown now varies by round tier, 300/180/120s). Kept only as
 * `createInitialState`'s pre-override default and `inGameTimeLabel`'s
 * default `totalClockSeconds` denominator, so call sites that don't pass
 * either explicitly (tests, the one-time intro scene) still get a sane,
 * stable value.
 */
export const SHIFT_CLOCK_SECONDS = 90;

/** Startime Diner's shift hours, in minutes since midnight: 8:30 AM to 11:30 PM. */
export const SHIFT_START_MINUTES = 8 * 60 + 30;
export const SHIFT_END_MINUTES = 23 * 60 + 30;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clampShift(shiftNumber) {
  const shift = Number.isFinite(shiftNumber) ? Math.floor(shiftNumber) : 1;
  return clamp(shift, 1, SHIFTS_PER_MONTH);
}

// ---------------------------------------------------------------------------
// 1. Recipes, gated by shift band
// ---------------------------------------------------------------------------

/**
 * The shift-band / recipe table from the doc's Business Rules section.
 * `cookware` is `null` for the one station-less dish (Garden Salad — no
 * cooking step, see Business Rules) and otherwise names the single
 * COOKWARE_ITEMS entry that dish's station requires — Pan for every Stove
 * dish, Baking Tray for every Oven dish, Rice Cooker for every Rice
 * Station dish (the Rice Station is a Kitchen countertop the Rice Cooker
 * plugs into — same station+cookware shape as Stove+Pan/Oven+Tray).
 */
export const RECIPE_BANDS = [
  { minShift: 1, dishes: [
    { name: 'Garden Salad', station: 'none', cookware: null, ingredients: ['Lettuce', 'Tomato'] },
    { name: 'Grilled Cheese', station: 'stove', cookware: 'Pan', ingredients: ['Bread', 'Cheese'] },
  ] },
  { minShift: 6, dishes: [
    { name: 'Burger', station: 'stove', cookware: 'Pan', ingredients: ['Buns', 'Patty', 'Lettuce'] },
    { name: 'Pancakes', station: 'stove', cookware: 'Pan', ingredients: ['Flour', 'Egg', 'Milk'] },
  ] },
  { minShift: 11, dishes: [
    { name: 'Roast Chicken', station: 'oven', cookware: 'Baking Tray', ingredients: ['Chicken', 'Herbs'] },
    { name: 'Pasta', station: 'stove', cookware: 'Pan', ingredients: ['Noodles', 'Sauce'] },
    { name: 'Chicken Rice', station: 'rice-station', cookware: 'Rice Cooker', ingredients: ['Rice', 'Chicken', 'Herbs'] },
  ] },
  { minShift: 16, dishes: [
    { name: 'Steak Dinner', station: 'stove', cookware: 'Pan', ingredients: ['Steak', 'Potato', 'Herbs'] },
    { name: 'Soufflé', station: 'oven', cookware: 'Baking Tray', ingredients: ['Egg', 'Cheese', 'Flour'] },
    { name: 'Omurice', station: 'rice-station', cookware: 'Rice Cooker', ingredients: ['Rice', 'Egg', 'Sauce'] },
  ] },
];

/**
 * Every ingredient name available at the Fridge (cold storage). Lemonade
 * and Matcha are cold drinks living here — Lemonade is only ever needed by
 * Mel's Usual, Matcha only by Olive & Oliver's Order (both below), never
 * by any RECIPE_BANDS dish.
 */
export const FRIDGE_INGREDIENTS = ['Cheese', 'Milk', 'Chicken', 'Patty', 'Steak', 'Lettuce', 'Tomato', 'Egg', 'Lemonade', 'Matcha'];

/**
 * Every ingredient name available at the Cabinet (dry storage). Star Cake
 * and Cake are pre-made bakery items (no cooking step) — Star Cake is
 * Mel's-Usual-only, plain Cake is Olive & Oliver's-Order-only, same
 * scoping as Lemonade/Matcha above.
 */
export const CABINET_INGREDIENTS = ['Bread', 'Flour', 'Noodles', 'Herbs', 'Buns', 'Sauce', 'Potato', 'Rice', 'Star Cake', 'Cake'];

/**
 * Every cookware item available at the Cookware Closet. Acquiring one is a
 * one-time pickup per shift, not consumed on use (rules.js has no
 * "cookware inventory" concept of its own — cooking-game.js tracks which
 * pieces the player has acquired this shift as a plain Set).
 */
export const COOKWARE_ITEMS = ['Pan', 'Baking Tray', 'Rice Cooker'];

/**
 * Dishes a customer may order at `shiftNumber`. Bands only ever accumulate
 * (a later band's dishes join the pool; earlier ones never drop out) —
 * matching the Fishing Game's fish-band gating shape.
 *
 * @param {number} shiftNumber - 1-20 (out-of-range/non-finite clamps into that range).
 * @returns {{name: string, station: string, ingredients: string[]}[]}
 */
export function availableDishes(shiftNumber) {
  const shift = clampShift(shiftNumber);
  return RECIPE_BANDS
    .filter((band) => band.minShift <= shift)
    .flatMap((band) => band.dishes);
}

/**
 * Looks up a dish's station/ingredients by name, regardless of shift band.
 *
 * @param {string} name
 * @returns {{name: string, station: string, ingredients: string[]} | null}
 */
export function findDish(name) {
  if (name === MEL_DISH.name) return MEL_DISH;
  if (name === COUPLE_DISH.name) return COUPLE_DISH;
  for (const band of RECIPE_BANDS) {
    const dish = band.dishes.find((d) => d.name === name);
    if (dish) return dish;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 2. Cook-timing success zone (binary, no quality tiers — see the doc's
//    "Cook-timing is a binary success zone" rule)
// ---------------------------------------------------------------------------

const COOK_ZONE_BASE_WIDTH = 0.16;
const COOK_ZONE_WIDTH_PER_SHARP_KNIFE_LEVEL = 0.03;
const COOK_ZONE_MAX_WIDTH = 0.4;

/**
 * The sweeping gauge's success window, centered at 0.5 on a 0..1 sweep.
 * Sharp Knife gear widens it per level, capped so it can never swallow the
 * whole sweep.
 *
 * @param {number} sharpKnifeLevel - gear level (negative/non-finite treated as 0).
 * @returns {{start: number, end: number, width: number}}
 */
export function cookSuccessZone(sharpKnifeLevel) {
  const level = Number.isFinite(sharpKnifeLevel) && sharpKnifeLevel > 0 ? sharpKnifeLevel : 0;
  const width = Math.min(
    COOK_ZONE_MAX_WIDTH,
    COOK_ZONE_BASE_WIDTH + level * COOK_ZONE_WIDTH_PER_SHARP_KNIFE_LEVEL,
  );
  return { start: 0.5 - width / 2, end: 0.5 + width / 2, width };
}

/**
 * Whether a sweep sample lands inside the success zone.
 *
 * @param {number} gaugePosition - 0..1 sweep position at the moment of interaction.
 * @param {{start: number, end: number}} zone - as returned by cookSuccessZone.
 * @returns {boolean}
 */
export function isCookSuccess(gaugePosition, zone) {
  return Number.isFinite(gaugePosition) && gaugePosition >= zone.start && gaugePosition <= zone.end;
}

const COOK_SWEEP_SPEED_BASE = 0.6;
const COOK_SWEEP_SPEED_MAX = 1.6;
const COOK_SWEEP_SHIFT_SATURATION = 12;

/**
 * How fast the cook-timing gauge sweeps (fraction of the 0..1 range per
 * second), ramping up with shift number — the cooking-side equivalent of
 * the Fishing Game's descentSpeed ramping with depth. Approaches
 * COOK_SWEEP_SPEED_MAX asymptotically, never reaching or exceeding it.
 *
 * @param {number} shiftNumber - 1-20.
 * @returns {number}
 */
export function cookSweepSpeed(shiftNumber) {
  const shift = clampShift(shiftNumber) - 1;
  const headroom = COOK_SWEEP_SPEED_MAX - COOK_SWEEP_SPEED_BASE;
  const ramp = 1 - Math.exp(-shift / COOK_SWEEP_SHIFT_SATURATION);
  return clamp(COOK_SWEEP_SPEED_BASE + headroom * ramp, COOK_SWEEP_SPEED_BASE, COOK_SWEEP_SPEED_MAX);
}

// ---------------------------------------------------------------------------
// 3. Shift-to-shift ramp: customer arrival rate and patience
// ---------------------------------------------------------------------------

const ARRIVAL_INTERVAL_BASE_SECONDS = 14;
const ARRIVAL_INTERVAL_MIN_SECONDS = 5;
const ARRIVAL_SHIFT_SATURATION = 10;

/**
 * Average seconds between new customers seating themselves, decreasing
 * (busier) as shift number increases. Approaches, but never goes below,
 * ARRIVAL_INTERVAL_MIN_SECONDS.
 *
 * @param {number} shiftNumber - 1-20.
 * @returns {number}
 */
export function customerArrivalIntervalSeconds(shiftNumber) {
  const shift = clampShift(shiftNumber) - 1;
  const headroom = ARRIVAL_INTERVAL_BASE_SECONDS - ARRIVAL_INTERVAL_MIN_SECONDS;
  const ramp = 1 - Math.exp(-shift / ARRIVAL_SHIFT_SATURATION);
  return clamp(
    ARRIVAL_INTERVAL_BASE_SECONDS - headroom * ramp,
    ARRIVAL_INTERVAL_MIN_SECONDS,
    ARRIVAL_INTERVAL_BASE_SECONDS,
  );
}

/**
 * v3.34: "enhance randomization of the customers... make it random so it
 * makes the game mechanics better" — before this, `customerArrivalIntervalSeconds`'s
 * output was consumed as an exact, unvarying wait every single time
 * (`cooking-game.js`'s `maybeSpawnCustomer`), so a given shift always sat
 * customers on a perfectly metronomic beat — the same rhythm every replay
 * of that shift. This widens that single average value into a
 * multiplicative range around it, so consecutive arrivals land in bursts
 * and lulls instead, the way real seating actually happens — without
 * changing the *average* pace a shift ramps toward (this doc comment
 * already called the base value an "average," which this finally makes
 * literally true).
 */
export const ARRIVAL_INTERVAL_JITTER_MIN = 0.6;
export const ARRIVAL_INTERVAL_JITTER_MAX = 1.4;

/**
 * Applies that jitter to one `customerArrivalIntervalSeconds` output.
 * Multiplicative, not additive, so the jitter's absolute size shrinks
 * alongside the shrinking base interval at later, busier shifts, rather
 * than staying a fixed number of seconds that would swamp an already-
 * short late-shift interval. This file has no RNG of its own (every other
 * formula here is a pure function of its inputs, same convention) — the
 * caller draws `randomRoll` from `[0, 1)` itself (cooking-game.js's
 * `random()` alias) and passes it in.
 *
 * @param {number} baseIntervalSeconds - customerArrivalIntervalSeconds's output.
 * @param {number} randomRoll - in [0, 1); out-of-range or non-finite is clamped/defaulted to the midpoint.
 * @returns {number}
 */
export function jitteredArrivalIntervalSeconds(baseIntervalSeconds, randomRoll) {
  const roll = Number.isFinite(randomRoll) ? Math.min(1, Math.max(0, randomRoll)) : 0.5;
  const factor = ARRIVAL_INTERVAL_JITTER_MIN + roll * (ARRIVAL_INTERVAL_JITTER_MAX - ARRIVAL_INTERVAL_JITTER_MIN);
  return Math.max(0, baseIntervalSeconds) * factor;
}

const PATIENCE_BASE_SECONDS = 45;
const PATIENCE_MIN_SECONDS = 20;
const PATIENCE_SHIFT_SATURATION = 10;
const PATIENCE_SECONDS_PER_REGULARS_PATIENCE_LEVEL = 4;

/**
 * Seconds a seated customer waits before leaving upset, decreasing with
 * shift number (shorter fuse in later, busier shifts) but increased per
 * level of the Regular's Patience gear upgrade.
 *
 * @param {number} shiftNumber - 1-20.
 * @param {number} regularsPatienceLevel - gear level (negative/non-finite treated as 0).
 * @returns {number}
 */
export function customerPatienceSeconds(shiftNumber, regularsPatienceLevel) {
  const shift = clampShift(shiftNumber) - 1;
  const headroom = PATIENCE_BASE_SECONDS - PATIENCE_MIN_SECONDS;
  const ramp = 1 - Math.exp(-shift / PATIENCE_SHIFT_SATURATION);
  const base = clamp(PATIENCE_BASE_SECONDS - headroom * ramp, PATIENCE_MIN_SECONDS, PATIENCE_BASE_SECONDS);

  const level = Number.isFinite(regularsPatienceLevel) && regularsPatienceLevel > 0 ? regularsPatienceLevel : 0;
  return base + level * PATIENCE_SECONDS_PER_REGULARS_PATIENCE_LEVEL;
}

/** Extra Table Service adds this many active tables per level. */
const TABLE_CAPACITY_PER_EXTRA_TABLE_SERVICE_LEVEL = 3;

/**
 * Simultaneous active tables/orders allowed: a round-tier-derived base
 * (see roundTier/baseCapacityForShift, section 11 below) plus Extra Table
 * Service gear on top, capped by however many tables are actually
 * unlocked this tier (not the full physical 30) — gear bought ahead of
 * the next tier doesn't raise capacity past what the dining room can
 * currently hold; it just takes effect the moment more tables open.
 *
 * @param {number} shiftNumber - 1..SHIFTS_PER_MONTH, the shift currently being played.
 * @param {number} extraTableServiceLevel - gear level (negative/non-finite treated as 0).
 * @returns {number}
 */
export function tableCapacity(shiftNumber, extraTableServiceLevel) {
  const base = baseCapacityForShift(shiftNumber);
  const gearLevel = Number.isFinite(extraTableServiceLevel) && extraTableServiceLevel > 0 ? extraTableServiceLevel : 0;
  return Math.min(unlockedTableCountForShift(shiftNumber), base + gearLevel * TABLE_CAPACITY_PER_EXTRA_TABLE_SERVICE_LEVEL);
}

// ---------------------------------------------------------------------------
// 4. Shift paycheck (final, not illustrative — the doc's headline rule)
// ---------------------------------------------------------------------------

/**
 * A shift's Gard payout: SHIFT_PAYCHECK_FULL minus
 * SHIFT_PAYCHECK_PENALTY_PER_MISTAKE for every mistake that shift (a missed
 * order or a wrong-dish serve — `ShiftState.mistakeCount`, engine-state.js),
 * floored at SHIFT_PAYCHECK_MIN so a shift always pays *something*,
 * matching this game's "never a hard game-over" design. v3.11: replaces the
 * old flat "4,000 unless `shiftUpset`, then 2,000" split — every mistake
 * now visibly costs Gard instead of one mistake costing exactly as much as
 * five. See the food-server rules doc for the full rationale.
 *
 * @param {number} mistakeCount - 0 or more (negative/non-finite treated as 0).
 * @returns {number}
 */
export function shiftPaycheck(mistakeCount) {
  const mistakes = Number.isFinite(mistakeCount) && mistakeCount > 0 ? mistakeCount : 0;
  return Math.max(SHIFT_PAYCHECK_MIN, SHIFT_PAYCHECK_FULL - mistakes * SHIFT_PAYCHECK_PENALTY_PER_MISTAKE);
}

/**
 * Sums a month's worth of per-shift paychecks into the month total.
 *
 * @param {number[]} shiftPaychecks
 * @returns {number}
 */
export function monthTotal(shiftPaychecks) {
  return Array.isArray(shiftPaychecks) ? shiftPaychecks.reduce((sum, p) => sum + (Number.isFinite(p) ? p : 0), 0) : 0;
}

/**
 * v3.28: Gard credited immediately to `save.monthToDateGard` when a served
 * customer's counter-payment animation completes (cooking-game.js's
 * `payingCustomers`), on top of — not instead of — the unchanged
 * `shiftPaycheck()` lump sum paid once at shift end. Deliberately modest
 * relative to that 4,000/500 range so a shift's earnings are still
 * dominated by the end-of-shift mistake-free/mistake-penalized payout;
 * this only adds a small, immediate, per-customer sense of progress toward
 * shop upgrades (`GEAR_DEFS`, whose costs start around 200-400 Gard).
 */
export const COUNTER_PAYMENT_GARD = 50;

// ---------------------------------------------------------------------------
// 5. The Karen event — a scripted customer on two shifts, not part of the
//    normal random arrival pool. Shift 12 is the original encounter;
//    shift 18 is a rematch: she remembers you, has an even shorter fuse,
//    and tips more if you get her order right in time.
// ---------------------------------------------------------------------------

/** The shifts Karen shows up on — her first visit, then the rematch. */
export const KAREN_SHIFT_NUMBERS = [12, 18];

/** Her first visit's shift, kept as its own name for callers/tests that mean "the original encounter". */
export const KAREN_SHIFT_NUMBER = KAREN_SHIFT_NUMBERS[0];

/** Her opening line on her first visit, shown the moment she's seated. */
export const KAREN_LINE = 'HEY YOU THERE COME OVER HERE';

/** Her rematch opening line — she remembers shift 12. */
export const KAREN_REMATCH_LINE = 'YOU AGAIN?! I remember you. Do NOT mess this up this time.';

/**
 * Karen's patience on her first visit — much shorter than a normal
 * customer's at the same shift (`customerPatienceSeconds`).
 */
export const KAREN_PATIENCE_SECONDS = 12;

/** The rematch's patience — angrier, so shorter still. */
export const KAREN_REMATCH_PATIENCE_SECONDS = 9;

/** Gard Karen tips on a correct serve (paid on top of the normal Counter payment). */
export const KAREN_TIP_GARD = 100;

/** The rematch's bigger tip — handling her a second time is worth more. */
export const KAREN_REMATCH_TIP_GARD = 250;

/**
 * Whether this shift is one of Karen's shifts.
 *
 * @param {number} shiftNumber
 * @returns {boolean}
 */
export function isKarenShift(shiftNumber) {
  return KAREN_SHIFT_NUMBERS.includes(clampShift(shiftNumber));
}

/**
 * Karen's encounter parameters for `shiftNumber`, or `null` when she isn't
 * due. `rematch` is true on every visit after her first.
 *
 * @param {number} shiftNumber
 * @returns {{rematch: boolean, line: string, patienceSeconds: number, tipGard: number} | null}
 */
export function karenEncounter(shiftNumber) {
  const index = KAREN_SHIFT_NUMBERS.indexOf(clampShift(shiftNumber));
  if (index === -1) return null;
  const rematch = index > 0;
  return {
    rematch,
    line: rematch ? KAREN_REMATCH_LINE : KAREN_LINE,
    patienceSeconds: rematch ? KAREN_REMATCH_PATIENCE_SECONDS : KAREN_PATIENCE_SECONDS,
    tipGard: rematch ? KAREN_REMATCH_TIP_GARD : KAREN_TIP_GARD,
  };
}

// ---------------------------------------------------------------------------
// 6. Mel — a recurring regular, the opposite of Karen: sweet, kind, and
//    caring, and always the very first customer seated every single
//    shift (not a random-chance appearance — the user described her as
//    "always come[s] here"). Favorite color yellow, favorite flower
//    dandelion — both show up as her look (cooking-game.js's rendering),
//    not gameplay math.
// ---------------------------------------------------------------------------

/**
 * Mel's usual order, every time — not part of RECIPE_BANDS/availableDishes,
 * so no random customer ever orders it; only Mel does (cooking-game.js
 * hardcodes it when spawning her). `station: 'none'` — it's assembled
 * straight from the Fridge/Cabinet, no cooking step, since it's a
 * ready-to-serve favorite, not something cooked to order.
 */
export const MEL_DISH = { name: "Mel's Usual", station: 'none', cookware: null, ingredients: ['Lemonade', 'Star Cake', 'Egg'] };

/** Shown the moment Mel is served correctly. */
export const MEL_THANK_YOU_LINE = 'Thank you so much — you always make my day!';

/**
 * How much extra patience Mel has on top of a normal customer's, at the
 * same shift — she's kind and understanding, never in a rush, the
 * opposite of Karen's shortened fuse.
 */
export const MEL_PATIENCE_BONUS_SECONDS = 15;

/** Mel's favorite color — her sprite's marker color (cooking-game.js). */
export const MEL_FAVORITE_COLOR = '#ffd23f';

// ---------------------------------------------------------------------------
// 7. Olive & Oliver — an engaged couple, recurring regulars who always
//    arrive together (one table, two people) right after Mel every
//    shift. Olive: brave, smart, neat, favorite color green, favorite
//    flower tulips. Oliver: intelligent, brave, favorite color blue,
//    favorite flower rose — his usual order is the same as his fiancée's.
//    Both favorite-flower details are cosmetic only (no gameplay math
//    hangs off them, same as Mel's dandelion) — cooking-game.js's
//    rendering is where they'd show up if ever illustrated.
// ---------------------------------------------------------------------------

/**
 * Their shared usual order — matcha and cake, ordered together as a
 * single table order (they're a couple sharing one table, not two
 * separate orders). Not part of RECIPE_BANDS/availableDishes, same
 * "only this couple orders it" scoping as MEL_DISH. `station: 'none'` —
 * assembled, not cooked, same reasoning as Mel's Usual.
 */
export const COUPLE_DISH = { name: "Olive & Oliver's Order", station: 'none', cookware: null, ingredients: ['Matcha', 'Cake'] };

/** Olive's favorite color. */
export const OLIVE_FAVORITE_COLOR = '#5a9b5a';

/** Oliver's favorite color. */
export const OLIVER_FAVORITE_COLOR = '#4a7fc9';

// ---------------------------------------------------------------------------
// 8. In-game clock display — Startime Diner's shift runs 8:30 AM to
//    11:30 PM (SHIFT_START_MINUTES/SHIFT_END_MINUTES). The HUD shows this
//    restaurant time-of-day instead of a countdown, mapped linearly onto
//    the same real-time SHIFT_CLOCK_SECONDS countdown every other
//    shift-timing function already uses — so "half the shift clock left"
//    always means "3:30 PM," not two numbers that could drift apart.
// ---------------------------------------------------------------------------

/**
 * Formats the current in-game restaurant time from how many real seconds
 * are left on the shift clock.
 *
 * @param {number} clockSecondsRemaining - as tracked by engine-state.js's
 *   `ShiftState.clockSeconds` (negative/non-finite treated as
 *   `totalClockSeconds`, i.e. "shift just started").
 * @param {number} [totalClockSeconds] - the shift's full countdown length
 *   (v3.14: `shiftClockSecondsForShift(shiftNumber)` now varies by round
 *   tier instead of a single fixed value) — defaults to the legacy
 *   SHIFT_CLOCK_SECONDS for callers that don't track it explicitly.
 * @returns {string} e.g. "8:30 AM", "3:30 PM", "11:30 PM".
 */
export function inGameTimeLabel(clockSecondsRemaining, totalClockSeconds = SHIFT_CLOCK_SECONDS) {
  const total = Number.isFinite(totalClockSeconds) && totalClockSeconds > 0 ? totalClockSeconds : SHIFT_CLOCK_SECONDS;
  const remaining = Number.isFinite(clockSecondsRemaining)
    ? clamp(clockSecondsRemaining, 0, total)
    : total;
  const elapsedFraction = 1 - remaining / total;
  const totalMinutes = Math.round(
    SHIFT_START_MINUTES + elapsedFraction * (SHIFT_END_MINUTES - SHIFT_START_MINUTES),
  );

  const hour24 = Math.floor(totalMinutes / 60) % 24;
  const minute = totalMinutes % 60;
  const period = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;

  return `${hour12}:${String(minute).padStart(2, '0')} ${period}`;
}

// ---------------------------------------------------------------------------
// 9. Sanity and the Coffee Machine — a shift-long stat that passively drains
//    and takes a bigger hit on every upset (a missed order or a wrong-dish
//    serve), representing the stress of a bad shift. Low sanity slows the
//    player down, never anything harsher — matching this game's existing
//    lower-stakes design (Business Rules: "the tension is finishing the
//    shift clean, not avoiding a game-over state"). A Coffee Machine station
//    restores it to full on the spot.
// ---------------------------------------------------------------------------

/** Sanity starts here every shift. */
export const SANITY_MAX = 100;

/** Passive drain per real second of the shift clock, whether or not anything goes wrong. */
export const SANITY_DRAIN_PER_SECOND = SANITY_MAX / 150;

/** Extra one-time drain on top of the passive rate for each upset event (missed order or wrong-dish serve). */
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
 * sanity, linearly down to `SANITY_MIN_WALK_MULTIPLIER` at 0 — tired
 * legs, not a hard stop. Multiplies whatever `walkSpeedForSave` (gear)
 * already computes; the two effects stack rather than one overriding the
 * other.
 *
 * @param {number} sanity - 0..SANITY_MAX (out-of-range/non-finite clamped).
 * @returns {number}
 */
export function walkSpeedMultiplierForSanity(sanity) {
  const fraction = clampSanity(sanity) / SANITY_MAX;
  return SANITY_MIN_WALK_MULTIPLIER + (1 - SANITY_MIN_WALK_MULTIPLIER) * fraction;
}

// ---------------------------------------------------------------------------
// 10. Restaurant reputation (v3.11) — a shift-long stat, same shape as
//     Sanity above but tracking the *restaurant's* mood rather than the
//     player's: it only moves on mistakes (a missed order or a wrong-dish
//     serve), never passively. The user asked for a wrong-dish serve to
//     make "customer[s] irritated" and raise "the ch[a]nce of leaving...
//     with bad review" — but a single customer only ever gets one order
//     (no do-over to escalate on), so there's no per-customer state to
//     track. This models it at the restaurant level instead: every mistake
//     drains reputation, and every *later* customer that shift (not just
//     the one who got the wrong dish) gets shorter patience as a result —
//     a bad review from one table sours the mood for whoever walks in
//     next, functioning as an increasing chance of losing them before they
//     even order. See the customer rules doc for the full rationale.
// ---------------------------------------------------------------------------

/** Reputation starts here every shift — a clean shift never touches it. */
export const REPUTATION_MAX = 100;

/** Reputation lost per mistake (missed order or wrong-dish serve) — four mistakes bottoms it out. */
export const REPUTATION_DRAIN_PER_MISTAKE = 25;

/** Patience multiplier floor at 0 reputation — shorter-fused, not instant walkouts. */
const REPUTATION_MIN_PATIENCE_MULTIPLIER = 0.6;

/**
 * Clamps a proposed reputation value into `[0, REPUTATION_MAX]`.
 *
 * @param {number} reputation
 * @returns {number}
 */
export function clampReputation(reputation) {
  return clamp(Number.isFinite(reputation) ? reputation : 0, 0, REPUTATION_MAX);
}

/**
 * Customer patience multiplier for the restaurant's current reputation:
 * 1.0 at full reputation, linearly down to
 * `REPUTATION_MIN_PATIENCE_MULTIPLIER` at 0. Applied once, at the moment an
 * order is taken (`customerPatienceSeconds(...) * this`) — an order's
 * patience budget is fixed for its lifetime, same as how Karen/Mel's
 * patience adjustments already work; it doesn't keep shrinking after the
 * fact if reputation drops further mid-order.
 *
 * @param {number} reputation - 0..REPUTATION_MAX (out-of-range/non-finite clamped).
 * @returns {number}
 */
export function patienceMultiplierForReputation(reputation) {
  const fraction = clampReputation(reputation) / REPUTATION_MAX;
  return REPUTATION_MIN_PATIENCE_MULTIPLIER + (1 - REPUTATION_MIN_PATIENCE_MULTIPLIER) * fraction;
}

// ---------------------------------------------------------------------------
// 10.5. Customer sanity (v3.18) — a per-order stat, distinct from both the
//      player's own Sanity (9) and the restaurant's Reputation (10). The
//      user asked for repeatedly "annoying" a single customer — the food
//      server re-visiting their table before serving them, or serving the
//      wrong dish — to have its own escalating consequence: after enough
//      annoyances, THAT customer walks out, same as a patience timeout.
//      Where Reputation models the *restaurant's* mood across customers,
//      this models one customer's patience for being asked to repeat
//      themselves — the "do-over to escalate on" that section 10's comment
//      notes doesn't exist at the restaurant level.
// ---------------------------------------------------------------------------

/** A fresh order's customer-sanity starts here — same 0..100 scale as the player's own Sanity/Reputation stats. */
export const CUSTOMER_SANITY_MAX = 100;

/**
 * Customer sanity lost per "annoyance" — the food server re-visiting an
 * already-ordered table before serving it, or serving the wrong dish.
 * Same 25-point/4-hits-to-bottom-out shape as REPUTATION_DRAIN_PER_MISTAKE,
 * deliberately: asking a customer to repeat themselves a few times is
 * tolerable, but by the 4th time they've had enough and walk out.
 */
export const CUSTOMER_SANITY_DRAIN_PER_ANNOYANCE = 25;

/**
 * Clamps a proposed customer-sanity value into `[0, CUSTOMER_SANITY_MAX]`.
 *
 * @param {number} customerSanity
 * @returns {number}
 */
export function clampCustomerSanity(customerSanity) {
  return clamp(Number.isFinite(customerSanity) ? customerSanity : 0, 0, CUSTOMER_SANITY_MAX);
}

// ---------------------------------------------------------------------------
// 11. Round tiers (v3.14) — SUPERSEDES the earlier v3.13 "food server
//     leveling" design (lifetime-shifts-completed based). The user asked
//     instead for each *round* (shift) to carry its own time limit, in
//     three progressively harder ten-shift bands across the now-30-shift
//     month — "level 1-10... 5 min... a few tables... level 10, 20, 30
//     becomes harder and more tables are introduced... a max of 30
//     tables." Driven directly by the CURRENT shift number, not a
//     persisted lifetime stat — so, unlike v3.13, this resets every month
//     along with `currentShift`: every fresh month starts back at Tier 1's
//     small, slow-paced dining room and builds up to the full, fast-paced
//     30-table floor by the final band, same shape every month rather than
//     a one-time unlock a veteran player would only ever see once.
//
//     Table-unlock geometry is unchanged from v3.13 — floor-plan.js's
//     `isTableUnlocked`/`unlockedStations` still take a 1-5 "row level"
//     (entrance-nearest row first, one row per level). Tier 1/2/3 map onto
//     row levels 1/3/5 (6/18/30 tables) so all three tiers land on clean
//     row boundaries without floor-plan.js needing any changes of its own.
//     Base simultaneous-order capacity scales the same way (1/3/5 orders,
//     before Extra Table Service gear adds more) — "a few tables" at Tier
//     1 is literally one order at a time, same deliberate choice v3.13
//     made and the user never asked to soften.
// ---------------------------------------------------------------------------

/** Three difficulty bands per month — the user's own "level 10, 20, 30" framing. */
export const ROUND_TIER_COUNT = 3;

/** Shifts per tier (30 shifts / 3 tiers). */
export const ROUND_TIER_SHIFT_SPAN = 10;

/**
 * Each tier's real-time shift-clock budget, in seconds — index 0 is Tier
 * 1's (the user's own "5mins" example), shrinking from there as more
 * tables come online, so a busier floor also means less time to run it.
 */
export const ROUND_TIER_CLOCK_SECONDS = [300, 180, 120];

/**
 * Each tier's floor-plan "row level" (floor-plan.js's `isTableUnlocked`
 * 1-5 scale) — 1/3/5, landing exactly on 6/18/30 open tables.
 */
export const ROUND_TIER_FLOOR_LEVEL = [1, 3, 5];

/** Tables unlocked per floor-plan level (floor-plan.js's `unlockedTableCount`/`TABLE_GRID_SHAPES`) — exported so callers never re-hardcode 6. */
export const TABLES_PER_FLOOR_LEVEL = 6;

function clampTier(tier) {
  const value = Number.isFinite(tier) ? Math.floor(tier) : 1;
  return clamp(value, 1, ROUND_TIER_COUNT);
}

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
 * A tier as filled/unfilled stars (Startime Diner's own star branding),
 * always ROUND_TIER_COUNT characters long — e.g. "★★☆" at tier 2.
 *
 * @param {number} tier - clamped into [1, ROUND_TIER_COUNT] (non-finite treated as 1).
 * @returns {string}
 */
export function roundTierStars(tier) {
  const value = clampTier(tier);
  return '★'.repeat(value) + '☆'.repeat(ROUND_TIER_COUNT - value);
}

/**
 * The shift-clock countdown, in seconds, for whichever tier `shiftNumber`
 * falls in — passed as `createInitialState`'s `clockSeconds` override and
 * as `inGameTimeLabel`'s `totalClockSeconds`.
 *
 * @param {number} shiftNumber - 1..SHIFTS_PER_MONTH (out-of-range/non-finite clamped).
 * @returns {number}
 */
export function shiftClockSecondsForShift(shiftNumber) {
  return ROUND_TIER_CLOCK_SECONDS[roundTier(shiftNumber) - 1];
}

/**
 * The floor-plan row level unlocked at `shiftNumber` — feed directly into
 * floor-plan.js's `isTableUnlocked`/`unlockedStations`.
 *
 * @param {number} shiftNumber - 1..SHIFTS_PER_MONTH (out-of-range/non-finite clamped).
 * @returns {number} 1..5.
 */
export function tableUnlockLevelForShift(shiftNumber) {
  return ROUND_TIER_FLOOR_LEVEL[roundTier(shiftNumber) - 1];
}

/**
 * How many of the dining room's 30 tables are open at `shiftNumber`.
 *
 * @param {number} shiftNumber - 1..SHIFTS_PER_MONTH (out-of-range/non-finite clamped).
 * @returns {number}
 */
export function unlockedTableCountForShift(shiftNumber) {
  return tableUnlockLevelForShift(shiftNumber) * TABLES_PER_FLOOR_LEVEL;
}

/**
 * Base simultaneous-order capacity at `shiftNumber`, before Extra Table
 * Service gear (`tableCapacity` above) adds on top.
 *
 * @param {number} shiftNumber - 1..SHIFTS_PER_MONTH (out-of-range/non-finite clamped).
 * @returns {number}
 */
export function baseCapacityForShift(shiftNumber) {
  return tableUnlockLevelForShift(shiftNumber);
}

// ---------------------------------------------------------------------------
// 12. Coffee Pour minigame — ported from Library Shift (its rules.js section
//     11). Arriving at the Coffee Machine no longer refills Sanity
//     instantly: the player holds to pour and releases inside a target
//     band. Overfilling to the brim spills hot coffee all over you.
// ---------------------------------------------------------------------------

/** Seconds of continuous pouring to go from an empty cup to the brim. */
export const COFFEE_POUR_SECONDS_TO_BRIM = 2.2;

/** Width of the target band, as a fraction of the cup. */
export const COFFEE_POUR_BAND_WIDTH = 0.12;

/** How far outside the band a release still counts as "good". */
export const COFFEE_POUR_GOOD_MARGIN = 0.1;

/** Gard tipped (into the shift's bonus Gard) for a perfect pour. */
export const COFFEE_PERFECT_TIP_GARD = 10;

/** Sanity change per pour grade — a spill burns you instead of helping. */
export const COFFEE_SANITY_RESTORE = {
  perfect: SANITY_MAX,
  good: 70,
  sloppy: 40,
  spilled: -50,
};

/**
 * The target band for one pour, from a 0..1 roll — centered somewhere in
 * the upper-middle of the cup so it's never trivially "just fill it".
 *
 * @param {number} roll - 0..1 (out-of-range/non-finite clamped).
 * @returns {{min: number, max: number}}
 */
export function coffeePourTargetBand(roll) {
  const r = clamp(Number.isFinite(roll) ? roll : 0.5, 0, 1);
  const center = 0.62 + r * 0.24;
  return { min: center - COFFEE_POUR_BAND_WIDTH / 2, max: center + COFFEE_POUR_BAND_WIDTH / 2 };
}

/**
 * Grades a pour released at `fill` (0..1 of the cup) against `band`.
 *
 * @param {number} fill
 * @param {{min: number, max: number}} band
 * @returns {'perfect'|'good'|'sloppy'|'spilled'}
 */
export function gradeCoffeePour(fill, band) {
  if (!Number.isFinite(fill)) return 'sloppy';
  if (fill >= 1) return 'spilled';
  if (fill >= band.min && fill <= band.max) return 'perfect';
  if (fill >= band.min - COFFEE_POUR_GOOD_MARGIN && fill <= band.max + COFFEE_POUR_GOOD_MARGIN) return 'good';
  return 'sloppy';
}

// ---------------------------------------------------------------------------
// 13. Hallucinations at low Sanity — ported from Library Shift (its section
//     15). Below HALLUCINATION_START_SANITY the player's face turns
//     worried and the restaurant starts playing tricks: shadow figures,
//     whispers, ghost customers at empty tables. At 0 Sanity it's at full
//     strength, with real costs: shaky hands (a narrower, faster cook
//     gauge), dropping what you carry, and a pay cut for time spent there.
// ---------------------------------------------------------------------------

/** Hallucinations start creeping in below this Sanity. */
export const HALLUCINATION_START_SANITY = 25;

/**
 * 0 at or above HALLUCINATION_START_SANITY, rising linearly to 1 at 0.
 *
 * @param {number} sanity
 * @returns {number}
 */
export function hallucinationIntensity(sanity) {
  const s = clampSanity(sanity);
  return s >= HALLUCINATION_START_SANITY ? 0 : (HALLUCINATION_START_SANITY - s) / HALLUCINATION_START_SANITY;
}

const SHAKY_HANDS_MIN_ZONE_SCALE = 0.5;
const SHAKY_HANDS_MAX_SWEEP_MULTIPLIER = 1.6;

/**
 * How much the cook gauge's success window shrinks: 1 (no change) at
 * intensity 0, down to SHAKY_HANDS_MIN_ZONE_SCALE at full intensity.
 *
 * @param {number} intensity - 0..1.
 * @returns {number}
 */
export function shakyHandsZoneScale(intensity) {
  return 1 - (1 - SHAKY_HANDS_MIN_ZONE_SCALE) * clamp(Number.isFinite(intensity) ? intensity : 0, 0, 1);
}

/**
 * How much faster the cook gauge sweeps: 1 at intensity 0, up to
 * SHAKY_HANDS_MAX_SWEEP_MULTIPLIER at full intensity.
 *
 * @param {number} intensity - 0..1.
 * @returns {number}
 */
export function shakyHandsSweepMultiplier(intensity) {
  return 1 + (SHAKY_HANDS_MAX_SWEEP_MULTIPLIER - 1) * clamp(Number.isFinite(intensity) ? intensity : 0, 0, 1);
}

/**
 * `cookSuccessZone(sharpKnifeLevel)` shrunk around its own center by
 * `scale` (shakyHandsZoneScale) — the gauge zone actually used at low Sanity.
 *
 * @param {number} sharpKnifeLevel
 * @param {number} scale - 0..1.
 * @returns {{start: number, end: number}}
 */
export function shakyCookSuccessZone(sharpKnifeLevel, scale) {
  const zone = cookSuccessZone(sharpKnifeLevel);
  const center = (zone.start + zone.end) / 2;
  const half = ((zone.end - zone.start) / 2) * clamp(Number.isFinite(scale) ? scale : 1, 0, 1);
  return { start: center - half, end: center + half, width: half * 2 };
}

/** Per-second chance (scaled by intensity) of dropping what you're carrying. */
export const CARRY_DROP_CHANCE_PER_SECOND = 0.06;

/** Sanity lost when you walk up to a ghost customer and nobody's there. */
export const HALLUCINATION_STARTLE_SANITY = 5;

export const ZERO_SANITY_PAY_CUT_PER_10S = 0.02;
export const ZERO_SANITY_PAY_CUT_MAX = 0.3;

/**
 * Pay multiplier for `zeroSanitySeconds` spent at 0 Sanity this shift:
 * −2% per full 10 seconds, capped at −30%.
 *
 * @param {number} zeroSanitySeconds
 * @returns {number}
 */
export function hallucinationPayMultiplier(zeroSanitySeconds) {
  const seconds = Number.isFinite(zeroSanitySeconds) && zeroSanitySeconds > 0 ? zeroSanitySeconds : 0;
  return 1 - Math.min(ZERO_SANITY_PAY_CUT_MAX, Math.floor(seconds / 10) * ZERO_SANITY_PAY_CUT_PER_10S);
}

// ---------------------------------------------------------------------------
// 14. Penalties at 0 Reputation — ported from Library Shift's 0-Mood
//     penalties (its section 16). Before this, 0 Reputation only meant
//     shorter patience. Now, while it sits at 0: every
//     ZERO_REPUTATION_STORM_OUT_SECONDS the customer closest to giving up
//     storms out (a mistake, like a timeout), every
//     COMPLAINT_INTERVAL_SECONDS Duke gets a complaint letter (−Gard), and
//     the shift's pay is cut for the time spent there.
// ---------------------------------------------------------------------------

export const ZERO_REPUTATION_STORM_OUT_SECONDS = 20;
export const COMPLAINT_INTERVAL_SECONDS = 30;
export const COMPLAINT_GARD = 25;
export const ZERO_REPUTATION_PAY_CUT_PER_10S = 0.02;
export const ZERO_REPUTATION_PAY_CUT_MAX = 0.3;

/**
 * Pay multiplier for `zeroReputationSeconds` spent at 0 Reputation this
 * shift: −2% per full 10 seconds, capped at −30%.
 *
 * @param {number} zeroReputationSeconds
 * @returns {number}
 */
export function reputationPayMultiplier(zeroReputationSeconds) {
  const seconds = Number.isFinite(zeroReputationSeconds) && zeroReputationSeconds > 0 ? zeroReputationSeconds : 0;
  return 1 - Math.min(ZERO_REPUTATION_PAY_CUT_MAX, Math.floor(seconds / 10) * ZERO_REPUTATION_PAY_CUT_PER_10S);
}
