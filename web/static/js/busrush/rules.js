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
  { kind: 'garbage', label: 'garbage truck', length: 110, width: 60, minDistance: 500, lethal: true, spills: 'garbage' },
  { kind: 'truck', length: 118, width: 62, minDistance: 800, lethal: true, spills: 'banana' },
  { kind: 'semi', length: 170, width: 64, minDistance: 1500, lethal: true, spills: 'banana' },
];

function level(n, max) {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), max);
}

/** Each district (level) raises both the speed floor and top speed by this much. */
export const LEVEL_SPEED_STEP = 1.5;

function levelSpeedBonus(levelIndex) {
  return level(levelIndex, LEVELS.length - 1) * LEVEL_SPEED_STEP;
}

/** Speed floor in a district (0-based level index) — what a hit drops you to. */
export function minSpeed(levelIndex = 0) {
  return MIN_SPEED + levelSpeedBonus(levelIndex);
}

/** Top speed for an Engine level in a district (0-based level index). */
export function maxSpeed(engineLevel, levelIndex = 0) {
  return BASE_MAX_SPEED + level(engineLevel, UPGRADES.engine.maxLevel) * ENGINE_SPEED_STEP + levelSpeedBonus(levelIndex);
}

/** Top speed while slowed by garbage: halved, never below the district's floor. */
export function slowedTopSpeed(engineLevel, levelIndex = 0) {
  return Math.max(minSpeed(levelIndex), maxSpeed(engineLevel, levelIndex) * GARBAGE_SPEED_FACTOR);
}

/**
 * Advances speed by one frame: holding accelerate speeds up (scaled by the
 * bus's `accel`), brake slows down (brake wins if both are held), neither
 * holds speed. While `slowed`, anything above slowedTopSpeed bleeds off at
 * braking rate rather than snapping down. Always clamped to
 * [minSpeed(levelIndex), maxSpeed(engineLevel, levelIndex)].
 */
export function stepSpeed(speed, input, dt, engineLevel, levelIndex = 0, { accel = 1, slowed = false } = {}) {
  const floor = minSpeed(levelIndex);
  const ceiling = maxSpeed(engineLevel, levelIndex);
  const cap = slowed ? slowedTopSpeed(engineLevel, levelIndex) : ceiling;
  const start = Number.isFinite(speed) ? speed : floor;
  let next = start;
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  if (input && input.brake) next -= BRAKING * step;
  else if (input && input.accelerate) next += ACCELERATION * accel * step;
  if (next > cap) next = Math.max(cap, Math.min(next, start - BRAKING * step));
  return Math.min(Math.max(next, floor), ceiling);
}

/** m/s → whole km/h for the HUD. */
export function toKmh(speed) {
  return Math.round(speed * 3.6);
}

/**
 * Player buses: bought once in the depot shop, then selectable. Every bus
 * fits within BUS_LENGTH and none steers slower than the single-decker, so
 * the row-spacing guarantee ("every row is passable") holds for all of
 * them. `lives` adds to the starting lives, `steer` scales lane-change time
 * (lower is quicker), `accel` scales acceleration.
 */
export const BUSES = {
  single: { label: 'Single-decker', cost: 0, length: 88, width: 54, lives: 0, steer: 1, accel: 1 },
  minibus: { label: 'Minibus', cost: 60, length: 70, width: 46, lives: -1, steer: 0.75, accel: 1 },
  double: { label: 'Double-decker', cost: 100, length: 88, width: 56, lives: 1, steer: 1, accel: 0.7 },
  electric: { label: 'Electric bus', cost: 150, length: 88, width: 54, lives: 0, steer: 1, accel: 1.6 },
};

/** A bus's definition; anything unknown is the single-decker. */
export function busDef(key) {
  return Object.prototype.hasOwnProperty.call(BUSES, key) ? BUSES[key] : BUSES.single;
}

/** Seconds a lane change takes at a Steering level, for a bus. */
export function laneChangeSeconds(steeringLevel, busKey = 'single') {
  return Math.max(0.1, 0.24 - level(steeringLevel, UPGRADES.steering.maxLevel) * 0.035) * busDef(busKey).steer;
}

/** Lives at the start of a run for a Bumpers level and bus — always at least one. */
export function maxLives(bumpersLevel, busKey = 'single') {
  return Math.max(1, BASE_LIVES + level(bumpersLevel, UPGRADES.bumpers.maxLevel) + busDef(busKey).lives);
}

/** Tokens each collected fare is worth at a Fare Box level. */
export function fareValue(fareBoxLevel) {
  return 1 + level(fareBoxLevel, UPGRADES.fareBox.maxLevel);
}

function wholeOrZero(n) {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Run score: distance pays (so speed pays), fares add a bonus, and
 * `bonusPoints` is what wrecked police earned (policeWreckPoints).
 */
export function runScore(distanceMeters, fares, bonusPoints = 0) {
  return Math.min(wholeOrZero(distanceMeters) + wholeOrZero(fares) * FARE_POINTS + wholeOrZero(bonusPoints), SCORE_MAX);
}

/** Tokens earned by a finished run. */
export function runTokens(distanceMeters, fares, fareBoxLevel, wrecks = 0) {
  return wholeOrZero(fares) * fareValue(fareBoxLevel)
    + Math.floor(wholeOrZero(distanceMeters) / 100)
    + wholeOrZero(wrecks) * WRECK_TOKENS;
}

// ---------------------------------------------------------------------------
// Police pursuit — the bus is stolen. Everything scales with the wanted level.
// ---------------------------------------------------------------------------

export const WANTED_MAX = 5;
export const WRECK_TOKENS = 2;

/** Seconds into a run before the first cruiser, and between later ones. */
export const POLICE_FIRST_SECONDS = 4;
export const POLICE_SPAWN_SECONDS = 3.5;

/** Roadblocks (rows of oncoming cruisers) start at this distance. */
export const ROADBLOCK_MIN_DISTANCE = 600;

/** The cruiser used for both pursuit cars and roadblocks. Lethal: any contact is Busted. */
export const POLICE_CAR = { kind: 'police', length: 64, width: 50, police: true, lethal: true };

// ---------------------------------------------------------------------------
// Levels — districts one continuous run passes through, every LEVEL_DISTANCE.
// ---------------------------------------------------------------------------

export const LEVEL_DISTANCE = 800;
export const LEVELS = ['CBD', 'Heartland', 'Expressway', 'Industrial', 'Changi'];
export const CHECKPOINT_POINTS = 250;

/** 0-based district index for a distance; the last district is endless. */
export function levelAt(distanceMeters) {
  return Math.min(LEVELS.length - 1, Math.floor(wholeOrZero(distanceMeters) / LEVEL_DISTANCE));
}

/** Score for reaching district `levelIndex` (0-based; the start earns nothing). */
export function checkpointPoints(levelIndex) {
  return CHECKPOINT_POINTS * wholeOrZero(levelIndex);
}

/**
 * Wanted stars (1..WANTED_MAX): each district starts one star hotter, and
 * every 10 fares on top adds another.
 */
export function wantedLevel(distanceMeters, fares) {
  return Math.min(WANTED_MAX, levelAt(distanceMeters) + 1 + Math.floor(wholeOrZero(fares) / 10));
}

function stars(wanted) {
  return Number.isFinite(wanted) ? Math.min(Math.max(Math.floor(wanted), 1), WANTED_MAX) : 1;
}

/** Police pace as a fraction of the district's stock top speed, by star. */
export const POLICE_PACE = [0.8, 0.84, 0.88, 0.92, 0.96];

/**
 * Pursuit speed (m/s) in a district (0-based level index). Pegged to an
 * unupgraded bus's top speed *in that district*, so levelling up never
 * makes police uncatchable: a stock bus at full throttle always pulls
 * away, just more slowly at higher stars. They catch you when you brake
 * or get knocked down to the speed floor.
 */
export function policeSpeed(wanted, levelIndex = 0) {
  return maxSpeed(0, levelIndex) * POLICE_PACE[stars(wanted) - 1];
}

/** Most cruisers chasing at once. */
export function maxPolice(wanted) {
  return [1, 1, 2, 2, 3][stars(wanted) - 1];
}

/** Seconds a cruiser waits before re-aiming at the bus's lane — the window to juke it. */
export function policeReactionSeconds(wanted) {
  return 1.0 - stars(wanted) * 0.12;
}

/** Chance a traffic row is a police roadblock instead. */
export function roadblockChance(distanceMeters, wanted) {
  if (wholeOrZero(distanceMeters) < ROADBLOCK_MIN_DISTANCE) return 0;
  return 0.06 * (stars(wanted) - 1);
}

/** Score for wrecking a cruiser into traffic. */
export function policeWreckPoints(wanted) {
  return 50 * stars(wanted);
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

// ---------------------------------------------------------------------------
// Spills — cargo that slips out of the back of trucks: bananas from trucks
// and semis, garbage from garbage trucks.
// ---------------------------------------------------------------------------

/** Per spill kind: chance a truck carrying it leaks, and most it drops. */
export const SPILLS = {
  banana: { chance: 0.6, max: 2 },
  garbage: { chance: 0.8, max: 3 },
};

/**
 * Screen y range (px, the truck's rear) where spills may drop. The floor
 * keeps every spill high enough up the screen to be seen and dodged; a
 * dropped spill lies still, so it then scrolls down at the bus's speed.
 */
export const BANANA_DROP_MIN_Y = 20;
export const BANANA_DROP_MAX_Y = 220;

/** Garbage: how long it slows the bus, and the top-speed factor meanwhile. */
export const GARBAGE_SLOW_SECONDS = 5.5;
export const GARBAGE_SPEED_FACTOR = 0.5;

/** Seconds the bus skids (steering locked) after running over a banana. */
export const SKID_SECONDS = 0.5;

/**
 * The rear-y positions at which one vehicle drops its spill, sorted: none
 * for a vehicle without `spills` or a non-leaky one, otherwise 1..max of
 * that spill kind within [BANANA_DROP_MIN_Y, BANANA_DROP_MAX_Y].
 */
export function spillDrops(rng, vehicle) {
  const spec = vehicle && SPILLS[vehicle.spills];
  if (!spec || rng() >= spec.chance) return [];
  const count = 1 + Math.floor(rng() * spec.max);
  return Array.from({ length: count }, () => BANANA_DROP_MIN_Y + rng() * (BANANA_DROP_MAX_Y - BANANA_DROP_MIN_Y))
    .sort((a, b) => a - b);
}

/** Lane a banana skid throws the bus into: one over, at random, inward at the edges. */
export function skidLane(lane, rng) {
  if (lane <= 0) return 1;
  if (lane >= LANES - 1) return LANES - 2;
  return lane + (rng() < 0.5 ? -1 : 1);
}

/** Clear space kept between a fare's edge and any vehicle, px. */
export const FARE_CLEARANCE = 10;

/**
 * Where a fare sits behind a traffic row: a y offset in px (negative = up
 * the screen) from the row's front bumpers. It's centred in the clear gap
 * between the tail of whatever blocks its lane in this row (`blockerLength`,
 * 0 for an open lane) and the front of the next row, one spacing further
 * up. Traffic and fares scroll at the same speed, so clear at spawn means
 * clear all the way down the screen.
 */
export function fareOffset(spacingPx, blockerLength, radius) {
  const nearest = -(blockerLength + radius + FARE_CLEARANCE);
  const farthest = -(spacingPx - radius - FARE_CLEARANCE);
  return (nearest + farthest) / 2;
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
