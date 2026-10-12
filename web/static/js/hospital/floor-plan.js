// Pure floor-plan geometry for Hospital Shift (docs/features/hospital-
// shift.md's Visual Direction): station coordinates on the fixed 960x600
// ER and the click-to-move helpers, ported from Library Shift's
// floor-plan.js (same stationAtPoint/approachPoint/clampToCanvas shape).
//
// Two floors, Library Shift's way: the 1st Floor is the ER itself; the
// 2nd Floor is the Supply Room, home of the Supply Cart (bandage rolls) —
// the user asked for a supply cart "and make a second floor where they
// are on". Stairs and an Elevator sit at the same spot on both floors,
// alongside hospital-game.js's HUD button; all three switch instantly and
// work in every phase (you must be able to come back down for handover).

export const CANVAS_WIDTH = 960;
export const CANVAS_HEIGHT = 600;

/** Box size for every ordinary station — Library Shift's 84. */
export const STATION_BOX_SIZE = 84;

/** Beds are taller than wide: a patient lies head-up on the pillow. */
export const BED_WIDTH = 92;
export const BED_HEIGHT = 120;

/** How far outside a station's box the player stops — Library Shift's value. */
export const PLAYER_STOP_MARGIN = 28;

export const FLOOR_1 = 1;
export const FLOOR_2 = 2;

/** Where the nurse starts each shift: the open middle of the floor, below the triage line. */
export const PLAYER_START = { x: 480, y: 520 };

/**
 * The fixed station list, each tagged with its floor. 1st Floor:
 * 'triage-desk', 'office' (Charge Nurse's office — the paycheck),
 * 'med-cabinet', 'operating-room', 'coffee-machine', 'bed' ×bedCount (each
 * with `bedIndex`). 2nd Floor: 'supply-cart'. Both: 'stairs' and
 * 'elevator' (with `targetFloor`).
 *
 * @param {number} bedCount
 * @returns {{id: string, kind: string, floor: number, x: number, y: number, w: number, h: number, bedIndex?: number, targetFloor?: number}[]}
 */
export function buildStations(bedCount = 4) {
  const s = STATION_BOX_SIZE;
  const stations = [
    { id: 'office', kind: 'office', floor: FLOOR_1, x: 80, y: 110, w: s, h: s },
    { id: 'triage-desk', kind: 'triage-desk', floor: FLOOR_1, x: 330, y: 110, w: 120, h: s },
    { id: 'med-cabinet', kind: 'med-cabinet', floor: FLOOR_1, x: 640, y: 110, w: s, h: s },
    { id: 'operating-room', kind: 'operating-room', floor: FLOOR_1, x: 868, y: 360, w: 140, h: 150 },
    { id: 'coffee-machine', kind: 'coffee-machine', floor: FLOOR_1, x: 80, y: 530, w: s, h: s },
    { id: 'stairs-1', kind: 'stairs', floor: FLOOR_1, targetFloor: FLOOR_2, x: 880, y: 110, w: s, h: s },
    { id: 'elevator-1', kind: 'elevator', floor: FLOOR_1, targetFloor: FLOOR_2, x: 880, y: 530, w: s, h: s },
    // The Supply Room: the cart sits in the middle, shelves line the walls.
    { id: 'supply-cart', kind: 'supply-cart', floor: FLOOR_2, x: 420, y: 330, w: 110, h: s },
    { id: 'stairs-2', kind: 'stairs', floor: FLOOR_2, targetFloor: FLOOR_1, x: 880, y: 110, w: s, h: s },
    { id: 'elevator-2', kind: 'elevator', floor: FLOOR_2, targetFloor: FLOOR_1, x: 880, y: 530, w: s, h: s },
  ];
  const bedXs = [150, 315, 480, 645];
  for (let i = 0; i < bedCount; i++) {
    stations.push({ id: `bed-${i}`, kind: 'bed', floor: FLOOR_1, bedIndex: i, x: bedXs[i] ?? (150 + i * 165), y: 360, w: BED_WIDTH, h: BED_HEIGHT });
  }
  return stations;
}

/** Just the stations on one floor — what's drawn and clickable there. */
export function stationsOnFloor(stations, floor) {
  return stations.filter((station) => station.floor === floor);
}

/**
 * Where the nurse lands after switching floors: beside whichever fixture
 * they used (Stairs or Elevator sit at the same spot on both floors), or
 * beside the Stairs for the HUD button.
 *
 * @param {'stairs' | 'elevator' | 'button'} via
 * @returns {{x: number, y: number}}
 */
export function entryPointFor(via) {
  return via === 'elevator' ? { x: 790, y: 530 } : { x: 790, y: 130 };
}

/** The station whose box contains (x, y), or null. */
export function stationAtPoint(x, y, stations) {
  for (const station of stations) {
    if (Math.abs(x - station.x) <= station.w / 2 && Math.abs(y - station.y) <= station.h / 2) return station;
  }
  return null;
}

/** How far from a station's center the player stops: just outside its box, toward wherever they're coming from. */
export function standoffFor(station, fromX, fromY) {
  const dx = Math.abs(fromX - station.x);
  const dy = Math.abs(fromY - station.y);
  // Approaching mostly from the side, stop past the half-width; from above/below, past the half-height.
  const half = dx * station.h > dy * station.w ? station.w / 2 : station.h / 2;
  return half + PLAYER_STOP_MARGIN;
}

/**
 * Where to walk to interact with a station at (stationX, stationY): a point
 * `standoffDistance` from it on the line toward the player. Already within
 * range → stay put.
 */
export function approachPoint(stationX, stationY, fromX, fromY, standoffDistance) {
  const dx = fromX - stationX;
  const dy = fromY - stationY;
  const dist = Math.hypot(dx, dy);
  if (dist <= standoffDistance) return { x: fromX, y: fromY };
  const ratio = standoffDistance / dist;
  return { x: stationX + dx * ratio, y: stationY + dy * ratio };
}

export function clampToCanvas(x, y, margin = 24) {
  return {
    x: Math.min(CANVAS_WIDTH - margin, Math.max(margin, x)),
    y: Math.min(CANVAS_HEIGHT - margin, Math.max(margin, y)),
  };
}
