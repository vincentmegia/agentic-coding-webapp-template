import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  moodPayMultiplier,
  hallucinationIntensity,
  shakyHandsZoneScale,
  shakyHandsSweepMultiplier,
  hallucinationPayMultiplier,
  HALLUCINATION_START_SANITY,
  clampRating,
  paycheckMultiplierForRating,
  queueWaitSecondsForShift,
  finesStartShiftForSeed,
  FINES_START_SHIFT_MIN,
  FINES_START_SHIFT_MAX,
  TILL_DENOMINATIONS,
  tillCountResult,
  coffeePourTargetBand,
  gradeCoffeePour,
  COFFEE_POUR_BAND_WIDTH,
  COFFEE_POUR_GOOD_MARGIN,
  COFFEE_SANITY_RESTORE,
  SHIFTS_PER_MONTH,
  ROUND_TIER_COUNT,
  ROUND_TIER_SHIFT_SPAN,
  ROUND_TIER_CLOCK_SECONDS,
  ROUND_TIER_RETURN_VOLUME,
  ROUND_TIER_FINE_VOLUME,
  ROUND_TIER_BORROW_VOLUME,
  roundTier,
  shiftClockSecondsForShift,
  returnVolumeForShift,
  fineVolumeForShift,
  borrowVolumeForShift,
  SHIFT_START_MINUTES,
  SHIFT_END_MINUTES,
  inGameTimeLabel,
  KAREN_SHIFT_MIN,
  KAREN_SHIFT_MAX,
  karenShiftForSeed,
  KAREN_EVENT_TIMER_SECONDS,
  KAREN_FINE_AMOUNT_GARD,
  KAREN_MOOD_PENALTY,
  GENRES,
  findGenre,
  COIN_HUNT_FREQUENCY,
  isCoinHuntBook,
  FINE_AMOUNT_MIN_GARD,
  FINE_AMOUNT_MAX_GARD,
  fineAmountForRoll,
  SHIFT_PAYCHECK_FULL,
  SHIFT_PAYCHECK_PENALTY_PER_MISTAKE,
  SHIFT_PAYCHECK_MIN,
  shiftPaycheck,
  monthTotal,
  CLOSING_WAIT_SECONDS,
  SKILL_CHECK_ZONE_WIDTH,
  skillCheckSuccessZone,
  isSkillCheckSuccess,
  skillCheckSweepSpeed,
  borrowPatienceSeconds,
  LIBRARY_MOOD_MAX,
  LIBRARY_MOOD_DRAIN_PER_MISTAKE,
  clampLibraryMood,
  patienceMultiplierForLibraryMood,
  SANITY_MAX,
  SANITY_DRAIN_PER_SECOND,
  SANITY_DRAIN_PER_UPSET,
  clampSanity,
  walkSpeedMultiplierForSanity,
} from './rules.js';

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

  test('treats a non-positive or non-finite shift number as shift 1', () => {
    assert.equal(roundTier(0), 1);
    assert.equal(roundTier(-5), 1);
    assert.equal(roundTier(NaN), 1);
    assert.equal(roundTier(undefined), 1);
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

  test('is paced much slower than Kitchen Shift\'s 300/180/120s tiers, per the doc\'s explicit "not go so fast" requirement', () => {
    assert.deepEqual(ROUND_TIER_CLOCK_SECONDS, [600, 480, 360]);
    for (const seconds of ROUND_TIER_CLOCK_SECONDS) {
      assert.ok(seconds > 120, 'a library tier must stay well above Kitchen Shift\'s fastest tier');
    }
  });
});

describe('returnVolumeForShift / fineVolumeForShift / borrowVolumeForShift', () => {
  test('grow monotonically across the month and match the documented arrays', () => {
    for (const [fn, arr] of [
      [returnVolumeForShift, ROUND_TIER_RETURN_VOLUME],
      [fineVolumeForShift, ROUND_TIER_FINE_VOLUME],
      [borrowVolumeForShift, ROUND_TIER_BORROW_VOLUME],
    ]) {
      assert.equal(fn(1), arr[0]);
      assert.equal(fn(ROUND_TIER_SHIFT_SPAN + 1), arr[1]);
      assert.equal(fn(ROUND_TIER_SHIFT_SPAN * 2 + 1), arr[2]);
      assert.ok(arr[1] >= arr[0]);
      assert.ok(arr[2] >= arr[1]);
    }
  });
});

describe('inGameTimeLabel', () => {
  test('a full clock (shift just started) reads 8:00 AM', () => {
    assert.equal(inGameTimeLabel(ROUND_TIER_CLOCK_SECONDS[0], ROUND_TIER_CLOCK_SECONDS[0]), '8:00 AM');
  });

  test('a zeroed clock (shift just ended) reads 11:00 PM', () => {
    assert.equal(inGameTimeLabel(0, ROUND_TIER_CLOCK_SECONDS[0]), '11:00 PM');
  });

  test('halfway through the clock reads halfway through the 15-hour day', () => {
    const total = ROUND_TIER_CLOCK_SECONDS[0];
    assert.equal(inGameTimeLabel(total / 2, total), '3:30 PM');
  });

  test('honors whichever tier\'s totalClockSeconds is passed', () => {
    const total = ROUND_TIER_CLOCK_SECONDS[2];
    assert.equal(inGameTimeLabel(total, total), '8:00 AM');
    assert.equal(inGameTimeLabel(0, total), '11:00 PM');
  });

  test('out-of-range/non-finite input clamps rather than producing a nonsense time', () => {
    const total = ROUND_TIER_CLOCK_SECONDS[0];
    assert.equal(inGameTimeLabel(-5, total), '11:00 PM');
    assert.equal(inGameTimeLabel(total + 500, total), '8:00 AM');
    assert.equal(inGameTimeLabel(NaN, total), '8:00 AM');
  });

  test('a non-positive/non-finite totalClockSeconds falls back to Tier 1\'s budget', () => {
    assert.equal(inGameTimeLabel(0, 0), inGameTimeLabel(0, ROUND_TIER_CLOCK_SECONDS[0]));
    assert.equal(inGameTimeLabel(0, NaN), inGameTimeLabel(0, ROUND_TIER_CLOCK_SECONDS[0]));
  });

  test('noon crossover renders as 12 PM, not 0 PM', () => {
    const total = ROUND_TIER_CLOCK_SECONDS[0];
    // Noon is 4 hours after 8:00 AM, i.e. 4/15 of the way through the 15-hour day.
    const fraction = 4 / 15;
    const remaining = total * (1 - fraction);
    assert.equal(inGameTimeLabel(remaining, total), '12:00 PM');
  });
});

describe('karenShiftForSeed', () => {
  test('always returns an integer in [KAREN_SHIFT_MIN, KAREN_SHIFT_MAX]', () => {
    for (let seed = 0; seed < 500; seed++) {
      const shift = karenShiftForSeed(seed);
      assert.ok(Number.isInteger(shift));
      assert.ok(shift >= KAREN_SHIFT_MIN && shift <= KAREN_SHIFT_MAX, `seed ${seed} produced out-of-range shift ${shift}`);
    }
  });

  test('is deterministic — the same seed always returns the same shift', () => {
    assert.equal(karenShiftForSeed(12345), karenShiftForSeed(12345));
    assert.equal(karenShiftForSeed(0), karenShiftForSeed(0));
  });

  test('different seeds are likely (not guaranteed, but overwhelmingly likely) to produce different shifts across a large sample', () => {
    const seen = new Set();
    for (let seed = 0; seed < 200; seed++) {
      seen.add(karenShiftForSeed(seed));
    }
    // 6 possible values (10-15); 200 varied seeds should hit every one.
    assert.equal(seen.size, KAREN_SHIFT_MAX - KAREN_SHIFT_MIN + 1);
  });

  test('a non-finite seed does not throw and still returns an in-range value', () => {
    const shift = karenShiftForSeed(NaN);
    assert.ok(shift >= KAREN_SHIFT_MIN && shift <= KAREN_SHIFT_MAX);
  });
});

describe('KAREN_EVENT_TIMER_SECONDS / KAREN_FINE_AMOUNT_GARD / KAREN_MOOD_PENALTY', () => {
  test('are all positive, and her mood penalty exceeds an ordinary mistake\'s drain', () => {
    assert.ok(KAREN_EVENT_TIMER_SECONDS > 0);
    assert.ok(KAREN_FINE_AMOUNT_GARD > 0);
    assert.ok(KAREN_MOOD_PENALTY > LIBRARY_MOOD_DRAIN_PER_MISTAKE);
  });
});

describe('GENRES / findGenre', () => {
  test('has at least the doc\'s example genres, each with a distinct id and color', () => {
    const ids = GENRES.map((g) => g.id);
    assert.equal(new Set(ids).size, ids.length, 'genre ids must be unique');
    const colors = GENRES.map((g) => g.color);
    assert.equal(new Set(colors).size, colors.length, 'genre colors must be unique');
    assert.ok(GENRES.length >= 5);
  });

  test('findGenre resolves a known id', () => {
    const genre = findGenre(GENRES[0].id);
    assert.deepEqual(genre, GENRES[0]);
  });

  test('findGenre returns null for an unknown id', () => {
    assert.equal(findGenre('nonexistent-genre'), null);
  });
});

describe('isCoinHuntBook', () => {
  test('a roll below COIN_HUNT_FREQUENCY is a Coin Hunt book', () => {
    assert.equal(isCoinHuntBook(0), true);
    assert.equal(isCoinHuntBook(COIN_HUNT_FREQUENCY - 0.0001), true);
  });

  test('a roll at or above COIN_HUNT_FREQUENCY is not', () => {
    assert.equal(isCoinHuntBook(COIN_HUNT_FREQUENCY), false);
    assert.equal(isCoinHuntBook(0.999), false);
  });

  test('roughly 1 in 5 across a large uniform sample', () => {
    let count = 0;
    const samples = 10000;
    for (let i = 0; i < samples; i++) {
      if (isCoinHuntBook(i / samples)) count++;
    }
    assert.equal(count, Math.round(samples * COIN_HUNT_FREQUENCY));
  });

  test('an out-of-range or non-finite roll defaults to false rather than throwing', () => {
    assert.equal(isCoinHuntBook(-1), false);
    assert.equal(isCoinHuntBook(NaN), false);
    assert.equal(isCoinHuntBook(undefined), false);
  });
});

describe('fineAmountForRoll', () => {
  test('roll 0 returns the minimum, roll 1 returns the maximum', () => {
    assert.equal(fineAmountForRoll(0), FINE_AMOUNT_MIN_GARD);
    assert.equal(fineAmountForRoll(1), FINE_AMOUNT_MAX_GARD);
  });

  test('a mid-range roll lands between the min and max', () => {
    const amount = fineAmountForRoll(0.5);
    assert.ok(amount >= FINE_AMOUNT_MIN_GARD && amount <= FINE_AMOUNT_MAX_GARD);
  });

  test('out-of-range/non-finite input clamps/defaults rather than escaping the range', () => {
    assert.equal(fineAmountForRoll(-5), FINE_AMOUNT_MIN_GARD);
    assert.equal(fineAmountForRoll(5), FINE_AMOUNT_MAX_GARD);
    const mid = fineAmountForRoll(NaN);
    assert.ok(mid >= FINE_AMOUNT_MIN_GARD && mid <= FINE_AMOUNT_MAX_GARD);
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

describe('monthTotal', () => {
  test('sums a full run of clean-shift payouts', () => {
    const payouts = Array(SHIFTS_PER_MONTH).fill(SHIFT_PAYCHECK_FULL);
    assert.equal(monthTotal(payouts), SHIFTS_PER_MONTH * SHIFT_PAYCHECK_FULL);
  });

  test('mixes clean and mistake-penalized shifts correctly', () => {
    const oneMistake = shiftPaycheck(1);
    const payouts = [SHIFT_PAYCHECK_FULL, oneMistake, SHIFT_PAYCHECK_FULL];
    assert.equal(monthTotal(payouts), SHIFT_PAYCHECK_FULL * 2 + oneMistake);
  });

  test('non-array input returns 0', () => {
    assert.equal(monthTotal(undefined), 0);
    assert.equal(monthTotal(null), 0);
  });
});

describe('CLOSING_WAIT_SECONDS', () => {
  test('is a small positive number of real seconds', () => {
    assert.equal(CLOSING_WAIT_SECONDS, 20);
    assert.ok(CLOSING_WAIT_SECONDS > 0);
  });
});

describe('skillCheckSuccessZone / isSkillCheckSuccess', () => {
  test('zone is centered at 0.5 and matches SKILL_CHECK_ZONE_WIDTH', () => {
    const zone = skillCheckSuccessZone();
    assert.equal((zone.start + zone.end) / 2, 0.5);
    assert.equal(zone.width, SKILL_CHECK_ZONE_WIDTH);
  });

  test('a sample squarely in the zone succeeds', () => {
    assert.ok(isSkillCheckSuccess(0.5));
  });

  test('a sample outside the zone (both sides) fails', () => {
    const zone = skillCheckSuccessZone();
    assert.ok(!isSkillCheckSuccess(zone.start - 0.01, zone));
    assert.ok(!isSkillCheckSuccess(zone.end + 0.01, zone));
  });

  test('a non-finite gauge position fails', () => {
    assert.ok(!isSkillCheckSuccess(NaN));
  });

  test('shared by both Shelf and Checkout Skill-Checks — a single zone definition, no per-check-kind variant', () => {
    // There is deliberately only one exported zone function; this test
    // documents that sharing rather than asserting behavior difference.
    assert.equal(typeof skillCheckSuccessZone, 'function');
  });
});

describe('skillCheckSweepSpeed', () => {
  test('increases with shift number', () => {
    assert.ok(skillCheckSweepSpeed(SHIFTS_PER_MONTH) > skillCheckSweepSpeed(1));
  });

  test('never exceeds 1.6', () => {
    assert.ok(skillCheckSweepSpeed(SHIFTS_PER_MONTH) <= 1.6);
  });

  test('never drops below its base at shift 1', () => {
    assert.ok(skillCheckSweepSpeed(1) >= 0.6);
  });
});

describe('borrowPatienceSeconds', () => {
  test('decreases as shift number increases', () => {
    assert.ok(borrowPatienceSeconds(SHIFTS_PER_MONTH) < borrowPatienceSeconds(1));
  });

  test('never goes below the documented floor', () => {
    assert.ok(borrowPatienceSeconds(SHIFTS_PER_MONTH) >= 30);
  });
});

describe('clampLibraryMood', () => {
  test('clamps into [0, LIBRARY_MOOD_MAX]', () => {
    assert.equal(clampLibraryMood(-10), 0);
    assert.equal(clampLibraryMood(LIBRARY_MOOD_MAX + 10), LIBRARY_MOOD_MAX);
    assert.equal(clampLibraryMood(50), 50);
  });

  test('non-finite input clamps to 0', () => {
    assert.equal(clampLibraryMood(NaN), 0);
  });
});

describe('patienceMultiplierForLibraryMood', () => {
  test('is 1.0 at full mood', () => {
    assert.equal(patienceMultiplierForLibraryMood(LIBRARY_MOOD_MAX), 1);
  });

  test('is below 1.0 and above the floor at partial mood', () => {
    const mult = patienceMultiplierForLibraryMood(LIBRARY_MOOD_MAX / 2);
    assert.ok(mult < 1 && mult > 0.6);
  });

  test('bottoms out at 0.6 at 0 mood', () => {
    assert.equal(patienceMultiplierForLibraryMood(0), 0.6);
  });

  test('four mistakes worth of drain reaches the floor', () => {
    const mood = clampLibraryMood(LIBRARY_MOOD_MAX - 4 * LIBRARY_MOOD_DRAIN_PER_MISTAKE);
    assert.equal(patienceMultiplierForLibraryMood(mood), 0.6);
  });
});

describe('Sanity (ported from Kitchen Shift)', () => {
  test('matches Kitchen Shift\'s exact constants', () => {
    assert.equal(SANITY_MAX, 100);
    assert.equal(SANITY_DRAIN_PER_SECOND, 100 / 150);
    assert.equal(SANITY_DRAIN_PER_UPSET, 15);
  });

  test('clampSanity clamps into [0, SANITY_MAX]', () => {
    assert.equal(clampSanity(-10), 0);
    assert.equal(clampSanity(SANITY_MAX + 10), SANITY_MAX);
    assert.equal(clampSanity(50), 50);
    assert.equal(clampSanity(NaN), 0);
  });

  test('walkSpeedMultiplierForSanity is 1.0 at full sanity', () => {
    assert.equal(walkSpeedMultiplierForSanity(SANITY_MAX), 1);
  });

  test('walkSpeedMultiplierForSanity never fully stops the player at 0 sanity', () => {
    const multiplier = walkSpeedMultiplierForSanity(0);
    assert.ok(multiplier > 0 && multiplier < 1);
  });

  test('walkSpeedMultiplierForSanity decreases monotonically as sanity drops', () => {
    assert.ok(walkSpeedMultiplierForSanity(80) > walkSpeedMultiplierForSanity(20));
  });

  test('libraryMood and sanity are independent constants/scales, not the same stat', () => {
    // Both happen to share a 0..100 scale, but are distinct exports with
    // distinct drain shapes (mood: mistake-only; sanity: passive + mistake).
    assert.notEqual(clampLibraryMood, clampSanity);
    assert.equal(LIBRARY_MOOD_MAX, SANITY_MAX); // same scale by convention...
    assert.notEqual(LIBRARY_MOOD_DRAIN_PER_MISTAKE, SANITY_DRAIN_PER_UPSET); // ...but different drain amounts
  });
});

describe('Coffee Pour minigame', () => {
  test('target band is COFFEE_POUR_BAND_WIDTH wide and slides between 62% and 86% full', () => {
    const lowest = coffeePourTargetBand(0);
    const highest = coffeePourTargetBand(0.9999);
    assert.ok(Math.abs((lowest.high - lowest.low) - COFFEE_POUR_BAND_WIDTH) < 1e-9);
    assert.ok(Math.abs((lowest.low + lowest.high) / 2 - 0.62) < 1e-9);
    assert.ok((highest.low + highest.high) / 2 <= 0.86 + 1e-9);
    assert.ok(highest.high < 1, 'the band never reaches the brim');
    assert.deepEqual(coffeePourTargetBand(NaN), lowest);
  });

  test('grades: perfect inside the band, good just outside it, sloppy further out, spilled at the brim', () => {
    const band = coffeePourTargetBand(0.5);
    const mid = (band.low + band.high) / 2;
    assert.equal(gradeCoffeePour(mid, band), 'perfect');
    assert.equal(gradeCoffeePour(band.low, band), 'perfect');
    assert.equal(gradeCoffeePour(band.high, band), 'perfect');
    assert.equal(gradeCoffeePour(band.low - COFFEE_POUR_GOOD_MARGIN / 2, band), 'good');
    assert.equal(gradeCoffeePour(band.high + COFFEE_POUR_GOOD_MARGIN / 2, band), 'good');
    assert.equal(gradeCoffeePour(0.1, band), 'sloppy');
    assert.equal(gradeCoffeePour(1, band), 'spilled');
    assert.equal(gradeCoffeePour(1.3, band), 'spilled');
    assert.equal(gradeCoffeePour(NaN, band), 'sloppy');
  });

  test('every grade restores some Sanity, and perfect restores the most', () => {
    const grades = ['perfect', 'good', 'sloppy', 'spilled'];
    for (const g of grades) assert.ok(COFFEE_SANITY_RESTORE[g] > 0, g);
    assert.ok(COFFEE_SANITY_RESTORE.perfect > COFFEE_SANITY_RESTORE.good);
    assert.ok(COFFEE_SANITY_RESTORE.good > COFFEE_SANITY_RESTORE.sloppy);
  });
});

describe('fines start shift (v2.4)', () => {
  test('finesStartShiftForSeed is deterministic and always within 5..8', () => {
    const seen = new Set();
    for (let seed = 0; seed < 500; seed++) {
      const shift = finesStartShiftForSeed(seed * 7919);
      assert.ok(shift >= FINES_START_SHIFT_MIN && shift <= FINES_START_SHIFT_MAX, String(shift));
      assert.equal(finesStartShiftForSeed(seed * 7919), shift);
      seen.add(shift);
    }
    assert.equal(seen.size, FINES_START_SHIFT_MAX - FINES_START_SHIFT_MIN + 1, 'every start shift in range is reachable');
    assert.equal(finesStartShiftForSeed(NaN), finesStartShiftForSeed(0));
  });

  test('no fines before the start shift; the normal tier volume from it onward', () => {
    assert.equal(fineVolumeForShift(1, 6), 0);
    assert.equal(fineVolumeForShift(5, 6), 0);
    assert.equal(fineVolumeForShift(6, 6), fineVolumeForShift(6));
    assert.ok(fineVolumeForShift(6, 6) > 0);
    assert.ok(fineVolumeForShift(1) > 0, 'omitting the start shift means no gate');
  });
});

describe('Count the Till (v2.4)', () => {
  test('tillCountResult compares the running count to the fine', () => {
    assert.equal(tillCountResult(45, 45), 'exact');
    assert.equal(tillCountResult(40, 45), 'under');
    assert.equal(tillCountResult(50, 45), 'over');
  });

  test('every possible fine amount can be counted exactly from the denominations', () => {
    for (let amount = FINE_AMOUNT_MIN_GARD; amount <= FINE_AMOUNT_MAX_GARD; amount++) {
      let left = amount;
      for (const d of [...TILL_DENOMINATIONS].sort((a, b) => b - a)) left %= d;
      assert.equal(left, 0, String(amount));
    }
  });
});

describe('rating rules (v2.9)', () => {
  test('paycheck multiplier is rating / 5, clamped', () => {
    assert.equal(paycheckMultiplierForRating(5), 1);
    assert.equal(paycheckMultiplierForRating(3.5), 0.7);
    assert.equal(paycheckMultiplierForRating(-1), 0);
    assert.equal(paycheckMultiplierForRating(9), 1);
    assert.equal(clampRating(NaN), 0);
  });

  test('queue wait shrinks with shift number but stays at least 45 s', () => {
    assert.equal(queueWaitSecondsForShift(1), 90);
    assert.ok(queueWaitSecondsForShift(30) < queueWaitSecondsForShift(1));
    assert.ok(queueWaitSecondsForShift(30) >= 45);
  });
});

describe('hallucination rules (v2.16)', () => {
  test('intensity is 0 at/above the start threshold and 1 at 0 Sanity', () => {
    assert.equal(hallucinationIntensity(100), 0);
    assert.equal(hallucinationIntensity(HALLUCINATION_START_SANITY), 0);
    assert.equal(hallucinationIntensity(0), 1);
    const mid = hallucinationIntensity(HALLUCINATION_START_SANITY / 2);
    assert.ok(mid > 0.4 && mid < 0.6);
  });

  test('shaky hands narrow the zone and speed the sweep with intensity', () => {
    assert.equal(shakyHandsZoneScale(0), 1);
    assert.equal(shakyHandsZoneScale(1), 0.5);
    assert.equal(shakyHandsSweepMultiplier(0), 1);
    assert.ok(Math.abs(shakyHandsSweepMultiplier(1) - 1.6) < 1e-9);
  });

  test('pay cut: 2% per full 10 s at 0 Sanity, capped at 30%', () => {
    assert.equal(hallucinationPayMultiplier(0), 1);
    assert.equal(hallucinationPayMultiplier(9), 1);
    assert.equal(hallucinationPayMultiplier(10), 0.98);
    assert.ok(Math.abs(hallucinationPayMultiplier(1000) - 0.7) < 1e-9);
  });
});

describe('zero-Mood pay cut (v2.17)', () => {
  test('2% per full 10 s at 0 Mood, capped at 30%', () => {
    assert.equal(moodPayMultiplier(0), 1);
    assert.equal(moodPayMultiplier(10), 0.98);
    assert.ok(Math.abs(moodPayMultiplier(10000) - 0.7) < 1e-9);
  });
});
