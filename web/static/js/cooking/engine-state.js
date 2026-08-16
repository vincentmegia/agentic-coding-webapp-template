// Pure, DOM-free shift-state management for Kitchen Shift
// (docs/features/cooking-game.md's Business Rules / Validation and Testing
// Plan). Mirrors the Fishing Game's engine-state.js contract exactly: no
// DOM/canvas/localStorage/timer dependencies, so it can be unit-tested with
// `node --test` and imported unchanged by the canvas game loop
// (cooking-game.js). Every order-queue/table/paycheck-phase transition for
// a single in-progress shift lives here.
//
// State shape (`ShiftState`):
//   {
//     phase: 'playing' | 'closing-clean' | 'closing-dishes' | 'closing-shutdown' | 'paycheck',
//     clockSeconds: number,     // remaining shift clock; only ticks down in 'playing'
//     orders: Order[],          // active order queue
//     tables: { [tableId: number]: { occupied: boolean, dirty: boolean } },
//     dirtyDishCount: number,   // the sink's accumulated stack this shift
//     shiftUpset: boolean,      // latches true on any missed/wrong order — see rules.js's shiftPaycheck()
//     sanity: number,           // 0..SANITY_MAX; drains passively and per-upset, restored by the Coffee Machine
//   }
//   Order = { tableId: number, dishName: string, patienceRemainingSeconds: number }
//
// A table's `occupied` (has a live order right now) and `dirty` (needs
// closing-time cleaning) are tracked independently: a table can be reused
// by a new customer mid-shift as soon as its order resolves, regardless of
// whether it's still marked dirty from an earlier serve — cleaning is
// explicitly a closing-sequence step (doc's User Flow step 8), not
// something that happens between customers mid-shift.
//
// This module never reads a clock itself — every function that needs a
// time delta takes it as an explicit argument, so behavior is fully
// deterministic and testable, matching the Fishing Game's engine-state.js.

import {
  SHIFT_CLOCK_SECONDS,
  SANITY_MAX,
  SANITY_DRAIN_PER_SECOND,
  SANITY_DRAIN_PER_UPSET,
  clampSanity,
} from './rules.js';

export { SHIFT_CLOCK_SECONDS, SANITY_MAX };

/**
 * Builds a fresh shift-start state for the given table ids.
 *
 * @param {number[]} tableIds
 * @param {Partial<ShiftState>} [overrides]
 * @returns {ShiftState}
 */
export function createInitialState(tableIds, overrides = {}) {
  const tables = {};
  for (const id of tableIds) {
    tables[id] = { occupied: false, dirty: false };
  }
  return {
    phase: 'playing',
    clockSeconds: SHIFT_CLOCK_SECONDS,
    orders: [],
    tables,
    dirtyDishCount: 0,
    shiftUpset: false,
    sanity: SANITY_MAX,
    ...overrides,
  };
}

/**
 * Seats a new order at `tableId`. A no-op (returns `state` unchanged) if
 * the shift isn't in 'playing', the table is already occupied, or the
 * queue is already at `maxOrders` (the caller passes
 * `rules.js`'s `tableCapacity(extraTableServiceLevel)` here — this module
 * knows nothing about gear).
 *
 * @param {ShiftState} state
 * @param {number} tableId
 * @param {string} dishName
 * @param {number} patienceSeconds
 * @param {number} maxOrders
 * @returns {ShiftState}
 */
export function addOrder(state, tableId, dishName, patienceSeconds, maxOrders) {
  if (state.phase !== 'playing') return state;
  const table = state.tables[tableId];
  if (!table || table.occupied) return state;
  if (state.orders.length >= maxOrders) return state;

  const patience = Number.isFinite(patienceSeconds) && patienceSeconds > 0 ? patienceSeconds : 0;

  return {
    ...state,
    orders: [...state.orders, { tableId, dishName, patienceRemainingSeconds: patience }],
    tables: { ...state.tables, [tableId]: { ...table, occupied: true } },
  };
}

/**
 * Serves `dishName` at `tableId`. If an active order at that table matches
 * the dish: the order clears, the table frees up (occupied -> false) and
 * gets marked dirty, and the sink's dirty-dish count increments — no
 * change to `shiftUpset`. Otherwise (no active order there, or the dish
 * doesn't match): latches `shiftUpset = true`, drains
 * `SANITY_DRAIN_PER_UPSET` sanity, and leaves the order (if any) in place
 * — the customer is still waiting (doc's Testing Plan: "does not clear the
 * order from the queue"). A no-op (state unchanged) if the shift isn't in
 * 'playing'.
 *
 * @param {ShiftState} state
 * @param {number} tableId
 * @param {string} dishName
 * @returns {ShiftState}
 */
export function serveDish(state, tableId, dishName) {
  if (state.phase !== 'playing') return state;

  const order = state.orders.find((o) => o.tableId === tableId);
  if (order && order.dishName === dishName) {
    const table = state.tables[tableId];
    return {
      ...state,
      orders: state.orders.filter((o) => o !== order),
      tables: { ...state.tables, [tableId]: { ...table, occupied: false, dirty: true } },
      dirtyDishCount: state.dirtyDishCount + 1,
    };
  }

  return { ...state, shiftUpset: true, sanity: clampSanity(state.sanity - SANITY_DRAIN_PER_UPSET) };
}

/**
 * Force-fails whichever order (if any) is currently active at `tableId` —
 * removed from the queue, table freed and marked dirty, `shiftUpset`
 * latched — exactly like a patience timeout, but triggered directly by
 * the caller rather than a clock tick. Used for the Karen event's ripple
 * effect (docs/features/cooking-game.md's Business Rules): failing her
 * order also fails one other random active table's order. A no-op if the
 * shift isn't in 'playing' or there's no active order at that table.
 *
 * @param {ShiftState} state
 * @param {number} tableId
 * @returns {ShiftState}
 */
export function failOrderAt(state, tableId) {
  if (state.phase !== 'playing') return state;
  const order = state.orders.find((o) => o.tableId === tableId);
  if (!order) return state;

  const result = failOrder(state, order);
  return {
    ...state,
    orders: result.orders,
    tables: result.tables,
    shiftUpset: true,
    sanity: clampSanity(state.sanity - SANITY_DRAIN_PER_UPSET),
  };
}

function allTablesClean(tables) {
  return Object.values(tables).every((t) => !t.dirty);
}

function failOrder(state, order) {
  const table = state.tables[order.tableId];
  return {
    orders: state.orders.filter((o) => o !== order),
    tables: { ...state.tables, [order.tableId]: { ...table, occupied: false, dirty: true } },
  };
}

/**
 * Advances the shift clock and every active order's patience timer by
 * `deltaSeconds`. Any order whose patience reaches 0 auto-fails: it's
 * removed from the queue, its table is freed and marked dirty, and
 * `shiftUpset` latches true — all without player input, per the doc's
 * User Flow step 7. If the shift clock itself reaches 0 while still
 * 'playing', every remaining queued order likewise auto-fails and the
 * phase transitions to 'closing-clean'. A no-op if the shift isn't in
 * 'playing' (the clock/patience only run during actual play).
 *
 * @param {ShiftState} state
 * @param {number} deltaSeconds - non-negative; negative/non-finite treated as 0.
 * @returns {ShiftState}
 */
export function tick(state, deltaSeconds) {
  if (state.phase !== 'playing') return state;

  const delta = Number.isFinite(deltaSeconds) && deltaSeconds > 0 ? deltaSeconds : 0;

  let orders = state.orders.map((o) => ({
    ...o,
    patienceRemainingSeconds: o.patienceRemainingSeconds - delta,
  }));

  let tables = state.tables;
  let shiftUpset = state.shiftUpset;
  // Passive drain applies every tick regardless of what else happens this
  // frame; each upset event below adds its own extra drain on top.
  let sanity = clampSanity(state.sanity - SANITY_DRAIN_PER_SECOND * delta);

  const expired = orders.filter((o) => o.patienceRemainingSeconds <= 0);
  for (const order of expired) {
    const result = failOrder({ orders, tables }, order);
    orders = result.orders;
    tables = result.tables;
    shiftUpset = true;
    sanity = clampSanity(sanity - SANITY_DRAIN_PER_UPSET);
  }

  const clockSeconds = Math.max(0, state.clockSeconds - delta);

  if (clockSeconds <= 0) {
    for (const order of orders) {
      const result = failOrder({ orders, tables }, order);
      orders = result.orders;
      tables = result.tables;
      shiftUpset = true;
      sanity = clampSanity(sanity - SANITY_DRAIN_PER_UPSET);
    }
    // If every table already happens to be clean (e.g. an idle shift with
    // no orders ever served), 'closing-clean' has nothing left for the
    // player to clean and cleanTable() below would never fire to check
    // that — skip straight past it rather than soft-locking the shift.
    const phase = allTablesClean(tables) ? 'closing-dishes' : 'closing-clean';
    return { ...state, clockSeconds: 0, orders, tables, shiftUpset, sanity, phase };
  }

  return { ...state, clockSeconds, orders, tables, shiftUpset, sanity };
}

/**
 * Cleans one dirty, unoccupied table. A no-op if the shift isn't in
 * 'closing-clean', the table doesn't exist, is still occupied, or is
 * already clean. Transitions to 'closing-dishes' the moment every table is
 * clean.
 *
 * @param {ShiftState} state
 * @param {number} tableId
 * @returns {ShiftState}
 */
export function cleanTable(state, tableId) {
  if (state.phase !== 'closing-clean') return state;
  const table = state.tables[tableId];
  if (!table || table.occupied || !table.dirty) return state;

  const tables = { ...state.tables, [tableId]: { ...table, dirty: false } };

  return { ...state, tables, phase: allTablesClean(tables) ? 'closing-dishes' : state.phase };
}

/**
 * Washes the sink's entire accumulated dirty-dish stack in one action (see
 * the doc's Open Questions — one interaction clears it all, symmetric with
 * the single shutdown action below). A no-op unless the shift is in
 * 'closing-dishes'. Transitions to 'closing-shutdown'.
 *
 * @param {ShiftState} state
 * @returns {ShiftState}
 */
export function washDishes(state) {
  if (state.phase !== 'closing-dishes') return state;
  return { ...state, dirtyDishCount: 0, phase: 'closing-shutdown' };
}

/**
 * Shuts the restaurant down for the night. A no-op unless the shift is in
 * 'closing-shutdown'. Transitions to 'paycheck' — the boss's office becomes
 * reachable only once this has fired (enforced by the caller/UI, not this
 * module, which only tracks phase).
 *
 * @param {ShiftState} state
 * @returns {ShiftState}
 */
export function shutDown(state) {
  if (state.phase !== 'closing-shutdown') return state;
  return { ...state, phase: 'paycheck' };
}

/**
 * Restores sanity to `SANITY_MAX` — the Coffee Machine's effect. A no-op
 * unless the shift is in 'playing' (matching every other station action
 * in this module; there's nothing to restore during closing).
 *
 * @param {ShiftState} state
 * @returns {ShiftState}
 */
export function restoreSanity(state) {
  if (state.phase !== 'playing') return state;
  return { ...state, sanity: SANITY_MAX };
}
