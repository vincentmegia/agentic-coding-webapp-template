// Pure, canvas-independent game rules for Bus Rush
// (docs/features/bus-rush.md's Business Rules).
//
// No DOM/canvas/localStorage/timer dependencies, so it runs under
// `node --test` and is imported unchanged by bus-rush.js. The numbers are
// tunable; the shapes (bounds, caps, "every row is passable") are not.

/** Number of road lanes. */
export const LANES = 4;

/** Canvas pixels per world metre — the scale traffic and fares scroll at. */
export const PX_PER_METER = 8;

/** Speeds are metres/second; the HUD shows km/h. */
export const MIN_SPEED = 8;
export const BASE_MAX_SPEED = 16;
export const ENGINE_SPEED_STEP = 3;
export const ACCELERATION = 6;
export const BRAKING = 14;

/** Oncoming traffic's own speed. One shared value on purpose: if vehicles
 * moved at different speeds, rows could drift into each other and close
 * every lane at once, breaking pickBlockedLanes' guarantee. */
export const TRAFFIC_SPEED = 6;

/** Seconds of invulnerability after a hit. */
export const HIT_GRACE_SECONDS = 1.5;

export const BASE_LIVES = 3;
export const FARE_POINTS = 25;

/** Leaderboard bounds — mirror internal/service/bus_rush_validation.go. */
export const SCORE_MAX = 999999;
export const DISTANCE_MAX = 999999;

/** Shop upgrades. `key` matches data-upgrade-key in bus-rush-shop.html. */
export const UPGRADES = {
  engine: { label: 'Engine', baseCost: 15, growth: 1.6, maxLevel: 6 },
  steering: { label: 'Steering', baseCost: 10, growth: 1.7, maxLevel: 4 },
  bumpers: { label: 'Bumpers', baseCost: 25, growth: 1.9, maxLevel: 3 },
  fareBox: { label: 'Fare Box', baseCost: 20, growth: 1.8, maxLevel: 4 },
};

/**
 * Oncoming vehicle kinds; length/width in pixels. A `lethal` vehicle ends
 * the run on contact regardless of lives left or post-hit grace.
 */
export const VEHICLES = [
  { kind: 'car', length: 64, width: 50, minDistance: 0 },
  { kind: 'van', length: 82, width: 56, minDistance: 300 },
  { kind: 'truck', length: 118, width: 62, minDistance: 800, lethal: true },
  { kind: 'semi', length: 170, width: 64, minDistance: 1500, lethal: true },
];

function level(n, max) {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), max);
}

/** Top speed for an Engine level. */
export function maxSpeed(engineLevel) {
  return BASE_MAX_SPEED + level(engineLevel, UPGRADES.engine.maxLevel) * ENGINE_SPEED_STEP;
}

/**
 * Advances speed by one frame: holding accelerate speeds up, brake slows
 * down (brake wins if both are held), neither holds speed. Always clamped
 * to [MIN_SPEED, maxSpeed(engineLevel)].
 */
export function stepSpeed(speed, input, dt, engineLevel) {
  let next = Number.isFinite(speed) ? speed : MIN_SPEED;
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  if (input && input.brake) next -= BRAKING * step;
  else if (input && input.accelerate) next += ACCELERATION * step;
  return Math.min(Math.max(next, MIN_SPEED), maxSpeed(engineLevel));
}

/** m/s → whole km/h for the HUD. */
export function toKmh(speed) {
  return Math.round(speed * 3.6);
}

/** Seconds a lane change takes at a Steering level. */
export function laneChangeSeconds(steeringLevel) {
  return Math.max(0.1, 0.24 - level(steeringLevel, UPGRADES.steering.maxLevel) * 0.035);
}

/** Lives at the start of a run for a Bumpers level. */
export function maxLives(bumpersLevel) {
  return BASE_LIVES + level(bumpersLevel, UPGRADES.bumpers.maxLevel);
}

/** Tokens each collected fare is worth at a Fare Box level. */
export function fareValue(fareBoxLevel) {
  return 1 + level(fareBoxLevel, UPGRADES.fareBox.maxLevel);
}

/** Run score: distance pays (so speed pays), fares add a bonus. */
export function runScore(distanceMeters, fares) {
  const d = Number.isFinite(distanceMeters) && distanceMeters > 0 ? Math.floor(distanceMeters) : 0;
  const f = Number.isFinite(fares) && fares > 0 ? Math.floor(fares) : 0;
  return Math.min(d + f * FARE_POINTS, SCORE_MAX);
}

/** Tokens earned by a finished run. */
export function runTokens(distanceMeters, fares, fareBoxLevel) {
  const d = Number.isFinite(distanceMeters) && distanceMeters > 0 ? distanceMeters : 0;
  const f = Number.isFinite(fares) && fares > 0 ? Math.floor(fares) : 0;
  return f * fareValue(fareBoxLevel) + Math.floor(d / 100);
}

/** Cost of the next level of an upgrade, or null when it's maxed/unknown. */
export function upgradeCost(key, currentLevel) {
  const def = UPGRADES[key];
  if (!def) return null;
  const lvl = level(currentLevel, def.maxLevel);
  if (lvl >= def.maxLevel) return null;
  return Math.round(def.baseCost * def.growth ** lvl);
}

/** Whether the next level of an upgrade is affordable. */
export function canBuy(key, currentLevel, tokens) {
  const cost = upgradeCost(key, currentLevel);
  return cost !== null && tokens >= cost;
}

/** Most lanes a traffic row may block at a given distance (never all). */
export function maxBlockedLanes(distanceMeters) {
  if (distanceMeters >= 1500) return LANES - 1;
  if (distanceMeters >= 400) return 2;
  return 1;
}

/**
 * Screen-space gap between traffic-row fronts: shrinks with distance down
 * to a floor. The floor leaves room, after the longest vehicle and the bus
 * itself (BUS_LENGTH), for one unupgraded lane change at top speed — the
 * move pickBlockedLanes may require between two rows.
 */
export const BUS_LENGTH = 88;
export const ROW_SPACING_MAX = 460;
export const ROW_SPACING_MIN = 350;
export function rowSpacingPx(distanceMeters) {
  const d = Number.isFinite(distanceMeters) && distanceMeters > 0 ? distanceMeters : 0;
  return Math.max(ROW_SPACING_MIN, ROW_SPACING_MAX - d / 10);
}

/**
 * Chooses which lanes the next traffic row blocks. Guarantees:
 *   - at least one lane stays open, and
 *   - when prevOpen is given, at least one new open lane is the same as or
 *     next to a previous open lane, so the bus is never asked to cross
 *     the whole road between two rows.
 * `rng` returns [0, 1), e.g. Math.random. Returns blocked lanes, sorted.
 */
export function pickBlockedLanes(rng, distanceMeters, prevOpen) {
  const cap = maxBlockedLanes(distanceMeters);
  const count = 1 + Math.floor(rng() * cap);
  const reachable = new Set();
  (prevOpen && prevOpen.length ? prevOpen : [...Array(LANES).keys()]).forEach((lane) => {
    [lane - 1, lane, lane + 1].forEach((l) => { if (l >= 0 && l < LANES) reachable.add(l); });
  });
  const reachableList = [...reachable];
  const keepOpen = reachableList[Math.floor(rng() * reachableList.length)];

  const candidates = [...Array(LANES).keys()].filter((l) => l !== keepOpen);
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  return candidates.slice(0, Math.min(count, LANES - 1)).sort((a, b) => a - b);
}

/**
 * Lives left after a collision. A lethal vehicle (truck, semi) takes them
 * all; anything else takes one, unless the bus is still in its post-hit
 * grace window. Lethal vehicles ignore grace — a flashing bus still can't
 * survive a truck.
 */
export function livesAfterHit(lives, vehicle, graceSeconds) {
  if (vehicle && vehicle.lethal) return 0;
  if (graceSeconds > 0) return lives;
  return Math.max(0, lives - 1);
}

/** Lanes not in `blocked`. */
export function openLanes(blocked) {
  return [...Array(LANES).keys()].filter((l) => !blocked.includes(l));
}

/** Picks a vehicle kind, unlocking bigger ones as distance grows. */
export function pickVehicle(rng, distanceMeters) {
  const pool = VEHICLES.filter((v) => distanceMeters >= v.minDistance);
  return pool[Math.floor(rng() * pool.length)];
}

/** Axis-aligned rectangle overlap ({x, y, w, h}); touching edges don't count. */
export function rectsOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
