import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { nextIndexOf, prevIndexOf, computeShouldRun } from './carousel-nav.js';

describe('nextIndexOf', () => {
	test('advances by one within range', () => {
		assert.equal(nextIndexOf(1, 5), 2);
		assert.equal(nextIndexOf(4, 5), 5);
	});

	test('wraps from the last slide back to the first', () => {
		assert.equal(nextIndexOf(5, 5), 1);
	});

	test('is a no-op loop with a single slide', () => {
		assert.equal(nextIndexOf(1, 1), 1);
	});
});

describe('prevIndexOf', () => {
	test('retreats by one within range', () => {
		assert.equal(prevIndexOf(5, 5), 4);
		assert.equal(prevIndexOf(2, 5), 1);
	});

	test('wraps from the first slide back to the last', () => {
		assert.equal(prevIndexOf(1, 5), 5);
	});

	test('is a no-op loop with a single slide', () => {
		assert.equal(prevIndexOf(1, 1), 1);
	});
});

describe('computeShouldRun', () => {
	const baseState = {
		total: 5,
		reducedMotion: false,
		hoverPaused: false,
		userPaused: false,
		offscreenPaused: false,
	};

	test('runs when nothing is pausing it', () => {
		assert.equal(computeShouldRun(baseState), true);
	});

	test('never runs with only one slide', () => {
		assert.equal(computeShouldRun({ ...baseState, total: 1 }), false);
	});

	test('never runs under prefers-reduced-motion', () => {
		assert.equal(computeShouldRun({ ...baseState, reducedMotion: true }), false);
	});

	test('stops for hover/focus pause alone', () => {
		assert.equal(computeShouldRun({ ...baseState, hoverPaused: true }), false);
	});

	test('stops for a user pause alone', () => {
		assert.equal(computeShouldRun({ ...baseState, userPaused: true }), false);
	});

	test('stops for an offscreen pause alone', () => {
		assert.equal(computeShouldRun({ ...baseState, offscreenPaused: true }), false);
	});

	test('stays stopped by a user pause even once hover/offscreen pauses clear', () => {
		// Locks in the "three independent pause sources" business rule
		// (docs/features/landing-carousel.md): clearing one source must
		// never itself resume autoplay if another source is still active.
		const state = { ...baseState, userPaused: true, hoverPaused: false, offscreenPaused: false };
		assert.equal(computeShouldRun(state), false);
	});

	test('resumes only once every pause source has cleared', () => {
		const stillPaused = { ...baseState, hoverPaused: true, userPaused: true };
		assert.equal(computeShouldRun(stillPaused), false);

		const allClear = { ...stillPaused, hoverPaused: false, userPaused: false };
		assert.equal(computeShouldRun(allClear), true);
	});
});
