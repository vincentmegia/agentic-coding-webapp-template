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
  restoreSanity,
  SHIFT_CLOCK_SECONDS,
  SANITY_MAX,
} from './engine-state.js';

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

describe('closing sequence order is enforced', () => {
  function closedShiftWithDirtyTablesAndDishes() {
    let state = createInitialState(TABLE_IDS);
    state = addOrder(state, 1, 'Burger', 30, 4);
    state = serveDish(state, 1, 'Burger');
    state = tick(state, SHIFT_CLOCK_SECONDS);
    return state;
  }

  test('cleanTable is a no-op outside closing-clean', () => {
    const state = createInitialState(TABLE_IDS);
    const next = cleanTable(state, 1);
    assert.deepEqual(next, state);
  });

  test('cleaning every dirty table transitions to closing-dishes', () => {
    let state = closedShiftWithDirtyTablesAndDishes();
    assert.equal(state.phase, 'closing-clean');
    state = cleanTable(state, 1);
    assert.equal(state.phase, 'closing-dishes');
  });

  test('washDishes is a no-op before every table is clean', () => {
    const state = closedShiftWithDirtyTablesAndDishes();
    const next = washDishes(state);
    assert.deepEqual(next, state);
  });

  test('washing dishes transitions to closing-shutdown', () => {
    let state = closedShiftWithDirtyTablesAndDishes();
    state = cleanTable(state, 1);
    state = washDishes(state);
    assert.equal(state.phase, 'closing-shutdown');
    assert.equal(state.dirtyDishCount, 0);
  });

  test('shutDown is a no-op before dishes are washed', () => {
    let state = closedShiftWithDirtyTablesAndDishes();
    state = cleanTable(state, 1);
    const next = shutDown(state);
    assert.deepEqual(next, state);
  });

  test('shutting down transitions to paycheck', () => {
    let state = closedShiftWithDirtyTablesAndDishes();
    state = cleanTable(state, 1);
    state = washDishes(state);
    state = shutDown(state);
    assert.equal(state.phase, 'paycheck');
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
