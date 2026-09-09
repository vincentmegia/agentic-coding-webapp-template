// Pure, DOM-free navigation logic for the landing page image carousel
// (carousel.js). No DOM/timer dependencies, so it can be unit-tested with
// `node --test` and imported unchanged by carousel.js — the same "pure
// logic module" pattern web/static/js/puzzle/dfs.js and
// web/static/js/fishing/rules.js already establish for this codebase's
// other client-side features.
//
// Slide indices are 1-based throughout (matching carousel.html's
// data-index attributes, which start at 1 — see docs/features/
// landing-carousel.md's Implementation Contract), not the more common
// 0-based array indexing.

/** Next slide index, wrapping from the last slide back to the first
 * (docs/features/landing-carousel.md's Testing Plan: "Autoplay advances
 * slides on a timer and loops from the last slide back to the first"). */
export function nextIndexOf(index, total) {
	return index >= total ? 1 : index + 1;
}

/** Previous slide index, wrapping from the first slide to the last. */
export function prevIndexOf(index, total) {
	return index <= 1 ? total : index - 1;
}

/** Whether autoplay should currently be running, per docs/features/
 * landing-carousel.md's Business Rules: never with 1 slide, never under
 * `prefers-reduced-motion`, and never while any of the three independent
 * pause sources (hover/focus, user toggle, offscreen) is active — pausing
 * for one reason must not be undone by another reason clearing, which is
 * exactly why these are three separate booleans ANDed together here
 * rather than one combined "paused" flag. */
export function computeShouldRun(state) {
	return (
		state.total > 1 &&
		!state.reducedMotion &&
		!state.hoverPaused &&
		!state.userPaused &&
		!state.offscreenPaused
	);
}
