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
 * Builds the fixed set of non-table stations plus one entry per table id,
 * tagged with which room each belongs to (`ROOM_DINING`/`ROOM_KITCHEN`).
 * The full combined list is always returned — game logic that isn't
 * room-scoped (e.g. looking up a table by id) shouldn't need to filter —
 * callers that render/hit-test only the currently-visible room should run
 * the result through `stationsInRoom`. Positions are hand-placed, not
 * computed, mirroring the room the doc's User Flow describes.
 *
 * Station kinds:
 * - Dining room: 'toilet' (a restroom — decorative only, no gameplay
 *   effect), 'kitchen-door' (walking up switches the active room to
 *   Kitchen), 'counter' (the old "shutdown" light-switch/register point,
 *   restyled as a proper front counter), 'coffee-machine' (restores
 *   sanity — rules.js's restoreSanity), 'boss-office', and 'table' (one
 *   per id, a 6x5 grid).
 * - Kitchen room: 'fridge', 'cabinet', 'cleaning-closet' (doubles as the
 *   old "sink" — washes dishes, restyled as a door per the user's
 *   request), 'cookware-closet' (Pan/Baking Tray/Rice Cooker), 'stove',
 *   'oven', and 'dining-door' (walking up switches the active room back
 *   to Dining).
 *
 * @param {number[]} tableIds
 * @returns {{id: string, kind: string, room: string, x: number, y: number, size: number, tableId?: number}[]}
 */
export function buildStations(tableIds) {
  const stations = [
    // Dining room
    { id: 'toilet', kind: 'toilet', room: ROOM_DINING, x: 90, y: 80, size: STATION_BOX_SIZE },
    { id: 'kitchen-door', kind: 'kitchen-door', room: ROOM_DINING, x: 870, y: 80, size: STATION_BOX_SIZE },
    { id: 'counter', kind: 'counter', room: ROOM_DINING, x: 480, y: 560, size: STATION_BOX_SIZE },
    { id: 'coffee-machine', kind: 'coffee-machine', room: ROOM_DINING, x: 376, y: 560, size: STATION_BOX_SIZE },
    { id: 'boss-office', kind: 'boss-office', room: ROOM_DINING, x: 480, y: 40, size: STATION_BOX_SIZE },
    // Kitchen room
    { id: 'fridge', kind: 'fridge', room: ROOM_KITCHEN, x: 200, y: 160, size: STATION_BOX_SIZE },
    { id: 'oven', kind: 'oven', room: ROOM_KITCHEN, x: 480, y: 160, size: STATION_BOX_SIZE },
    { id: 'cabinet', kind: 'cabinet', room: ROOM_KITCHEN, x: 760, y: 160, size: STATION_BOX_SIZE },
    { id: 'cookware-closet', kind: 'cookware-closet', room: ROOM_KITCHEN, x: 200, y: 360, size: STATION_BOX_SIZE },
    { id: 'cleaning-closet', kind: 'cleaning-closet', room: ROOM_KITCHEN, x: 480, y: 360, size: STATION_BOX_SIZE },
    { id: 'stove', kind: 'stove', room: ROOM_KITCHEN, x: 760, y: 360, size: STATION_BOX_SIZE },
    { id: 'dining-door', kind: 'dining-door', room: ROOM_KITCHEN, x: 480, y: 540, size: STATION_BOX_SIZE },
  ];

  const columnXs = [220, 324, 428, 532, 636, 740];
  const rowYs = [130, 215, 300, 385, 470];
  tableIds.forEach((tableId, i) => {
    const col = i % columnXs.length;
    const row = Math.floor(i / columnXs.length) % rowYs.length;
    stations.push({
      id: `table-${tableId}`,
      kind: 'table',
      room: ROOM_DINING,
      tableId,
      x: columnXs[col],
      y: rowYs[row],
      size: TABLE_BOX_SIZE,
    });
  });

  return stations;
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
