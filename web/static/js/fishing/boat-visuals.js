// Pure, canvas-independent math for the boat's cast animation and
// depth-based fade (docs/features/fishing-game.md's Visual Direction "Cast
// animation and boat fade" and Client-side Behavior of the same name).
//
// This module has NO DOM/canvas/timer dependencies on purpose, mirroring
// rules.js/engine-state.js/world-scroll.js's contract, so it can be
// unit-tested with `node --test` and imported unchanged by the canvas game
// loop (fishing-game.js). Both functions here are purely cosmetic — the doc
// is explicit that neither may gate collision/scoring or move the hook; this
// module has no way to do that even by accident, since it never touches
// round state, only takes a plain number and returns a plain number.

// ---------------------------------------------------------------------------
// 1. castProgress
// ---------------------------------------------------------------------------

/** How long the initial cast animation takes, in seconds (doc: "roughly the
 * first half-second"). */
export const CAST_ANIMATION_SECONDS = 0.45;

/**
 * Fraction of the cast animation complete, given seconds elapsed since the
 * round started. 0 at t=0 (line not yet paid out), 1.0 once
 * `CAST_ANIMATION_SECONDS` have elapsed (line at its normal full length) and
 * for all time after. Callers use this to interpolate the rendered line's
 * length from short to full — the round's actual state (hook position,
 * collision) is unaffected either way; see the doc's explicit "cosmetic
 * only" callout.
 *
 * @param {number} castElapsedSeconds - seconds since the round started.
 *   Negative/non-finite input is treated as 0.
 * @returns {number} progress in [0, 1].
 */
export function castProgress(castElapsedSeconds) {
  const elapsed = Number.isFinite(castElapsedSeconds) && castElapsedSeconds > 0
    ? castElapsedSeconds
    : 0;
  return Math.min(1, elapsed / CAST_ANIMATION_SECONDS);
}

// ---------------------------------------------------------------------------
// 2. boatOpacityForDepth
// ---------------------------------------------------------------------------

/** Depth (miles) by which the boat has reached its minimum opacity.
 * Illustrative — tune during build. Chosen as a small fraction of the
 * 1000-mile depth cap so the fade is clearly visible well within a typical
 * round rather than only mattering near the very end of a deep dive. */
export const BOAT_FADE_DEPTH_MILES = 120;

/** The boat/fisherman/rod group's minimum opacity — never fully `0` (doc:
 * "the boat never disappears entirely"), just a faint hint that it's still
 * up there at the surface. */
export const BOAT_MIN_OPACITY = 0.12;

/**
 * The boat/fisherman/rod group's opacity at the given depth: fully opaque
 * (1.0) at depth 0, linearly interpolating down to `BOAT_MIN_OPACITY` by
 * `BOAT_FADE_DEPTH_MILES`, and staying at that minimum beyond it. The line
 * and hook are never passed through this function — callers must draw them
 * in a separate pass at their own constant, full opacity (doc: "the line
 * and hook stay fully visible throughout").
 *
 * @param {number} depthMiles - current depth in miles. Negative/non-finite
 *   input is treated as 0 (fully opaque).
 * @returns {number} opacity in [BOAT_MIN_OPACITY, 1.0].
 */
export function boatOpacityForDepth(depthMiles) {
  const depth = Number.isFinite(depthMiles) && depthMiles > 0 ? depthMiles : 0;
  if (depth >= BOAT_FADE_DEPTH_MILES) return BOAT_MIN_OPACITY;

  const progress = depth / BOAT_FADE_DEPTH_MILES;
  return 1 - progress * (1 - BOAT_MIN_OPACITY);
}
