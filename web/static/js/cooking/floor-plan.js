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

/** The floor plan's fixed canvas size, in pixels (matches cooking-game.html). */
export const CANVAS_WIDTH = 960;
export const CANVAS_HEIGHT = 600;

/** Box size (pixels, square) for door/fixture stations — fridge, cabinet, closets, stove, oven, counter, boss's office. */
export const STATION_BOX_SIZE = 70;

/** Box size (pixels, square) for a table — smaller, since 30 of them share the floor. */
export const TABLE_BOX_SIZE = 50;

/**
 * How far outside a station's box edge the player stops when walking up
 * to interact with it — close enough to read as "at the fridge," far
 * enough that the player sprite never overlaps the station's box.
 */
export const PLAYER_STOP_MARGIN = 26;

/** The player's starting position — just below the table grid, near the counter/entrance. */
export const PLAYER_START = { x: 480, y: 500 };

/**
 * Builds the fixed set of non-table stations plus one entry per table id.
 * Positions are hand-placed, not computed, mirroring the room the doc's
 * User Flow describes: door-fixture stations along the left/right walls
 * and top/bottom centerline, a 6x5 table grid filling the middle.
 *
 * Station kinds: 'fridge', 'cabinet', 'cleaning-closet' (doubles as the
 * old "sink" — washes dishes, restyled as a door per the user's request),
 * 'cookware-closet' (Pan/Baking Tray/Rice Cooker), 'stove', 'oven',
 * 'counter' (the old "shutdown" light-switch/register point, restyled as
 * a proper front counter), 'boss-office', and 'table' (one per id).
 *
 * @param {number[]} tableIds
 * @returns {{id: string, kind: string, x: number, y: number, size: number, tableId?: number}[]}
 */
export function buildStations(tableIds) {
  const stations = [
    { id: 'fridge', kind: 'fridge', x: 90, y: 80, size: STATION_BOX_SIZE },
    { id: 'cabinet', kind: 'cabinet', x: 870, y: 80, size: STATION_BOX_SIZE },
    { id: 'cleaning-closet', kind: 'cleaning-closet', x: 90, y: 300, size: STATION_BOX_SIZE },
    { id: 'cookware-closet', kind: 'cookware-closet', x: 870, y: 300, size: STATION_BOX_SIZE },
    { id: 'stove', kind: 'stove', x: 90, y: 520, size: STATION_BOX_SIZE },
    { id: 'oven', kind: 'oven', x: 870, y: 520, size: STATION_BOX_SIZE },
    { id: 'counter', kind: 'counter', x: 480, y: 560, size: STATION_BOX_SIZE },
    { id: 'boss-office', kind: 'boss-office', x: 480, y: 40, size: STATION_BOX_SIZE },
  ];

  const columnXs = [220, 324, 428, 532, 636, 740];
  const rowYs = [130, 215, 300, 385, 470];
  tableIds.forEach((tableId, i) => {
    const col = i % columnXs.length;
    const row = Math.floor(i / columnXs.length) % rowYs.length;
    stations.push({
      id: `table-${tableId}`,
      kind: 'table',
      tableId,
      x: columnXs[col],
      y: rowYs[row],
      size: TABLE_BOX_SIZE,
    });
  });

  return stations;
}

/**
 * The station whose box contains (x, y), if any — a rectangle hit-test
 * used for both click-to-target and mouse-hover tooltips. `null` if the
 * point isn't over any station.
 *
 * @param {number} x
 * @param {number} y
 * @param {{x: number, y: number, size: number}[]} stations
 * @returns {object | null}
 */
export function stationAtPoint(x, y, stations) {
  for (const station of stations) {
    const half = station.size / 2;
    if (x >= station.x - half && x <= station.x + half
      && y >= station.y - half && y <= station.y + half) {
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
