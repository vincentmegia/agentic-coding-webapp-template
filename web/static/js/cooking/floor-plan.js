// Pure, canvas-independent floor-plan math for Kitchen Shift
// (docs/features/cooking-game.md's Client-side Behavior "Movement and
// interaction" note).
//
// This module has NO DOM/canvas/localStorage/timer dependencies on
// purpose, mirroring rules.js/engine-state.js's contract, so it can be
// unit-tested with `node --test` and imported unchanged by the canvas game
// loop (cooking-game.js). It owns station coordinates on the fixed
// 480x480 floor plan (matching cooking-game.html's canvas dimensions) and
// "is the player within interaction range of station X" checks — the
// station-interaction equivalent of the Fishing Game's world-scroll.js.

/** The floor plan's fixed canvas size, in pixels (matches cooking-game.html). */
export const CANVAS_SIZE = 480;

/** How close (pixels, center-to-center) the player must be to interact with a station. */
export const INTERACTION_RADIUS = 42;

/**
 * Builds the fixed set of stations for a floor plan with the given table
 * ids — everything the player can walk up to and interact with. Station
 * positions are hand-placed, not computed: fridge/cabinet along the top
 * corners, stove/oven along the bottom corners, the sink along the left
 * wall, tables in a grid in the middle, and the shutdown point/boss's
 * office along the vertical centerline (entrance at the bottom, office at
 * the top) — matching the doc's User Flow description of the room.
 *
 * @param {number[]} tableIds
 * @returns {{id: string, kind: string, x: number, y: number, tableId?: number}[]}
 */
export function buildStations(tableIds) {
  const stations = [
    { id: 'fridge', kind: 'fridge', x: 60, y: 60 },
    { id: 'cabinet', kind: 'cabinet', x: 420, y: 60 },
    { id: 'stove', kind: 'stove', x: 60, y: 420 },
    { id: 'oven', kind: 'oven', x: 420, y: 420 },
    { id: 'sink', kind: 'sink', x: 60, y: 240 },
    { id: 'shutdown', kind: 'shutdown', x: 240, y: 450 },
    { id: 'boss-office', kind: 'boss-office', x: 240, y: 30 },
  ];

  const tableGridX = [180, 300];
  const tableGridY = [180, 300];
  tableIds.forEach((tableId, i) => {
    const x = tableGridX[i % 2];
    const y = tableGridY[Math.floor(i / 2) % 2];
    stations.push({ id: `table-${tableId}`, kind: 'table', tableId, x, y });
  });

  return stations;
}

/** The player's starting position — just below center, near the entrance/shutdown point. */
export const PLAYER_START = { x: 240, y: 400 };

function distance(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

/**
 * Every station within `radius` of (playerX, playerY), nearest first.
 *
 * @param {number} playerX
 * @param {number} playerY
 * @param {{id: string, x: number, y: number}[]} stations
 * @param {number} [radius] - defaults to INTERACTION_RADIUS.
 * @returns {{id: string, x: number, y: number}[]}
 */
export function stationsInRange(playerX, playerY, stations, radius = INTERACTION_RADIUS) {
  return stations
    .map((station) => ({ station, dist: distance(playerX, playerY, station.x, station.y) }))
    .filter(({ dist }) => dist <= radius)
    .sort((a, b) => a.dist - b.dist)
    .map(({ station }) => station);
}

/**
 * The single station the player would interact with right now — the
 * nearest one within range, or `null` if none are in range. Deterministic
 * tie-break: on an exact distance tie, the station earlier in the input
 * array wins (Array.prototype.sort is stable, so equal-distance entries
 * keep their relative input order).
 *
 * @param {number} playerX
 * @param {number} playerY
 * @param {{id: string, x: number, y: number}[]} stations
 * @param {number} [radius] - defaults to INTERACTION_RADIUS.
 * @returns {{id: string, x: number, y: number} | null}
 */
export function nearestStation(playerX, playerY, stations, radius = INTERACTION_RADIUS) {
  const inRange = stationsInRange(playerX, playerY, stations, radius);
  return inRange.length > 0 ? inRange[0] : null;
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
export function clampToCanvas(x, y, margin = 16) {
  const clamp = (value) => Math.min(CANVAS_SIZE - margin, Math.max(margin, value));
  return { x: clamp(x), y: clamp(y) };
}
