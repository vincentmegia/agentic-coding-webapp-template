import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createInitialState,
  addOrder,
  serveDish,
  tick,
  cleanTable,
  washDishes,
  shutDown,
  failOrderAt,
  annoyCustomer,
  restoreSanity,
  SHIFT_CLOCK_SECONDS,
  SANITY_MAX,
  REPUTATION_MAX,
} from './engine-state.js';
import { CUSTOMER_SANITY_MAX, CUSTOMER_SANITY_DRAIN_PER_ANNOYANCE } from './rules.js';

const TABLE_IDS = [1, 2, 3, 4];

describe('createInitialState', () => {
  test('defaults to playing, a full clock, no orders, no upset, every table clean/unoccupied', () => {
    const state = createInitialState(TABLE_IDS);
    assert.equal(state.phase, 'playing');
    assert.equal(state.clockSeconds, SHIFT_CLOCK_SECONDS);
    assert.deepEqual(state.orders, []);
    assert.equal(state.dirtyDishCount, 0);
    assert.equal(state.shiftUpset, false);
    assert.equal(state.sanity, SANITY_MAX);
    assert.equal(state.mistakeCount, 0);
    assert.equal(state.reputation, REPUTATION_MAX);
    for (const id of TABLE_IDS) {
      assert.deepEqual(state.tables[id], { occupied: false, dirty: false });
    }
  });
});

describe('addOrder', () => {
  test('seats an order and marks the table occupied', () => {
    const state = createInitialState(TABLE_IDS);
    const next = addOrder(state, 1, 'Burger', 30, 4);
    assert.equal(next.orders.length, 1);
    assert.equal(next.orders[0].tableId, 1);
    assert.equal(next.orders[0].dishName, 'Burger');
    assert.equal(next.tables[1].occupied, true);
  });

  test('stores the given patience as both the countdown and patienceMaxSeconds', () => {
    const state = createInitialState(TABLE_IDS);
    const next = addOrder(state, 1, 'Burger', 45, 4);
    assert.equal(next.orders[0].patienceRemainingSeconds, 45);
    assert.equal(next.orders[0].patienceMaxSeconds, 45);
  });

  test('starts customerSanityRemaining at CUSTOMER_SANITY_MAX', () => {
    const state = createInitialState(TABLE_IDS);
    const next = addOrder(state, 1, 'Burger', 45, 4);
    assert.equal(next.orders[0].customerSanityRemaining, CUSTOMER_SANITY_MAX);
  });

  test('is a no-op if the table is already occupied', () => {
    const state = addOrder(createInitialState(TABLE_IDS), 1, 'Burger', 30, 4);
    const next = addOrder(state, 1, 'Pancakes', 30, 4);
    assert.equal(next.orders.length, 1);
    assert.equal(next.orders[0].dishName, 'Burger');
  });

  test('respects the table-capacity cap', () => {
    let state = createInitialState(TABLE_IDS);
    state = addOrder(state, 1, 'A', 30, 1);
    state = addOrder(state, 2, 'B', 30, 1);
    assert.equal(state.orders.length, 1);
    assert.equal(state.tables[2].occupied, false);
  });
});

describe('serveDish', () => {
  test('serving the correct dish clears the order and marks the table dirty', () => {
    let state = createInitialState(TABLE_IDS);
    state = addOrder(state, 1, 'Burger', 30, 4);
    const next = serveDish(state, 1, 'Burger');
    assert.equal(next.orders.length, 0);
    assert.deepEqual(next.tables[1], { occupied: false, dirty: true });
    assert.equal(next.dirtyDishCount, 1);
    assert.equal(next.shiftUpset, false);
  });

  test('serving the wrong dish latches shiftUpset and does not clear the order', () => {
    let state = createInitialState(TABLE_IDS);
    state = addOrder(state, 1, 'Burger', 30, 4);
    const next = serveDish(state, 1, 'Pancakes');
    assert.equal(next.orders.length, 1);
    assert.equal(next.shiftUpset, true);
    assert.equal(next.tables[1].occupied, true);
  });

  test('serving a table with no active order latches shiftUpset', () => {
    const state = createInitialState(TABLE_IDS);
    const next = serveDish(state, 1, 'Burger');
    assert.equal(next.shiftUpset, true);
  });
});

describe('failOrderAt', () => {
  test('fails the active order at that table exactly like a patience timeout', () => {
    let state = createInitialState(TABLE_IDS);
    state = addOrder(state, 1, 'Burger', 999, 4);
    const next = failOrderAt(state, 1);
    assert.equal(next.orders.length, 0);
    assert.deepEqual(next.tables[1], { occupied: false, dirty: true });
    assert.equal(next.shiftUpset, true);
  });

  test('is a no-op if there is no active order at that table', () => {
    const state = createInitialState(TABLE_IDS);
    const next = failOrderAt(state, 1);
    assert.deepEqual(next, state);
  });

  test('is a no-op once the shift has left playing', () => {
    let state = createInitialState(TABLE_IDS);
    state = addOrder(state, 1, 'Burger', 999, 4);
    state = tick(state, SHIFT_CLOCK_SECONDS + 1);
    const before = state;
    const after = failOrderAt(state, 2);
    assert.deepEqual(after, before);
  });

  test('does not affect other tables\' orders', () => {
    let state = createInitialState(TABLE_IDS);
    state = addOrder(state, 1, 'Burger', 999, 4);
    state = addOrder(state, 2, 'Pancakes', 999, 4);
    const next = failOrderAt(state, 1);
    assert.equal(next.orders.length, 1);
    assert.equal(next.orders[0].tableId, 2);
  });
});

describe('annoyCustomer', () => {
  test('drains customerSanityRemaining by CUSTOMER_SANITY_DRAIN_PER_ANNOYANCE and leaves the order in place', () => {
    let state = createInitialState(TABLE_IDS);
    state = addOrder(state, 1, 'Burger', 999, 4);
    const next = annoyCustomer(state, 1);
    assert.equal(next.orders.length, 1);
    assert.equal(next.orders[0].tableId, 1);
    assert.equal(next.orders[0].customerSanityRemaining, CUSTOMER_SANITY_MAX - CUSTOMER_SANITY_DRAIN_PER_ANNOYANCE);
    assert.equal(next.tables[1].occupied, true);
    // A single annoyance (with sanity remaining above 0) is not itself a mistake.
    assert.equal(next.shiftUpset, false);
    assert.equal(next.mistakeCount, 0);
  });

  test('four annoyances in a row bottom out sanity and fail the order exactly like failOrderAt', () => {
    let state = createInitialState(TABLE_IDS);
    state = addOrder(state, 1, 'Burger', 999, 4);
    const expectedHits = Math.ceil(CUSTOMER_SANITY_MAX / CUSTOMER_SANITY_DRAIN_PER_ANNOYANCE);
    assert.equal(expectedHits, 4, 'sanity/drain constants changed — update this test\'s expectations');

    for (let i = 0; i < expectedHits - 1; i++) {
      state = annoyCustomer(state, 1);
      assert.equal(state.orders.length, 1, `order should still be active after annoyance ${i + 1}`);
      assert.equal(state.mistakeCount, 0);
    }

    const next = annoyCustomer(state, 1);
    assert.equal(next.orders.length, 0);
    assert.deepEqual(next.tables[1], { occupied: false, dirty: true });
    assert.equal(next.shiftUpset, true);
    assert.equal(next.mistakeCount, 1);
    // Same drain amounts failOrderAt applies on its own — verified by
    // comparing against a fresh failOrderAt call from the same pre-hit
    // state, on a second table seeded identically.
    let comparisonState = createInitialState(TABLE_IDS);
    comparisonState = addOrder(comparisonState, 2, 'Burger', 999, 4);
    const viaFailOrderAt = failOrderAt(comparisonState, 2);
    assert.equal(next.sanity, viaFailOrderAt.sanity);
    assert.equal(next.reputation, viaFailOrderAt.reputation);
  });

  test('is a no-op if there is no active order at that table', () => {
    const state = createInitialState(TABLE_IDS);
    const next = annoyCustomer(state, 1);
    assert.deepEqual(next, state);
  });

  test('is a no-op once the shift has left playing', () => {
    let state = createInitialState(TABLE_IDS);
    state = addOrder(state, 1, 'Burger', 999, 4);
    state = tick(state, SHIFT_CLOCK_SECONDS + 1);
    const before = state;
    const after = annoyCustomer(state, 2);
    assert.deepEqual(after, before);
  });

  test('does not affect other tables\' orders or the shift clock', () => {
    let state = createInitialState(TABLE_IDS);
    state = addOrder(state, 1, 'Burger', 999, 4);
    state = addOrder(state, 2, 'Pancakes', 999, 4);
    const next = annoyCustomer(state, 1);
    assert.equal(next.orders.length, 2);
    const other = next.orders.find((o) => o.tableId === 2);
    assert.equal(other.customerSanityRemaining, CUSTOMER_SANITY_MAX);
    assert.equal(next.clockSeconds, state.clockSeconds);
  });
});

describe('tick', () => {
  test('decrements the shift clock and every order\'s patience timer', () => {
    let state = createInitialState(TABLE_IDS);
    state = addOrder(state, 1, 'Burger', 10, 4);
    const next = tick(state, 3);
    assert.equal(next.clockSeconds, SHIFT_CLOCK_SECONDS - 3);
    assert.equal(next.orders[0].patienceRemainingSeconds, 7);
  });

  test('an order whose patience reaches 0 auto-fails: removed, table dirty, shiftUpset latched', () => {
    let state = createInitialState(TABLE_IDS);
    state = addOrder(state, 1, 'Burger', 5, 4);
    const next = tick(state, 5);
    assert.equal(next.orders.length, 0);
    assert.deepEqual(next.tables[1], { occupied: false, dirty: true });
    assert.equal(next.shiftUpset, true);
  });

  test('the shift clock reaching 0 fails every remaining order and moves to closing-clean', () => {
    let state = createInitialState(TABLE_IDS);
    state = addOrder(state, 1, 'Burger', 999, 4);
    state = addOrder(state, 2, 'Pancakes', 999, 4);
    const next = tick(state, SHIFT_CLOCK_SECONDS + 10);
    assert.equal(next.phase, 'closing-clean');
    assert.equal(next.clockSeconds, 0);
    assert.equal(next.orders.length, 0);
    assert.equal(next.shiftUpset, true);
    assert.equal(next.tables[1].dirty, true);
    assert.equal(next.tables[2].dirty, true);
  });

  test('a clean shift (no missed orders) never latches shiftUpset from ticking alone', () => {
    let state = createInitialState(TABLE_IDS);
    state = tick(state, SHIFT_CLOCK_SECONDS);
    assert.equal(state.shiftUpset, false);
  });

  test('an idle shift (no orders ever served) skips closing-clean entirely — regression for a soft-lock where no table is ever dirty, so cleanTable() never fires its all-clean transition check', () => {
    let state = createInitialState(TABLE_IDS);
    state = tick(state, SHIFT_CLOCK_SECONDS);
    assert.equal(state.phase, 'closing-dishes');
  });

  test('a shift with at least one served order still stops at closing-clean until cleaned', () => {
    let state = createInitialState(TABLE_IDS);
    state = addOrder(state, 1, 'Burger', 30, 4);
    state = serveDish(state, 1, 'Burger');
    state = tick(state, SHIFT_CLOCK_SECONDS);
    assert.equal(state.phase, 'closing-clean');
  });

  test('is a no-op once the shift has left playing', () => {
    let state = createInitialState(TABLE_IDS);
    state = tick(state, SHIFT_CLOCK_SECONDS);
    const before = state;
    const after = tick(state, 5);
    assert.deepEqual(after, before);
  });
});

describe('closing chores (any order after 11:30 PM, v4.8)', () => {
  function closedShiftWithDirtyTablesAndDishes() {
    let state = createInitialState(TABLE_IDS);
    state = addOrder(state, 1, 'Burger', 30, 4);
    state = serveDish(state, 1, 'Burger');
    state = tick(state, SHIFT_CLOCK_SECONDS);
    return state;
  }

  test('chores are no-ops while the shift is still playing', () => {
    const state = createInitialState(TABLE_IDS);
    assert.deepEqual(cleanTable(state, 1), state);
    assert.deepEqual(washDishes(state), state);
    assert.deepEqual(shutDown(state), state);
  });

  test('the classic order still works: tables, dishes, shutdown', () => {
    let state = closedShiftWithDirtyTablesAndDishes();
    assert.equal(state.phase, 'closing-clean');
    state = cleanTable(state, 1);
    assert.equal(state.phase, 'closing-dishes');
    state = washDishes(state);
    assert.equal(state.phase, 'closing-shutdown');
    assert.equal(state.dirtyDishCount, 0);
    state = shutDown(state);
    assert.equal(state.phase, 'paycheck');
    assert.equal(skippedChores(state).gard, 0);
  });

  test('dishes can be washed before the tables are clean', () => {
    let state = closedShiftWithDirtyTablesAndDishes();
    state = washDishes(state);
    assert.equal(state.dishesWashed, true);
    assert.equal(state.phase, 'closing-clean');
    state = cleanTable(state, 1);
    assert.equal(state.phase, 'closing-shutdown');
  });

  test('shutting down right away is allowed; the skipped chores are docked', () => {
    let state = closedShiftWithDirtyTablesAndDishes();
    state = shutDown(state);
    assert.equal(state.phase, 'paycheck');
    const chores = skippedChores(state);
    assert.deepEqual([chores.dirtyTables, chores.dishesUnwashed, chores.notShutDown], [1, true, false]);
  });
});

describe('sanity', () => {
  test('tick drains sanity passively even when nothing goes wrong', () => {
    let state = createInitialState(TABLE_IDS);
    state = tick(state, 10);
    assert.ok(state.sanity < SANITY_MAX);
  });

  test('a wrong-dish serve drains sanity on top of the passive rate', () => {
    let state = createInitialState(TABLE_IDS);
    state = addOrder(state, 1, 'Burger', 30, 4);
    const before = state.sanity;
    state = serveDish(state, 1, 'Pancakes');
    assert.ok(state.sanity < before);
  });

  test('failOrderAt drains sanity', () => {
    let state = createInitialState(TABLE_IDS);
    state = addOrder(state, 1, 'Burger', 30, 4);
    const before = state.sanity;
    state = failOrderAt(state, 1);
    assert.ok(state.sanity < before);
  });

  test('a patience timeout during tick drains sanity', () => {
    let state = createInitialState(TABLE_IDS);
    state = addOrder(state, 1, 'Burger', 5, 4);
    const before = state.sanity;
    state = tick(state, 5);
    assert.ok(state.sanity < before);
  });

  test('sanity never drops below 0 no matter how much drains at once', () => {
    let state = createInitialState(TABLE_IDS);
    state = tick(state, SHIFT_CLOCK_SECONDS * 100);
    assert.equal(state.sanity, 0);
  });

  test('restoreSanity sets it back to SANITY_MAX', () => {
    let state = createInitialState(TABLE_IDS);
    state = tick(state, 10);
    assert.ok(state.sanity < SANITY_MAX);
    state = restoreSanity(state);
    assert.equal(state.sanity, SANITY_MAX);
  });

  test('restoreSanity is a no-op once the shift has left playing', () => {
    let state = createInitialState(TABLE_IDS);
    state = tick(state, SHIFT_CLOCK_SECONDS);
    const before = state;
    const after = restoreSanity(state);
    assert.deepEqual(after, before);
  });
});

// v3.11: mistakeCount (feeds rules.js's shiftPaycheck) and reputation
// (feeds rules.js's patienceMultiplierForReputation) track every mistake
// the same three ways sanity already does — a wrong-dish serve, a
// failOrderAt (Karen's ripple), and a tick()-driven patience/clock
// timeout — see the food-server/customer rules docs.
describe('mistakes and reputation', () => {
  test('a wrong-dish serve increments mistakeCount and drains reputation', () => {
    let state = createInitialState(TABLE_IDS);
    state = addOrder(state, 1, 'Burger', 30, 4);
    const next = serveDish(state, 1, 'Pancakes');
    assert.equal(next.mistakeCount, 1);
    assert.ok(next.reputation < REPUTATION_MAX);
  });

  test('serving the correct dish leaves mistakeCount and reputation untouched', () => {
    let state = createInitialState(TABLE_IDS);
    state = addOrder(state, 1, 'Burger', 30, 4);
    const next = serveDish(state, 1, 'Burger');
    assert.equal(next.mistakeCount, 0);
    assert.equal(next.reputation, REPUTATION_MAX);
  });

  test('failOrderAt increments mistakeCount and drains reputation', () => {
    let state = createInitialState(TABLE_IDS);
    state = addOrder(state, 1, 'Burger', 30, 4);
    const next = failOrderAt(state, 1);
    assert.equal(next.mistakeCount, 1);
    assert.ok(next.reputation < REPUTATION_MAX);
  });

  test('a patience timeout during tick increments mistakeCount and drains reputation', () => {
    let state = createInitialState(TABLE_IDS);
    state = addOrder(state, 1, 'Burger', 5, 4);
    state = tick(state, 5);
    assert.equal(state.mistakeCount, 1);
    assert.ok(state.reputation < REPUTATION_MAX);
  });

  test('reputation never drops below 0 no matter how many mistakes', () => {
    let state = createInitialState(TABLE_IDS);
    for (let i = 0; i < 20; i++) {
      state = addOrder(state, 1, 'Burger', 30, 4);
      state = serveDish(state, 1, 'Wrong Dish');
    }
    assert.equal(state.reputation, 0);
    assert.equal(state.mistakeCount, 20);
  });

  test('tick never drains reputation passively (only sanity does)', () => {
    let state = createInitialState(TABLE_IDS);
    state = tick(state, 10);
    assert.equal(state.reputation, REPUTATION_MAX);
  });

  test('the shift clock hitting zero with orders still queued counts each as a mistake', () => {
    let state = createInitialState(TABLE_IDS);
    state = addOrder(state, 1, 'Burger', 999, 4);
    state = addOrder(state, 2, 'Pancakes', 999, 4);
    state = tick(state, SHIFT_CLOCK_SECONDS);
    assert.equal(state.mistakeCount, 2);
  });
});

// ---------------------------------------------------------------------------
// v4 — mechanics ported from Library Shift
// ---------------------------------------------------------------------------

import {
  brewCoffee,
  earnBonusGard,
  startleFromHallucination,
  shiftPayout,
} from './engine-state.js';
import {
  COFFEE_SANITY_RESTORE,
  COFFEE_PERFECT_TIP_GARD,
  HALLUCINATION_STARTLE_SANITY,
  ZERO_REPUTATION_STORM_OUT_SECONDS,
  COMPLAINT_INTERVAL_SECONDS,
  COMPLAINT_GARD,
  shiftPaycheck,
} from './rules.js';

describe('brewCoffee (Coffee Pour)', () => {
  test('a perfect pour fills Sanity and tips bonus Gard', () => {
    const state = brewCoffee(createInitialState(TABLE_IDS, { sanity: 10 }), 'perfect');
    assert.equal(state.sanity, SANITY_MAX);
    assert.equal(state.bonusGard, COFFEE_PERFECT_TIP_GARD);
  });

  test('good/sloppy restore partially, with no tip', () => {
    assert.equal(brewCoffee(createInitialState(TABLE_IDS, { sanity: 10 }), 'good').sanity, 10 + COFFEE_SANITY_RESTORE.good);
    const sloppy = brewCoffee(createInitialState(TABLE_IDS, { sanity: 10 }), 'sloppy');
    assert.equal(sloppy.sanity, 10 + COFFEE_SANITY_RESTORE.sloppy);
    assert.equal(sloppy.bonusGard, 0);
  });

  test('a spill drains 50 Sanity, clamped at 0', () => {
    assert.equal(brewCoffee(createInitialState(TABLE_IDS, { sanity: 80 }), 'spilled').sanity, 30);
    assert.equal(brewCoffee(createInitialState(TABLE_IDS, { sanity: 20 }), 'spilled').sanity, 0);
  });

  test('an unknown grade counts as sloppy; a no-op outside playing', () => {
    assert.equal(brewCoffee(createInitialState(TABLE_IDS, { sanity: 10 }), 'weird').sanity, 10 + COFFEE_SANITY_RESTORE.sloppy);
    const closing = createInitialState(TABLE_IDS, { phase: 'closing-clean', sanity: 10 });
    assert.equal(brewCoffee(closing, 'perfect'), closing);
  });
});

describe('earnBonusGard', () => {
  test('adds positive amounts only', () => {
    const state = createInitialState(TABLE_IDS);
    assert.equal(earnBonusGard(state, 250).bonusGard, 250);
    assert.equal(earnBonusGard(state, 0), state);
    assert.equal(earnBonusGard(state, NaN), state);
  });
});

describe('startleFromHallucination', () => {
  test('costs HALLUCINATION_STARTLE_SANITY, not a mistake', () => {
    const state = startleFromHallucination(createInitialState(TABLE_IDS, { sanity: 20 }));
    assert.equal(state.sanity, 20 - HALLUCINATION_STARTLE_SANITY);
    assert.equal(state.mistakeCount, 0);
  });
});

describe('tick at 0 Sanity', () => {
  test('counts only the time after Sanity actually hit 0', () => {
    // 1 Sanity left drains in 1.5 s at SANITY_DRAIN_PER_SECOND (100/150).
    const state = tick(createInitialState(TABLE_IDS, { sanity: 1 }), 10);
    assert.equal(state.sanity, 0);
    assert.ok(Math.abs(state.zeroSanitySeconds - 8.5) < 1e-9);
  });
});

describe('tick at 0 Reputation', () => {
  test('nothing happens while Reputation is above 0', () => {
    const state = tick(addOrder(createInitialState(TABLE_IDS, { reputation: 25 }), 1, 'Burger', 999, 5), 25);
    assert.equal(state.stormOuts, 0);
    assert.equal(state.complaints, 0);
    assert.equal(state.zeroReputationSeconds, 0);
  });

  test('the customer closest to giving up storms out every ZERO_REPUTATION_STORM_OUT_SECONDS — a mistake', () => {
    let state = createInitialState(TABLE_IDS, { reputation: 0 });
    state = addOrder(state, 1, 'Burger', 500, 5);
    state = addOrder(state, 2, 'Pasta', 300, 5);
    state = tick(state, ZERO_REPUTATION_STORM_OUT_SECONDS);
    assert.equal(state.stormOuts, 1);
    assert.deepEqual(state.orders.map((o) => o.tableId), [1]);
    assert.equal(state.tables[2].dirty, true);
    assert.equal(state.mistakeCount, 1);
    assert.equal(state.shiftUpset, true);
  });

  test('with nobody to storm out, the timer holds so the next order goes right away', () => {
    let state = tick(createInitialState(TABLE_IDS, { reputation: 0 }), ZERO_REPUTATION_STORM_OUT_SECONDS + 5);
    assert.equal(state.stormOuts, 0);
    assert.equal(state.reputationStormTimer, ZERO_REPUTATION_STORM_OUT_SECONDS);
    state = addOrder(state, 1, 'Burger', 500, 5);
    state = tick(state, 0.01);
    assert.equal(state.stormOuts, 1);
  });

  test('a complaint letter every COMPLAINT_INTERVAL_SECONDS at 0', () => {
    const state = tick(createInitialState(TABLE_IDS, { reputation: 0 }), COMPLAINT_INTERVAL_SECONDS * 2 + 1);
    assert.equal(state.complaints, 2);
  });
});

describe('shiftPayout', () => {
  test('a clean shift with no extras is exactly the base paycheck', () => {
    assert.equal(shiftPayout(createInitialState(TABLE_IDS)).payout, shiftPaycheck(0));
  });

  test('bonus Gard adds, complaint letters subtract, then the pay cuts multiply', () => {
    const state = createInitialState(TABLE_IDS, {
      mistakeCount: 1, bonusGard: 250, complaints: 2, zeroSanitySeconds: 50, zeroReputationSeconds: 20,
    });
    const parts = shiftPayout(state);
    const gross = shiftPaycheck(1) + 250 - 2 * COMPLAINT_GARD;
    assert.equal(parts.payout, Math.round(gross * 0.9 * 0.96));
    assert.equal(parts.complaintGard, 2 * COMPLAINT_GARD);
  });

  test('flat deductions floor at 0 before the multipliers', () => {
    const parts = shiftPayout(createInitialState(TABLE_IDS, { mistakeCount: 99, complaints: 1000 }));
    assert.equal(parts.payout, 0);
  });
});

import { skippedChores } from './engine-state.js';
import { DIRTY_TABLE_PENALTY_GARD, UNWASHED_DISHES_PENALTY_GARD, NO_SHUTDOWN_PENALTY_GARD } from './rules.js';

describe('skippedChores (Duke opens at 11:30 PM)', () => {
  test('nothing counts while still playing', () => {
    assert.equal(skippedChores(createInitialState(TABLE_IDS)).gard, 0);
  });

  test('walking out straight after closing time skips every chore', () => {
    let state = createInitialState(TABLE_IDS);
    state = addOrder(state, 1, 'Burger', 99, 5);
    state = serveDish(state, 1, 'Burger');
    state = addOrder(state, 2, 'Pasta', 99, 5);
    state = serveDish(state, 2, 'Pasta');
    state = tick(state, SHIFT_CLOCK_SECONDS + 1);
    assert.equal(state.phase, 'closing-clean');
    const chores = skippedChores(state);
    assert.deepEqual(chores, {
      dirtyTables: 2, dishesUnwashed: true, notShutDown: true,
      gard: 2 * DIRTY_TABLE_PENALTY_GARD + UNWASHED_DISHES_PENALTY_GARD + NO_SHUTDOWN_PENALTY_GARD,
    });
    assert.equal(shiftPayout(state).payout, shiftPayout(createInitialState(TABLE_IDS)).payout - chores.gard);
  });

  test('only the shutdown left: just that penalty; all done: nothing', () => {
    let state = tick(createInitialState(TABLE_IDS), SHIFT_CLOCK_SECONDS + 1);
    state = washDishes(state);
    assert.equal(state.phase, 'closing-shutdown');
    assert.equal(skippedChores(state).gard, NO_SHUTDOWN_PENALTY_GARD);
    assert.equal(skippedChores(shutDown(state)).gard, 0);
  });
});
