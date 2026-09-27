// Pure, DOM-free shift-state management for Library Shift
// (docs/features/library-game.md's Business Rules / Validation, Scope, and
// User Flow). Mirrors Kitchen Shift's engine-state.js contract exactly: no
// DOM/canvas/localStorage/timer dependencies, so it can be unit-tested with
// `node --test` and imported unchanged by the canvas game loop
// (library-game.js, owned by a different agent). Every Return Cart/fines/
// borrow-request queue transition and phase change for a single in-progress
// shift lives here.
//
// State shape (`ShiftState`):
//   {
//     phase: 'not-started' | 'playing' | 'closing-wait' | 'paycheck',
//     shiftNumber: number,          // 1..SHIFTS_PER_MONTH
//     clockSeconds: number,         // remaining shift clock; only ticks down in 'playing'
//     totalClockSeconds: number,    // this shift's full countdown length (rules.js's shiftClockSecondsForShift)
//     closingWaitSecondsRemaining: number, // counts down from CLOSING_WAIT_SECONDS during 'closing-wait'; the Boss's Office is non-interactive until this hits 0
//
//     returnCart: Book[],           // books waiting to be picked up and shelved
//     carriedBook: Book | null,     // the one book currently being carried
//     shelfCheck: { kind: 'skill-check' | 'coin-hunt' } | null, // active once arriveAtShelf starts one
//
//     finesQueue: Fine[],           // fine-paying patrons waiting at the Front Desk
//     carriedFine: Fine | null,     // the payment currently being carried to the Fines Counter
//     finesSortActive: boolean,     // true once arriveAtFinesCounter starts the Fines Sort minigame
//
//     borrowQueue: BorrowRequest[], // borrow-request patrons waiting at the Front Desk
//     activeBorrow: BorrowRequest | null, // the one being fulfilled ('searching' | 'checkout' stage)
//
//     karen: {
//       shiftNumber: number,        // rules.js's karenShiftForSeed(seed) output for this save
//       active: boolean,            // true while her scripted event's short timer is running
//       triggered: boolean,         // true once startKarenEvent has fired this shift (never twice)
//       resolved: boolean,          // true once resolveKarenEvent (or an auto-resolved timeout) has fired
//       outcome: 'collectFine' | 'letItSlide' | null,
//       timerSecondsRemaining: number,
//     },
//
//     libraryMood: number,          // 0..LIBRARY_MOOD_MAX; the restaurant/library-reputation-equivalent stat — drains per mistake, scales patron patience
//     sanity: number,               // 0..SANITY_MAX; the PLAYER's own stat — drains passively + per mistake, scales walk speed. Distinct from libraryMood (see rules.js section 10).
//     mistakeCount: number,         // every failed Shelf/Checkout Skill-Check, failed Fines Sort, patience-timeout, or mishandled Karen event
//     bonusGard: number,            // Coin Hunt finds + banked fines + Karen's collected fine, accumulated this shift, added on top of shiftPaycheck() at payout
//     payout: number | null,        // set by finishClosing(): shiftPaycheck(mistakeCount) + bonusGard
//   }
//   Book = { id: string, genreId: string, isCoinHunt: boolean }
//   Fine = { id: string, amountGard: number }
//   BorrowRequest = {
//     id: string, bookId: string,
//     patienceRemainingSeconds: number, patienceMaxSeconds: number,
//     stage: 'searching' | 'checkout',
//   }
//
// This module never reads a clock itself — every function that needs a time
// delta takes it as an explicit argument, so behavior is fully deterministic
// and testable, matching Kitchen Shift's engine-state.js.
//
// Wrong-shelf handling (doc's Open Questions, resolved here): arriveAtShelf
// is a no-op if the carried book's genre doesn't match the shelf — it BLOCKS
// the skill-check from starting rather than counting as a mistake, matching
// the doc's stated preference and Kitchen Shift's dish-must-match-order
// strictness.
//
// Retry-on-failure (new to this game, no direct Kitchen Shift analog):
// failing a Shelf Skill-Check, Fines Sort, or Checkout Skill-Check counts as
// a mistake and drains libraryMood/sanity immediately, but leaves the
// player still holding the book/payment (or still in the checkout stage) so
// they can immediately re-attempt rather than losing the item outright —
// this game has no "customer walks out" consequence for those three steps,
// only for a borrow request's search-phase patience timing out (which does
// remove it, mirroring a Kitchen Shift patience timeout exactly).

import {
  shiftClockSecondsForShift,
  shiftPaycheck,
  LIBRARY_MOOD_MAX,
  LIBRARY_MOOD_DRAIN_PER_MISTAKE,
  clampLibraryMood,
  SANITY_MAX,
  SANITY_DRAIN_PER_SECOND,
  SANITY_DRAIN_PER_UPSET,
  clampSanity,
  KAREN_EVENT_TIMER_SECONDS,
  KAREN_FINE_AMOUNT_GARD,
  KAREN_MOOD_PENALTY,
  CLOSING_WAIT_SECONDS,
} from './rules.js';

export { LIBRARY_MOOD_MAX, SANITY_MAX };

/**
 * Builds a fresh shift-start state.
 *
 * @param {number} shiftNumber - 1..SHIFTS_PER_MONTH.
 * @param {number} karenShiftNumber - this save's rules.js `karenShiftForSeed(seed)` output, stored once per month/run.
 * @param {Partial<ShiftState>} [overrides]
 * @returns {ShiftState}
 */
export function createInitialState(shiftNumber, karenShiftNumber, overrides = {}) {
  const totalClockSeconds = shiftClockSecondsForShift(shiftNumber);
  return {
    phase: 'not-started',
    shiftNumber,
    clockSeconds: totalClockSeconds,
    totalClockSeconds,
    closingWaitSecondsRemaining: 0,

    returnCart: [],
    carriedBook: null,
    shelfCheck: null,

    finesQueue: [],
    carriedFine: null,
    finesSortActive: false,

    borrowQueue: [],
    activeBorrow: null,

    karen: {
      shiftNumber: karenShiftNumber,
      active: false,
      triggered: false,
      resolved: false,
      outcome: null,
      timerSecondsRemaining: 0,
    },

    libraryMood: LIBRARY_MOOD_MAX,
    sanity: SANITY_MAX,
    mistakeCount: 0,
    bonusGard: 0,
    payout: null,

    ...overrides,
  };
}

/**
 * Starts the shift: 'not-started' -> 'playing'. A no-op otherwise.
 *
 * @param {ShiftState} state
 * @returns {ShiftState}
 */
export function startShift(state) {
  if (state.phase !== 'not-started') return state;
  return { ...state, phase: 'playing' };
}

// ---------------------------------------------------------------------------
// Return Cart / shelving flow
// ---------------------------------------------------------------------------

/**
 * Delivers a new book onto the Return Cart. A no-op unless the shift is
 * 'playing'.
 *
 * @param {ShiftState} state
 * @param {{id: string, genreId: string, isCoinHunt: boolean}} book
 * @returns {ShiftState}
 */
export function addBookToCart(state, book) {
  if (state.phase !== 'playing') return state;
  return { ...state, returnCart: [...state.returnCart, book] };
}

/**
 * Picks up one book from the Return Cart to carry. A no-op if the shift
 * isn't 'playing', a book is already being carried, or no book with that id
 * is on the cart.
 *
 * @param {ShiftState} state
 * @param {string} bookId
 * @returns {ShiftState}
 */
export function pickUpBook(state, bookId) {
  if (state.phase !== 'playing' || state.carriedBook) return state;
  const book = state.returnCart.find((b) => b.id === bookId);
  if (!book) return state;

  return {
    ...state,
    returnCart: state.returnCart.filter((b) => b !== book),
    carriedBook: book,
  };
}

/**
 * Arriving at a shelf with a carried book. If `genreId` matches the carried
 * book's genre, starts the appropriate minigame (`shelfCheck.kind`:
 * 'coin-hunt' for a Coin Hunt book, 'skill-check' otherwise) — see the doc's
 * Scope: Coin Hunt books trigger the hidden-object search "before they can
 * be shelved" instead of the plain timing-bar check. A no-op (wrong shelf
 * BLOCKS the check from starting, per this file's header comment) if the
 * genre doesn't match, if there's no carried book, if a check is already
 * active, or if the shift isn't 'playing'.
 *
 * @param {ShiftState} state
 * @param {string} genreId
 * @returns {ShiftState}
 */
export function arriveAtShelf(state, genreId) {
  if (state.phase !== 'playing' || !state.carriedBook || state.shelfCheck) return state;
  if (state.carriedBook.genreId !== genreId) return state;

  return {
    ...state,
    shelfCheck: { kind: state.carriedBook.isCoinHunt ? 'coin-hunt' : 'skill-check' },
  };
}

function applyMistake(state) {
  return {
    mistakeCount: state.mistakeCount + 1,
    libraryMood: clampLibraryMood(state.libraryMood - LIBRARY_MOOD_DRAIN_PER_MISTAKE),
    sanity: clampSanity(state.sanity - SANITY_DRAIN_PER_UPSET),
  };
}

/**
 * Resolves an active Shelf Skill-Check. A no-op unless `state.shelfCheck` is
 * `{ kind: 'skill-check' }`. On success, the carried book is shelved
 * (cleared, along with `shelfCheck`). On failure, it counts as a mistake
 * (`mistakeCount`/`libraryMood`/`sanity` all move) but the player keeps
 * holding the book and `shelfCheck` clears back to `null` so they can
 * immediately re-attempt — see this file's header comment on retry-on-
 * failure.
 *
 * @param {ShiftState} state
 * @param {boolean} success
 * @returns {ShiftState}
 */
export function resolveShelfSkillCheck(state, success) {
  if (state.phase !== 'playing' || state.shelfCheck?.kind !== 'skill-check') return state;

  if (success) {
    return { ...state, carriedBook: null, shelfCheck: null };
  }
  return { ...state, shelfCheck: null, ...applyMistake(state) };
}

/**
 * Resolves an active Coin Hunt. A no-op unless `state.shelfCheck` is
 * `{ kind: 'coin-hunt' }`. Always completes the shelving (the doc's Business
 * Rules treat Coin Hunt decoys as non-punitive — there is no failure state,
 * only a found-Gard amount that can legitimately be 0 if the player missed
 * every item); `foundGard` is added to `bonusGard` on top of the shift's
 * base payout.
 *
 * @param {ShiftState} state
 * @param {number} foundGard - Gard value of every coin/bill actually found (negative/non-finite treated as 0).
 * @returns {ShiftState}
 */
export function resolveCoinHunt(state, foundGard) {
  if (state.phase !== 'playing' || state.shelfCheck?.kind !== 'coin-hunt') return state;

  const found = Number.isFinite(foundGard) && foundGard > 0 ? foundGard : 0;
  return {
    ...state,
    carriedBook: null,
    shelfCheck: null,
    bonusGard: state.bonusGard + found,
  };
}

// ---------------------------------------------------------------------------
// Fines counter flow
// ---------------------------------------------------------------------------

/**
 * A fine-paying patron arrives at the Front Desk. A no-op unless the shift
 * is 'playing'.
 *
 * @param {ShiftState} state
 * @param {{id: string, amountGard: number}} fine
 * @returns {ShiftState}
 */
export function addFineToQueue(state, fine) {
  if (state.phase !== 'playing') return state;
  return { ...state, finesQueue: [...state.finesQueue, fine] };
}

/**
 * Accepts one fine payment to carry to the Fines Counter. A no-op if the
 * shift isn't 'playing', a fine is already being carried, or no fine with
 * that id is queued.
 *
 * @param {ShiftState} state
 * @param {string} fineId
 * @returns {ShiftState}
 */
export function acceptFine(state, fineId) {
  if (state.phase !== 'playing' || state.carriedFine) return state;
  const fine = state.finesQueue.find((f) => f.id === fineId);
  if (!fine) return state;

  return {
    ...state,
    finesQueue: state.finesQueue.filter((f) => f !== fine),
    carriedFine: fine,
  };
}

/**
 * Arriving at the Fines Counter with a carried payment starts the Fines
 * Sort minigame. A no-op if there's no carried fine, one is already active,
 * or the shift isn't 'playing'.
 *
 * @param {ShiftState} state
 * @returns {ShiftState}
 */
export function arriveAtFinesCounter(state) {
  if (state.phase !== 'playing' || !state.carriedFine || state.finesSortActive) return state;
  return { ...state, finesSortActive: true };
}

/**
 * Resolves an active Fines Sort. A no-op unless `finesSortActive`. On
 * success, the carried fine's amount is banked into `bonusGard` and the
 * payment clears. On failure, it counts as a mistake but the player keeps
 * carrying the payment (retry-on-failure, same as resolveShelfSkillCheck).
 *
 * @param {ShiftState} state
 * @param {boolean} success
 * @returns {ShiftState}
 */
export function resolveFinesSort(state, success) {
  if (state.phase !== 'playing' || !state.finesSortActive) return state;

  if (success) {
    return {
      ...state,
      bonusGard: state.bonusGard + state.carriedFine.amountGard,
      carriedFine: null,
      finesSortActive: false,
    };
  }
  return { ...state, finesSortActive: false, ...applyMistake(state) };
}

// ---------------------------------------------------------------------------
// Borrowing flow — "Find the Book" (search among shelved decoys) then a
// Checkout Skill-Check, mirroring the Return Cart flow's shape (doc's
// Scope: "the mirror image of shelving").
// ---------------------------------------------------------------------------

/**
 * A borrow-request patron arrives at the Front Desk. A no-op unless the
 * shift is 'playing'.
 *
 * @param {ShiftState} state
 * @param {{id: string, bookId: string, patienceSeconds: number}} request
 * @returns {ShiftState}
 */
export function addBorrowRequest(state, request) {
  if (state.phase !== 'playing') return state;
  const patience = Number.isFinite(request.patienceSeconds) && request.patienceSeconds > 0 ? request.patienceSeconds : 0;

  return {
    ...state,
    borrowQueue: [...state.borrowQueue, {
      id: request.id,
      bookId: request.bookId,
      patienceRemainingSeconds: patience,
      patienceMaxSeconds: patience,
    }],
  };
}

/**
 * Accepts one borrow request to fulfill, starting its 'searching' stage
 * (the Find the Book minigame). A no-op if the shift isn't 'playing', a
 * request is already active, or no request with that id is queued.
 *
 * @param {ShiftState} state
 * @param {string} requestId
 * @returns {ShiftState}
 */
export function acceptBorrowRequest(state, requestId) {
  if (state.phase !== 'playing' || state.activeBorrow) return state;
  const request = state.borrowQueue.find((r) => r.id === requestId);
  if (!request) return state;

  return {
    ...state,
    borrowQueue: state.borrowQueue.filter((r) => r !== request),
    activeBorrow: { ...request, stage: 'searching' },
  };
}

/**
 * Resolves the active Find the Book search. A no-op unless
 * `activeBorrow?.stage === 'searching'`. `success: true` advances to the
 * 'checkout' stage (the Checkout Skill-Check). `success: false` (an
 * explicit forfeit, distinct from the patience timeout `tick` applies
 * automatically) fails the request exactly like a timeout: a mistake, and
 * the request is dropped rather than requeued — the patron gives up and
 * leaves, matching the doc's "failure... costs the patron's patience" (once
 * their patience/attempt is spent, it's spent).
 *
 * @param {ShiftState} state
 * @param {boolean} success
 * @returns {ShiftState}
 */
export function resolveFindTheBook(state, success) {
  if (state.phase !== 'playing' || state.activeBorrow?.stage !== 'searching') return state;

  if (success) {
    return { ...state, activeBorrow: { ...state.activeBorrow, stage: 'checkout' } };
  }
  return { ...state, activeBorrow: null, ...applyMistake(state) };
}

/**
 * Resolves the active Checkout Skill-Check. A no-op unless
 * `activeBorrow?.stage === 'checkout'`. On success, the loan completes and
 * `activeBorrow` clears. On failure, it counts as a mistake but the request
 * stays in the 'checkout' stage for an immediate retry (retry-on-failure,
 * same as resolveShelfSkillCheck/resolveFinesSort).
 *
 * @param {ShiftState} state
 * @param {boolean} success
 * @returns {ShiftState}
 */
export function resolveCheckoutSkillCheck(state, success) {
  if (state.phase !== 'playing' || state.activeBorrow?.stage !== 'checkout') return state;

  if (success) {
    return { ...state, activeBorrow: null };
  }
  return { ...state, ...applyMistake(state) };
}

// ---------------------------------------------------------------------------
// Karen's scripted event (doc's Scope/Open Questions, resolved here — see
// this file's report-back writeup for the full design rationale):
//
// A forced, two-outcome event with a short timer
// (rules.js's KAREN_EVENT_TIMER_SECONDS). It fires once, on
// `state.karen.shiftNumber` (rules.js's karenShiftForSeed(seed) for this
// save), when the caller decides the scripted beat should start (e.g. her
// slot in the Front Desk queue) via `startKarenEvent`. While active, the
// caller offers exactly two responses, resolved via `resolveKarenEvent`:
//
//   - 'collectFine' (handled well): the player successfully gets her to pay
//     the overdue fine after all — KAREN_FINE_AMOUNT_GARD is banked into
//     bonusGard, no libraryMood/sanity/mistake cost.
//   - 'letItSlide' (mishandled): she leaves without paying and the player
//     lets it go — counts as a mistake, and drains libraryMood by the
//     larger KAREN_MOOD_PENALTY (not the standard
//     LIBRARY_MOOD_DRAIN_PER_MISTAKE) on top of the usual sanity/mistake
//     hit, reflecting how much more disruptive her scripted outburst is.
//
// If the timer runs out before either is chosen, `tick` (below)
// auto-resolves it as 'letItSlide' — failing to act in time IS mishandling
// it, not a neutral third outcome.
// ---------------------------------------------------------------------------

/**
 * Starts Karen's scripted event. A no-op unless the shift is 'playing', the
 * current shift is `state.karen.shiftNumber`, and it hasn't already
 * triggered this run.
 *
 * @param {ShiftState} state
 * @returns {ShiftState}
 */
export function startKarenEvent(state) {
  if (state.phase !== 'playing') return state;
  if (state.karen.triggered || state.shiftNumber !== state.karen.shiftNumber) return state;

  return {
    ...state,
    karen: {
      ...state.karen,
      active: true,
      triggered: true,
      timerSecondsRemaining: KAREN_EVENT_TIMER_SECONDS,
    },
  };
}

function resolveKarenOutcome(state, outcome) {
  const karen = { ...state.karen, active: false, resolved: true, outcome };

  if (outcome === 'collectFine') {
    return { ...state, karen, bonusGard: state.bonusGard + KAREN_FINE_AMOUNT_GARD };
  }

  // 'letItSlide' — mishandled: a mistake, plus her outsized mood penalty on
  // top of the standard per-mistake sanity drain.
  return {
    ...state,
    karen,
    mistakeCount: state.mistakeCount + 1,
    libraryMood: clampLibraryMood(state.libraryMood - KAREN_MOOD_PENALTY),
    sanity: clampSanity(state.sanity - SANITY_DRAIN_PER_UPSET),
  };
}

/**
 * Resolves Karen's active event with the player's chosen outcome. A no-op
 * unless `karen.active`.
 *
 * @param {ShiftState} state
 * @param {'collectFine' | 'letItSlide'} outcome
 * @returns {ShiftState}
 */
export function resolveKarenEvent(state, outcome) {
  if (state.phase !== 'playing' || !state.karen.active) return state;
  return resolveKarenOutcome(state, outcome);
}

// ---------------------------------------------------------------------------
// Clock / phase progression
// ---------------------------------------------------------------------------

/**
 * Advances time for whichever phase the shift is currently in.
 *
 * During 'playing': advances the shift clock, the active borrow request's
 * search-phase patience (if any), and Karen's event timer (if active) by
 * `deltaSeconds`, and drains sanity passively (rules.js's
 * SANITY_DRAIN_PER_SECOND) — same as Kitchen Shift's tick. If the active
 * borrow request's patience reaches 0 while 'searching', it auto-fails
 * exactly like `resolveFindTheBook(state, false)` (a mistake, request
 * dropped) — the patron gave up waiting. If Karen's timer reaches 0 while
 * still active and unresolved, it auto-resolves as 'letItSlide' (mishandled
 * — see the section above). If the shift clock itself reaches 0, the phase
 * transitions to 'closing-wait' with a fresh `closingWaitSecondsRemaining`
 * (rules.js's CLOSING_WAIT_SECONDS) — in-flight interactions (a carried
 * book/fine, an active borrow request) are simply abandoned rather than
 * force-failed; only `mistakeCount`/`bonusGard` already accumulated feed the
 * payout. Sanity does not drain during 'closing-wait' (matches Kitchen
 * Shift's own closing sequence, where passive drain stops once the shift
 * clock itself has run out).
 *
 * During 'closing-wait': advances only `closingWaitSecondsRemaining`,
 * floored at 0. Reaching 0 does not itself change the phase — the Boss's
 * Office simply becomes enterable (see `isBossOfficeReady`); the transition
 * to 'paycheck' happens explicitly via `enterBossOffice`, matching the
 * doc's "walking in immediately triggers the paycheck" (a player action,
 * not a timer expiry).
 *
 * A no-op in every other phase.
 *
 * @param {ShiftState} state
 * @param {number} deltaSeconds - non-negative; negative/non-finite treated as 0.
 * @returns {ShiftState}
 */
export function tick(state, deltaSeconds) {
  if (state.phase !== 'playing' && state.phase !== 'closing-wait') return state;

  const delta = Number.isFinite(deltaSeconds) && deltaSeconds > 0 ? deltaSeconds : 0;

  if (state.phase === 'closing-wait') {
    return { ...state, closingWaitSecondsRemaining: Math.max(0, state.closingWaitSecondsRemaining - delta) };
  }

  let next = { ...state, sanity: clampSanity(state.sanity - SANITY_DRAIN_PER_SECOND * delta) };

  if (next.activeBorrow?.stage === 'searching') {
    const remaining = next.activeBorrow.patienceRemainingSeconds - delta;
    if (remaining <= 0) {
      next = { ...next, activeBorrow: null, ...applyMistake(next) };
    } else {
      next = { ...next, activeBorrow: { ...next.activeBorrow, patienceRemainingSeconds: remaining } };
    }
  }

  if (next.karen.active) {
    const remaining = next.karen.timerSecondsRemaining - delta;
    if (remaining <= 0) {
      next = resolveKarenOutcome(next, 'letItSlide');
    } else {
      next = { ...next, karen: { ...next.karen, timerSecondsRemaining: remaining } };
    }
  }

  const clockSeconds = Math.max(0, next.clockSeconds - delta);
  if (clockSeconds <= 0) {
    return { ...next, clockSeconds: 0, phase: 'closing-wait', closingWaitSecondsRemaining: CLOSING_WAIT_SECONDS };
  }
  return { ...next, clockSeconds };
}

/**
 * Whether the Boss's Office has finished its closing wait and can be
 * entered. Convenience wrapper around `closingWaitSecondsRemaining` so
 * callers don't have to know the phase name to check it.
 *
 * @param {ShiftState} state
 * @returns {boolean}
 */
export function isBossOfficeReady(state) {
  return state.phase === 'closing-wait' && state.closingWaitSecondsRemaining <= 0;
}

/**
 * Walking into the Boss's Office once the closing wait has elapsed: ends
 * the shift, 'closing-wait' -> 'paycheck', computing `payout` as
 * `shiftPaycheck(mistakeCount) + bonusGard`. No further confirmation step —
 * matches the doc's "walking in immediately triggers the paycheck." A no-op
 * unless `isBossOfficeReady(state)` (the office is locked/non-interactive
 * before the wait elapses, and this is also correctly a no-op in every
 * other phase).
 *
 * @param {ShiftState} state
 * @returns {ShiftState}
 */
export function enterBossOffice(state) {
  if (!isBossOfficeReady(state)) return state;
  return { ...state, phase: 'paycheck', payout: shiftPaycheck(state.mistakeCount) + state.bonusGard };
}

/**
 * Restores sanity to `SANITY_MAX` — the Coffee Machine's effect. A no-op
 * unless the shift is 'playing' (matching every other station action in
 * this module; there's nothing to restore during closing). No cooldown or
 * usage limit — mirrors Kitchen Shift's restoreSanity exactly.
 *
 * @param {ShiftState} state
 * @returns {ShiftState}
 */
export function restoreSanity(state) {
  if (state.phase !== 'playing') return state;
  return { ...state, sanity: SANITY_MAX };
}
