import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createInitialState,
  applyHazardHit,
  applyFishCatch,
  advance,
  DEFAULT_LIVES,
  INVULNERABILITY_SECONDS,
  DEPTH_CAP_MILES,
} from './engine-state.js';

describe('createInitialState', () => {
  test('defaults to 3 lives, zeroed progress, playing status', () => {
    const state = createInitialState();
    assert.equal(state.lives, DEFAULT_LIVES);
    assert.equal(state.milesSinceLastHit, 0);
    assert.equal(state.depthMiles, 0);
    assert.equal(state.elapsedSeconds, 0);
    assert.equal(state.score, 0);
    assert.equal(state.invulnerableUntil, 0);
    assert.equal(state.emergencyBallastCharged, false);
    assert.equal(state.roundStatus, 'playing');
  });

  test('accepts overrides for gear effects applied next round', () => {
    const state = createInitialState({ lives: 5, emergencyBallastCharged: true });
    assert.equal(state.lives, 5);
    assert.equal(state.emergencyBallastCharged, true);
  });
});

describe('applyHazardHit', () => {
  test('a hit decrements lives by exactly one and resets streak distance', () => {
    const state = createInitialState({ milesSinceLastHit: 42 });
    const next = applyHazardHit(state, 0);
    assert.equal(next.lives, DEFAULT_LIVES - 1);
    assert.equal(next.milesSinceLastHit, 0);
  });

  test('a hit starts the invulnerability window', () => {
    const state = createInitialState();
    const next = applyHazardHit(state, 10);
    assert.equal(next.invulnerableUntil, 10 + INVULNERABILITY_SECONDS);
  });

  test('a hit during the invulnerability window is a no-op', () => {
    const state = createInitialState();
    const afterFirstHit = applyHazardHit(state, 0);
    assert.equal(afterFirstHit.lives, DEFAULT_LIVES - 1);

    // Still inside the 1.2s window started at t=0.
    const afterSecondHit = applyHazardHit(afterFirstHit, 0.5);
    assert.deepEqual(afterSecondHit, afterFirstHit);
  });

  test('a hit after the invulnerability window expires registers normally', () => {
    const state = createInitialState();
    const afterFirstHit = applyHazardHit(state, 0);
    const afterWindow = applyHazardHit(afterFirstHit, INVULNERABILITY_SECONDS + 0.01);
    assert.equal(afterWindow.lives, DEFAULT_LIVES - 2);
  });

  test('zero lives transitions roundStatus to caught', () => {
    let state = createInitialState({ lives: 1 });
    state = applyHazardHit(state, 0);
    assert.equal(state.lives, 0);
    assert.equal(state.roundStatus, 'caught');
  });

  test('a hit once caught is a no-op (round already over)', () => {
    let state = createInitialState({ lives: 1 });
    state = applyHazardHit(state, 0);
    assert.equal(state.roundStatus, 'caught');
    const again = applyHazardHit(state, 100);
    assert.deepEqual(again, state);
  });

  describe('Emergency Ballast', () => {
    test('absorbs one hit without costing a life or resetting streak', () => {
      const state = createInitialState({ emergencyBallastCharged: true, milesSinceLastHit: 77 });
      const next = applyHazardHit(state, 0);
      assert.equal(next.lives, DEFAULT_LIVES);
      assert.equal(next.milesSinceLastHit, 77);
      assert.equal(next.emergencyBallastCharged, false);
    });

    test('still starts the same invulnerability window as a real hit', () => {
      const state = createInitialState({ emergencyBallastCharged: true });
      const next = applyHazardHit(state, 5);
      assert.equal(next.invulnerableUntil, 5 + INVULNERABILITY_SECONDS);
    });

    test('a hazard immediately following the absorbed one does not cost a life either', () => {
      let state = createInitialState({ emergencyBallastCharged: true });
      state = applyHazardHit(state, 0);
      assert.equal(state.lives, DEFAULT_LIVES);

      // Still within the i-frame window granted by the absorbed hit.
      const next = applyHazardHit(state, 0.1);
      assert.equal(next.lives, DEFAULT_LIVES);
      assert.deepEqual(next, state);
    });

    test('is unavailable again until explicitly recharged (e.g. next round)', () => {
      let state = createInitialState({ emergencyBallastCharged: true });
      state = applyHazardHit(state, 0);
      assert.equal(state.emergencyBallastCharged, false);

      // Past the i-frame window: the next hit now costs a real life, since
      // the shield was already consumed.
      const next = applyHazardHit(state, INVULNERABILITY_SECONDS + 1);
      assert.equal(next.lives, DEFAULT_LIVES - 1);
      assert.equal(next.emergencyBallastCharged, false);
    });
  });
});

describe('applyFishCatch', () => {
  test('adds fish.points times the current streak multiplier to score', () => {
    // milesSinceLastHit 0 -> streakMultiplier is 1.0x (base).
    const state = createInitialState();
    const next = applyFishCatch(state, { points: 10 });
    assert.equal(next.score, 10);
  });

  test('applies the elevated multiplier once streak distance has accrued', () => {
    // 50 hit-free miles -> streakMultiplier(50) = 1.25x per rules.test.js.
    const state = createInitialState({ milesSinceLastHit: 50 });
    const next = applyFishCatch(state, { points: 100 });
    assert.equal(next.score, 125);
  });

  test('is a no-op once the round has ended', () => {
    let state = createInitialState({ lives: 1 });
    state = applyHazardHit(state, 0);
    assert.equal(state.roundStatus, 'caught');
    const next = applyFishCatch(state, { points: 999 });
    assert.equal(next.score, state.score);
  });
});

describe('advance', () => {
  test('increases depthMiles, elapsedSeconds, and milesSinceLastHit together', () => {
    const state = createInitialState();
    const { state: next } = advance(state, 5, 0.5);
    assert.equal(next.depthMiles, 5);
    assert.equal(next.elapsedSeconds, 0.5);
    assert.equal(next.milesSinceLastHit, 5);
  });

  test('returns the descent speed for the caller to use, without storing it on state', () => {
    const state = createInitialState();
    const { state: next, speed } = advance(state, 10, 1);
    assert.equal(typeof speed, 'number');
    assert.ok(speed >= 1.0);
    assert.equal(next.speed, undefined);
  });

  test('reaching the depth cap transitions to reached-abyss even at full lives', () => {
    const state = createInitialState({ depthMiles: DEPTH_CAP_MILES - 1 });
    const { state: next } = advance(state, 5, 1);
    assert.equal(next.depthMiles, DEPTH_CAP_MILES);
    assert.equal(next.roundStatus, 'reached-abyss');
    assert.equal(next.lives, DEFAULT_LIVES);
  });

  test('depthMiles never exceeds the cap', () => {
    const state = createInitialState({ depthMiles: DEPTH_CAP_MILES - 1 });
    const { state: next } = advance(state, 500, 1);
    assert.equal(next.depthMiles, DEPTH_CAP_MILES);
  });

  test('is a no-op once the round has ended', () => {
    let state = createInitialState({ lives: 1 });
    state = applyHazardHit(state, 0);
    assert.equal(state.roundStatus, 'caught');
    const { state: next } = advance(state, 50, 5);
    assert.equal(next.depthMiles, state.depthMiles);
    assert.equal(next.elapsedSeconds, state.elapsedSeconds);
  });

  test('negative/non-finite deltas are treated as 0', () => {
    const state = createInitialState({ depthMiles: 10 });
    const { state: next } = advance(state, -5, NaN);
    assert.equal(next.depthMiles, 10);
    assert.equal(next.elapsedSeconds, 0);
  });
});

describe('fish/hazard overlap in the same tick', () => {
  test('a catch during an active hit in the same tick still applies (no forced priority)', () => {
    let state = createInitialState();

    // Same frame: both a hazard hit and a fish catch resolve independently,
    // in whichever order the caller happens to invoke them, per the doc's
    // "Fish/hazard overlap" rule.
    state = applyHazardHit(state, 0);
    const afterBoth = applyFishCatch(state, { points: 20 });

    assert.equal(afterBoth.lives, DEFAULT_LIVES - 1);
    assert.equal(afterBoth.score, 20);
  });

  test('order does not matter: catch then hit yields the same outcome', () => {
    let state = createInitialState();

    state = applyFishCatch(state, { points: 20 });
    state = applyHazardHit(state, 0);

    assert.equal(state.lives, DEFAULT_LIVES - 1);
    assert.equal(state.score, 20);
  });
});
