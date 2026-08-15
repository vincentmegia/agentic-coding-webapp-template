import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  castProgress,
  CAST_ANIMATION_SECONDS,
  boatOpacityForDepth,
  BOAT_FADE_DEPTH_MILES,
  BOAT_MIN_OPACITY,
} from './boat-visuals.js';

describe('castProgress', () => {
  test('is 0 at the start of the round', () => {
    assert.equal(castProgress(0), 0);
  });

  test('increases toward 1 as the animation plays', () => {
    const half = castProgress(CAST_ANIMATION_SECONDS / 2);
    assert.ok(half > 0 && half < 1, `expected 0 < ${half} < 1`);
  });

  test('reaches exactly 1 once the animation duration elapses', () => {
    assert.equal(castProgress(CAST_ANIMATION_SECONDS), 1);
  });

  test('stays at 1 for any time after the animation completes', () => {
    assert.equal(castProgress(CAST_ANIMATION_SECONDS * 10), 1);
    assert.equal(castProgress(9999), 1);
  });

  test('treats negative or non-finite input as 0 elapsed', () => {
    assert.equal(castProgress(-1), 0);
    assert.equal(castProgress(NaN), 0);
    assert.equal(castProgress(Infinity), 0);
  });
});

describe('boatOpacityForDepth', () => {
  test('is fully opaque at depth 0', () => {
    assert.equal(boatOpacityForDepth(0), 1);
  });

  test('decreases monotonically as depth increases toward the fade depth', () => {
    const a = boatOpacityForDepth(10);
    const b = boatOpacityForDepth(50);
    const c = boatOpacityForDepth(100);
    assert.ok(a > b && b > c, `expected ${a} > ${b} > ${c}`);
  });

  test('reaches exactly the minimum at the fade depth', () => {
    assert.equal(boatOpacityForDepth(BOAT_FADE_DEPTH_MILES), BOAT_MIN_OPACITY);
  });

  test('never goes below the documented minimum beyond the fade depth', () => {
    assert.equal(boatOpacityForDepth(BOAT_FADE_DEPTH_MILES * 5), BOAT_MIN_OPACITY);
    assert.equal(boatOpacityForDepth(1000), BOAT_MIN_OPACITY);
  });

  test('minimum is never fully zero (the boat never disappears entirely)', () => {
    assert.ok(BOAT_MIN_OPACITY > 0);
    assert.ok(boatOpacityForDepth(1_000_000) > 0);
  });

  test('treats negative or non-finite depth as 0 (fully opaque)', () => {
    assert.equal(boatOpacityForDepth(-5), 1);
    assert.equal(boatOpacityForDepth(NaN), 1);
  });
});
