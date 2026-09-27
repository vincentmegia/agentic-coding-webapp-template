import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createInitialState,
  startShift,
  addBookToCart,
  pickUpBook,
  arriveAtShelf,
  resolveShelfSkillCheck,
  resolveCoinHunt,
  addFineToQueue,
  acceptFine,
  arriveAtFinesCounter,
  resolveFinesSort,
  addBorrowRequest,
  acceptBorrowRequest,
  resolveFindTheBook,
  resolveCheckoutSkillCheck,
  startKarenEvent,
  resolveKarenEvent,
  tick,
  isBossOfficeReady,
  enterBossOffice,
  restoreSanity,
  LIBRARY_MOOD_MAX,
  SANITY_MAX,
} from './engine-state.js';
import {
  shiftClockSecondsForShift,
  shiftPaycheck,
  LIBRARY_MOOD_DRAIN_PER_MISTAKE,
  KAREN_EVENT_TIMER_SECONDS,
  KAREN_FINE_AMOUNT_GARD,
  KAREN_MOOD_PENALTY,
  CLOSING_WAIT_SECONDS,
  SANITY_DRAIN_PER_UPSET,
} from './rules.js';

const SHIFT_1 = 1;
const KAREN_SHIFT = 12;

function playingState(overrides = {}) {
  return startShift(createInitialState(SHIFT_1, KAREN_SHIFT, overrides));
}

describe('createInitialState', () => {
  test('defaults to not-started, a full clock, empty queues, full mood/sanity, no mistakes', () => {
    const state = createInitialState(SHIFT_1, KAREN_SHIFT);
    assert.equal(state.phase, 'not-started');
    assert.equal(state.clockSeconds, shiftClockSecondsForShift(SHIFT_1));
    assert.equal(state.totalClockSeconds, shiftClockSecondsForShift(SHIFT_1));
    assert.equal(state.closingWaitSecondsRemaining, 0);
    assert.deepEqual(state.returnCart, []);
    assert.equal(state.carriedBook, null);
    assert.equal(state.shelfCheck, null);
    assert.deepEqual(state.finesQueue, []);
    assert.equal(state.carriedFine, null);
    assert.equal(state.finesSortActive, false);
    assert.deepEqual(state.borrowQueue, []);
    assert.equal(state.activeBorrow, null);
    assert.equal(state.karen.shiftNumber, KAREN_SHIFT);
    assert.equal(state.karen.active, false);
    assert.equal(state.karen.triggered, false);
    assert.equal(state.karen.resolved, false);
    assert.equal(state.libraryMood, LIBRARY_MOOD_MAX);
    assert.equal(state.sanity, SANITY_MAX);
    assert.equal(state.mistakeCount, 0);
    assert.equal(state.bonusGard, 0);
    assert.equal(state.payout, null);
  });
});

describe('startShift', () => {
  test('not-started -> playing', () => {
    const state = startShift(createInitialState(SHIFT_1, KAREN_SHIFT));
    assert.equal(state.phase, 'playing');
  });

  test('is a no-op once already playing', () => {
    const state = playingState();
    assert.deepEqual(startShift(state), state);
  });
});

describe('Return Cart / shelving flow', () => {
  const BOOK = { id: 'b1', genreId: 'mystery', isCoinHunt: false };

  test('addBookToCart -> pickUpBook -> arriveAtShelf (correct genre) -> resolveShelfSkillCheck(true) shelves it', () => {
    let state = playingState();
    state = addBookToCart(state, BOOK);
    assert.equal(state.returnCart.length, 1);

    state = pickUpBook(state, 'b1');
    assert.equal(state.carriedBook.id, 'b1');
    assert.equal(state.returnCart.length, 0);

    state = arriveAtShelf(state, 'mystery');
    assert.deepEqual(state.shelfCheck, { kind: 'skill-check' });

    state = resolveShelfSkillCheck(state, true);
    assert.equal(state.carriedBook, null);
    assert.equal(state.shelfCheck, null);
    assert.equal(state.mistakeCount, 0);
  });

  test('arriveAtShelf at the wrong genre is a no-op (blocks the check from starting)', () => {
    let state = playingState();
    state = addBookToCart(state, BOOK);
    state = pickUpBook(state, 'b1');
    const before = state;
    const after = arriveAtShelf(state, 'romance');
    assert.deepEqual(after, before);
    assert.equal(after.shelfCheck, null);
  });

  test('resolveShelfSkillCheck(false) counts a mistake, drains mood/sanity, but keeps the carried book for retry', () => {
    let state = playingState();
    state = addBookToCart(state, BOOK);
    state = pickUpBook(state, 'b1');
    state = arriveAtShelf(state, 'mystery');
    const next = resolveShelfSkillCheck(state, false);
    assert.equal(next.mistakeCount, 1);
    assert.ok(next.libraryMood < LIBRARY_MOOD_MAX);
    assert.ok(next.sanity < SANITY_MAX);
    assert.equal(next.shelfCheck, null);
    assert.deepEqual(next.carriedBook, BOOK);
  });

  test('pickUpBook is a no-op if already carrying a book', () => {
    let state = playingState();
    state = addBookToCart(state, BOOK);
    state = addBookToCart(state, { id: 'b2', genreId: 'kids', isCoinHunt: false });
    state = pickUpBook(state, 'b1');
    const next = pickUpBook(state, 'b2');
    assert.equal(next.carriedBook.id, 'b1');
    assert.equal(next.returnCart.length, 1);
  });

  test('pickUpBook is a no-op for an unknown id', () => {
    const state = playingState();
    assert.deepEqual(pickUpBook(state, 'nonexistent'), state);
  });

  test('a Coin Hunt book starts a coin-hunt check instead of a skill-check', () => {
    let state = playingState();
    const coinBook = { id: 'b3', genreId: 'scifi', isCoinHunt: true };
    state = addBookToCart(state, coinBook);
    state = pickUpBook(state, 'b3');
    state = arriveAtShelf(state, 'scifi');
    assert.deepEqual(state.shelfCheck, { kind: 'coin-hunt' });
  });

  test('resolveCoinHunt shelves the book and adds foundGard to bonusGard, no failure state', () => {
    let state = playingState();
    const coinBook = { id: 'b3', genreId: 'scifi', isCoinHunt: true };
    state = addBookToCart(state, coinBook);
    state = pickUpBook(state, 'b3');
    state = arriveAtShelf(state, 'scifi');
    const next = resolveCoinHunt(state, 75);
    assert.equal(next.carriedBook, null);
    assert.equal(next.shelfCheck, null);
    assert.equal(next.bonusGard, 75);
    assert.equal(next.mistakeCount, 0);
  });

  test('resolveCoinHunt treats a negative/non-finite foundGard as 0, never subtracting', () => {
    let state = playingState();
    const coinBook = { id: 'b3', genreId: 'scifi', isCoinHunt: true };
    state = addBookToCart(state, coinBook);
    state = pickUpBook(state, 'b3');
    state = arriveAtShelf(state, 'scifi');
    const next = resolveCoinHunt(state, -10);
    assert.equal(next.bonusGard, 0);
  });

  test('resolveShelfSkillCheck is a no-op if there is no active skill-check', () => {
    const state = playingState();
    assert.deepEqual(resolveShelfSkillCheck(state, true), state);
  });

  test('resolveCoinHunt is a no-op if the active check is a skill-check, not a coin-hunt', () => {
    let state = playingState();
    state = addBookToCart(state, BOOK);
    state = pickUpBook(state, 'b1');
    state = arriveAtShelf(state, 'mystery');
    assert.deepEqual(resolveCoinHunt(state, 50), state);
  });
});

describe('Fines counter flow', () => {
  const FINE = { id: 'f1', amountGard: 40 };

  test('full happy path banks the fine into bonusGard', () => {
    let state = playingState();
    state = addFineToQueue(state, FINE);
    state = acceptFine(state, 'f1');
    assert.deepEqual(state.carriedFine, FINE);
    assert.equal(state.finesQueue.length, 0);

    state = arriveAtFinesCounter(state);
    assert.equal(state.finesSortActive, true);

    state = resolveFinesSort(state, true);
    assert.equal(state.bonusGard, 40);
    assert.equal(state.carriedFine, null);
    assert.equal(state.finesSortActive, false);
  });

  test('resolveFinesSort(false) counts a mistake and keeps the carried fine for retry', () => {
    let state = playingState();
    state = addFineToQueue(state, FINE);
    state = acceptFine(state, 'f1');
    state = arriveAtFinesCounter(state);
    const next = resolveFinesSort(state, false);
    assert.equal(next.mistakeCount, 1);
    assert.ok(next.libraryMood < LIBRARY_MOOD_MAX);
    assert.ok(next.sanity < SANITY_MAX);
    assert.equal(next.finesSortActive, false);
    assert.deepEqual(next.carriedFine, FINE);
  });

  test('acceptFine is a no-op if already carrying a fine', () => {
    let state = playingState();
    state = addFineToQueue(state, FINE);
    state = addFineToQueue(state, { id: 'f2', amountGard: 20 });
    state = acceptFine(state, 'f1');
    const next = acceptFine(state, 'f2');
    assert.equal(next.carriedFine.id, 'f1');
    assert.equal(next.finesQueue.length, 1);
  });

  test('arriveAtFinesCounter is a no-op without a carried fine', () => {
    const state = playingState();
    assert.deepEqual(arriveAtFinesCounter(state), state);
  });
});

describe('Borrowing flow (Find the Book -> Checkout Skill-Check)', () => {
  const REQUEST = { id: 'r1', bookId: 'the-great-mystery', patienceSeconds: 30 };

  test('full happy path completes the loan with no mistake', () => {
    let state = playingState();
    state = addBorrowRequest(state, REQUEST);
    assert.equal(state.borrowQueue.length, 1);

    state = acceptBorrowRequest(state, 'r1');
    assert.equal(state.activeBorrow.stage, 'searching');
    assert.equal(state.activeBorrow.patienceRemainingSeconds, 30);
    assert.equal(state.borrowQueue.length, 0);

    state = resolveFindTheBook(state, true);
    assert.equal(state.activeBorrow.stage, 'checkout');

    state = resolveCheckoutSkillCheck(state, true);
    assert.equal(state.activeBorrow, null);
    assert.equal(state.mistakeCount, 0);
  });

  test('resolveFindTheBook(false) fails the request as a mistake and drops it (no retry)', () => {
    let state = playingState();
    state = addBorrowRequest(state, REQUEST);
    state = acceptBorrowRequest(state, 'r1');
    const next = resolveFindTheBook(state, false);
    assert.equal(next.activeBorrow, null);
    assert.equal(next.mistakeCount, 1);
    assert.ok(next.libraryMood < LIBRARY_MOOD_MAX);
  });

  test('resolveCheckoutSkillCheck(false) counts a mistake but stays in checkout stage for retry', () => {
    let state = playingState();
    state = addBorrowRequest(state, REQUEST);
    state = acceptBorrowRequest(state, 'r1');
    state = resolveFindTheBook(state, true);
    const next = resolveCheckoutSkillCheck(state, false);
    assert.equal(next.mistakeCount, 1);
    assert.equal(next.activeBorrow.stage, 'checkout');
  });

  test('resolveFindTheBook is a no-op if the active borrow isn\'t in the searching stage', () => {
    let state = playingState();
    state = addBorrowRequest(state, REQUEST);
    state = acceptBorrowRequest(state, 'r1');
    state = resolveFindTheBook(state, true); // now in 'checkout'
    assert.deepEqual(resolveFindTheBook(state, true), state);
  });

  test('resolveCheckoutSkillCheck is a no-op if the active borrow is still searching', () => {
    let state = playingState();
    state = addBorrowRequest(state, REQUEST);
    state = acceptBorrowRequest(state, 'r1');
    assert.deepEqual(resolveCheckoutSkillCheck(state, true), state);
  });

  test('acceptBorrowRequest is a no-op if a request is already active', () => {
    let state = playingState();
    state = addBorrowRequest(state, REQUEST);
    state = addBorrowRequest(state, { id: 'r2', bookId: 'other', patienceSeconds: 20 });
    state = acceptBorrowRequest(state, 'r1');
    const next = acceptBorrowRequest(state, 'r2');
    assert.equal(next.activeBorrow.id, 'r1');
    assert.equal(next.borrowQueue.length, 1);
  });

  test('tick decrements searching-stage patience, and running out fails it as a mistake', () => {
    let state = playingState();
    state = addBorrowRequest(state, { id: 'r1', bookId: 'x', patienceSeconds: 10 });
    state = acceptBorrowRequest(state, 'r1');

    state = tick(state, 4);
    assert.equal(state.activeBorrow.patienceRemainingSeconds, 6);
    assert.equal(state.mistakeCount, 0);

    state = tick(state, 6);
    assert.equal(state.activeBorrow, null);
    assert.equal(state.mistakeCount, 1);
  });

  test('tick does not drain patience once a borrow has moved into the checkout stage', () => {
    let state = playingState();
    state = addBorrowRequest(state, { id: 'r1', bookId: 'x', patienceSeconds: 10 });
    state = acceptBorrowRequest(state, 'r1');
    state = resolveFindTheBook(state, true);
    state = tick(state, 100);
    assert.equal(state.activeBorrow.stage, 'checkout');
  });
});

describe('Karen\'s scripted event', () => {
  test('startKarenEvent is a no-op on a shift that is not her shift', () => {
    const state = playingState();
    assert.deepEqual(startKarenEvent(state), state);
  });

  test('startKarenEvent fires on her shift and starts the timer', () => {
    const state = startShift(createInitialState(KAREN_SHIFT, KAREN_SHIFT));
    const next = startKarenEvent(state);
    assert.equal(next.karen.active, true);
    assert.equal(next.karen.triggered, true);
    assert.equal(next.karen.timerSecondsRemaining, KAREN_EVENT_TIMER_SECONDS);
  });

  test('startKarenEvent cannot fire twice in one shift', () => {
    const state = startShift(createInitialState(KAREN_SHIFT, KAREN_SHIFT));
    let next = startKarenEvent(state);
    next = resolveKarenEvent(next, 'collectFine');
    const again = startKarenEvent(next);
    assert.deepEqual(again, next);
  });

  test('resolveKarenEvent(\'collectFine\') banks KAREN_FINE_AMOUNT_GARD with no mood/mistake cost', () => {
    let state = startShift(createInitialState(KAREN_SHIFT, KAREN_SHIFT));
    state = startKarenEvent(state);
    const next = resolveKarenEvent(state, 'collectFine');
    assert.equal(next.karen.active, false);
    assert.equal(next.karen.resolved, true);
    assert.equal(next.karen.outcome, 'collectFine');
    assert.equal(next.bonusGard, KAREN_FINE_AMOUNT_GARD);
    assert.equal(next.mistakeCount, 0);
    assert.equal(next.libraryMood, LIBRARY_MOOD_MAX);
  });

  test('resolveKarenEvent(\'letItSlide\') counts a mistake and drains mood by KAREN_MOOD_PENALTY', () => {
    let state = startShift(createInitialState(KAREN_SHIFT, KAREN_SHIFT));
    state = startKarenEvent(state);
    const next = resolveKarenEvent(state, 'letItSlide');
    assert.equal(next.karen.outcome, 'letItSlide');
    assert.equal(next.mistakeCount, 1);
    assert.equal(next.libraryMood, LIBRARY_MOOD_MAX - KAREN_MOOD_PENALTY);
    assert.ok(next.sanity < SANITY_MAX);
    assert.equal(next.bonusGard, 0);
  });

  test('resolveKarenEvent is a no-op if her event isn\'t active', () => {
    const state = playingState();
    assert.deepEqual(resolveKarenEvent(state, 'collectFine'), state);
  });

  test('tick auto-resolves as letItSlide (mishandled) when her timer runs out', () => {
    let state = startShift(createInitialState(KAREN_SHIFT, KAREN_SHIFT));
    state = startKarenEvent(state);
    state = tick(state, KAREN_EVENT_TIMER_SECONDS + 1);
    assert.equal(state.karen.active, false);
    assert.equal(state.karen.outcome, 'letItSlide');
    assert.equal(state.mistakeCount, 1);
    assert.equal(state.libraryMood, LIBRARY_MOOD_MAX - KAREN_MOOD_PENALTY);
  });

  test('tick counts down her timer without resolving before it expires', () => {
    let state = startShift(createInitialState(KAREN_SHIFT, KAREN_SHIFT));
    state = startKarenEvent(state);
    state = tick(state, 3);
    assert.equal(state.karen.active, true);
    assert.equal(state.karen.timerSecondsRemaining, KAREN_EVENT_TIMER_SECONDS - 3);
  });

  test('KAREN_MOOD_PENALTY is bigger than an ordinary mistake\'s mood drain', () => {
    assert.ok(KAREN_MOOD_PENALTY > LIBRARY_MOOD_DRAIN_PER_MISTAKE);
  });
});

describe('Sanity / Coffee Machine', () => {
  test('tick drains sanity passively during playing', () => {
    let state = playingState();
    state = tick(state, 10);
    assert.ok(state.sanity < SANITY_MAX);
  });

  test('a mistake drains sanity by SANITY_DRAIN_PER_UPSET on top of any passive drain', () => {
    let state = playingState();
    state = addBookToCart(state, { id: 'b1', genreId: 'mystery', isCoinHunt: false });
    state = pickUpBook(state, 'b1');
    state = arriveAtShelf(state, 'mystery');
    const before = state.sanity;
    state = resolveShelfSkillCheck(state, false);
    assert.equal(state.sanity, before - SANITY_DRAIN_PER_UPSET);
  });

  test('restoreSanity (the Coffee Machine) sets sanity back to SANITY_MAX with no cooldown', () => {
    let state = playingState();
    state = tick(state, 50);
    assert.ok(state.sanity < SANITY_MAX);
    state = restoreSanity(state);
    assert.equal(state.sanity, SANITY_MAX);
    // Usable again immediately — no cooldown/limit.
    state = tick(state, 10);
    state = restoreSanity(state);
    assert.equal(state.sanity, SANITY_MAX);
  });

  test('restoreSanity is a no-op outside playing', () => {
    const state = createInitialState(SHIFT_1, KAREN_SHIFT); // not-started
    assert.deepEqual(restoreSanity(state), state);
  });

  test('sanity never drops below 0 no matter how much drains at once', () => {
    let state = playingState();
    state = tick(state, 100000);
    assert.equal(state.sanity, 0);
  });

  test('libraryMood and sanity drain independently — a mistake affects both, but sanity also drains passively while mood does not', () => {
    let state = playingState();
    state = tick(state, 20);
    assert.ok(state.sanity < SANITY_MAX);
    assert.equal(state.libraryMood, LIBRARY_MOOD_MAX);
  });
});

describe('shift-clock tick / closing-wait / paycheck lifecycle', () => {
  test('tick decrements the shift clock during playing', () => {
    let state = playingState();
    const total = state.totalClockSeconds;
    state = tick(state, 5);
    assert.equal(state.clockSeconds, total - 5);
    assert.equal(state.phase, 'playing');
  });

  test('the shift clock reaching 0 transitions to closing-wait with a fresh timer', () => {
    let state = playingState();
    state = tick(state, state.totalClockSeconds + 5);
    assert.equal(state.phase, 'closing-wait');
    assert.equal(state.clockSeconds, 0);
    assert.equal(state.closingWaitSecondsRemaining, CLOSING_WAIT_SECONDS);
  });

  test('isBossOfficeReady is false until the closing-wait timer elapses', () => {
    let state = playingState();
    state = tick(state, state.totalClockSeconds); // -> closing-wait
    assert.equal(state.phase, 'closing-wait');
    assert.equal(isBossOfficeReady(state), false);

    state = tick(state, CLOSING_WAIT_SECONDS - 1);
    assert.equal(isBossOfficeReady(state), false);

    state = tick(state, 1);
    assert.equal(state.closingWaitSecondsRemaining, 0);
    assert.equal(isBossOfficeReady(state), true);
  });

  test('enterBossOffice is a no-op before the closing wait elapses', () => {
    let state = playingState();
    state = tick(state, state.totalClockSeconds);
    const before = state;
    const after = enterBossOffice(state);
    assert.deepEqual(after, before);
  });

  test('enterBossOffice transitions to paycheck and computes payout once ready', () => {
    let state = playingState();
    state = tick(state, state.totalClockSeconds);
    state = tick(state, CLOSING_WAIT_SECONDS);
    assert.equal(isBossOfficeReady(state), true);

    state = enterBossOffice(state);
    assert.equal(state.phase, 'paycheck');
    assert.equal(state.payout, shiftPaycheck(0) + 0);
  });

  test('payout includes bonusGard on top of shiftPaycheck(mistakeCount)', () => {
    let state = playingState();
    state = addFineToQueue(state, { id: 'f1', amountGard: 30 });
    state = acceptFine(state, 'f1');
    state = arriveAtFinesCounter(state);
    state = resolveFinesSort(state, true); // bonusGard += 30

    state = addBookToCart(state, { id: 'b1', genreId: 'kids', isCoinHunt: false });
    state = pickUpBook(state, 'b1');
    state = arriveAtShelf(state, 'kids');
    state = resolveShelfSkillCheck(state, false); // 1 mistake

    state = tick(state, state.totalClockSeconds);
    state = tick(state, CLOSING_WAIT_SECONDS);
    state = enterBossOffice(state);

    assert.equal(state.payout, shiftPaycheck(1) + 30);
  });

  test('tick is a no-op in every phase except playing and closing-wait', () => {
    const notStarted = createInitialState(SHIFT_1, KAREN_SHIFT);
    assert.deepEqual(tick(notStarted, 5), notStarted);

    let paycheck = playingState();
    paycheck = tick(paycheck, paycheck.totalClockSeconds);
    paycheck = tick(paycheck, CLOSING_WAIT_SECONDS);
    paycheck = enterBossOffice(paycheck);
    assert.equal(paycheck.phase, 'paycheck');
    assert.deepEqual(tick(paycheck, 5), paycheck);
  });

  test('in-flight interactions are abandoned (not force-failed) when the clock runs out', () => {
    let state = playingState();
    state = addBookToCart(state, { id: 'b1', genreId: 'mystery', isCoinHunt: false });
    state = pickUpBook(state, 'b1');
    const mistakesBefore = state.mistakeCount;

    state = tick(state, state.totalClockSeconds + 1);
    assert.equal(state.phase, 'closing-wait');
    assert.equal(state.mistakeCount, mistakesBefore);
    // The carried book is simply left carried — no forced resolution.
    assert.deepEqual(state.carriedBook, { id: 'b1', genreId: 'mystery', isCoinHunt: false });
  });

  test('a negative or non-finite delta is treated as 0', () => {
    let state = playingState();
    const before = state;
    state = tick(state, -5);
    assert.equal(state.clockSeconds, before.clockSeconds);
    state = tick(state, NaN);
    assert.equal(state.clockSeconds, before.clockSeconds);
  });
});
