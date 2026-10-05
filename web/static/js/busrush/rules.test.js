import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  LANES,
  MIN_SPEED,
  BASE_MAX_SPEED,
  ENGINE_SPEED_STEP,
  UPGRADES,
  VEHICLES,
  BUS_LENGTH,
  PX_PER_METER,
  TRAFFIC_SPEED,
  ROW_SPACING_MAX,
  ROW_SPACING_MIN,
  SCORE_MAX,
  maxSpeed,
  stepSpeed,
  toKmh,
  laneChangeSeconds,
  maxLives,
  fareValue,
  runScore,
  runTokens,
  upgradeCost,
  canBuy,
  maxBlockedLanes,
  rowSpacingPx,
  pickBlockedLanes,
  openLanes,
  pickVehicle,
  rectsOverlap,
} from './rules.js';

// Small deterministic PRNG so the property-style tests below are repeatable.
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('speed', () => {
  test('engine raises top speed by a fixed step and caps at max level', () => {
    assert.equal(maxSpeed(0), BASE_MAX_SPEED);
    assert.equal(maxSpeed(2), BASE_MAX_SPEED + 2 * ENGINE_SPEED_STEP);
    assert.equal(maxSpeed(99), maxSpeed(UPGRADES.engine.maxLevel));
    assert.equal(maxSpeed(-1), BASE_MAX_SPEED);
  });

  test('accelerate speeds up, brake slows down, neither holds', () => {
    assert.ok(stepSpeed(10, { accelerate: true }, 0.1, 0) > 10);
    assert.ok(stepSpeed(12, { brake: true }, 0.1, 0) < 12);
    assert.equal(stepSpeed(12, {}, 0.1, 0), 12);
  });

  test('brake wins when both are held', () => {
    assert.ok(stepSpeed(12, { accelerate: true, brake: true }, 0.1, 0) < 12);
  });

  test('speed is clamped to [MIN_SPEED, maxSpeed(engine)]', () => {
    assert.equal(stepSpeed(MIN_SPEED, { brake: true }, 10, 0), MIN_SPEED);
    assert.equal(stepSpeed(BASE_MAX_SPEED, { accelerate: true }, 10, 0), BASE_MAX_SPEED);
    assert.equal(stepSpeed(1000, {}, 0.1, 0), BASE_MAX_SPEED);
    assert.equal(stepSpeed(NaN, {}, 0.1, 0), MIN_SPEED);
  });

  test('toKmh converts m/s to whole km/h', () => {
    assert.equal(toKmh(10), 36);
  });
});

describe('upgrade effects', () => {
  test('steering shortens lane changes but never below 0.1s', () => {
    assert.ok(laneChangeSeconds(1) < laneChangeSeconds(0));
    assert.ok(laneChangeSeconds(99) >= 0.1);
  });

  test('bumpers add a life per level', () => {
    assert.equal(maxLives(0), 3);
    assert.equal(maxLives(2), 5);
    assert.equal(maxLives(99), 3 + UPGRADES.bumpers.maxLevel);
  });

  test('fare box adds a token per fare per level', () => {
    assert.equal(fareValue(0), 1);
    assert.equal(fareValue(3), 4);
  });
});

describe('scoring', () => {
  test('score is whole distance plus 25 per fare, capped', () => {
    assert.equal(runScore(1234.9, 2), 1284);
    assert.equal(runScore(-5, -1), 0);
    assert.equal(runScore(10_000_000, 0), SCORE_MAX);
  });

  test('tokens are fares × fare value plus one per 100 m', () => {
    assert.equal(runTokens(450, 3, 0), 3 + 4);
    assert.equal(runTokens(450, 3, 2), 9 + 4);
    assert.equal(runTokens(0, 0, 0), 0);
  });
});

describe('shop', () => {
  test('cost grows with level and is null at max level', () => {
    for (const key of Object.keys(UPGRADES)) {
      const max = UPGRADES[key].maxLevel;
      for (let lvl = 1; lvl < max; lvl++) {
        assert.ok(upgradeCost(key, lvl) > upgradeCost(key, lvl - 1), `${key} level ${lvl}`);
      }
      assert.equal(upgradeCost(key, max), null);
    }
    assert.equal(upgradeCost('nope', 0), null);
  });

  test('canBuy needs enough tokens and an unmaxed upgrade', () => {
    const cost = upgradeCost('engine', 0);
    assert.equal(canBuy('engine', 0, cost), true);
    assert.equal(canBuy('engine', 0, cost - 1), false);
    assert.equal(canBuy('engine', UPGRADES.engine.maxLevel, 1e9), false);
  });
});

describe('traffic', () => {
  test('rows get denser with distance but never block every lane', () => {
    assert.equal(maxBlockedLanes(0), 1);
    assert.ok(maxBlockedLanes(5000) <= LANES - 1);
    assert.equal(rowSpacingPx(0), ROW_SPACING_MAX);
    assert.ok(rowSpacingPx(600) < ROW_SPACING_MAX);
    assert.equal(rowSpacingPx(1e7), ROW_SPACING_MIN);
  });

  test('pickBlockedLanes always leaves a lane open that is reachable from the previous row', () => {
    const rng = seeded(42);
    let prevOpen = null;
    for (let i = 0; i < 5000; i++) {
      const distance = i * 3;
      const blocked = pickBlockedLanes(rng, distance, prevOpen);
      assert.ok(blocked.length >= 1 && blocked.length <= maxBlockedLanes(distance));
      assert.equal(new Set(blocked).size, blocked.length, 'no duplicate lanes');
      blocked.forEach((l) => assert.ok(l >= 0 && l < LANES));
      const open = openLanes(blocked);
      assert.ok(open.length >= 1);
      if (prevOpen) {
        assert.ok(
          open.some((l) => prevOpen.some((p) => Math.abs(p - l) <= 1)),
          `row ${i}: open ${open} unreachable from ${prevOpen}`,
        );
      }
      prevOpen = open;
    }
  });

  test('the minimum row spacing leaves room for one lane change at top speed', () => {
    const longest = Math.max(...VEHICLES.map((v) => v.length));
    const topRelativePxPerSec = (maxSpeed(UPGRADES.engine.maxLevel) + TRAFFIC_SPEED) * PX_PER_METER;
    const windowSeconds = (ROW_SPACING_MIN - longest - BUS_LENGTH) / topRelativePxPerSec;
    assert.ok(windowSeconds >= laneChangeSeconds(0), `window ${windowSeconds}s`);
  });

  test('bigger vehicles unlock with distance', () => {
    const rng = seeded(7);
    const early = new Set(Array.from({ length: 200 }, () => pickVehicle(rng, 0).kind));
    assert.deepEqual([...early], ['car']);
    const late = new Set(Array.from({ length: 200 }, () => pickVehicle(rng, 5000).kind));
    assert.equal(late.size, VEHICLES.length);
  });

  test('rectsOverlap ignores touching edges', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    assert.equal(rectsOverlap(a, { x: 5, y: 5, w: 10, h: 10 }), true);
    assert.equal(rectsOverlap(a, { x: 10, y: 0, w: 10, h: 10 }), false);
  });
});
