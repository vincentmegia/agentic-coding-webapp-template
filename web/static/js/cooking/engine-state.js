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
//     shiftUpset: boolean,      // latches true on any missed/wrong order — unchanged since v1
//     sanity: number,           // 0..SANITY_MAX; drains passively and per-upset, restored by the Coffee Machine
//     mistakeCount: number,     // v3.11: every missed order or wrong-dish serve, counted (not just latched) — see rules.js's shiftPaycheck()
//     reputation: number,       // v3.11: 0..REPUTATION_MAX; drains per mistake, scales every later order's patience — see rules.js's patienceMultiplierForReputation()
//     bonusGard: number,        // Gard earned on top of the base paycheck this shift (Karen's tip, perfect coffee) — see earnBonusGard()
//     zeroSanitySeconds: number,      // time spent at 0 Sanity this shift — rules.js's hallucinationPayMultiplier()
//     zeroReputationSeconds: number,  // time spent at 0 Reputation this shift — rules.js's reputationPayMultiplier()
//     reputationStormTimer: number,   // counts up to ZERO_REPUTATION_STORM_OUT_SECONDS while Reputation is 0
//     complaints: number,       // complaint letters received at 0 Reputation (−COMPLAINT_GARD each)
//     stormOuts: number,        // customers who stormed out at 0 Reputation
//   }
//   Order = {
//     tableId: number, dishName: string,
//     patienceRemainingSeconds: number, patienceMaxSeconds: number,
//     customerSanityRemaining: number, // v3.18: 0..CUSTOMER_SANITY_MAX; drains per "annoyance" (re-visiting before serving, or a wrong-dish serve) — see annoyCustomer()
//   }
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
  REPUTATION_MAX,
  REPUTATION_DRAIN_PER_MISTAKE,
  clampReputation,
  CUSTOMER_SANITY_MAX,
  CUSTOMER_SANITY_DRAIN_PER_ANNOYANCE,
  clampCustomerSanity,
  shiftPaycheck,
  COFFEE_SANITY_RESTORE,
  COFFEE_PERFECT_TIP_GARD,
  HALLUCINATION_STARTLE_SANITY,
  hallucinationPayMultiplier,
  ZERO_REPUTATION_STORM_OUT_SECONDS,
  COMPLAINT_INTERVAL_SECONDS,
  COMPLAINT_GARD,
  reputationPayMultiplier,
} from './rules.js';

export { SHIFT_CLOCK_SECONDS, SANITY_MAX, REPUTATION_MAX };

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
    mistakeCount: 0,
    reputation: REPUTATION_MAX,
    bonusGard: 0,
    zeroSanitySeconds: 0,
    zeroReputationSeconds: 0,
    reputationStormTimer: 0,
    complaints: 0,
    stormOuts: 0,
    ...overrides,
  };
}

/**
 * Seats a new order at `tableId`. A no-op (returns `state` unchanged) if
 * the shift isn't in 'playing', the table is already occupied, or the
 * queue is already at `maxOrders` (the caller passes
 * `rules.js`'s `tableCapacity(extraTableServiceLevel)` here — this module
 * knows nothing about gear). `patienceSeconds` is expected to already have
 * `rules.js`'s `patienceMultiplierForReputation(state.reputation)` folded
 * in by the caller (alongside any Karen/Mel adjustment) — it's stored
 * verbatim as both the countdown and `patienceMaxSeconds` (the order's
 * fixed reference point for rendering a patience-remaining fraction later,
 * so that doesn't drift if reputation changes again before this order
 * resolves). The order also starts with a fresh `customerSanityRemaining`
 * at `CUSTOMER_SANITY_MAX` (v3.18) — see `annoyCustomer()`.
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
    orders: [...state.orders, {
      tableId,
      dishName,
      patienceRemainingSeconds: patience,
      patienceMaxSeconds: patience,
      customerSanityRemaining: CUSTOMER_SANITY_MAX,
    }],
    tables: { ...state.tables, [tableId]: { ...table, occupied: true } },
  };
}

/**
 * Serves `dishName` at `tableId`. If an active order at that table matches
 * the dish: the order clears, the table frees up (occupied -> false) and
 * gets marked dirty, and the sink's dirty-dish count increments — no
 * change to `shiftUpset`/`mistakeCount`/`reputation`. Otherwise (no active
 * order there, or the dish doesn't match): latches `shiftUpset = true`,
 * increments `mistakeCount`, drains `SANITY_DRAIN_PER_UPSET` sanity and
 * `REPUTATION_DRAIN_PER_MISTAKE` reputation (v3.11 — see rules.js's
 * `shiftPaycheck`/`patienceMultiplierForReputation`), and leaves the order
 * (if any) in place — the customer is still waiting (doc's Testing Plan:
 * "does not clear the order from the queue"). A no-op (state unchanged) if
 * the shift isn't in 'playing'.
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

  return {
    ...state,
    shiftUpset: true,
    mistakeCount: state.mistakeCount + 1,
    sanity: clampSanity(state.sanity - SANITY_DRAIN_PER_UPSET),
    reputation: clampReputation(state.reputation - REPUTATION_DRAIN_PER_MISTAKE),
  };
}

/**
 * Force-fails whichever order (if any) is currently active at `tableId` —
 * removed from the queue, table freed and marked dirty, `shiftUpset`
 * latched, `mistakeCount`/reputation drained same as any other mistake
 * (v3.11) — exactly like a patience timeout, but triggered directly by the
 * caller rather than a clock tick. Used for the Karen event's ripple
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
    mistakeCount: state.mistakeCount + 1,
    sanity: clampSanity(state.sanity - SANITY_DRAIN_PER_UPSET),
    reputation: clampReputation(state.reputation - REPUTATION_DRAIN_PER_MISTAKE),
  };
}

/**
 * One "annoyance" at `tableId`'s active order — the food server re-visiting
 * an already-ordered table before serving it, or serving the wrong dish
 * (both driven from cooking-game.js, not this module). Drains that order's
 * `customerSanityRemaining` by `CUSTOMER_SANITY_DRAIN_PER_ANNOYANCE`; if it
 * bottoms out at 0, the order fails exactly like a patience timeout —
 * delegates to `failOrderAt` for those identical consequences (order
 * removed, table freed dirty, `shiftUpset` latched, `mistakeCount`/sanity/
 * reputation drained) rather than duplicating that logic. A no-op if the
 * shift isn't in 'playing' or there's no active order at that table.
 *
 * @param {ShiftState} state
 * @param {number} tableId
 * @returns {ShiftState}
 */
export function annoyCustomer(state, tableId) {
  if (state.phase !== 'playing') return state;
  const order = state.orders.find((o) => o.tableId === tableId);
  if (!order) return state;

  const nextSanity = clampCustomerSanity(order.customerSanityRemaining - CUSTOMER_SANITY_DRAIN_PER_ANNOYANCE);
  if (nextSanity <= 0) return failOrderAt(state, tableId);

  return {
    ...state,
    orders: state.orders.map((o) => (o === order ? { ...o, customerSanityRemaining: nextSanity } : o)),
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
 * `shiftUpset` latches true, `mistakeCount`/reputation drain (v3.11) — all
 * without player input, per the doc's User Flow step 7. If the shift clock
 * itself reaches 0 while still 'playing', every remaining queued order
 * likewise auto-fails and the phase transitions to 'closing-clean'. A
 * no-op if the shift isn't in 'playing' (the clock/patience only run
 * during actual play).
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
  let mistakeCount = state.mistakeCount;
  // Passive drain applies every tick regardless of what else happens this
  // frame; each upset event below adds its own extra drain on top.
  let sanity = clampSanity(state.sanity - SANITY_DRAIN_PER_SECOND * delta);
  // Reputation, unlike sanity, only ever moves on a mistake — no passive drain.
  let reputation = state.reputation;

  const expired = orders.filter((o) => o.patienceRemainingSeconds <= 0);
  for (const order of expired) {
    const result = failOrder({ orders, tables }, order);
    orders = result.orders;
    tables = result.tables;
    shiftUpset = true;
    mistakeCount += 1;
    sanity = clampSanity(sanity - SANITY_DRAIN_PER_UPSET);
    reputation = clampReputation(reputation - REPUTATION_DRAIN_PER_MISTAKE);
  }

  // Time spent at 0 Sanity — only the part of this tick after it actually
  // hit zero, so a single big tick doesn't over-count (Library Shift's
  // same accounting).
  let zeroSanitySeconds = state.zeroSanitySeconds ?? 0;
  if (sanity <= 0) {
    const secondsToZero = Math.max(0, state.sanity) / SANITY_DRAIN_PER_SECOND;
    zeroSanitySeconds += Math.max(0, delta - secondsToZero);
  }

  // 0 Reputation penalties (rules.js section 14): pay-cut time, complaint
  // letters, and storm-outs of whoever is closest to giving up anyway.
  let zeroReputationSeconds = state.zeroReputationSeconds ?? 0;
  let complaints = state.complaints ?? 0;
  let stormOuts = state.stormOuts ?? 0;
  let reputationStormTimer = 0;
  if (reputation <= 0) {
    zeroReputationSeconds += delta;
    complaints = Math.max(complaints, Math.floor(zeroReputationSeconds / COMPLAINT_INTERVAL_SECONDS));
    let timer = (state.reputationStormTimer ?? 0) + delta;
    while (timer >= ZERO_REPUTATION_STORM_OUT_SECONDS) {
      if (orders.length === 0) {
        // Nobody to storm out yet — the next customer to order is first in line.
        timer = ZERO_REPUTATION_STORM_OUT_SECONDS;
        break;
      }
      const leaving = orders.reduce((a, b) => (b.patienceRemainingSeconds < a.patienceRemainingSeconds ? b : a));
      const result = failOrder({ orders, tables }, leaving);
      orders = result.orders;
      tables = result.tables;
      shiftUpset = true;
      mistakeCount += 1;
      stormOuts += 1;
      sanity = clampSanity(sanity - SANITY_DRAIN_PER_UPSET);
      timer -= ZERO_REPUTATION_STORM_OUT_SECONDS;
    }
    reputationStormTimer = timer;
  }
  const penaltyFields = { zeroSanitySeconds, zeroReputationSeconds, reputationStormTimer, complaints, stormOuts };

  const clockSeconds = Math.max(0, state.clockSeconds - delta);

  if (clockSeconds <= 0) {
    for (const order of orders) {
      const result = failOrder({ orders, tables }, order);
      orders = result.orders;
      tables = result.tables;
      shiftUpset = true;
      mistakeCount += 1;
      sanity = clampSanity(sanity - SANITY_DRAIN_PER_UPSET);
      reputation = clampReputation(reputation - REPUTATION_DRAIN_PER_MISTAKE);
    }
    // If every table already happens to be clean (e.g. an idle shift with
    // no orders ever served), 'closing-clean' has nothing left for the
    // player to clean and cleanTable() below would never fire to check
    // that — skip straight past it rather than soft-locking the shift.
    const phase = allTablesClean(tables) ? 'closing-dishes' : 'closing-clean';
    return { ...state, ...penaltyFields, clockSeconds: 0, orders, tables, shiftUpset, mistakeCount, sanity, reputation, phase };
  }

  return { ...state, ...penaltyFields, clockSeconds, orders, tables, shiftUpset, mistakeCount, sanity, reputation };
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

/**
 * Applies one Coffee Pour result (rules.js's gradeCoffeePour) — Sanity
 * changes by COFFEE_SANITY_RESTORE[grade] (a spill *drains* it), and a
 * perfect pour tips COFFEE_PERFECT_TIP_GARD into `bonusGard`. An unknown
 * grade counts as 'sloppy'. A no-op outside 'playing'.
 *
 * @param {ShiftState} state
 * @param {'perfect'|'good'|'sloppy'|'spilled'} grade
 * @returns {ShiftState}
 */
export function brewCoffee(state, grade) {
  if (state.phase !== 'playing') return state;
  const restore = COFFEE_SANITY_RESTORE[grade] ?? COFFEE_SANITY_RESTORE.sloppy;
  return {
    ...state,
    sanity: clampSanity(state.sanity + restore),
    bonusGard: (state.bonusGard ?? 0) + (grade === 'perfect' ? COFFEE_PERFECT_TIP_GARD : 0),
  };
}

/**
 * Adds `amount` Gard to this shift's `bonusGard` (paid on top of the base
 * paycheck at Duke's office) — e.g. Karen's tip. Non-positive/non-finite
 * amounts are ignored. Works in any phase: a tip earned during play is
 * still owed if the clock runs out before payday.
 *
 * @param {ShiftState} state
 * @param {number} amount
 * @returns {ShiftState}
 */
export function earnBonusGard(state, amount) {
  if (!Number.isFinite(amount) || amount <= 0) return state;
  return { ...state, bonusGard: (state.bonusGard ?? 0) + amount };
}

/**
 * Walking up to a ghost customer and finding nobody there: a jolt of fear
 * (−HALLUCINATION_STARTLE_SANITY), not a mistake. A no-op outside 'playing'.
 *
 * @param {ShiftState} state
 * @returns {ShiftState}
 */
export function startleFromHallucination(state) {
  if (state.phase !== 'playing') return state;
  return { ...state, sanity: clampSanity(state.sanity - HALLUCINATION_STARTLE_SANITY) };
}

/**
 * The shift's payout at Duke's office, Library Shift's formula: flat Gard
 * first (base paycheck for the mistake count, plus bonus Gard, minus
 * complaint letters, floored at 0), then the 0-Sanity and 0-Reputation
 * pay-cut multipliers. Returns the parts too, for the paycheck screen.
 *
 * @param {ShiftState} state
 * @returns {{base: number, bonusGard: number, complaintGard: number, sanityMultiplier: number, reputationMultiplier: number, payout: number}}
 */
export function shiftPayout(state) {
  const base = shiftPaycheck(state.mistakeCount);
  const bonusGard = state.bonusGard ?? 0;
  const complaintGard = (state.complaints ?? 0) * COMPLAINT_GARD;
  const gross = Math.max(0, base + bonusGard - complaintGard);
  const sanityMultiplier = hallucinationPayMultiplier(state.zeroSanitySeconds);
  const reputationMultiplier = reputationPayMultiplier(state.zeroReputationSeconds);
  return {
    base,
    bonusGard,
    complaintGard,
    sanityMultiplier,
    reputationMultiplier,
    payout: Math.round(gross * sanityMultiplier * reputationMultiplier),
  };
}
