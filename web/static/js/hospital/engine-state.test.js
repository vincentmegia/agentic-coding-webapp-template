import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  BED_COUNT,
  createInitialState,
  startShift,
  addPatientToTriage,
  canTriage,
  resolveTriage,
  currentStep,
  freeBedIndex,
  startBedTask,
  resolveBedTask,
  nextMedsBedIndex,
  startMedsDispense,
  resolveMedsDispense,
  deliverMeds,
  dropCarriedSupply,
  pickUpBandage,
  startSurgeryTransport,
  startSurgery,
  resolveSurgery,
  cancelTask,
  startKarenEvent,
  resolveKarenEvent,
  tick,
  isOfficeReady,
  enterOffice,
  brewCoffee,
  startleFromHallucination,
} from './engine-state.js';
import {
  findCondition,
  TREATMENT_TIP_GARD,
  DISCHARGE_GARD,
  WARD_MOOD_DRAIN_PER_MISTAKE,
  SANITY_DRAIN_PER_UPSET,
  RATING_PENALTY_PER_WALKOUT,
  treatmentPatienceSeconds,
  KAREN_CALMED_TIP_GARD,
  KAREN_MOOD_PENALTY,
  KAREN_EVENT_TIMER_SECONDS,
  CLOSING_WAIT_SECONDS,
  COFFEE_PERFECT_TIP_GARD,
  COFFEE_MOOD_RESTORE,
  shiftPaycheck,
} from './rules.js';

function playing(shift = 5, overrides = {}) {
  return startShift(createInitialState(shift, 12, overrides));
}

/** Queues and correctly triages a patient into the first free bed; returns [state, bedIndex]. */
function bedded(state, id, conditionId) {
  const bedIndex = freeBedIndex(state);
  let s = addPatientToTriage(state, { id, conditionId });
  s = resolveTriage(s, id, findCondition(conditionId).level);
  return [s, bedIndex];
}

describe('shift start', () => {
  test('a fresh shift has empty beds and full stats', () => {
    const s = createInitialState(1, 12);
    assert.equal(s.phase, 'not-started');
    assert.equal(s.beds.length, BED_COUNT);
    assert.ok(s.beds.every((b) => b === null));
    assert.equal(s.wardMood, 100);
    assert.equal(s.sanity, 100);
    assert.equal(s.rating, 5);
    assert.equal(startShift(s).phase, 'playing');
  });

  test('nothing queues before the shift starts', () => {
    const s = createInitialState(1, 12);
    assert.equal(addPatientToTriage(s, { id: 'p1', conditionId: 'sprain' }), s);
  });
});

describe('triage', () => {
  test('a queued patient carries their condition level and a mood-scaled wait', () => {
    const s = addPatientToTriage(playing(1, { wardMood: 50 }), { id: 'p1', conditionId: 'asthma', waitSeconds: 100 });
    const p = s.triageQueue[0];
    assert.equal(p.level, 'red');
    assert.equal(p.waitMaxSeconds, 80);
  });

  test('an unknown condition is ignored', () => {
    const s = playing();
    assert.equal(addPatientToTriage(s, { id: 'x', conditionId: 'nope' }), s);
  });

  test('a correct call beds the patient with their plan and no mistake', () => {
    const [s, bedIndex] = bedded(playing(1), 'p1', 'cut');
    assert.equal(s.triageQueue.length, 0);
    assert.equal(bedIndex, 0);
    const bed = s.beds[0];
    assert.deepEqual(bed.plan, findCondition('cut').plan);
    assert.equal(bed.step, 0);
    assert.equal(bed.patienceMaxSeconds, treatmentPatienceSeconds('yellow', 1));
    assert.equal(s.mistakeCount, 0);
  });

  test('a wrong call still beds the patient but is a mistake', () => {
    let s = addPatientToTriage(playing(1), { id: 'p1', conditionId: 'asthma' });
    s = resolveTriage(s, 'p1', 'green');
    assert.ok(s.beds[0]);
    assert.equal(s.beds[0].level, 'red');
    assert.equal(s.mistakeCount, 1);
    assert.equal(s.wardMood, 100 - WARD_MOOD_DRAIN_PER_MISTAKE);
    assert.equal(s.sanity, 100 - SANITY_DRAIN_PER_UPSET);
  });

  test('triage is blocked when every bed is full', () => {
    let s = playing(1);
    for (let i = 0; i < BED_COUNT; i++) [s] = bedded(s, `p${i}`, 'sprain');
    s = addPatientToTriage(s, { id: 'extra', conditionId: 'sprain' });
    assert.equal(canTriage(s, 'extra'), false);
    assert.equal(resolveTriage(s, 'extra', 'green'), s);
  });
});

describe('bed-side minigames', () => {
  test('starting the bed task opens its current step', () => {
    const [s0, bed] = bedded(playing(1), 'p1', 'sprain');
    const s = startBedTask(s0, bed);
    assert.deepEqual(s.activeTask, { kind: 'vitals', bedIndex: bed, patientId: 'p1' });
  });

  test('success advances the plan and tips; failure is a mistake and keeps the task open', () => {
    const [s0, bed] = bedded(playing(1), 'p1', 'sprain');
    let s = startBedTask(s0, bed);
    s = resolveBedTask(s, false);
    assert.equal(s.mistakeCount, 1);
    assert.ok(s.activeTask);
    s = resolveBedTask(s, true);
    assert.equal(s.activeTask, null);
    assert.equal(currentStep(s.beds[bed]), 'bandage');
    assert.equal(s.bonusGard, TREATMENT_TIP_GARD);
  });

  test('finishing the last step discharges the patient and frees the bed', () => {
    const [s0, bed] = bedded(playing(1), 'p1', 'sprain');
    let s = resolveBedTask(startBedTask(s0, bed), true); // vitals
    s = resolveBedTask(startBedTask(pickUpBandage(s), bed), true); // bandage
    assert.equal(s.beds[bed], null);
    assert.equal(s.discharged, 1);
    assert.equal(s.bonusGard, TREATMENT_TIP_GARD * 2 + DISCHARGE_GARD.green);
  });

  test('a meds or surgery step can\'t be started at the bed as a minigame', () => {
    let [s, bed] = bedded(playing(1), 'p1', 'migraine');
    s = resolveBedTask(startBedTask(s, bed), true);
    assert.equal(currentStep(s.beds[bed]), 'meds');
    assert.equal(startBedTask(s, bed), s);
  });

  test('cancelling a minigame leaves the step as it was, with no mistake', () => {
    const [s0, bed] = bedded(playing(1), 'p1', 'sprain');
    const s = cancelTask(startBedTask(s0, bed));
    assert.equal(s.activeTask, null);
    assert.equal(s.mistakeCount, 0);
    assert.equal(currentStep(s.beds[bed]), 'vitals');
    assert.equal(cancelTask(s), s);
  });

  test('only one minigame at a time', () => {
    let [s, a] = bedded(playing(1), 'p1', 'sprain');
    let b;
    [s, b] = bedded(s, 'p2', 'sprain');
    s = startBedTask(s, a);
    assert.equal(startBedTask(s, b), s);
  });
});

describe('bandages (Supply Cart)', () => {
  function bandageReady() {
    let [s, bed] = bedded(playing(1), 'p1', 'sprain');
    s = resolveBedTask(startBedTask(s, bed), true); // vitals
    return [s, bed];
  }

  test('a Bandage step won\'t start without a roll from the Supply Cart', () => {
    const [s, bed] = bandageReady();
    assert.equal(currentStep(s.beds[bed]), 'bandage');
    assert.equal(startBedTask(s, bed), s);
  });

  test('picking up a roll, then dressing the wound uses it up', () => {
    let [s, bed] = bandageReady();
    s = pickUpBandage(s);
    assert.deepEqual(s.carried, { kind: 'bandage' });
    s = startBedTask(s, bed);
    assert.equal(s.activeTask.kind, 'bandage');
    s = resolveBedTask(s, false);
    assert.deepEqual(s.carried, { kind: 'bandage' }, 'a botched dressing keeps the roll for the retry');
    s = resolveBedTask(s, true);
    assert.equal(s.carried, null);
    assert.equal(s.beds[bed], null);
  });

  test('backing out keeps the roll in hand', () => {
    let [s, bed] = bandageReady();
    s = cancelTask(startBedTask(pickUpBandage(s), bed));
    assert.deepEqual(s.carried, { kind: 'bandage' });
  });

  test('one item at a time: no roll while holding meds or pushing a gurney', () => {
    const s = playing(1, { carried: { kind: 'meds', bedIndex: 0, patientId: 'x' } });
    assert.equal(pickUpBandage(s), s);
    assert.equal(pickUpBandage(pickUpBandage(playing(1))).carried.kind, 'bandage');
  });

  test('any patient can use the roll, and a transfer elsewhere doesn\'t take it', () => {
    let s = pickUpBandage(playing(1));
    let bed;
    [s, bed] = bedded(s, 'p1', 'asthma');
    s = tick(s, 500);
    assert.equal(s.beds[bed], null);
    assert.deepEqual(s.carried, { kind: 'bandage' });
  });

  test('a hallucination can make you drop the roll, but not mid-dressing', () => {
    let [s, bed] = bandageReady();
    s = pickUpBandage(s);
    assert.equal(dropCarriedSupply(s).carried, null);
    s = startBedTask(s, bed);
    assert.equal(dropCarriedSupply(s), s);
  });
});

describe('meds', () => {
  function medsReady() {
    let [s, bed] = bedded(playing(1), 'p1', 'migraine');
    s = resolveBedTask(startBedTask(s, bed), true);
    return [s, bed];
  }

  test('the cabinet fills the bed waiting on meds, then you carry them back', () => {
    let [s, bed] = medsReady();
    assert.equal(nextMedsBedIndex(s), bed);
    s = startMedsDispense(s);
    assert.equal(s.activeTask.kind, 'meds-dispense');
    s = resolveMedsDispense(s, false);
    assert.equal(s.mistakeCount, 1);
    assert.equal(s.carried, null);
    s = resolveMedsDispense(s, true);
    assert.deepEqual(s.carried, { kind: 'meds', bedIndex: bed, patientId: 'p1' });
    s = deliverMeds(s, bed);
    assert.equal(s.carried, null);
    assert.equal(s.beds[bed], null); // migraine: vitals, meds -> discharged
    assert.equal(s.discharged, 1);
  });

  test('no meds order means the cabinet does nothing', () => {
    const [s] = bedded(playing(1), 'p1', 'sprain');
    assert.equal(nextMedsBedIndex(s), -1);
    assert.equal(startMedsDispense(s), s);
  });

  test('meds delivered to the wrong bed do nothing', () => {
    let [s, bed] = medsReady();
    s = resolveMedsDispense(startMedsDispense(s), true);
    assert.equal(deliverMeds(s, bed + 1), s);
  });

  test('dropped meds leave the order in place', () => {
    let [s, bed] = medsReady();
    s = resolveMedsDispense(startMedsDispense(s), true);
    s = dropCarriedSupply(s);
    assert.equal(s.carried, null);
    assert.equal(currentStep(s.beds[bed]), 'meds');
  });

  test('the most urgent meds order is filled first', () => {
    let s = playing(1);
    let a;
    let b;
    [s, a] = bedded(s, 'p1', 'migraine');
    [s, b] = bedded(s, 'p2', 'migraine');
    s = resolveBedTask(startBedTask(s, a), true);
    s = resolveBedTask(startBedTask(s, b), true);
    s = { ...s, beds: s.beds.map((p, i) => (i === b ? { ...p, patienceRemainingSeconds: 5 } : p)) };
    assert.equal(nextMedsBedIndex(s), b);
  });
});

describe('surgery', () => {
  function surgeryReady() {
    let [s, bed] = bedded(playing(5), 'p1', 'appendicitis');
    s = resolveBedTask(startBedTask(s, bed), true); // vitals
    s = resolveBedTask(startBedTask(s, bed), true); // iv
    return [s, bed];
  }

  test('take the gurney, operate, and the patient is discharged', () => {
    let [s, bed] = surgeryReady();
    assert.equal(currentStep(s.beds[bed]), 'surgery');
    s = startSurgeryTransport(s, bed);
    assert.equal(s.carried.kind, 'gurney');
    assert.equal(s.beds[bed].inSurgery, true);
    s = startSurgery(s);
    assert.equal(s.activeTask.kind, 'surgery');
    s = resolveSurgery(s, false);
    assert.equal(s.mistakeCount, 1);
    s = resolveSurgery(s, true);
    assert.equal(s.carried, null);
    assert.equal(s.beds[bed], null);
    assert.equal(s.bonusGard, TREATMENT_TIP_GARD * 3 + DISCHARGE_GARD.red);
  });

  test('a patient in surgery doesn\'t lose patience', () => {
    let [s, bed] = surgeryReady();
    s = startSurgeryTransport(s, bed);
    const before = s.beds[bed].patienceRemainingSeconds;
    s = tick(s, 30);
    assert.equal(s.beds[bed].patienceRemainingSeconds, before);
  });

  test('pushing a gurney blocks other bed work and the cabinet', () => {
    let [s, bed] = surgeryReady();
    let other;
    [s, other] = bedded(s, 'p2', 'sprain');
    s = startSurgeryTransport(s, bed);
    assert.equal(startBedTask(s, other), s);
    assert.equal(startMedsDispense(s), s);
  });

  test('without a gurney the OR does nothing', () => {
    const s = playing(5);
    assert.equal(startSurgery(s), s);
  });
});

describe('tick', () => {
  test('a queued patient whose wait runs out walks out (−1.5★, not a mistake)', () => {
    let s = addPatientToTriage(playing(1), { id: 'p1', conditionId: 'sprain', waitSeconds: 10 });
    s = tick(s, 11);
    assert.equal(s.triageQueue.length, 0);
    assert.equal(s.rating, 5 - RATING_PENALTY_PER_WALKOUT);
    assert.equal(s.mistakeCount, 0);
  });

  test('a bedded patient left too long is transferred: a mistake and a walk-out, freeing the bed', () => {
    let [s, bed] = bedded(playing(1), 'p1', 'asthma');
    s = startBedTask(s, bed);
    s = tick(s, 200);
    assert.equal(s.beds[bed], null);
    assert.equal(s.transfers, 1);
    assert.equal(s.mistakeCount, 1);
    assert.equal(s.rating, 5 - RATING_PENALTY_PER_WALKOUT);
    assert.equal(s.activeTask, null);
  });

  test('carried meds for a transferred patient are dropped', () => {
    let [s, bed] = bedded(playing(1), 'p1', 'migraine');
    s = resolveBedTask(startBedTask(s, bed), true);
    s = resolveMedsDispense(startMedsDispense(s), true);
    s = tick(s, 500);
    assert.equal(s.carried, null);
  });

  test('Sanity drains and time at 0 is counted', () => {
    let s = tick(playing(1), 10);
    assert.ok(s.sanity < 100);
    s = tick(playing(1, { sanity: 1 }), 20);
    assert.equal(s.sanity, 0);
    assert.ok(s.zeroSanitySeconds > 18 && s.zeroSanitySeconds < 20);
  });

  test('the clock running out starts the handover, then the office opens', () => {
    let s = playing(1);
    s = tick(s, s.totalClockSeconds);
    assert.equal(s.phase, 'closing-wait');
    assert.equal(s.closingWaitSecondsRemaining, CLOSING_WAIT_SECONDS);
    assert.equal(isOfficeReady(s), false);
    assert.equal(enterOffice(s), s);
    s = tick(s, CLOSING_WAIT_SECONDS);
    assert.equal(isOfficeReady(s), true);
  });
});

describe('Karen', () => {
  test('only fires on her shift, once', () => {
    assert.equal(startKarenEvent(playing(5)).karen.active, false);
    const s = startKarenEvent(playing(12));
    assert.equal(s.karen.active, true);
    const resolved = resolveKarenEvent(s, 'explain');
    assert.equal(startKarenEvent(resolved), resolved);
  });

  test('explaining triage earns a tip; letting her cut in is a big mood hit', () => {
    const s = startKarenEvent(playing(12));
    assert.equal(resolveKarenEvent(s, 'explain').bonusGard, KAREN_CALMED_TIP_GARD);
    const bad = resolveKarenEvent(s, 'letCut');
    assert.equal(bad.mistakeCount, 1);
    assert.equal(bad.wardMood, 100 - KAREN_MOOD_PENALTY);
  });

  test('ignoring her lets her cut in', () => {
    const s = tick(startKarenEvent(playing(12)), KAREN_EVENT_TIMER_SECONDS + 1);
    assert.equal(s.karen.outcome, 'letCut');
    assert.equal(s.karen.active, false);
  });
});

describe('payout and extras', () => {
  test('pay = (base + bonuses) × rating × hallucination cut', () => {
    let s = playing(1, { mistakeCount: 1, bonusGard: 100, rating: 4, zeroSanitySeconds: 20 });
    s = enterOffice({ ...s, phase: 'closing-wait', closingWaitSecondsRemaining: 0 });
    assert.equal(s.phase, 'paycheck');
    assert.equal(s.payout, Math.round((shiftPaycheck(1) + 100) * 0.8 * 0.96));
  });

  test('coffee restores Sanity, a perfect pour tips, a spill hurts', () => {
    const s = playing(1, { sanity: 30 });
    assert.equal(brewCoffee(s, 'perfect').sanity, 100);
    assert.equal(brewCoffee(s, 'perfect').bonusGard, COFFEE_PERFECT_TIP_GARD);
    assert.equal(brewCoffee(s, 'good').sanity, 100);
    assert.equal(brewCoffee(s, 'spilled').sanity, 0);
  });

  test('coffee also lifts Ward Mood by grade, capped at full; a spill does nothing for it', () => {
    const s = playing(1, { wardMood: 50 });
    assert.equal(brewCoffee(s, 'perfect').wardMood, 50 + COFFEE_MOOD_RESTORE.perfect);
    assert.equal(brewCoffee(s, 'good').wardMood, 50 + COFFEE_MOOD_RESTORE.good);
    assert.equal(brewCoffee(s, 'sloppy').wardMood, 50 + COFFEE_MOOD_RESTORE.sloppy);
    assert.equal(brewCoffee(s, 'spilled').wardMood, 50);
    assert.equal(brewCoffee(playing(1, { wardMood: 95 }), 'perfect').wardMood, 100);
    assert.equal(brewCoffee(s, 'mystery').wardMood, 50 + COFFEE_MOOD_RESTORE.sloppy);
  });

  test('a ghost patient costs a little Sanity, not a mistake', () => {
    const s = startleFromHallucination(playing(1));
    assert.equal(s.sanity, 95);
    assert.equal(s.mistakeCount, 0);
  });
});
