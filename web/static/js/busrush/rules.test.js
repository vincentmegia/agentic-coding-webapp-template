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
  livesAfterHit,
  WANTED_MAX,
  WRECK_TOKENS,
  POLICE_CAR,
  wantedLevel,
  policeSpeed,
  maxPolice,
  policeReactionSeconds,
  roadblockChance,
  policeWreckPoints,
  LEVELS,
  LEVEL_DISTANCE,
  levelAt,
  checkpointPoints,
  minSpeed,
  FARE_CLEARANCE,
  fareOffset,
  BANANA_DROP_MIN_Y,
  BANANA_DROP_MAX_Y,
  bananaDrops,
  skidLane,
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

  test('wrecked police add score and tokens', () => {
    assert.equal(runScore(100, 0, 150), 250);
    assert.equal(runTokens(0, 0, 0, 3), 3 * WRECK_TOKENS);
    assert.equal(runScore(100, 0, -50), 100);
  });
});

describe('police pursuit', () => {
  test('wanted level starts at one star, rises with distance and fares, caps', () => {
    assert.equal(wantedLevel(0, 0), 1);
    assert.ok(wantedLevel(1200, 0) > wantedLevel(0, 0));
    assert.ok(wantedLevel(0, 10) > wantedLevel(0, 0));
    assert.equal(wantedLevel(1e7, 1e7), WANTED_MAX);
    assert.equal(wantedLevel(NaN, -3), 1);
  });

  test('more stars mean faster, more numerous, quicker-reacting police', () => {
    for (let w = 2; w <= WANTED_MAX; w++) {
      assert.ok(policeSpeed(w) > policeSpeed(w - 1));
      assert.ok(maxPolice(w) >= maxPolice(w - 1));
      assert.ok(policeReactionSeconds(w) < policeReactionSeconds(w - 1));
      assert.ok(policeWreckPoints(w) > policeWreckPoints(w - 1));
    }
    assert.ok(policeReactionSeconds(WANTED_MAX) > 0);
  });

  test('a stock bus at full throttle outruns police at any star, in any level', () => {
    for (let lvl = 0; lvl < LEVELS.length; lvl++) {
      for (let w = 1; w <= WANTED_MAX; w++) {
        assert.ok(policeSpeed(w, lvl) < maxSpeed(0, lvl), `stock bus outruns ${w}★ in level ${lvl + 1}`);
        assert.ok(policeSpeed(w, lvl) > minSpeed(lvl), `${w}★ catches a bus at the floor in level ${lvl + 1}`);
      }
    }
  });

  test('roadblocks need distance and heat', () => {
    assert.equal(roadblockChance(100, WANTED_MAX), 0);
    assert.equal(roadblockChance(5000, 1), 0);
    assert.ok(roadblockChance(5000, WANTED_MAX) > 0 && roadblockChance(5000, WANTED_MAX) < 0.5);
  });

  test('police cars are lethal and fit the row spacing', () => {
    assert.equal(livesAfterHit(3, POLICE_CAR, 0), 0);
    assert.equal(livesAfterHit(3, POLICE_CAR, 1), 0);
    assert.ok(POLICE_CAR.length <= Math.max(...VEHICLES.map((v) => v.length)));
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
    const topRelativePxPerSec = (maxSpeed(UPGRADES.engine.maxLevel, LEVELS.length - 1) + TRAFFIC_SPEED) * PX_PER_METER;
    const windowSeconds = (ROW_SPACING_MIN - longest - BUS_LENGTH) / topRelativePxPerSec;
    assert.ok(windowSeconds >= laneChangeSeconds(0), `window ${windowSeconds}s`);
  });

  test('fares never overlap the vehicle in their lane or the next row', () => {
    const radius = 13;
    // The next row's spacing can be a little tighter (spacing shrinks with
    // distance): allow for the distance covered between two rows.
    const shrink = 6;
    for (let spacing = ROW_SPACING_MIN; spacing <= ROW_SPACING_MAX; spacing += 5) {
      for (const len of [0, ...VEHICLES.map((v) => v.length)]) {
        const y = fareOffset(spacing, len, radius);
        assert.ok(y + radius <= -len - FARE_CLEARANCE, `clear of a ${len}px tail at spacing ${spacing}`);
        assert.ok(y - radius >= -(spacing - shrink) + FARE_CLEARANCE / 2, `clear of the next row at spacing ${spacing}`);
      }
    }
  });

  test('bigger vehicles unlock with distance', () => {
    const rng = seeded(7);
    const early = new Set(Array.from({ length: 200 }, () => pickVehicle(rng, 0).kind));
    assert.deepEqual([...early], ['car']);
    const late = new Set(Array.from({ length: 200 }, () => pickVehicle(rng, 5000).kind));
    assert.equal(late.size, VEHICLES.length);
  });

  test('trucks and semis are lethal; cars and vans are not', () => {
    const lethal = VEHICLES.filter((v) => v.lethal).map((v) => v.kind).sort();
    assert.deepEqual(lethal, ['semi', 'truck']);
  });

  test('a lethal hit takes every life, even during grace', () => {
    const truck = VEHICLES.find((v) => v.kind === 'truck');
    const semi = VEHICLES.find((v) => v.kind === 'semi');
    assert.equal(livesAfterHit(6, truck, 0), 0);
    assert.equal(livesAfterHit(6, semi, 1.2), 0);
  });

  test('a non-lethal hit takes one life, none during grace', () => {
    const car = VEHICLES.find((v) => v.kind === 'car');
    assert.equal(livesAfterHit(3, car, 0), 2);
    assert.equal(livesAfterHit(3, car, 0.5), 3);
    assert.equal(livesAfterHit(0, car, 0), 0);
  });

  test('rectsOverlap ignores touching edges', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    assert.equal(rectsOverlap(a, { x: 5, y: 5, w: 10, h: 10 }), true);
    assert.equal(rectsOverlap(a, { x: 10, y: 0, w: 10, h: 10 }), false);
  });
});

describe('levels', () => {
  test('a run moves through every district in order, the last one endless', () => {
    assert.equal(levelAt(0), 0);
    assert.equal(levelAt(LEVEL_DISTANCE - 1), 0);
    assert.equal(levelAt(LEVEL_DISTANCE), 1);
    assert.equal(levelAt(LEVEL_DISTANCE * 99), LEVELS.length - 1);
    assert.equal(levelAt(NaN), 0);
  });

  test('each district starts one wanted star hotter', () => {
    for (let i = 1; i < LEVELS.length; i++) {
      assert.equal(wantedLevel(i * LEVEL_DISTANCE, 0), Math.min(WANTED_MAX, i + 1));
    }
  });

  test('each district is faster: higher speed floor and top speed', () => {
    for (let i = 1; i < LEVELS.length; i++) {
      assert.ok(minSpeed(i) > minSpeed(i - 1));
      assert.ok(maxSpeed(0, i) > maxSpeed(0, i - 1));
      assert.equal(stepSpeed(0, {}, 0.1, 0, i), minSpeed(i));
    }
    assert.equal(minSpeed(99), minSpeed(LEVELS.length - 1));
    assert.equal(maxSpeed(0, 99), maxSpeed(0, LEVELS.length - 1));
    assert.ok(minSpeed(LEVELS.length - 1) < BASE_MAX_SPEED);
  });

  test('checkpoints pay more the deeper the district', () => {
    assert.equal(checkpointPoints(0), 0);
    assert.ok(checkpointPoints(2) > checkpointPoints(1));
  });
});

describe('bananas', () => {
  test('only trucks and semis drop bananas, 1–2 of them, inside the drop window', () => {
    const rng = seeded(3);
    for (const v of VEHICLES) {
      for (let i = 0; i < 200; i++) {
        const drops = bananaDrops(rng, v);
        if (!v.lethal) {
          assert.deepEqual(drops, [], `${v.kind} never drops`);
          continue;
        }
        assert.ok(drops.length <= 2);
        drops.forEach((y) => assert.ok(y >= BANANA_DROP_MIN_Y && y <= BANANA_DROP_MAX_Y));
        assert.deepEqual(drops, [...drops].sort((a, b) => a - b));
      }
    }
    assert.deepEqual(bananaDrops(rng, POLICE_CAR), []);
    // Some trucks are leaky and some aren't.
    const truck = VEHICLES.find((v) => v.kind === 'truck');
    const counts = Array.from({ length: 200 }, () => bananaDrops(rng, truck).length);
    assert.ok(counts.includes(0) && counts.some((c) => c > 0));
  });

  test('a skid always throws the bus exactly one lane, and never off the road', () => {
    const rng = seeded(9);
    for (let lane = 0; lane < LANES; lane++) {
      for (let i = 0; i < 50; i++) {
        const next = skidLane(lane, rng);
        assert.equal(Math.abs(next - lane), 1);
        assert.ok(next >= 0 && next < LANES);
      }
    }
  });
});
