import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  scrollOffsetForFrame,
  spawnY,
  scrollSprite,
  isOffScreen,
  SCROLL_PIXELS_PER_SECOND_AT_BASE_SPEED,
} from './world-scroll.js';

describe('scrollOffsetForFrame', () => {
  test('scales linearly with speed at a fixed delta', () => {
    const delta = 1;
    const base = scrollOffsetForFrame(1.0, delta);
    const double = scrollOffsetForFrame(2.0, delta);
    assert.equal(base, SCROLL_PIXELS_PER_SECOND_AT_BASE_SPEED * delta);
    assert.equal(double, base * 2);
  });

  test('scales linearly with deltaSeconds at a fixed speed', () => {
    const speed = 1.0;
    const half = scrollOffsetForFrame(speed, 0.5);
    const full = scrollOffsetForFrame(speed, 1.0);
    assert.equal(full, half * 2);
    assert.equal(full, SCROLL_PIXELS_PER_SECOND_AT_BASE_SPEED);
  });

  test('at the documented max descent speed, scrolls proportionally faster', () => {
    const atBase = scrollOffsetForFrame(1.0, 1);
    const atMax = scrollOffsetForFrame(5.0, 1);
    assert.equal(atMax, atBase * 5);
  });

  test('zero speed produces zero scroll', () => {
    assert.equal(scrollOffsetForFrame(0, 1), 0);
  });

  test('zero delta produces zero scroll', () => {
    assert.equal(scrollOffsetForFrame(3.0, 0), 0);
  });

  test('negative speed is treated as 0', () => {
    assert.equal(scrollOffsetForFrame(-2.0, 1), 0);
  });

  test('negative deltaSeconds is treated as 0', () => {
    assert.equal(scrollOffsetForFrame(2.0, -1), 0);
  });

  test('non-finite speed or delta is treated as 0, never throws or returns NaN', () => {
    assert.doesNotThrow(() => scrollOffsetForFrame(NaN, 1));
    assert.equal(scrollOffsetForFrame(NaN, 1), 0);
    assert.equal(scrollOffsetForFrame(undefined, 1), 0);
    assert.equal(scrollOffsetForFrame(1, NaN), 0);
    assert.equal(scrollOffsetForFrame(1, undefined), 0);
    assert.equal(scrollOffsetForFrame(Infinity, 1), 0);
  });

  test('return value is always >= 0', () => {
    assert.ok(scrollOffsetForFrame(-5, -5) >= 0);
    assert.ok(scrollOffsetForFrame(5, 5) >= 0);
  });
});

describe('spawnY', () => {
  test('returns a y-coordinate past the given world height', () => {
    const height = 640;
    const y = spawnY(height);
    assert.ok(y > height);
  });

  test('grows with world height', () => {
    assert.ok(spawnY(1000) > spawnY(500));
  });

  test('negative or non-finite world height is treated as 0, still returns a positive margin', () => {
    assert.ok(spawnY(-100) > 0);
    assert.ok(spawnY(NaN) > 0);
    assert.ok(spawnY(undefined) > 0);
  });
});

describe('scrollSprite', () => {
  test('decreases y by exactly the given offset', () => {
    const sprite = { x: 10, y: 100 };
    const result = scrollSprite(sprite, 25);
    assert.equal(result.y, 75);
  });

  test('does not mutate the input sprite', () => {
    const sprite = { x: 10, y: 100 };
    const snapshot = { ...sprite };
    scrollSprite(sprite, 25);
    assert.deepEqual(sprite, snapshot);
  });

  test('returns a new object, not the same reference', () => {
    const sprite = { x: 10, y: 100 };
    const result = scrollSprite(sprite, 25);
    assert.notEqual(result, sprite);
  });

  test('preserves other sprite fields unchanged', () => {
    const sprite = { x: 42, y: 100, kind: 'fish', name: 'Sardine', radius: 8 };
    const result = scrollSprite(sprite, 10);
    assert.equal(result.x, 42);
    assert.equal(result.kind, 'fish');
    assert.equal(result.name, 'Sardine');
    assert.equal(result.radius, 8);
  });

  test('negative or non-finite offset is treated as 0 (no movement)', () => {
    const sprite = { x: 0, y: 100 };
    assert.equal(scrollSprite(sprite, -10).y, 100);
    assert.equal(scrollSprite(sprite, NaN).y, 100);
    assert.equal(scrollSprite(sprite, undefined).y, 100);
  });

  test('a zero offset returns an equivalent (but distinct) sprite', () => {
    const sprite = { x: 5, y: 200 };
    const result = scrollSprite(sprite, 0);
    assert.deepEqual(result, sprite);
    assert.notEqual(result, sprite);
  });
});

describe('isOffScreen', () => {
  test('false for a sprite still fully on-screen', () => {
    assert.equal(isOffScreen({ y: 300 }), false);
  });

  test('false for a sprite right at the top edge', () => {
    assert.equal(isOffScreen({ y: 0 }), false);
  });

  test('false for a sprite just slightly above the top edge, within the margin', () => {
    assert.equal(isOffScreen({ y: -5 }), false);
  });

  test('true once a sprite has scrolled sufficiently far past the top edge', () => {
    assert.equal(isOffScreen({ y: -1000 }), true);
  });
});

describe('integration: spawn, scroll repeatedly, eventually off-screen', () => {
  test('a sprite spawned at the bottom moves upward each step and never downward', () => {
    const worldHeight = 640;
    let sprite = { x: 100, y: spawnY(worldHeight), kind: 'fish' };
    const startingY = sprite.y;

    let steps = 0;
    const maxSteps = 10_000;
    let previousY = sprite.y;

    while (!isOffScreen(sprite) && steps < maxSteps) {
      const offset = scrollOffsetForFrame(2.0, 1 / 60);
      sprite = scrollSprite(sprite, offset);
      assert.ok(sprite.y <= previousY, 'sprite must never move downward while scrolling');
      previousY = sprite.y;
      steps += 1;
    }

    assert.ok(steps < maxSteps, 'sprite should have gone off-screen well before maxSteps');
    assert.ok(isOffScreen(sprite));
    assert.ok(sprite.y < startingY);
    // Horizontal position and identity fields are untouched by scrolling.
    assert.equal(sprite.x, 100);
    assert.equal(sprite.kind, 'fish');
  });
});
