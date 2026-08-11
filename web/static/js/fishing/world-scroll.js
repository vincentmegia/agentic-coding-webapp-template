// Pure, canvas-independent "world scroll" math for the Fishing Game
// (docs/features/fishing-game.md's Client-side Behavior "World scroll" note
// and Visual Direction: "The boat/rod is the only screen-fixed element").
//
// This module has NO DOM/canvas/localStorage/timer dependencies on purpose,
// mirroring rules.js and engine-state.js's contract, so it can be
// unit-tested with `node --test` and imported unchanged by the canvas game
// loop (fishing-game.js, a separate task). It owns exactly the math needed
// to make depth read as "the world scrolls up past a fixed boat" instead of
// the earlier fixed-diver-with-drifting-sprites mechanic:
//
//   - converting the same `descentSpeed()` value rules.js already produces
//     for scoring into a per-frame pixel scroll offset (scrollOffsetForFrame)
//   - where a newly-spawned sprite should start, just past the bottom edge
//     (spawnY)
//   - applying that offset to move a sprite upward without mutating it
//     (scrollSprite)
//   - deciding when a sprite has scrolled far enough past the top edge to
//     be safely removed (isOffScreen)
//
// This module never reads a clock or recomputes descent speed itself — the
// doc is explicit that "a visually faster descent and a harder round are
// always the same moment, not two separate systems that could drift out of
// sync," so the same `descentSpeed()` output the scoring math already used
// this frame must be the value the caller passes in here too. Enforcing
// that single-source-of-truth discipline is the caller's job (fishing-game.js);
// this module just does the correct, pure conversion once it's handed that
// value.

// ---------------------------------------------------------------------------
// 1. scrollOffsetForFrame
// ---------------------------------------------------------------------------

/**
 * rules.js's `descentSpeed()` documents its own units as "arbitrary game
 * units" (its comment: "e.g. px/frame at 60fps") and explicitly leaves the
 * real interpretation to callers. fishing-game.js already has
 * `DEPTH_MILES_PER_SECOND_AT_BASE_SPEED = 8` as *its* interpretation, for
 * the scoring-relevant depth-miles/second conversion. This constant is the
 * matching interpretation for the visual world-scroll rate: pixels/second
 * at the base speed (1.0).
 *
 * The canvas is roughly 480x640px (doc: Visual Direction/User Flow describe
 * a portrait-oriented play area). A sprite spawns just past the bottom edge
 * (`spawnY`, ~canvas height + a small margin) and is removed once it passes
 * a fixed threshold above the top edge (`isOffScreen`), so a sprite's full
 * top-to-bottom trip covers roughly canvas-height-plus-margins, i.e. on the
 * order of 700-750px. At base descent speed, this constant is chosen so
 * that trip takes on the order of 4-5 seconds: fast enough that "descent"
 * reads as continuous motion rather than a static scene, slow enough that a
 * player can actually see an incoming fish/hazard, judge its horizontal
 * position, and react — the same readability budget an arcade scroller
 * needs regardless of how the underlying speed number is scaled for
 * scoring. 150 px/s * ~4.7s ≈ 700px, matching that trip length.
 *
 * Scales linearly with `descentSpeedValue`, exactly like
 * `DEPTH_MILES_PER_SECOND_AT_BASE_SPEED` does for depth-miles — so if
 * fishing-game.js feeds this function and its own depth-miles conversion
 * the *same* `descentSpeed()` output every frame (the doc's explicit
 * requirement), the visual scroll rate and the scoring-relevant descent
 * speed never drift apart; a round that is scoring "faster" is always
 * visibly scrolling faster by the same proportion.
 */
export const SCROLL_PIXELS_PER_SECOND_AT_BASE_SPEED = 150;

/**
 * Converts a per-frame time delta into how many pixels the world (water
 * background and every fish/hazard sprite) should scroll upward this frame,
 * at the given descent speed.
 *
 * This is a direct, linear interpretation of `descentSpeed()` — see
 * `SCROLL_PIXELS_PER_SECOND_AT_BASE_SPEED`'s doc comment for why that
 * constant's value was chosen and why linear scaling is what keeps the
 * visual scroll rate and the scoring-relevant descent speed from drifting
 * apart. This function does not read a clock or call `descentSpeed()`
 * itself — the caller must pass in the same `descentSpeed()` output it used
 * for this frame's scoring math, so the two never disagree about "how fast
 * is this frame."
 *
 * @param {number} descentSpeedValue - the current `descentSpeed()` output
 *   (rules.js's `[1.0, 5.0]` "arbitrary game units"). Negative/non-finite
 *   input is treated as 0 (no scroll that frame), matching this codebase's
 *   established defensive-input convention (rules.js/engine-state.js).
 * @param {number} deltaSeconds - elapsed time this frame, in seconds.
 *   Negative/non-finite/zero input is treated as 0 (no scroll that frame) —
 *   a frame can't un-scroll the world or scroll it on a bad delta.
 * @returns {number} pixels to scroll the world upward this frame, always >= 0.
 */
export function scrollOffsetForFrame(descentSpeedValue, deltaSeconds) {
  const speed = Number.isFinite(descentSpeedValue) && descentSpeedValue > 0
    ? descentSpeedValue
    : 0;
  const delta = Number.isFinite(deltaSeconds) && deltaSeconds > 0
    ? deltaSeconds
    : 0;

  return speed * SCROLL_PIXELS_PER_SECOND_AT_BASE_SPEED * delta;
}

// ---------------------------------------------------------------------------
// 2. spawnY
// ---------------------------------------------------------------------------

/**
 * Margin below the bottom edge a freshly-spawned sprite starts at, so it
 * enters the visible play area smoothly (already moving, not popping into
 * existence at the exact edge) once scrolling is applied. Illustrative but
 * deliberate: large enough that a sprite's own height/hitbox (fish/hazard
 * SVGs are small, silhouette-sized per the doc's Visual Direction) is fully
 * clear of the bottom edge at spawn, small enough that it scrolls into view
 * within a fraction of a second rather than a long, empty wait.
 */
const SPAWN_MARGIN_PX = 40;

/**
 * The y-coordinate a newly-spawned sprite should be placed at: just past
 * the bottom edge of the play area, so `scrollSprite` calls immediately
 * start carrying it upward into view rather than requiring a separate
 * "wait to enter" state.
 *
 * @param {number} worldHeight - the play area's current height in pixels
 *   (i.e. the canvas height). Negative/non-finite input is treated as 0.
 * @returns {number} a y-coordinate greater than `worldHeight`.
 */
export function spawnY(worldHeight) {
  const height = Number.isFinite(worldHeight) && worldHeight > 0 ? worldHeight : 0;
  return height + SPAWN_MARGIN_PX;
}

// ---------------------------------------------------------------------------
// 3. scrollSprite
// ---------------------------------------------------------------------------

/**
 * Moves a single sprite upward by `scrollOffsetPx` (the doc: depth is
 * communicated by scrolling "every fish/hazard sprite *upward* past the
 * fixed boat"). Pure, matching engine-state.js's pattern: returns a new
 * sprite object and never mutates the input, so callers can safely keep
 * reusing an existing sprite reference elsewhere (e.g. mid-iteration over an
 * array) without aliasing bugs.
 *
 * Only `y` is touched — this function has no opinion about a sprite's other
 * fields (`x`, kind, hitbox radius, etc.); it just forwards them unchanged.
 *
 * @param {{y: number, [key: string]: unknown}} sprite
 * @param {number} scrollOffsetPx - pixels to move the sprite upward this
 *   frame (typically `scrollOffsetForFrame`'s return value).
 *   Negative/non-finite input is treated as 0 (no movement).
 * @returns {{y: number, [key: string]: unknown}} a new sprite object.
 */
export function scrollSprite(sprite, scrollOffsetPx) {
  const offset = Number.isFinite(scrollOffsetPx) && scrollOffsetPx > 0
    ? scrollOffsetPx
    : 0;

  return { ...sprite, y: sprite.y - offset };
}

// ---------------------------------------------------------------------------
// 4. isOffScreen
// ---------------------------------------------------------------------------

/**
 * How far above the top edge (y=0) a sprite must scroll before it's
 * reported as safe to remove. A pure margin check against a fixed
 * threshold — this function deliberately does not take `worldHeight`, since
 * "scrolled off the top" is a property of the sprite's own position
 * relative to y=0, not of the play area's dimensions (unlike `spawnY`,
 * which does need the bottom edge's position). Set comfortably larger than
 * any sprite's own size (fish/hazard SVGs are small, silhouette-sized) so a
 * sprite is fully invisible — not just past its center point — before
 * despawning, avoiding a visible pop-out at the top edge.
 */
const OFFSCREEN_MARGIN_PX = 40;

/**
 * Reports whether a sprite has scrolled far enough past the top edge that
 * it's safe to remove from whatever array holds it (the doc: "despawning
 * once they exit the top").
 *
 * @param {{y: number}} sprite
 * @returns {boolean} true once `sprite.y` is past the fixed threshold above
 *   the top edge.
 */
export function isOffScreen(sprite) {
  return sprite.y < -OFFSCREEN_MARGIN_PX;
}
