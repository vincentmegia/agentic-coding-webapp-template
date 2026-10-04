// Pure, canvas-independent floor-plan math for Kitchen Shift
// (docs/features/cooking-game.md's Client-side Behavior "Movement and
// interaction" note).
//
// This module has NO DOM/canvas/localStorage/timer dependencies on
// purpose, mirroring rules.js/engine-state.js's contract, so it can be
// unit-tested with `node --test` and imported unchanged by the canvas game
// loop (cooking-game.js). It owns station coordinates on the fixed
// 960x600 floor plan (matching cooking-game.html's canvas dimensions) and
// the click-to-move geometry: hit-testing a click/hover point against a
// station's box, and computing where the player should stop when walking
// up to interact with one (just outside its box, not dead-center on top
// of it).
//
// v2 redesign: controls are click-only now (a prior keyboard-arrows/WASD
// version existed; the user asked to replace it with point-and-click
// movement/interaction, which is also what fixed a real "I can't move"
// bug report — this module no longer exposes a circular
// "nearestStation"-style proximity scan, since a click always commits to
// one specific station or floor point as the current move target, and
// "arrival" is judged against that one target, not a continuous
// every-frame area scan the way keyboard movement needed.
//
// v3.1 room split: the user asked for the fridge/cabinet/cookware-closet/
// stove/oven/cleaning-closet to stop being "in random places in the
// dining [room]" and move into a separate Kitchen, reachable through a
// door. Every station now carries a `room` tag (`ROOM_DINING` or
// `ROOM_KITCHEN`); `buildStations` still returns the full combined list
// (so game logic that isn't room-scoped — e.g. looking up a table by id —
// doesn't need to care which room it's in), and `stationsInRoom` is the
// pure filter cooking-game.js uses for rendering/hit-testing/hover, so
// only the active room's stations are ever visible or clickable. Both
// rooms reuse the same 960x600 canvas — they're never shown at once, so
// there's no need for a bigger or split canvas.
//
// v3.13 food server leveling: the dining room now opens up more tables at
// a time as the player's food server level rises (1-5, rules.js — not
// imported here, see isTableUnlocked's doc comment for why).
// `isTableUnlocked`/`unlockedStations` are the pure filters for that, the
// same shape as `stationsInRoom` above — compose the two.
//
// v3.15 centered box layout, table size doubled: the original fixed 6x5
// grid (used at every level, with a row-based unlock filter picking which
// cells were interactive) is gone. The user asked for the visible tables
// to be "vertically and horizontally center[ed]," then separately for the
// table box itself to be twice as big with "the stars around it" (the
// decorative chair pillows, cooking-game.js's drawChairPillows) removed,
// and the layout to "follow a box layout as much as possible." Since
// TABLE_BOX_SIZE doubling makes the old 6x5 grid physically too tall for
// the room (30 rows worth of space doesn't fit), and a single full-width
// unlocked row (the old center-out scheme) reads as a thin strip rather
// than a box, `buildStations` now takes the current level and lays out
// exactly the tables unlocked *at that level* in a fresh, compact,
// near-square grid (`TABLE_GRID_SHAPES`), centered within the room's
// available space (`TABLE_AREA_*`) every time — see `tableGridPosition`.
// `isTableUnlocked` simplifies to "is this id among the first N," since
// centering is now handled entirely by the layout, not by which specific
// ids are chosen.
//
// v3.16 table size scales with level: the user reported level 1's tables
// (a sparse 6-table room at the flat 100px size v3.15 introduced) looked
// "too big" — a rookie server's small, quiet room doesn't need furniture
// sized for the full 30-table rush. `tableBoxSizeForLevel` now scales the
// box itself, 64px at level 1 up to 100px at level 5 in 9px steps, and
// `tableGridPosition`/`axisSpacing` take that size as a parameter so the
// preferred spacing scales proportionally with it (`preferredSpacingForSize`,
// a constant ~0.6x gap-to-box ratio at every level) instead of measuring
// every level against the old flat 160px meant for a 100px box. Level 5's
// numbers are unchanged — `preferredSpacingForSize(100) === 160` exactly,
// so the room's busiest, tightest tier keeps the same layout it already had.

/** The floor plan's fixed canvas size, in pixels (matches cooking-game.html). */
export const CANVAS_WIDTH = 960;
export const CANVAS_HEIGHT = 600;

/** Box size (pixels, square) for door/fixture stations — fridge, cabinet, closets, stove, oven, counter, boss's office. */
export const STATION_BOX_SIZE = 70;

/** Box size (pixels, square) for a table — v3.15: doubled from 50 per the user's "two times bigger" request. */
export const TABLE_BOX_SIZE = 100;

/**
 * Extra click/hover hit-test margin below a table's box, on top of its
 * normal symmetric size/2 half-extent (see `stationAtPoint`'s
 * `hitExtendDown` handling). A seated customer's pixel-person sprite
 * (cooking-game.js's drawTableContents/drawPixelPerson) is drawn starting
 * below the table box, not inside it, and — after the v3.3 "make the
 * characters bigger" pass raised customer scale up to 1.05 — its legs now
 * extend roughly 18-19px past the table box's unextended bottom edge.
 * Without this, clicking directly on a seated customer's visible sprite
 * (exactly where a player would naturally aim to "hand them their order")
 * often misses the table's actual hit box entirely, a real bug report
 * ("i click on them but i cant [serve/take their order]"). 22px covers
 * that with a few pixels of buffer. This offset is measured from the
 * table's own bottom edge, not its center, so it stayed correct as-is
 * when `TABLE_BOX_SIZE` doubled (v3.15) — the customer sprite's draw
 * offset below the box edge didn't change, only the box itself grew.
 */
export const TABLE_HIT_EXTEND_DOWN = 22;

/**
 * How far outside a station's box edge the player stops when walking up
 * to interact with it — close enough to read as "at the fridge," far
 * enough that the player sprite never overlaps the station's box.
 */
export const PLAYER_STOP_MARGIN = 26;

/** The player's starting position — just below the table grid, near the counter/entrance, in the Dining room. */
export const PLAYER_START = { x: 480, y: 500 };

/** Room identifiers a station (and the player) can be in. Exactly one room is ever visible/active at a time. */
export const ROOM_DINING = 'dining';
export const ROOM_KITCHEN = 'kitchen';

/** Where the player lands after walking through the kitchen-door (arriving into the Kitchen, near its dining-door). */
export const KITCHEN_ENTRY_POINT = { x: 480, y: 470 };

/** Where the player lands after walking through the dining-door (arriving back into Dining, near its kitchen-door). */
export const DINING_ENTRY_POINT = { x: 820, y: 150 };

/**
 * Mirrors `rules.js`'s FOOD_SERVER_MAX_LEVEL (5) and TABLES_PER_LEVEL (6)
 * — kept as local literals rather than an import, since this module has
 * no dependencies on purpose (see the file header comment).
 */
const FOOD_SERVER_MAX_LEVEL = 5;
const TABLES_PER_LEVEL = 6;

/**
 * How many tables are unlocked at a given food server `level` (1-5,
 * clamped; non-finite treated as 1) — the *count* only; `tableGridPosition`
 * below turns a count into an actual centered layout.
 *
 * @param {number} level
 * @returns {number}
 */
function unlockedTableCount(level) {
  const lvl = Number.isFinite(level) ? Math.max(1, Math.min(FOOD_SERVER_MAX_LEVEL, level)) : 1;
  return lvl * TABLES_PER_LEVEL;
}

/**
 * Whether `tableId` is open yet at food server `level` — the first
 * `unlockedTableCount(level)` ids (1-indexed) are open; which physical ids
 * those are no longer matters for the *unlock* decision (only for where
 * they're drawn — see `tableGridPosition`), since every level's open set
 * gets a freshly centered layout regardless of which specific ids are in
 * it.
 *
 * @param {number} tableId
 * @param {number} level
 * @returns {boolean}
 */
export function isTableUnlocked(tableId, level) {
  return tableId <= unlockedTableCount(level);
}

/**
 * Table box size, in pixels, scaling with food server level — 64px at
 * level 1 (deliberately smaller than STATION_BOX_SIZE's 70px, so a
 * rookie server's small, sparse dining room doesn't visually dominate
 * the room with oversized furniture) growing linearly to 100px at level
 * 5 (the room's busiest, tightest-packed tier, where a bigger, bolder
 * table matches the room actually being full). Linear steps of 9px.
 *
 * @param {number} level - clamped into [1, FOOD_SERVER_MAX_LEVEL] (non-finite treated as 1).
 * @returns {number}
 */
export function tableBoxSizeForLevel(level) {
  const lvl = Number.isFinite(level) ? Math.max(1, Math.min(FOOD_SERVER_MAX_LEVEL, level)) : 1;
  return 64 + (lvl - 1) * 9; // 64, 73, 82, 91, 100
}

/**
 * Near-square grid shapes for each table count this game actually
 * produces (`unlockedTableCount` at levels 1-5) — hand-picked rather than
 * derived from a generic packing formula, same "explicit, tunable table"
 * style as `RECIPE_BANDS`/`ROUND_TIER_CLOCK_SECONDS`. 30's 8x4 (32 slots,
 * 2 unused) is the tightest — the room physically can't fit a 6x5 grid at
 * the doubled `TABLE_BOX_SIZE` with any breathing room, so the full
 * dining room trades "square" for "wide," matching the room's own
 * landscape aspect ratio instead. 4 rows at `TABLE_BOX_SIZE` slightly
 * exceeds `TABLE_AREA_Y`'s span (rows land ~5px closer together than the
 * box is tall) — a deliberate, user-accepted tradeoff ("pack tightly...
 * tables will sit close together, nearly touching") rather than shrinking
 * the table size or leaving 2 of the 30 physical tables permanently
 * unreachable.
 */
const TABLE_GRID_SHAPES = {
  6: { cols: 3, rows: 2 },
  12: { cols: 4, rows: 3 },
  18: { cols: 6, rows: 3 },
  24: { cols: 6, rows: 4 },
  30: { cols: 8, rows: 4 },
};

/**
 * The comfortable center-to-center spacing this layout reaches for
 * whenever the room has room to spare — a constant ~0.6x gap-to-box
 * ratio at every level (e.g. 60px of clear space around a 100px table,
 * 38.4px around a level-1 64px table), so smaller level-1 tables don't
 * end up spaced as if they were still 100px. Only shrinks below this
 * when a shape's row/column count wouldn't otherwise fit
 * `TABLE_AREA_X`/`TABLE_AREA_Y`. At `size` === TABLE_BOX_SIZE (100) this
 * is exactly 160 — the same flat number the layout used before v3.16, so
 * level 5 is unaffected.
 *
 * @param {number} size
 * @returns {number}
 */
function preferredSpacingForSize(size) {
  return size * 1.6;
}

/**
 * The room's available space for table centers — clear of every
 * surrounding fixture (kitchen-door above; counter/coffee-machine, and,
 * since v3.31, toilet too, below) at the doubled `TABLE_BOX_SIZE`, with
 * the x-bounds matching those fixtures' own x positions for a clean
 * shared margin. The lower y-bound (450, not counter/coffee-machine's box
 * edge at 525) originally left room for their label chip flipping to
 * draw *above* the box (cooking-game.js's drawStation, for a bottom-row
 * station whose label wouldn't fit below the canvas edge) — as of v3.27
 * none of the bottom-row fixtures (all now at y=540, including toilet)
 * actually trigger that flip any more (`540 + 35 + 13 + 7 = 595 <= 600`),
 * so today this bound is just a comfortable, still-accurate margin above
 * their box edges, not active flipped-label clearance.
 */
const TABLE_AREA_X = [90, 870];
const TABLE_AREA_Y = [165, 450];

/** `TABLE_GRID_SHAPES` fallback key — the physical table count (30), mirroring `rules.js`'s PHYSICAL_TABLE_COUNT. */
const PHYSICAL_TABLE_COUNT_LOCAL = 30;

function axisSpacing(count, span, size) {
  return count > 1 ? Math.min(preferredSpacingForSize(size), span / (count - 1)) : 0;
}

/**
 * The centered position of the `index`-th (0-based) table among `count`
 * currently-unlocked tables, laid out in `TABLE_GRID_SHAPES[count]` at
 * the given `size` (`tableBoxSizeForLevel`'s output — spacing scales
 * with it, see `preferredSpacingForSize`). A short final row (count
 * doesn't evenly divide the shape's columns, e.g. 30 in an 8x4/32-slot
 * shape) is centered under the rows above it rather than left-aligned,
 * so a partially-filled grid still reads as one symmetric block.
 *
 * @param {number} index
 * @param {number} count
 * @param {number} size
 * @returns {{x: number, y: number}}
 */
function tableGridPosition(index, count, size) {
  const shape = TABLE_GRID_SHAPES[count] || TABLE_GRID_SHAPES[PHYSICAL_TABLE_COUNT_LOCAL];
  const { cols, rows } = shape;
  const row = Math.floor(index / cols);
  const col = index % cols;
  const isLastRow = row === rows - 1;
  const itemsInThisRow = isLastRow ? count - (rows - 1) * cols : cols;

  const spacingX = axisSpacing(cols, TABLE_AREA_X[1] - TABLE_AREA_X[0], size);
  const spacingY = axisSpacing(rows, TABLE_AREA_Y[1] - TABLE_AREA_Y[0], size);
  const areaCenterX = (TABLE_AREA_X[0] + TABLE_AREA_X[1]) / 2;
  const areaCenterY = (TABLE_AREA_Y[0] + TABLE_AREA_Y[1]) / 2;

  const blockHeight = (rows - 1) * spacingY;
  const rowWidth = (itemsInThisRow - 1) * spacingX;
  const rowStartX = areaCenterX - rowWidth / 2;
  const startY = areaCenterY - blockHeight / 2;

  return { x: rowStartX + col * spacingX, y: startY + row * spacingY };
}

/**
 * Builds the fixed set of non-table stations plus one entry per table id,
 * tagged with which room each belongs to (`ROOM_DINING`/`ROOM_KITCHEN`).
 * The full combined list is always returned — game logic that isn't
 * room-scoped (e.g. looking up a table by id) shouldn't need to filter —
 * callers that render/hit-test only the currently-visible room should run
 * the result through `stationsInRoom`. Non-table positions are
 * hand-placed; table positions are computed fresh for the given `level`
 * (`tableGridPosition`) — a locked table (beyond what `level` unlocks)
 * still gets an entry (so table-id lookups never fail), positioned as if
 * it were the next table in the *full* 30-table layout, off past whatever
 * is currently visible; it's never drawn or hit-tested regardless (see
 * cooking-game.js's drawStation/isTableUnlocked call sites).
 *
 * Station kinds:
 * - Dining room: 'toilet' (a restroom — decorative only, no gameplay
 *   effect), 'kitchen-door' (walking up switches the active room to
 *   Kitchen), 'counter' (the old "shutdown" light-switch/register point,
 *   restyled as a proper front counter), 'coffee-machine' (restores
 *   sanity — rules.js's restoreSanity), 'boss-office', and 'table' (one
 *   per id).
 * - Kitchen room: 'fridge', 'cabinet', 'cleaning-closet' (doubles as the
 *   old "sink" — washes dishes, restyled as a door per the user's
 *   request), 'cookware-closet' (Pan/Baking Tray/Rice Cooker), 'stove',
 *   'oven', and 'dining-door' (walking up switches the active room back
 *   to Dining).
 *
 * @param {number[]} tableIds
 * @param {number} [level] - food server level (1-5); defaults to 5 (every table laid out in the full 30-table shape) for callers that don't care about leveling (e.g. tests exercising a fixed layout).
 * @returns {{id: string, kind: string, room: string, x: number, y: number, size: number, tableId?: number}[]}
 */
export function buildStations(tableIds, level = FOOD_SERVER_MAX_LEVEL) {
  const stations = [
    // Dining room
    { id: 'kitchen-door', kind: 'kitchen-door', room: ROOM_DINING, x: 870, y: 80, size: STATION_BOX_SIZE },
    // v3.25: moved to the left side of the dining room (was centered at
    // the bottom, x=480/376) per the user's explicit request — the
    // bottom-left corner was empty (Toilet anchors the top-left; nothing
    // else sits near x=90-200 at the bottom), and moving them there
    // doesn't conflict with the "Entrance / Exit" floor text or the
    // security guard, both well to the right (x=560-785, see drawFloor/
    // SECURITY_GUARD_POSITION in cooking-game.js).
    // v3.27: nudged up from y=560 to y=540 so `station.y + half + 13 + 7`
    // (35 + 20 = 55) stays within CANVAS_HEIGHT (600) — keeps the label
    // chip drawing normally below the box instead of flipping above it,
    // which would otherwise collide with the counter's employee sprite.
    { id: 'coffee-machine', kind: 'coffee-machine', room: ROOM_DINING, x: 90, y: 540, size: STATION_BOX_SIZE },
    { id: 'counter', kind: 'counter', room: ROOM_DINING, x: 194, y: 540, size: STATION_BOX_SIZE },
    // v3.31: moved from the top-left corner (x=90, y=80, alongside where
    // kitchen-door still sits) down to the bottom-right, mirroring the
    // Coffee Machine/Counter cluster at the bottom-left — same y=540 (and
    // same labelBelowFits reasoning above) and x=870 to match
    // kitchen-door's/the table area's right edge, clear of both the
    // security guard (x=560) and the "Entrance / Exit" floor text
    // (centered around x=650), well to its left.
    { id: 'toilet', kind: 'toilet', room: ROOM_DINING, x: 870, y: 540, size: STATION_BOX_SIZE },
    { id: 'boss-office', kind: 'boss-office', room: ROOM_DINING, x: 480, y: 40, size: STATION_BOX_SIZE },
    // Kitchen room
    { id: 'fridge', kind: 'fridge', room: ROOM_KITCHEN, x: 200, y: 160, size: STATION_BOX_SIZE },
    { id: 'oven', kind: 'oven', room: ROOM_KITCHEN, x: 480, y: 160, size: STATION_BOX_SIZE },
    { id: 'cabinet', kind: 'cabinet', room: ROOM_KITCHEN, x: 760, y: 160, size: STATION_BOX_SIZE },
    { id: 'cookware-closet', kind: 'cookware-closet', room: ROOM_KITCHEN, x: 200, y: 360, size: STATION_BOX_SIZE },
    { id: 'cleaning-closet', kind: 'cleaning-closet', room: ROOM_KITCHEN, x: 480, y: 360, size: STATION_BOX_SIZE },
    { id: 'stove', kind: 'stove', room: ROOM_KITCHEN, x: 760, y: 360, size: STATION_BOX_SIZE },
    // The Rice Cooker's countertop plug-in spot (rules.js's 'rice-station'
    // dishes) — bottom-right, under the stove, clear of the dining-door.
    { id: 'rice-station', kind: 'rice-station', room: ROOM_KITCHEN, x: 760, y: 540, size: STATION_BOX_SIZE },
    { id: 'dining-door', kind: 'dining-door', room: ROOM_KITCHEN, x: 480, y: 540, size: STATION_BOX_SIZE },
  ];

  const unlockedCount = unlockedTableCount(level);
  const size = tableBoxSizeForLevel(level);
  tableIds.forEach((tableId, i) => {
    const unlocked = tableId <= unlockedCount;
    const pos = unlocked
      ? tableGridPosition(i, unlockedCount, size)
      : tableGridPosition(i, PHYSICAL_TABLE_COUNT_LOCAL, TABLE_BOX_SIZE);
    stations.push({
      id: `table-${tableId}`,
      kind: 'table',
      room: ROOM_DINING,
      tableId,
      x: pos.x,
      y: pos.y,
      size,
      hitExtendDown: TABLE_HIT_EXTEND_DOWN,
    });
  });

  return stations;
}

/**
 * Filters `stations` down to ones a player at food server `level` can
 * currently interact with — every non-table station passes through
 * unchanged (kitchen equipment is never level-gated, only dining
 * tables), a table station passes only if `isTableUnlocked`. Compose
 * with `stationsInRoom` for click-hit-testing/hover/spawn-eligibility,
 * e.g. `unlockedStations(stationsInRoom(stations, currentRoom), level)`.
 *
 * @param {{kind: string, tableId?: number}[]} stations
 * @param {number} level
 * @returns {object[]}
 */
export function unlockedStations(stations, level) {
  return stations.filter((s) => s.kind !== 'table' || isTableUnlocked(s.tableId, level));
}

/**
 * Filters a station list down to just the ones in the given room — the
 * pure "what's visible/clickable right now" query, used for rendering and
 * hit-testing so the inactive room's stations never render or intercept
 * clicks.
 *
 * @param {{room: string}[]} stations
 * @param {string} room - `ROOM_DINING` or `ROOM_KITCHEN`.
 * @returns {object[]}
 */
export function stationsInRoom(stations, room) {
  return stations.filter((station) => station.room === room);
}

/**
 * The station whose box contains (x, y), if any — a rectangle hit-test
 * used for both click-to-target and mouse-hover tooltips. `null` if the
 * point isn't over any station. A station's box is symmetric around
 * (x, y) by size/2 on every side, except its bottom edge extends further
 * down by `hitExtendDown` if the station has one (tables do, to also
 * cover the seated-customer sprite drawn below the table box itself —
 * see `TABLE_HIT_EXTEND_DOWN`); stations without it keep the plain
 * symmetric box.
 *
 * @param {number} x
 * @param {number} y
 * @param {{x: number, y: number, size: number, hitExtendDown?: number}[]} stations
 * @returns {object | null}
 */
export function stationAtPoint(x, y, stations) {
  for (const station of stations) {
    const half = station.size / 2;
    if (x >= station.x - half && x <= station.x + half
      && y >= station.y - half && y <= station.y + half + (station.hitExtendDown || 0)) {
      return station;
    }
  }
  return null;
}

/**
 * Where the player should walk to in order to interact with a station:
 * a point `standoffDistance` outside the station's center, along the line
 * toward the player's current position — so the player approaches from
 * whichever side they're already on, rather than always attaching to one
 * fixed edge. If the player is already within `standoffDistance`, they
 * don't move at all (returns their current position unchanged).
 *
 * @param {number} stationX
 * @param {number} stationY
 * @param {number} fromX - the player's current x.
 * @param {number} fromY - the player's current y.
 * @param {number} standoffDistance - typically station.size / 2 + PLAYER_STOP_MARGIN.
 * @returns {{x: number, y: number}}
 */
export function approachPoint(stationX, stationY, fromX, fromY, standoffDistance) {
  const dx = fromX - stationX;
  const dy = fromY - stationY;
  const dist = Math.hypot(dx, dy);
  if (dist <= standoffDistance) return { x: fromX, y: fromY };
  const ratio = standoffDistance / dist;
  return { x: stationX + dx * ratio, y: stationY + dy * ratio };
}

/**
 * Clamps a proposed player position to stay within the canvas bounds
 * (with a small margin so the player sprite never draws half off-screen).
 *
 * @param {number} x
 * @param {number} y
 * @param {number} [margin]
 * @returns {{x: number, y: number}}
 */
export function clampToCanvas(x, y, margin = 20) {
  const clampX = (value) => Math.min(CANVAS_WIDTH - margin, Math.max(margin, value));
  const clampY = (value) => Math.min(CANVAS_HEIGHT - margin, Math.max(margin, value));
  return { x: clampX(x), y: clampY(y) };
}

/**
 * v3.33: "treat all things as objects... should never collide" — pushes a
 * moving entity (a circle of `radius`, centered at `x, y`) out of any
 * `obstacles` entry it overlaps, along the shortest way out. Not
 * pathfinding — cooking-game.js still moves every entity in a straight
 * line toward its target every frame; this is a per-frame "slide off the
 * edge" nudge applied on top of that step, cheap enough for this game's
 * small, sparse obstacle counts (a handful of stations/characters per
 * room). Obstacles are resolved one at a time, in list order, so two
 * overlapping obstacles can fight over the same nudge — never an issue in
 * practice here since real obstacles (stations, characters) don't overlap
 * each other, only the moving entity passing near/between them.
 *
 * Each obstacle is either circular (`{x, y, radius}` — this game's tables,
 * drawn as circles since v3.16, and every character, drawn as a person)
 * or rectangular (`{x, y, halfWidth, halfHeight}` — every other station,
 * drawn as a rounded box). Circular obstacles resolve as a direct
 * circle-vs-circle push; rectangular ones as circle-vs-AABB via the
 * closest point on the box to the entity's center.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} radius
 * @param {({x: number, y: number, radius: number}|{x: number, y: number, halfWidth: number, halfHeight: number})[]} obstacles
 * @returns {{x: number, y: number}}
 */
export function resolveObstacleCollisions(x, y, radius, obstacles) {
  let rx = x;
  let ry = y;
  for (const obs of obstacles) {
    if (obs.radius !== undefined) {
      const dx = rx - obs.x;
      const dy = ry - obs.y;
      const minDist = radius + obs.radius;
      const dist = Math.hypot(dx, dy);
      if (dist >= minDist) continue;
      if (dist > 0) {
        const push = minDist - dist;
        rx += (dx / dist) * push;
        ry += (dy / dist) * push;
      } else {
        // Exactly coincident centers — an arbitrary but stable escape
        // direction; two same-position entities shouldn't occur in normal
        // play (every spawn point is a distinct station/table).
        rx = obs.x + minDist;
        ry = obs.y;
      }
    } else {
      const closestX = Math.max(obs.x - obs.halfWidth, Math.min(rx, obs.x + obs.halfWidth));
      const closestY = Math.max(obs.y - obs.halfHeight, Math.min(ry, obs.y + obs.halfHeight));
      const dx = rx - closestX;
      const dy = ry - closestY;
      const distSq = dx * dx + dy * dy;
      if (distSq >= radius * radius) continue;
      const dist = Math.sqrt(distSq);
      if (dist > 0) {
        const push = radius - dist;
        rx += (dx / dist) * push;
        ry += (dy / dist) * push;
      } else {
        // Entity's center is inside the box — push out along whichever
        // axis has the shallower penetration.
        const overlapX = obs.halfWidth + radius - Math.abs(rx - obs.x);
        const overlapY = obs.halfHeight + radius - Math.abs(ry - obs.y);
        if (overlapX < overlapY) rx = obs.x + (rx >= obs.x ? 1 : -1) * (obs.halfWidth + radius);
        else ry = obs.y + (ry >= obs.y ? 1 : -1) * (obs.halfHeight + radius);
      }
    }
  }
  return { x: rx, y: ry };
}
