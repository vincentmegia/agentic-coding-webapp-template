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
  arriveAtFinesCounter,
  resolveFinesSort,
  arriveAtFrontDeskWithFine,
  resolveTillCount,
  addBorrowRequest,
  acceptBorrowRequest,
  resolveFindTheBook,
  resolveCheckoutSkillCheck,
  startKarenEvent,
  resolveKarenEvent,
  tick,
  isBossOfficeReady,
  enterBossOffice,
  brewCoffee,
  canReadBook,
  dropCarriedBook,
  startleFromHallucination,
  finishReading,
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
  COFFEE_SANITY_RESTORE,
  COFFEE_PERFECT_TIP_GARD,
  patienceMultiplierForLibraryMood,
  RATING_MAX,
  RATING_PENALTY_PER_WALKOUT,
  shiftPaycheck as shiftPaycheckForRating,
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
    assert.equal(next.bonusGard, 75 + SHELVED_BOOK_TIP_GARD); // found Gard + v2.18 shelving tip
    assert.equal(next.mistakeCount, 0);
  });

  test('resolveCoinHunt treats a negative/non-finite foundGard as 0, never subtracting', () => {
    let state = playingState();
    const coinBook = { id: 'b3', genreId: 'scifi', isCoinHunt: true };
    state = addBookToCart(state, coinBook);
    state = pickUpBook(state, 'b3');
    state = arriveAtShelf(state, 'scifi');
    const next = resolveCoinHunt(state, -10);
    assert.equal(next.bonusGard, SHELVED_BOOK_TIP_GARD); // just the shelving tip — never subtracted
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

describe('Fines flow (Fines Counter -> Front Desk till)', () => {
  const FINE = { id: 'f1', amountGard: 40 };
  // Queued entries gain wait-timer fields (null = no timer when waitSeconds is omitted).
  const QUEUED_FINE = { ...FINE, waitRemainingSeconds: null, waitMaxSeconds: null };

  test('full happy path: collect at the counter, count it into the till at the desk, banked', () => {
    let state = playingState();
    state = addFineToQueue(state, QUEUED_FINE);
    assert.equal(state.finesQueue.length, 1);

    state = arriveAtFinesCounter(state);
    assert.equal(state.finesSortActive, true);
    assert.deepEqual(state.activeFine, QUEUED_FINE);
    assert.equal(state.finesQueue.length, 0);

    state = resolveFinesSort(state, true);
    assert.deepEqual(state.carriedFine, QUEUED_FINE);
    assert.equal(state.activeFine, null);
    assert.equal(state.bonusGard, 0, 'not banked until it reaches the till');

    state = arriveAtFrontDeskWithFine(state);
    assert.equal(state.tillCountActive, true);

    state = resolveTillCount(state, true);
    assert.equal(state.bonusGard, 40);
    assert.equal(state.carriedFine, null);
    assert.equal(state.tillCountActive, false);
    assert.equal(state.mistakeCount, 0);
  });

  test('a failed Fines Sort is a mistake and the patron steps back to the front of the queue', () => {
    let state = playingState();
    state = addFineToQueue(state, QUEUED_FINE);
    state = addFineToQueue(state, { id: 'f2', amountGard: 20 });
    state = arriveAtFinesCounter(state);
    const next = resolveFinesSort(state, false);
    assert.equal(next.mistakeCount, 1);
    assert.ok(next.libraryMood < LIBRARY_MOOD_MAX);
    assert.equal(next.finesSortActive, false);
    assert.equal(next.carriedFine, null);
    assert.deepEqual(next.finesQueue.map((f) => f.id), ['f1', 'f2']);
  });

  test('a till miscount is a mistake but keeps the till open with the payment in hand', () => {
    let state = playingState();
    state = addFineToQueue(state, QUEUED_FINE);
    state = arriveAtFinesCounter(state);
    state = resolveFinesSort(state, true);
    state = arriveAtFrontDeskWithFine(state);
    const next = resolveTillCount(state, false);
    assert.equal(next.mistakeCount, 1);
    assert.equal(next.tillCountActive, true);
    assert.deepEqual(next.carriedFine, QUEUED_FINE);
    assert.equal(next.bonusGard, 0);
  });

  test('cannot start collecting another payment while still carrying one', () => {
    let state = playingState();
    state = addFineToQueue(state, QUEUED_FINE);
    state = addFineToQueue(state, { id: 'f2', amountGard: 20 });
    state = arriveAtFinesCounter(state);
    state = resolveFinesSort(state, true);
    assert.deepEqual(arriveAtFinesCounter(state), state);
  });

  test('arriving at either end with nothing to do is a no-op', () => {
    const state = playingState();
    assert.deepEqual(arriveAtFinesCounter(state), state);
    assert.deepEqual(arriveAtFrontDeskWithFine(state), state);
    assert.deepEqual(resolveTillCount(state, true), state);
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

  test('a patron arriving while library mood is low gets proportionally less patience; already-queued patrons keep theirs', () => {
    let state = playingState();
    state = addBorrowRequest(state, REQUEST); // arrives at full mood
    state = { ...state, libraryMood: 0 };
    state = addBorrowRequest(state, { ...REQUEST, id: 'r2' }); // arrives at 0 mood
    const [calm, tense] = state.borrowQueue;
    assert.equal(calm.patienceMaxSeconds, 30);
    assert.equal(tense.patienceMaxSeconds, 30 * patienceMultiplierForLibraryMood(0));
    assert.equal(tense.patienceRemainingSeconds, tense.patienceMaxSeconds);
    assert.ok(tense.patienceMaxSeconds < calm.patienceMaxSeconds);
  });

  test('tick with pauseBorrowPatience leaves a searching request\'s patience untouched', () => {
    let state = playingState();
    state = addBorrowRequest(state, REQUEST);
    state = acceptBorrowRequest(state, 'r1');
    const before = state.activeBorrow.patienceRemainingSeconds;
    state = tick(state, 1000, { pauseBorrowPatience: true });
    assert.equal(state.activeBorrow?.patienceRemainingSeconds, before);
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

  test('brewCoffee: a perfect pour refills Sanity to full and banks a Gard tip, with no cooldown', () => {
    let state = tick(playingState(), 50);
    assert.ok(state.sanity < SANITY_MAX);
    const gardBefore = state.bonusGard;
    state = brewCoffee(state, 'perfect');
    assert.equal(state.sanity, SANITY_MAX);
    assert.equal(state.bonusGard, gardBefore + COFFEE_PERFECT_TIP_GARD);
    // Usable again immediately — no cooldown/limit.
    state = tick(state, 10);
    state = brewCoffee(state, 'perfect');
    assert.equal(state.sanity, SANITY_MAX);
  });

  test('brewCoffee: good/sloppy/spilled add their partial restore, clamped, with no tip', () => {
    for (const grade of ['good', 'sloppy', 'spilled']) {
      const start = { ...playingState(), sanity: 10 };
      const after = brewCoffee(start, grade);
      assert.equal(after.sanity, 10 + COFFEE_SANITY_RESTORE[grade], grade);
      assert.equal(after.bonusGard, start.bonusGard, grade);
    }
    assert.equal(brewCoffee({ ...playingState(), sanity: 90 }, 'good').sanity, SANITY_MAX);
  });

  test('brewCoffee: every grade restores something (never zero), and an unknown grade counts as sloppy', () => {
    for (const grade of ['perfect', 'good', 'sloppy', 'spilled']) assert.ok(COFFEE_SANITY_RESTORE[grade] > 0, grade);
    const start = { ...playingState(), sanity: 10 };
    assert.equal(brewCoffee(start, 'bogus').sanity, 10 + COFFEE_SANITY_RESTORE.sloppy);
  });

  test('brewCoffee is a no-op outside playing', () => {
    const state = createInitialState(SHIFT_1, KAREN_SHIFT);
    assert.deepEqual(brewCoffee(state, 'perfect'), state);
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

    // Isolate the base formula from v2.16's 0-Sanity pay cut (fast-forwarding
    // a whole shift with no coffee spends most of it at 0 Sanity).
    state = enterBossOffice({ ...state, zeroSanitySeconds: 0 });
    assert.equal(state.phase, 'paycheck');
    assert.equal(state.payout, shiftPaycheck(0) + 0);
  });

  test('payout includes bonusGard on top of shiftPaycheck(mistakeCount)', () => {
    let state = playingState();
    state = addFineToQueue(state, { id: 'f1', amountGard: 30 });
    state = arriveAtFinesCounter(state);
    state = resolveFinesSort(state, true);
    state = arriveAtFrontDeskWithFine(state);
    state = resolveTillCount(state, true); // bonusGard += 30

    state = addBookToCart(state, { id: 'b1', genreId: 'kids', isCoinHunt: false });
    state = pickUpBook(state, 'b1');
    state = arriveAtShelf(state, 'kids');
    state = resolveShelfSkillCheck(state, false); // 1 mistake

    state = tick(state, state.totalClockSeconds);
    state = tick(state, CLOSING_WAIT_SECONDS);
    state = enterBossOffice({ ...state, zeroSanitySeconds: 0 }); // isolate from the 0-Sanity pay cut

    // The failed shelf check leaves the book in hand at closing: docked (v2.18).
    assert.equal(state.unshelvedAtClose, 1);
    assert.equal(state.payout, shiftPaycheck(1) + 30 - UNSHELVED_BOOK_PENALTY_GARD);
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

describe('Star rating (v2.9)', () => {
  test('starts at RATING_MAX with no walkouts', () => {
    const state = playingState();
    assert.equal(state.rating, RATING_MAX);
    assert.equal(state.walkouts, 0);
  });

  test('a queued fine or borrow patron whose wait runs out walks out and costs RATING_PENALTY_PER_WALKOUT stars', () => {
    let state = playingState();
    state = addFineToQueue(state, { id: 'f1', amountGard: 30, waitSeconds: 10 });
    state = addBorrowRequest(state, { id: 'r1', bookId: 'b', patienceSeconds: 30, waitSeconds: 20 });
    state = tick(state, 11);
    assert.equal(state.finesQueue.length, 0);
    assert.equal(state.borrowQueue.length, 1);
    assert.equal(state.rating, RATING_MAX - RATING_PENALTY_PER_WALKOUT);
    state = tick(state, 10);
    assert.equal(state.borrowQueue.length, 0);
    assert.equal(state.walkouts, 2);
    assert.equal(state.rating, RATING_MAX - 2 * RATING_PENALTY_PER_WALKOUT);
  });

  test('queued patrons without a wait timer never walk out', () => {
    let state = playingState();
    state = addFineToQueue(state, { id: 'f1', amountGard: 30 });
    state = tick(state, 100);
    assert.equal(state.finesQueue.length, 1);
    assert.equal(state.rating, RATING_MAX);
  });

  test('a borrow patron whose search patience runs out also costs stars', () => {
    let state = playingState();
    state = addBorrowRequest(state, { id: 'r1', bookId: 'b', patienceSeconds: 5, waitSeconds: 60 });
    state = acceptBorrowRequest(state, 'r1');
    state = tick(state, 6);
    assert.equal(state.activeBorrow, null);
    assert.equal(state.rating, RATING_MAX - RATING_PENALTY_PER_WALKOUT);
  });

  test('rating never drops below 0', () => {
    let state = playingState();
    for (let i = 0; i < 6; i++) state = addFineToQueue(state, { id: `f${i}`, amountGard: 20, waitSeconds: 1 });
    state = tick(state, 2);
    assert.equal(state.rating, 0);
  });

  test('payout is scaled by rating / RATING_MAX', () => {
    let state = { ...playingState(), rating: 3.5 };
    state = tick(state, state.totalClockSeconds);
    state = tick(state, CLOSING_WAIT_SECONDS);
    state = enterBossOffice({ ...state, zeroSanitySeconds: 0 }); // isolate from the 0-Sanity pay cut
    assert.equal(state.payout, Math.round(shiftPaycheckForRating(0) * 0.7));
  });
});

describe('Reading Nook (v2.10)', () => {
  test('finishing a book restores Library Mood and starts the cooldown', () => {
    let state = { ...playingState(), libraryMood: 50 };
    assert.equal(canReadBook(state), true);
    state = finishReading(state);
    assert.equal(state.libraryMood, 50 + READING_MOOD_RESTORE);
    assert.equal(state.readingCooldownSeconds, READING_COOLDOWN_SECONDS);
    assert.equal(canReadBook(state), false);
  });

  test('reading again during the cooldown is a no-op; it is usable again once the cooldown ticks down', () => {
    let state = finishReading({ ...playingState(), libraryMood: 10 });
    const during = finishReading(state);
    assert.deepEqual(during, state);
    state = tick(state, READING_COOLDOWN_SECONDS);
    assert.equal(canReadBook(state), true);
    assert.equal(finishReading(state).libraryMood, 10 + 2 * READING_MOOD_RESTORE);
  });

  test('mood never goes above the max', () => {
    const state = finishReading({ ...playingState(), libraryMood: LIBRARY_MOOD_MAX - 5 });
    assert.equal(state.libraryMood, LIBRARY_MOOD_MAX);
  });

  test('not usable outside playing', () => {
    const state = createInitialState(SHIFT_1, KAREN_SHIFT);
    assert.equal(canReadBook(state), false);
    assert.deepEqual(finishReading(state), state);
  });
});

describe('Hallucinations (v2.16)', () => {
  test('time at 0 Sanity accumulates and cuts the payout', () => {
    let state = { ...playingState(), sanity: 0 };
    state = tick(state, 35);
    assert.ok(state.zeroSanitySeconds >= 35);
    state = tick(state, state.totalClockSeconds);
    state = tick(state, CLOSING_WAIT_SECONDS);
    const zero = state.zeroSanitySeconds;
    state = enterBossOffice(state);
    assert.equal(state.payout, Math.round(shiftPaycheckForRating(0) * hallucinationPayMultiplier(zero)));
    assert.ok(state.payout < shiftPaycheckForRating(0));
  });

  test('time above 0 Sanity does not count', () => {
    const state = tick(playingState(), 5);
    assert.equal(state.zeroSanitySeconds, 0);
  });

  test('dropCarriedBook puts the carried book back at the front of the Return Cart', () => {
    let state = playingState();
    state = addBookToCart(state, { id: 'b1', genreId: 'kids', isCoinHunt: false });
    state = addBookToCart(state, { id: 'b2', genreId: 'kids', isCoinHunt: false });
    state = pickUpBook(state, 'b2');
    state = dropCarriedBook(state);
    assert.equal(state.carriedBook, null);
    assert.deepEqual(state.returnCart.map((b) => b.id), ['b2', 'b1']);
  });

  test('dropCarriedBook is a no-op mid shelf-check or with nothing carried', () => {
    let state = playingState();
    assert.deepEqual(dropCarriedBook(state), state);
    state = addBookToCart(state, { id: 'b1', genreId: 'kids', isCoinHunt: false });
    state = pickUpBook(state, 'b1');
    state = arriveAtShelf(state, 'kids');
    assert.deepEqual(dropCarriedBook(state), state);
  });

  test('startleFromHallucination costs a little Sanity, never below 0', () => {
    assert.equal(startleFromHallucination({ ...playingState(), sanity: 50 }).sanity, 50 - HALLUCINATION_STARTLE_SANITY);
    assert.equal(startleFromHallucination({ ...playingState(), sanity: 2 }).sanity, 0);
  });
});

describe('Zero-Mood penalties (v2.17)', () => {
  test('time at 0 Mood accumulates; above 0 it does not', () => {
    assert.equal(tick({ ...playingState(), sanity: 100 }, 5).zeroMoodSeconds, 0);
    assert.equal(tick({ ...playingState(), libraryMood: 0 }, 5).zeroMoodSeconds, 5);
  });

  test('every ZERO_MOOD_STORM_OUT_SECONDS at 0 Mood, the patron closest to giving up storms out (a walk-out)', () => {
    let state = { ...playingState(), libraryMood: 0 };
    state = addFineToQueue(state, { id: 'f1', amountGard: 20, waitSeconds: 200 });
    state = addBorrowRequest(state, { id: 'r1', bookId: 'b', patienceSeconds: 30, waitSeconds: 100 });
    state = tick(state, ZERO_MOOD_STORM_OUT_SECONDS + 0.5);
    assert.equal(state.borrowQueue.length, 0, 'the borrow patron had less wait left');
    assert.equal(state.finesQueue.length, 1);
    assert.equal(state.walkouts, 1);
    assert.equal(state.rating, RATING_MAX - RATING_PENALTY_PER_WALKOUT);
  });

  test('with nobody in line, the next arrival storms out right away', () => {
    let state = tick({ ...playingState(), libraryMood: 0 }, ZERO_MOOD_STORM_OUT_SECONDS * 2);
    assert.equal(state.walkouts, 0);
    state = addFineToQueue(state, { id: 'f1', amountGard: 20, waitSeconds: 200 });
    state = tick(state, 0.1);
    assert.equal(state.finesQueue.length, 0);
    assert.equal(state.walkouts, 1);
  });

  test('a complaint letter every COMPLAINT_INTERVAL_SECONDS at 0 Mood', () => {
    const state = tick({ ...playingState(), libraryMood: 0 }, COMPLAINT_INTERVAL_SECONDS * 2 + 1);
    assert.equal(state.complaints, 2);
  });

  test('payout subtracts complaints and applies the 0-Mood pay cut', () => {
    let state = { ...playingState(), complaints: 2, zeroMoodSeconds: 50 };
    state = tick({ ...state, libraryMood: 1 }, state.totalClockSeconds);
    state = tick(state, CLOSING_WAIT_SECONDS);
    state = enterBossOffice({ ...state, zeroSanitySeconds: 0 });
    const gross = shiftPaycheckForRating(0) - 2 * COMPLAINT_GARD;
    assert.equal(state.payout, Math.round(gross * moodPayMultiplier(50)));
  });
});

describe('Shelving incentives (v2.18)', () => {
  test('a successful shelf check tips SHELVED_BOOK_TIP_GARD', () => {
    let state = playingState();
    state = addBookToCart(state, { id: 'b1', genreId: 'kids', isCoinHunt: false });
    state = pickUpBook(state, 'b1');
    state = arriveAtShelf(state, 'kids');
    state = resolveShelfSkillCheck(state, true);
    assert.equal(state.bonusGard, SHELVED_BOOK_TIP_GARD);
  });

  test('a cart past MESSY_CART_THRESHOLD drains Library Mood; at the threshold it does not', () => {
    let state = playingState();
    for (let i = 0; i < MESSY_CART_THRESHOLD; i++) state = addBookToCart(state, { id: `b${i}`, genreId: 'kids', isCoinHunt: false });
    assert.equal(tick(state, 10).libraryMood, LIBRARY_MOOD_MAX);
    state = addBookToCart(state, { id: 'extra', genreId: 'kids', isCoinHunt: false });
    assert.equal(tick(state, 10).libraryMood, LIBRARY_MOOD_MAX - MESSY_CART_MOOD_DRAIN_PER_SECOND * 10);
  });

  test('books unshelved when the clock runs out are counted and docked at payout', () => {
    let state = playingState();
    for (let i = 0; i < 3; i++) state = addBookToCart(state, { id: `b${i}`, genreId: 'kids', isCoinHunt: false });
    state = pickUpBook(state, 'b0');
    state = tick(state, state.totalClockSeconds);
    assert.equal(state.unshelvedAtClose, 3); // 2 on the cart + 1 in hand
    state = tick(state, CLOSING_WAIT_SECONDS);
    state = enterBossOffice({ ...state, zeroSanitySeconds: 0, zeroMoodSeconds: 0, complaints: 0 });
    assert.equal(state.payout, shiftPaycheck(0) - 3 * UNSHELVED_BOOK_PENALTY_GARD);
  });
});
