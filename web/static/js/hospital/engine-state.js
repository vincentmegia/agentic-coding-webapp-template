// Pure, DOM-free shift-state management for Hospital Shift
// (docs/features/hospital-shift.md). Same contract as Library Shift's
// engine-state.js: every function takes a state and returns a new one (or
// the same object when the call is a no-op, so callers can detect "nothing
// happened" with `next === state`), and nothing reads a clock — time deltas
// are explicit arguments.
//
// State shape (`ShiftState`):
//   {
//     phase: 'not-started' | 'playing' | 'closing-wait' | 'paycheck',
//     shiftNumber, clockSeconds, totalClockSeconds, closingWaitSecondsRemaining,
//
//     triageQueue: Patient[],       // waiting at the Triage Desk (wait timer each)
//     beds: (BedPatient | null)[],  // BED_COUNT slots
//     carried: null | { kind: 'meds' | 'gurney', bedIndex, patientId }, // what's in your hands
//     hasBandage: boolean,          // a bandage roll in your pocket — never blocks the hands
//       // (the user: "even when i have bandage on i should still be able to
//       // perform the surgery"); any patient's Bandage step uses it
//     activeTask: null | { kind, bedIndex, patientId },
//       // the minigame in progress: 'vitals' | 'oxygen' | 'iv' | 'bandage'
//       // (at a bed), 'meds-dispense' (at the cabinet), 'surgery' (in the OR)
//
//     orderlyGurney: null | { bedIndex, patientId }, // the Orderly wheeling a patient to the OR
//     orPatient: null | { bedIndex, patientId },     // a patient the Orderly left waiting on the OR table
//     doctorCooldownSeconds: number,                 // until Dr. Okafor can step in again
//     doctorAssists: number,                         // times he did this shift
//     karen: { shiftNumber, active, triggered, resolved, outcome, timerSecondsRemaining },
//     wardMood, sanity, rating, walkouts, transfers, discharged,
//     zeroSanitySeconds, mistakeCount, bonusGard, payout,
//   }
//   Patient    = { id, conditionId, level, waitRemainingSeconds, waitMaxSeconds }
//   BedPatient = { id, conditionId, level, plan: string[], step: number,
//                  patienceRemainingSeconds, patienceMaxSeconds, inSurgery: boolean }
//
// Failing a minigame (a missed skill check, a bad bandage, the wrong drug)
// is a mistake but leaves `activeTask` set so the player retries at once —
// Library Shift's retry-on-failure. The patient's patience keeps ticking
// meanwhile, except while they're in surgery (their gurney is being pushed
// or they're on the table), so a patient can't be "transferred" mid-op.

import {
  shiftClockSecondsForShift,
  shiftPaycheck,
  findCondition,
  BED_MINIGAME_TREATMENTS,
  treatmentPatienceSeconds,
  WARD_MOOD_MAX,
  WARD_MOOD_DRAIN_PER_MISTAKE,
  clampWardMood,
  patienceMultiplierForWardMood,
  SANITY_MAX,
  SANITY_DRAIN_PER_SECOND,
  SANITY_DRAIN_PER_UPSET,
  clampSanity,
  KAREN_EVENT_TIMER_SECONDS,
  KAREN_CALMED_TIP_GARD,
  KAREN_MOOD_PENALTY,
  CLOSING_WAIT_SECONDS,
  COFFEE_SANITY_RESTORE,
  COFFEE_PERFECT_TIP_GARD,
  COFFEE_MOOD_RESTORE,
  TREATMENT_TIP_GARD,
  DISCHARGE_GARD,
  RATING_MAX,
  RATING_PENALTY_PER_WALKOUT,
  clampRating,
  paycheckMultiplierForRating,
  hallucinationPayMultiplier,
  HALLUCINATION_STARTLE_SANITY,
  DOCTOR_ASSIST_PATIENCE_FRACTION,
  DOCTOR_ASSIST_PATIENCE_REFILL,
  DOCTOR_ASSIST_COOLDOWN_SECONDS,
} from './rules.js';

export { WARD_MOOD_MAX, SANITY_MAX, RATING_MAX };

/** Treatment beds on the ward. */
export const BED_COUNT = 4;

export function createInitialState(shiftNumber, karenShiftNumber, overrides = {}) {
  const totalClockSeconds = shiftClockSecondsForShift(shiftNumber);
  return {
    phase: 'not-started',
    shiftNumber,
    clockSeconds: totalClockSeconds,
    totalClockSeconds,
    closingWaitSecondsRemaining: 0,

    triageQueue: [],
    beds: Array.from({ length: BED_COUNT }, () => null),
    carried: null,
    hasBandage: false,
    activeTask: null,
    orderlyGurney: null,
    orPatient: null,
    doctorCooldownSeconds: DOCTOR_ASSIST_COOLDOWN_SECONDS,
    doctorAssists: 0,

    karen: {
      shiftNumber: karenShiftNumber,
      active: false,
      triggered: false,
      resolved: false,
      outcome: null,
      timerSecondsRemaining: 0,
    },

    wardMood: WARD_MOOD_MAX,
    sanity: SANITY_MAX,
    rating: RATING_MAX,
    walkouts: 0,
    transfers: 0,
    discharged: 0,
    zeroSanitySeconds: 0,
    mistakeCount: 0,
    bonusGard: 0,
    payout: null,

    ...overrides,
  };
}

export function startShift(state) {
  if (state.phase !== 'not-started') return state;
  return { ...state, phase: 'playing' };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function applyMistake(state) {
  return {
    mistakeCount: state.mistakeCount + 1,
    wardMood: clampWardMood(state.wardMood - WARD_MOOD_DRAIN_PER_MISTAKE),
    sanity: clampSanity(state.sanity - SANITY_DRAIN_PER_UPSET),
  };
}

function applyWalkout(state) {
  return {
    rating: clampRating(state.rating - RATING_PENALTY_PER_WALKOUT),
    walkouts: state.walkouts + 1,
  };
}

function setBed(beds, index, value) {
  return beds.map((b, i) => (i === index ? value : b));
}

/** The step a bedded patient needs next, or null for an empty bed. */
export function currentStep(bedPatient) {
  if (!bedPatient) return null;
  return bedPatient.plan[bedPatient.step] ?? null;
}

/** Index of the first empty bed, or -1 when the ward is full. */
export function freeBedIndex(state) {
  return state.beds.findIndex((b) => b === null);
}

/**
 * Completes the current step of the patient in `bedIndex`: +TREATMENT_TIP_GARD,
 * and if that was the last step, discharges them (DISCHARGE_GARD by level)
 * and frees the bed.
 */
function advanceStep(state, bedIndex, { tip: earnsTip = true } = {}) {
  const patient = state.beds[bedIndex];
  const nextStep = patient.step + 1;
  const tip = state.bonusGard + (earnsTip ? TREATMENT_TIP_GARD : 0);
  if (nextStep >= patient.plan.length) {
    return {
      ...state,
      beds: setBed(state.beds, bedIndex, null),
      bonusGard: tip + (DISCHARGE_GARD[patient.level] ?? 0),
      discharged: state.discharged + 1,
    };
  }
  return { ...state, beds: setBed(state.beds, bedIndex, { ...patient, step: nextStep, inSurgery: false }), bonusGard: tip };
}

// ---------------------------------------------------------------------------
// Triage
// ---------------------------------------------------------------------------

/**
 * A patient arrives at the Triage Desk. Their wait is `waitSeconds` × the
 * Ward Mood multiplier at arrival (omitted = no wait timer).
 *
 * @param {ShiftState} state
 * @param {{id: string, conditionId: string, waitSeconds?: number}} patient
 */
export function addPatientToTriage(state, patient) {
  if (state.phase !== 'playing') return state;
  const condition = findCondition(patient.conditionId);
  if (!condition) return state;
  const wait = Number.isFinite(patient.waitSeconds) && patient.waitSeconds > 0
    ? patient.waitSeconds * patienceMultiplierForWardMood(state.wardMood)
    : null;
  return {
    ...state,
    triageQueue: [...state.triageQueue, {
      id: patient.id,
      conditionId: condition.id,
      level: condition.level,
      waitRemainingSeconds: wait,
      waitMaxSeconds: wait,
    }],
  };
}

/** Whether the Triage Sort can open for this patient: queued, a bed free, nothing else in progress. */
export function canTriage(state, patientId) {
  return state.phase === 'playing'
    && !state.activeTask
    && freeBedIndex(state) !== -1
    && state.triageQueue.some((p) => p.id === patientId);
}

/**
 * Resolves a Triage Sort: the patient leaves the queue for the first free
 * bed whatever the call (the charge nurse corrects a wrong one), and a
 * wrong call is a mistake. Treatment patience is set here, scaled by Ward
 * Mood at bedding. A no-op unless `canTriage`.
 *
 * @param {ShiftState} state
 * @param {string} patientId
 * @param {'red' | 'yellow' | 'green'} chosenLevel
 */
export function resolveTriage(state, patientId, chosenLevel) {
  if (!canTriage(state, patientId)) return state;
  const patient = state.triageQueue.find((p) => p.id === patientId);
  const condition = findCondition(patient.conditionId);
  const bedIndex = freeBedIndex(state);
  const correct = chosenLevel === patient.level;
  const after = correct ? state : { ...state, ...applyMistake(state) };
  const patience = treatmentPatienceSeconds(patient.level, state.shiftNumber) * patienceMultiplierForWardMood(after.wardMood);
  return {
    ...after,
    triageQueue: state.triageQueue.filter((p) => p !== patient),
    beds: setBed(state.beds, bedIndex, {
      id: patient.id,
      conditionId: patient.conditionId,
      level: patient.level,
      plan: [...condition.plan],
      step: 0,
      patienceRemainingSeconds: patience,
      patienceMaxSeconds: patience,
      inSurgery: false,
    }),
  };
}

// ---------------------------------------------------------------------------
// Bed-side minigames: Vitals, Oxygen, IV, Bandage
// ---------------------------------------------------------------------------

/**
 * Starts the bed's current step when it's a bed-side minigame. A no-op if
 * something else is in progress, a gurney is being pushed, or the step
 * needs the cabinet/OR instead.
 */
export function startBedTask(state, bedIndex) {
  if (state.phase !== 'playing' || state.activeTask || state.carried?.kind === 'gurney') return state;
  const patient = state.beds[bedIndex];
  const step = currentStep(patient);
  if (!BED_MINIGAME_TREATMENTS.includes(step)) return state;
  // A Bandage step needs a roll from the Supply Cart in your pocket.
  if (step === 'bandage' && !state.hasBandage) return state;
  return { ...state, activeTask: { kind: step, bedIndex, patientId: patient.id } };
}

/**
 * Resolves the active bed-side minigame. Success completes the step; a
 * failure is a mistake and leaves the task active for a retry.
 */
export function resolveBedTask(state, success) {
  const task = state.activeTask;
  if (state.phase !== 'playing' || !task || !BED_MINIGAME_TREATMENTS.includes(task.kind)) return state;
  if (state.beds[task.bedIndex]?.id !== task.patientId) return { ...state, activeTask: null };
  if (!success) return { ...state, ...applyMistake(state) };
  // A successful dressing uses up the bandage roll.
  const hasBandage = task.kind === 'bandage' ? false : state.hasBandage;
  return advanceStep({ ...state, activeTask: null, hasBandage }, task.bedIndex);
}

// ---------------------------------------------------------------------------
// Meds: dispense at the cabinet, then deliver to the bed
// ---------------------------------------------------------------------------

/** The bed the cabinet fills next: the lowest-patience bed whose current step is Meds, or -1. */
export function nextMedsBedIndex(state) {
  let best = -1;
  state.beds.forEach((patient, i) => {
    if (currentStep(patient) !== 'meds') return;
    if (best === -1 || patient.patienceRemainingSeconds < state.beds[best].patienceRemainingSeconds) best = i;
  });
  return best;
}

/** Opens Meds Dispensing at the cabinet for `nextMedsBedIndex`. A no-op with hands full or no meds order. */
export function startMedsDispense(state) {
  if (state.phase !== 'playing' || state.activeTask || state.carried) return state;
  const bedIndex = nextMedsBedIndex(state);
  if (bedIndex === -1) return state;
  return { ...state, activeTask: { kind: 'meds-dispense', bedIndex, patientId: state.beds[bedIndex].id } };
}

/** Success: now carrying that patient's meds. Failure (wrong drug/dose): a mistake, cabinet stays open. */
export function resolveMedsDispense(state, success) {
  const task = state.activeTask;
  if (state.phase !== 'playing' || task?.kind !== 'meds-dispense') return state;
  if (state.beds[task.bedIndex]?.id !== task.patientId) return { ...state, activeTask: null };
  if (!success) return { ...state, ...applyMistake(state) };
  return { ...state, activeTask: null, carried: { kind: 'meds', bedIndex: task.bedIndex, patientId: task.patientId } };
}

/** Arriving at a bed with that patient's meds: the Meds step completes. */
export function deliverMeds(state, bedIndex) {
  const carried = state.carried;
  if (state.phase !== 'playing' || carried?.kind !== 'meds' || carried.bedIndex !== bedIndex) return state;
  const patient = state.beds[bedIndex];
  if (patient?.id !== carried.patientId || currentStep(patient) !== 'meds') return state;
  return advanceStep({ ...state, carried: null }, bedIndex);
}

/**
 * Hallucination: carried meds — or, with none, the pocketed bandage roll —
 * slip away (the order stays; fetch another). Never mid-minigame.
 */
export function dropCarriedSupply(state) {
  if (state.phase !== 'playing' || state.activeTask) return state;
  if (state.carried?.kind === 'meds') return { ...state, carried: null };
  if (state.hasBandage) return { ...state, hasBandage: false };
  return state;
}

// ---------------------------------------------------------------------------
// Supply Cart (2nd Floor): bandage rolls
// ---------------------------------------------------------------------------

/** Pockets a bandage roll (Supply Cart or the Stock tech). Works with your hands full; one roll at a time. */
export function pickUpBandage(state) {
  if (state.phase !== 'playing' || state.activeTask || state.hasBandage) return state;
  return { ...state, hasBandage: true };
}

// ---------------------------------------------------------------------------
// Surgery: wheel the patient to the OR, then operate
// ---------------------------------------------------------------------------

/** At a bed whose step is Surgery with empty hands: take the gurney. Their patience pauses. */
export function startSurgeryTransport(state, bedIndex) {
  if (state.phase !== 'playing' || state.activeTask || state.carried) return state;
  const patient = state.beds[bedIndex];
  if (currentStep(patient) !== 'surgery' || patient.inSurgery) return state;
  return {
    ...state,
    carried: { kind: 'gurney', bedIndex, patientId: patient.id },
    beds: setBed(state.beds, bedIndex, { ...patient, inSurgery: true }),
  };
}

/**
 * Arriving at the Operating Room opens the surgery — for the gurney you're
 * pushing, or else for a patient the Orderly left on the table (your hands
 * must be free to scrub in).
 */
export function startSurgery(state) {
  if (state.phase !== 'playing' || state.activeTask) return state;
  const carried = state.carried;
  const patient = carried?.kind === 'gurney' ? carried : (!carried ? state.orPatient : null);
  if (!patient) return state;
  return { ...state, activeTask: { kind: 'surgery', bedIndex: patient.bedIndex, patientId: patient.patientId } };
}

/** Success: the patient goes back to their bed with Surgery done. Failure: a mistake, stay on the table. */
export function resolveSurgery(state, success) {
  const task = state.activeTask;
  if (state.phase !== 'playing' || task?.kind !== 'surgery') return state;
  if (!success) return { ...state, ...applyMistake(state) };
  const carried = state.carried?.patientId === task.patientId ? null : state.carried;
  const orPatient = state.orPatient?.patientId === task.patientId ? null : state.orPatient;
  return advanceStep({ ...state, activeTask: null, carried, orPatient }, task.bedIndex);
}

// ---------------------------------------------------------------------------
// Helping staff (rules.js section 15)
// ---------------------------------------------------------------------------

/** A bed waiting on surgery that nobody has wheeled out yet, or -1. The lowest-patience one first. */
export function nextSurgeryBedIndex(state) {
  let best = -1;
  state.beds.forEach((patient, i) => {
    if (currentStep(patient) !== 'surgery' || patient.inSurgery) return;
    if (best === -1 || patient.patienceRemainingSeconds < state.beds[best].patienceRemainingSeconds) best = i;
  });
  return best;
}

/** The Orderly reaches a surgery patient's bed and takes them (their patience pauses). One at a time; the OR table must be free. */
export function orderlyTakePatient(state, bedIndex) {
  if (state.phase !== 'playing' || state.orderlyGurney || state.orPatient) return state;
  const patient = state.beds[bedIndex];
  if (currentStep(patient) !== 'surgery' || patient.inSurgery) return state;
  return {
    ...state,
    orderlyGurney: { bedIndex, patientId: patient.id },
    beds: setBed(state.beds, bedIndex, { ...patient, inSurgery: true }),
  };
}

/** The Orderly reaches the OR: the patient waits on the table for you. */
export function orderlyDeliverToOR(state) {
  if (state.phase !== 'playing' || !state.orderlyGurney) return state;
  return { ...state, orPatient: state.orderlyGurney, orderlyGurney: null };
}

/**
 * The patient Dr. Okafor would step in for right now, or -1: his cooldown
 * is up and someone below DOCTOR_ASSIST_PATIENCE_FRACTION of their
 * patience needs a step other than surgery, isn't mid-minigame with you,
 * and isn't the one whose meds you're carrying. Most urgent first.
 */
export function doctorAssistTarget(state) {
  if (state.phase !== 'playing' || state.doctorCooldownSeconds > 0) return -1;
  let best = -1;
  let bestFraction = DOCTOR_ASSIST_PATIENCE_FRACTION;
  state.beds.forEach((patient, i) => {
    if (!patient || patient.inSurgery || currentStep(patient) === 'surgery') return;
    if (state.activeTask?.patientId === patient.id || state.carried?.patientId === patient.id) return;
    const fraction = patient.patienceRemainingSeconds / patient.patienceMaxSeconds;
    if (fraction < bestFraction) {
      best = i;
      bestFraction = fraction;
    }
  });
  return best;
}

/**
 * Dr. Okafor finishes the current step for the patient in `bedIndex` (no
 * tip — you didn't do it; a discharge still pays), tops their patience up
 * to DOCTOR_ASSIST_PATIENCE_REFILL, and starts his cooldown. A no-op if
 * they're no longer a valid target (the renderer picks the target, then he
 * walks over, so it re-checks on arrival).
 */
export function doctorAssist(state, bedIndex, patientId) {
  if (state.phase !== 'playing' || state.doctorCooldownSeconds > 0) return state;
  const patient = state.beds[bedIndex];
  if (!patient || patient.id !== patientId || patient.inSurgery || currentStep(patient) === 'surgery') return state;
  if (state.activeTask?.patientId === patientId || state.carried?.patientId === patientId) return state;
  if (patient.patienceRemainingSeconds / patient.patienceMaxSeconds >= DOCTOR_ASSIST_PATIENCE_FRACTION) return state;
  const refilled = {
    ...patient,
    patienceRemainingSeconds: Math.max(patient.patienceRemainingSeconds, patient.patienceMaxSeconds * DOCTOR_ASSIST_PATIENCE_REFILL),
  };
  const next = advanceStep({ ...state, beds: setBed(state.beds, bedIndex, refilled) }, bedIndex, { tip: false });
  return { ...next, doctorCooldownSeconds: DOCTOR_ASSIST_COOLDOWN_SECONDS, doctorAssists: state.doctorAssists + 1 };
}

/**
 * Backs out of the active minigame without resolving it (the overlay's ×
 * button): no mistake, the step stays where it was. A gurney already on
 * its way to the OR stays in hand.
 */
export function cancelTask(state) {
  if (state.phase !== 'playing' || !state.activeTask) return state;
  return { ...state, activeTask: null };
}

// ---------------------------------------------------------------------------
// Karen — the angry relative
// ---------------------------------------------------------------------------

export function startKarenEvent(state) {
  if (state.phase !== 'playing') return state;
  if (state.karen.triggered || state.shiftNumber !== state.karen.shiftNumber) return state;
  return {
    ...state,
    karen: { ...state.karen, active: true, triggered: true, timerSecondsRemaining: KAREN_EVENT_TIMER_SECONDS },
  };
}

function resolveKarenOutcome(state, outcome) {
  const karen = { ...state.karen, active: false, resolved: true, outcome };
  if (outcome === 'explain') {
    return { ...state, karen, bonusGard: state.bonusGard + KAREN_CALMED_TIP_GARD };
  }
  return {
    ...state,
    karen,
    mistakeCount: state.mistakeCount + 1,
    wardMood: clampWardMood(state.wardMood - KAREN_MOOD_PENALTY),
    sanity: clampSanity(state.sanity - SANITY_DRAIN_PER_UPSET),
  };
}

/** @param {'explain' | 'letCut'} outcome */
export function resolveKarenEvent(state, outcome) {
  if (state.phase !== 'playing' || !state.karen.active) return state;
  return resolveKarenOutcome(state, outcome === 'explain' ? 'explain' : 'letCut');
}

// ---------------------------------------------------------------------------
// Clock / phase progression
// ---------------------------------------------------------------------------

/**
 * Advances time. In 'playing': the shift clock, Sanity drain (and time at
 * 0 Sanity), triage-queue waits (a timeout is a walk-out: −1.5★), bed
 * patience (a timeout transfers the patient out: a mistake and a
 * walk-out, and drops anything carried/in progress for them), and Karen's
 * timer. At 0 the shift enters 'closing-wait'. In 'closing-wait' only the
 * handover countdown moves.
 */
export function tick(state, deltaSeconds) {
  if (state.phase !== 'playing' && state.phase !== 'closing-wait') return state;
  const delta = Number.isFinite(deltaSeconds) && deltaSeconds > 0 ? deltaSeconds : 0;

  if (state.phase === 'closing-wait') {
    return { ...state, closingWaitSecondsRemaining: Math.max(0, state.closingWaitSecondsRemaining - delta) };
  }

  let next = {
    ...state,
    sanity: clampSanity(state.sanity - SANITY_DRAIN_PER_SECOND * delta),
    doctorCooldownSeconds: Math.max(0, (state.doctorCooldownSeconds ?? 0) - delta),
  };
  if (next.sanity <= 0) {
    const secondsToZero = Math.max(0, state.sanity) / SANITY_DRAIN_PER_SECOND;
    next.zeroSanitySeconds = state.zeroSanitySeconds + Math.max(0, delta - secondsToZero);
  }

  // Triage queue walk-outs.
  let walkedOut = 0;
  const queue = [];
  for (const p of next.triageQueue) {
    if (p.waitRemainingSeconds == null) { queue.push(p); continue; }
    const remaining = p.waitRemainingSeconds - delta;
    if (remaining <= 0) walkedOut++;
    else queue.push({ ...p, waitRemainingSeconds: remaining });
  }
  next.triageQueue = queue;
  for (let i = 0; i < walkedOut; i++) next = { ...next, ...applyWalkout(next) };

  // Bed patience — a patient left too long is transferred out.
  next.beds.forEach((patient, i) => {
    if (!patient || patient.inSurgery) return;
    const remaining = patient.patienceRemainingSeconds - delta;
    if (remaining > 0) {
      next = { ...next, beds: setBed(next.beds, i, { ...patient, patienceRemainingSeconds: remaining }) };
      return;
    }
    next = {
      ...next,
      ...applyMistake(next),
      ...applyWalkout(next),
      transfers: next.transfers + 1,
      beds: setBed(next.beds, i, null),
      carried: next.carried?.patientId === patient.id ? null : next.carried,
      activeTask: next.activeTask?.patientId === patient.id ? null : next.activeTask,
    };
  });

  if (next.karen.active) {
    const remaining = next.karen.timerSecondsRemaining - delta;
    next = remaining <= 0
      ? resolveKarenOutcome(next, 'letCut')
      : { ...next, karen: { ...next.karen, timerSecondsRemaining: remaining } };
  }

  const clockSeconds = Math.max(0, next.clockSeconds - delta);
  if (clockSeconds <= 0) {
    return { ...next, clockSeconds: 0, phase: 'closing-wait', closingWaitSecondsRemaining: CLOSING_WAIT_SECONDS, activeTask: null };
  }
  return { ...next, clockSeconds };
}

export function isOfficeReady(state) {
  return state.phase === 'closing-wait' && state.closingWaitSecondsRemaining <= 0;
}

/**
 * Walking into the Charge Nurse's office after handover: 'paycheck', with
 * payout = (shiftPaycheck(mistakes) + bonusGard) × rating/5 × the
 * hallucination multiplier.
 */
export function enterOffice(state) {
  if (!isOfficeReady(state)) return state;
  const gross = Math.max(0, shiftPaycheck(state.mistakeCount) + state.bonusGard);
  const multiplier = paycheckMultiplierForRating(state.rating) * hallucinationPayMultiplier(state.zeroSanitySeconds);
  return { ...state, phase: 'paycheck', payout: Math.round(gross * multiplier) };
}

/** A finished Coffee Pour: that grade's Sanity and Ward Mood change, plus a tip for a perfect pour. */
export function brewCoffee(state, grade) {
  if (state.phase !== 'playing') return state;
  const known = grade in COFFEE_SANITY_RESTORE ? grade : 'sloppy';
  return {
    ...state,
    sanity: clampSanity(state.sanity + COFFEE_SANITY_RESTORE[known]),
    wardMood: clampWardMood(state.wardMood + COFFEE_MOOD_RESTORE[known]),
    bonusGard: state.bonusGard + (grade === 'perfect' ? COFFEE_PERFECT_TIP_GARD : 0),
  };
}

/** Walking up to a ghost patient who isn't there: −5 Sanity, not a mistake. */
export function startleFromHallucination(state) {
  if (state.phase !== 'playing') return state;
  return { ...state, sanity: clampSanity(state.sanity - HALLUCINATION_STARTLE_SANITY) };
}
