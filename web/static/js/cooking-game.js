// Kitchen Shift canvas engine: rendering, input, station interaction,
// customer/order spawning, and localStorage progress persistence
// (docs/features/cooking-game.md, "Client-side Behavior (non-HTMX)" and
// "Business Rules / Validation").
//
// v2 REDESIGN (superseding an earlier keyboard-arrows/WASD version): the
// user reported "I can't move" against that version and asked for
// point-and-click controls instead — click a station and the player walks
// over and interacts with it automatically; click empty floor and the
// player just walks there. This file no longer reads any keyboard input
// for movement at all. It also grew the floor plan to 30 tables, added a
// Cookware Closet (Pan/Baking Tray/Rice Cooker) with per-dish cookware
// requirements, restyled the fridge/cabinet/cleaning-closet/boss's-office
// as doors that visually "open" while their panel/action is active, added
// a front counter fixture (replacing a plain "shutdown" box), a fullscreen
// toggle, and a one-time scripted "Karen" customer event on shift 12.
//
// v3 restyle (see "Coquette rendering constants" below): dropped v2's
// pixel-art treatment for a soft pastel "coquette" look.
//
// v3.1 room split: the fridge/cabinet/cookware-closet/stove/oven/cleaning-
// closet no longer sit "in random places" alongside the dining tables —
// they now live in a separate Kitchen room, reachable from Dining through
// a kitchen-door station (and back via a dining-door station in Kitchen),
// plus a "roomButton" DOM shortcut that switches instantly from anywhere.
// Only the active room's stations render or hit-test at any moment
// (`stationsInRoom`, floor-plan.js) — see `currentRoom`/`switchRoom` below.
//
// v3.3: characters drawn bigger (every drawPixelPerson/drawMel call site's
// `scale` raised) and given an "anime art style" face — this project has
// no sprite/image assets anywhere (canvas-primitives-only, same as every
// other visual here), so "anime style" means procedurally drawing big
// vertical-oval eyes with a sparkle highlight, thin eyebrows, cheek blush,
// and a small smile via drawAnimeFace(), folded into drawPixelPerson
// itself so every character (player, generic customers, Karen, Olive &
// Oliver, the security guard, and Mel via her drawMel wrapper) gets one
// automatically rather than needing a separate opt-in per call site.
//
// v3.14 round tiers: SUPERSEDES the earlier v3.13 lifetime-shifts-based
// food server leveling. The month now runs 30 shifts (was 20), split into
// three 10-shift tiers, each with its own real-time shift-clock budget
// (`shiftClockSecondsForShift`) and dining-room size
// (`tableUnlockLevelForShift`, read live via `currentTableUnlockLevel`) —
// driven directly by the current shift number, so (unlike v3.13) it
// resets to Tier 1 every "Start New Month" rather than persisting across
// a save's lifetime. See `./cooking/rules.js`'s "Round tiers" section and
// docs/features/cooking-game-food-server-leveling.md.
//
// v3.16: tables draw as circles instead of rounded squares (drawStation),
// per the user's explicit request — every other station kind is
// unchanged. Table geometry (seated-customer sprite, patience bar, order
// bubble) now reads each table's own `station.size` instead of a flat
// `TABLE_BOX_SIZE` constant, since floor-plan.js's `tableBoxSizeForLevel`
// makes table size scale with the round tier (smaller at Tier 1, growing
// to the original full size at Tier 3) rather than staying fixed.
//
// v3.18: customer sanity — a new per-order stat (engine-state.js's
// `annoyCustomer`, drawn as a small lavender bar above each table's
// patience bar) separate from the time-based patience countdown. Two
// things now "annoy" a customer: re-visiting their table after taking
// their order but before serving it (handleTableArrival's re-click
// branch), and serving them the wrong dish (on top of that mistake's
// existing Gard/Reputation cost, not instead of it). Each annoyance
// re-shows the order speech bubble too — the customer "repeats" their
// order — and after 4 annoyances they walk out angry, exactly like a
// patience timeout (annoyCustomerAt reuses the same Karen-ripple/Mel/
// couple cleanup the main loop's tick()-driven timeout path already has).
// The order bubble itself also got slower (2.5s -> 5s, it was
// disappearing too quickly) and its dish icon bigger again (32px -> 40px,
// a follow-up on an earlier 22px -> 32px pass).
//
// v3.19: the order bubble drops its dish-name text entirely — icon-only
// now, per direct follow-up feedback ("remove the names from the
// customer order bubble") — and the icon grew again (40px -> 56px) so it
// still reads clearly without the name as a fallback.
//
// This file owns everything HTMX cannot model for /kitchen-shift: the
// `requestAnimationFrame` loop, click-driven movement/station-interaction,
// customer spawning, HUD/order-queue updates, and the single
// `localStorage` progress key. Order-queue/table/closing-sequence
// *transitions* are delegated to the pure `./cooking/engine-state.js`
// module rather than reimplemented inline here. Recipe/cook-timing/
// shift-ramp/paycheck/Karen math is delegated the same way to
// `./cooking/rules.js`, and station-position/click-hit-testing/movement
// geometry to `./cooking/floor-plan.js`.
//
// External file, no inline <script> tag, per this codebase's CSP-compatible
// convention. Loaded as an ES module:
//
//   <script type="module" src="/static/js/cooking-game.js"></script>
//
// from web/templates/pages/cooking-game.html — see this file's exported
// `init()` doc comment below for the DOM contract that page must provide.

import {
  availableDishes,
  findDish,
  RECIPE_BANDS,
  isCookSuccess,
  cookSweepSpeed,
  customerArrivalIntervalSeconds,
  jitteredArrivalIntervalSeconds,
  customerPatienceSeconds,
  tableCapacity,
  COUNTER_PAYMENT_GARD,
  karenEncounter,
  inGameTimeLabel,
  SHIFTS_PER_MONTH,
  PHYSICAL_TABLE_COUNT,
  FRIDGE_INGREDIENTS,
  CABINET_INGREDIENTS,
  COOKWARE_ITEMS,
  MEL_DISH,
  MEL_THANK_YOU_LINE,
  MEL_PATIENCE_BONUS_SECONDS,
  MEL_FAVORITE_COLOR,
  COUPLE_DISH,
  OLIVE_FAVORITE_COLOR,
  OLIVER_FAVORITE_COLOR,
  walkSpeedMultiplierForSanity,
  patienceMultiplierForReputation,
  roundTier,
  roundTierStars,
  shiftClockSecondsForShift,
  tableUnlockLevelForShift,
  unlockedTableCountForShift,
  CUSTOMER_SANITY_MAX,
  COFFEE_POUR_SECONDS_TO_BRIM,
  coffeePourTargetBand,
  gradeCoffeePour,
  hallucinationIntensity,
  shakyHandsZoneScale,
  shakyHandsSweepMultiplier,
  shakyCookSuccessZone,
  CARRY_DROP_CHANCE_PER_SECOND,
  COMPLAINT_GARD,
} from './cooking/rules.js';
import {
  createInitialState,
  addOrder,
  serveDish,
  tick,
  cleanTable,
  washDishes,
  shutDown,
  failOrderAt,
  brewCoffee,
  earnBonusGard as addBonusGard,
  startleFromHallucination,
  shiftPayout,
  annoyCustomer,
  SANITY_MAX,
  REPUTATION_MAX,
} from './cooking/engine-state.js';
import {
  buildStations,
  stationsInRoom,
  stationAtPoint,
  approachPoint,
  clampToCanvas,
  resolveObstacleCollisions,
  PLAYER_START,
  PLAYER_STOP_MARGIN,
  ROOM_DINING,
  ROOM_KITCHEN,
  KITCHEN_ENTRY_POINT,
  DINING_ENTRY_POINT,
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  isTableUnlocked,
  unlockedStations,
} from './cooking/floor-plan.js';
import { drawPerson, shadeColor, PEOPLE_TEMPLATES } from './shared/people.js';

// ---------------------------------------------------------------------------
// localStorage progress (doc: "a single localStorage key")
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'cooking-game:v2';

const TABLE_IDS = Array.from({ length: PHYSICAL_TABLE_COUNT }, (_, i) => i + 1);

/** Gear keys and their shop definitions (doc: "Gear upgrades", illustrative costs/levels — tune during build). */
export const GEAR_DEFS = {
  runningShoes: { label: 'Running Shoes', baseCost: 250, costGrowth: 1.5, maxLevel: 5 },
  biggerTray: { label: 'Bigger Tray', baseCost: 300, costGrowth: 1.5, maxLevel: 5 },
  sharpKnife: { label: 'Sharp Knife', baseCost: 280, costGrowth: 1.5, maxLevel: 5 },
  extraTableService: { label: 'Extra Table Service', baseCost: 400, costGrowth: 1.6, maxLevel: 8 },
  regularsPatience: { label: "Regular's Patience", baseCost: 220, costGrowth: 1.5, maxLevel: 5 },
  quickClean: { label: 'Quick Clean', baseCost: 200, costGrowth: 1.4, maxLevel: 5 },
};

function defaultSave() {
  const gear = {};
  Object.keys(GEAR_DEFS).forEach((key) => { gear[key] = 0; });
  return {
    version: 1,
    monthToDateGard: 0,
    currentShift: 1,
    gear,
    bestMonthTotal: 0,
    hasSeenIntro: false,
  };
}

/** Feature-detects a real, usable localStorage (private browsing / disabled storage safe). */
function probeStorageAvailable() {
  try {
    const probeKey = '\0cooking-game-probe';
    window.localStorage.setItem(probeKey, '1');
    window.localStorage.removeItem(probeKey);
    return true;
  } catch {
    return false;
  }
}

function isValidSaveShape(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.version !== 1) return false;
  if (typeof value.monthToDateGard !== 'number' || !Number.isFinite(value.monthToDateGard)) return false;
  if (typeof value.currentShift !== 'number' || !Number.isFinite(value.currentShift)) return false;
  if (typeof value.bestMonthTotal !== 'number' || !Number.isFinite(value.bestMonthTotal)) return false;
  if (!value.gear || typeof value.gear !== 'object') return false;
  return true;
}

/**
 * Loads saved progress, falling back to defaults on missing/corrupted data
 * or when storage is unavailable — never throws.
 */
export function loadSave(storageAvailable) {
  if (!storageAvailable) return defaultSave();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultSave();
    const parsed = JSON.parse(raw);
    if (!isValidSaveShape(parsed)) return defaultSave();
    const save = defaultSave();
    save.monthToDateGard = Math.max(0, parsed.monthToDateGard);
    save.currentShift = Math.min(SHIFTS_PER_MONTH, Math.max(1, Math.round(parsed.currentShift)));
    save.bestMonthTotal = Math.max(0, parsed.bestMonthTotal);
    // Absent on any save written before this field existed — treated as
    // `false` (not yet seen), so pre-existing players see the one-time
    // intro once on their next "Start Shift" rather than the load failing
    // or the intro being skipped for a save that genuinely never saw it.
    save.hasSeenIntro = parsed.hasSeenIntro === true;
    Object.keys(GEAR_DEFS).forEach((key) => {
      const level = parsed.gear[key];
      save.gear[key] = typeof level === 'number' && Number.isFinite(level) && level >= 0
        ? Math.min(level, GEAR_DEFS[key].maxLevel)
        : 0;
    });
    return save;
  } catch {
    return defaultSave();
  }
}

function persistSave(storageAvailable, save) {
  if (!storageAvailable) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(save));
  } catch {
    // Storage became unavailable mid-session — the game stays fully
    // playable for the rest of this session; it just silently stops
    // persisting.
  }
}

function gearCost(key, currentLevel) {
  const def = GEAR_DEFS[key];
  return Math.round(def.baseCost * Math.pow(def.costGrowth, currentLevel));
}

// ---------------------------------------------------------------------------
// Gear effects
// ---------------------------------------------------------------------------

/** Base walking speed, px/s — higher than the old keyboard version's, since the floor plan is much bigger now. */
const PLAYER_BASE_SPEED = 220;
const BASE_CARRY_CAPACITY = 3;
const BASE_CLEAN_SECONDS = 1.5;
const CLEAN_SECONDS_PER_QUICK_CLEAN_LEVEL = 0.2;

function walkSpeedForSave(save) {
  return PLAYER_BASE_SPEED * (1 + 0.15 * save.gear.runningShoes);
}

function carryCapacityForSave(save) {
  return BASE_CARRY_CAPACITY + save.gear.biggerTray;
}

function cleaningDurationForSave(save) {
  return Math.max(0.4, BASE_CLEAN_SECONDS - save.gear.quickClean * CLEAN_SECONDS_PER_QUICK_CLEAN_LEVEL);
}

// ---------------------------------------------------------------------------
// One-time intro (v3): the very first "Start Shift" ever clicked on this
// device shows the player walking in from the entrance/exit (drawFloor's
// door sprite/"Entrance / Exit" caption, v3.32) while a dialogue line displays, before
// normal play begins — never again after that, gated on the save's
// `hasSeenIntro` flag (see loadSave/defaultSave above).
// ---------------------------------------------------------------------------

/** Verbatim per the user's request — not reworded. */
const INTRO_DIALOGUE_LINE = "Woah so this is my new job! i hope this will turn out well this is a perfect match because i like this resturant";

/** Just inside the canvas near the floor's "Entrance / Exit" marker (drawFloor). */
const INTRO_ENTRANCE_POSITION = { x: 650, y: CANVAS_HEIGHT - 30 };

// ---------------------------------------------------------------------------
// Recipe helpers
// ---------------------------------------------------------------------------

/**
 * Ingredients a dish still needs, given what's already in a (possibly
 * partial, possibly irrelevant-to-this-dish) inventory bag. Treats
 * inventory as a multiset — an ingredient already held satisfies at most
 * one required copy.
 */
function missingIngredientsForDish(dish, inventory) {
  const remaining = [...inventory];
  const missing = [];
  for (const ingredient of dish.ingredients) {
    const idx = remaining.indexOf(ingredient);
    if (idx === -1) {
      missing.push(ingredient);
    } else {
      remaining.splice(idx, 1);
    }
  }
  return missing;
}

function removeDishIngredientsFromInventory(dish, inventory) {
  const next = [...inventory];
  for (const ingredient of dish.ingredients) {
    const idx = next.indexOf(ingredient);
    if (idx !== -1) next.splice(idx, 1);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Coquette rendering constants
// ---------------------------------------------------------------------------
//
// v3 restyle: the user tried the v2 pixel-art look, then asked for
// "coquette" instead — a soft, pastel, ribbon-and-bow aesthetic (their
// reference: pale pink/white lace, soft linework). Real illustrated
// anime-style art needs actual drawn/generated sprite assets, which this
// canvas-primitive renderer doesn't have (see Open Questions) — what
// follows is the closest honest approximation buildable from flat shapes:
// a pastel palette, rounded corners everywhere (via ctx.roundRect, not
// square pixel corners), round heads, and small bow/star accent shapes.
// The hard pixelation from v2 (image-rendering: pixelated, forcing a
// blocky nearest-neighbor upscale) is dropped for the same reason — a soft
// style needs smooth scaling, not jagged edges — see cooking-game.html's
// canvas element, which no longer carries the .pixel-canvas class.


// v3.7 dish icons + carrying animation: how fast drawPlayerHolding's held
// tray/upper-body bobs while walking with something held (radians/sec fed
// into Math.sin — not a real-world unit) and how far it moves (px, before
// the * scale drawPlayerHolding applies). Per the reviewed mockup: a light
// bounce, not a full walk-cycle bob.
const CARRY_BOB_SPEED = 8;
const CARRY_BOB_AMPLITUDE = 3;

/**
 * v3.12: how long the speech-bubble popup showing a customer's order stays
 * on screen once the player arrives and the order is taken — see
 * drawOrderBubble/updateOrderBubble. v3.18: doubled from 2.5s — the user
 * reported it disappeared too quickly to read comfortably.
 */
const ORDER_BUBBLE_SECONDS = 5;

/**
 * v3.28: a served customer's eat-at-the-table → walk-to-counter → pay →
 * leave animation (payingCustomers). v3.29: the eating pause and the
 * paying pause are each randomized per customer (within these ranges,
 * picked at spawn/arrival time — see spawnPayingCustomer/
 * updatePayingCustomers) rather than fixed durations, so several
 * customers served close together don't all eat/pay/leave in lockstep.
 */
const PAYING_CUSTOMER_WALK_SPEED = 130; // px/sec, while 'walking' or 'leaving'
const CUSTOMER_EATING_SECONDS_MIN = 2.5;
const CUSTOMER_EATING_SECONDS_MAX = 5.5;
const PAYING_CUSTOMER_TRANSACTION_SECONDS_MIN = 0.8;
const PAYING_CUSTOMER_TRANSACTION_SECONDS_MAX = 1.8;

/**
 * Random float in [min, max) — a top-level helper (unlike most randomness
 * in this file, which goes through `init()`'s local `random` alias) since
 * animation-timing jitter here has no gameplay-outcome stake worth routing
 * through that alias.
 */
function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

/**
 * v3.33: "treat all things as objects... [they] should never collide" —
 * every moving entity in this game (the player, each `payingCustomers`
 * entry) is a circle of one of these radii for
 * `resolveObstacleCollisions` (floor-plan.js) purposes, roughly matching
 * each sprite's own visual width so the collision footprint reads as
 * "can't walk through them," not a mysteriously larger invisible bubble.
 *
 * TABLE_COLLISION_RADIUS is deliberately much smaller than a table's own
 * visual radius (up to 50px at the densest Tier 3 size) rather than
 * matching it exactly: `floor-plan.js`'s `TABLE_GRID_SHAPES[30]` already
 * *intentionally* packs Tier 3's rows ~5px tighter than the tables are
 * tall ("a deliberate, user-accepted tradeoff," kitchen leveling doc) —
 * full-radius circular collision between adjacent rows would make some
 * tables geometrically unreachable, walled in by their own neighbors. A
 * smaller radius still stops a character from walking through a table's
 * own center while leaving Tier 3's already-tight row gaps (as little as
 * ~35px edge-to-edge between hitboxes) navigable.
 */
const PLAYER_COLLISION_RADIUS = 14;
const CUSTOMER_COLLISION_RADIUS = 14;
const TABLE_COLLISION_RADIUS = 30;

const STATION_COLORS = {
  // v4: Library Shift's warmer, lightly desaturated palette.
  fridge: '#bcd6e4',
  cabinet: '#e0bf94',
  toilet: '#cfe3ea',
  'cleaning-closet': '#c9e2d4',
  'cookware-closet': '#d6c3e0',
  stove: '#ede4da',
  oven: '#e9b9a8',
  'rice-station': '#efe0c4',
  counter: '#f2d98a',
  'coffee-machine': '#e3cdb4',
  'boss-office': '#dcc2ea',
  'kitchen-door': '#e9c49a',
  'dining-door': '#e9c49a',
};

const STATION_LABELS = {
  fridge: 'Fridge',
  cabinet: 'Cabinet',
  toilet: 'Restroom',
  'cleaning-closet': 'Cleaning Closet',
  'cookware-closet': 'Cookware Closet',
  stove: 'Stove',
  oven: 'Oven',
  'rice-station': 'Rice Station',
  counter: 'Counter',
  'coffee-machine': 'Coffee Machine',
  'boss-office': "Duke's Office",
  'kitchen-door': 'To Kitchen',
  'dining-door': 'To Dining',
};

function drawRoundRect(ctx, x, y, w, h, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h), r);
  ctx.fill();
}

/** A small bow (two triangular loops + a center knot) — the coquette style's signature accent. */
function drawBow(ctx, x, y, color, scale = 1) {
  const s = scale;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - 8 * s, y - 5 * s);
  ctx.lineTo(x - 8 * s, y + 5 * s);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + 8 * s, y - 5 * s);
  ctx.lineTo(x + 8 * s, y + 5 * s);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, 3 * s, 0, Math.PI * 2);
  ctx.fill();
}

/** A five-point star — the restaurant's star theme (table pillows, the sign, floor accents). */
function drawStar(ctx, cx, cy, outerRadius, innerRadius, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outerRadius : innerRadius;
    const angle = (Math.PI / 5) * i - Math.PI / 2;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Dish icons — flat, canvas-drawn (no image assets exist anywhere in this
// project — see the v3.3 anime-face changelog note above for why) icons for
// every finished dish, replacing the plain dish-name text that used to be
// the only visual for a held/served dish. Ported from a reviewed design
// mockup (a claude.ai/design canvas the user approved before this landed).
// Each drawX(ctx) function assumes it's already been translated/scaled into
// a local 100x100 coordinate box (see drawDishIcon's dispatcher below) —
// coordinates are lifted directly from that mockup's SVG.
// ---------------------------------------------------------------------------

/** A closed blob from a moveTo through one or more quadratic-curve segments — e.g. a leaf or petal shape. `points` is [x0,y0, cx1,cy1,x1,y1, cx2,cy2,x2,y2, ...]. */
function drawQuadBlob(ctx, points, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(points[0], points[1]);
  for (let i = 2; i < points.length; i += 4) {
    ctx.quadraticCurveTo(points[i], points[i + 1], points[i + 2], points[i + 3]);
  }
  ctx.closePath();
  ctx.fill();
}

/** A wavy strip (lettuce, a bottom bun edge): curve out, straight down, curve back. */
function drawWaveStrip(ctx, x0, y0, cx1, cy1, x1, y1, x2, y2, cx3, cy3, x3, y3, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.quadraticCurveTo(cx1, cy1, x1, y1);
  ctx.lineTo(x2, y2);
  ctx.quadraticCurveTo(cx3, cy3, x3, y3);
  ctx.closePath();
  ctx.fill();
}

function drawGardenSaladIcon(ctx) {
  ctx.fillStyle = '#fdf1e4';
  ctx.strokeStyle = '#e0c9a6';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.ellipse(50, 66, 36, 20, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  drawQuadBlob(ctx, [34, 54, 30, 40, 40, 38, 44, 48, 40, 56], '#8fbf7f');
  drawQuadBlob(ctx, [50, 52, 48, 36, 58, 36, 60, 48, 54, 56], '#a3cf8f');
  drawQuadBlob(ctx, [62, 56, 62, 42, 70, 42, 72, 52, 66, 58], '#8fbf7f');
  ctx.fillStyle = '#e0685a';
  ctx.beginPath();
  ctx.arc(42, 58, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(60, 60, 5.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.beginPath();
  ctx.arc(40.5, 56, 1.4, 0, Math.PI * 2);
  ctx.fill();
}

function drawGrilledCheeseIcon(ctx) {
  ctx.fillStyle = '#e0a458';
  ctx.fillRect(20, 34, 58, 10);
  ctx.fillStyle = '#f7d774';
  ctx.fillRect(20, 44, 58, 8);
  ctx.fillStyle = '#e0a458';
  ctx.fillRect(20, 52, 58, 14);
  ctx.fillStyle = '#f7d774';
  ctx.beginPath();
  ctx.moveTo(78, 44);
  ctx.quadraticCurveTo(84, 48, 78, 52);
  ctx.closePath();
  ctx.fill();
}

function drawBurgerIcon(ctx) {
  ctx.fillStyle = '#e8b968';
  ctx.beginPath();
  ctx.moveTo(22, 44);
  ctx.quadraticCurveTo(22, 26, 50, 26);
  ctx.quadraticCurveTo(78, 26, 78, 44);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#fff8ea';
  for (const [x, y] of [[36, 34], [50, 30], [64, 34]]) {
    ctx.beginPath();
    ctx.arc(x, y, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  drawWaveStrip(ctx, 20, 46, 50, 54, 80, 46, 78, 52, 50, 60, 22, 52, '#8fbf7f');
  drawRoundRect(ctx, 21, 52, 58, 12, 4, '#8a5a3a');
  ctx.fillStyle = '#f7d774';
  ctx.beginPath();
  ctx.moveTo(66, 52);
  ctx.lineTo(76, 46);
  ctx.lineTo(78, 54);
  ctx.closePath();
  ctx.fill();
  drawWaveStrip(ctx, 21, 66, 50, 74, 79, 66, 79, 72, 50, 80, 21, 72, '#e0a458');
}

function drawPancakesIcon(ctx) {
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = '#c67139';
  ctx.beginPath();
  ctx.ellipse(50, 66, 30, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#e8c073';
  ctx.strokeStyle = '#c9985a';
  ctx.lineWidth = 1.5;
  for (const y of [58, 47, 36]) {
    ctx.beginPath();
    ctx.ellipse(50, y, 30, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  drawRoundRect(ctx, 42, 28, 16, 9, 2.5, '#fff3c4');
  ctx.strokeStyle = '#c67139';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(30, 30);
  ctx.quadraticCurveTo(40, 38, 34, 46);
  ctx.quadraticCurveTo(46, 52, 40, 60);
  ctx.quadraticCurveTo(54, 66, 48, 72);
  ctx.stroke();
  ctx.lineCap = 'butt';
}

function drawRoastChickenIcon(ctx) {
  ctx.fillStyle = '#fdf1e4';
  ctx.strokeStyle = '#e0c9a6';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.ellipse(50, 68, 34, 12, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#d99a5b';
  ctx.beginPath();
  ctx.ellipse(50, 52, 24, 17, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(198,113,57,0.35)';
  ctx.beginPath();
  ctx.ellipse(50, 46, 24, 10, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#7a8a5e';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  for (const [bx, by, angle] of [[62, 38, -0.5], [70, 43, -0.2]]) {
    ctx.save();
    ctx.translate(bx, by);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, 7);
    ctx.lineTo(0, -6);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-4, -4);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -3);
    ctx.lineTo(4, -6);
    ctx.stroke();
    ctx.restore();
  }
  ctx.lineCap = 'butt';
}

function drawPastaIcon(ctx) {
  ctx.fillStyle = '#fdf1e4';
  ctx.strokeStyle = '#e0c9a6';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.ellipse(50, 66, 34, 18, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = '#f0d9a0';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(26, 58);
  ctx.quadraticCurveTo(34, 48, 30, 40);
  ctx.quadraticCurveTo(44, 46, 40, 56);
  ctx.quadraticCurveTo(52, 50, 48, 40);
  ctx.quadraticCurveTo(62, 48, 58, 58);
  ctx.stroke();
  ctx.lineCap = 'butt';
  ctx.fillStyle = '#c65f7c';
  for (const [x, y, r] of [[38, 58, 3], [52, 62, 2.6], [60, 56, 2.2]]) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = '#7a8a5e';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(44, 52);
  ctx.lineTo(40, 48);
  ctx.stroke();
  ctx.lineCap = 'butt';
}

function drawSteakDinnerIcon(ctx) {
  ctx.fillStyle = '#fdf1e4';
  ctx.strokeStyle = '#e0c9a6';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.ellipse(50, 66, 34, 18, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#7a4a32';
  ctx.beginPath();
  ctx.moveTo(24, 56);
  ctx.quadraticCurveTo(40, 46, 58, 54);
  ctx.quadraticCurveTo(68, 58, 62, 66);
  ctx.quadraticCurveTo(44, 74, 28, 66);
  ctx.quadraticCurveTo(20, 62, 24, 56);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(90,50,34,0.7)';
  ctx.lineWidth = 1.6;
  for (const [x1, y1, x2, y2] of [[32, 54, 40, 62], [42, 52, 50, 60], [52, 52, 58, 58]]) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  ctx.fillStyle = '#e8d4a0';
  ctx.beginPath();
  ctx.arc(68, 62, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#7a8a5e';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(66, 56);
  ctx.quadraticCurveTo(62, 48, 56, 46);
  ctx.stroke();
  ctx.lineCap = 'butt';
}

function drawSouffleIcon(ctx) {
  ctx.fillStyle = '#c67139';
  ctx.beginPath();
  ctx.moveTo(32, 70);
  ctx.lineTo(36, 40);
  ctx.quadraticCurveTo(50, 34, 64, 40);
  ctx.lineTo(68, 70);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#a35a2c';
  ctx.beginPath();
  ctx.moveTo(33, 62);
  ctx.lineTo(67, 62);
  ctx.lineTo(67, 70);
  ctx.quadraticCurveTo(50, 74, 33, 70);
  ctx.closePath();
  ctx.fill();
  // Puffy risen top: a cluster of overlapping soft circles reads as
  // "fluffy" far more clearly than a single traced outline did.
  ctx.fillStyle = '#fff3c4';
  ctx.strokeStyle = '#f2e2b0';
  ctx.lineWidth = 1;
  for (const [cx, cy, r] of [[50, 32, 13], [36, 38, 9], [64, 38, 9], [43, 24, 8], [57, 24, 8]]) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

/**
 * Mel's Usual is Lemonade, Star Cake, and Egg (MEL_DISH) — reuses the
 * actual drawLemonadeIcon/drawStarCakeIcon/drawEggIcon drawers (via
 * drawIconAt, the same composition helper drawCoupleOrderIcon below also
 * uses) side by side on a small plate, instead of a bespoke redrawn
 * composite. The previous hand-drawn version's "Star Cake" slice used a
 * plain white star accent — exactly the ambiguous choice
 * drawStarCakeIcon's own doc comment already explains was rejected there
 * (indistinguishable from plain Cake's icon at small size) — and a user
 * report ("what is the pink triangle food picture") confirmed it read as
 * unrecognizable here too. Reusing the same icons already shown in the
 * Fridge/Cabinet panels fixes both problems at once.
 */
function drawMelsUsualIcon(ctx) {
  drawRoundRect(ctx, 10, 62, 80, 10, 5, '#fdf1e4');
  drawIconAt(ctx, 18, 50, 34, drawLemonadeIcon);
  drawIconAt(ctx, 50, 50, 34, drawStarCakeIcon);
  drawIconAt(ctx, 82, 50, 34, drawEggIcon);
}

/**
 * Olive & Oliver's Order is Matcha + Cake (COUPLE_DISH) — reuses the
 * exact same Matcha/Cake icons already shown in the Fridge/Cabinet
 * panels (via drawIconAt, defined below), side by side on a small plate,
 * rather than a bespoke redrawn composite. The previous hand-drawn
 * version (two identical matcha rectangles plus a pink/green two-tone
 * triangle found nowhere else in the game) read as an unrecognizable
 * shape — a real user report ("i dont not understand this triangle food
 * icon"). Reusing the same icons the player already knows from gathering
 * ingredients directly fixes that: it's the same Matcha glass and the
 * same Cake triangle, just smaller and side by side.
 */
function drawCoupleOrderIcon(ctx) {
  drawRoundRect(ctx, 10, 62, 80, 10, 5, '#fdf1e4');
  drawIconAt(ctx, 26, 50, 46, drawMatchaIcon);
  drawIconAt(ctx, 74, 50, 46, drawCakeIcon);
}

/** Dish name -> icon drawer, one entry per RECIPE_BANDS/MEL_DISH/COUPLE_DISH name (rules.js). */
/** A plate with a dome of white rice — shared base for both rice dishes. */
function drawRicePlate(ctx) {
  ctx.fillStyle = '#fdf1e4';
  ctx.strokeStyle = '#e0c9a6';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.ellipse(50, 68, 36, 16, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

function drawChickenRiceIcon(ctx) {
  drawRicePlate(ctx);
  // Rice mound on the left, speckled with grains.
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.ellipse(38, 60, 18, 13, 0, Math.PI, 0);
  ctx.lineTo(56, 66);
  ctx.lineTo(20, 66);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#e6dccb';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = '#e6dccb';
  for (const [x, y] of [[30, 56], [38, 52], [44, 58], [34, 62], [42, 63]]) {
    ctx.beginPath();
    ctx.ellipse(x, y, 2, 1, 0.4, 0, Math.PI * 2);
    ctx.fill();
  }
  // Sliced chicken fanned on the right.
  for (const [x, y] of [[58, 56], [64, 60], [70, 64]]) {
    drawQuadBlob(ctx, [x - 7, y, x, y - 8, x + 7, y, x, y + 4, x - 7, y], '#e8b37a');
    ctx.strokeStyle = '#c98a50';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x - 5, y);
    ctx.lineTo(x + 5, y);
    ctx.stroke();
  }
  // A herb sprig.
  drawQuadBlob(ctx, [52, 50, 56, 42, 60, 48, 56, 52, 52, 50], '#7aa865');
}

function drawOmuriceIcon(ctx) {
  drawRicePlate(ctx);
  // The omelette blanket: a fat golden oval over the rice.
  ctx.fillStyle = '#f7d774';
  ctx.strokeStyle = '#e0b84a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(50, 58, 28, 15, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.beginPath();
  ctx.ellipse(42, 52, 10, 4, -0.2, 0, Math.PI * 2);
  ctx.fill();
  // A ketchup heart on top.
  ctx.fillStyle = '#d0453a';
  ctx.beginPath();
  ctx.moveTo(50, 66);
  ctx.bezierCurveTo(38, 58, 42, 48, 50, 54);
  ctx.bezierCurveTo(58, 48, 62, 58, 50, 66);
  ctx.fill();
}

const DISH_ICON_DRAWERS = {
  'Garden Salad': drawGardenSaladIcon,
  'Grilled Cheese': drawGrilledCheeseIcon,
  'Burger': drawBurgerIcon,
  'Pancakes': drawPancakesIcon,
  'Roast Chicken': drawRoastChickenIcon,
  'Pasta': drawPastaIcon,
  'Steak Dinner': drawSteakDinnerIcon,
  'Soufflé': drawSouffleIcon,
  'Chicken Rice': drawChickenRiceIcon,
  'Omurice': drawOmuriceIcon,
  "Mel's Usual": drawMelsUsualIcon,
  "Olive & Oliver's Order": drawCoupleOrderIcon,
};

// v3.9: raw ingredients (Fridge/Cabinet items, held before they're cooked
// or assembled into a finished dish) also get icons — see that changelog
// note for why this was originally scoped out, then brought back in after
// the user pointed out that carrying raw ingredients (e.g. "Cheese, Milk"
// walking to the stove) is what a player actually sees far more often than
// the brief moment of holding a finished dish. One small icon function per
// FRIDGE_INGREDIENTS/CABINET_INGREDIENTS name (rules.js) — deliberately
// simpler than the dish icons above (1-2 shapes, not a whole composed
// scene), since these render much smaller, several at once in a row.

function drawCheeseIcon(ctx) {
  ctx.fillStyle = '#f7d774';
  ctx.beginPath();
  ctx.moveTo(30, 40);
  ctx.lineTo(75, 55);
  ctx.lineTo(75, 76);
  ctx.lineTo(30, 76);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#e0a458';
  for (const [x, y, r] of [[50, 58, 3], [63, 68, 2.5], [40, 66, 2]]) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawMilkIcon(ctx) {
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#d8dce0';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(35, 30);
  ctx.lineTo(65, 30);
  ctx.lineTo(65, 40);
  ctx.lineTo(72, 50);
  ctx.lineTo(72, 78);
  ctx.lineTo(28, 78);
  ctx.lineTo(28, 50);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#bcdcf2';
  ctx.fillRect(28, 58, 44, 12);
}

function drawChickenIcon(ctx) {
  ctx.fillStyle = '#e8b8a0';
  ctx.beginPath();
  ctx.ellipse(54, 55, 20, 16, 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#f4e0d0';
  ctx.beginPath();
  ctx.ellipse(28, 68, 8, 5, 0.5, 0, Math.PI * 2);
  ctx.fill();
}

function drawPattyIcon(ctx) {
  ctx.fillStyle = '#c98a72';
  ctx.strokeStyle = '#a86a54';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.ellipse(50, 55, 26, 16, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

function drawSteakIngredientIcon(ctx) {
  ctx.fillStyle = '#b2564a';
  ctx.beginPath();
  ctx.moveTo(28, 50);
  ctx.quadraticCurveTo(40, 35, 60, 42);
  ctx.quadraticCurveTo(75, 48, 70, 62);
  ctx.quadraticCurveTo(55, 72, 35, 66);
  ctx.quadraticCurveTo(24, 60, 28, 50);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.beginPath();
  ctx.ellipse(50, 54, 14, 7, 0.2, 0, Math.PI * 2);
  ctx.fill();
}

function drawLettuceIcon(ctx) {
  ctx.fillStyle = '#8fbf7f';
  ctx.beginPath();
  ctx.arc(50, 55, 22, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#6fa060';
  ctx.lineWidth = 1.5;
  for (const [x, y] of [[38, 44], [60, 46], [44, 66], [62, 62]]) {
    ctx.beginPath();
    ctx.moveTo(50, 55);
    ctx.lineTo(x, y);
    ctx.stroke();
  }
}

function drawTomatoIcon(ctx) {
  ctx.fillStyle = '#e0685a';
  ctx.beginPath();
  ctx.arc(50, 58, 22, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#8fbf7f';
  ctx.beginPath();
  ctx.moveTo(42, 38);
  ctx.lineTo(50, 30);
  ctx.lineTo(58, 38);
  ctx.lineTo(50, 42);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.beginPath();
  ctx.arc(42, 50, 4, 0, Math.PI * 2);
  ctx.fill();
}

function drawEggIcon(ctx) {
  ctx.fillStyle = '#fdf1e4';
  ctx.strokeStyle = '#e6d3b8';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(50, 55, 20, 26, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#ffd23f';
  ctx.beginPath();
  ctx.arc(50, 55, 10, 0, Math.PI * 2);
  ctx.fill();
}

function drawLemonadeIcon(ctx) {
  ctx.strokeStyle = '#c9a35a';
  ctx.lineWidth = 2.5;
  ctx.strokeRect(34, 28, 32, 50);
  ctx.fillStyle = '#e8b84b';
  ctx.fillRect(37, 42, 26, 34);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(58, 18);
  ctx.lineTo(58, 32);
  ctx.stroke();
}

function drawMatchaIcon(ctx) {
  ctx.strokeStyle = '#8a9a6e';
  ctx.lineWidth = 2.2;
  ctx.strokeRect(32, 32, 36, 44);
  ctx.fillStyle = '#7a8a5e';
  ctx.fillRect(35, 44, 30, 30);
}

function drawBreadIcon(ctx) {
  ctx.fillStyle = '#e0a458';
  ctx.beginPath();
  ctx.moveTo(26, 72);
  ctx.lineTo(26, 52);
  ctx.quadraticCurveTo(26, 32, 50, 30);
  ctx.quadraticCurveTo(74, 32, 74, 52);
  ctx.lineTo(74, 72);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#c9985a';
  ctx.lineWidth = 1.5;
  for (const x of [36, 50, 64]) {
    ctx.beginPath();
    ctx.moveTo(x, 40);
    ctx.lineTo(x, 60);
    ctx.stroke();
  }
}

function drawFlourIcon(ctx) {
  ctx.fillStyle = '#fdf6ea';
  ctx.strokeStyle = '#e6d9bc';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(32, 34);
  ctx.lineTo(68, 34);
  ctx.lineTo(72, 76);
  ctx.lineTo(28, 76);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = '#c9a35a';
  ctx.beginPath();
  ctx.moveTo(36, 34);
  ctx.lineTo(40, 24);
  ctx.moveTo(64, 34);
  ctx.lineTo(60, 24);
  ctx.stroke();
  ctx.fillStyle = '#c9a35a';
  ctx.fillRect(40, 50, 20, 12);
}

function drawNoodlesIcon(ctx) {
  ctx.strokeStyle = '#f0d9a0';
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(28, 45);
  ctx.quadraticCurveTo(45, 30, 40, 50);
  ctx.quadraticCurveTo(55, 60, 50, 42);
  ctx.quadraticCurveTo(65, 50, 60, 68);
  ctx.stroke();
  ctx.lineCap = 'butt';
}

function drawHerbsIcon(ctx) {
  ctx.strokeStyle = '#7a8a5e';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(50, 75);
  ctx.lineTo(50, 30);
  ctx.stroke();
  for (const [x, y, dir] of [[50, 45, -1], [50, 55, 1], [50, 65, -1]]) {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + dir * 14, y - 8);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y + 6);
    ctx.lineTo(x - dir * 14, y - 2);
    ctx.stroke();
  }
  ctx.lineCap = 'butt';
}

function drawBunsIcon(ctx) {
  ctx.fillStyle = '#e8b968';
  ctx.beginPath();
  ctx.arc(38, 55, 16, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(64, 55, 16, 0, Math.PI * 2);
  ctx.fill();
}

function drawSauceIcon(ctx) {
  ctx.strokeStyle = '#a35a2c';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(38, 30);
  ctx.lineTo(62, 30);
  ctx.lineTo(62, 38);
  ctx.lineTo(70, 46);
  ctx.lineTo(70, 74);
  ctx.lineTo(30, 74);
  ctx.lineTo(30, 46);
  ctx.lineTo(38, 38);
  ctx.closePath();
  ctx.stroke();
  ctx.fillStyle = '#c65f7c';
  ctx.fillRect(32, 50, 36, 22);
}

function drawPotatoIcon(ctx) {
  ctx.fillStyle = '#e8d4a0';
  ctx.beginPath();
  ctx.ellipse(50, 55, 24, 18, 0.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(180,140,80,0.4)';
  for (const [x, y] of [[40, 50], [58, 60], [45, 64]]) {
    ctx.beginPath();
    ctx.arc(x, y, 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * A two-tier cake silhouette (base + a lighter frosting layer, with a
 * drip line between them) — a real user report ("what is the pink
 * triangle food picture," repeated even after Star Cake's icon was
 * reused correctly elsewhere) showed the previous plain-triangle-wedge
 * shape simply doesn't read as "cake" to a player at a glance — a
 * triangle alone more commonly reads as a party hat or a warning sign.
 * A stacked-rectangle cake silhouette is a much more standard, immediate
 * "this is a cake" shape. `drawStarCakeIcon` below reuses this directly
 * and only adds a star topper, so the two stay visually related (both
 * "cake") while the topper is what tells them apart.
 */
function drawCakeIcon(ctx) {
  drawRoundRect(ctx, 22, 52, 56, 24, 6, '#f7b8cf'); // base tier
  drawRoundRect(ctx, 30, 34, 40, 20, 6, '#fdf1e4'); // frosting/top tier
  ctx.strokeStyle = '#e0a8c0';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(32, 44);
  ctx.lineTo(68, 44);
  ctx.stroke();
}

/** Plain Cake, plus a gold star topper — the star (not the shape) is what marks this specifically as Star Cake. */
function drawStarCakeIcon(ctx) {
  drawCakeIcon(ctx);
  drawStar(ctx, 50, 20, 9, 4, '#ffd23f');
}

/** Raw ingredient name -> icon drawer, one entry per FRIDGE_INGREDIENTS/CABINET_INGREDIENTS name (rules.js). */
function drawRiceIcon(ctx) {
  // A burlap-ish rice sack, top tied off, a few grains spilling out.
  ctx.fillStyle = '#efe2c4';
  ctx.strokeStyle = '#c9b48a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(34, 34);
  ctx.quadraticCurveTo(24, 58, 30, 80);
  ctx.lineTo(70, 80);
  ctx.quadraticCurveTo(76, 58, 66, 34);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#c9b48a';
  ctx.fillRect(38, 28, 24, 7);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.ellipse(50, 26, 10, 5, 0, Math.PI, 0);
  ctx.fill();
  ctx.fillStyle = '#9a7a4a';
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('米', 50, 58);
  ctx.fillStyle = '#ffffff';
  for (const [x, y] of [[76, 82], [82, 78], [20, 82]]) {
    ctx.beginPath();
    ctx.ellipse(x, y, 2.5, 1.3, 0.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Cookware icons — Pan/Baking Tray/Rice Cooker (rules.js's COOKWARE_ITEMS),
// shown in the Cookware Closet panel and on the HUD's "cookware in hand"
// pill once picked up. Same 100x100 local-box convention as every icon above.

function drawPanIcon(ctx) {
  ctx.fillStyle = '#5a4a44';
  ctx.beginPath();
  ctx.ellipse(42, 56, 28, 22, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#7a6a62';
  ctx.beginPath();
  ctx.ellipse(42, 54, 22, 17, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.beginPath();
  ctx.ellipse(34, 48, 8, 4, -0.5, 0, Math.PI * 2);
  ctx.fill();
  drawRoundRect(ctx, 66, 50, 28, 8, 4, '#8a5a3a');
}

function drawBakingTrayIcon(ctx) {
  drawRoundRect(ctx, 14, 34, 72, 40, 6, '#a7aeb6');
  drawRoundRect(ctx, 20, 40, 60, 28, 4, '#c7ced6');
  ctx.strokeStyle = '#8a929a';
  ctx.lineWidth = 2;
  ctx.strokeRect(20, 40, 60, 28);
  // Side handles.
  drawRoundRect(ctx, 6, 46, 10, 16, 4, '#8a929a');
  drawRoundRect(ctx, 84, 46, 10, 16, 4, '#8a929a');
}

function drawRiceCookerIcon(ctx) {
  // Body, lid, steam vent, and a little front panel with a light.
  drawRoundRect(ctx, 22, 40, 56, 44, 14, '#f5f0e6');
  ctx.strokeStyle = '#d6cbb6';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(22, 40, 56, 44, 14);
  ctx.stroke();
  ctx.fillStyle = '#f0c6cf';
  ctx.beginPath();
  ctx.ellipse(50, 40, 28, 10, 0, Math.PI, 0);
  ctx.fill();
  ctx.stroke();
  drawRoundRect(ctx, 44, 24, 12, 6, 3, '#d6cbb6');
  drawRoundRect(ctx, 38, 58, 24, 14, 4, '#e6ddcc');
  ctx.fillStyle = '#7fd68a';
  ctx.beginPath();
  ctx.arc(44, 65, 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#e06a5b';
  ctx.beginPath();
  ctx.arc(56, 65, 2.5, 0, Math.PI * 2);
  ctx.fill();
}

const COOKWARE_ICON_DRAWERS = {
  Pan: drawPanIcon,
  'Baking Tray': drawBakingTrayIcon,
  'Rice Cooker': drawRiceCookerIcon,
};

const INGREDIENT_ICON_DRAWERS = {
  Cheese: drawCheeseIcon,
  Milk: drawMilkIcon,
  Chicken: drawChickenIcon,
  Patty: drawPattyIcon,
  Steak: drawSteakIngredientIcon,
  Lettuce: drawLettuceIcon,
  Tomato: drawTomatoIcon,
  Egg: drawEggIcon,
  Lemonade: drawLemonadeIcon,
  Matcha: drawMatchaIcon,
  Bread: drawBreadIcon,
  Flour: drawFlourIcon,
  Noodles: drawNoodlesIcon,
  Herbs: drawHerbsIcon,
  Buns: drawBunsIcon,
  Sauce: drawSauceIcon,
  Potato: drawPotatoIcon,
  Rice: drawRiceIcon,
  'Star Cake': drawStarCakeIcon,
  Cake: drawCakeIcon,
};

/** Runs `drawer` translated/scaled so it can draw in its native 100x100 box centered at (cx, cy), `size` px square. */
function drawIconAt(ctx, cx, cy, size, drawer) {
  const s = size / 100;
  ctx.save();
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(s, s);
  drawer(ctx);
  ctx.restore();
}

/**
 * Draws `dishName`'s icon centered at (cx, cy), `size` px square. No-op
 * (draws nothing) for an unrecognized name rather than throwing, so a
 * future dish added to rules.js without a matching icon here just shows
 * nothing instead of crashing the render loop.
 */
function drawDishIcon(ctx, cx, cy, dishName, size) {
  const drawer = DISH_ICON_DRAWERS[dishName];
  if (drawer) drawIconAt(ctx, cx, cy, size, drawer);
}

/** Same contract as drawDishIcon, for a raw ingredient name instead. */
function drawIngredientIcon(ctx, cx, cy, ingredientName, size) {
  const drawer = INGREDIENT_ICON_DRAWERS[ingredientName];
  if (drawer) drawIconAt(ctx, cx, cy, size, drawer);
}

// ---------------------------------------------------------------------------
// Characters — v4 art pass ("make the art style similar to the library
// game"): every person is drawn by the renderer Library Shift uses
// (../shared/people.js's drawPerson: a wide rounded torso the head sits on,
// hands, shoes, a ground shadow, and a personality-driven face/hair/outfit),
// replacing v3.3's drawPixelPerson/drawAnimeFace. Regular customers now get
// one of the shared PEOPLE_TEMPLATES designs instead of one recolored body.
// ---------------------------------------------------------------------------

/** Kitchen Shift's own named characters, in shared/people.js's personality shape. */
const KITCHEN_PEOPLE = {
  server: {
    bodyColor: '#6fa0d8', pantsColor: '#3a4a5a', headColor: '#f4c99a', hairColor: '#3a2a1a', accentColor: '#ffffff',
    eyeColor: '#2a2a2a', eyeShape: 'bigRound', browAngle: 0.3, mouthCurve: 1.1, blush: true,
    hairStyle: 'bun', outfit: 'apron', accessory: 'ribbon', shoeColor: '#5a3a2a',
  },
  mel: {
    bodyColor: '#fff3c4', pantsColor: '#ffffff', headColor: '#f6dcb8', hairColor: '#e8b84b', accentColor: '#ffffff',
    eyeColor: '#3a2a2a', eyeShape: 'bigRound', browAngle: 0.5, mouthCurve: 1.5, blush: true,
    hairStyle: 'bun', outfit: 'none', accessory: 'ribbon', shoeColor: '#e8b84b',
  },
  olive: {
    bodyColor: OLIVE_FAVORITE_COLOR, pantsColor: '#fdf1e4', headColor: '#f6dcc0', hairColor: '#7a4a2e', accentColor: '#ffffff',
    eyeColor: '#2a3a2a', eyeShape: 'bigRound', browAngle: 0.3, mouthCurve: 1.1, blush: true,
    hairStyle: 'long', outfit: 'dress', accessory: 'ribbon', shoeColor: '#5a3a22',
  },
  oliver: {
    bodyColor: OLIVER_FAVORITE_COLOR, pantsColor: '#2c3140', headColor: '#f6dcc0', hairColor: '#33261a',
    eyeColor: '#2a2a3a', eyeShape: 'roundSmall', browAngle: 0.2, mouthCurve: 0.9, blush: false,
    hairStyle: 'sidePart', outfit: 'collar', shoeColor: '#1e1e1e',
  },
  counterStaff: {
    bodyColor: '#f2d98a', pantsColor: '#5a3a22', headColor: '#e0ac69', hairColor: '#3a2a1a', accentColor: '#fdf8ee',
    eyeColor: '#2a2a2a', eyeShape: 'roundSmall', browAngle: 0.3, mouthCurve: 1, blush: true,
    hairStyle: 'bangs', outfit: 'apron', shoeColor: '#3a2a1a',
  },
  guard: {
    bodyColor: '#4a5468', pantsColor: '#242c38', headColor: '#a8754a', hairColor: '#14181f', accentColor: '#e0c25a',
    hatColor: '#242c38', eyeColor: '#1a1a1a', eyeShape: 'narrow', browAngle: -0.4, mouthCurve: 0, blush: false,
    hairStyle: 'beanie', outfit: 'uniform', shoeColor: '#14181f',
  },
};

/** Designs a regular (non-scripted) customer can have — every shared design except Karen. */
const CUSTOMER_LOOK_KEYS = Object.keys(PEOPLE_TEMPLATES).filter((key) => key !== 'karen');

function drawKitchenPerson(ctx, x, y, key, opts = {}) {
  const personality = KITCHEN_PEOPLE[key] || PEOPLE_TEMPLATES[key] || PEOPLE_TEMPLATES.shyStudent;
  drawPerson(ctx, x, y, personality, opts);
}

/**
 * Mel: sweet, kind, and caring — favorite color a soft creamy light
 * yellow and white, favorite flowers dandelions/tulips/roses. Her usual
 * outfit (all per the user's description): a dandelion tucked behind her
 * ear, a yellow hair clip, her hair tied up in a white ribbon, a yellow
 * shirt with a small flower pattern, and a plain white skirt — drawn on
 * top of the shared body (shared/people.js's head sits at y - 34*s).
 */
function drawMel(ctx, x, y, scale) {
  const s = scale;
  drawKitchenPerson(ctx, x, y, 'mel', { scale: s });
  const headY = y - 34 * s;

  // Plain white skirt over the hips.
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(x - 10 * s, y - 8 * s);
  ctx.lineTo(x + 10 * s, y - 8 * s);
  ctx.lineTo(x + 13 * s, y + 1 * s);
  ctx.lineTo(x - 13 * s, y + 1 * s);
  ctx.closePath();
  ctx.fill();

  // Small flower pattern on her shirt.
  ctx.fillStyle = '#f6a6c1';
  [[-5, -20], [4, -16], [-2, -12]].forEach(([dx, dy]) => {
    ctx.beginPath();
    ctx.arc(x + dx * s, y + dy * s, 1.3 * s, 0, Math.PI * 2);
    ctx.fill();
  });

  // Yellow hair clip.
  drawRoundRect(ctx, x - 6 * s, headY - 8 * s, 4.5 * s, 2 * s, 1 * s, MEL_FAVORITE_COLOR);

  // A dandelion tucked behind her ear — a small cream puff with a few wisps.
  const fx = x - 11 * s;
  const fy = headY - 2 * s;
  ctx.fillStyle = '#fdfaf0';
  ctx.beginPath();
  ctx.arc(fx, fy, 3 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#fdfaf0';
  ctx.lineWidth = Math.max(1, s * 0.6);
  for (const angle of [-0.6, 0, 0.6]) {
    ctx.beginPath();
    ctx.moveTo(fx, fy);
    ctx.lineTo(fx - Math.sin(angle) * 4 * s, fy - Math.cos(angle) * 4 * s);
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// init()
// ---------------------------------------------------------------------------

/**
 * Wires up the canvas game loop against a page's DOM elements.
 *
 * DOM contract:
 *   hud: { shift, clock, status } — Sanity is drawn on-canvas (drawSanityBar), not in the HUD.
 *   orderQueue                    — <ul> repopulated with the active order/pending-customer list every frame.
 *   hoverHint                     — shown/hidden with the hovered station's name/status (mouse-hover tooltip, not a "press key" prompt).
 *   toast                         — brief transient message banner (e.g. missing-ingredient hints, Karen's line).
 *   introScreen: { root, line, continueButton } — the one-time walk-in intro dialogue box (see playIntro()).
 *   fullscreenButton              — toggles Fullscreen API on the game container.
 *   roomButton (optional)         — instant Dining/Kitchen room switch shortcut; label/aria-pressed follow the current room.
 *   recipeBookButton              — opens the recipe book (see below); available before and during a shift.
 *   recipeBook: { root, list, closeButton } — a static reference list of every known dish, rendered once. `root` also closes on a backdrop click (v3.24), same as closeButton.
 *   cookGauge: { root, button }   — the cook-timing mini-game's click-to-sample overlay.
 *   stationPanel: { root, title, list, closeButton } — fridge/cabinet/cookware-closet's browsable item picker. `root` also closes on a backdrop click (v3.24), same as closeButton.
 *   startScreen: { root, gard, bestMonth, level (optional), storageNotice (optional), shiftButton, shopButton (optional) }
 *   paycheckScreen: {
 *     root, title, outcome, shiftTotal, monthTotal,
 *     finalBlock, nameInput (optional), earningsInput (optional),
 *     shiftsInput (optional), submitButton (optional),
 *     nextShiftButton, newMonthButton, shopButton
 *   }
 *   shopScreen: {
 *     root, gard, closeButton, resetButton,
 *     gearItems: { [gearKey]: { levelText, costText, buyButton } }
 *   }
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} elements
 * @returns {() => void} a teardown function (also auto-invoked on htmx nav-away).
 */
export function init(canvas, elements) {
  if (typeof teardownActiveInstance === 'function') teardownActiveInstance();

  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true; // coquette look: soft curves, not blocky pixels
  const storageAvailable = probeStorageAvailable();
  let save = loadSave(storageAvailable);

  if (elements.startScreen.storageNotice) {
    elements.startScreen.storageNotice.classList.toggle('hidden', storageAvailable);
  }

  const random = Math.random;
  const world = { width: CANVAS_WIDTH, height: CANVAS_HEIGHT };
  // v3.15: table positions are laid out fresh per round tier (floor-plan.js's
  // buildStations now takes a level and lays out only the unlocked tables in
  // a centered box grid) — rebuilt in beginShift()/playIntro() below
  // whenever a shift (and therefore its tier) starts, not just once here.
  let stations = buildStations(TABLE_IDS, 1);

  let currentShiftNumber = save.currentShift;

  /** The floor-plan row level unlocked by the round tier `currentShiftNumber` falls in — read live everywhere table-unlocking gates behavior (capacity, spawn eligibility, hit-testing, rendering). */
  function currentTableUnlockLevel() {
    return tableUnlockLevelForShift(currentShiftNumber);
  }

  /** Rebuilds `stations`' table entries for the tier `currentShiftNumber` currently falls in — call after `currentShiftNumber` is set/changed, before anything reads `stations`. */
  function rebuildStationsForCurrentTier() {
    stations = buildStations(TABLE_IDS, currentTableUnlockLevel());
  }
  let shiftState = null;
  let player = { ...PLAYER_START };
  let currentRoom = ROOM_DINING; // ROOM_DINING | ROOM_KITCHEN — only this room's stations render/hit-test
  let moveTarget = null; // { x, y, station: station|null }
  let carryBobPhase = 0; // advances while walking; drives drawPlayerCarrying's up/down bob when heldDish is set
  let hoverStation = null;
  let pendingCustomers = {}; // { [tableId]: dishName }
  let inventory = []; // raw ingredient names
  let cookware = new Set(); // acquired this shift, never consumed
  let heldDish = null; // finished dish name, or null
  let activeOrderTableId = null; // which order gathering/cooking currently targets
  let cookMiniGame = null; // { dishName, station, gaugePosition, direction, zone }
  let closingTimer = null; // { stationId, kind: 'table'|'cleaning-closet', tableId?, remaining }
  let activePanel = null; // 'fridge' | 'cabinet' | 'cookware' | null
  let recipeBookOpen = false;
  let karen = null; // { tableId } while her order is live and unresolved this shift
  // rules.js's karenEncounter() for the current shift (line/patience/tip —
  // shift 18's rematch differs from shift 12's), or null on any other shift.
  let karenThisShift = null;
  let mel = null; // { tableId } while her order is live and unresolved this shift
  let melSpawnedThisShift = false; // guaranteed once per shift, but v3.35 randomizes *when* — see maybeSpawnCustomer
  let couple = null; // { tableId } while Olive & Oliver's order is live and unresolved this shift
  let coupleSpawnedThisShift = false; // guaranteed once per shift, but v3.35 randomizes *when* — see maybeSpawnCustomer
  let orderBubble = null; // { tableId, dishName, remaining } — a brief speech bubble shown the moment an order is taken (v3.12)
  // v3.28: independent of shiftState.orders/tables — a served customer is
  // already cleared from the table (serveDish) the instant they're spawned
  // here, so this is purely a cosmetic walk-to-counter-pay-leave animation
  // layered on top, never blocking gameplay at the table itself. Each entry:
  // { x, y, targetX, targetY, phase: 'walking'|'paying'|'leaving', elapsed, appearance }.
  let payingCustomers = [];
  // v3.36: "put animation when customer come from entrance/exit" — the
  // mirror image of payingCustomers' walk-out: before this, a newly
  // spawned customer (maybeSpawnCustomer/spawnKarenIfDue) appeared seated
  // at their table the instant they were picked, with no travel of their
  // own. Now they walk in from the same entrance/exit spot paying
  // customers walk out to (INTRO_ENTRANCE_POSITION) first, and only
  // "materialize" as a real pendingCustomers entry (visible/interactable,
  // patience/mel/couple/karen tracking all start) on arrival — see
  // spawnArrivingCustomer/updateArrivingCustomers. Each entry:
  // { x, y, targetX, targetY, tableId, appearance, dishName }.
  let arrivingCustomers = [];
  // v4: which shared design (CUSTOMER_LOOK_KEYS) each seated regular
  // customer has, by table — picked when they walk in, carried to their
  // walk-out (spawnPayingCustomer) so they look the same the whole visit.
  let customerLooks = {};
  let timeSinceCustomerSpawn = 0;
  // v3.34: the actual jittered wait `maybeSpawnCustomer` is counting down
  // to right now — re-rolled (jitteredArrivalIntervalSeconds) every time
  // timeSinceCustomerSpawn resets (beginShift, and each spawn attempt),
  // not recomputed fresh every single frame — that would just converge on
  // the jitter's lower bound instead of varying per customer, since the
  // very next frame after the wait elapsed would always see the smallest
  // possible re-roll. This placeholder value is only ever visible for the
  // instant before the first real "Start Shift" click.
  let nextCustomerArrivalSeconds = customerArrivalIntervalSeconds(1);
  let running = false;
  let rafHandle = null;
  let lastTimestamp = null;
  let paused = false;
  let toastTimeoutHandle = null;

  // -- Screen visibility -----------------------------------------------

  function showScreen(which) {
    elements.startScreen.root.classList.toggle('hidden', which !== 'start');
    elements.paycheckScreen.root.classList.toggle('hidden', which !== 'paycheck');
    elements.shopScreen.root.classList.toggle('hidden', which !== 'shop');
  }

  function showToast(text, seconds = 2.5) {
    elements.toast.textContent = text;
    elements.toast.classList.remove('hidden');
    if (toastTimeoutHandle) window.clearTimeout(toastTimeoutHandle);
    toastTimeoutHandle = window.setTimeout(() => { elements.toast.classList.add('hidden'); }, seconds * 1000);
  }

  // -- Start screen -------------------------------------------------------

  function renderStartScreen() {
    elements.startScreen.gard.textContent = `${save.monthToDateGard} Gard`;
    elements.startScreen.bestMonth.textContent = `${save.bestMonthTotal} Gard`;
    if (elements.startScreen.level) {
      elements.startScreen.level.textContent = roundTierStars(roundTier(save.currentShift));
    }
    elements.startScreen.shiftButton.textContent = save.currentShift > 1
      ? `Resume Shift ${save.currentShift}`
      : 'Start Shift';
    showScreen('start');
  }

  // -- Shop -----------------------------------------------------------

  function renderShop() {
    elements.shopScreen.gard.textContent = `${save.monthToDateGard} Gard`;
    Object.keys(GEAR_DEFS).forEach((key) => {
      const row = elements.shopScreen.gearItems[key];
      if (!row) return;
      const level = save.gear[key];
      const def = GEAR_DEFS[key];
      const maxed = level >= def.maxLevel;
      row.levelText.textContent = String(level);
      row.costText.textContent = maxed ? 'MAX' : String(gearCost(key, level));
      if (row.buyButton) {
        const affordable = !maxed && save.monthToDateGard >= gearCost(key, level);
        row.buyButton.disabled = !affordable;
        row.buyButton.classList.toggle('opacity-50', !affordable);
      }
    });
  }

  function buyGear(key) {
    const def = GEAR_DEFS[key];
    if (!def) return;
    const level = save.gear[key];
    if (level >= def.maxLevel) return;
    const cost = gearCost(key, level);
    if (save.monthToDateGard < cost) return;
    save.monthToDateGard -= cost;
    save.gear[key] = level + 1;
    persistSave(storageAvailable, save);
    renderShop();
  }

  function openShop() {
    renderShop();
    showScreen('shop');
  }

  function resetProgress() {
    if (!window.confirm('Reset all Kitchen Shift progress? This clears your Gard, shop levels, and best month total, and cannot be undone.')) {
      return;
    }
    save = defaultSave();
    persistSave(storageAvailable, save);
    renderShop();
    renderStartScreen();
  }

  // -- HUD / order queue / hover hint --------------------------------------

  function renderHud() {
    elements.hud.shift.textContent = `${currentShiftNumber}/${SHIFTS_PER_MONTH}`;
    elements.hud.clock.textContent = inGameTimeLabel(shiftState.clockSeconds, shiftClockSecondsForShift(currentShiftNumber));
    elements.hud.status.textContent = shiftState.shiftUpset ? 'Customer upset' : 'Going well';
  }

  function renderOrderQueue() {
    const items = [];
    for (const tableId of TABLE_IDS) {
      const pendingDish = pendingCustomers[tableId];
      if (pendingDish) {
        const isKarenTable = karen && karen.tableId === tableId;
        const isMelTable = mel && mel.tableId === tableId;
        const isCoupleTable = couple && couple.tableId === tableId;
        const suffix = isKarenTable ? ' — looks upset already' : (isMelTable ? ' — it\'s Mel!' : (isCoupleTable ? ' — Olive & Oliver' : ''));
        items.push({ text: `Table ${tableId}: wants to order (${pendingDish})${suffix}`, active: false });
      }
    }
    for (const order of shiftState.orders) {
      const secondsLeft = Math.max(0, Math.ceil(order.patienceRemainingSeconds));
      const isKarenTable = karen && karen.tableId === order.tableId;
      const isMelTable = mel && mel.tableId === order.tableId;
      const isCoupleTable = couple && couple.tableId === order.tableId;
      let label = `Table ${order.tableId}: `;
      if (isKarenTable) label = `Table ${order.tableId} (Karen!): `;
      else if (isMelTable) label = `Table ${order.tableId} (Mel): `;
      else if (isCoupleTable) label = `Table ${order.tableId} (Olive & Oliver): `;
      items.push({
        text: `${label}${order.dishName} — ${secondsLeft}s`,
        active: order.tableId === activeOrderTableId,
      });
    }

    elements.orderQueue.textContent = '';
    if (items.length === 0) {
      const li = document.createElement('li');
      li.className = 'text-muted';
      li.textContent = 'No orders yet.';
      elements.orderQueue.appendChild(li);
      return;
    }
    for (const item of items) {
      const li = document.createElement('li');
      if (item.active) li.className = 'font-semibold text-ink';
      li.textContent = item.text;
      elements.orderQueue.appendChild(li);
    }
  }

  function hoverHintFor(station) {
    if (!station) return '';
    if (station.kind === 'table') {
      const pendingDish = pendingCustomers[station.tableId];
      if (pendingDish) return `Table ${station.tableId}: wants to order`;
      const order = shiftState.orders.find((o) => o.tableId === station.tableId);
      if (order) return `Table ${station.tableId}: ${order.dishName}`;
      const t = shiftState.tables[station.tableId];
      if (t && t.dirty) return `Table ${station.tableId}: dirty`;
      return `Table ${station.tableId}`;
    }
    if (station.kind === 'boss-office' && shiftState.phase !== 'paycheck') return "Duke's Office (locked)";
    if (station.kind === 'counter' && shiftState.phase !== 'closing-shutdown') return 'Counter';
    return STATION_LABELS[station.kind] || '';
  }

  function updateHoverHint() {
    const text = hoverHintFor(hoverStation);
    // "(Enter)" surfaces the keyboard shortcut onKeyDown implements — click
    // this station, or press Enter while it's hovered, do the same thing.
    if (text) {
      elements.hoverHint.textContent = `${text} (Enter)`;
      elements.hoverHint.classList.remove('hidden');
    } else {
      elements.hoverHint.classList.add('hidden');
    }
  }

  // -- Station panels (fridge / cabinet / cookware closet) ----------------

  const PANEL_ITEMS = { fridge: FRIDGE_INGREDIENTS, cabinet: CABINET_INGREDIENTS, cookware: COOKWARE_ITEMS };
  const PANEL_TITLES = { fridge: 'Fridge', cabinet: 'Cabinet', cookware: 'Cookware Closet' };

  function pickIngredient(item) {
    if (inventory.length >= carryCapacityForSave(save)) {
      showToast('Tray full');
      return;
    }
    inventory.push(item);
    maybeAutoAssembleActiveDish();
  }

  function pickCookware(item) {
    cookware.add(item);
  }

  function maybeAutoAssembleActiveDish() {
    if (activeOrderTableId == null) return;
    const order = shiftState.orders.find((o) => o.tableId === activeOrderTableId);
    if (!order) return;
    const dish = findDish(order.dishName);
    if (!dish || dish.station !== 'none') return;
    if (missingIngredientsForDish(dish, inventory).length === 0) {
      inventory = removeDishIngredientsFromInventory(dish, inventory);
      heldDish = dish.name;
    }
  }

  function renderPanel() {
    if (!activePanel) return;
    elements.stationPanel.title.textContent = PANEL_TITLES[activePanel];
    elements.stationPanel.list.textContent = '';
    for (const item of PANEL_ITEMS[activePanel]) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      const owned = activePanel === 'cookware' && cookware.has(item);
      button.className = 'flex w-full items-center gap-2 rounded-card border border-line bg-surface px-3 py-2 text-left text-sm text-ink transition-colors duration-150 hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50';
      if (owned) button.disabled = true;

      // Fridge/Cabinet items reuse the same canvas-drawn icons already used
      // on the tray/order bubble (this project has no image-generation
      // tooling, so every icon is a procedural drawer taking a plain 2D
      // context — a small offscreen <canvas> works just as well as the
      // main game canvas). Cookware Closet items use COOKWARE_ICON_DRAWERS.
      const drawer = INGREDIENT_ICON_DRAWERS[item] || COOKWARE_ICON_DRAWERS[item];
      if (drawer) {
        // Bumped up from an initial 24px (reported "too small... hard to
        // see") to 44px — big enough to actually read the icon's shape at
        // a glance, not just register as a colored dot.
        const iconCanvas = document.createElement('canvas');
        iconCanvas.width = 44;
        iconCanvas.height = 44;
        iconCanvas.className = 'shrink-0';
        drawIconAt(iconCanvas.getContext('2d'), 22, 22, 40, drawer);
        button.appendChild(iconCanvas);
      }

      const label = document.createElement('span');
      label.textContent = owned ? `${item} ✓` : item;
      button.appendChild(label);

      button.addEventListener('click', () => {
        if (activePanel === 'cookware') pickCookware(item);
        else pickIngredient(item);
        renderPanel();
      });
      li.appendChild(button);
      elements.stationPanel.list.appendChild(li);
    }
  }

  function openPanel(kind) {
    activePanel = kind;
    renderPanel();
    elements.stationPanel.root.classList.remove('hidden');
  }

  function closePanel() {
    activePanel = null;
    elements.stationPanel.root.classList.add('hidden');
  }

  // -- Recipe book ------------------------------------------------------

  // Static content (every known dish never changes mid-session), so this
  // only actually builds the list once — reopening just toggles visibility.
  let recipeBookRendered = false;

  function describeDish(dish) {
    const station = dish.station === 'none' ? 'No cooking needed' : STATION_LABELS[dish.station];
    const cookware = dish.cookware ? ` + ${dish.cookware}` : '';
    return `${station}${cookware} — ${dish.ingredients.join(', ')}`;
  }

  function renderRecipeBook() {
    if (recipeBookRendered) return;
    recipeBookRendered = true;

    const addEntry = (name, dish, note) => {
      const li = document.createElement('li');
      li.className = 'rounded-card border border-line p-3';
      const title = document.createElement('p');
      title.className = 'text-sm font-medium text-ink';
      title.textContent = note ? `${name} (${note})` : name;
      const desc = document.createElement('p');
      desc.className = 'text-xs text-muted';
      desc.textContent = describeDish(dish);
      li.append(title, desc);
      elements.recipeBook.list.appendChild(li);
    };

    RECIPE_BANDS.forEach((band) => {
      band.dishes.forEach((dish) => addEntry(dish.name, dish, `unlocks shift ${band.minShift}`));
    });
    addEntry(MEL_DISH.name, MEL_DISH, "Mel's favorite — always her order");
    addEntry(COUPLE_DISH.name, COUPLE_DISH, "Olive & Oliver's favorite");
  }

  function openRecipeBook() {
    renderRecipeBook();
    recipeBookOpen = true;
    elements.recipeBook.root.classList.remove('hidden');
  }

  function closeRecipeBook() {
    recipeBookOpen = false;
    elements.recipeBook.root.classList.add('hidden');
  }

  // -- Shift lifecycle ------------------------------------------------

  function spawnKarenIfDue() {
    karen = null;
    karenThisShift = karenEncounter(currentShiftNumber);
    if (!karenThisShift) return;
    const availableTableIds = TABLE_IDS.filter((id) => !shiftState.tables[id].occupied);
    if (availableTableIds.length === 0) return;
    const tableId = availableTableIds[Math.floor(random() * availableTableIds.length)];
    const dishes = availableDishes(currentShiftNumber);
    const dish = dishes[Math.floor(random() * dishes.length)];
    // v3.36: she now walks in from the entrance like everyone else —
    // `karen = { tableId }` and her line firing are deferred to
    // updateArrivingCustomers' arrival branch, genuinely "the moment
    // she's seated" (customer rules doc) rather than the moment she was
    // picked, before she'd have walked in at all.
    spawnArrivingCustomer(tableId, 'karen', dish.name);
  }

  // "Start Shift"/"Start Next Shift"/"Start New Month" all funnel through
  // this gate: the very first time ever (hasSeenIntro still false), play
  // the one-time walk-in intro first; every other time, start the shift
  // immediately. "Reset progress" (resetProgress, below) clears
  // hasSeenIntro back to false along with the rest of the save, so the
  // intro replays once after a reset too — consistent with treating reset
  // as a fresh save, not a special case.
  function startShift() {
    requestFullscreen();
    if (!save.hasSeenIntro) {
      playIntro(beginShift);
    } else {
      beginShift();
    }
  }

  function playIntro(onComplete) {
    const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // A valid shiftState is needed for render() (drawSanityBar/drawStation/
    // drawTableContents all read it) — beginShift() below creates its own
    // fresh one afterward, so this one is only ever used for these
    // intro-scene frames.
    currentShiftNumber = save.currentShift;
    rebuildStationsForCurrentTier();
    shiftState = createInitialState(TABLE_IDS, { clockSeconds: shiftClockSecondsForShift(currentShiftNumber) });
    pendingCustomers = {};
    payingCustomers = [];
    arrivingCustomers = [];
    karen = null;
    mel = null;
    couple = null;
    player = reducedMotion ? { ...PLAYER_START } : { ...INTRO_ENTRANCE_POSITION };
    moveTarget = reducedMotion ? null : { x: PLAYER_START.x, y: PLAYER_START.y, station: null };

    showScreen(null);
    elements.introScreen.line.textContent = INTRO_DIALOGUE_LINE;
    // Stays hidden until the walk-in finishes — the dialogue card sits at
    // the bottom of the canvas, the same area the entrance-to-PLAYER_START
    // walk crosses, so showing it immediately would hide the player sprite
    // behind it for the whole walk. Revealed by introLoop below once
    // moveTarget clears (or immediately under reduced motion, where there's
    // no walk to watch in the first place).
    elements.introScreen.root.classList.add('hidden');
    render();

    let introRafHandle = null;
    let introLastTimestamp = null;
    function introLoop(timestamp) {
      if (introLastTimestamp === null) introLastTimestamp = timestamp;
      const deltaSeconds = Math.min(0.1, (timestamp - introLastTimestamp) / 1000);
      introLastTimestamp = timestamp;
      updatePlayer(deltaSeconds); // station: null on moveTarget, so arrival never calls handleArrival
      render();
      if (moveTarget) {
        introRafHandle = window.requestAnimationFrame(introLoop);
      } else {
        introRafHandle = null;
        elements.introScreen.root.classList.remove('hidden');
      }
    }
    if (!reducedMotion) {
      introRafHandle = window.requestAnimationFrame(introLoop);
    } else {
      elements.introScreen.root.classList.remove('hidden');
    }

    function dismiss() {
      if (introRafHandle !== null) {
        window.cancelAnimationFrame(introRafHandle);
        introRafHandle = null;
      }
      // Clicking "Continue" mid-walk finishes it instantly rather than
      // leaving the player stranded partway across the floor.
      player = { ...PLAYER_START };
      moveTarget = null;
      elements.introScreen.root.classList.add('hidden');
      elements.introScreen.continueButton.removeEventListener('click', dismiss);
      save.hasSeenIntro = true;
      persistSave(storageAvailable, save);
      onComplete();
    }
    elements.introScreen.continueButton.addEventListener('click', dismiss);
  }

  function beginShift() {
    currentShiftNumber = save.currentShift;
    rebuildStationsForCurrentTier();
    shiftState = createInitialState(TABLE_IDS, { clockSeconds: shiftClockSecondsForShift(currentShiftNumber) });
    player = { ...PLAYER_START };
    currentRoom = ROOM_DINING;
    updateRoomButton();
    moveTarget = null;
    pendingCustomers = {};
    payingCustomers = [];
    arrivingCustomers = [];
    customerLooks = {};
    counterGardThisShift = 0;
    lastSeenShiftGard = 0;
    gardPops = [];
    coffeePour = null;
    coffeeSplashSeconds = 0;
    resetHallucinations();
    inventory = [];
    cookware = new Set();
    heldDish = null;
    activeOrderTableId = null;
    cookMiniGame = null;
    closingTimer = null;
    activePanel = null;
    mel = null;
    melSpawnedThisShift = false;
    couple = null;
    coupleSpawnedThisShift = false;
    timeSinceCustomerSpawn = 0;
    nextCustomerArrivalSeconds = jitteredArrivalIntervalSeconds(customerArrivalIntervalSeconds(currentShiftNumber), random());
    lastTimestamp = null;
    running = true;
    paused = false;
    closePanel();
    elements.cookGauge.root.classList.add('hidden');
    showScreen(null);
    spawnKarenIfDue();
    renderHud();
    renderOrderQueue();
    if (rafHandle === null) rafHandle = window.requestAnimationFrame(loop);
  }

  function endShift() {
    running = false;
    if (rafHandle !== null) {
      window.cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }

    // v3.11: the payout now scales with mistakeCount (see rules.js's
    // shiftPaycheck) instead of the old flat 4,000/2,000 split — shiftUpset
    // itself is unchanged and still drives dataset.outcome below, kept for
    // that binary ok/upset UI state and the test hooks that already key off
    // it.
    // v4: Library Shift's payout — base paycheck for the mistake count plus
    // bonus Gard (Karen's tip, perfect pours) minus complaint letters, then
    // the 0-Sanity/0-Reputation pay cuts (engine-state.js's shiftPayout).
    const payoutParts = shiftPayout(shiftState);
    const paycheck = payoutParts.payout;
    save.monthToDateGard += paycheck;
    const isFinalShift = currentShiftNumber >= SHIFTS_PER_MONTH;
    if (isFinalShift) {
      save.bestMonthTotal = Math.max(save.bestMonthTotal, save.monthToDateGard);
    } else {
      // Round tiers (v3.14): driven directly by the shift about to start,
      // not a persisted lifetime stat — so this naturally resets to Tier 1
      // every "Start New Month" along with currentShift itself. See
      // docs/features/cooking-game-food-server-leveling.md.
      const tierBeforeNextShift = roundTier(currentShiftNumber);
      save.currentShift = currentShiftNumber + 1;
      const tierAfterNextShift = roundTier(save.currentShift);
      if (tierAfterNextShift > tierBeforeNextShift) {
        showToast(
          `Tier up! ${roundTierStars(tierAfterNextShift)} — ${unlockedTableCountForShift(save.currentShift)} tables now open, less time on the clock`,
          4,
        );
      }
    }
    persistSave(storageAvailable, save);

    elements.paycheckScreen.root.dataset.outcome = shiftState.shiftUpset ? 'upset' : 'ok';
    elements.paycheckScreen.root.dataset.final = isFinalShift ? 'true' : 'false';
    const outcomeParts = [shiftState.mistakeCount > 0
      ? `${shiftState.mistakeCount} mistake${shiftState.mistakeCount === 1 ? '' : 's'} — Duke saw the reviews`
      : 'Duke says great job'];
    if (payoutParts.bonusGard > 0) outcomeParts.push(`+${payoutParts.bonusGard}g bonus`);
    if (shiftState.complaints > 0) outcomeParts.push(`${shiftState.complaints} complaint letter${shiftState.complaints === 1 ? '' : 's'} (−${payoutParts.complaintGard}g)`);
    if (payoutParts.sanityMultiplier < 1) outcomeParts.push(`−${Math.round((1 - payoutParts.sanityMultiplier) * 100)}% for hallucinating`);
    if (payoutParts.reputationMultiplier < 1) outcomeParts.push(`−${Math.round((1 - payoutParts.reputationMultiplier) * 100)}% for a ruined reputation`);
    elements.paycheckScreen.outcome.textContent = outcomeParts.join(' · ');
    elements.paycheckScreen.shiftTotal.textContent = `${paycheck} Gard`;
    elements.paycheckScreen.monthTotal.textContent = `${save.monthToDateGard} Gard`;
    elements.paycheckScreen.nextShiftButton.classList.toggle('hidden', isFinalShift);
    elements.paycheckScreen.newMonthButton.classList.toggle('hidden', !isFinalShift);
    elements.paycheckScreen.finalBlock.classList.toggle('hidden', !isFinalShift);
    if (isFinalShift) {
      if (elements.paycheckScreen.earningsInput) elements.paycheckScreen.earningsInput.value = String(save.monthToDateGard);
      if (elements.paycheckScreen.shiftsInput) elements.paycheckScreen.shiftsInput.value = String(SHIFTS_PER_MONTH);
      if (elements.paycheckScreen.submitButton) elements.paycheckScreen.submitButton.disabled = false;
    }

    showScreen('paycheck');
  }

  function startNewMonth() {
    save.currentShift = 1;
    save.monthToDateGard = 0;
    persistSave(storageAvailable, save);
    startShift();
  }

  // -- Karen ripple effect ----------------------------------------------

  function triggerKarenRipple() {
    const others = shiftState.orders.filter((o) => o.tableId !== karen.tableId);
    if (others.length > 0) {
      const victim = others[Math.floor(random() * others.length)];
      shiftState = failOrderAt(shiftState, victim.tableId);
      showToast('Karen upset another table too!', 3);
    }
    karen = null;
  }

  // -- Customer sanity (v3.18) --------------------------------------------

  /**
   * Applies one annoyance to tableId's order via annoyCustomer, then reacts
   * to whatever happened: if the order is still there afterward, re-shows
   * the order bubble (the customer "repeats" their order) so the player
   * gets a fresh reminder of what they ordered; if the order is now GONE
   * (their sanity bottomed out and they walked out), applies the same
   * Karen-ripple/Mel/couple cleanup the main loop's tick() already does for
   * patience-timeout walkouts, so this event-driven walkout path isn't
   * treated any differently from a time-driven one.
   */
  function annoyCustomerAt(tableId) {
    const beforeOrder = shiftState.orders.find((o) => o.tableId === tableId);
    if (!beforeOrder) return;
    const dishName = beforeOrder.dishName;
    shiftState = annoyCustomer(shiftState, tableId);
    const stillHasOrder = shiftState.orders.some((o) => o.tableId === tableId);
    if (stillHasOrder) {
      orderBubble = { tableId, dishName, remaining: ORDER_BUBBLE_SECONDS };
      return;
    }
    if (karen && karen.tableId === tableId) triggerKarenRipple();
    if (mel && mel.tableId === tableId) mel = null;
    if (couple && couple.tableId === tableId) couple = null;
  }

  // -- Gard counter (v4, ported from Library Shift v2.15) -----------------
  //
  // A HUD pill beside the Sanity/Reputation bars: this shift's Gard so far
  // (Counter payments + bonus Gard such as Karen's tip or a perfect pour,
  // minus complaint letters) and the month-to-date total, with a floating
  // "+N g" pop each time it changes. The base paycheck isn't shown until
  // Duke's office, since mistakes decide it.

  let counterGardThisShift = 0;
  let lastSeenShiftGard = 0;
  let gardPops = []; // { amount, age }
  const GARD_POP_SECONDS = 1.4;

  /** Adds Gard to this shift's bonus (paid at Duke's office) — Karen's tip. */
  function earnBonusGard(amount) {
    shiftState = addBonusGard(shiftState, amount);
  }

  function netShiftGard() {
    if (!shiftState) return 0;
    return counterGardThisShift + (shiftState.bonusGard ?? 0) - (shiftState.complaints ?? 0) * COMPLAINT_GARD;
  }

  function trackGardPops(deltaSeconds) {
    const net = netShiftGard();
    if (net !== lastSeenShiftGard) {
      gardPops.push({ amount: net - lastSeenShiftGard, age: 0 });
      lastSeenShiftGard = net;
    }
    gardPops = gardPops.filter((pop) => {
      pop.age += deltaSeconds;
      return pop.age < GARD_POP_SECONDS;
    });
  }

  function drawGardCoin(cx, cy, r) {
    ctx.fillStyle = '#c28a2c';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f2cf6a';
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#a8741e';
    ctx.font = `bold ${Math.round(r)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('G', cx, cy + 0.5);
  }

  function drawGardCounter() {
    const x = 152;
    const y = 14;
    const w = 176;
    const h = 22;
    ctx.save();
    drawRoundRect(ctx, x, y, w, h, 11, 'rgba(255,251,246,0.85)');
    ctx.strokeStyle = 'rgba(58,42,42,0.3)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 11);
    ctx.stroke();
    drawGardCoin(x + 13, y + h / 2, 8);
    const net = netShiftGard();
    ctx.fillStyle = LABEL_TEXT_COLOR;
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${net >= 0 ? '+' : '−'}${Math.abs(net)}g shift`, x + 26, y + h / 2 + 0.5);
    ctx.globalAlpha = 0.7;
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`Month ${save.monthToDateGard}g`, x + w - 9, y + h / 2 + 0.5);
    ctx.globalAlpha = 1;
    for (const pop of gardPops) {
      const t = pop.age / GARD_POP_SECONDS;
      ctx.globalAlpha = 1 - t;
      ctx.font = 'bold 15px sans-serif';
      ctx.textAlign = 'center';
      const text = `${pop.amount > 0 ? '+' : '−'}${Math.abs(pop.amount)} g`;
      const py = y + h + 12 - t * 10;
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = 'rgba(255,251,246,0.95)';
      ctx.strokeText(text, x + 60, py);
      ctx.fillStyle = pop.amount > 0 ? '#b07a1e' : '#c0392b';
      ctx.fillText(text, x + 60, py);
    }
    ctx.restore();
  }

  // -- Coffee Pour minigame (v4, ported from Library Shift v2.2/v2.19) ---
  //
  // Arriving at the Coffee Machine opens an on-canvas pour: hold (mouse,
  // touch, Space or Enter) to pour, release inside the gold band. Overfill
  // to the brim and it spills all over you: −50 Sanity and coffee stains.

  const COFFEE_RESULT_SECONDS = 1.2;
  const COFFEE_SPLASH_SECONDS = 6;
  const COFFEE_RESULT_TEXT = {
    perfect: 'Perfect pour! Sanity fully restored, +10g tip.',
    good: 'Good pour — feeling sharper.',
    sloppy: 'Sloppy pour — it helps a little.',
    spilled: 'Ow! Hot coffee all over you — −50 Sanity.',
  };
  const COFFEE_RESULT_COLORS = { perfect: '#e0a83a', good: '#7fb0d6', sloppy: '#a08a7a', spilled: '#e06a5b' };

  let coffeePour = null; // { fill, pouring, band, grade, closeIn }
  let coffeeSplashSeconds = 0;

  function openCoffeePour() {
    coffeePour = { fill: 0, pouring: false, band: coffeePourTargetBand(random()), grade: null, closeIn: 0 };
    moveTarget = null;
  }

  function startCoffeePour() {
    if (coffeePour && !coffeePour.grade) coffeePour.pouring = true;
  }

  // Only grades a pour that actually started, so the keyup of whatever key
  // got the player here can't grade an empty cup.
  function stopCoffeePour() {
    if (coffeePour && coffeePour.pouring && !coffeePour.grade) finishCoffeePour();
  }

  function finishCoffeePour() {
    coffeePour.pouring = false;
    const grade = gradeCoffeePour(coffeePour.fill, coffeePour.band);
    coffeePour.grade = grade;
    coffeePour.closeIn = COFFEE_RESULT_SECONDS;
    shiftState = brewCoffee(shiftState, grade);
    if (grade === 'spilled') coffeeSplashSeconds = COFFEE_SPLASH_SECONDS;
    showToast(COFFEE_RESULT_TEXT[grade], 3);
  }

  function updateCoffeePour(deltaSeconds) {
    if (coffeeSplashSeconds > 0) coffeeSplashSeconds = Math.max(0, coffeeSplashSeconds - deltaSeconds);
    if (!coffeePour) return;
    if (shiftState.phase !== 'playing' && !coffeePour.grade) {
      coffeePour = null;
      return;
    }
    if (coffeePour.grade) {
      coffeePour.closeIn -= deltaSeconds;
      if (coffeePour.closeIn <= 0) coffeePour = null;
      return;
    }
    if (coffeePour.pouring) {
      coffeePour.fill = Math.min(1, coffeePour.fill + deltaSeconds / COFFEE_POUR_SECONDS_TO_BRIM);
      if (coffeePour.fill >= 1) finishCoffeePour();
    }
  }

  function onCanvasPointerDown(e) {
    if (!coffeePour) return;
    e.preventDefault();
    startCoffeePour();
  }

  function onWindowPointerUp() {
    stopCoffeePour();
  }

  function onKeyUp(e) {
    if (e.key === ' ' || e.key === 'Enter') stopCoffeePour();
  }

  /** Steaming coffee stains on the player's apron for a few seconds after a spill. */
  function drawCoffeeSplash(x, y, s) {
    if (coffeeSplashSeconds <= 0) return;
    ctx.save();
    ctx.globalAlpha = Math.min(1, coffeeSplashSeconds / 1.5);
    ctx.fillStyle = 'rgba(106,74,48,0.85)';
    for (const [dx, dy, r] of [[-5, -20, 3], [3, -16, 3.6], [-2, -11, 2.4], [6, -22, 2], [-7, -13, 1.8], [1, -24, 1.6]]) {
      ctx.beginPath();
      ctx.arc(x + dx * s, y + dy * s, r * s, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = Math.min(1, coffeeSplashSeconds / 1.5);
    ctx.translate(x, y);
    drawSteam([-4 * s, 4 * s], -24 * s, 12 * s, 0.8);
    ctx.restore();
  }

  function drawCoffeePourOverlay() {
    if (!coffeePour) return;
    const W = world.width;
    const H = world.height;
    ctx.save();
    ctx.fillStyle = 'rgba(40,28,20,0.45)';
    ctx.fillRect(0, 0, W, H);

    const panelW = 360;
    const panelH = 400;
    const px = (W - panelW) / 2;
    const py = (H - panelH) / 2;
    drawRoundRect(ctx, px, py, panelW, panelH, 18, '#f2e9da');
    ctx.strokeStyle = 'rgba(58,42,42,0.3)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(px, py, panelW, panelH, 18);
    ctx.stroke();

    ctx.fillStyle = LABEL_TEXT_COLOR;
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Coffee Pour', W / 2, py + 26);
    ctx.font = '12px sans-serif';
    ctx.fillText('Hold to pour — release in the gold band', W / 2, py + 44);
    ctx.globalAlpha = 0.7;
    ctx.font = '11px sans-serif';
    ctx.fillText('mouse, tap, Space or Enter', W / 2, py + 58);
    ctx.globalAlpha = 1;

    // Machine head + spout, LED red while pouring.
    const cx = W / 2;
    drawRoundRect(ctx, cx - 70, py + 68, 140, 34, 10, '#7a5a42');
    drawRoundRect(ctx, cx - 26, py + 100, 52, 14, 4, '#b0a090');
    ctx.fillStyle = coffeePour.pouring ? '#e06a5b' : '#9fe0a8';
    ctx.beginPath();
    ctx.arc(cx + 52, py + 82, 5, 0, Math.PI * 2);
    ctx.fill();
    if (coffeePour.pouring) {
      ctx.fillStyle = '#6a4a30';
      ctx.fillRect(cx - 3, py + 114, 6, 70);
    }

    // Tapered mug.
    const cupTop = py + 170;
    const cupBottom = py + 350;
    const topHalf = 72;
    const bottomHalf = 58;
    const mugPath = () => {
      ctx.beginPath();
      ctx.moveTo(cx - topHalf, cupTop);
      ctx.lineTo(cx + topHalf, cupTop);
      ctx.lineTo(cx + bottomHalf, cupBottom);
      ctx.quadraticCurveTo(cx, cupBottom + 10, cx - bottomHalf, cupBottom);
      ctx.closePath();
    };
    ctx.fillStyle = '#fdf8ee';
    mugPath();
    ctx.fill();
    ctx.strokeStyle = '#c9b896';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx + topHalf + 6, (cupTop + cupBottom) / 2, 26, -Math.PI / 2, Math.PI / 2);
    ctx.lineWidth = 8;
    ctx.strokeStyle = '#fdf8ee';
    ctx.stroke();

    // Coffee, clipped to the mug.
    const levelY = (fill) => cupBottom - fill * (cupBottom - cupTop);
    ctx.save();
    mugPath();
    ctx.clip();
    const surfaceY = levelY(Math.min(1, coffeePour.fill));
    ctx.fillStyle = '#6a4a30';
    ctx.fillRect(cx - topHalf, surfaceY, topHalf * 2, cupBottom - surfaceY + 12);
    if (coffeePour.fill > 0.02) {
      ctx.fillStyle = '#c49a6c';
      ctx.fillRect(cx - topHalf, surfaceY, topHalf * 2, 5);
    }
    ctx.restore();

    // Gold target band.
    const bandTop = levelY(coffeePour.band.max);
    const bandBottom = levelY(coffeePour.band.min);
    ctx.fillStyle = 'rgba(232,185,90,0.28)';
    ctx.fillRect(cx - topHalf - 14, bandTop, (topHalf + 14) * 2, bandBottom - bandTop);
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = '#e0a83a';
    ctx.lineWidth = 2;
    for (const by of [bandTop, bandBottom]) {
      ctx.beginPath();
      ctx.moveTo(cx - topHalf - 14, by);
      ctx.lineTo(cx + topHalf + 14, by);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.fillStyle = '#e0a83a';
    for (const dir of [-1, 1]) {
      const tx = cx + dir * (topHalf + 18);
      const ty = (bandTop + bandBottom) / 2;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx + dir * 9, ty - 6);
      ctx.lineTo(tx + dir * 9, ty + 6);
      ctx.closePath();
      ctx.fill();
    }

    if (coffeePour.grade === 'spilled') {
      ctx.fillStyle = '#6a4a30';
      for (const [dx, dy, r] of [[-80, -8, 6], [84, 4, 5], [-60, 30, 4], [70, 40, 5], [-95, 60, 3], [100, 70, 4]]) {
        ctx.beginPath();
        ctx.arc(cx + dx, cupTop + dy, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.ellipse(cx, cupBottom + 18, 120, 10, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (coffeePour.grade) {
      ctx.save();
      ctx.translate(cx, surfaceY - 4);
      drawSteam([-20, 0, 20], 0, 30, 0.9);
      ctx.restore();
    }

    if (coffeePour.grade) {
      const text = coffeePour.grade[0].toUpperCase() + coffeePour.grade.slice(1);
      drawRoundRect(ctx, cx - 60, py + panelH - 38, 120, 26, 13, COFFEE_RESULT_COLORS[coffeePour.grade]);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(text, cx, py + panelH - 24.5);
    }
    ctx.restore();
  }

  // -- Hallucinations (v4, ported from Library Shift v2.16) ---------------
  //
  // Below HALLUCINATION_START_SANITY the diner starts playing tricks —
  // shadow figures, whispers, a pulsing vignette, flickers, and ghost
  // customers sitting at empty tables (walk up to one and nobody's there:
  // −5 Sanity). At 0 Sanity: jump scares, shaky hands (narrower, faster
  // cook gauge), dropping what you carry, and a pay cut.

  const WHISPERS = [
    'table six is watching you',
    'did you hear the bell?',
    'the oven is calling your name',
    'nobody ordered that',
    'Duke knows',
    'behind you',
    'one more shift… one more shift…',
    'the soup is staring back',
  ];

  let halluc = { figures: [], whispers: [], ghosts: [], flicker: 0, scare: 0, ghostCounter: 0 };

  function currentIntensity() {
    return shiftState && shiftState.phase === 'playing' ? hallucinationIntensity(shiftState.sanity) : 0;
  }

  function resetHallucinations() {
    halluc = { figures: [], whispers: [], ghosts: [], flicker: 0, scare: 0, ghostCounter: 0 };
  }

  function ghostAtTable(tableId) {
    return halluc.ghosts.find((g) => g.tableId === tableId) || null;
  }

  function spawnGhostCustomer(life = 15) {
    const level = currentTableUnlockLevel();
    const free = TABLE_IDS.filter((id) => isTableUnlocked(id, level)
      && !shiftState.tables[id].occupied
      && !pendingCustomers[id]
      && !arrivingCustomers.some((c) => c.tableId === id)
      && !ghostAtTable(id));
    if (free.length === 0) return null;
    const ghost = {
      id: ++halluc.ghostCounter,
      tableId: free[Math.floor(random() * free.length)],
      look: CUSTOMER_LOOK_KEYS[Math.floor(random() * CUSTOMER_LOOK_KEYS.length)],
      age: 0,
      life,
    };
    halluc.ghosts.push(ghost);
    return ghost;
  }

  function updateHallucinations(deltaSeconds) {
    const age = (list) => list.filter((item) => {
      item.age += deltaSeconds;
      return item.age < item.life;
    });
    halluc.figures = age(halluc.figures);
    halluc.whispers = age(halluc.whispers);
    halluc.ghosts = age(halluc.ghosts);
    halluc.flicker = Math.max(0, halluc.flicker - deltaSeconds);
    halluc.scare = Math.max(0, halluc.scare - deltaSeconds);

    const i = currentIntensity();
    if (i <= 0) {
      // Sanity's back above the threshold (or the shift's over) — the
      // tricks stop at once.
      halluc.figures = [];
      halluc.whispers = [];
      halluc.ghosts = [];
      return;
    }
    const chance = (perSecond) => random() < perSecond * deltaSeconds;
    if (i > 0.3 && chance(0.35 * i)) {
      halluc.figures.push({ x: 80 + random() * (world.width - 160), y: 140 + random() * 380, age: 0, life: 0.8 + random() * 1.2 });
    }
    if (chance(0.3 * i)) {
      halluc.whispers.push({ text: WHISPERS[Math.floor(random() * WHISPERS.length)], x: 120 + random() * (world.width - 240), y: 120 + random() * 380, age: 0, life: 2.6 });
    }
    if (chance(0.12 * i)) halluc.flicker = 0.18;
    if (i >= 1 && chance(0.04)) halluc.scare = 0.45;
    if (currentRoom === ROOM_DINING && i >= 0.5 && halluc.ghosts.length === 0 && chance(0.06 * i)) spawnGhostCustomer();
    if (!cookMiniGame && !coffeePour && (heldDish || inventory.length > 0) && chance(CARRY_DROP_CHANCE_PER_SECOND * i)) {
      if (heldDish) {
        showToast(`Your hands shake — you dropped the ${heldDish}!`, 3);
        heldDish = null;
      } else {
        const index = Math.floor(random() * inventory.length);
        showToast(`Your hands shake — you dropped the ${inventory[index]}!`, 3);
        inventory.splice(index, 1);
      }
    }
  }

  function drawShadowFigure(x, y, scale, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#140c18';
    ctx.beginPath();
    ctx.ellipse(x, y - 34 * scale, 10 * scale, 11 * scale, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x - 14 * scale, y + 8 * scale);
    ctx.quadraticCurveTo(x - 13 * scale, y - 26 * scale, x, y - 26 * scale);
    ctx.quadraticCurveTo(x + 13 * scale, y - 26 * scale, x + 14 * scale, y + 8 * scale);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#e0303a';
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(x + dir * 3.6 * scale, y - 35 * scale, 1.4 * scale, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** A ghost customer: a translucent, jittering diner with a "???" chip, drawn in the table's local space. */
  function drawGhostAtTable(ghost, half) {
    const t = performance.now();
    ctx.save();
    ctx.globalAlpha = 0.35 + 0.2 * Math.sin(t / 90);
    drawKitchenPerson(ctx, Math.sin(t / 37) * 1.5, half + 8, ghost.look, { scale: 1.0 });
    ctx.restore();
    drawLabelChip(ctx, 0, -half - 10, '???', 'bold 10px sans-serif');
  }

  function drawHallucinations() {
    const i = currentIntensity();
    const t = performance.now();
    if (i <= 0 && halluc.flicker <= 0 && halluc.scare <= 0) return;
    for (const f of halluc.figures) {
      const fade = Math.sin((f.age / f.life) * Math.PI);
      const flick = Math.sin(t / 33) > -0.6 ? 1 : 0.3;
      drawShadowFigure(f.x, f.y, 1.4, 0.55 * fade * flick);
    }
    ctx.save();
    for (const w of halluc.whispers) {
      ctx.globalAlpha = Math.sin((w.age / w.life) * Math.PI) * 0.85;
      ctx.fillStyle = 'rgba(110,40,90,1)';
      ctx.font = 'italic 15px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.fillText(w.text, w.x, w.y - w.age * 8);
    }
    ctx.restore();
    if (i > 0) {
      const pulse = 0.85 + 0.15 * Math.sin(t / 400);
      const vignette = ctx.createRadialGradient(world.width / 2, world.height / 2, 90 + 170 * (1 - i), world.width / 2, world.height / 2, 560);
      vignette.addColorStop(0, 'rgba(40,0,50,0)');
      vignette.addColorStop(0.6, `rgba(40,0,50,${0.45 * i * pulse})`);
      vignette.addColorStop(1, `rgba(20,0,30,${0.9 * i * pulse})`);
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, world.width, world.height);
    }
    if (halluc.flicker > 0) {
      ctx.fillStyle = 'rgba(10,0,15,0.55)';
      ctx.fillRect(0, 0, world.width, world.height);
    }
    if (halluc.scare > 0) {
      const p = 1 - halluc.scare / 0.45;
      ctx.fillStyle = 'rgba(5,0,8,0.7)';
      ctx.fillRect(0, 0, world.width, world.height);
      drawShadowFigure(world.width / 2, world.height + 120 - p * 140, 4.2, 0.95);
    }
  }

  // -- 0 Reputation penalties (v4, ported from Library Shift's 0 Mood) ----

  /** Toasts for whatever engine-state.js's tick just did at 0 Reputation. */
  function announceZeroReputationPenalties(before) {
    if ((shiftState.complaints ?? 0) > (before.complaints ?? 0)) {
      showToast(`📨 A complaint letter for Duke — −${COMPLAINT_GARD} Gard. Reputation is at 0!`, 3.5);
    }
    if ((shiftState.stormOuts ?? 0) > (before.stormOuts ?? 0)) {
      showToast('A fed-up customer stormed out — Reputation is at 0!', 3.5);
    }
  }

  // -- Movement + station interaction --------------------------------

  // The canvas's own CSS layout box (getBoundingClientRect) isn't always
  // the same aspect ratio as its fixed 960x600 drawing buffer — in
  // fullscreen especially (app.css's :fullscreen override lets
  // #cooking-canvas-wrapper flex-fill whatever space is under the Orders/
  // HUD bars, which is essentially never exactly 960:600 on a real
  // screen), object-fit: contain letterboxes the actual visible content
  // inside that box, with empty bars on either the sides or top/bottom.
  // getBoundingClientRect still reports the *full* box, bars included, so
  // naively scaling a click by rect.width/rect.height maps it to the
  // wrong world position by however much bar padding exists — a real,
  // previously-shipped bug ("its not working when i click it or press
  // enter"): on a typical 16:9 monitor in fullscreen, that's easily
  // ~200px of unaccounted-for pillarboxing on each side, enough to miss
  // nearly everything. This computes the actual rendered content
  // rectangle within the box (mirroring what object-fit: contain draws)
  // and maps against that instead. In non-fullscreen play the box is
  // already aspect-[960/600]-locked, so this is a no-op there (offsetX/Y
  // stay 0) — purely corrective for the letterboxed case.
  function canvasCoordsFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const worldAspect = world.width / world.height;
    let contentWidth = rect.width;
    let contentHeight = rect.height;
    let offsetX = 0;
    let offsetY = 0;
    if (rect.width / rect.height > worldAspect) {
      contentWidth = rect.height * worldAspect;
      offsetX = (rect.width - contentWidth) / 2;
    } else {
      contentHeight = rect.width / worldAspect;
      offsetY = (rect.height - contentHeight) / 2;
    }
    return {
      x: ((e.clientX - rect.left - offsetX) / contentWidth) * world.width,
      y: ((e.clientY - rect.top - offsetY) / contentHeight) * world.height,
    };
  }

  function cancelCookMiniGame() {
    cookMiniGame = null;
    elements.cookGauge.root.classList.add('hidden');
  }

  // Shared by both the click and Enter-key paths below: commits to
  // walking toward (and, on arrival, interacting with) `station`, or —
  // click only, since Enter has no floor point to fall back to — just
  // walking to `rawPoint` when there's no station under it.
  function commitStationTarget(station, rawPoint) {
    if (cookMiniGame) {
      if (station && station.kind === cookMiniGame.station) return; // still cooking here — ignore
      cancelCookMiniGame();
    }
    if (closingTimer && (!station || station.id !== closingTimer.stationId)) {
      closingTimer = null;
    }

    if (station) {
      const standoff = station.size / 2 + PLAYER_STOP_MARGIN;
      const approach = approachPoint(station.x, station.y, player.x, player.y, standoff);
      moveTarget = { x: approach.x, y: approach.y, station };
    } else if (rawPoint) {
      moveTarget = { x: rawPoint.x, y: rawPoint.y, station: null };
    }
  }

  function onCanvasClick(e) {
    if (activePanel || recipeBookOpen || coffeePour || !running) return;
    const { x, y } = canvasCoordsFromEvent(e);

    // v3.24: clicking directly on a food icon sitting on the tray removes
    // it — checked before normal station targeting, since the tray icons
    // are drawn on/around the player's own sprite and should win over
    // whatever station happens to be nearby. Held-dish and raw-ingredient
    // trays are mutually exclusive (drawPlayer never shows both at once),
    // so at most one of these two checks can ever find a hit.
    const pose = currentPlayerDrawPose();
    const heldHit = heldDishIconHit(pose.x, pose.y, pose.bobOffset, heldDish);
    if (heldHit && Math.abs(x - heldHit.x) <= heldHit.halfSize && Math.abs(y - heldHit.y) <= heldHit.halfSize) {
      showToast(`Set down ${heldDish}`);
      heldDish = null;
      return;
    }
    const ingredientHit = trayIngredientIconHits(pose.x, pose.y, pose.bobOffset, inventory)
      .find((hit) => Math.abs(x - hit.x) <= hit.halfSize && Math.abs(y - hit.y) <= hit.halfSize);
    if (ingredientHit) {
      showToast(`Removed ${ingredientHit.name}`);
      inventory.splice(ingredientHit.index, 1);
      return;
    }

    const station = stationAtPoint(x, y, unlockedStations(stationsInRoom(stations, currentRoom), currentTableUnlockLevel()));
    commitStationTarget(station, { x, y });
  }

  function onCanvasMouseMove(e) {
    const { x, y } = canvasCoordsFromEvent(e);
    hoverStation = stationAtPoint(x, y, unlockedStations(stationsInRoom(stations, currentRoom), currentTableUnlockLevel()));
  }

  function onCanvasMouseLeave() {
    hoverStation = null;
  }

  // Enter key as an alternate to clicking — same interaction, targeting
  // whichever station the mouse is currently hovering (already tracked by
  // onCanvasMouseMove above), so a player who's lined the cursor up on a
  // customer/station but whose click didn't land can just press Enter
  // instead. Requested by the user after "i click on them but i cant" —
  // a real click hit-test bug (see TABLE_HIT_EXTEND_DOWN in floor-plan.js)
  // was the root cause there, but Enter is a useful fallback regardless.
  // Guarded the same way onCanvasClick is (no panel/recipe book open, a
  // shift actually running) so it's a no-op everywhere else on the page —
  // including the Final Paycheck screen's leaderboard name `<input>`,
  // where `running` is already false and Enter should submit that form
  // normally, not be intercepted here.
  function onKeyDown(e) {
    if (coffeePour && (e.key === ' ' || e.key === 'Enter')) {
      e.preventDefault();
      if (!e.repeat) startCoffeePour();
      return;
    }
    if (e.key !== 'Enter') return;
    if (!hoverStation) return;
    if (activePanel || recipeBookOpen || !running) return;
    e.preventDefault();
    commitStationTarget(hoverStation, null);
  }

  /**
   * v3.33: every non-table station in `room` as a rectangular obstacle,
   * every unlocked table as a (deliberately undersized — see
   * TABLE_COLLISION_RADIUS) circular one, for `resolveObstacleCollisions`.
   * A locked table renders nothing at all (drawStation) and isn't
   * clickable, so it isn't an obstacle either — nothing to walk into.
   * Shared by both the player and every `payingCustomers` entry, since
   * both move through the same room the same way.
   */
  function stationObstaclesForRoom(room) {
    const level = currentTableUnlockLevel();
    return stationsInRoom(stations, room)
      .filter((s) => s.kind !== 'table' || isTableUnlocked(s.tableId, level))
      .map((s) => (s.kind === 'table'
        ? { x: s.x, y: s.y, radius: TABLE_COLLISION_RADIUS }
        : { x: s.x, y: s.y, halfWidth: s.size / 2, halfHeight: s.size / 2 }));
  }

  /**
   * v3.33: deliberately *not* used here — `player.x/player.y` stay the
   * pure, unobstructed simulation position (exactly the movement math
   * this function had before collision existed), so every distance/
   * arrival check anywhere else in this file (patience timers, the shift
   * clock, `handleArrival`'s `dist <= step` trigger, etc.) keeps behaving
   * exactly as before, with zero risk of a collision nudge subtly
   * altering game timing. Collision avoidance is applied only where it's
   * purely a rendering concern: `currentPlayerDrawPose` (used by both
   * `drawPlayer` and this file's click hit-testing, so the two can never
   * drift apart) and `drawPayingCustomers`. See those for why — a naive
   * "collision nudges the real position" version of this deadlocked in
   * testing: two customers converging on nearly the same Counter standoff
   * point pushed each other back exactly as far as they'd just advanced,
   * forever, since arrival detection also read the nudged position.
   */
  function updatePlayer(deltaSeconds) {
    if (!moveTarget) return;
    carryBobPhase += deltaSeconds * CARRY_BOB_SPEED; // only read while heldDish is set (drawPlayerCarrying); harmless to advance otherwise
    const dx = moveTarget.x - player.x;
    const dy = moveTarget.y - player.y;
    const dist = Math.hypot(dx, dy);
    // Sanity multiplies on top of the gear-based speed (rules.js's
    // walkSpeedMultiplierForSanity) — tired legs from a rough shift, not a
    // separate speed system. shiftState is only null before the very first
    // "Start Shift" click; SANITY_MAX (full speed) covers that case.
    const sanityMultiplier = walkSpeedMultiplierForSanity(shiftState ? shiftState.sanity : SANITY_MAX);
    const step = walkSpeedForSave(save) * sanityMultiplier * deltaSeconds;

    if (dist <= step || dist === 0) {
      const clamped = clampToCanvas(moveTarget.x, moveTarget.y);
      player.x = clamped.x;
      player.y = clamped.y;
      const arrivedStation = moveTarget.station;
      moveTarget = null;
      if (arrivedStation) handleArrival(arrivedStation);
    } else {
      const next = clampToCanvas(player.x + (dx / dist) * step, player.y + (dy / dist) * step);
      player.x = next.x;
      player.y = next.y;
    }
  }

  function handleTableArrival(tableId) {
    const ghost = ghostAtTable(tableId);
    if (ghost && !pendingCustomers[tableId]) {
      halluc.ghosts = halluc.ghosts.filter((g) => g !== ghost);
      shiftState = startleFromHallucination(shiftState);
      showToast("…there's no one there. Your heart pounds.", 3);
      return;
    }
    const pendingDish = pendingCustomers[tableId];
    if (pendingDish) {
      const isKarenTable = karen && karen.tableId === tableId;
      const isMelTable = mel && mel.tableId === tableId;
      let patience = customerPatienceSeconds(currentShiftNumber, save.gear.regularsPatience);
      if (isKarenTable) patience = karenThisShift.patienceSeconds;
      else if (isMelTable) patience += MEL_PATIENCE_BONUS_SECONDS;
      // v3.11: a mistake this shift drains the restaurant's reputation, and
      // every order taken *after* that (not just the mistaken one) gets
      // shorter patience as a result — Karen and Mel aren't exempt, same as
      // sanity's walk-speed penalty applies to everyone regardless of who
      // caused it.
      patience *= patienceMultiplierForReputation(shiftState.reputation);
      const maxOrders = tableCapacity(currentShiftNumber, save.gear.extraTableService);
      const next = addOrder(shiftState, tableId, pendingDish, patience, maxOrders);
      if (next !== shiftState) {
        shiftState = next;
        delete pendingCustomers[tableId];
        activeOrderTableId = tableId;
        // v3.12: a brief speech-bubble popup showing what was just ordered
        // — replaces the previous silent hand-off (the table's own
        // "wants to order" text just disappearing and a patience bar
        // appearing in its place) with a clearer, in-the-moment cue.
        orderBubble = { tableId, dishName: pendingDish, remaining: ORDER_BUBBLE_SECONDS };
      }
      return;
    }

    const order = shiftState.orders.find((o) => o.tableId === tableId);
    if (!order) return;
    if (heldDish) {
      const isKarenTable = karen && karen.tableId === tableId;
      const isMelTable = mel && mel.tableId === tableId;
      const isCoupleTable = couple && couple.tableId === tableId;
      const matched = order.dishName === heldDish;
      const servedDish = heldDish;
      shiftState = serveDish(shiftState, tableId, heldDish);
      heldDish = null;
      if (matched) {
        const appearance = isKarenTable ? 'karen' : isMelTable ? 'mel' : isCoupleTable ? 'couple' : 'regular';
        spawnPayingCustomer(tableId, appearance, servedDish);
      }
      if (isKarenTable) {
        if (matched) {
          karen = null;
          earnBonusGard(karenThisShift.tipGard);
          showToast(karenThisShift.rematch
            ? `Karen, grudgingly: "...Fine. That was actually good." +${karenThisShift.tipGard}g tip`
            : `Karen huffs, but tips anyway. +${karenThisShift.tipGard}g`, 4);
        } else {
          triggerKarenRipple();
        }
      }
      if (isMelTable) {
        if (matched) showToast(MEL_THANK_YOU_LINE, 4);
        mel = null;
      }
      if (isCoupleTable) couple = null;
      // v3.18: a wrong-dish serve doesn't just cost Gard/Reputation (above)
      // — it also annoys the customer directly, on top of that. A correct
      // serve never annoys them (their order is already gone via serveDish
      // above, so annoyCustomerAt would only ever no-op there).
      if (!matched) annoyCustomerAt(tableId);
    } else {
      // v3.18: re-visiting a table whose order was already taken (not
      // holding the matching dish) annoys the customer too — they have to
      // repeat themselves.
      activeOrderTableId = tableId;
      annoyCustomerAt(tableId);
    }
  }

  /**
   * v3.28: spawns an eat-at-the-table → walk-to-counter → pay → leave
   * animation for a customer who was just correctly served (called from
   * handleTableArrival's matched branch, right after serveDish — the
   * table itself is already free by then). `appearance` picks which
   * figure to draw at each step, `dishName` which icon they're eating.
   * Gard is credited once, when the 'paying' phase completes (see
   * updatePayingCustomers), not at spawn time. v3.29: `eatingDuration`
   * is randomized here (picked once, up front) so simultaneously-served
   * customers don't all finish eating in lockstep; `payingDuration` is
   * randomized too, but picked lazily on arrival at the Counter (see
   * updatePayingCustomers) since picking it this early would go stale if
   * the entry sits in 'eating' for a while first.
   */
  function spawnPayingCustomer(tableId, appearance, dishName) {
    const tableStation = stations.find((s) => s.kind === 'table' && s.tableId === tableId);
    const counterStation = stations.find((s) => s.kind === 'counter');
    if (!tableStation || !counterStation) return; // shouldn't happen — both always exist in ROOM_DINING
    // v3.33: a standoff point just outside the Counter's own collision
    // box, not its exact center — otherwise `updatePayingCustomers`'
    // collision resolution (added this same version) would immediately
    // push a customer who just "arrived" back out of the Counter they're
    // trying to stand at, same reasoning as the player's own
    // approachPoint/PLAYER_STOP_MARGIN standoff.
    const counterTarget = approachPoint(counterStation.x, counterStation.y, tableStation.x, tableStation.y, counterStation.size / 2 + 20);
    payingCustomers.push({
      x: tableStation.x,
      y: tableStation.y + tableStation.size / 2 + 8, // matches drawTableContents' seated position
      targetX: counterTarget.x,
      targetY: counterTarget.y,
      phase: 'eating',
      elapsed: 0,
      eatingDuration: randomBetween(CUSTOMER_EATING_SECONDS_MIN, CUSTOMER_EATING_SECONDS_MAX),
      payingDuration: null, // picked on arrival at the Counter, once 'walking' completes
      appearance,
      dishName,
      look: customerLooks[tableId],
    });
  }

  // v3.33: same reasoning as updatePlayer's doc comment — c.x/c.y stay the
  // pure simulation position (unaltered from before collision existed),
  // so a customer's eat/walk/pay/leave timing can never deadlock or drift
  // because of where anyone else happens to be standing. Collision
  // avoidance is purely a `drawPayingCustomers` rendering concern.
  function updatePayingCustomers(deltaSeconds) {
    if (payingCustomers.length === 0) return;
    const step = PAYING_CUSTOMER_WALK_SPEED * deltaSeconds;
    payingCustomers = payingCustomers.filter((c) => {
      if (c.phase === 'eating') {
        c.elapsed += deltaSeconds;
        if (c.elapsed >= c.eatingDuration) {
          c.phase = 'walking';
        }
        return true;
      }

      if (c.phase === 'paying') {
        c.elapsed += deltaSeconds;
        if (c.elapsed >= c.payingDuration) {
          save.monthToDateGard += COUNTER_PAYMENT_GARD;
          counterGardThisShift += COUNTER_PAYMENT_GARD;
          persistSave(storageAvailable, save);
          c.phase = 'leaving';
          c.targetX = INTRO_ENTRANCE_POSITION.x;
          c.targetY = INTRO_ENTRANCE_POSITION.y;
        }
        return true;
      }

      const dx = c.targetX - c.x;
      const dy = c.targetY - c.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= step || dist === 0) {
        c.x = c.targetX;
        c.y = c.targetY;
        if (c.phase === 'walking') {
          c.phase = 'paying';
          c.elapsed = 0;
          c.payingDuration = randomBetween(PAYING_CUSTOMER_TRANSACTION_SECONDS_MIN, PAYING_CUSTOMER_TRANSACTION_SECONDS_MAX);
          return true;
        }
        return false; // 'leaving' arrived at the exit — done
      }
      c.x += (dx / dist) * step;
      c.y += (dy / dist) * step;
      return true;
    });
  }

  /**
   * v3.29: a small dish icon bobbing between "plate" and "mouth" height,
   * one bob per bite — reuses drawDishIcon (the same icon shown in the
   * order bubble/tray) rather than a new asset, per this project's no-
   * image-assets convention. Purely decorative: eatingDuration (how long
   * this plays for) is already decided at spawn time regardless of bite
   * count.
   */
  function drawEatingAnimation(c) {
    const biteCycle = (c.elapsed % 0.6) / 0.6; // one bite every 0.6s
    const bob = Math.sin(biteCycle * Math.PI); // 0 -> 1 -> 0 per bite
    // Held up beside the head at roughly mouth height (drawPixelPerson's
    // head center sits around y-32*scale) — a small, mostly-stationary
    // bob reads as "taking a bite" much better than a long plate-to-mouth
    // travel would on a figure this small (~50px tall).
    const iconX = c.x + 10;
    const iconY = c.y - 34 - bob * 4;
    const iconSize = 13 + bob * 2;
    drawDishIcon(ctx, iconX, iconY, c.dishName, iconSize);
  }

  /**
   * v3.36: shared by `drawPayingCustomers` and `drawArrivingCustomers` —
   * the same appearance vocabulary ('mel'/'couple'/'karen'/'regular')
   * drawn identically regardless of which direction they're walking, so a
   * customer looks the same arriving as they do leaving.
   */
  function drawCustomerFigure(x, y, appearance, look) {
    if (appearance === 'mel') {
      drawMel(ctx, x, y, 1.0);
    } else if (appearance === 'couple') {
      drawKitchenPerson(ctx, x - 13, y, 'olive', { scale: 0.85 });
      drawKitchenPerson(ctx, x + 13, y, 'oliver', { scale: 0.85 });
    } else if (appearance === 'karen') {
      drawKitchenPerson(ctx, x, y, 'karen', { scale: 1.0, angryTint: Boolean(karenThisShift && karenThisShift.rematch) });
    } else {
      drawKitchenPerson(ctx, x, y, look || CUSTOMER_LOOK_KEYS[0], { scale: 1.0 });
    }
  }

  /**
   * v3.33: like `currentPlayerDrawPose`, `c.x/c.y` (the pure simulation
   * position `updatePayingCustomers` moves) are left untouched — only
   * where each customer is actually *drawn* gets nudged clear of
   * stations/tables, the player, and every other paying customer, so
   * their eat/walk/pay/leave timing can never be affected by collision.
   */
  function drawPayingCustomers() {
    const stationObstacles = stationObstaclesForRoom(ROOM_DINING);
    for (const c of payingCustomers) {
      const obstacles = [
        ...stationObstacles,
        { x: player.x, y: player.y, radius: PLAYER_COLLISION_RADIUS },
        ...payingCustomers.filter((other) => other !== c).map((other) => ({ x: other.x, y: other.y, radius: CUSTOMER_COLLISION_RADIUS })),
        ...arrivingCustomers.map((other) => ({ x: other.x, y: other.y, radius: CUSTOMER_COLLISION_RADIUS })),
      ];
      const visual = resolveObstacleCollisions(c.x, c.y, CUSTOMER_COLLISION_RADIUS, obstacles);
      drawCustomerFigure(visual.x, visual.y, c.appearance, c.look);
      if (c.phase === 'eating') drawEatingAnimation({ ...c, x: visual.x, y: visual.y });
    }
  }

  /**
   * v3.36: spawns a walk-in-from-the-entrance animation for a customer
   * who was just picked to seat at `tableId` (maybeSpawnCustomer/
   * spawnKarenIfDue) — the mirror image of spawnPayingCustomer's walk-out.
   * They don't become a real, interactable `pendingCustomers` entry (or
   * start counting toward capacity, patience, mel/couple/karen tracking)
   * until `updateArrivingCustomers` sees them arrive — see that function.
   */
  function spawnArrivingCustomer(tableId, appearance, dishName) {
    const tableStation = stations.find((s) => s.kind === 'table' && s.tableId === tableId);
    if (!tableStation) return; // shouldn't happen — caller already validated tableId is a real, open table
    arrivingCustomers.push({
      x: INTRO_ENTRANCE_POSITION.x,
      y: INTRO_ENTRANCE_POSITION.y,
      targetX: tableStation.x,
      targetY: tableStation.y + tableStation.size / 2 + 8, // matches drawTableContents' seated position
      tableId,
      appearance,
      dishName,
      look: CUSTOMER_LOOK_KEYS[Math.floor(random() * CUSTOMER_LOOK_KEYS.length)],
    });
  }

  // v3.36: pure simulation position, same reasoning as updatePayingCustomers
  // — never nudged by collision, so arrival timing can't drift or deadlock.
  function updateArrivingCustomers(deltaSeconds) {
    if (arrivingCustomers.length === 0) return;
    const step = PAYING_CUSTOMER_WALK_SPEED * deltaSeconds;
    arrivingCustomers = arrivingCustomers.filter((c) => {
      const dx = c.targetX - c.x;
      const dy = c.targetY - c.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= step || dist === 0) {
        // Arrived — this is the moment they actually "become" a seated,
        // interactable customer (drawTableContents starts drawing them
        // there once pendingCustomers[tableId] is set), same moment
        // mel/couple/karen tracking and (for Karen) her line used to fire
        // at spawn time instead — now genuinely "the moment she's seated"
        // per the customer rules doc, not just the moment she was picked.
        pendingCustomers[c.tableId] = c.dishName;
        customerLooks[c.tableId] = c.look;
        if (c.appearance === 'mel') mel = { tableId: c.tableId };
        else if (c.appearance === 'couple') couple = { tableId: c.tableId };
        else if (c.appearance === 'karen') {
          karen = { tableId: c.tableId };
          showToast(karenThisShift.line, 5);
        }
        return false;
      }
      c.x += (dx / dist) * step;
      c.y += (dy / dist) * step;
      return true;
    });
  }

  function drawArrivingCustomers() {
    const stationObstacles = stationObstaclesForRoom(ROOM_DINING);
    for (const c of arrivingCustomers) {
      const obstacles = [
        ...stationObstacles,
        { x: player.x, y: player.y, radius: PLAYER_COLLISION_RADIUS },
        ...payingCustomers.map((other) => ({ x: other.x, y: other.y, radius: CUSTOMER_COLLISION_RADIUS })),
        ...arrivingCustomers.filter((other) => other !== c).map((other) => ({ x: other.x, y: other.y, radius: CUSTOMER_COLLISION_RADIUS })),
      ];
      const visual = resolveObstacleCollisions(c.x, c.y, CUSTOMER_COLLISION_RADIUS, obstacles);
      drawCustomerFigure(visual.x, visual.y, c.appearance, c.look);
    }
  }

  function handleGatherArrival(stationKind) {
    openPanel(stationKind === 'fridge' ? 'fridge' : 'cabinet');
  }

  function handleCookArrival(stationKind) {
    if (activeOrderTableId == null) {
      showToast('Take an order first');
      return;
    }
    const order = shiftState.orders.find((o) => o.tableId === activeOrderTableId);
    if (!order) {
      // v3.30: this used to silently return — no toast, nothing on screen
      // — which read as "the stove/oven does nothing" from the player's
      // side. It fires whenever the tracked order resolved out from under
      // them while they were still gathering (most often a patience
      // timeout, engine-state.js's failOrderAt/tick): the order vanishes
      // from shiftState.orders, but activeOrderTableId — a cooking-game.js
      // closure variable tick() has no way to reach — keeps pointing at
      // that now-gone order. Oven dishes (fridge + cabinet + cookware
      // closet + oven, the longest gather chain) are the likeliest to
      // still be mid-gather when a timeout lands, which is why this read
      // as an oven-specific bug rather than the generic gap it actually is.
      activeOrderTableId = null;
      showToast("That order's gone — take a new one first");
      return;
    }
    const dish = findDish(order.dishName);
    if (!dish || dish.station !== stationKind) {
      showToast(dish && dish.station === 'none' ? `${dish.name} doesn't need cooking` : "Can't cook that here");
      return;
    }
    if (dish.cookware && !cookware.has(dish.cookware)) {
      showToast(`Need a ${dish.cookware} from the Cookware Closet`);
      return;
    }
    const missing = missingIngredientsForDish(dish, inventory);
    if (missing.length > 0) {
      showToast(`Need: ${missing.join(', ')}`);
      return;
    }

    cookMiniGame = {
      dishName: dish.name,
      station: stationKind,
      gaugePosition: 0,
      direction: 1,
      // v4 shaky hands: a narrower window at low Sanity.
      zone: shakyCookSuccessZone(save.gear.sharpKnife, shakyHandsZoneScale(currentIntensity())),
    };
    if (elements.cookGauge.zone) {
      const zone = cookMiniGame.zone;
      elements.cookGauge.zone.style.left = `${(zone.start * 100).toFixed(1)}%`;
      elements.cookGauge.zone.style.width = `${((zone.end - zone.start) * 100).toFixed(1)}%`;
      elements.cookGauge.zone.style.backgroundColor = 'rgba(224,168,58,0.55)';
    }
    elements.cookGauge.root.classList.remove('hidden');
  }

  function sampleCookGauge() {
    if (!cookMiniGame) return;
    const dish = findDish(cookMiniGame.dishName);
    const success = isCookSuccess(cookMiniGame.gaugePosition, cookMiniGame.zone);
    if (dish) inventory = removeDishIngredientsFromInventory(dish, inventory);
    if (success) heldDish = cookMiniGame.dishName;
    else showToast(`${cookMiniGame.dishName} came out wrong — ingredients lost`);
    cancelCookMiniGame();
  }

  function startClosingTimerIfValid(station) {
    if (shiftState.phase === 'closing-clean' && station.kind === 'table') {
      const t = shiftState.tables[station.tableId];
      if (!t || t.occupied || !t.dirty) return;
      closingTimer = { stationId: station.id, kind: 'table', tableId: station.tableId, remaining: cleaningDurationForSave(save) };
    } else if (shiftState.phase === 'closing-dishes' && station.kind === 'cleaning-closet') {
      closingTimer = { stationId: station.id, kind: 'cleaning-closet', remaining: cleaningDurationForSave(save) };
    }
  }

  // Room switching works in every shift phase, not just 'playing' — the
  // closing sequence needs both rooms (dirty tables and the counter/boss's
  // office are in Dining, the cleaning closet is in Kitchen), so gating
  // the doors to one phase would make the game unwinnable mid-closing.
  function switchRoom(room, entryPoint) {
    currentRoom = room;
    player.x = entryPoint.x;
    player.y = entryPoint.y;
    moveTarget = null;
    hoverStation = null;
    updateRoomButton();
  }

  function handleArrival(station) {
    if (station.kind === 'kitchen-door') return switchRoom(ROOM_KITCHEN, KITCHEN_ENTRY_POINT);
    if (station.kind === 'dining-door') return switchRoom(ROOM_DINING, DINING_ENTRY_POINT);
    if (shiftState.phase === 'playing') {
      if (station.kind === 'table') return handleTableArrival(station.tableId);
      if (station.kind === 'fridge' || station.kind === 'cabinet') return handleGatherArrival(station.kind);
      if (station.kind === 'cookware-closet') return openPanel('cookware');
      if (station.kind === 'stove' || station.kind === 'oven' || station.kind === 'rice-station') return handleCookArrival(station.kind);
      if (station.kind === 'coffee-machine') {
        openCoffeePour();
        return;
      }
      return;
    }
    if (shiftState.phase === 'closing-clean' && station.kind === 'table') return startClosingTimerIfValid(station);
    if (shiftState.phase === 'closing-dishes' && station.kind === 'cleaning-closet') return startClosingTimerIfValid(station);
    if (shiftState.phase === 'closing-shutdown' && station.kind === 'counter') {
      shiftState = shutDown(shiftState);
      return;
    }
    if (shiftState.phase === 'paycheck' && station.kind === 'boss-office') {
      endShift();
    }
  }

  function maybeSpawnCustomer() {
    if (timeSinceCustomerSpawn < nextCustomerArrivalSeconds) return;
    timeSinceCustomerSpawn = 0;
    // v3.34: re-rolled every time the wait elapses (whether or not a
    // customer actually ends up spawning below — capacity/no-table
    // rejections already restarted the full wait before this existed,
    // same behavior preserved, just with a freshly jittered length now).
    nextCustomerArrivalSeconds = jitteredArrivalIntervalSeconds(customerArrivalIntervalSeconds(currentShiftNumber), random());

    const maxOrders = tableCapacity(currentShiftNumber, save.gear.extraTableService);
    // v3.36: an arrivingCustomers entry doesn't have a pendingCustomers
    // entry yet (that's the whole point — see spawnArrivingCustomer) but
    // is still headed for a table, so it counts toward capacity too;
    // otherwise several customers could pile up walking in at once and
    // all land past the real cap the instant they arrive.
    const activeCount = shiftState.orders.length + Object.keys(pendingCustomers).length + arrivingCustomers.length;
    if (activeCount >= maxOrders) return;

    const level = currentTableUnlockLevel();
    const availableTableIds = TABLE_IDS.filter((id) => isTableUnlocked(id, level)
      && !shiftState.tables[id].occupied
      && !pendingCustomers[id]
      && !arrivingCustomers.some((c) => c.tableId === id)
      && !ghostAtTable(id));
    if (availableTableIds.length === 0) return;

    const tableId = availableTableIds[Math.floor(random() * availableTableIds.length)];

    // v3.35: "first customer is still the same, randomize the customers
    // and the food they order" — Mel and Olive & Oliver used to be forced
    // into the literal 1st/2nd spawn slot of every shift, unconditionally,
    // before the random dish pool ever got a turn. One flat candidate
    // list instead: each not-yet-spawned-this-shift special customer gets
    // exactly one entry (same weight as any single regular dish), so
    // which customer/dish a given spawn slot produces is one random draw
    // — sometimes Mel or the couple land first, sometimes third, sometimes
    // a regular customer opens the shift instead. They're still guaranteed
    // to show up exactly once per shift (still candidates on every later
    // attempt until picked) — only the *timing* is now random, not *who*
    // eventually appears, same principle v3.34 applied to arrival timing
    // itself (customer rules doc's Karen/Mel/Olive & Oliver section).
    const candidates = [];
    if (!melSpawnedThisShift) candidates.push({ kind: 'mel', dishName: MEL_DISH.name });
    if (!coupleSpawnedThisShift) candidates.push({ kind: 'couple', dishName: COUPLE_DISH.name });
    for (const dish of availableDishes(currentShiftNumber)) candidates.push({ kind: 'regular', dishName: dish.name });

    const chosen = candidates[Math.floor(random() * candidates.length)];
    // v3.36: "who" is decided now (the flags below gate which candidates
    // future spawn attempts even offer, so they must latch immediately —
    // otherwise Mel could get drawn twice while her first pick is still
    // mid-walk) but they don't actually become a real pendingCustomers
    // entry, or set mel/couple's "currently active" tracking, until they
    // arrive — see spawnArrivingCustomer/updateArrivingCustomers.
    if (chosen.kind === 'mel') melSpawnedThisShift = true;
    else if (chosen.kind === 'couple') coupleSpawnedThisShift = true;
    spawnArrivingCustomer(tableId, chosen.kind, chosen.dishName);
  }

  function updateCookMiniGame(deltaSeconds) {
    if (!cookMiniGame) return;
    const speed = cookSweepSpeed(currentShiftNumber) * shakyHandsSweepMultiplier(currentIntensity());
    cookMiniGame.gaugePosition += cookMiniGame.direction * speed * deltaSeconds;
    if (cookMiniGame.gaugePosition >= 1) {
      cookMiniGame.gaugePosition = 1;
      cookMiniGame.direction = -1;
    } else if (cookMiniGame.gaugePosition <= 0) {
      cookMiniGame.gaugePosition = 0;
      cookMiniGame.direction = 1;
    }
    elements.cookGauge.fill.style.width = `${(cookMiniGame.gaugePosition * 100).toFixed(1)}%`;
  }

  function updateClosingTimer(deltaSeconds) {
    if (!closingTimer) return;
    closingTimer.remaining -= deltaSeconds;
    if (closingTimer.remaining <= 0) {
      if (closingTimer.kind === 'table') shiftState = cleanTable(shiftState, closingTimer.tableId);
      else shiftState = washDishes(shiftState);
      closingTimer = null;
    }
  }

  /** v3.12: counts down and clears the order speech-bubble popup — see handleTableArrival/drawOrderBubble. */
  function updateOrderBubble(deltaSeconds) {
    if (!orderBubble) return;
    orderBubble.remaining -= deltaSeconds;
    if (orderBubble.remaining <= 0) orderBubble = null;
  }

  // -- Rendering ----------------------------------------------------------

  // v4 art pass ("make the art style similar to the library game"): the
  // pink checkerboard floor became Library Shift's staggered wooden planks
  // (Dining) and warm terracotta tiles (Kitchen), both with the same soft
  // vignette toward the walls — fixed per position, so nothing shimmers.
  const PLANK_HEIGHT = 30;
  const PLANK_LENGTH = 160;
  const PLANK_TONES = ['#efdfc4', '#ecdabd', '#f1e3ca', '#e9d6b8'];
  const KITCHEN_TILE_SIZE = 48;
  const KITCHEN_TILE_TONES = ['#f3e4d2', '#efdcc6'];

  /**
   * v3.32: "generate a door or sprite image for entrance and exit" — the
   * diner's front door, drawn directly in world coordinates (never a
   * clickable station). Centered on `INTRO_ENTRANCE_POSITION.x` (650) — the
   * exact spot the one-time walk-in intro, every arriving customer and
   * every departing paid customer walk to/from. v4: restyled to match the
   * Library-style wood palette (paneled frame, brass handle, a mat).
   */
  function drawEntranceDoor() {
    const doorX = 650;
    const doorTop = 508;
    const doorHalfWidth = 30;
    const doorHeight = 62;

    drawRoundRect(ctx, doorX - doorHalfWidth - 4, doorTop - 4, doorHalfWidth * 2 + 8, doorHeight + 4, [10, 10, 0, 0], '#8a6a4a');
    // Open doorway with warm daylight spilling in.
    drawRoundRect(ctx, doorX - doorHalfWidth + 2, doorTop + 2, doorHalfWidth * 2 - 4, doorHeight - 2, [7, 7, 0, 0], '#ffe6a8');
    drawRoundRect(ctx, doorX - doorHalfWidth + 2, doorTop + 2, doorHalfWidth * 2 - 4, (doorHeight - 2) * 0.45, [7, 7, 0, 0], '#fff4d6');
    // The door leaf, propped open against the right side, with a brass handle.
    drawRoundRect(ctx, doorX + doorHalfWidth - 13, doorTop + 2, 11, doorHeight - 2, 2, '#b9824f');
    ctx.strokeStyle = 'rgba(90,55,30,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(doorX + doorHalfWidth - 11, doorTop + 8, 7, 20);
    ctx.strokeRect(doorX + doorHalfWidth - 11, doorTop + 34, 7, 20);
    ctx.fillStyle = '#c9a24a';
    ctx.beginPath();
    ctx.arc(doorX + doorHalfWidth - 15, doorTop + doorHeight / 2, 2, 0, Math.PI * 2);
    ctx.fill();
    // Star lanterns either side and a welcome mat.
    drawStar(ctx, doorX - doorHalfWidth - 10, doorTop + 6, 6, 2.5, '#e8b95a');
    drawStar(ctx, doorX + doorHalfWidth + 10, doorTop + 6, 6, 2.5, '#e8b95a');
    drawRoundRect(ctx, doorX - doorHalfWidth - 6, doorTop + doorHeight - 4, doorHalfWidth * 2 + 12, 9, 4, '#c65f7c');
    drawStar(ctx, doorX, doorTop + doorHeight + 0.5, 4, 1.8, '#fdf1e4');
  }

  function drawPlankFloor() {
    ctx.fillStyle = PLANK_TONES[0];
    ctx.fillRect(0, 0, world.width, world.height);
    for (let row = 0; row * PLANK_HEIGHT < world.height; row++) {
      const y = row * PLANK_HEIGHT;
      const offset = (row % 3) * (PLANK_LENGTH / 3);
      for (let x = -offset, i = 0; x < world.width; x += PLANK_LENGTH, i++) {
        ctx.fillStyle = PLANK_TONES[(row * 7 + i * 3) % PLANK_TONES.length];
        ctx.fillRect(x, y, PLANK_LENGTH, PLANK_HEIGHT);
        ctx.fillStyle = 'rgba(120,85,50,0.16)';
        ctx.fillRect(x, y, 1.5, PLANK_HEIGHT);
        ctx.fillStyle = 'rgba(120,85,50,0.06)';
        ctx.fillRect(x + 24 + ((row * 37 + i * 53) % 90), y + 9 + ((row + i) % 3) * 5, 40, 1.5);
      }
      ctx.fillStyle = 'rgba(120,85,50,0.18)';
      ctx.fillRect(0, y, world.width, 1.5);
    }
  }

  function drawKitchenTileFloor() {
    for (let row = 0; row * KITCHEN_TILE_SIZE < world.height; row++) {
      for (let col = 0; col * KITCHEN_TILE_SIZE < world.width; col++) {
        const x = col * KITCHEN_TILE_SIZE;
        const y = row * KITCHEN_TILE_SIZE;
        ctx.fillStyle = KITCHEN_TILE_TONES[(row + col) % 2];
        ctx.fillRect(x, y, KITCHEN_TILE_SIZE, KITCHEN_TILE_SIZE);
        // A soft highlight on each tile's upper-left, for a glazed look.
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillRect(x + 3, y + 3, KITCHEN_TILE_SIZE - 14, 3);
      }
    }
    // Grout lines.
    ctx.fillStyle = 'rgba(150,110,80,0.2)';
    for (let x = 0; x < world.width; x += KITCHEN_TILE_SIZE) ctx.fillRect(x, 0, 1.5, world.height);
    for (let y = 0; y < world.height; y += KITCHEN_TILE_SIZE) ctx.fillRect(0, y, world.width, 1.5);
  }

  function drawFloor() {
    if (currentRoom === ROOM_DINING) drawPlankFloor();
    else drawKitchenTileFloor();

    const vignette = ctx.createRadialGradient(world.width / 2, world.height / 2, 200, world.width / 2, world.height / 2, 620);
    vignette.addColorStop(0, 'rgba(120,85,50,0)');
    vignette.addColorStop(1, 'rgba(120,85,50,0.12)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, world.width, world.height);

    // The sign sits right of Duke's Office (x 445-515) and the wall clock,
    // clear of every station box and label chip — the HUD (Sanity/
    // Reputation bars and the Gard counter) owns the top-left.
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#8a6a4a';
    ctx.font = 'bold 13px sans-serif';
    if (currentRoom === ROOM_DINING) {
      ctx.fillText('★ Startime Diner ★', 700, 22);
      drawEntranceDoor();
      ctx.fillStyle = 'rgba(138,106,74,0.8)';
      ctx.font = '10px sans-serif';
      ctx.fillText('Entrance / Exit', 650, world.height - 8);
    } else {
      ctx.fillText('Kitchen', 700, 22);
    }
    ctx.restore();

    drawWallClock();
  }

  /**
   * v4: an analog wall clock (ported from Library Shift) echoing the HUD's
   * `#cooking-hud-clock` reading — parsed from the same `inGameTimeLabel`
   * text so the two can never drift apart. Purely decorative; drawn in
   * both rooms (every kitchen has a clock on the wall too).
   */
  function drawWallClock() {
    if (!shiftState) return;
    const label = inGameTimeLabel(shiftState.clockSeconds, shiftClockSecondsForShift(currentShiftNumber));
    const match = /^(\d+):(\d+)\s(AM|PM)$/.exec(label);
    if (!match) return;
    const hour12 = Number(match[1]);
    const minute = Number(match[2]);

    const cx = 600;
    const cy = 34;
    const r = 18;
    drawRoundRect(ctx, cx - r - 4, cy - r - 4, (r + 4) * 2, (r + 4) * 2, 8, '#8a6a4a');
    ctx.fillStyle = '#fdf8ee';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#5a4a3a';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * (r - 3), cy + Math.sin(angle) * (r - 3));
      ctx.lineTo(cx + Math.cos(angle) * (r - 7), cy + Math.sin(angle) * (r - 7));
      ctx.stroke();
    }
    const minuteAngle = (minute / 60) * Math.PI * 2 - Math.PI / 2;
    const hourAngle = (((hour12 % 12) + minute / 60) / 12) * Math.PI * 2 - Math.PI / 2;
    ctx.strokeStyle = '#3a2a2a';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(hourAngle) * r * 0.5, cy + Math.sin(hourAngle) * r * 0.5);
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(minuteAngle) * r * 0.75, cy + Math.sin(minuteAngle) * r * 0.75);
    ctx.stroke();
    ctx.fillStyle = '#3a2a2a';
    ctx.beginPath();
    ctx.arc(cx, cy, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  function isStationOpen(station) {
    if (station.kind === 'fridge') return activePanel === 'fridge';
    if (station.kind === 'cabinet') return activePanel === 'cabinet';
    if (station.kind === 'cookware-closet') return activePanel === 'cookware';
    if (station.kind === 'cleaning-closet') return closingTimer && closingTimer.stationId === station.id;
    if (station.kind === 'boss-office') return shiftState.phase === 'paycheck';
    return false;
  }

  function drawTableContents(station) {
    const tableId = station.tableId;
    const tableState = shiftState.tables[tableId];
    const pendingDish = pendingCustomers[tableId];
    const order = shiftState.orders.find((o) => o.tableId === tableId);
    const isKarenTable = karen && karen.tableId === tableId;
    const isMelTable = mel && mel.tableId === tableId;
    const isCoupleTable = couple && couple.tableId === tableId;
    const half = station.size / 2;

    const ghost = !pendingDish && !order ? ghostAtTable(tableId) : null;
    if (ghost) drawGhostAtTable(ghost, half);

    if (pendingDish || order) {
      if (isMelTable) {
        drawMel(ctx, 0, half + 8, 1.0);
      } else if (isCoupleTable) {
        // Olive & Oliver: a couple sharing one table — two people, not one.
        drawKitchenPerson(ctx, -17, half + 8, 'olive', { scale: 0.9 });
        drawKitchenPerson(ctx, 17, half + 8, 'oliver', { scale: 0.9 });
      } else if (isKarenTable) {
        // Already fuming the moment she sits down.
        drawKitchenPerson(ctx, 0, half + 8, 'karen', { scale: 1.0, angryTint: true });
      } else {
        drawKitchenPerson(ctx, 0, half + 8, customerLooks[tableId] || CUSTOMER_LOOK_KEYS[0], { scale: 1.0 });
      }
    }

    if (order) {
      // v3.11: read the order's own patienceMaxSeconds (fixed at the moment
      // it was taken, reputation multiplier already folded in — see
      // handleTableArrival/engine-state.js's addOrder) rather than
      // recomputing it here — recomputing with the *current* reputation
      // would drift for an older order if reputation has changed since,
      // making its patience bar's fraction wrong.
      const frac = Math.max(0, Math.min(1, order.patienceRemainingSeconds / order.patienceMaxSeconds));
      drawRoundRect(ctx, -16, -half - 14, 32, 4, 2, 'rgba(90,50,60,0.2)');
      drawRoundRect(ctx, -16, -half - 14, 32 * frac, 4, 2, frac > 0.3 ? '#7fd68a' : '#e06a5b');

      // v3.18: customer sanity — separate from the time-based patience bar
      // above, this drains only on an "annoyance" (re-visiting before
      // serving, or a wrong-dish serve), not passively. A lavender/plum
      // fill keeps it visually distinct from patience's green/red at a
      // glance, in the same "coquette" pastel family as the rest of this
      // game's palette.
      const sanityFrac = Math.max(0, Math.min(1, order.customerSanityRemaining / CUSTOMER_SANITY_MAX));
      drawRoundRect(ctx, -16, -half - 20, 32, 4, 2, 'rgba(120,80,140,0.2)');
      drawRoundRect(ctx, -16, -half - 20, 32 * sanityFrac, 4, 2, '#c9a0dc');
    } else if (tableState.dirty) {
      ctx.fillStyle = '#c65f7c';
      ctx.font = 'bold 9px sans-serif';
      ctx.fillText('dirty', 0, 4);
    } else if (shiftState.phase !== 'playing') {
      ctx.fillStyle = '#4a9d5a';
      ctx.font = 'bold 9px sans-serif';
      ctx.fillText('clean', 0, 4);
    }
  }

  // v4 art pass: Library Shift's label ink/chip style (a darker warm ink, a
  // thin outline around the chip) — still the fix for "where is the coffee
  // machine???" (light chip behind dark text over any station color).
  const LABEL_TEXT_COLOR = '#3a2a2a';

  /** Small rounded chip behind a label so it stays legible over any station color. */
  function drawLabelChip(ctx, cx, cy, text, font) {
    if (!text) return;
    ctx.save();
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width + 14;
    const h = 16;
    drawRoundRect(ctx, cx - w / 2, cy - h / 2, w, h, 6, 'rgba(255,251,246,0.92)');
    ctx.strokeStyle = 'rgba(58,42,42,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(cx - w / 2, cy - h / 2, w, h, 6);
    ctx.stroke();
    ctx.fillStyle = LABEL_TEXT_COLOR;
    ctx.fillText(text, cx, cy + 0.5);
    ctx.restore();
  }

  /** A small cream plaque with bold caps text — Library Shift's "RETURNS"/"FINES" sign style. */
  function drawPlaque(text, cy, width, color = '#a0503a') {
    drawRoundRect(ctx, -width / 2, cy - 6, width, 12, 3, '#fdf8ee');
    ctx.fillStyle = color;
    ctx.font = 'bold 7px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 0, cy + 0.5);
  }

  /** A round brass knob — every door/cabinet detail drawer places its own. */
  function drawKnob(x, y, r = 2.6) {
    ctx.fillStyle = '#c9a24a';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.beginPath();
    ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.35, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Steam wisps rising from (x, y) — shared by the coffee machine, stove, oven and rice station. */
  function drawSteam(xs, y, height = 14, alpha = 0.8) {
    ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
    ctx.lineWidth = 1.5;
    for (const dx of xs) {
      ctx.beginPath();
      ctx.moveTo(dx, y);
      ctx.quadraticCurveTo(dx - 3, y - height / 3, dx, y - (height * 2) / 3);
      ctx.quadraticCurveTo(dx + 3, y - height * 0.85, dx, y - height);
      ctx.stroke();
    }
  }

  /** Whether the cook gauge is currently running at this station kind (glows/steam while cooking). */
  function isCookingAt(kind) {
    return Boolean(cookMiniGame && cookMiniGame.station === kind);
  }

  /**
   * v3.26/v3.27/v3.31: the front Counter — an employee standing behind a
   * solid counter-front panel that starts exactly at their torso-bottom
   * (shared/people.js's torso ends at y - 5*s), so the panel never crosses
   * the face and always hides the legs. v4: the employee is the shared
   * Library-style person; the panel is wood with a lighter countertop lip.
   */
  function drawCounterDetail(half) {
    const scale = 0.48;
    const waistY = -half + 24;
    drawKitchenPerson(ctx, 0, waistY, 'counterStaff', { scale });
    const panelTop = waistY - 5 * scale;
    drawRoundRect(ctx, -half, panelTop, half * 2, half - panelTop, [0, 0, 10, 10], '#c98a5a');
    drawRoundRect(ctx, -half, panelTop - 2, half * 2, 6, 3, '#e8b37a');
    ctx.strokeStyle = 'rgba(90,55,30,0.3)';
    ctx.lineWidth = 1.2;
    ctx.strokeRect(-half + 8, panelTop + 12, half - 12, half - panelTop - 18);
    ctx.strokeRect(4, panelTop + 12, half - 12, half - panelTop - 18);
    // Cash register: display, body, keypad.
    drawRoundRect(ctx, 6, panelTop - 12, 22, 6, 2, '#5a4a4a');
    drawRoundRect(ctx, 8, panelTop - 11, 12, 3.5, 1, '#9fe0a8');
    drawRoundRect(ctx, 4, panelTop - 6, 26, 8, 2, '#7a6a6a');
    // Service bell.
    ctx.fillStyle = '#e0a83a';
    ctx.beginPath();
    ctx.arc(-20, panelTop - 1, 5, Math.PI, 0);
    ctx.fill();
    ctx.fillRect(-21, panelTop - 9, 2, 3);
  }

  /** v4: Library Shift's espresso machine (bean hopper, display, brewing bay, cup, drip tray, steam), resized for this game's 70px box. */
  function drawCoffeeMachineDetail(half) {
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.beginPath();
    ctx.moveTo(-10, -half + 3);
    ctx.lineTo(10, -half + 3);
    ctx.lineTo(6, -half + 13);
    ctx.lineTo(-6, -half + 13);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#6a4a30';
    for (const [bx, by] of [[-5, -half + 7], [0, -half + 6], [5, -half + 7], [-2.5, -half + 10], [2.5, -half + 10]]) {
      ctx.beginPath();
      ctx.ellipse(bx, by, 1.8, 1.2, 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
    drawRoundRect(ctx, -half + 7, -half + 13, half * 2 - 14, half * 2 - 19, 6, '#7a5a42');
    drawRoundRect(ctx, -half + 7, -half + 13, half * 2 - 14, 8, [6, 6, 0, 0], '#8f6c50');
    drawRoundRect(ctx, -8, -half + 15, 16, 4, 1.5, '#9fe0a8');
    for (const [bx, color] of [[-half + 13, '#e8b95a'], [half - 13, '#e06a5b']]) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(bx, -half + 17, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    drawRoundRect(ctx, -half + 12, -half + 25, half * 2 - 24, half + 2, 5, '#4a3424');
    drawRoundRect(ctx, -7, -half + 25, 14, 5, 2, '#b0a090');
    ctx.fillStyle = '#b0a090';
    ctx.fillRect(-4, -half + 29, 2.5, 4);
    ctx.fillRect(1.5, -half + 29, 2.5, 4);
    ctx.fillStyle = '#c47f4e';
    ctx.fillRect(-0.75, -half + 33, 1.5, 3);
    drawRoundRect(ctx, -6.5, half - 21, 13, 10, [1, 1, 4, 4], '#fdf8ee');
    drawRoundRect(ctx, -5, half - 20, 10, 2, 1, '#6a4a30');
    ctx.strokeStyle = '#fdf8ee';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.arc(7.5, half - 16, 2.6, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
    drawRoundRect(ctx, -half + 10, half - 11, half * 2 - 20, 4, 2, '#b0a090');
    ctx.fillStyle = 'rgba(58,42,42,0.4)';
    for (let gx = -half + 13; gx < half - 11; gx += 4.5) ctx.fillRect(gx, half - 10.5, 1.3, 2.5);
    drawSteam([-11, 11], half - 22, 12);
  }

  /**
   * Fridge: a two-door fridge (small freezer on top), long handles, a
   * couple of magnets and a note. While its panel is open, the main door
   * swings away to show stocked shelves.
   */
  function drawFridgeDetail(half, open) {
    const seamY = -half + 22;
    if (open) {
      drawRoundRect(ctx, -half + 5, seamY + 3, half * 2 - 10, half - seamY - 8, 5, '#fdf8ee');
      for (const shelfY of [seamY + 15, seamY + 29]) {
        drawRoundRect(ctx, -half + 7, shelfY, half * 2 - 14, 2, 1, 'rgba(90,110,130,0.45)');
      }
      for (const [fx, fy, color] of [[-20, seamY + 9, '#e06a5b'], [-9, seamY + 9, '#f7d774'], [4, seamY + 9, '#ffffff'], [-16, seamY + 23, '#7aa865'], [-4, seamY + 23, '#f2b6c6'], [10, seamY + 23, '#c98a5a'], [-12, seamY + 37, '#6fa0d8'], [6, seamY + 37, '#e8b95a']]) {
        drawRoundRect(ctx, fx, fy - 4, 9, 8, 2, color);
      }
      drawRoundRect(ctx, half - 9, seamY + 3, 6, half - seamY - 8, 2, shadeColor('#bcd6e4', -0.1));
    }
    ctx.fillStyle = 'rgba(58,80,100,0.22)';
    ctx.fillRect(-half + 4, seamY, half * 2 - 8, 2);
    drawRoundRect(ctx, half - 12, -half + 7, 3.5, 11, 1.75, '#8aa2b2');
    if (!open) {
      drawRoundRect(ctx, half - 12, seamY + 6, 3.5, 22, 1.75, '#8aa2b2');
      // Magnets and a shopping-list note.
      drawRoundRect(ctx, -half + 10, seamY + 9, 14, 16, 1.5, '#fdf8ee');
      ctx.fillStyle = 'rgba(58,42,42,0.35)';
      for (const ly of [seamY + 13, seamY + 17, seamY + 21]) ctx.fillRect(-half + 12, ly, 10, 1);
      for (const [mx, my, color] of [[-half + 17, seamY + 8, '#e06a5b'], [2, seamY + 20, '#7aa865'], [-4, seamY + 30, '#e8b95a']]) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(mx, my, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(-half + 6, -half + 6, 3, half * 2 - 14);
  }

  /** Cabinet: a wood countertop lip over two raised-panel doors with knobs; open shows jars and boxes on shelves. */
  function drawCabinetDetail(half, open) {
    drawRoundRect(ctx, -half - 1, -half + 4, half * 2 + 2, 7, 3, '#f0d2a8');
    if (open) {
      drawRoundRect(ctx, -half + 5, -half + 14, half * 2 - 10, half * 2 - 19, 4, '#6a4a30');
      drawRoundRect(ctx, -half + 6, -2, half * 2 - 12, 2.5, 1, '#c99a6a');
      for (const [jx, jy, color] of [[-22, -12, '#f7d774'], [-10, -12, '#e06a5b'], [4, -14, '#fdf8ee'], [16, -12, '#7aa865'], [-18, 12, '#c98a5a'], [-4, 12, '#f2b6c6'], [12, 12, '#e8b95a']]) {
        drawRoundRect(ctx, jx - 4, jy - 6, 9, 12, 2, color);
        drawRoundRect(ctx, jx - 4, jy - 7.5, 9, 2.5, 1, 'rgba(58,42,42,0.4)');
      }
      return;
    }
    ctx.fillStyle = 'rgba(90,55,30,0.35)';
    ctx.fillRect(-0.75, -half + 13, 1.5, half * 2 - 18);
    ctx.strokeStyle = 'rgba(90,55,30,0.3)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-half + 8, -half + 18, half - 13, half * 2 - 28);
    ctx.strokeRect(5, -half + 18, half - 13, half * 2 - 28);
    drawKnob(-5, 4);
    drawKnob(5, 4);
  }

  /** Cookware Closet: open wooden shelving — a hanging utensil rail, a pot, a pan and a baking tray. */
  function drawCookwareClosetDetail(half, open) {
    drawRoundRect(ctx, -half + 5, -half + 5, half * 2 - 10, half * 2 - 10, 5, open ? '#f5ecf8' : shadeColor('#d6c3e0', 0.35));
    // Utensil rail with a ladle, spatula and whisk.
    drawRoundRect(ctx, -half + 9, -half + 9, half * 2 - 18, 2.5, 1, '#8a6a4a');
    ctx.strokeStyle = '#8a8f96';
    ctx.lineWidth = 1.6;
    for (const ux of [-16, -4, 8, 19]) {
      ctx.beginPath();
      ctx.moveTo(ux, -half + 11);
      ctx.lineTo(ux, -half + 22);
      ctx.stroke();
    }
    ctx.fillStyle = '#8a8f96';
    ctx.beginPath();
    ctx.arc(-16, -half + 23, 3, 0, Math.PI);
    ctx.fill();
    ctx.fillRect(-6.5, -half + 21, 5, 4);
    ctx.beginPath();
    ctx.ellipse(8, -half + 24, 2.5, 4, 0, 0, Math.PI * 2);
    ctx.stroke();
    // Two shelves.
    for (const shelfY of [2, half - 9]) drawRoundRect(ctx, -half + 6, shelfY, half * 2 - 12, 3, 1.5, '#b9824f');
    // Pot (body, handles, lid knob) and a pan on the top shelf.
    drawRoundRect(ctx, -24, -10, 18, 12, 3, '#9a6a5a');
    ctx.fillStyle = '#9a6a5a';
    ctx.fillRect(-27, -7, 3, 4);
    ctx.fillRect(-6, -7, 3, 4);
    drawRoundRect(ctx, -25, -12, 20, 3, 1.5, '#7a4a3a');
    ctx.beginPath();
    ctx.arc(-15, -13, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#5a4a44';
    ctx.beginPath();
    ctx.ellipse(10, -2, 11, 3.5, 0, 0, Math.PI * 2);
    ctx.fill();
    drawRoundRect(ctx, 20, -4, 11, 3, 1.5, '#8a5a3a');
    // Baking tray and a rice cooker on the bottom shelf.
    drawRoundRect(ctx, -26, half - 15, 24, 5, 1.5, '#a7aeb6');
    drawRoundRect(ctx, 6, half - 23, 18, 14, 5, '#f5f0e6');
    ctx.fillStyle = '#f0c6cf';
    ctx.beginPath();
    ctx.ellipse(15, half - 23, 9, 3.5, 0, Math.PI, 0);
    ctx.fill();
  }

  /** Cleaning Closet: a slatted-vent door, plus a mop and bucket leaning beside it; the dirty-dish count is a badge (drawStation). */
  function drawCleaningClosetDetail(half, open) {
    drawRoundRect(ctx, -half + 6, -half + 6, 30, half * 2 - 12, [5, 5, 2, 2], open ? '#4a5a52' : shadeColor('#c9e2d4', -0.08));
    if (!open) {
      ctx.fillStyle = 'rgba(58,80,70,0.3)';
      for (let vy = -half + 12; vy < -half + 28; vy += 4) ctx.fillRect(-half + 11, vy, 20, 1.6);
      drawKnob(-half + 31, 4);
    }
    // Mop: handle + fanned strands.
    ctx.strokeStyle = '#a68a6a';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(12, -half + 6);
    ctx.lineTo(18, half - 14);
    ctx.stroke();
    ctx.strokeStyle = '#e6dccb';
    ctx.lineWidth = 2;
    for (const dx of [12, 16, 20, 24]) {
      ctx.beginPath();
      ctx.moveTo(18, half - 15);
      ctx.lineTo(dx, half - 5);
      ctx.stroke();
    }
    // Bucket with water.
    ctx.fillStyle = '#6fa0d8';
    ctx.beginPath();
    ctx.moveTo(-6, half - 17);
    ctx.lineTo(12, half - 17);
    ctx.lineTo(10, half - 4);
    ctx.lineTo(-4, half - 4);
    ctx.closePath();
    ctx.fill();
    drawRoundRect(ctx, -6, half - 18, 18, 3, 1.5, '#bcdcf2');
    ctx.strokeStyle = '#4f7fb0';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.arc(3, half - 19, 7, Math.PI, 0);
    ctx.stroke();
  }

  /** Stove: a cooktop with four grated burners, a knob strip, and an oven door below. A burner glows (with a pan on it) while cooking. */
  function drawStoveDetail(half) {
    const cooking = isCookingAt('stove');
    drawRoundRect(ctx, -half + 4, -half + 4, half * 2 - 8, 30, 4, '#3a3634');
    for (const [bx, by] of [[-13, -half + 12], [13, -half + 12], [-13, -half + 26], [13, -half + 26]]) {
      ctx.strokeStyle = '#6a625e';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(bx, by, 5.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(bx, by, 2.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (cooking) {
      ctx.fillStyle = 'rgba(255,140,60,0.85)';
      ctx.beginPath();
      ctx.arc(-13, -half + 26, 6.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#5a4a44';
      ctx.beginPath();
      ctx.ellipse(-13, -half + 24, 9, 4, 0, 0, Math.PI * 2);
      ctx.fill();
      drawRoundRect(ctx, -4, -half + 22, 12, 3, 1.5, '#8a5a3a');
      drawSteam([-16, -10], -half + 20, 12);
    }
    // Knob strip.
    drawRoundRect(ctx, -half + 4, -1, half * 2 - 8, 7, 2, '#d6cdc2');
    for (const kx of [-20, -10, 10, 20]) {
      ctx.fillStyle = '#5a4a44';
      ctx.beginPath();
      ctx.arc(kx, 2.5, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    // Oven door with a window and handle.
    drawRoundRect(ctx, -half + 9, 12, half * 2 - 18, 4, 2, '#8a8f96');
    drawRoundRect(ctx, -half + 10, 18, half * 2 - 20, half - 23, 3, cooking ? '#5a3a2a' : '#4a4442');
  }

  /** Oven: a wall oven — an LCD timer and knobs on top, a handle bar, and a big window with a warm glow that brightens while baking. */
  function drawOvenDetail(half) {
    const cooking = isCookingAt('oven');
    drawRoundRect(ctx, -half + 5, -half + 5, half * 2 - 10, 12, 3, '#5a4a4a');
    drawRoundRect(ctx, -9, -half + 7.5, 18, 7, 1.5, '#9fe0a8');
    ctx.fillStyle = '#2a4a2a';
    ctx.font = 'bold 6px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(cooking ? '350°' : '0:00', 0, -half + 11.5);
    for (const kx of [-half + 11, half - 11]) {
      ctx.fillStyle = '#e8b95a';
      ctx.beginPath();
      ctx.arc(kx, -half + 11, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    drawRoundRect(ctx, -half + 9, -half + 21, half * 2 - 18, 3.5, 1.75, '#8a8f96');
    drawRoundRect(ctx, -half + 6, -half + 27, half * 2 - 12, half * 2 - 33, 5, shadeColor('#e9b9a8', -0.25));
    drawRoundRect(ctx, -half + 12, -half + 32, half * 2 - 24, half * 2 - 44, 4, cooking ? '#ffb45a' : '#f7d9a0');
    ctx.fillStyle = 'rgba(58,42,42,0.3)';
    ctx.fillRect(-half + 13, 8, half * 2 - 26, 1.5);
    if (cooking) drawSteam([-8, 8], -half + 22, 10, 0.7);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(-half + 14, -half + 34, 3, half - 12);
  }

  /**
   * Rice Station: a countertop with drawers and a power outlet — the spot
   * the Rice Cooker plugs into (rules.js's 'rice-station' dishes). Shows
   * the cooker sitting on it once the player has picked one up this shift
   * (steaming while the gauge runs), or an empty dashed spot until then.
   */
  function drawRiceStationDetail(half) {
    drawRoundRect(ctx, -half + 4, -half + 6, half * 2 - 8, 16, 3, '#f6eedf');
    drawRoundRect(ctx, half - 16, -half + 10, 8, 9, 2, '#fdf8ee');
    ctx.fillStyle = '#5a4a44';
    ctx.fillRect(half - 13.5, -half + 12.5, 1, 3);
    ctx.fillRect(half - 10.5, -half + 12.5, 1, 3);
    drawRoundRect(ctx, -half, 2, half * 2, 5, 2.5, '#e8b37a');
    drawRoundRect(ctx, -half + 2, 7, half * 2 - 4, half - 9, [0, 0, 8, 8], '#c98a5a');
    for (const dy of [10, 21]) {
      ctx.strokeStyle = 'rgba(90,55,30,0.35)';
      ctx.lineWidth = 1.2;
      ctx.strokeRect(-half + 8, dy, half * 2 - 16, 9);
      drawRoundRect(ctx, -5, dy + 3.5, 10, 2, 1, '#8a6a4a');
    }
    if (cookware.has('Rice Cooker')) {
      drawIconAt(ctx, -6, -10, 40, drawRiceCookerIcon);
      ctx.strokeStyle = '#5a4a44';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(8, -6);
      ctx.quadraticCurveTo(16, -4, half - 12, -half + 17);
      ctx.stroke();
      if (isCookingAt('rice-station')) drawSteam([-10, -2], -24, 12);
    } else {
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(90,55,30,0.45)';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.ellipse(-6, -4, 13, 5, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  /** Restroom: a door with a little WC sign and a brass knob. */
  function drawRestroomDetail(half) {
    drawRoundRect(ctx, -half + 10, -half + 6, half * 2 - 20, half * 2 - 6, [6, 6, 0, 0], 'rgba(60,110,130,0.14)');
    ctx.strokeStyle = 'rgba(60,110,130,0.3)';
    ctx.lineWidth = 1.3;
    ctx.strokeRect(-half + 15, -half + 30, half * 2 - 30, 14);
    ctx.strokeRect(-half + 15, 12, half * 2 - 30, 14);
    drawRoundRect(ctx, -13, -half + 11, 26, 14, 7, '#4f86b0');
    ctx.fillStyle = '#fdf8ee';
    for (const dx of [-5, 5]) {
      ctx.beginPath();
      ctx.arc(dx, -half + 15, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillRect(-6.5, -half + 17.5, 3, 5);
    ctx.beginPath();
    ctx.moveTo(5, -half + 17);
    ctx.lineTo(7.5, -half + 22.5);
    ctx.lineTo(2.5, -half + 22.5);
    ctx.closePath();
    ctx.fill();
    drawKnob(half - 16, 6);
  }

  /** Duke's Office: Library Shift's paneled office door with a brass "DUKE" plaque and knob; a padlock badge while locked. */
  function drawBossOfficeDetail(half, open) {
    drawRoundRect(ctx, -half + 9, -half + 5, half * 2 - 18, half * 2 - 5, [6, 6, 0, 0], 'rgba(90,60,90,0.18)');
    ctx.strokeStyle = 'rgba(90,60,90,0.28)';
    ctx.lineWidth = 1.4;
    ctx.strokeRect(-half + 14, -half + 22, half * 2 - 28, 17);
    ctx.strokeRect(-half + 14, 8, half * 2 - 28, 17);
    drawRoundRect(ctx, -14, -half + 8, 28, 10, 2, '#e8cf8a');
    ctx.fillStyle = '#8a6a3a';
    ctx.font = 'bold 7px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('DUKE', 0, -half + 13.5);
    drawKnob(half - 15, 3, 2.8);
    if (!open) {
      drawRoundRect(ctx, -11, -8, 22, 22, 11, 'rgba(255,251,246,0.92)');
      ctx.strokeStyle = '#5a5060';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.arc(0, -1, 4.2, Math.PI, 0);
      ctx.stroke();
      drawRoundRect(ctx, -6, 1, 12, 9, 2.5, '#5a5060');
    }
  }

  /**
   * Shared by kitchen-door (Dining -> Kitchen) and dining-door (Kitchen ->
   * Dining) — the same physical doorway seen from either side: two swinging
   * restaurant door leaves, each with a porthole window and a kick plate.
   */
  function drawSwingDoorDetail(half) {
    for (const dir of [-1, 1]) {
      const leafX = dir < 0 ? -half + 6 : 1.5;
      const leafW = half - 7.5;
      drawRoundRect(ctx, leafX, -half + 6, leafW, half * 2 - 10, 3, '#c98a5a');
      const cx = leafX + leafW / 2;
      ctx.fillStyle = '#bcdcf2';
      ctx.beginPath();
      ctx.arc(cx, -half + 20, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#8a8f96';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillRect(cx - 3.5, -half + 16, 2, 5);
      drawRoundRect(ctx, leafX + 2, half - 14, leafW - 4, 7, 2, '#a7aeb6');
    }
  }

  const STATION_DETAIL_DRAWERS = {
    fridge: drawFridgeDetail,
    cabinet: drawCabinetDetail,
    'cookware-closet': drawCookwareClosetDetail,
    'cleaning-closet': drawCleaningClosetDetail,
    stove: drawStoveDetail,
    oven: drawOvenDetail,
    'rice-station': drawRiceStationDetail,
    toilet: drawRestroomDetail,
    'boss-office': drawBossOfficeDetail,
    'kitchen-door': drawSwingDoorDetail,
    'dining-door': drawSwingDoorDetail,
    counter: drawCounterDetail,
    'coffee-machine': drawCoffeeMachineDetail,
  };

  /**
   * v3.16 tables are circles; v4 draws them as Library-style wood
   * furniture — a soft shadow, a wood rim, and a cream tablecloth with a
   * gold star. A dirty table shows a stacked plate and crumbs.
   */
  function drawTableTop(half, dirty) {
    ctx.fillStyle = 'rgba(58,42,42,0.14)';
    ctx.beginPath();
    ctx.ellipse(0, half * 0.18, half * 0.98, half * 0.9, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#b9824f';
    ctx.beginPath();
    ctx.arc(0, 0, half, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#d9a66b';
    ctx.beginPath();
    ctx.arc(0, -1, half - 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fdf8ee';
    ctx.beginPath();
    ctx.arc(0, -1, half * 0.72, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(198,95,124,0.35)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(0, -1, half * 0.62, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    if (dirty) {
      ctx.fillStyle = '#f0e6d6';
      ctx.beginPath();
      ctx.ellipse(-half * 0.2, -half * 0.1, half * 0.32, half * 0.22, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#d6c6ae';
      ctx.stroke();
      ctx.fillStyle = 'rgba(138,90,40,0.55)';
      for (const [dx, dy] of [[0.2, 0.2], [0.3, -0.25], [-0.05, 0.3], [0.12, 0.05]]) {
        ctx.beginPath();
        ctx.arc(dx * half, dy * half, 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      drawStar(ctx, 0, -1, half * 0.16, half * 0.07, '#e8b95a');
    }
  }

  function drawStation(station) {
    // Locked (not-yet-unlocked-this-tier) tables render nothing at all —
    // not even dimmed — per the user's explicit "tables not available
    // should not be visible."
    if (station.kind === 'table' && !isTableUnlocked(station.tableId, currentTableUnlockLevel())) return;

    const isHovered = hoverStation && hoverStation.id === station.id;
    const isTarget = moveTarget && moveTarget.station && moveTarget.station.id === station.id;
    const size = station.size;
    const half = size / 2;

    ctx.save();
    ctx.translate(Math.round(station.x), Math.round(station.y));

    const isTable = station.kind === 'table';
    const open = isStationOpen(station);

    if (isTable) {
      drawTableTop(half, Boolean(shiftState.tables[station.tableId] && shiftState.tables[station.tableId].dirty));
    } else {
      drawRoundRect(ctx, -half, -half, size, size, 10, STATION_COLORS[station.kind] || '#8a6a4a');
      const detail = STATION_DETAIL_DRAWERS[station.kind];
      if (detail) detail(half, open);
    }

    // Library Shift's outline: a thin warm ink edge, blue on hover, amber
    // on the station the player is walking to.
    ctx.strokeStyle = isTarget ? '#e0a83a' : (isHovered ? '#7fb0d6' : 'rgba(58,42,42,0.3)');
    ctx.lineWidth = isTarget || isHovered ? 3 : 2;
    ctx.beginPath();
    if (isTable) {
      ctx.arc(0, 0, half - 1, 0, Math.PI * 2);
    } else {
      ctx.roundRect(-half + 1, -half + 1, size - 2, size - 2, 8);
    }
    ctx.stroke();
    ctx.restore();
  }

  /**
   * v4: everything that sits *on top of* the furniture — seated customers
   * and their bars (tables), label chips and the dirty-dish badge — drawn
   * in a second pass after every station, so a customer seated at one
   * table is never covered by the next row's table, and a tight Tier 3
   * table row never hides a station's label chip.
   */
  function drawStationOverlay(station) {
    if (station.kind === 'table' && !isTableUnlocked(station.tableId, currentTableUnlockLevel())) return;
    const half = station.size / 2;
    const isTable = station.kind === 'table';
    ctx.save();
    ctx.translate(Math.round(station.x), Math.round(station.y));

    // Flip the label above the box for stations hugging the bottom edge,
    // so the chip never draws off-canvas. Tables have no caption (removed
    // per the user's request).
    if (!isTable) {
      const labelBelowFits = station.y + half + 13 + 7 <= CANVAS_HEIGHT;
      const labelY = labelBelowFits ? half + 13 : -half - 13;
      drawLabelChip(ctx, 0, labelY, hoverLabelFor(station), 'bold 11px sans-serif');
    }

    if (isTable) {
      drawTableContents(station);
    } else if (station.kind === 'cleaning-closet' && shiftState.dirtyDishCount > 0) {
      // Dirty-dish count as a badge on the closet's corner.
      drawRoundRect(ctx, half - 20, -half - 6, 24, 16, 8, '#e06a5b');
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(shiftState.dirtyDishCount), half - 8, -half + 2.5);
    }

    ctx.restore();
  }

  /** A station's on-canvas caption — Duke's Office reads "(locked)" until payday, like Library Shift's Boss's Office. */
  function hoverLabelFor(station) {
    if (station.kind === 'boss-office' && shiftState.phase !== 'paycheck') return "Duke's Office (locked)";
    return STATION_LABELS[station.kind] || '';
  }

  /**
   * The player's body/pose while holding something — a finished dish or
   * raw ingredients, either one (see drawPlayerCarrying/
   * drawPlayerCarryingIngredients below, the only two callers): legs stay
   * in the normal drawPixelPerson position, torso/arms bend in around a
   * tray instead of straight arms at the sides, and the whole upper
   * body/tray bobs by `bobOffset` (negative = up) while walking, per the
   * reviewed carrying-animation mockup. Draws everything except what's
   * actually sitting on the tray — callers draw that on top, after this
   * returns, so it's never at risk of being covered by the head. Returns
   * `{trayX, trayY, s}` for callers to draw against.
   *
   * v3.10: the user asked for the food to render ON the tray (realistic),
   * not in a badge above the head — v3.8 had moved it off the tray
   * because a small icon there read as an indistinct smudge at the
   * game's real on-screen size. Reconciled by making the tray itself much
   * bigger (`TRAY_RX`/`TRAY_RY`, roughly 1.5x the old v3.7 tray) rather
   * than moving the food elsewhere — see drawPlayerCarrying/
   * drawPlayerCarryingIngredients for the icon sizes this now supports
   * legibly directly on it.
   */
  const TRAY_RX = 22;
  const TRAY_RY = 7;

  function drawPlayerHolding(ctx, x, y, bobOffset) {
    const { trayX, trayY, s } = drawPlayerHoldingPose(x, y, bobOffset);
    // v4: the shared Library-style body (bobbing with the walk), with the
    // tray held out in front at chest height and both hands on its rim.
    drawKitchenPerson(ctx, x, y + bobOffset, 'server', { scale: s, stress: playerStress() });
    ctx.fillStyle = '#fdf1e4';
    ctx.strokeStyle = '#d6bf9a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(trayX, trayY, TRAY_RX * s, TRAY_RY * s, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = KITCHEN_PEOPLE.server.headColor;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(trayX + dir * (TRAY_RX - 1) * s, trayY + 1 * s, 2.7 * s, 0, Math.PI * 2);
      ctx.fill();
    }
    drawCoffeeSplash(x, y + bobOffset, s);
    return { trayX, trayY, s };
  }

  /**
   * The single held-dish icon's on-screen center/half-size for the given
   * pose — the exact same math drawPlayerCarrying uses to draw it, shared
   * so click hit-testing (v3.24: "clicking on the food icon on the tray
   * should remove the food") can never drift from what's actually drawn.
   * `null` when not holding a finished dish.
   */
  function heldDishIconHit(x, y, bobOffset, dishName) {
    if (!dishName) return null;
    const { trayX, trayY, s } = drawPlayerHoldingPose(x, y, bobOffset);
    const size = 28 * s;
    return { x: trayX, y: trayY - 3 * s, halfSize: size / 2 };
  }

  /**
   * Every carried raw ingredient's on-screen center/half-size for the
   * given pose, in the same stacked-tray layout
   * drawPlayerCarryingIngredients draws — shared with click hit-testing
   * for the same reason as heldDishIconHit above. Each entry also carries
   * the ingredient's index into `items`, so a hit can be spliced out of
   * `inventory` directly.
   */
  function trayIngredientIconHits(x, y, bobOffset, items) {
    if (items.length === 0) return [];
    const { trayX, trayY, s } = drawPlayerHoldingPose(x, y, bobOffset);
    const perRow = items.length <= 3 ? items.length : Math.ceil(items.length / 2);
    const iconSize = (items.length === 1 ? 26 : items.length <= 3 ? 20 : 16) * s;
    const step = iconSize * 0.95;
    return items.map((name, i) => {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      const itemsInRow = Math.min(perRow, items.length - row * perRow);
      const rowStartX = trayX - ((itemsInRow - 1) * step) / 2;
      return { index: i, name, x: rowStartX + col * step, y: trayY - 3 * s - row * step, halfSize: iconSize / 2 };
    });
  }

  /** Pure geometry half of drawPlayerHolding — just the trayX/trayY/s a given pose produces, without drawing anything. */
  function drawPlayerHoldingPose(x, y, bobOffset) {
    const s = 1.25;
    const uy = y + bobOffset;
    return { trayX: x, trayY: uy - 12 * s, s };
  }

  /**
   * Holding a finished dish: its icon (drawDishIcon) sits directly on the
   * tray, sized generously (28px at the player's normal scale) since it's
   * the only thing on the tray.
   */
  function drawPlayerCarrying(ctx, x, y, dishName, bobOffset) {
    drawPlayerHolding(ctx, x, y, bobOffset);
    const hit = heldDishIconHit(x, y, bobOffset, dishName);
    drawDishIcon(ctx, hit.x, hit.y, dishName, hit.halfSize * 2);
  }

  /**
   * Holding one or more raw ingredients (gathered but not yet cooked or
   * assembled into a dish): each item's icon stacks onto the tray as it's
   * picked up — up to 3 across in one row (a full recipe's worth, the
   * common case), a second, higher row for anything beyond that (gear can
   * push carry capacity up to 8) so a fuller tray still fits rather than
   * spilling off it, with icons shrinking a little as more items join.
   */
  function drawPlayerCarryingIngredients(ctx, x, y, items, bobOffset) {
    drawPlayerHolding(ctx, x, y, bobOffset);
    for (const hit of trayIngredientIconHits(x, y, bobOffset, items)) {
      drawIngredientIcon(ctx, hit.x, hit.y, hit.name, hit.halfSize * 2);
    }
  }

  /** The player's current draw-time position/bob — shared by drawPlayer (rendering) and onCanvasClick's tray-icon hit-testing, so a click is tested against exactly what's on screen this frame. */
  /**
   * v3.33: the single source both `drawPlayer` and this file's tray-icon
   * click hit-testing (`heldDishIconHit`/`trayIngredientIconHits`, the
   * established v3.24 "shared geometry" pattern) already read from — so
   * routing the collision-avoidance nudge through here, rather than
   * through `player.x/player.y` directly, keeps drawing and hit-testing
   * exactly in sync for free, the same way that pattern already did for
   * the carrying-pose bob offset.
   */
  function currentPlayerDrawPose() {
    const obstacles = stationObstaclesForRoom(currentRoom);
    const visual = resolveObstacleCollisions(player.x, player.y, PLAYER_COLLISION_RADIUS, obstacles);
    return {
      x: Math.round(visual.x),
      y: Math.round(visual.y),
      bobOffset: moveTarget ? Math.sin(carryBobPhase) * CARRY_BOB_AMPLITUDE : 0,
    };
  }

  function drawPlayer() {
    const { x, y, bobOffset } = currentPlayerDrawPose();

    if (heldDish) {
      drawPlayerCarrying(ctx, x, y, heldDish, bobOffset);
      return;
    }

    if (inventory.length > 0) {
      drawPlayerCarryingIngredients(ctx, x, y, inventory, bobOffset);
      return;
    }

    drawKitchenPerson(ctx, x, y, 'server', { scale: 1.25, stress: playerStress() });
    drawCoffeeSplash(x, y, 1.25);
  }

  /** The player's low-Sanity stress (0..1) — Library Shift's worried face, eye bags and sweat drop below HALLUCINATION_START_SANITY. */
  function playerStress() {
    return shiftState ? hallucinationIntensity(shiftState.sanity) : 0;
  }

  // Security guard — a stationary decorative figure near the entrance/
  // counter ("there's security to protect the place"). Purely visual: not
  // a floor-plan.js station, not clickable, no interaction of its own —
  // just presence, standing watch by the door the same way real diners
  // often post someone near the entrance.
  const SECURITY_GUARD_POSITION = { x: 560, y: 545 };

  function drawSecurityGuard() {
    drawKitchenPerson(ctx, SECURITY_GUARD_POSITION.x, SECURITY_GUARD_POSITION.y, 'guard', { scale: 1.1 });
    drawLabelChip(ctx, SECURITY_GUARD_POSITION.x, SECURITY_GUARD_POSITION.y + 26, 'Security', 'bold 10px sans-serif');
  }

  // On-canvas Sanity and Reputation bars (top-left of the floor plan,
  // inside the scene per the user's "add the sanity bar inside the game").
  // v4: Library Shift's look — the Sanity label in the site's display font,
  // Caprasimo, once it has loaded (a canvas draw before the @font-face is
  // ready silently falls back, so every frame re-checks).
  let displayFontReady = false;
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { displayFontReady = true; }).catch(() => {});
  }

  function drawStatBar(y, label, value, max, colors, font) {
    const x = 14;
    const width = 130;
    const height = 16;
    const percent = Math.round(value);
    const frac = Math.max(0, Math.min(1, value / max));
    const fillColor = percent > 50 ? colors[0] : (percent > 20 ? '#e0a83a' : '#e06a5b');
    ctx.save();
    drawRoundRect(ctx, x, y, width, height, 8, 'rgba(255,251,246,0.85)');
    if (frac > 0) drawRoundRect(ctx, x + 2, y + 2, Math.max(6, (width - 4) * frac), height - 4, 6, fillColor);
    ctx.strokeStyle = 'rgba(58,42,42,0.3)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, 8);
    ctx.stroke();
    ctx.fillStyle = LABEL_TEXT_COLOR;
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${label} ${percent}%`, x + width / 2, y + height / 2 + 0.5);
    ctx.restore();
  }

  function drawSanityBar() {
    drawStatBar(14, 'Sanity', shiftState.sanity, SANITY_MAX, ['#7fd68a'],
      displayFontReady ? 'bold 11px "Caprasimo", sans-serif' : 'bold 11px sans-serif');
  }

  // v3.11: the restaurant's reputation, directly below Sanity — every
  // mistake drains it; v4 adds penalties while it sits at 0.
  function drawReputationBar() {
    drawStatBar(36, 'Reputation', shiftState.reputation, REPUTATION_MAX, ['#7fb0d6'], 'bold 10px sans-serif');
  }

  /**
   * v3.12: a small speech bubble — dish icon + name, rounded body with a
   * tail pointing down at the table — showing what a customer just
   * ordered, for `ORDER_BUBBLE_SECONDS` right after the player arrives at
   * their table (see handleTableArrival/updateOrderBubble). Absolute
   * canvas coordinates, not the per-station `ctx.translate` drawStation
   * uses, since it's drawn independently of the station-render pass (after
   * drawPlayer, so the player sprite standing right at that table can
   * never cover it).
   *
   * v3.17: the user asked specifically for this moment's dish icon — the
   * one visible right as the food server takes a customer's order — to
   * read bigger, so `iconSize` grew (22 → 32) with the bubble/font/gap
   * scaled up to match rather than the icon just overflowing a
   * small-icon-sized bubble. Every other on-canvas dish icon (the tray,
   * held-item badges) is untouched — only this order-taking bubble.
   *
   * v3.19: the dish-name text is gone — icon-only now, per the user's
   * direct request ("remove the names from the customer order bubble") —
   * and the icon grew again (40 → 56) so it reads clearly on its own
   * without the name as a fallback.
   */
  function drawOrderBubble() {
    if (!orderBubble) return;
    const station = stations.find((s) => s.kind === 'table' && s.tableId === orderBubble.tableId);
    if (!station || station.room !== currentRoom) return;

    const x = station.x;
    const bubbleY = station.y - station.size / 2 - 46;
    // v3.23: every food icon shown here is a uniform 24x24, per the
    // user's explicit "all food icons 24x24" request. For a composite
    // order (Mel's Usual, Olive & Oliver's — both "assembled from
    // separate items," rules.js's MEL_DISH/COUPLE_DISH.ingredients) that
    // means one full 24x24 icon PER INGREDIENT, side by side — squeezing
    // 2-3 items into one icon-sized slot (the first version of this
    // change) made them illegible, which is the opposite of the point.
    const iconSize = 24;
    const iconGap = 4;
    const compositeIngredients = orderBubble.dishName === MEL_DISH.name
      ? MEL_DISH.ingredients
      : orderBubble.dishName === COUPLE_DISH.name
        ? COUPLE_DISH.ingredients
        : null;
    const iconCount = compositeIngredients ? compositeIngredients.length : 1;
    const contentWidth = iconCount * iconSize + (iconCount - 1) * iconGap;

    ctx.save();
    const paddingX = 8;
    const paddingY = 6;
    const bubbleW = contentWidth + paddingX * 2;
    const bubbleH = iconSize + paddingY * 2;

    ctx.fillStyle = 'rgba(255,251,246,0.95)';
    ctx.strokeStyle = '#e0a8c0';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(x - bubbleW / 2, bubbleY - bubbleH / 2, bubbleW, bubbleH, 12);
    ctx.fill();
    ctx.stroke();

    // Tail pointing down toward the table.
    ctx.fillStyle = 'rgba(255,251,246,0.95)';
    ctx.beginPath();
    ctx.moveTo(x - 6, bubbleY + bubbleH / 2 - 1);
    ctx.lineTo(x + 2, bubbleY + bubbleH / 2 + 9);
    ctx.lineTo(x + 9, bubbleY + bubbleH / 2 - 1);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#e0a8c0';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x - 6, bubbleY + bubbleH / 2 - 1);
    ctx.lineTo(x + 2, bubbleY + bubbleH / 2 + 9);
    ctx.lineTo(x + 9, bubbleY + bubbleH / 2 - 1);
    ctx.stroke();
    // Re-fill over the seam where the tail meets the bubble body, so the
    // stroke drawn above doesn't leave a visible line across the join.
    ctx.fillStyle = 'rgba(255,251,246,0.95)';
    ctx.fillRect(x - 6, bubbleY + bubbleH / 2 - 2, 15, 3);

    if (compositeIngredients) {
      const startX = x - contentWidth / 2 + iconSize / 2;
      compositeIngredients.forEach((ingredientName, i) => {
        drawIngredientIcon(ctx, startX + i * (iconSize + iconGap), bubbleY, ingredientName, iconSize);
      });
    } else {
      drawDishIcon(ctx, x, bubbleY, orderBubble.dishName, iconSize);
    }
    ctx.restore();
  }

  function render() {
    // v4: past 60% hallucination intensity the whole room shakes (the HUD,
    // drawn after the restore, stays steady) — Library Shift's same effect.
    const i = currentIntensity();
    const shake = i > 0.6 ? (i - 0.6) * 5 : 0;
    ctx.save();
    if (shake > 0) ctx.translate((Math.random() - 0.5) * 2 * shake, (Math.random() - 0.5) * 2 * shake);
    drawFloor();
    const roomStations = stationsInRoom(stations, currentRoom);
    roomStations.forEach((station) => drawStation(station));
    roomStations.forEach((station) => drawStationOverlay(station));
    // Guard stands watch by the Dining entrance — not a Kitchen fixture.
    if (currentRoom === ROOM_DINING) drawSecurityGuard();
    if (currentRoom === ROOM_DINING) drawArrivingCustomers();
    if (currentRoom === ROOM_DINING) drawPayingCustomers();
    drawPlayer();
    drawOrderBubble();
    drawHallucinations();
    ctx.restore();
    drawSanityBar();
    drawReputationBar();
    drawGardCounter();
    drawCoffeePourOverlay();
  }

  // -- Game loop ------------------------------------------------------

  function loop(timestamp) {
    if (!running || paused) { rafHandle = null; return; }
    if (lastTimestamp === null) lastTimestamp = timestamp;
    const deltaSeconds = Math.min(0.1, (timestamp - lastTimestamp) / 1000);
    lastTimestamp = timestamp;

    if (!activePanel && !recipeBookOpen && !coffeePour) updatePlayer(deltaSeconds);

    if (shiftState.phase === 'playing') {
      const beforeTick = shiftState;
      shiftState = tick(shiftState, deltaSeconds);
      announceZeroReputationPenalties(beforeTick);
      if (karen) {
        const hadOrder = beforeTick.orders.some((o) => o.tableId === karen.tableId);
        const stillHasOrder = shiftState.orders.some((o) => o.tableId === karen.tableId);
        if (hadOrder && !stillHasOrder) triggerKarenRipple();
      }
      if (mel) {
        // No ripple for Mel — she's sweet and understanding, even kept
        // waiting. Just stop tracking her once her order is gone, whether
        // served (handled synchronously in handleTableArrival, which
        // already nulled her out) or timed out (here).
        const hadOrder = beforeTick.orders.some((o) => o.tableId === mel.tableId);
        const stillHasOrder = shiftState.orders.some((o) => o.tableId === mel.tableId);
        if (hadOrder && !stillHasOrder) mel = null;
      }
      if (couple) {
        const hadOrder = beforeTick.orders.some((o) => o.tableId === couple.tableId);
        const stillHasOrder = shiftState.orders.some((o) => o.tableId === couple.tableId);
        if (hadOrder && !stillHasOrder) couple = null;
      }
      if (shiftState.phase === 'playing') {
        timeSinceCustomerSpawn += deltaSeconds;
        maybeSpawnCustomer();
        updateArrivingCustomers(deltaSeconds);
        updateCookMiniGame(deltaSeconds);
      } else {
        cancelCookMiniGame();
        pendingCustomers = {};
        arrivingCustomers = [];
        karen = null;
        mel = null;
        couple = null;
      }
    } else {
      updateClosingTimer(deltaSeconds);
    }

    updateOrderBubble(deltaSeconds);
    updatePayingCustomers(deltaSeconds);
    updateCoffeePour(deltaSeconds);
    updateHallucinations(deltaSeconds);
    trackGardPops(deltaSeconds);
    updateHoverHint();
    renderHud();
    renderOrderQueue();
    render();

    rafHandle = window.requestAnimationFrame(loop);
  }

  // -- Room toggle button -------------------------------------------------

  // A DOM shortcut alongside the canvas's own kitchen-door/dining-door
  // stations — the user asked for both "a door to the kitchen" and "a
  // button to enter the kitchen"; this button switches instantly from
  // wherever the player currently stands, no walk-up needed.
  function updateRoomButton() {
    if (!elements.roomButton) return;
    const inKitchen = currentRoom === ROOM_KITCHEN;
    elements.roomButton.textContent = inKitchen ? 'Back to Dining' : 'Enter Kitchen';
    elements.roomButton.setAttribute('aria-pressed', String(inKitchen));
  }

  function toggleRoomButton() {
    if (currentRoom === ROOM_DINING) {
      switchRoom(ROOM_KITCHEN, KITCHEN_ENTRY_POINT);
    } else {
      switchRoom(ROOM_DINING, DINING_ENTRY_POINT);
    }
  }

  // -- Fullscreen -------------------------------------------------------

  // Called both from the "Fullscreen" button and (best-effort) as soon as
  // a shift starts, so the game "launches" full-size rather than making
  // the player hunt for the small toggle button first — see startShift().
  // Both call sites fire from a click handler, satisfying the Fullscreen
  // API's user-gesture requirement; the .catch swallows rejection when a
  // browser still refuses (e.g. iOS Safari, which doesn't support
  // Fullscreen on canvases' ancestors at all).
  function requestFullscreen() {
    if (document.fullscreenElement) return;
    // #cooking-game-container, not canvas.parentElement (which is the
    // narrower #cooking-canvas-wrapper one level in) — the Orders bar
    // needs to be inside the Fullscreen API target too, per the user's
    // "orders on the same window" request, so fullscreening just the
    // canvas's immediate parent would leave it behind.
    const container = document.getElementById('cooking-game-container');
    container.requestFullscreen?.().catch(() => {});
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      requestFullscreen();
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }

  function onFullscreenChange() {
    elements.fullscreenButton.textContent = document.fullscreenElement ? 'Exit Fullscreen' : 'Fullscreen';
  }

  function onVisibilityChange() {
    paused = document.hidden;
    if (!paused && running && rafHandle === null) {
      lastTimestamp = null;
      rafHandle = window.requestAnimationFrame(loop);
    }
  }

  // -- Event wiring -----------------------------------------------------

  canvas.addEventListener('click', onCanvasClick);
  canvas.addEventListener('mousemove', onCanvasMouseMove);
  canvas.addEventListener('mouseleave', onCanvasMouseLeave);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  canvas.addEventListener('pointerdown', onCanvasPointerDown);
  window.addEventListener('pointerup', onWindowPointerUp);
  window.addEventListener('pointercancel', onWindowPointerUp);
  document.addEventListener('visibilitychange', onVisibilityChange);
  elements.fullscreenButton.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  elements.recipeBookButton.addEventListener('click', openRecipeBook);
  elements.roomButton?.addEventListener('click', toggleRoomButton);
  elements.recipeBook.closeButton.addEventListener('click', closeRecipeBook);
  elements.cookGauge.button.addEventListener('click', sampleCookGauge);
  elements.stationPanel.closeButton.addEventListener('click', closePanel);
  // v3.24: clicking the open backdrop area of a popup menu (outside its
  // centered card) closes it automatically, same as clicking Close — the
  // root element only ever receives a click event as its own `target`
  // when the click didn't land on any of its children (the card and
  // everything inside it), so this is a reliable "clicked outside" check.
  elements.stationPanel.root.addEventListener('click', (e) => {
    if (e.target === elements.stationPanel.root) closePanel();
  });
  elements.recipeBook.root.addEventListener('click', (e) => {
    if (e.target === elements.recipeBook.root) closeRecipeBook();
  });

  elements.startScreen.shiftButton.addEventListener('click', startShift);
  if (elements.startScreen.shopButton) elements.startScreen.shopButton.addEventListener('click', openShop);
  elements.paycheckScreen.nextShiftButton.addEventListener('click', startShift);
  elements.paycheckScreen.newMonthButton.addEventListener('click', startNewMonth);
  elements.paycheckScreen.shopButton.addEventListener('click', openShop);
  if (elements.paycheckScreen.submitButton) {
    elements.paycheckScreen.submitButton.addEventListener('click', () => {
      // Same real bug fixed in fishing-game.js's round-over submit handler:
      // disabling a submit <button> synchronously in its own click handler
      // suppresses the form's default submit action. Defer by one tick.
      window.setTimeout(() => { elements.paycheckScreen.submitButton.disabled = true; }, 0);
    });
  }
  elements.shopScreen.closeButton.addEventListener('click', renderStartScreen);
  elements.shopScreen.resetButton.addEventListener('click', resetProgress);
  Object.keys(GEAR_DEFS).forEach((key) => {
    const row = elements.shopScreen.gearItems[key];
    if (row && row.buyButton) row.buyButton.addEventListener('click', () => buyGear(key));
  });

  function teardown() {
    running = false;
    if (rafHandle !== null) {
      window.cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
    if (toastTimeoutHandle) window.clearTimeout(toastTimeoutHandle);
    canvas.removeEventListener('click', onCanvasClick);
    canvas.removeEventListener('mousemove', onCanvasMouseMove);
    canvas.removeEventListener('mouseleave', onCanvasMouseLeave);
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
    canvas.removeEventListener('pointerdown', onCanvasPointerDown);
    window.removeEventListener('pointerup', onWindowPointerUp);
    window.removeEventListener('pointercancel', onWindowPointerUp);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    document.body.removeEventListener('htmx:beforeSwap', teardown);
    if (teardownActiveInstance === teardown) teardownActiveInstance = null;
  }

  // Doc's Cleanup requirement: tear down on HTMX nav-away, not just full
  // page unload. Same target-check reasoning as fishing-game.js's
  // equivalent listener.
  document.body.addEventListener('htmx:beforeSwap', (e) => {
    if (e.target && e.target.id === 'main-content') teardown();
  });

  teardownActiveInstance = teardown;

  // Test-only debug hooks for e2e/cooking-game.spec.js — reaching a
  // shift's end "naturally" means waiting out the full shift-clock
  // countdown (v3.14: varies by round tier, shiftClockSecondsForShift),
  // too slow for a reliable browser test. These drive the exact same real
  // transitions (tick/cleanTable/washDishes/shutDown from
  // ./cooking/engine-state.js, then the real endShift() below) real play
  // uses. Real clicks (via Playwright mouse events against the canvas) are
  // used for everything else — these hooks exist only to fast-forward the
  // closing sequence's real-time waits, same reasoning as the v1 hooks.
  if (typeof window !== 'undefined') {
    window.__cookingGameTestHooks = {
      skipToClosing() {
        if (!running || !shiftState || shiftState.phase !== 'playing') return;
        shiftState = tick(shiftState, shiftClockSecondsForShift(currentShiftNumber) + 1);
        pendingCustomers = {};
        arrivingCustomers = [];
        cancelCookMiniGame();
        for (const id of TABLE_IDS) shiftState = cleanTable(shiftState, id);
        shiftState = washDishes(shiftState);
        shiftState = shutDown(shiftState);
      },
      forceUpset() {
        if (!running || !shiftState || shiftState.phase !== 'playing') return;
        shiftState = serveDish(shiftState, TABLE_IDS[0], '__test-nonexistent-dish__');
      },
      collectPaycheck() {
        if (!shiftState || shiftState.phase !== 'paycheck') return;
        endShift();
      },
      // v4 hooks (e2e/cooking-game.spec.js): read state, and patch the
      // stats a test needs (e.g. Sanity/Reputation at 0) without waiting
      // out the real drains.
      getShiftState() { return shiftState; },
      setShiftStats(patch) { if (shiftState) shiftState = { ...shiftState, ...patch }; },
      stationPosition(id) {
        const station = stations.find((st) => st.id === id);
        return station ? { x: station.x, y: station.y, size: station.size, room: station.room } : null;
      },
      getRoom() { return currentRoom; },
      getCoffeePour() { return coffeePour ? { ...coffeePour, band: { ...coffeePour.band } } : null; },
      setCoffeePourFill(fill) { if (coffeePour && !coffeePour.grade) coffeePour.fill = fill; },
      getCoffeeSplashSeconds() { return coffeeSplashSeconds; },
      getHallucinations() {
        return { intensity: currentIntensity(), ghosts: halluc.ghosts.map((g) => ({ ...g })), figures: halluc.figures.length, whispers: halluc.whispers.length };
      },
      spawnGhostNow() { return shiftState ? spawnGhostCustomer(60) : null; },
      getGardPops() { return gardPops.map((pop) => ({ ...pop })); },
      getNetShiftGard() { return netShiftGard(); },
      getKarenEncounter() { return karenThisShift; },
      getCookZone() { return cookMiniGame ? { ...cookMiniGame.zone } : null; },
      isPlayerMoving() { return moveTarget !== null; },
      getHeld() { return { heldDish, inventory: [...inventory], cookware: [...cookware], activeOrderTableId }; },
      getKaren() { return karen ? { ...karen } : null; },
      /** Seats a waiting customer at `tableId` right away (skipping the walk-in) wanting `dishName`. */
      seatCustomerNow(tableId, dishName) {
        pendingCustomers[tableId] = dishName;
        customerLooks[tableId] = CUSTOMER_LOOK_KEYS[Math.floor(random() * CUSTOMER_LOOK_KEYS.length)];
      },
      setHeldDish(name) { heldDish = name; },
      freeTableId() {
        const level = currentTableUnlockLevel();
        return TABLE_IDS.find((id) => isTableUnlocked(id, level) && !shiftState.tables[id].occupied
          && !pendingCustomers[id] && !arrivingCustomers.some((c) => c.tableId === id) && !ghostAtTable(id)) ?? null;
      },
      setCookGauge(position) { if (cookMiniGame) cookMiniGame.gaugePosition = position; },
    };
  }

  renderStartScreen();

  return teardown;
}

let teardownActiveInstance = null;

// ---------------------------------------------------------------------------
// Auto-bootstrap (browser only)
// ---------------------------------------------------------------------------

function queryGearItems(shopRoot) {
  const gearItems = {};
  Object.keys(GEAR_DEFS).forEach((key) => {
    const row = shopRoot ? shopRoot.querySelector(`[data-gear-key="${key}"]`) : null;
    if (!row) return;
    gearItems[key] = {
      levelText: row.querySelector('[data-gear-level]'),
      costText: row.querySelector('[data-gear-cost]'),
      buyButton: row.querySelector('[data-gear-buy]'),
    };
  });
  return gearItems;
}

function bootstrap() {
  const canvas = document.getElementById('cooking-canvas');
  if (!canvas) return; // this page isn't mounted — no-op, same convention as fishing-game.js

  const shopRoot = document.getElementById('cooking-shop-screen');

  const elements = {
    hud: {
      shift: document.getElementById('cooking-hud-shift'),
      clock: document.getElementById('cooking-hud-clock'),
      status: document.getElementById('cooking-hud-status'),
    },
    orderQueue: document.getElementById('cooking-order-queue'),
    hoverHint: document.getElementById('cooking-interact-hint'),
    toast: document.getElementById('cooking-toast'),
    introScreen: {
      root: document.getElementById('cooking-intro-screen'),
      line: document.getElementById('cooking-intro-line'),
      continueButton: document.getElementById('cooking-intro-continue-button'),
    },
    fullscreenButton: document.getElementById('cooking-fullscreen-button'),
    roomButton: document.getElementById('cooking-room-button'),
    recipeBookButton: document.getElementById('cooking-recipe-book-button'),
    recipeBook: {
      root: document.getElementById('cooking-recipe-book'),
      list: document.getElementById('cooking-recipe-book-list'),
      closeButton: document.getElementById('cooking-recipe-book-close-button'),
    },
    cookGauge: {
      root: document.getElementById('cooking-gauge'),
      fill: document.getElementById('cooking-gauge-fill'),
      zone: document.getElementById('cooking-gauge-zone'),
      button: document.getElementById('cooking-gauge-button'),
    },
    stationPanel: {
      root: document.getElementById('cooking-station-panel'),
      title: document.getElementById('cooking-station-panel-title'),
      list: document.getElementById('cooking-station-panel-list'),
      closeButton: document.getElementById('cooking-station-panel-close-button'),
    },
    startScreen: {
      root: document.getElementById('cooking-start-screen'),
      gard: document.getElementById('cooking-start-gard'),
      bestMonth: document.getElementById('cooking-start-best-month'),
      level: document.getElementById('cooking-start-level'),
      storageNotice: document.getElementById('cooking-storage-notice'),
      shiftButton: document.getElementById('cooking-start-shift-button'),
      shopButton: document.getElementById('cooking-start-shop-button'),
    },
    paycheckScreen: {
      root: document.getElementById('cooking-paycheck-screen'),
      title: document.getElementById('cooking-paycheck-title'),
      outcome: document.getElementById('cooking-paycheck-outcome'),
      shiftTotal: document.getElementById('cooking-paycheck-shift-total'),
      monthTotal: document.getElementById('cooking-paycheck-month-total'),
      finalBlock: document.getElementById('cooking-final-paycheck-block'),
      nameInput: document.getElementById('cooking-paycheck-name-input'),
      earningsInput: document.getElementById('cooking-paycheck-earnings-input'),
      shiftsInput: document.getElementById('cooking-paycheck-shifts-input'),
      submitButton: document.getElementById('cooking-paycheck-submit-button'),
      nextShiftButton: document.getElementById('cooking-paycheck-next-shift-button'),
      newMonthButton: document.getElementById('cooking-paycheck-new-month-button'),
      shopButton: document.getElementById('cooking-paycheck-shop-button'),
    },
    shopScreen: {
      root: shopRoot,
      gard: document.getElementById('cooking-shop-gard'),
      closeButton: document.getElementById('cooking-shop-close-button'),
      resetButton: document.getElementById('cooking-shop-reset-button'),
      gearItems: queryGearItems(shopRoot),
    },
  };

  init(canvas, elements);
}

if (typeof document !== 'undefined') {
  bootstrap();

  // A `<script type="module">`'s top-level code runs at most once per
  // resolved URL for the whole document's lifetime (per spec) — so if the
  // visitor navigates away from /kitchen-shift and back via HTMX later in
  // the same tab, htmx recreates and re-inserts this <script> tag, but the
  // browser does NOT re-execute it, meaning the plain `bootstrap()` call
  // above never fires again and the freshly swapped-in #cooking-canvas (and
  // every HUD/start-screen/paycheck-screen/shop element) is never wired up
  // — a real bug this shipped with: a revisit left the start screen
  // visually intact (it's static HTML, so it still *looked* fine) but
  // completely inert, e.g. its shift-start button silently doing nothing.
  // See docs/features/puzzle-solver.md's "Later change" note for the full
  // writeup of this bug, first caught on that feature (whose canvas draws
  // immediately and so failed loudly, unlike this one). document.body
  // survives every #main-content swap, so registering this listener once,
  // during whichever visit happens to be this file's one-and-only
  // execution, keeps it alive to catch every later swap too. init()'s own
  // teardown-previous-instance guard (line ~1368 above) makes calling
  // bootstrap() again here safe even on the very first swap, where this
  // listener and the direct call above can both fire for the same
  // navigation.
  document.body.addEventListener('htmx:afterSwap', (e) => {
    if (e.target && e.target.id === 'main-content') bootstrap();
  });
}
