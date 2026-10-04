import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  availableDishes,
  findDish,
  cookSuccessZone,
  isCookSuccess,
  cookSweepSpeed,
  customerArrivalIntervalSeconds,
  jitteredArrivalIntervalSeconds,
  ARRIVAL_INTERVAL_JITTER_MIN,
  ARRIVAL_INTERVAL_JITTER_MAX,
  customerPatienceSeconds,
  tableCapacity,
  shiftPaycheck,
  monthTotal,
  isKarenShift,
  karenEncounter,
  KAREN_SHIFT_NUMBERS,
  KAREN_LINE,
  KAREN_REMATCH_LINE,
  KAREN_PATIENCE_SECONDS,
  KAREN_TIP_GARD,
  inGameTimeLabel,
  SHIFT_PAYCHECK_FULL,
  SHIFT_PAYCHECK_PENALTY_PER_MISTAKE,
  SHIFT_PAYCHECK_MIN,
  COUNTER_PAYMENT_GARD,
  SHIFT_CLOCK_SECONDS,
  PHYSICAL_TABLE_COUNT,
  RECIPE_BANDS,
  FRIDGE_INGREDIENTS,
  CABINET_INGREDIENTS,
  COOKWARE_ITEMS,
  KAREN_SHIFT_NUMBER,
  MEL_DISH,
  MEL_PATIENCE_BONUS_SECONDS,
  COUPLE_DISH,
  clampSanity,
  walkSpeedMultiplierForSanity,
  SANITY_MAX,
  REPUTATION_MAX,
  REPUTATION_DRAIN_PER_MISTAKE,
  clampReputation,
  patienceMultiplierForReputation,
  CUSTOMER_SANITY_MAX,
  CUSTOMER_SANITY_DRAIN_PER_ANNOYANCE,
  clampCustomerSanity,
  SHIFTS_PER_MONTH,
  ROUND_TIER_COUNT,
  ROUND_TIER_SHIFT_SPAN,
  ROUND_TIER_CLOCK_SECONDS,
  TABLES_PER_FLOOR_LEVEL,
  roundTier,
  roundTierStars,
  shiftClockSecondsForShift,
  tableUnlockLevelForShift,
  unlockedTableCountForShift,
  baseCapacityForShift,
} from './rules.js';

describe('RECIPE_BANDS ingredient and cookware names', () => {
  test('every dish ingredient resolves to a real Fridge or Cabinet item', () => {
    const known = new Set([...FRIDGE_INGREDIENTS, ...CABINET_INGREDIENTS]);
    for (const band of RECIPE_BANDS) {
      for (const dish of band.dishes) {
        for (const ingredient of dish.ingredients) {
          assert.ok(known.has(ingredient), `${dish.name}'s "${ingredient}" isn't in FRIDGE_INGREDIENTS or CABINET_INGREDIENTS`);
        }
      }
    }
  });

  test('every non-null dish cookware resolves to a real Cookware Closet item', () => {
    for (const band of RECIPE_BANDS) {
      for (const dish of band.dishes) {
        if (dish.cookware === null) continue;
        assert.ok(COOKWARE_ITEMS.includes(dish.cookware), `${dish.name}'s "${dish.cookware}" isn't in COOKWARE_ITEMS`);
      }
    }
  });

  test('a station-less dish (Garden Salad) requires no cookware', () => {
    const dish = findDish('Garden Salad');
    assert.equal(dish.station, 'none');
    assert.equal(dish.cookware, null);
  });

  test('every stove dish requires a Pan, every oven dish a Baking Tray, and every rice-station dish a Rice Cooker', () => {
    for (const band of RECIPE_BANDS) {
      for (const dish of band.dishes) {
        if (dish.station === 'stove') assert.equal(dish.cookware, 'Pan', `${dish.name} should need a Pan`);
        if (dish.station === 'oven') assert.equal(dish.cookware, 'Baking Tray', `${dish.name} should need a Baking Tray`);
        if (dish.station === 'rice-station') assert.equal(dish.cookware, 'Rice Cooker', `${dish.name} should need a Rice Cooker`);
      }
    }
  });

  test('every COOKWARE_ITEMS entry is required by at least one dish (the Rice Cooker is no longer flavor-only)', () => {
    const required = new Set(RECIPE_BANDS.flatMap((band) => band.dishes.map((d) => d.cookware)).filter(Boolean));
    for (const item of COOKWARE_ITEMS) assert.ok(required.has(item), `${item} is never required`);
  });
});

describe('availableDishes', () => {
  test('shift 1 only unlocks the first band', () => {
    const names = availableDishes(1).map((d) => d.name);
    assert.deepEqual(names.sort(), ['Garden Salad', 'Grilled Cheese']);
  });

  test('bands only ever accumulate as shift increases', () => {
    const shift5 = availableDishes(5).map((d) => d.name);
    const shift6 = availableDishes(6).map((d) => d.name);
    for (const name of shift5) {
      assert.ok(shift6.includes(name), `${name} dropped out of the pool at shift 6`);
    }
    assert.ok(shift6.length > shift5.length);
  });

  test('shift 20 unlocks every band', () => {
    const names = availableDishes(20).map((d) => d.name);
    assert.equal(names.length, RECIPE_BANDS.reduce((n, band) => n + band.dishes.length, 0));
  });

  test('out-of-range/non-finite input clamps into [1, 20]', () => {
    assert.deepEqual(availableDishes(0), availableDishes(1));
    assert.deepEqual(availableDishes(-5), availableDishes(1));
    assert.deepEqual(availableDishes(999), availableDishes(20));
    assert.deepEqual(availableDishes(NaN), availableDishes(1));
  });
});

describe('findDish', () => {
  test('returns the correct ingredient list and station for a known dish', () => {
    const dish = findDish('Burger');
    assert.equal(dish.station, 'stove');
    assert.deepEqual(dish.ingredients, ['Buns', 'Patty', 'Lettuce']);
  });

  test('returns null for an unknown dish', () => {
    assert.equal(findDish('Nonexistent Dish'), null);
  });
});

describe('cookSuccessZone / isCookSuccess', () => {
  test('zone is centered at 0.5', () => {
    const zone = cookSuccessZone(0);
    assert.equal((zone.start + zone.end) / 2, 0.5);
  });

  test('a sample squarely in the zone succeeds', () => {
    const zone = cookSuccessZone(0);
    assert.ok(isCookSuccess(0.5, zone));
  });

  test('a sample outside the zone (both sides) fails', () => {
    const zone = cookSuccessZone(0);
    assert.ok(!isCookSuccess(zone.start - 0.01, zone));
    assert.ok(!isCookSuccess(zone.end + 0.01, zone));
  });

  test('Sharp Knife level widens the zone monotonically', () => {
    const widths = [0, 1, 2, 3].map((level) => cookSuccessZone(level).width);
    for (let i = 1; i < widths.length; i++) {
      assert.ok(widths[i] > widths[i - 1], `width did not increase from level ${i - 1} to ${i}`);
    }
  });

  test('zone width never exceeds the documented max', () => {
    const zone = cookSuccessZone(100);
    assert.ok(zone.width <= 0.4);
  });
});

describe('cookSweepSpeed', () => {
  test('increases with shift number', () => {
    assert.ok(cookSweepSpeed(20) > cookSweepSpeed(1));
  });

  test('never exceeds the documented max', () => {
    assert.ok(cookSweepSpeed(20) <= 1.6);
  });
});

describe('customerArrivalIntervalSeconds', () => {
  test('decreases (busier) as shift number increases', () => {
    assert.ok(customerArrivalIntervalSeconds(20) < customerArrivalIntervalSeconds(1));
  });

  test('never goes below the documented floor', () => {
    assert.ok(customerArrivalIntervalSeconds(20) >= 5);
  });
});

describe('jitteredArrivalIntervalSeconds', () => {
  test('a roll of 0 returns exactly the minimum jitter factor applied', () => {
    assert.equal(jitteredArrivalIntervalSeconds(10, 0), 10 * ARRIVAL_INTERVAL_JITTER_MIN);
  });

  test('a roll just under 1 returns just under the maximum jitter factor applied', () => {
    const result = jitteredArrivalIntervalSeconds(10, 0.999999);
    assert.ok(result < 10 * ARRIVAL_INTERVAL_JITTER_MAX);
    assert.ok(result > 10 * ARRIVAL_INTERVAL_JITTER_MAX - 0.01);
  });

  test('a mid-range roll lands between the min and max factors', () => {
    const result = jitteredArrivalIntervalSeconds(10, 0.5);
    assert.ok(result > 10 * ARRIVAL_INTERVAL_JITTER_MIN);
    assert.ok(result < 10 * ARRIVAL_INTERVAL_JITTER_MAX);
  });

  test('scales down alongside a smaller base interval — jitter is multiplicative, not a fixed offset', () => {
    const wide = jitteredArrivalIntervalSeconds(14, 1);
    const narrow = jitteredArrivalIntervalSeconds(5, 1);
    assert.ok(wide - 14 * ARRIVAL_INTERVAL_JITTER_MIN > narrow - 5 * ARRIVAL_INTERVAL_JITTER_MIN);
  });

  test('an out-of-range or non-finite roll is clamped/defaulted rather than throwing or escaping the jitter bounds', () => {
    assert.ok(jitteredArrivalIntervalSeconds(10, -5) >= 10 * ARRIVAL_INTERVAL_JITTER_MIN);
    assert.ok(jitteredArrivalIntervalSeconds(10, 5) <= 10 * ARRIVAL_INTERVAL_JITTER_MAX);
    assert.equal(jitteredArrivalIntervalSeconds(10, NaN), 10 * (ARRIVAL_INTERVAL_JITTER_MIN + ARRIVAL_INTERVAL_JITTER_MAX) / 2);
  });

  test('a non-positive base interval returns 0, never negative', () => {
    assert.equal(jitteredArrivalIntervalSeconds(-5, 0.5), 0);
  });
});

describe('customerPatienceSeconds', () => {
  test('decreases as shift number increases, at gear level 0', () => {
    assert.ok(customerPatienceSeconds(20, 0) < customerPatienceSeconds(1, 0));
  });

  test('increases with Regular\'s Patience gear level', () => {
    assert.ok(customerPatienceSeconds(10, 3) > customerPatienceSeconds(10, 0));
  });
});

describe('tableCapacity', () => {
  test('tier 3 (shift 21+) reproduces the pre-v3.13 numbers exactly, for every gear level', () => {
    // Regression guard: base 5 + 3/gear-level, capped at the physical 30,
    // same shape the original flat tableCapacity(gearLevel) had.
    for (let gearLevel = 0; gearLevel <= 8; gearLevel++) {
      assert.equal(tableCapacity(30, gearLevel), Math.min(PHYSICAL_TABLE_COUNT, 5 + gearLevel * 3));
    }
    assert.equal(tableCapacity(999, 99), PHYSICAL_TABLE_COUNT);
  });

  test('shift 1 with no gear caps at exactly 1', () => {
    assert.equal(tableCapacity(1, 0), 1);
  });

  test('gear can still raise a tier-1 shift\'s capacity, but never past that tier\'s unlocked table count', () => {
    // Tier 1 has 6 tables open; gear can use more of them sooner, but
    // can't reach a 7th table that doesn't exist yet.
    assert.equal(tableCapacity(1, 1), 4); // base 1 + 3
    assert.equal(tableCapacity(1, 2), 6); // base 1 + 6, capped at 6 open tables
    assert.equal(tableCapacity(1, 99), 6); // huge gear still capped at 6
  });

  test('capacity increases with shift number even at zero gear', () => {
    assert.ok(tableCapacity(11, 0) > tableCapacity(1, 0));
    assert.ok(tableCapacity(21, 0) > tableCapacity(11, 0));
  });

  test('never exceeds the physical table count regardless of shift or gear', () => {
    assert.equal(tableCapacity(999, 99), PHYSICAL_TABLE_COUNT);
  });
});

describe('roundTier', () => {
  test('shift 1 is tier 1', () => {
    assert.equal(roundTier(1), 1);
  });

  test('correct tier at every band boundary', () => {
    assert.equal(roundTier(ROUND_TIER_SHIFT_SPAN), 1);
    assert.equal(roundTier(ROUND_TIER_SHIFT_SPAN + 1), 2);
    assert.equal(roundTier(ROUND_TIER_SHIFT_SPAN * 2), 2);
    assert.equal(roundTier(ROUND_TIER_SHIFT_SPAN * 2 + 1), 3);
    assert.equal(roundTier(SHIFTS_PER_MONTH), ROUND_TIER_COUNT);
  });

  test('never exceeds ROUND_TIER_COUNT, however large the shift number', () => {
    assert.equal(roundTier(1000), ROUND_TIER_COUNT);
  });

  test('is monotonically non-decreasing across the whole month', () => {
    let previous = roundTier(1);
    for (let shift = 2; shift <= SHIFTS_PER_MONTH; shift++) {
      const tier = roundTier(shift);
      assert.ok(tier >= previous);
      previous = tier;
    }
  });

  test('treats a non-positive or non-finite shift number as shift 1', () => {
    assert.equal(roundTier(0), 1);
    assert.equal(roundTier(-5), 1);
    assert.equal(roundTier(NaN), 1);
    assert.equal(roundTier(undefined), 1);
  });
});

describe('roundTierStars', () => {
  test('is all-filled at max tier and all-empty-but-one at tier 1', () => {
    assert.equal(roundTierStars(1), '★☆☆');
    assert.equal(roundTierStars(ROUND_TIER_COUNT), '★★★');
  });

  test('is always ROUND_TIER_COUNT characters long', () => {
    for (let tier = 1; tier <= ROUND_TIER_COUNT; tier++) {
      assert.equal(roundTierStars(tier).length, ROUND_TIER_COUNT);
    }
  });

  test('clamps out-of-range or non-finite input into [1, ROUND_TIER_COUNT]', () => {
    assert.equal(roundTierStars(0), '★☆☆');
    assert.equal(roundTierStars(99), '★★★');
    assert.equal(roundTierStars(NaN), '★☆☆');
  });
});

describe('shiftClockSecondsForShift', () => {
  test('matches ROUND_TIER_CLOCK_SECONDS at the start of each tier', () => {
    assert.equal(shiftClockSecondsForShift(1), ROUND_TIER_CLOCK_SECONDS[0]);
    assert.equal(shiftClockSecondsForShift(ROUND_TIER_SHIFT_SPAN + 1), ROUND_TIER_CLOCK_SECONDS[1]);
    assert.equal(shiftClockSecondsForShift(ROUND_TIER_SHIFT_SPAN * 2 + 1), ROUND_TIER_CLOCK_SECONDS[2]);
  });

  test('shrinks (or stays equal) as the shift number increases — never gets easier', () => {
    let previous = shiftClockSecondsForShift(1);
    for (let shift = 2; shift <= SHIFTS_PER_MONTH; shift++) {
      const seconds = shiftClockSecondsForShift(shift);
      assert.ok(seconds <= previous);
      previous = seconds;
    }
  });
});

describe('tableUnlockLevelForShift / unlockedTableCountForShift', () => {
  test('tier 1 opens exactly TABLES_PER_FLOOR_LEVEL tables, tier 3 opens all of them', () => {
    assert.equal(unlockedTableCountForShift(1), TABLES_PER_FLOOR_LEVEL);
    assert.equal(unlockedTableCountForShift(SHIFTS_PER_MONTH), PHYSICAL_TABLE_COUNT);
  });

  test('grows monotonically across the month and never exceeds the physical count', () => {
    let previous = unlockedTableCountForShift(1);
    for (let shift = 2; shift <= SHIFTS_PER_MONTH; shift++) {
      const count = unlockedTableCountForShift(shift);
      assert.ok(count >= previous);
      assert.ok(count <= PHYSICAL_TABLE_COUNT);
      previous = count;
    }
  });
});

describe('baseCapacityForShift', () => {
  test('grows monotonically across the month and never exceeds ROUND_TIER_FLOOR_LEVEL\'s max', () => {
    let previous = baseCapacityForShift(1);
    for (let shift = 2; shift <= SHIFTS_PER_MONTH; shift++) {
      const capacity = baseCapacityForShift(shift);
      assert.ok(capacity >= previous);
      previous = capacity;
    }
    assert.equal(baseCapacityForShift(SHIFTS_PER_MONTH), 5);
  });

  test('is exactly 1 at shift 1 — literally one table at a time', () => {
    assert.equal(baseCapacityForShift(1), 1);
  });
});

describe('shiftPaycheck', () => {
  test('pays the full amount when there were no mistakes', () => {
    assert.equal(shiftPaycheck(0), SHIFT_PAYCHECK_FULL);
  });

  test('deducts SHIFT_PAYCHECK_PENALTY_PER_MISTAKE for each mistake', () => {
    assert.equal(shiftPaycheck(1), SHIFT_PAYCHECK_FULL - SHIFT_PAYCHECK_PENALTY_PER_MISTAKE);
    assert.equal(shiftPaycheck(3), SHIFT_PAYCHECK_FULL - 3 * SHIFT_PAYCHECK_PENALTY_PER_MISTAKE);
  });

  test('never pays less than SHIFT_PAYCHECK_MIN, however many mistakes', () => {
    assert.equal(shiftPaycheck(50), SHIFT_PAYCHECK_MIN);
  });

  test('treats a negative or non-finite mistake count as 0', () => {
    assert.equal(shiftPaycheck(-3), SHIFT_PAYCHECK_FULL);
    assert.equal(shiftPaycheck(NaN), SHIFT_PAYCHECK_FULL);
    assert.equal(shiftPaycheck(undefined), SHIFT_PAYCHECK_FULL);
  });
});

describe('COUNTER_PAYMENT_GARD', () => {
  test('is a small, positive amount — additive on top of shiftPaycheck, not a replacement for it', () => {
    assert.ok(COUNTER_PAYMENT_GARD > 0);
    assert.ok(COUNTER_PAYMENT_GARD < SHIFT_PAYCHECK_MIN);
  });
});

describe('monthTotal', () => {
  test('sums a full month of clean-shift paychecks', () => {
    const paychecks = Array(20).fill(SHIFT_PAYCHECK_FULL);
    assert.equal(monthTotal(paychecks), 20 * SHIFT_PAYCHECK_FULL);
  });

  test('mixes clean and mistake-penalized shifts correctly', () => {
    const oneMistake = shiftPaycheck(1);
    const paychecks = [SHIFT_PAYCHECK_FULL, oneMistake, SHIFT_PAYCHECK_FULL];
    assert.equal(monthTotal(paychecks), SHIFT_PAYCHECK_FULL * 2 + oneMistake);
  });
});

describe('clampReputation', () => {
  test('leaves an in-range value unchanged', () => {
    assert.equal(clampReputation(50), 50);
  });

  test('clamps above REPUTATION_MAX down to it', () => {
    assert.equal(clampReputation(REPUTATION_MAX + 10), REPUTATION_MAX);
  });

  test('clamps below 0 up to it', () => {
    assert.equal(clampReputation(-10), 0);
  });

  test('treats a non-finite value as 0', () => {
    assert.equal(clampReputation(NaN), 0);
  });
});

describe('patienceMultiplierForReputation', () => {
  test('is 1.0 at full reputation', () => {
    assert.equal(patienceMultiplierForReputation(REPUTATION_MAX), 1);
  });

  test('is below 1.0 and above the floor at partial reputation', () => {
    const mult = patienceMultiplierForReputation(REPUTATION_MAX / 2);
    assert.ok(mult < 1 && mult > 0.6);
  });

  test('bottoms out at the documented floor at 0 reputation', () => {
    assert.equal(patienceMultiplierForReputation(0), 0.6);
  });

  test('four mistakes worth of drain reaches the floor', () => {
    const reputation = clampReputation(REPUTATION_MAX - 4 * REPUTATION_DRAIN_PER_MISTAKE);
    assert.equal(patienceMultiplierForReputation(reputation), 0.6);
  });
});

describe('clampCustomerSanity', () => {
  test('clamps into [0, CUSTOMER_SANITY_MAX]', () => {
    assert.equal(clampCustomerSanity(-10), 0);
    assert.equal(clampCustomerSanity(CUSTOMER_SANITY_MAX + 10), CUSTOMER_SANITY_MAX);
    assert.equal(clampCustomerSanity(50), 50);
  });

  test('non-finite input clamps to 0', () => {
    assert.equal(clampCustomerSanity(NaN), 0);
    assert.equal(clampCustomerSanity(undefined), 0);
  });

  test('four annoyances worth of drain bottoms it out exactly at 0', () => {
    assert.equal(clampCustomerSanity(CUSTOMER_SANITY_MAX - 4 * CUSTOMER_SANITY_DRAIN_PER_ANNOYANCE), 0);
  });
});

describe('isKarenShift', () => {
  test('true only on shifts 12 and 18', () => {
    assert.deepEqual(KAREN_SHIFT_NUMBERS, [12, 18]);
    for (let shift = 1; shift <= 30; shift++) {
      assert.equal(isKarenShift(shift), shift === 12 || shift === 18, `shift ${shift}`);
    }
  });

  test('out-of-range/non-finite input clamps before comparing', () => {
    assert.equal(isKarenShift(999), false); // clamps to 30
    assert.equal(isKarenShift(NaN), false); // clamps to 1
  });
});

describe('karenEncounter', () => {
  test('null on a non-Karen shift', () => {
    assert.equal(karenEncounter(1), null);
    assert.equal(karenEncounter(13), null);
  });

  test('shift 12 is the original encounter', () => {
    assert.deepEqual(karenEncounter(12), {
      rematch: false, line: KAREN_LINE, patienceSeconds: KAREN_PATIENCE_SECONDS, tipGard: KAREN_TIP_GARD,
    });
  });

  test('shift 18 is an angrier rematch: shorter patience, a new line, a bigger tip', () => {
    const first = karenEncounter(12);
    const rematch = karenEncounter(18);
    assert.equal(rematch.rematch, true);
    assert.equal(rematch.line, KAREN_REMATCH_LINE);
    assert.ok(rematch.patienceSeconds < first.patienceSeconds);
    assert.ok(rematch.tipGard > first.tipGard);
  });
});

describe('inGameTimeLabel', () => {
  test('a full clock (shift just started) reads 8:30 AM', () => {
    assert.equal(inGameTimeLabel(SHIFT_CLOCK_SECONDS), '8:30 AM');
  });

  test('a zeroed clock (shift just ended) reads 11:30 PM', () => {
    assert.equal(inGameTimeLabel(0), '11:30 PM');
  });

  test('halfway through the clock reads halfway through the shift day', () => {
    assert.equal(inGameTimeLabel(SHIFT_CLOCK_SECONDS / 2), '4:00 PM');
  });

  test('noon crossover renders as 12 PM, not 0 PM', () => {
    // 12:00 PM is 3.5 hours after 8:30 AM, i.e. 3.5/15 of the way through the clock.
    const fraction = 3.5 / 15;
    const remaining = SHIFT_CLOCK_SECONDS * (1 - fraction);
    assert.equal(inGameTimeLabel(remaining), '12:00 PM');
  });

  test('out-of-range/non-finite input clamps rather than producing a nonsense time', () => {
    assert.equal(inGameTimeLabel(-5), '11:30 PM');
    assert.equal(inGameTimeLabel(SHIFT_CLOCK_SECONDS + 100), '8:30 AM');
    assert.equal(inGameTimeLabel(NaN), '8:30 AM');
  });

  test('honors an explicit totalClockSeconds (v3.14: varies by round tier)', () => {
    const total = ROUND_TIER_CLOCK_SECONDS[0]; // Tier 1's 300s, not the legacy 90s default
    assert.equal(inGameTimeLabel(total, total), '8:30 AM');
    assert.equal(inGameTimeLabel(0, total), '11:30 PM');
    assert.equal(inGameTimeLabel(total / 2, total), '4:00 PM');
  });
});

describe('MEL_DISH', () => {
  test('every ingredient resolves to a real Fridge or Cabinet item', () => {
    const known = new Set([...FRIDGE_INGREDIENTS, ...CABINET_INGREDIENTS]);
    for (const ingredient of MEL_DISH.ingredients) {
      assert.ok(known.has(ingredient), `Mel's Usual's "${ingredient}" isn't in FRIDGE_INGREDIENTS or CABINET_INGREDIENTS`);
    }
  });

  test('is Lemonade, Star Cake, and Egg', () => {
    assert.deepEqual(MEL_DISH.ingredients, ['Lemonade', 'Star Cake', 'Egg']);
  });

  test('needs no station or cookware — assembled, not cooked', () => {
    assert.equal(MEL_DISH.station, 'none');
    assert.equal(MEL_DISH.cookware, null);
  });

  test('findDish resolves it by name', () => {
    assert.deepEqual(findDish(MEL_DISH.name), MEL_DISH);
  });

  test('is never part of the normal random-customer dish pool', () => {
    for (let shift = 1; shift <= 20; shift++) {
      const names = availableDishes(shift).map((d) => d.name);
      assert.ok(!names.includes(MEL_DISH.name), `MEL_DISH leaked into availableDishes(${shift})`);
    }
  });

  test('MEL_PATIENCE_BONUS_SECONDS is a positive bonus, not a penalty', () => {
    assert.ok(MEL_PATIENCE_BONUS_SECONDS > 0);
  });
});

describe('COUPLE_DISH', () => {
  test('every ingredient resolves to a real Fridge or Cabinet item', () => {
    const known = new Set([...FRIDGE_INGREDIENTS, ...CABINET_INGREDIENTS]);
    for (const ingredient of COUPLE_DISH.ingredients) {
      assert.ok(known.has(ingredient), `Olive & Oliver's Order's "${ingredient}" isn't in FRIDGE_INGREDIENTS or CABINET_INGREDIENTS`);
    }
  });

  test('is Matcha and Cake', () => {
    assert.deepEqual(COUPLE_DISH.ingredients, ['Matcha', 'Cake']);
  });

  test('needs no station or cookware — assembled, not cooked', () => {
    assert.equal(COUPLE_DISH.station, 'none');
    assert.equal(COUPLE_DISH.cookware, null);
  });

  test('findDish resolves it by name', () => {
    assert.deepEqual(findDish(COUPLE_DISH.name), COUPLE_DISH);
  });

  test('is never part of the normal random-customer dish pool', () => {
    for (let shift = 1; shift <= 20; shift++) {
      const names = availableDishes(shift).map((d) => d.name);
      assert.ok(!names.includes(COUPLE_DISH.name), `COUPLE_DISH leaked into availableDishes(${shift})`);
    }
  });
});

describe('clampSanity', () => {
  test('clamps into [0, SANITY_MAX]', () => {
    assert.equal(clampSanity(-10), 0);
    assert.equal(clampSanity(SANITY_MAX + 10), SANITY_MAX);
    assert.equal(clampSanity(50), 50);
  });

  test('non-finite input clamps to 0', () => {
    assert.equal(clampSanity(NaN), 0);
  });
});

describe('walkSpeedMultiplierForSanity', () => {
  test('full sanity is full speed', () => {
    assert.equal(walkSpeedMultiplierForSanity(SANITY_MAX), 1);
  });

  test('zero sanity never fully stops the player', () => {
    const multiplier = walkSpeedMultiplierForSanity(0);
    assert.ok(multiplier > 0);
    assert.ok(multiplier < 1);
  });

  test('decreases monotonically as sanity drops', () => {
    const high = walkSpeedMultiplierForSanity(80);
    const low = walkSpeedMultiplierForSanity(20);
    assert.ok(high > low);
  });

  test('out-of-range/non-finite input clamps before computing', () => {
    assert.equal(walkSpeedMultiplierForSanity(-50), walkSpeedMultiplierForSanity(0));
    assert.equal(walkSpeedMultiplierForSanity(SANITY_MAX + 50), walkSpeedMultiplierForSanity(SANITY_MAX));
  });
});

// ---------------------------------------------------------------------------
// v4 — Coffee Pour, hallucinations, 0-Reputation pay cut
// ---------------------------------------------------------------------------

import {
  coffeePourTargetBand,
  gradeCoffeePour,
  COFFEE_POUR_BAND_WIDTH,
  hallucinationIntensity,
  shakyHandsZoneScale,
  shakyHandsSweepMultiplier,
  shakyCookSuccessZone,
  hallucinationPayMultiplier,
  reputationPayMultiplier,
} from './rules.js';

describe('Coffee Pour', () => {
  test('the target band is COFFEE_POUR_BAND_WIDTH wide and stays inside the cup', () => {
    for (const roll of [0, 0.5, 1, -3, 9, NaN]) {
      const band = coffeePourTargetBand(roll);
      assert.ok(Math.abs(band.max - band.min - COFFEE_POUR_BAND_WIDTH) < 1e-9);
      assert.ok(band.min > 0 && band.max < 1);
    }
  });

  test('grades: in band perfect, near it good, far sloppy, brim spilled', () => {
    const band = { min: 0.7, max: 0.82 };
    assert.equal(gradeCoffeePour(0.75, band), 'perfect');
    assert.equal(gradeCoffeePour(0.65, band), 'good');
    assert.equal(gradeCoffeePour(0.9, band), 'good');
    assert.equal(gradeCoffeePour(0.3, band), 'sloppy');
    assert.equal(gradeCoffeePour(1, band), 'spilled');
  });
});

describe('hallucinations', () => {
  test('intensity is 0 at 25+ Sanity and 1 at 0', () => {
    assert.equal(hallucinationIntensity(100), 0);
    assert.equal(hallucinationIntensity(25), 0);
    assert.equal(hallucinationIntensity(12.5), 0.5);
    assert.equal(hallucinationIntensity(0), 1);
  });

  test('shaky hands: the cook zone halves and the sweep is 1.6x at full intensity', () => {
    assert.equal(shakyHandsZoneScale(0), 1);
    assert.equal(shakyHandsZoneScale(1), 0.5);
    assert.equal(shakyHandsSweepMultiplier(0), 1);
    assert.ok(Math.abs(shakyHandsSweepMultiplier(1) - 1.6) < 1e-9);
    const normal = cookSuccessZone(0);
    const shaky = shakyCookSuccessZone(0, 0.5);
    assert.ok(Math.abs((shaky.end - shaky.start) - (normal.end - normal.start) / 2) < 1e-9);
    assert.equal((shaky.start + shaky.end) / 2, (normal.start + normal.end) / 2);
  });

  test('0-Sanity and 0-Reputation pay cuts: −2% per 10 s, capped at −30%', () => {
    for (const fn of [hallucinationPayMultiplier, reputationPayMultiplier]) {
      assert.equal(fn(0), 1);
      assert.equal(fn(9.9), 1);
      assert.ok(Math.abs(fn(10) - 0.98) < 1e-9);
      assert.ok(Math.abs(fn(1000) - 0.7) < 1e-9);
      assert.equal(fn(NaN), 1);
    }
  });
});
