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

/** Shifts per month (doc: "20 shifts = one month"). */
export const SHIFTS_PER_MONTH = 20;

/** Flat per-shift paycheck when no customer was upset (doc's Shift paycheck rule). */
export const SHIFT_PAYCHECK_FULL = 4000;

/** Flat per-shift paycheck when at least one customer was upset. */
export const SHIFT_PAYCHECK_UPSET = 2000;

/** Physical tables on the floor plan — the hard cap on simultaneous orders regardless of gear. */
export const PHYSICAL_TABLE_COUNT = 4;

/**
 * Fixed per-shift countdown, in seconds (doc: "each shift runs on a fixed
 * countdown ... illustrative, tune during build"). Deliberately the same
 * for every shift — only the pace of what happens *within* it (arrival
 * rate, patience, sweep speed below) ramps with shift number.
 */
export const SHIFT_CLOCK_SECONDS = 90;

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

/** The shift-band / recipe table from the doc's Business Rules section. */
export const RECIPE_BANDS = [
  { minShift: 1, dishes: [
    { name: 'Garden Salad', station: 'none', ingredients: ['Lettuce', 'Tomato'] },
    { name: 'Grilled Cheese', station: 'stove', ingredients: ['Bread', 'Cheese'] },
  ] },
  { minShift: 6, dishes: [
    { name: 'Burger', station: 'stove', ingredients: ['Buns', 'Patty', 'Lettuce'] },
    { name: 'Pancakes', station: 'stove', ingredients: ['Flour', 'Egg', 'Milk'] },
  ] },
  { minShift: 11, dishes: [
    { name: 'Roast Chicken', station: 'oven', ingredients: ['Chicken', 'Herbs'] },
    { name: 'Pasta', station: 'stove', ingredients: ['Noodles', 'Sauce'] },
  ] },
  { minShift: 16, dishes: [
    { name: 'Steak Dinner', station: 'stove', ingredients: ['Steak', 'Potato', 'Herbs'] },
    { name: 'Soufflé', station: 'oven', ingredients: ['Egg', 'Cheese', 'Flour'] },
  ] },
];

/** Every ingredient name available at the Fridge (cold storage). */
export const FRIDGE_INGREDIENTS = ['Cheese', 'Milk', 'Chicken', 'Patty', 'Steak', 'Lettuce', 'Tomato', 'Egg'];

/** Every ingredient name available at the Cabinet (dry storage). */
export const CABINET_INGREDIENTS = ['Bread', 'Flour', 'Noodles', 'Herbs', 'Buns', 'Sauce', 'Potato'];

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

const BASE_TABLE_CAPACITY = 2;

/**
 * Simultaneous active tables/orders allowed, capped by both the physical
 * table count and the Extra Table Service gear level — whichever is lower
 * (doc's Business Rules).
 *
 * @param {number} extraTableServiceLevel - gear level (negative/non-finite treated as 0).
 * @returns {number}
 */
export function tableCapacity(extraTableServiceLevel) {
  const level = Number.isFinite(extraTableServiceLevel) && extraTableServiceLevel > 0 ? extraTableServiceLevel : 0;
  return Math.min(PHYSICAL_TABLE_COUNT, BASE_TABLE_CAPACITY + level);
}

// ---------------------------------------------------------------------------
// 4. Shift paycheck (final, not illustrative — the doc's headline rule)
// ---------------------------------------------------------------------------

/**
 * A shift's flat Gard payout: SHIFT_PAYCHECK_FULL unless `shiftUpset` is
 * true, in which case SHIFT_PAYCHECK_UPSET — regardless of how many
 * customers were upset or how many were served correctly. Not a per-dish
 * or per-upset scaling number; see the doc's Shift paycheck rule for why.
 *
 * @param {boolean} shiftUpset
 * @returns {number}
 */
export function shiftPaycheck(shiftUpset) {
  return shiftUpset ? SHIFT_PAYCHECK_UPSET : SHIFT_PAYCHECK_FULL;
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
