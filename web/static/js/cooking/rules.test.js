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
  SHIFT_PAYCHECK_FULL,
  SHIFT_PAYCHECK_UPSET,
  PHYSICAL_TABLE_COUNT,
  RECIPE_BANDS,
  FRIDGE_INGREDIENTS,
  CABINET_INGREDIENTS,
} from './rules.js';

describe('RECIPE_BANDS ingredient names', () => {
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
