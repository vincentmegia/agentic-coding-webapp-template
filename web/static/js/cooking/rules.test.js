import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  availableDishes,
  findDish,
  cookSuccessZone,
  isCookSuccess,
  cookSweepSpeed,
  customerArrivalIntervalSeconds,
  customerPatienceSeconds,
  tableCapacity,
  shiftPaycheck,
  monthTotal,
  isKarenShift,
  inGameTimeLabel,
  SHIFT_PAYCHECK_FULL,
  SHIFT_PAYCHECK_UPSET,
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

  test('every stove dish requires a Pan and every oven dish requires a Baking Tray', () => {
    for (const band of RECIPE_BANDS) {
      for (const dish of band.dishes) {
        if (dish.station === 'stove') assert.equal(dish.cookware, 'Pan', `${dish.name} should need a Pan`);
        if (dish.station === 'oven') assert.equal(dish.cookware, 'Baking Tray', `${dish.name} should need a Baking Tray`);
      }
    }
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
    assert.equal(names.length, 8);
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

describe('customerPatienceSeconds', () => {
  test('decreases as shift number increases, at gear level 0', () => {
    assert.ok(customerPatienceSeconds(20, 0) < customerPatienceSeconds(1, 0));
  });

  test('increases with Regular\'s Patience gear level', () => {
    assert.ok(customerPatienceSeconds(10, 3) > customerPatienceSeconds(10, 0));
  });
});

describe('tableCapacity', () => {
  test('never exceeds the physical table count regardless of gear level', () => {
    assert.equal(tableCapacity(99), PHYSICAL_TABLE_COUNT);
  });

  test('increases with gear level up to the physical cap', () => {
    assert.ok(tableCapacity(1) > tableCapacity(0));
  });
});

describe('shiftPaycheck', () => {
  test('pays the full amount when no customer was upset', () => {
    assert.equal(shiftPaycheck(false), SHIFT_PAYCHECK_FULL);
  });

  test('pays only the reduced amount when a customer was upset', () => {
    assert.equal(shiftPaycheck(true), SHIFT_PAYCHECK_UPSET);
  });
});

describe('monthTotal', () => {
  test('sums a full month of flat per-shift paychecks', () => {
    const paychecks = Array(20).fill(SHIFT_PAYCHECK_FULL);
    assert.equal(monthTotal(paychecks), 20 * SHIFT_PAYCHECK_FULL);
  });

  test('mixes full and upset shifts correctly', () => {
    const paychecks = [SHIFT_PAYCHECK_FULL, SHIFT_PAYCHECK_UPSET, SHIFT_PAYCHECK_FULL];
    assert.equal(monthTotal(paychecks), SHIFT_PAYCHECK_FULL * 2 + SHIFT_PAYCHECK_UPSET);
  });
});

describe('isKarenShift', () => {
  test('true only on KAREN_SHIFT_NUMBER', () => {
    assert.equal(isKarenShift(KAREN_SHIFT_NUMBER), true);
    assert.equal(isKarenShift(KAREN_SHIFT_NUMBER - 1), false);
    assert.equal(isKarenShift(KAREN_SHIFT_NUMBER + 1), false);
  });

  test('out-of-range/non-finite input clamps before comparing', () => {
    assert.equal(isKarenShift(999), KAREN_SHIFT_NUMBER === 20);
    assert.equal(isKarenShift(NaN), KAREN_SHIFT_NUMBER === 1);
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
