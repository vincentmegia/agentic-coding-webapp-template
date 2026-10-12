// Pure, canvas-independent game-logic functions for Hospital Shift
// (docs/features/hospital-shift.md's Business Rules / Validation).
//
// No DOM/canvas/localStorage/timer dependencies, so it runs under
// `node --test` and is imported unchanged by hospital-game.js. Mirrors
// Library Shift's rules.js (web/static/js/library/rules.js): named,
// tunable constants, the same round-tier shape, the same shiftPaycheck,
// Sanity, Coffee Pour, star-rating and hallucination rules — ported, not
// reinvented, since the user asked for this game to mirror Library Shift.
// This file has no RNG: callers draw rolls in [0, 1) and pass them in.

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Shifts per run — same 30 as Kitchen/Library Shift. */
export const SHIFTS_PER_MONTH = 30;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clampShift(shiftNumber) {
  const shift = Number.isFinite(shiftNumber) ? Math.floor(shiftNumber) : 1;
  return clamp(shift, 1, SHIFTS_PER_MONTH);
}

function clampRoll(roll) {
  return clamp(Number.isFinite(roll) ? roll : 0.5, 0, 0.999999);
}

/** Exponential ramp from 0 (shift 1) toward 1, shared by every "gets harder with shift number" curve. */
function shiftRamp(shiftNumber, saturation) {
  return 1 - Math.exp(-(clampShift(shiftNumber) - 1) / saturation);
}

// ---------------------------------------------------------------------------
// 1. Round tiers
// ---------------------------------------------------------------------------

export const ROUND_TIER_COUNT = 3;
export const ROUND_TIER_SHIFT_SPAN = 10;

/** Real seconds per shift, per tier — Library Shift's slow 10/8/6 minutes. */
export const ROUND_TIER_CLOCK_SECONDS = [600, 480, 360];

/** Patients arriving at triage over one shift, per tier. Raised from [6, 9, 12] — the user asked to "make it more busier". */
export const ROUND_TIER_PATIENT_VOLUME = [12, 16, 22];

/** The opening patients of every shift arrive within this window (seconds in), so the ER is busy from the start. */
export const FIRST_PATIENT_ARRIVAL_SECONDS = [4, 20];

/** How many patients arrive in that opening window. */
export const EARLY_PATIENT_COUNT = 2;

/** Arrivals stop this far into the shift, leaving time to treat the last ones. */
export const ARRIVAL_WINDOW_FRACTION = 0.85;

export function roundTier(shiftNumber) {
  return clamp(Math.ceil(clampShift(shiftNumber) / ROUND_TIER_SHIFT_SPAN), 1, ROUND_TIER_COUNT);
}

export function shiftClockSecondsForShift(shiftNumber) {
  return ROUND_TIER_CLOCK_SECONDS[roundTier(shiftNumber) - 1];
}

export function patientVolumeForShift(shiftNumber) {
  return ROUND_TIER_PATIENT_VOLUME[roundTier(shiftNumber) - 1];
}

/**
 * When each of a shift's patients arrives, in seconds since the shift
 * began, sorted. The first EARLY_PATIENT_COUNT land in the opening window;
 * the rest are spread evenly — one per equal slice of the remaining
 * arrival window, at a random point inside its slice — so the flow is
 * steady instead of clumping into rushes and dead spells.
 *
 * @param {number} count
 * @param {number} totalSeconds - the shift clock.
 * @param {number[]} rolls - one value in [0, 1) per patient (missing → 0.5).
 * @returns {number[]}
 */
export function patientArrivalTimes(count, totalSeconds, rolls = []) {
  const roll = (i) => clampRoll(rolls[i]);
  const [early, late] = FIRST_PATIENT_ARRIVAL_SECONDS;
  const times = [];
  const earlyCount = Math.min(count, EARLY_PATIENT_COUNT);
  for (let i = 0; i < earlyCount; i++) times.push(early + roll(i) * (late - early));
  const rest = count - earlyCount;
  const windowEnd = Math.max(late, totalSeconds * ARRIVAL_WINDOW_FRACTION);
  const slice = (windowEnd - late) / Math.max(1, rest);
  for (let i = 0; i < rest; i++) times.push(late + (i + roll(earlyCount + i)) * slice);
  return times.sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// 2. In-game clock — the ER day shift runs 7:00 AM to 7:00 PM.
// ---------------------------------------------------------------------------

export const SHIFT_START_MINUTES = 7 * 60;
export const SHIFT_END_MINUTES = 19 * 60;

/**
 * Formats the in-game time from the real seconds left on the shift clock.
 *
 * @param {number} clockSecondsRemaining
 * @param {number} totalClockSeconds
 * @returns {string} e.g. "7:00 AM", "1:30 PM", "7:00 PM".
 */
export function inGameTimeLabel(clockSecondsRemaining, totalClockSeconds) {
  const total = Number.isFinite(totalClockSeconds) && totalClockSeconds > 0 ? totalClockSeconds : ROUND_TIER_CLOCK_SECONDS[0];
  const remaining = Number.isFinite(clockSecondsRemaining) ? clamp(clockSecondsRemaining, 0, total) : total;
  const elapsedFraction = 1 - remaining / total;
  const totalMinutes = Math.round(SHIFT_START_MINUTES + elapsedFraction * (SHIFT_END_MINUTES - SHIFT_START_MINUTES));
  const hour24 = Math.floor(totalMinutes / 60) % 24;
  const minute = totalMinutes % 60;
  const period = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${period}`;
}

// ---------------------------------------------------------------------------
// 3. Karen — the angry relative, once per run on a shift rolled from 10–15,
//    derived deterministically from the save's seed so it survives a reload
//    (Library Shift's karenShiftForSeed, same mulberry32 hash).
// ---------------------------------------------------------------------------

export const KAREN_SHIFT_MIN = 10;
export const KAREN_SHIFT_MAX = 15;

function mulberry32(seed) {
  let t = seed >>> 0;
  return function next() {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function karenShiftForSeed(seed) {
  const value = Number.isFinite(seed) ? Math.floor(seed) : 0;
  const roll = mulberry32(value)();
  const span = KAREN_SHIFT_MAX - KAREN_SHIFT_MIN + 1;
  return KAREN_SHIFT_MIN + Math.min(span - 1, Math.floor(roll * span));
}

/** Seconds to respond before her event auto-resolves as "let her cut in". */
export const KAREN_EVENT_TIMER_SECONDS = 12;
/** Gard for calmly explaining triage (the family's thank-you card). */
export const KAREN_CALMED_TIP_GARD = 30;
/** Ward Mood lost when she's allowed to cut the line — double a normal mistake. */
export const KAREN_MOOD_PENALTY = 50;
export const KAREN_LINE = "MY MOTHER HAS BEEN WAITING FOR HOURS! SEE HER RIGHT NOW!";

// ---------------------------------------------------------------------------
// 4. Triage levels and vitals. vitalsForLevel generates a chart that
//    triageLevelForVitals classifies back to the same level, so the Triage
//    Sort is a real read-the-vitals decision with one right answer.
// ---------------------------------------------------------------------------

export const TRIAGE_LEVELS = [
  { id: 'red', name: 'Red', label: 'Critical', color: '#d9534f' },
  { id: 'yellow', name: 'Yellow', label: 'Urgent', color: '#e8b440' },
  { id: 'green', name: 'Green', label: 'Minor', color: '#5fa86a' },
];

export function findTriageLevel(levelId) {
  return TRIAGE_LEVELS.find((l) => l.id === levelId) ?? null;
}

/** Red-flag thresholds — any one makes a patient Red. */
export const RED_SPO2_BELOW = 90;
export const RED_HR_ABOVE = 130;
export const RED_SYSTOLIC_BELOW = 90;
/** Yellow-flag thresholds (when nothing is Red). */
export const YELLOW_TEMP_AT_LEAST = 38.5;
export const YELLOW_HR_ABOVE = 100;

/** The legend printed on the Triage Sort chart. */
export const TRIAGE_LEGEND = [
  `Red: SpO₂ < ${RED_SPO2_BELOW}%, HR > ${RED_HR_ABOVE} or BP < ${RED_SYSTOLIC_BELOW}`,
  `Yellow: temp ≥ ${YELLOW_TEMP_AT_LEAST}°C or HR ${YELLOW_HR_ABOVE + 1}–${RED_HR_ABOVE}`,
  'Green: everything normal',
];

/**
 * Classifies a set of vitals.
 *
 * @param {{hr: number, systolic: number, diastolic: number, spo2: number, temp: number}} v
 * @returns {'red' | 'yellow' | 'green'}
 */
export function triageLevelForVitals(v) {
  if (v.spo2 < RED_SPO2_BELOW || v.hr > RED_HR_ABOVE || v.systolic < RED_SYSTOLIC_BELOW) return 'red';
  if (v.temp >= YELLOW_TEMP_AT_LEAST || v.hr > YELLOW_HR_ABOVE) return 'yellow';
  return 'green';
}

function lerpInt(min, max, roll) {
  return Math.round(min + clampRoll(roll) * (max - min));
}

function lerpTenth(min, max, roll) {
  return Math.round((min + clampRoll(roll) * (max - min)) * 10) / 10;
}

/**
 * Generates a vitals chart for a triage level from five rolls in [0, 1).
 * Red patients get exactly one red flag (picked by rolls[0]) with the rest
 * normal-ish; Yellow get a fever or a raised HR; Green are normal.
 *
 * @param {'red' | 'yellow' | 'green'} level
 * @param {number[]} rolls - at least 5 values in [0, 1); missing ones default to 0.5.
 * @returns {{hr: number, systolic: number, diastolic: number, spo2: number, temp: number}}
 */
export function vitalsForLevel(level, rolls = []) {
  const r = (i) => (Number.isFinite(rolls[i]) ? rolls[i] : 0.5);
  const normal = {
    hr: lerpInt(62, 96, r(1)),
    systolic: lerpInt(105, 135, r(2)),
    spo2: lerpInt(95, 99, r(3)),
    temp: lerpTenth(36.4, 37.6, r(4)),
  };
  let v = { ...normal };
  if (level === 'red') {
    const flag = Math.floor(clampRoll(r(0)) * 3);
    if (flag === 0) v.spo2 = lerpInt(78, 88, r(3));
    else if (flag === 1) v.hr = lerpInt(135, 165, r(1));
    else v.systolic = lerpInt(70, 85, r(2));
  } else if (level === 'yellow') {
    if (clampRoll(r(0)) < 0.5) v.temp = lerpTenth(38.6, 40.2, r(4));
    else v.hr = lerpInt(104, 126, r(1));
  }
  v.diastolic = Math.round(v.systolic * 0.62);
  return v;
}

// ---------------------------------------------------------------------------
// 5. Conditions — each patient has one: a triage level, a complaint, an
//    ordered treatment plan, and (if it includes 'meds') a drug and dose.
// ---------------------------------------------------------------------------

/** Every treatment step a plan can contain. */
export const TREATMENTS = ['vitals', 'oxygen', 'iv', 'bandage', 'meds', 'surgery'];

/** Steps done as a minigame right at the bed (meds needs the cabinet, surgery the OR). */
export const BED_MINIGAME_TREATMENTS = ['vitals', 'oxygen', 'iv', 'bandage'];

export const TREATMENT_LABELS = {
  vitals: 'Vitals',
  oxygen: 'Oxygen',
  iv: 'IV',
  bandage: 'Bandage',
  meds: 'Meds',
  surgery: 'Surgery',
};

// Bandage steps need a roll from the 2nd-Floor Supply Cart in hand
// (engine-state.js's pickUpBandage) — the user asked for a supply cart "and
// make a second floor where they are on", and for bandages to be more
// common: burn, dog bite and bad fall joined sprain, cut, broken arm and
// crash injuries.

/** Surgery cases only arrive from this shift on, so shift 1 teaches the basics. Was 4 — the user asked for surgeries "on shift 2". */
export const SURGERY_START_SHIFT = 2;

export const CONDITIONS = [
  { id: 'sprain', name: 'Sprained ankle', level: 'green', complaint: 'Twisted my ankle on the stairs.', plan: ['vitals', 'bandage'] },
  { id: 'migraine', name: 'Migraine', level: 'green', complaint: 'Pounding headache since this morning.', plan: ['vitals', 'meds'], med: { drug: 'Ibuprofen', dose: 2 } },
  { id: 'burn', name: 'Kitchen burn', level: 'green', complaint: 'Grabbed a hot pan by the handle.', plan: ['vitals', 'bandage'] },
  { id: 'dehydration', name: 'Dehydration', level: 'green', complaint: 'Dizzy after a long run in the heat.', plan: ['vitals', 'iv'] },
  { id: 'cut', name: 'Deep cut', level: 'yellow', complaint: 'Sliced my hand open cooking dinner.', plan: ['vitals', 'bandage', 'meds'], med: { drug: 'Amoxicillin', dose: 2 } },
  { id: 'bite', name: 'Dog bite', level: 'yellow', complaint: "The neighbor's dog bit my leg.", plan: ['vitals', 'bandage', 'meds'], med: { drug: 'Amoxicillin', dose: 1 } },
  { id: 'fall', name: 'Bad fall', level: 'yellow', complaint: 'Slipped in the shower — scraped and woozy.', plan: ['vitals', 'bandage', 'iv'] },
  { id: 'fever', name: 'High fever', level: 'yellow', complaint: 'Burning up and shivering all night.', plan: ['vitals', 'iv', 'meds'], med: { drug: 'Acetaminophen', dose: 2 } },
  { id: 'fracture', name: 'Broken arm', level: 'yellow', complaint: 'Fell off my bike — my arm looks wrong.', plan: ['vitals', 'meds', 'bandage'], med: { drug: 'Morphine', dose: 1 } },
  { id: 'pneumonia', name: 'Pneumonia', level: 'yellow', complaint: "Coughing for a week, can't catch my breath.", plan: ['vitals', 'oxygen', 'iv'] },
  { id: 'asthma', name: 'Asthma attack', level: 'red', complaint: "Can't… breathe… inhaler isn't working.", plan: ['oxygen', 'meds', 'vitals'], med: { drug: 'Albuterol', dose: 2 } },
  { id: 'allergy', name: 'Allergic reaction', level: 'red', complaint: 'Ate peanuts — throat is closing up.', plan: ['oxygen', 'meds'], med: { drug: 'Epinephrine', dose: 1 } },
  { id: 'appendicitis', name: 'Appendicitis', level: 'red', complaint: 'Sharp pain in my lower right side.', plan: ['vitals', 'iv', 'surgery'], minShift: SURGERY_START_SHIFT },
  { id: 'crash', name: 'Car crash injuries', level: 'red', complaint: 'Car accident — bleeding badly.', plan: ['oxygen', 'iv', 'surgery', 'bandage'], minShift: SURGERY_START_SHIFT },
];

export function findCondition(conditionId) {
  return CONDITIONS.find((c) => c.id === conditionId) ?? null;
}

/** Conditions that can arrive on a given shift (surgery cases gated by SURGERY_START_SHIFT). */
export function conditionsForShift(shiftNumber) {
  const shift = clampShift(shiftNumber);
  return CONDITIONS.filter((c) => (c.minShift ?? 1) <= shift);
}

/** Picks a condition for a roll in [0, 1) from those available on this shift. */
export function conditionForRoll(shiftNumber, roll) {
  const pool = conditionsForShift(shiftNumber);
  return pool[Math.floor(clampRoll(roll) * pool.length)];
}

// ---------------------------------------------------------------------------
// 6. Medications — the Med Cabinet shows the ordered drug among look-alike
//    names, so reading the label matters.
// ---------------------------------------------------------------------------

export const MEDICATIONS = [
  { name: 'Amoxicillin', color: '#e8b440' },
  { name: 'Amoxapine', color: '#e0a83a' },
  { name: 'Acetaminophen', color: '#f2f0ea' },
  { name: 'Acetazolamide', color: '#ece6da' },
  { name: 'Albuterol', color: '#7fb0d6' },
  { name: 'Atenolol', color: '#8cbbe0' },
  { name: 'Epinephrine', color: '#e06a5b' },
  { name: 'Ephedrine', color: '#e47a6b' },
  { name: 'Ibuprofen', color: '#c65f7c' },
  { name: 'Ibandronate', color: '#c8708a' },
  { name: 'Morphine', color: '#9a7ac0' },
  { name: 'Moxifloxacin', color: '#a688c6' },
];

/** Dose choices offered in the Meds Dispensing overlay. */
export const DOSE_CHOICES = [1, 2, 3];

/** How many bottles the cabinet shows (the ordered one plus decoys). */
export const MED_CABINET_BOTTLES = 8;

/**
 * Grades a Meds Dispensing pick.
 *
 * @param {{drug: string, dose: number}} order
 * @param {string} pickedDrug
 * @param {number} pickedDose
 * @returns {'correct' | 'wrong-drug' | 'wrong-dose'}
 */
export function gradeMedsPick(order, pickedDrug, pickedDose) {
  if (pickedDrug !== order.drug) return 'wrong-drug';
  if (pickedDose !== order.dose) return 'wrong-dose';
  return 'correct';
}

// ---------------------------------------------------------------------------
// 7. Skill checks — the timing bar behind Vitals, Oxygen, IV and Surgery
//    (the user: "for the vitals checks and the stuff that pumps oxygen and
//    surgeries i want there to be skill checks"). Same centered gold zone
//    and bouncing sweep as Library Shift's, with a per-treatment width and
//    hit count: Oxygen takes three good pumps, Surgery three stages.
// ---------------------------------------------------------------------------

export const SKILL_CHECKS = {
  vitals: { zoneWidth: 0.22, hits: 1, speedMultiplier: 1 },
  iv: { zoneWidth: 0.16, hits: 1, speedMultiplier: 1 },
  surgery: { zoneWidth: 0.14, hits: 3, speedMultiplier: 1.15 },
};

/** Surgery's three stages, one per hit. */
export const SURGERY_STAGES = ['Incision', 'Repair', 'Sutures'];

export function skillCheckHitsRequired(kind) {
  return SKILL_CHECKS[kind]?.hits ?? 1;
}

/**
 * The gold zone for a skill check, centered at 0.5.
 *
 * @param {string} kind - a SKILL_CHECKS key (unknown kinds use vitals').
 * @param {number} [scale=1] - shaky-hands shrink factor.
 * @returns {{start: number, end: number, width: number}}
 */
export function skillCheckSuccessZone(kind, scale = 1) {
  const base = (SKILL_CHECKS[kind] ?? SKILL_CHECKS.vitals).zoneWidth;
  const width = base * (Number.isFinite(scale) && scale > 0 ? scale : 1);
  return { start: 0.5 - width / 2, end: 0.5 + width / 2, width };
}

export function isSkillCheckSuccess(gaugePosition, zone) {
  return Number.isFinite(gaugePosition) && gaugePosition >= zone.start && gaugePosition <= zone.end;
}

const SKILL_CHECK_SWEEP_SPEED_BASE = 0.6;
const SKILL_CHECK_SWEEP_SPEED_MAX = 1.5;
const SKILL_CHECK_SWEEP_SHIFT_SATURATION = 12;

/** Sweep speed (fraction of the bar per second), ramping with shift number. */
export function skillCheckSweepSpeed(shiftNumber, kind) {
  const ramp = shiftRamp(shiftNumber, SKILL_CHECK_SWEEP_SHIFT_SATURATION);
  const base = SKILL_CHECK_SWEEP_SPEED_BASE + (SKILL_CHECK_SWEEP_SPEED_MAX - SKILL_CHECK_SWEEP_SPEED_BASE) * ramp;
  return base * (SKILL_CHECKS[kind]?.speedMultiplier ?? 1);
}

// ---------------------------------------------------------------------------
// 7.5. Oxygen — a search scene, not a timing bar (the user: "make it find
//      hearts and there will be skulls that symbol missed skill checks").
//      Hearts and skulls are scattered over the scene; each heart clicked
//      is one good pump of the bag, and clicking a skull is a missed skill
//      check — a mistake, with the minigame staying open for a retry.
// ---------------------------------------------------------------------------

/** Hearts to find — one pump each. */
export const OXYGEN_HEARTS = 3;
/** Skull decoys scattered among them. */
export const OXYGEN_SKULLS = 5;

/**
 * Grades a click on the Oxygen scene.
 *
 * @param {{kind: 'heart' | 'skull', found: boolean} | null} item - the item under the click, if any.
 * @returns {'pump' | 'miss' | 'nothing'} 'pump' for a heart, 'miss' for a skull, 'nothing' for empty space or anything already clicked (a clicked skull fades out, so one slip never costs twice).
 */
export function gradeOxygenClick(item) {
  if (!item || item.found) return 'nothing';
  return item.kind === 'skull' ? 'miss' : 'pump';
}

// ---------------------------------------------------------------------------
// 8. Bandage trace — hold and trace the dashed line along the wound.
// ---------------------------------------------------------------------------

/** A sample within this many pixels of the path counts as on it. */
export const BANDAGE_TOLERANCE_PX = 16;
/** Share of the path that must be covered. */
export const BANDAGE_MIN_COVERAGE = 0.85;
/** Share of samples that must be on the path. */
export const BANDAGE_MIN_ACCURACY = 0.7;
/** The path is split into this many segments for coverage. */
export const BANDAGE_COVERAGE_BUCKETS = 20;

/** Distance from point p to segment ab, plus the position t (0..1) along it. */
function projectOntoSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq, 0, 1);
  const cx = a.x + dx * t;
  const cy = a.y + dy * t;
  return { distance: Math.hypot(p.x - cx, p.y - cy), t };
}

/**
 * The nearest point on a polyline to p: its distance and how far along the
 * whole path (0..1, by length) it sits.
 *
 * @param {{x: number, y: number}} p
 * @param {{x: number, y: number}[]} path - at least 2 points.
 * @returns {{distance: number, along: number}}
 */
export function nearestOnPath(p, path) {
  const lengths = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const len = Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
    lengths.push(len);
    total += len;
  }
  let best = { distance: Infinity, along: 0 };
  let walked = 0;
  for (let i = 1; i < path.length; i++) {
    const { distance, t } = projectOntoSegment(p, path[i - 1], path[i]);
    if (distance < best.distance) best = { distance, along: total === 0 ? 0 : (walked + t * lengths[i - 1]) / total };
    walked += lengths[i - 1];
  }
  return best;
}

/**
 * Grades a bandage trace.
 *
 * @param {{x: number, y: number}[]} samples - pointer positions while held.
 * @param {{x: number, y: number}[]} path
 * @returns {{coverage: number, accuracy: number, success: boolean}}
 */
export function gradeBandageTrace(samples, path) {
  if (!Array.isArray(samples) || samples.length === 0 || !Array.isArray(path) || path.length < 2) {
    return { coverage: 0, accuracy: 0, success: false };
  }
  const covered = new Set();
  let onPath = 0;
  for (const s of samples) {
    const { distance, along } = nearestOnPath(s, path);
    if (distance <= BANDAGE_TOLERANCE_PX) {
      onPath++;
      covered.add(Math.min(BANDAGE_COVERAGE_BUCKETS - 1, Math.floor(along * BANDAGE_COVERAGE_BUCKETS)));
    }
  }
  const coverage = covered.size / BANDAGE_COVERAGE_BUCKETS;
  const accuracy = onPath / samples.length;
  return { coverage, accuracy, success: coverage >= BANDAGE_MIN_COVERAGE && accuracy >= BANDAGE_MIN_ACCURACY };
}

/**
 * A wavy wound path across the overlay's work area from rolls in [0, 1).
 *
 * @param {number[]} rolls - 5 values.
 * @returns {{x: number, y: number}[]} 6 points, left to right.
 */
export function bandagePathForRolls(rolls = []) {
  const points = [];
  for (let i = 0; i < 6; i++) {
    const roll = Number.isFinite(rolls[i]) ? rolls[i] : 0.5;
    points.push({ x: 250 + i * 92, y: Math.round(300 + (clampRoll(roll) - 0.5) * 110) });
  }
  return points;
}

// ---------------------------------------------------------------------------
// 9. Patience — queue wait at triage and treatment patience in a bed. Both
//    shrink with shift number and are scaled by Ward Mood at arrival.
// ---------------------------------------------------------------------------

const QUEUE_WAIT_BASE_SECONDS = 90;
const QUEUE_WAIT_MIN_SECONDS = 45;
const QUEUE_WAIT_SHIFT_SATURATION = 10;

export function queueWaitSecondsForShift(shiftNumber) {
  const ramp = shiftRamp(shiftNumber, QUEUE_WAIT_SHIFT_SATURATION);
  return QUEUE_WAIT_BASE_SECONDS - (QUEUE_WAIT_BASE_SECONDS - QUEUE_WAIT_MIN_SECONDS) * ramp;
}

/** Treatment patience at shift 1, by triage level — Red patients can't wait as long. */
export const TREATMENT_PATIENCE_SECONDS = { red: 90, yellow: 120, green: 150 };
/** By late shifts patience shrinks by up to this fraction. */
const TREATMENT_PATIENCE_MAX_SHRINK = 0.35;
const TREATMENT_PATIENCE_SHIFT_SATURATION = 12;

export function treatmentPatienceSeconds(level, shiftNumber) {
  const base = TREATMENT_PATIENCE_SECONDS[level] ?? TREATMENT_PATIENCE_SECONDS.yellow;
  return base * (1 - TREATMENT_PATIENCE_MAX_SHRINK * shiftRamp(shiftNumber, TREATMENT_PATIENCE_SHIFT_SATURATION));
}

// ---------------------------------------------------------------------------
// 10. Ward Mood — Library Mood's analog: −25 per mistake, scales patience.
// ---------------------------------------------------------------------------

export const WARD_MOOD_MAX = 100;
export const WARD_MOOD_DRAIN_PER_MISTAKE = 25;
const WARD_MOOD_MIN_PATIENCE_MULTIPLIER = 0.6;

export function clampWardMood(mood) {
  return clamp(Number.isFinite(mood) ? mood : 0, 0, WARD_MOOD_MAX);
}

export function patienceMultiplierForWardMood(mood) {
  const fraction = clampWardMood(mood) / WARD_MOOD_MAX;
  return WARD_MOOD_MIN_PATIENCE_MULTIPLIER + (1 - WARD_MOOD_MIN_PATIENCE_MULTIPLIER) * fraction;
}

// ---------------------------------------------------------------------------
// 11. Player Sanity — identical to Library/Kitchen Shift's.
// ---------------------------------------------------------------------------

export const SANITY_MAX = 100;
export const SANITY_DRAIN_PER_SECOND = SANITY_MAX / 150;
export const SANITY_DRAIN_PER_UPSET = 15;
const SANITY_MIN_WALK_MULTIPLIER = 0.6;

export function clampSanity(sanity) {
  return clamp(Number.isFinite(sanity) ? sanity : 0, 0, SANITY_MAX);
}

export function walkSpeedMultiplierForSanity(sanity) {
  const fraction = clampSanity(sanity) / SANITY_MAX;
  return SANITY_MIN_WALK_MULTIPLIER + (1 - SANITY_MIN_WALK_MULTIPLIER) * fraction;
}

/** Pushing a gurney is slower than walking. */
export const GURNEY_WALK_MULTIPLIER = 0.8;

// ---------------------------------------------------------------------------
// 12. Coffee Pour — ported from Library Shift (including v2.19's spill).
// ---------------------------------------------------------------------------

export const COFFEE_POUR_SECONDS_TO_BRIM = 2.2;
export const COFFEE_POUR_BAND_WIDTH = 0.12;
export const COFFEE_POUR_GOOD_MARGIN = 0.1;
export const COFFEE_PERFECT_TIP_GARD = 10;
export const COFFEE_SANITY_RESTORE = { perfect: SANITY_MAX, good: 70, sloppy: 40, spilled: -50 };
/**
 * Ward Mood restored per grade — a caffeinated nurse calms the ward (the
 * user: "make the coffee also improve the mood"). Unlike Library Shift,
 * where coffee only touches Sanity. A spill helps nobody.
 */
export const COFFEE_MOOD_RESTORE = { perfect: 20, good: 12, sloppy: 6, spilled: 0 };

export function coffeePourTargetBand(roll) {
  const r = clamp(Number.isFinite(roll) ? roll : 0, 0, 1);
  const center = 0.62 + r * 0.24;
  return { low: center - COFFEE_POUR_BAND_WIDTH / 2, high: center + COFFEE_POUR_BAND_WIDTH / 2 };
}

export function gradeCoffeePour(fill, band) {
  const f = Number.isFinite(fill) ? fill : 0;
  if (f >= 1) return 'spilled';
  if (f >= band.low && f <= band.high) return 'perfect';
  if (f >= band.low - COFFEE_POUR_GOOD_MARGIN && f <= band.high + COFFEE_POUR_GOOD_MARGIN) return 'good';
  return 'sloppy';
}

// ---------------------------------------------------------------------------
// 13. Pay — shiftPaycheck, step tips, discharge bonuses, star rating.
// ---------------------------------------------------------------------------

export const SHIFT_PAYCHECK_FULL = 4000;
export const SHIFT_PAYCHECK_PENALTY_PER_MISTAKE = 500;
export const SHIFT_PAYCHECK_MIN = 500;

export function shiftPaycheck(mistakeCount) {
  const mistakes = Number.isFinite(mistakeCount) && mistakeCount > 0 ? mistakeCount : 0;
  return Math.max(SHIFT_PAYCHECK_MIN, SHIFT_PAYCHECK_FULL - mistakes * SHIFT_PAYCHECK_PENALTY_PER_MISTAKE);
}

/** Gard tip for each treatment step completed. */
export const TREATMENT_TIP_GARD = 5;

/** Gard bonus for discharging a patient, by triage level. */
export const DISCHARGE_GARD = { red: 60, yellow: 40, green: 25 };

export const RATING_MAX = 5;
export const RATING_PENALTY_PER_WALKOUT = 1.5;

export function clampRating(rating) {
  return clamp(Number.isFinite(rating) ? rating : 0, 0, RATING_MAX);
}

export function paycheckMultiplierForRating(rating) {
  return clampRating(rating) / RATING_MAX;
}

/** Seconds of handover after 7:00 PM before the Charge Nurse lets you in. */
export const CLOSING_WAIT_SECONDS = 20;

// ---------------------------------------------------------------------------
// 14. Hallucinations — Library Shift's v2.16 rules.
// ---------------------------------------------------------------------------

export const HALLUCINATION_START_SANITY = 25;

export function hallucinationIntensity(sanity) {
  const s = clampSanity(sanity);
  if (s >= HALLUCINATION_START_SANITY) return 0;
  return (HALLUCINATION_START_SANITY - s) / HALLUCINATION_START_SANITY;
}

export const SHAKY_HANDS_MIN_ZONE_SCALE = 0.5;
export const SHAKY_HANDS_MAX_SWEEP_MULTIPLIER = 1.6;

export function shakyHandsZoneScale(intensity) {
  const i = clamp(Number.isFinite(intensity) ? intensity : 0, 0, 1);
  return 1 - (1 - SHAKY_HANDS_MIN_ZONE_SCALE) * i;
}

export function shakyHandsSweepMultiplier(intensity) {
  const i = clamp(Number.isFinite(intensity) ? intensity : 0, 0, 1);
  return 1 + (SHAKY_HANDS_MAX_SWEEP_MULTIPLIER - 1) * i;
}

/** Chance per second, at full intensity, that carried meds slip from your hands. */
export const MEDS_DROP_CHANCE_PER_SECOND = 0.06;
export const HALLUCINATION_STARTLE_SANITY = 5;
export const ZERO_SANITY_PAY_CUT_PER_10S = 0.02;
export const ZERO_SANITY_PAY_CUT_MAX = 0.3;

export function hallucinationPayMultiplier(zeroSanitySeconds) {
  const seconds = Number.isFinite(zeroSanitySeconds) && zeroSanitySeconds > 0 ? zeroSanitySeconds : 0;
  return 1 - Math.min(ZERO_SANITY_PAY_CUT_MAX, Math.floor(seconds / 10) * ZERO_SANITY_PAY_CUT_PER_10S);
}

export function monthTotal(shiftPayouts) {
  return Array.isArray(shiftPayouts) ? shiftPayouts.reduce((sum, p) => sum + (Number.isFinite(p) ? p : 0), 0) : 0;
}

// ---------------------------------------------------------------------------
// 15. Helping staff — the user picked all three jobs for the background
//     workers ("help"): Dr. Okafor rescues patients about to be transferred,
//     the Orderly wheels surgery patients to the OR on request, and the
//     Stock tech brings bandage rolls downstairs now and then.
// ---------------------------------------------------------------------------

/** Dr. Okafor steps in for a patient below this share of their patience... */
export const DOCTOR_ASSIST_PATIENCE_FRACTION = 0.3;
/** ...finishes their current step (never surgery) and tops their patience up to at least this share... */
export const DOCTOR_ASSIST_PATIENCE_REFILL = 0.5;
/** ...then needs this long before he can help again (also his delay at shift start). */
export const DOCTOR_ASSIST_COOLDOWN_SECONDS = 50;

/** The Stock tech's rhythm: this long upstairs, then this long downstairs with bandage rolls. */
export const STOCK_TECH_UPSTAIRS_SECONDS = 35;
export const STOCK_TECH_DOWNSTAIRS_SECONDS = 25;
