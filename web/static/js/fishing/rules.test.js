import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  streakMultiplier,
  fishSpawnPool,
  descentSpeed,
  roundTokens,
  STREAK_MULTIPLIER_BASE,
  STREAK_MULTIPLIER_MAX,
  DEPTH_CAP_MILES,
} from './rules.js';

describe('streakMultiplier', () => {
  test('starts at 1.0x with zero hit-free miles', () => {
    assert.equal(streakMultiplier(0), 1.0);
  });

  test('gains +0.05x per 10 hit-free miles', () => {
    assert.equal(streakMultiplier(10), 1.05);
    assert.equal(streakMultiplier(20), 1.10);
    assert.equal(streakMultiplier(50), 1.25);
  });

  test('does not gain credit for a partial 10-mile step', () => {
    // 19 miles is only one full 10-mile step, not two.
    assert.equal(streakMultiplier(19), 1.05);
    assert.equal(streakMultiplier(9), 1.0);
  });

  test('caps at 2.5x and never exceeds it, even at very large mileage', () => {
    // (2.5 - 1.0) / 0.05 = 30 steps -> 300 miles reaches the cap exactly.
    assert.equal(streakMultiplier(300), 2.5);
    assert.equal(streakMultiplier(301), 2.5);
    assert.equal(streakMultiplier(1_000_000), 2.5);
    assert.ok(streakMultiplier(1_000_000) <= STREAK_MULTIPLIER_MAX);
  });

  test('treats negative or non-finite input as 0 miles (base multiplier)', () => {
    assert.equal(streakMultiplier(-50), STREAK_MULTIPLIER_BASE);
    assert.equal(streakMultiplier(NaN), STREAK_MULTIPLIER_BASE);
    assert.equal(streakMultiplier(undefined), STREAK_MULTIPLIER_BASE);
  });
});

describe('fishSpawnPool', () => {
  test('at depth 0 with no streak bonus, pool is only Sardine/Anchovy', () => {
    const pool = fishSpawnPool(0, 1.0);
    const names = pool.map((f) => f.name).sort();
    assert.deepEqual(names, ['Anchovy', 'Sardine']);
    pool.forEach((f) => assert.ok(f.weight > 0));
  });

  test('within a band, higher streak biases weight toward the higher-point fish', () => {
    const lowStreak = fishSpawnPool(50, 1.0);
    const highStreak = fishSpawnPool(50, 2.5);

    const sardineLow = lowStreak.find((f) => f.name === 'Sardine').weight;
    const anchovyLow = lowStreak.find((f) => f.name === 'Anchovy').weight;
    const sardineHigh = highStreak.find((f) => f.name === 'Sardine').weight;
    const anchovyHigh = highStreak.find((f) => f.name === 'Anchovy').weight;

    // Low tier (Sardine) weight shrinks, high tier (Anchovy) weight grows.
    assert.ok(sardineHigh < sardineLow);
    assert.ok(anchovyHigh > anchovyLow);
    // At no streak bonus, the low-tier fish should still outweigh the high-tier one.
    assert.ok(sardineLow > anchovyLow);
  });

  test('low-tier fish weight never hits zero, even at max streak (no extinction)', () => {
    const pool = fishSpawnPool(50, STREAK_MULTIPLIER_MAX);
    const sardine = pool.find((f) => f.name === 'Sardine');
    assert.ok(sardine.weight > 0);
  });

  test('next band lowest-tier fish previews early at elevated streak', () => {
    // Depth 50 is in the 0-100mi band; Mackerel belongs to the 100-300mi band.
    const noStreak = fishSpawnPool(50, 1.0);
    const highStreak = fishSpawnPool(50, 2.5);

    assert.equal(noStreak.some((f) => f.name === 'Mackerel'), false);
    const mackerel = highStreak.find((f) => f.name === 'Mackerel');
    assert.ok(mackerel);
    assert.ok(mackerel.weight > 0);
    // The higher-point Clownfish of that next band should not appear yet.
    assert.equal(highStreak.some((f) => f.name === 'Clownfish'), false);
  });

  test('preview weight increases monotonically with streak', () => {
    const low = fishSpawnPool(50, 1.2).find((f) => f.name === 'Mackerel');
    const mid = fishSpawnPool(50, 1.8).find((f) => f.name === 'Mackerel');
    const high = fishSpawnPool(50, 2.5).find((f) => f.name === 'Mackerel');
    assert.ok(low.weight < mid.weight);
    assert.ok(mid.weight < high.weight);
  });

  test('band selection matches each documented depth range', () => {
    assert.deepEqual(
      fishSpawnPool(150, 1.0).map((f) => f.name).sort(),
      ['Clownfish', 'Mackerel'],
    );
    assert.deepEqual(
      fishSpawnPool(450, 1.0).map((f) => f.name).sort(),
      ['Swordfish', 'Tuna'],
    );
    assert.deepEqual(
      fishSpawnPool(750, 1.0).map((f) => f.name).sort(),
      ['Anglerfish', 'Giant Squid'],
    );
  });

  test('the 900-1000mi band has only Golden Koi and no next-band preview', () => {
    const pool = fishSpawnPool(950, 2.5);
    assert.equal(pool.length, 1);
    assert.equal(pool[0].name, 'Golden Koi');
    assert.equal(pool[0].rare, true);
    assert.ok(pool[0].weight > 0);
  });

  test('at the exact depth cap (1000mi), still resolves to the Golden Koi band', () => {
    const pool = fishSpawnPool(DEPTH_CAP_MILES, 1.0);
    assert.equal(pool.length, 1);
    assert.equal(pool[0].name, 'Golden Koi');
  });

  test('depth is clamped into [0, 1000]; out-of-range input does not throw', () => {
    assert.doesNotThrow(() => fishSpawnPool(-100, 1.0));
    assert.doesNotThrow(() => fishSpawnPool(5000, 1.0));
    assert.deepEqual(
      fishSpawnPool(-100, 1.0).map((f) => f.name).sort(),
      ['Anchovy', 'Sardine'],
    );
  });

  test('band boundaries are exclusive on the upper edge (except the last band)', () => {
    // Exactly 100 miles should already be in the 100-300mi band.
    assert.deepEqual(
      fishSpawnPool(100, 1.0).map((f) => f.name).sort(),
      ['Clownfish', 'Mackerel'],
    );
  });
});

describe('descentSpeed', () => {
  test('is at its base value at depth 0, elapsed 0', () => {
    assert.equal(descentSpeed(0, 0), 1.0);
  });

  test('increases with depth alone', () => {
    const shallow = descentSpeed(0, 0);
    const deep = descentSpeed(500, 0);
    assert.ok(deep > shallow);
  });

  test('increases with elapsed time alone', () => {
    const early = descentSpeed(0, 0);
    const later = descentSpeed(0, 90);
    assert.ok(later > early);
  });

  test('increases with both depth and time combined', () => {
    const a = descentSpeed(100, 10);
    const b = descentSpeed(400, 90);
    assert.ok(b > a);
  });

  test('caps at its documented maximum and never exceeds it, even at extreme inputs', () => {
    const extreme = descentSpeed(1_000_000, 1_000_000);
    // Mathematically the asymptote is only ever approached, never reached;
    // at very large (but finite) inputs float64 precision can round the
    // true value up to exactly the cap, so the contract we can actually
    // guarantee/test is "never exceeds", not "always strictly less than".
    assert.ok(extreme <= 5.0);
    assert.ok(extreme > 4.9); // should be very close to the max
  });

  test('approaches but never reaches max even at the real depth cap and a long round', () => {
    const atCapLongRound = descentSpeed(DEPTH_CAP_MILES, 600); // 10-minute round
    assert.ok(atCapLongRound < 5.0);
  });

  test('never exceeds max at any combination of large finite inputs', () => {
    const samples = [
      [1000, 3600],
      [1e9, 1e9],
      [1e12, 1],
      [1, 1e12],
    ];
    samples.forEach(([depth, elapsed]) => {
      const speed = descentSpeed(depth, elapsed);
      // See the note above: at float64-extreme inputs the true asymptotic
      // value can round up to exactly the cap; the guaranteed contract is
      // "never exceeds", not "always strictly less than".
      assert.ok(speed <= 5.0, `speed ${speed} exceeded max for depth=${depth}, elapsed=${elapsed}`);
    });
  });

  test('treats negative or non-finite input as 0', () => {
    assert.equal(descentSpeed(-100, -50), 1.0);
    assert.equal(descentSpeed(NaN, NaN), 1.0);
  });
});

describe('roundTokens', () => {
  test('at score=0, depth=0, returns a sane non-negative value', () => {
    const tokens = roundTokens(0, 0);
    assert.equal(tokens, 0);
    assert.ok(tokens >= 0);
  });

  test('converts score to tokens via floor(score / 20)', () => {
    assert.equal(roundTokens(100, 0), 5);
    assert.equal(roundTokens(119, 0), 5); // floors, doesn't round up
    assert.equal(roundTokens(120, 0), 6);
  });

  test('adds a milestone bonus per full 100-mile depth band reached', () => {
    // 250 miles = 2 full 100-mile bands.
    const withoutDepth = roundTokens(0, 0);
    const withDepth = roundTokens(0, 250);
    assert.ok(withDepth > withoutDepth);
    assert.equal(withDepth, withoutDepth + 2 * 5); // 2 bands * MILESTONE_BONUS_PER_BAND(5)
  });

  test('does not award a milestone bonus for a partial band', () => {
    assert.equal(roundTokens(0, 99), 0);
    assert.equal(roundTokens(0, 100), 5);
  });

  test('combines score and depth bonuses for representative pairs', () => {
    // score=300 -> 15 tokens; depth=650 -> 6 full bands -> 30 bonus tokens.
    assert.equal(roundTokens(300, 650), 15 + 30);
    // score=1000 -> 50 tokens; depth=1000 (full run) -> 10 bands -> 50 bonus tokens.
    assert.equal(roundTokens(1000, DEPTH_CAP_MILES), 50 + 50);
  });

  test('depth is clamped to the 1000-mile cap even if a bad value is passed in', () => {
    assert.equal(roundTokens(0, 5000), roundTokens(0, DEPTH_CAP_MILES));
  });

  test('treats negative or non-finite score/depth as 0, never returns negative tokens', () => {
    assert.equal(roundTokens(-500, -100), 0);
    assert.equal(roundTokens(NaN, NaN), 0);
  });

  test('always returns a whole number', () => {
    const tokens = roundTokens(137, 155);
    assert.equal(Number.isInteger(tokens), true);
  });
});
