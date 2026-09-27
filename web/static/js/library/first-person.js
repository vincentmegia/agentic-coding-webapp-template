// Pure, canvas-independent math for Library Shift's First Person Mode
// (docs/features/library-game.md's Scope: "First Person Mode" — added
// after the game shipped, per the user's explicit "seeing in first person
// and seeing anything but yourself").
//
// This module has NO DOM/canvas dependencies on purpose, mirroring
// floor-plan.js/rules.js/engine-state.js's own contract, so the
// angle/distance/projection math can be unit-tested with `node --test`
// (first-person.test.js) and imported unchanged by library-game.js's
// render loop.
//
// There is no 3D engine, wall texture, or raycaster anywhere in this
// codebase, so First Person is a lightweight "billboard sprite" camera, not
// a true 3D projection: every station/patron is a flat point in the
// existing 960x600 top-down world; this module turns "where is that point
// relative to the player's position + facing angle" into "how far
// horizontally across the screen, and how big" — angle-across-the-FOV maps
// to screen X, inverse distance maps to a draw scale — so
// library-game.js's render loop can keep calling the exact same
// `drawLibraryPerson`/`drawStation` primitives it already uses in
// Top-Down mode, just fed a screen position and scale instead of a world
// position.
//
// Facing-angle convention (arbitrary but fixed, documented once here so
// every function agrees): angle 0 points "north" — the world's -y
// direction (up, same sense as the top-down floor plan's y axis) — and
// angle increases CLOCKWISE toward "east" (+x). That makes the forward
// unit vector `(sin(facing), -cos(facing))`, and `angleTo` below is defined
// so that facing an entity exactly (angleOffset === 0) means walking
// forward walks straight at it.

/** Standard normalization: any angle in radians -> the equivalent value in (-PI, PI]. */
export function normalizeAngle(angle) {
  let a = angle % TWO_PI;
  if (a <= -Math.PI) a += TWO_PI;
  else if (a > Math.PI) a -= TWO_PI;
  return a;
}

export const TWO_PI = Math.PI * 2;

/** The world-space angle (this module's convention, see header) from (fromX, fromY) toward (toX, toY). */
export function angleTo(fromX, fromY, toX, toY) {
  return normalizeAngle(Math.atan2(toX - fromX, -(toY - fromY)));
}

/** Smallest signed angular difference `a - b`, wrapped to (-PI, PI] — e.g. angleDiff of two near-opposite angles never returns something like 359 degrees. */
export function angleDiff(a, b) {
  return normalizeAngle(a - b);
}

/** The unit vector a player facing `facing` walks toward, in this module's angle convention. */
export function forwardVector(facing) {
  return { dx: Math.sin(facing), dy: -Math.cos(facing) };
}

/**
 * A sensible default facing when first entering First Person: point toward
 * the room's center rather than an arbitrary fixed direction, so the player
 * isn't immediately staring at a wall regardless of where they happened to
 * be standing in Top-Down mode. Falls back to facing 0 ("north") when `x, y`
 * already IS the center (distance ~0) — both floors' entry points
 * (floor-plan.js's FLOOR_1_ENTRY_POINT/FLOOR_2_ENTRY_POINT) are exactly the
 * canvas center, and `angleTo` on two identical points hits `Math.atan2(0,
 * -0)`, which JS defines as `PI`, not `0` — a real, silent-degenerate result
 * that isn't "toward the center" in any meaningful sense, and would leave a
 * player facing exactly backward every time they arrive at either floor's
 * entry point.
 */
export function defaultFacingTowardCenter(x, y, canvasWidth, canvasHeight) {
  const dx = canvasWidth / 2 - x;
  const dy = canvasHeight / 2 - y;
  if (Math.hypot(dx, dy) < 0.001) return 0;
  return angleTo(x, y, canvasWidth / 2, canvasHeight / 2);
}

// ---------------------------------------------------------------------------
// Tunable constants — all illustrative/tunable like every other magnitude in
// this game (rules.js's own precedent), named rather than inlined.
// ---------------------------------------------------------------------------

/** Horizontal field of view, in degrees — the doc's own "~90°" suggestion. */
export const DEFAULT_FOV_DEGREES = 90;

/** Anything farther than this (world pixels) is culled — never even considered "visible," regardless of angle. */
export const DEFAULT_MAX_DISTANCE = 750;

/** The distance at which an entity draws at scale 1 — closer draws bigger, farther draws smaller, via `scaleForDistance`. */
export const DEFAULT_REFERENCE_DISTANCE = 130;

export const DEFAULT_MIN_SCALE = 0.15;
export const DEFAULT_MAX_SCALE = 2.5;

/** How many degrees off dead-center still counts as "looked at" for the interact prompt/crosshair — a narrow cone near the crosshair, not the full FOV. */
export const DEFAULT_INTERACT_MAX_ANGLE_DEGREES = 9;

/** How close (world pixels) an entity must be to be interactable at all, even if perfectly centered — roughly a station's half-size plus walking-up room, same spirit as floor-plan.js's PLAYER_STOP_MARGIN. */
export const DEFAULT_INTERACT_MAX_DISTANCE = 150;

/** Radians/second the camera turns while a turn control is held — a full 180-degree turn in exactly one second. */
export const TURN_SPEED_RADIANS_PER_SECOND = Math.PI;

/** World pixels/second walked while a move control is held, before the Sanity walk-speed multiplier (rules.js's `walkSpeedMultiplierForSanity`, reused as-is by the caller) is applied — deliberately a bit below Top-Down's 240 base speed since aiming a facing angle is less precise than clicking an exact destination. */
export const MOVE_SPEED_PIXELS_PER_SECOND = 200;

/** Where the horizon line sits and how far a billboard's "ground contact point" can drop below it as distance shrinks — see `groundScreenY`. */
export const DEFAULT_PERSPECTIVE_K = 220;

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * The player's position (`entity.x`/`entity.y`) is any spawn/station's
 * existing world x/y (floor-plan.js's coordinate space, or a front-desk
 * slot/return-cart book's own computed x/y) — this module doesn't care
 * which, it just needs a point and the player's own {x, y, facing}.
 *
 * @param {{x: number, y: number, facing: number}} player
 * @param {{x: number, y: number}} entity
 * @returns {{distance: number, angleOffset: number}}
 */
export function projectEntity(player, entity) {
  const dx = entity.x - player.x;
  const dy = entity.y - player.y;
  const distance = Math.hypot(dx, dy);
  const worldAngle = angleTo(player.x, player.y, entity.x, entity.y);
  const angleOffset = angleDiff(worldAngle, player.facing);
  return { distance, angleOffset };
}

/** Whether an already-projected {angleOffset, distance} pair should be drawn at all: within the FOV cone and not farther than the render cutoff. */
export function isVisibleInFOV(angleOffset, distance, opts = {}) {
  const maxDistance = opts.maxDistance ?? DEFAULT_MAX_DISTANCE;
  if (distance > maxDistance) return false;
  const fovRadians = ((opts.fovDegrees ?? DEFAULT_FOV_DEGREES) * Math.PI) / 180;
  return Math.abs(angleOffset) <= fovRadians / 2;
}

/** Maps an angleOffset within [-FOV/2, FOV/2] to a screen X in [0, canvasWidth] — angleOffset 0 (dead-center) always lands at canvasWidth/2. */
export function screenXForAngleOffset(angleOffset, canvasWidth, opts = {}) {
  const fovRadians = ((opts.fovDegrees ?? DEFAULT_FOV_DEGREES) * Math.PI) / 180;
  const half = fovRadians / 2;
  const t = (angleOffset + half) / fovRadians;
  return t * canvasWidth;
}

/** Inverse-distance draw scale: closer = bigger, farther = smaller, clamped so nothing vanishes to nothing or balloons to fill the screen. */
export function scaleForDistance(distance, opts = {}) {
  const reference = opts.referenceDistance ?? DEFAULT_REFERENCE_DISTANCE;
  const min = opts.minScale ?? DEFAULT_MIN_SCALE;
  const max = opts.maxScale ?? DEFAULT_MAX_SCALE;
  const raw = reference / Math.max(distance, 1);
  return Math.min(max, Math.max(min, raw));
}

/**
 * The screen Y a billboard's "feet"/ground-contact point should draw at, for
 * a given distance — a cheap stand-in for real perspective: nearer things
 * sit lower on screen (closer to the bottom edge, i.e. closer to the
 * camera), farther things sit near the horizon, clamped so nothing crosses
 * the horizon line itself or runs off the bottom edge.
 */
export function groundScreenY(distance, opts = {}) {
  const horizonY = opts.horizonY ?? 300;
  const canvasHeight = opts.canvasHeight ?? 600;
  const perspectiveK = opts.perspectiveK ?? DEFAULT_PERSPECTIVE_K;
  const maxDrop = canvasHeight - horizonY - 6;
  const drop = Math.min(maxDrop, ((canvasHeight - horizonY) * perspectiveK) / Math.max(distance, 1));
  return horizonY + Math.max(0, drop);
}

/**
 * Projects, culls, and sorts a list of world-space entities against the
 * player's position + facing: `{ ...entity, distance, angleOffset,
 * screenX, scale, groundY }`, FOV/distance-culled, sorted back-to-front
 * (farthest first) — a simple painter's algorithm, so a caller that draws
 * the array in order naturally layers nearer sprites on top of farther
 * ones without any manual z-checking.
 *
 * @param {{x: number, y: number, facing: number}} player
 * @param {{x: number, y: number}[]} entities - each may carry any extra fields; they pass through untouched.
 * @param {object} [opts] - forwarded to isVisibleInFOV/screenXForAngleOffset/scaleForDistance/groundScreenY.
 */
export function projectScene(player, entities, opts = {}) {
  const canvasWidth = opts.canvasWidth ?? 960;
  const projected = [];
  for (const entity of entities) {
    const { distance, angleOffset } = projectEntity(player, entity);
    if (!isVisibleInFOV(angleOffset, distance, opts)) continue;
    projected.push({
      ...entity,
      distance,
      angleOffset,
      screenX: screenXForAngleOffset(angleOffset, canvasWidth, opts),
      scale: scaleForDistance(distance, opts),
      groundY: groundScreenY(distance, opts),
    });
  }
  projected.sort((a, b) => b.distance - a.distance);
  return projected;
}

/**
 * Of a list of already-projected entities (as returned by `projectScene`),
 * finds the nearest one sitting close enough to dead-center (within
 * `maxAngleDegrees`) and close enough in distance (`maxDistance`) to count
 * as "looked at" — the thing the interact prompt/crosshair should target.
 * `null` if nothing qualifies. Ties (equal distance) keep whichever the
 * input list visited first, same as a plain linear-scan minimum.
 */
export function findInteractTarget(projectedEntities, opts = {}) {
  const maxAngleRadians = ((opts.maxAngleDegrees ?? DEFAULT_INTERACT_MAX_ANGLE_DEGREES) * Math.PI) / 180;
  const maxDistance = opts.maxDistance ?? DEFAULT_INTERACT_MAX_DISTANCE;
  let best = null;
  for (const entity of projectedEntities) {
    if (Math.abs(entity.angleOffset) > maxAngleRadians) continue;
    if (entity.distance > maxDistance) continue;
    if (!best || entity.distance < best.distance) best = entity;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Turning / moving
// ---------------------------------------------------------------------------

/** Applies one frame's worth of turning: `direction` is -1 (left/counter-clockwise), 0, or 1 (right/clockwise). */
export function turnFacing(facing, direction, deltaSeconds, turnSpeed = TURN_SPEED_RADIANS_PER_SECOND) {
  if (!direction) return normalizeAngle(facing);
  return normalizeAngle(facing + direction * turnSpeed * deltaSeconds);
}

/** Moves a point `distance` world pixels along (`direction` 1) or against (`direction` -1) the given facing. */
export function stepForward(x, y, facing, direction, distance) {
  const { dx, dy } = forwardVector(facing);
  return { x: x + dx * distance * direction, y: y + dy * distance * direction };
}
