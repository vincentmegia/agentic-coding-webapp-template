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

/**
 * Physical tables on the floor plan — the hard cap on simultaneous orders
 * regardless of gear. 30, not 4 — the user asked for a much bigger dining
 * room once the game moved to a bigger, click-driven floor plan; see
 * floor-plan.js's 6x5 table grid.
 */
export const PHYSICAL_TABLE_COUNT = 30;

/**
 * Fixed per-shift countdown, in seconds (doc: "each shift runs on a fixed
 * countdown ... illustrative, tune during build"). Deliberately the same
 * for every shift — only the pace of what happens *within* it (arrival
 * rate, patience, sweep speed below) ramps with shift number.
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
 * dish, Baking Tray for every Oven dish (Rice Cooker exists in the
 * Cookware Closet but isn't required by any dish yet; the user asked for
 * it "e.g." alongside Pan, not as a strict requirement).
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
  ] },
  { minShift: 16, dishes: [
    { name: 'Steak Dinner', station: 'stove', cookware: 'Pan', ingredients: ['Steak', 'Potato', 'Herbs'] },
    { name: 'Soufflé', station: 'oven', cookware: 'Baking Tray', ingredients: ['Egg', 'Cheese', 'Flour'] },
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
export const CABINET_INGREDIENTS = ['Bread', 'Flour', 'Noodles', 'Herbs', 'Buns', 'Sauce', 'Potato', 'Star Cake', 'Cake'];

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

/**
 * A new player only fields a handful of simultaneous tables out of the
 * full 30-table room — Extra Table Service gear opens up more over many
 * levels (see GEAR_DEFS in cooking-game.js), never all 30 at once without
 * real investment.
 */
const BASE_TABLE_CAPACITY = 5;

/** Extra Table Service adds this many active tables per level. */
const TABLE_CAPACITY_PER_EXTRA_TABLE_SERVICE_LEVEL = 3;

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
  return Math.min(PHYSICAL_TABLE_COUNT, BASE_TABLE_CAPACITY + level * TABLE_CAPACITY_PER_EXTRA_TABLE_SERVICE_LEVEL);
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

// ---------------------------------------------------------------------------
// 5. The Karen event — a one-time scripted customer on a single shift, not
//    part of the normal random arrival pool. Picked as shift 12 out of the
//    "12 or 18" the user offered, to keep this a single well-defined
//    trigger rather than two; easy to move or duplicate later.
// ---------------------------------------------------------------------------

/** The one shift Karen shows up on. */
export const KAREN_SHIFT_NUMBER = 12;

/** Her opening line, shown the moment she's seated. */
export const KAREN_LINE = 'HEY YOU THERE COME OVER HERE';

/**
 * Karen's patience is much shorter than a normal customer's at the same
 * shift (`customerPatienceSeconds`) — she's not here to wait.
 */
export const KAREN_PATIENCE_SECONDS = 12;

/**
 * Whether this shift is Karen's shift.
 *
 * @param {number} shiftNumber
 * @returns {boolean}
 */
export function isKarenShift(shiftNumber) {
  return clampShift(shiftNumber) === KAREN_SHIFT_NUMBER;
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
 *   SHIFT_CLOCK_SECONDS, i.e. "shift just started").
 * @returns {string} e.g. "8:30 AM", "3:30 PM", "11:30 PM".
 */
export function inGameTimeLabel(clockSecondsRemaining) {
  const remaining = Number.isFinite(clockSecondsRemaining)
    ? clamp(clockSecondsRemaining, 0, SHIFT_CLOCK_SECONDS)
    : SHIFT_CLOCK_SECONDS;
  const elapsedFraction = 1 - remaining / SHIFT_CLOCK_SECONDS;
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
