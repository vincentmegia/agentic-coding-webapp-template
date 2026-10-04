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
//     rating: number,               // v2.9: 0..RATING_MAX stars; −RATING_PENALTY_PER_WALKOUT per patron who walks out; scales the payout
//     unshelvedAtClose: number,     // v2.18: books on the cart/in hand when the clock ran out (UNSHELVED_BOOK_PENALTY_GARD each)
//     zeroMoodSeconds: number,      // v2.17: seconds at 0 Library Mood this shift (cuts pay — moodPayMultiplier)
//     moodStormTimer: number,       // v2.17: seconds toward the next 0-Mood storm-out
//     complaints: number,           // v2.17: complaint letters this shift (COMPLAINT_GARD each, off the payout)
//     zeroSanitySeconds: number,    // v2.16: seconds spent at 0 Sanity this shift (cuts pay — rules.js's hallucinationPayMultiplier)
//     readingCooldownSeconds: number, // v2.10: seconds until the Reading Nook can be used again (0 = ready)
//     walkouts: number,             // v2.9: patrons who left after waiting too long this shift
//     (queued Fine/BorrowRequest entries carry waitRemainingSeconds/waitMaxSeconds — null = no wait timer)
//
//     finesQueue: Fine[],           // fine-paying patrons waiting at the Fines Counter (v2.4; previously the Front Desk)
//     activeFine: Fine | null,      // the patron whose payment is being collected in the Fines Sort minigame
//     finesSortActive: boolean,     // true once arriveAtFinesCounter starts the Fines Sort minigame
//     carriedFine: Fine | null,     // a collected payment being carried to the Front Desk till
//     tillCountActive: boolean,     // true once arriveAtFrontDeskWithFine starts the Count the Till minigame
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
  patienceMultiplierForLibraryMood,
  SANITY_MAX,
  SANITY_DRAIN_PER_SECOND,
  SANITY_DRAIN_PER_UPSET,
  clampSanity,
  KAREN_EVENT_TIMER_SECONDS,
  KAREN_FINE_AMOUNT_GARD,
  KAREN_MOOD_PENALTY,
  CLOSING_WAIT_SECONDS,
  COFFEE_SANITY_RESTORE,
  COFFEE_PERFECT_TIP_GARD,
  RATING_MAX,
  RATING_PENALTY_PER_WALKOUT,
  clampRating,
  paycheckMultiplierForRating,
  READING_MOOD_RESTORE,
  READING_COOLDOWN_SECONDS,
  HALLUCINATION_STARTLE_SANITY,
  hallucinationPayMultiplier,
  moodPayMultiplier,
  ZERO_MOOD_STORM_OUT_SECONDS,
  COMPLAINT_INTERVAL_SECONDS,
  COMPLAINT_GARD,
  SHELVED_BOOK_TIP_GARD,
  UNSHELVED_BOOK_PENALTY_GARD,
  MESSY_CART_THRESHOLD,
  MESSY_CART_MOOD_DRAIN_PER_SECOND,
} from './rules.js';

export { LIBRARY_MOOD_MAX, SANITY_MAX, RATING_MAX };

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

    rating: RATING_MAX,
    walkouts: 0,
    readingCooldownSeconds: 0,
    zeroSanitySeconds: 0,
    zeroMoodSeconds: 0,
    unshelvedAtClose: 0,
    moodStormTimer: 0,
    complaints: 0,

    finesQueue: [],
    activeFine: null,
    finesSortActive: false,
    carriedFine: null,
    tillCountActive: false,

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

/**
 * Removes the queued patron (borrow or fine line) with the least wait left
 * — the one closest to giving up anyway. Returns null if nobody is queued.
 */
function stormOutLongestWaiting(state) {
  const remaining = (entry) => entry.waitRemainingSeconds ?? Infinity;
  const candidates = [
    ...state.borrowQueue.map((e, i) => ({ queue: 'borrowQueue', i, left: remaining(e) })),
    ...state.finesQueue.map((e, i) => ({ queue: 'finesQueue', i, left: remaining(e) })),
  ];
  if (candidates.length === 0) return null;
  const target = candidates.reduce((a, b) => (b.left < a.left ? b : a));
  return { ...state, [target.queue]: state[target.queue].filter((_, i) => i !== target.i) };
}

/** A patron walked out after waiting too long (v2.9): costs stars. */
function applyWalkout(state) {
  return {
    rating: clampRating(state.rating - RATING_PENALTY_PER_WALKOUT),
    walkouts: state.walkouts + 1,
  };
}

/** Wait-timer fields for a newly queued patron: `waitSeconds` scaled by Library Mood at arrival, or no timer when omitted. */
function initialWait(state, waitSeconds) {
  if (!Number.isFinite(waitSeconds) || waitSeconds <= 0) return { waitRemainingSeconds: null, waitMaxSeconds: null };
  const seconds = waitSeconds * patienceMultiplierForLibraryMood(state.libraryMood);
  return { waitRemainingSeconds: seconds, waitMaxSeconds: seconds };
}

/** Counts down every queued patron's wait timer; returns the survivors and how many walked out. */
function tickQueue(queue, delta) {
  let walkedOut = 0;
  const kept = [];
  for (const entry of queue) {
    if (entry.waitRemainingSeconds == null) { kept.push(entry); continue; }
    const remaining = entry.waitRemainingSeconds - delta;
    if (remaining <= 0) walkedOut++;
    else kept.push({ ...entry, waitRemainingSeconds: remaining });
  }
  return { kept, walkedOut };
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
    return { ...state, carriedBook: null, shelfCheck: null, bonusGard: state.bonusGard + SHELVED_BOOK_TIP_GARD };
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
    bonusGard: state.bonusGard + found + SHELVED_BOOK_TIP_GARD,
  };
}

// ---------------------------------------------------------------------------
// Fines counter flow
// ---------------------------------------------------------------------------

/**
 * A fine-paying patron arrives and queues at the Fines Counter (v2.4 — they
 * used to queue at the Front Desk). A no-op unless the shift is 'playing'.
 *
 * @param {ShiftState} state
 * @param {{id: string, amountGard: number, waitSeconds?: number}} fine - `waitSeconds`: how long they'll wait in line (rules.js's queueWaitSecondsForShift), scaled by mood; omitted = no wait timer.
 * @returns {ShiftState}
 */
export function addFineToQueue(state, fine) {
  if (state.phase !== 'playing') return state;
  const { waitSeconds, ...rest } = fine;
  return { ...state, finesQueue: [...state.finesQueue, { ...rest, ...initialWait(state, waitSeconds) }] };
}

/**
 * Arriving at the Fines Counter starts collecting the first queued
 * patron's payment (the Fines Sort minigame). A no-op if the shift isn't
 * 'playing', a sort is already active, the player is still carrying an
 * earlier payment (it has to reach the till first), or nobody is queued.
 *
 * @param {ShiftState} state
 * @returns {ShiftState}
 */
export function arriveAtFinesCounter(state) {
  if (state.phase !== 'playing' || state.finesSortActive || state.carriedFine || state.finesQueue.length === 0) return state;
  const [fine, ...rest] = state.finesQueue;
  return { ...state, finesQueue: rest, activeFine: fine, finesSortActive: true };
}

/**
 * Resolves an active Fines Sort. On success the player now carries the
 * patron's payment (to take to the Front Desk till) and the patron leaves.
 * On failure it counts as a mistake and the patron steps back to the front
 * of the queue to try again.
 *
 * @param {ShiftState} state
 * @param {boolean} success
 * @returns {ShiftState}
 */
export function resolveFinesSort(state, success) {
  if (state.phase !== 'playing' || !state.finesSortActive) return state;
  if (success) {
    return { ...state, carriedFine: state.activeFine, activeFine: null, finesSortActive: false };
  }
  return {
    ...state,
    finesQueue: [state.activeFine, ...state.finesQueue],
    activeFine: null,
    finesSortActive: false,
    ...applyMistake(state),
  };
}

/**
 * Arriving at the Front Desk while carrying a collected payment starts the
 * Count the Till minigame. A no-op without a carried fine, if one is
 * already being counted, or if the shift isn't 'playing'.
 *
 * @param {ShiftState} state
 * @returns {ShiftState}
 */
export function arriveAtFrontDeskWithFine(state) {
  if (state.phase !== 'playing' || !state.carriedFine || state.tillCountActive) return state;
  return { ...state, tillCountActive: true };
}

/**
 * Resolves a Count the Till attempt. An exact count banks the payment into
 * `bonusGard`, ending the flow. A miscount (over the amount) counts as a
 * mistake, but the till stays open with the payment still in hand, for an
 * immediate recount (retry-on-failure, same as resolveShelfSkillCheck).
 *
 * @param {ShiftState} state
 * @param {boolean} success
 * @returns {ShiftState}
 */
export function resolveTillCount(state, success) {
  if (state.phase !== 'playing' || !state.tillCountActive) return state;
  if (success) {
    return {
      ...state,
      bonusGard: state.bonusGard + state.carriedFine.amountGard,
      carriedFine: null,
      tillCountActive: false,
    };
  }
  return { ...state, ...applyMistake(state) };
}

// ---------------------------------------------------------------------------
// Borrowing flow — "Find the Book" (search among shelved decoys) then a
// Checkout Skill-Check, mirroring the Return Cart flow's shape (doc's
// Scope: "the mirror image of shelving").
// ---------------------------------------------------------------------------

/**
 * A borrow-request patron arrives at the Front Desk. A no-op unless the
 * shift is 'playing'. Their patience is `request.patienceSeconds` scaled by
 * `patienceMultiplierForLibraryMood(state.libraryMood)` *at arrival*: a
 * tense library (low mood, from earlier mistakes) means less patient
 * patrons. Patrons already queued keep the patience they arrived with, the
 * same fold-in-at-spawn shape as Kitchen Shift's
 * patienceMultiplierForReputation.
 *
 * @param {ShiftState} state
 * @param {{id: string, bookId: string, patienceSeconds: number, waitSeconds?: number}} request - `waitSeconds`: how long they'll wait in line before being accepted (scaled by mood; omitted = no timer); `patienceSeconds`: the search phase after accepting.
 * @returns {ShiftState}
 */
export function addBorrowRequest(state, request) {
  if (state.phase !== 'playing') return state;
  const base = Number.isFinite(request.patienceSeconds) && request.patienceSeconds > 0 ? request.patienceSeconds : 0;
  const patience = base * patienceMultiplierForLibraryMood(state.libraryMood);

  return {
    ...state,
    borrowQueue: [...state.borrowQueue, {
      id: request.id,
      bookId: request.bookId,
      patienceRemainingSeconds: patience,
      patienceMaxSeconds: patience,
      ...initialWait(state, request.waitSeconds),
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
 * @param {{pauseBorrowPatience?: boolean}} [options] - pause a searching borrow request's patience (while Find the Book is open).
 * @returns {ShiftState}
 */
export function tick(state, deltaSeconds, { pauseBorrowPatience = false } = {}) {
  if (state.phase !== 'playing' && state.phase !== 'closing-wait') return state;

  const delta = Number.isFinite(deltaSeconds) && deltaSeconds > 0 ? deltaSeconds : 0;

  if (state.phase === 'closing-wait') {
    return { ...state, closingWaitSecondsRemaining: Math.max(0, state.closingWaitSecondsRemaining - delta) };
  }

  let next = {
    ...state,
    sanity: clampSanity(state.sanity - SANITY_DRAIN_PER_SECOND * delta),
    readingCooldownSeconds: Math.max(0, (state.readingCooldownSeconds ?? 0) - delta),
  };
  if (next.sanity <= 0) {
    // Only the part of this tick after Sanity actually reached 0 counts.
    const secondsToZero = Math.max(0, state.sanity) / SANITY_DRAIN_PER_SECOND;
    next.zeroSanitySeconds = (state.zeroSanitySeconds ?? 0) + Math.max(0, delta - secondsToZero);
  }

  // `pauseBorrowPatience`: the caller passes true while the Find the Book
  // minigame is open (v2.7), so the patron's patience never runs out
  // mid-search and closes the minigame with nothing to show for it.
  if (next.activeBorrow?.stage === 'searching' && !pauseBorrowPatience) {
    const remaining = next.activeBorrow.patienceRemainingSeconds - delta;
    if (remaining <= 0) {
      next = { ...next, activeBorrow: null, ...applyMistake(next) };
      next = { ...next, ...applyWalkout(next) };
    } else {
      next = { ...next, activeBorrow: { ...next.activeBorrow, patienceRemainingSeconds: remaining } };
    }
  }

  // v2.18: a messy cart (too many unshelved returns) drains Library Mood.
  if (next.returnCart.length > MESSY_CART_THRESHOLD) {
    next = { ...next, libraryMood: clampLibraryMood(next.libraryMood - MESSY_CART_MOOD_DRAIN_PER_SECOND * delta) };
  }

  // v2.17 zero-Mood penalties: pay-cut clock, storm-outs, complaint letters.
  if (next.libraryMood <= 0) {
    const zeroMood = (state.zeroMoodSeconds ?? 0) + delta;
    const complaints = Math.floor(zeroMood / COMPLAINT_INTERVAL_SECONDS);
    next = { ...next, zeroMoodSeconds: zeroMood, complaints: Math.max(next.complaints ?? 0, complaints) };
    let timer = (state.moodStormTimer ?? 0) + delta;
    while (timer >= ZERO_MOOD_STORM_OUT_SECONDS) {
      const stormed = stormOutLongestWaiting(next);
      if (!stormed) { timer = ZERO_MOOD_STORM_OUT_SECONDS; break; } // nobody in line: the next arrival storms out right away
      next = { ...stormed, ...applyWalkout(stormed) };
      timer -= ZERO_MOOD_STORM_OUT_SECONDS;
    }
    next.moodStormTimer = timer;
  } else {
    next.moodStormTimer = 0;
  }

  // Queued patrons (not yet being helped) walk out when their wait runs out.
  const borrows = tickQueue(next.borrowQueue, delta);
  const fines = tickQueue(next.finesQueue, delta);
  next = { ...next, borrowQueue: borrows.kept, finesQueue: fines.kept };
  for (let i = 0; i < borrows.walkedOut + fines.walkedOut; i++) next = { ...next, ...applyWalkout(next) };

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
    // v2.18: whatever's still unshelved at closing is docked at payout.
    const unshelvedAtClose = next.returnCart.length + (next.carriedBook ? 1 : 0);
    return { ...next, clockSeconds: 0, phase: 'closing-wait', closingWaitSecondsRemaining: CLOSING_WAIT_SECONDS, unshelvedAtClose };
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
  // v2.9: the star rating scales the whole payout (5★ = 100%).
  // v2.16: time spent at 0 Sanity (hallucinating) cuts it further.
  // v2.17: complaint letters come off the gross, 0-Mood time cuts it too.
  const gross = Math.max(0, shiftPaycheck(state.mistakeCount) + state.bonusGard
    - (state.complaints ?? 0) * COMPLAINT_GARD
    - (state.unshelvedAtClose ?? 0) * UNSHELVED_BOOK_PENALTY_GARD);
  const multiplier = paycheckMultiplierForRating(state.rating)
    * hallucinationPayMultiplier(state.zeroSanitySeconds)
    * moodPayMultiplier(state.zeroMoodSeconds);
  return { ...state, phase: 'paycheck', payout: Math.round(gross * multiplier) };
}

/**
 * Applies a finished Coffee Pour (rules.js's `gradeCoffeePour` grade) —
 * the Coffee Machine's effect since v2.2. Adds that grade's
 * `COFFEE_SANITY_RESTORE` amount to Sanity (clamped; a perfect pour always
 * refills to full), and a perfect pour also banks a
 * `COFFEE_PERFECT_TIP_GARD` tip into `bonusGard`. An unknown grade is
 * treated as 'sloppy'. A no-op unless the shift is 'playing'. Still no
 * cooldown or usage limit, same as the original instant refill.
 *
 * @param {ShiftState} state
 * @param {'perfect' | 'good' | 'sloppy' | 'spilled'} grade
 * @returns {ShiftState}
 */
export function brewCoffee(state, grade) {
  if (state.phase !== 'playing') return state;
  const restore = COFFEE_SANITY_RESTORE[grade] ?? COFFEE_SANITY_RESTORE.sloppy;
  return {
    ...state,
    sanity: clampSanity(state.sanity + restore),
    bonusGard: state.bonusGard + (grade === 'perfect' ? COFFEE_PERFECT_TIP_GARD : 0),
  };
}

/**
 * Whether the Reading Nook is usable right now: the shift is 'playing'
 * and its cooldown has elapsed.
 *
 * @param {ShiftState} state
 * @returns {boolean}
 */
export function canReadBook(state) {
  return state.phase === 'playing' && (state.readingCooldownSeconds ?? 0) <= 0;
}

/**
 * Finishing a book at the Reading Nook (v2.10): restores
 * READING_MOOD_RESTORE Library Mood (clamped) and starts the nook's
 * READING_COOLDOWN_SECONDS cooldown. A no-op unless `canReadBook`.
 *
 * @param {ShiftState} state
 * @returns {ShiftState}
 */
export function finishReading(state) {
  if (!canReadBook(state)) return state;
  return {
    ...state,
    libraryMood: clampLibraryMood(state.libraryMood + READING_MOOD_RESTORE),
    readingCooldownSeconds: READING_COOLDOWN_SECONDS,
  };
}

/**
 * Hallucination "dropped book" (v2.16): the carried book slips back onto
 * the front of the Return Cart. A no-op without a carried book, while a
 * shelf check is underway, or outside 'playing'.
 *
 * @param {ShiftState} state
 * @returns {ShiftState}
 */
export function dropCarriedBook(state) {
  if (state.phase !== 'playing' || !state.carriedBook || state.shelfCheck) return state;
  return { ...state, returnCart: [state.carriedBook, ...state.returnCart], carriedBook: null };
}

/**
 * Walking up to a ghost patron and finding no one there (v2.16): a small
 * Sanity hit (HALLUCINATION_STARTLE_SANITY). Not a mistake. A no-op
 * outside 'playing'.
 *
 * @param {ShiftState} state
 * @returns {ShiftState}
 */
export function startleFromHallucination(state) {
  if (state.phase !== 'playing') return state;
  return { ...state, sanity: clampSanity(state.sanity - HALLUCINATION_STARTLE_SANITY) };
}
