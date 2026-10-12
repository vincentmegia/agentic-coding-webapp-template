// Hospital Shift canvas engine: rendering, input, station interaction,
// patient spawning, minigame overlays and localStorage progress
// (docs/features/hospital-shift.md). Same architecture as Library Shift's
// library-game.js — bootstrap()/init() split, one requestAnimationFrame
// loop, letterbox-aware click mapping, the htmx-revisit bootstrap fix —
// with every shift-state transition delegated to ./hospital/engine-state.js,
// the numbers to ./hospital/rules.js and the geometry to
// ./hospital/floor-plan.js. This file owns what those can't: drawing, input,
// spawn pacing, the overlays' own transient state (gauge position, traced
// points, picked bottle) and the single localStorage key.
//
// Every minigame is a full-canvas overlay drawn by render() and fed by the
// same canvas listeners as movement, gated on `overlay`.
//
// Loaded as a module from web/templates/pages/hospital-shift.html.

import { drawPerson, shadeColor, PEOPLE_TEMPLATES } from './shared/people.js';
import {
  SHIFTS_PER_MONTH,
  patientVolumeForShift,
  FIRST_PATIENT_ARRIVAL_SECONDS,
  inGameTimeLabel,
  karenShiftForSeed,
  KAREN_LINE,
  KAREN_CALMED_TIP_GARD,
  TRIAGE_LEVELS,
  findTriageLevel,
  TRIAGE_LEGEND,
  vitalsForLevel,
  findCondition,
  conditionForRoll,
  TREATMENT_LABELS,
  BED_MINIGAME_TREATMENTS,
  MEDICATIONS,
  DOSE_CHOICES,
  MED_CABINET_BOTTLES,
  gradeMedsPick,
  SURGERY_STAGES,
  skillCheckHitsRequired,
  skillCheckSuccessZone,
  isSkillCheckSuccess,
  skillCheckSweepSpeed,
  gradeBandageTrace,
  bandagePathForRolls,
  BANDAGE_TOLERANCE_PX,
  OXYGEN_HEARTS,
  OXYGEN_SKULLS,
  gradeOxygenClick,
  queueWaitSecondsForShift,
  WARD_MOOD_MAX,
  SANITY_MAX,
  walkSpeedMultiplierForSanity,
  GURNEY_WALK_MULTIPLIER,
  coffeePourTargetBand,
  gradeCoffeePour,
  COFFEE_POUR_SECONDS_TO_BRIM,
  COFFEE_PERFECT_TIP_GARD,
  COFFEE_MOOD_RESTORE,
  RATING_MAX,
  RATING_PENALTY_PER_WALKOUT,
  paycheckMultiplierForRating,
  hallucinationIntensity,
  shakyHandsZoneScale,
  shakyHandsSweepMultiplier,
  MEDS_DROP_CHANCE_PER_SECOND,
  HALLUCINATION_START_SANITY,
  hallucinationPayMultiplier,
  TREATMENT_TIP_GARD,
  DISCHARGE_GARD,
} from './hospital/rules.js';
import {
  createInitialState,
  startShift as startShiftState,
  addPatientToTriage,
  canTriage,
  resolveTriage,
  currentStep,
  freeBedIndex,
  startBedTask,
  resolveBedTask,
  startMedsDispense,
  resolveMedsDispense,
  deliverMeds,
  dropCarriedMeds,
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
} from './hospital/engine-state.js';
import {
  buildStations,
  stationAtPoint,
  standoffFor,
  approachPoint,
  clampToCanvas,
  PLAYER_START,
  PLAYER_STOP_MARGIN,
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
} from './hospital/floor-plan.js';

// ---------------------------------------------------------------------------
// localStorage progress
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'hospital-game:v1';

function defaultSave() {
  return { version: 1, monthToDateGard: 0, currentShift: 1, bestRunTotal: 0, karenSeed: Date.now() };
}

function probeStorageAvailable() {
  try {
    const probeKey = '\0hospital-game-probe';
    window.localStorage.setItem(probeKey, '1');
    window.localStorage.removeItem(probeKey);
    return true;
  } catch {
    return false;
  }
}

function isValidSaveShape(value) {
  if (!value || typeof value !== 'object' || value.version !== 1) return false;
  return ['monthToDateGard', 'currentShift', 'bestRunTotal', 'karenSeed']
    .every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]));
}

export function loadSave(storageAvailable) {
  if (!storageAvailable) return defaultSave();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultSave();
    const parsed = JSON.parse(raw);
    if (!isValidSaveShape(parsed)) return defaultSave();
    return {
      version: 1,
      monthToDateGard: Math.max(0, parsed.monthToDateGard),
      currentShift: Math.min(SHIFTS_PER_MONTH, Math.max(1, Math.round(parsed.currentShift))),
      bestRunTotal: Math.max(0, parsed.bestRunTotal),
      karenSeed: Math.round(parsed.karenSeed),
    };
  } catch {
    return defaultSave();
  }
}

function persistSave(storageAvailable, save) {
  if (!storageAvailable) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(save));
  } catch {
    // Storage went away mid-session — keep playing, just stop persisting.
  }
}

// ---------------------------------------------------------------------------
// Drawing primitives (Library Shift's)
// ---------------------------------------------------------------------------

function drawRoundRect(ctx, x, y, w, h, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

function drawStar(ctx, cx, cy, outerRadius, innerRadius, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const radius = i % 2 === 0 ? outerRadius : innerRadius;
    const angle = (Math.PI / 5) * i - Math.PI / 2;
    const px = cx + Math.cos(angle) * radius;
    const py = cy + Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
}

const LABEL_TEXT_COLOR = '#3a2a2a';
const CREAM = '#fdf8ee';

function drawLabelChip(ctx, x, y, text, font, fill = 'rgba(255,251,246,0.92)', ink = LABEL_TEXT_COLOR) {
  if (!text) return;
  ctx.save();
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width + 14;
  const h = 16;
  drawRoundRect(ctx, x - w / 2, y - h / 2, w, h, 6, fill);
  ctx.strokeStyle = 'rgba(58,42,42,0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - h / 2, w, h, 6);
  ctx.stroke();
  ctx.fillStyle = ink;
  ctx.fillText(text, x, y + 0.5);
  ctx.restore();
}

function insideRect(r, x, y) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

// ---------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------

/** Library Shift's big-character scale. */
export const PERSON_SCALE = 1.55;

export const PERSON_TEMPLATES = {
  ...PEOPLE_TEMPLATES,
  nurse: {
    label: 'Maya Santos',
    bodyColor: '#6fb3b0', pantsColor: '#5a9e9b', headColor: '#c68e5a', hairColor: '#2a1c14', accentColor: '#34343e',
    eyeColor: '#2a2a2a', eyeShape: 'bigRound', browAngle: 0.3, mouthCurve: 1.1, blush: true,
    hairStyle: 'bun', outfit: 'scrubs', shoeColor: '#f2f0ea',
  },
};

/** Every design a patient can have (not Karen, not the nurse). */
export const PATIENT_PERSONALITY_KEYS = ['grumpyRegular', 'shyStudent', 'cheerfulKid', 'teen', 'grandma', 'businessman', 'artist', 'bearded', 'curly'];

export const PLAYER_NAME = 'Nurse Maya';

const PATIENT_NAMES = ['Rahul P.', 'Ana L.', 'Ben O.', 'Mei T.', 'Omar S.', 'Grace K.', 'Leo M.', 'Priya N.', 'Sam W.', 'Ivy C.', 'Tomas R.', 'Zara H.', 'Kenji A.', 'Lola D.', 'Hugo B.', 'Nadia F.'];

function hashId(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

function drawHospitalPerson(ctx, x, y, opts = {}) {
  const base = PERSON_TEMPLATES[opts.personalityKey] || PERSON_TEMPLATES.shyStudent;
  drawPerson(ctx, x, y, base, { ...opts, scale: (opts.scale ?? 1) * PERSON_SCALE });
}

// ---------------------------------------------------------------------------
// init()
// ---------------------------------------------------------------------------

/** Overlays tied to an engine `activeTask` (closing it means cancelTask). */
const TASK_OVERLAYS = new Set(['skill', 'oxygen', 'bandage', 'meds']);

/**
 * Wires the game to hospital-shift.html's elements.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} elements
 * @returns {() => void} teardown (also run on htmx nav-away).
 */
export function init(canvas, elements) {
  if (typeof teardownActiveInstance === 'function') teardownActiveInstance();

  const ctx = canvas.getContext('2d');
  const storageAvailable = probeStorageAvailable();
  const save = loadSave(storageAvailable);
  const random = Math.random;

  const stations = buildStations();
  const stationOfKind = (kind) => stations.find((s) => s.kind === kind);
  const bedStation = (index) => stations.find((s) => s.kind === 'bed' && s.bedIndex === index);

  let player = { ...PLAYER_START };
  let moveTarget = null; // { x, y, station }
  let hoverStation = null;

  let currentShiftNumber = save.currentShift;
  let karenShiftNumber = karenShiftForSeed(save.karenSeed);
  let karenAvailable = false;

  let shiftState = null;
  let running = false;
  let paused = false;
  let lastTimestamp = null;
  let rafHandle = null;
  let toastTimeoutHandle = null;

  let scheduledEvents = [];
  let patientIdCounter = 0;
  /** id -> { name, vitals, personalityKey } — chart flavor the engine doesn't carry. */
  const patientInfo = new Map();

  let overlay = null;
  let pendingTriageAction = null; // { kind: 'patient'|'karen'|'ghost', id? }
  let waitingAtOffice = false;

  let sanityFontReady = false;
  document.fonts.ready.then(() => { sanityFontReady = true; }).catch(() => {});

  // -- Toast / screens / HUD -----------------------------------------------

  function showToast(text, seconds = 2.8) {
    elements.toast.textContent = text;
    elements.toast.classList.remove('hidden');
    if (toastTimeoutHandle) window.clearTimeout(toastTimeoutHandle);
    toastTimeoutHandle = window.setTimeout(() => elements.toast.classList.add('hidden'), seconds * 1000);
  }

  function showScreen(name) {
    elements.startScreen.root.classList.toggle('hidden', name !== 'start');
    elements.paycheckScreen.root.classList.toggle('hidden', name !== 'paycheck');
  }

  function renderHud() {
    elements.hud.shift.textContent = `${currentShiftNumber}/${SHIFTS_PER_MONTH}`;
    if (!shiftState) {
      elements.hud.clock.textContent = '--:--';
      elements.hud.status.textContent = 'Quiet';
      return;
    }
    elements.hud.clock.textContent = inGameTimeLabel(shiftState.clockSeconds, shiftState.totalClockSeconds);
    let status;
    if (shiftState.phase === 'closing-wait') status = isOfficeReady(shiftState) ? 'Handover — go in' : 'Handover…';
    else if (shiftState.phase === 'paycheck') status = 'Shift over';
    else if (shiftState.wardMood > 70) status = 'Calm';
    else if (shiftState.wardMood > 30) status = 'Busy';
    else status = 'Chaotic';
    elements.hud.status.textContent = status;
  }

  function bedLabel(index) {
    return `Bed ${index + 1}`;
  }

  function labelForStation(station) {
    switch (station.kind) {
      case 'bed': return bedLabel(station.bedIndex);
      case 'triage-desk': return 'Triage Desk';
      case 'med-cabinet': return 'Med Cabinet';
      case 'operating-room': return 'Operating Room';
      case 'coffee-machine': return 'Coffee Machine';
      case 'office':
        if (shiftState?.phase === 'playing') return 'Charge Nurse (after 7 PM)';
        if (shiftState?.phase === 'closing-wait' && !isOfficeReady(shiftState)) return `Charge Nurse (${Math.ceil(shiftState.closingWaitSecondsRemaining)}s)`;
        return 'Charge Nurse';
      default: return '';
    }
  }

  function hintForStation(station) {
    const label = labelForStation(station);
    if (station.kind !== 'bed' || !shiftState) return label;
    const patient = shiftState.beds[station.bedIndex];
    if (!patient) return `${label} — empty`;
    if (patient.inSurgery) return `${label} — in the OR`;
    const step = currentStep(patient);
    const name = patientInfo.get(patient.id)?.name ?? 'Patient';
    return `${label} — ${name} needs ${TREATMENT_LABELS[step]}`;
  }

  function updateHoverHint() {
    if (overlay || !running || !hoverStation) {
      elements.hoverHint.classList.add('hidden');
      return;
    }
    elements.hoverHint.textContent = hintForStation(hoverStation);
    elements.hoverHint.classList.remove('hidden');
  }

  // -- Movement ---------------------------------------------------------------

  // Letterbox-aware mapping, ported from library-game.js: in fullscreen the
  // canvas box isn't 960:600 and object-fit: contain letterboxes it.
  function canvasCoordsFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const worldAspect = CANVAS_WIDTH / CANVAS_HEIGHT;
    let contentWidth = rect.width;
    let contentHeight = rect.height;
    let offsetX = 0;
    let offsetY = 0;
    if (rect.width / rect.height > worldAspect) {
      contentWidth = rect.height * worldAspect;
      offsetX = (rect.width - contentWidth) / 2;
    } else {
      contentHeight = rect.width / worldAspect;
      offsetY = (rect.height - contentHeight) / 2;
    }
    return {
      x: ((e.clientX - rect.left - offsetX) / contentWidth) * CANVAS_WIDTH,
      y: ((e.clientY - rect.top - offsetY) / contentHeight) * CANVAS_HEIGHT,
    };
  }

  function commitStationTarget(station, rawPoint) {
    if (station?.kind !== 'office') waitingAtOffice = false;
    if (station) {
      const approach = approachPoint(station.x, station.y, player.x, player.y, standoffFor(station, player.x, player.y));
      moveTarget = { x: approach.x, y: approach.y, station };
    } else if (rawPoint) {
      moveTarget = { x: rawPoint.x, y: rawPoint.y, station: null };
    }
  }

  function updatePlayer(deltaSeconds) {
    if (!moveTarget) return;
    const gurney = shiftState?.carried?.kind === 'gurney' ? GURNEY_WALK_MULTIPLIER : 1;
    const step = 240 * walkSpeedMultiplierForSanity(shiftState ? shiftState.sanity : SANITY_MAX) * gurney * deltaSeconds;
    const dx = moveTarget.x - player.x;
    const dy = moveTarget.y - player.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= step || dist === 0) {
      player = clampToCanvas(moveTarget.x, moveTarget.y);
      const arrived = moveTarget.station;
      moveTarget = null;
      if (arrived) handleArrival(arrived);
    } else {
      player = clampToCanvas(player.x + (dx / dist) * step, player.y + (dy / dist) * step);
    }
  }

  function isPlayerAtOffice() {
    const office = stationOfKind('office');
    return Math.hypot(player.x - office.x, player.y - office.y) <= office.w / 2 + PLAYER_STOP_MARGIN + 30;
  }

  function enterOfficeNow() {
    waitingAtOffice = false;
    shiftState = enterOffice(shiftState);
    endShift();
  }

  // -- Triage queue -------------------------------------------------------------

  const QUEUE_VISIBLE_MAX = 4;
  const QUEUE_SLOT_PITCH = 46;
  const QUEUE_SLOT_OFFSET_Y = 72;

  function triageSlots() {
    if (!shiftState) return [];
    const slots = [];
    if (karenAvailable && !shiftState.karen.triggered && shiftState.phase === 'playing') slots.push({ kind: 'karen', id: 'karen' });
    shiftState.triageQueue.slice(0, QUEUE_VISIBLE_MAX).forEach((p) => slots.push({
      kind: 'patient', id: p.id, waitFraction: p.waitMaxSeconds ? p.waitRemainingSeconds / p.waitMaxSeconds : null,
    }));
    halluc.ghosts.forEach((g) => slots.push({ kind: 'ghost', id: g.id }));
    const desk = stationOfKind('triage-desk');
    const totalWidth = (slots.length - 1) * QUEUE_SLOT_PITCH;
    return slots.map((slot, i) => ({
      ...slot,
      x: desk.x - totalWidth / 2 + i * QUEUE_SLOT_PITCH,
      y: desk.y + desk.h / 2 + QUEUE_SLOT_OFFSET_Y,
    }));
  }

  /** A queued patient's whole drawn body (their slot y is their feet). */
  function triageSlotAtPoint(x, y) {
    return triageSlots().find((slot) => Math.abs(x - slot.x) <= 22 && y >= slot.y - 50 && y <= slot.y + 26) || null;
  }

  // -- Spawning -------------------------------------------------------------------

  function scheduleShiftEvents() {
    const total = shiftState.totalClockSeconds;
    const events = [];
    const count = patientVolumeForShift(currentShiftNumber);
    for (let i = 0; i < count; i++) {
      const [early, late] = FIRST_PATIENT_ARRIVAL_SECONDS;
      events.push({ type: 'patient', at: i === 0 ? early + random() * (late - early) : random() * total * 0.85 });
    }
    if (currentShiftNumber === karenShiftNumber) events.push({ type: 'karen', at: total * 0.3 });
    return events.sort((a, b) => a.at - b.at);
  }

  function spawnPatient(conditionId) {
    const condition = findCondition(conditionId) ?? conditionForRoll(currentShiftNumber, random());
    const id = `patient-${patientIdCounter++}`;
    const h = hashId(id);
    patientInfo.set(id, {
      name: PATIENT_NAMES[(h + patientIdCounter) % PATIENT_NAMES.length],
      vitals: vitalsForLevel(condition.level, [random(), random(), random(), random(), random()]),
      personalityKey: PATIENT_PERSONALITY_KEYS[h % PATIENT_PERSONALITY_KEYS.length],
    });
    shiftState = addPatientToTriage(shiftState, { id, conditionId: condition.id, waitSeconds: queueWaitSecondsForShift(currentShiftNumber) });
    return id;
  }

  function processScheduledEvents() {
    const elapsed = shiftState.totalClockSeconds - shiftState.clockSeconds;
    while (scheduledEvents.length && scheduledEvents[0].at <= elapsed) {
      const event = scheduledEvents.shift();
      if (event.type === 'patient') spawnPatient();
      else if (event.type === 'karen') karenAvailable = true;
    }
  }

  // -- Overlays: open ---------------------------------------------------------------

  function openTriageOverlay(patientId) {
    overlay = { kind: 'triage', patientId };
  }

  function openSkillOverlay(task) {
    overlay = {
      kind: 'skill', task, gauge: 0, direction: 1, hits: 0,
      required: skillCheckHitsRequired(task), flash: null,
    };
  }

  function openBandageOverlay() {
    overlay = {
      kind: 'bandage',
      path: bandagePathForRolls([random(), random(), random(), random(), random(), random()]),
      samples: [], tracing: false, flash: null, closeIn: 0,
    };
  }

  function openMedsOverlay() {
    const order = findCondition(shiftState.beds[shiftState.activeTask.bedIndex].conditionId).med;
    const others = MEDICATIONS.filter((m) => m.name !== order.drug);
    // Always include the look-alikes (same first letter), then fill with others.
    const lookAlikes = others.filter((m) => m.name[0] === order.drug[0]);
    const rest = others.filter((m) => m.name[0] !== order.drug[0]).sort(() => random() - 0.5);
    const picks = [MEDICATIONS.find((m) => m.name === order.drug), ...lookAlikes, ...rest].slice(0, MED_CABINET_BOTTLES);
    for (let i = picks.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [picks[i], picks[j]] = [picks[j], picks[i]];
    }
    overlay = { kind: 'meds', order, bottles: picks, picked: null, flash: null };
  }

  function openKarenOverlay() {
    overlay = { kind: 'karen' };
  }

  function openCoffeeOverlay() {
    overlay = { kind: 'coffee-pour', fill: 0, pouring: false, band: coffeePourTargetBand(random()), grade: null, closeIn: 0 };
  }

  /** Where the Oxygen scene scatters its hearts and skulls (right of the patient and bag). */
  const OXYGEN_SCENE = { x: 390, y: 172, w: 420, h: 276 };
  const OXYGEN_HIT_RADIUS = 26;

  function openOxygenOverlay() {
    const count = OXYGEN_HEARTS + OXYGEN_SKULLS;
    const points = [];
    for (let i = 0; i < count; i++) {
      let candidate;
      for (let attempt = 0; attempt < 60; attempt++) {
        candidate = { x: OXYGEN_SCENE.x + random() * OXYGEN_SCENE.w, y: OXYGEN_SCENE.y + random() * OXYGEN_SCENE.h };
        if (points.every((p) => Math.hypot(p.x - candidate.x, p.y - candidate.y) >= 72)) break;
      }
      points.push(candidate);
    }
    // Shuffle which points are hearts so they aren't always the first-placed ones.
    const kinds = [...Array(OXYGEN_HEARTS).fill('heart'), ...Array(OXYGEN_SKULLS).fill('skull')];
    for (let i = kinds.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
    }
    overlay = {
      kind: 'oxygen',
      items: points.map((p, i) => ({ id: i, x: p.x, y: p.y, kind: kinds[i], found: false, fade: 0, phase: random() * Math.PI * 2 })),
      hits: 0, required: OXYGEN_HEARTS, squeeze: 0, flash: null,
    };
  }

  function openTaskOverlay(task) {
    if (task === 'bandage') openBandageOverlay();
    else if (task === 'oxygen') openOxygenOverlay();
    else openSkillOverlay(task);
  }

  function flash(text, good) {
    if (overlay) overlay.flash = { text, good, seconds: 0.9 };
  }

  // -- Arrival dispatch ---------------------------------------------------------

  function handleArrival(station) {
    if (!shiftState) return;
    const playing = shiftState.phase === 'playing';

    if (station.kind === 'office') {
      if (isOfficeReady(shiftState)) {
        enterOfficeNow();
      } else if (shiftState.phase === 'closing-wait') {
        waitingAtOffice = true;
        showToast(`Handing over to the night shift — wait here ${Math.ceil(shiftState.closingWaitSecondsRemaining)}s.`);
      } else if (playing) {
        showToast('The charge nurse pays you after the shift ends at 7:00 PM.');
      }
      return;
    }
    if (!playing) return;

    if (station.kind === 'triage-desk') {
      const action = pendingTriageAction
        ?? (karenAvailable && !shiftState.karen.triggered ? { kind: 'karen' } : null)
        ?? (shiftState.triageQueue[0] ? { kind: 'patient', id: shiftState.triageQueue[0].id } : null);
      pendingTriageAction = null;
      if (!action) {
        showToast('Nobody waiting at triage right now.');
      } else if (action.kind === 'ghost') {
        halluc.ghosts = halluc.ghosts.filter((g) => g.id !== action.id);
        shiftState = startleFromHallucination(shiftState);
        showToast("…the chair is empty. There was nobody there.");
      } else if (action.kind === 'karen') {
        const before = shiftState;
        shiftState = startKarenEvent(shiftState);
        if (shiftState !== before) openKarenOverlay();
      } else if (canTriage(shiftState, action.id)) {
        openTriageOverlay(action.id);
      } else if (freeBedIndex(shiftState) === -1) {
        showToast('No free beds — treat and discharge someone first.');
      }
      return;
    }

    if (station.kind === 'bed') {
      handleBedArrival(station.bedIndex);
      return;
    }

    if (station.kind === 'med-cabinet') {
      if (shiftState.carried) {
        showToast(shiftState.carried.kind === 'meds'
          ? `You're already holding meds for ${bedLabel(shiftState.carried.bedIndex)}.`
          : "Your hands are on the gurney — get it to the OR first.");
        return;
      }
      const before = shiftState;
      shiftState = startMedsDispense(shiftState);
      if (shiftState !== before) openMedsOverlay();
      else showToast('No medication orders right now.');
      return;
    }

    if (station.kind === 'operating-room') {
      const before = shiftState;
      shiftState = startSurgery(shiftState);
      if (shiftState !== before) openSkillOverlay('surgery');
      else showToast('Bring a patient who needs surgery — take their gurney from the bed.');
      return;
    }

    if (station.kind === 'coffee-machine') openCoffeeOverlay();
  }

  function handleBedArrival(bedIndex) {
    const patient = shiftState.beds[bedIndex];
    const label = bedLabel(bedIndex);
    const carried = shiftState.carried;
    if (!patient) {
      showToast(`${label} is empty — triage someone into it.`);
      return;
    }
    if (patient.inSurgery) {
      showToast(`${label}'s patient is with you on the gurney — head to the OR.`);
      return;
    }
    if (carried?.kind === 'meds') {
      if (carried.bedIndex !== bedIndex) {
        showToast(`These meds are for ${bedLabel(carried.bedIndex)}.`);
        return;
      }
      const before = shiftState;
      shiftState = deliverMeds(shiftState, bedIndex);
      if (shiftState !== before) announceStepDone(bedIndex, before, 'Meds given');
      return;
    }
    if (carried?.kind === 'gurney') {
      showToast("You're pushing a gurney — take it to the Operating Room.");
      return;
    }
    const step = currentStep(patient);
    if (BED_MINIGAME_TREATMENTS.includes(step)) {
      const before = shiftState;
      shiftState = startBedTask(shiftState, bedIndex);
      if (shiftState !== before) openTaskOverlay(step);
    } else if (step === 'meds') {
      const med = findCondition(patient.conditionId).med;
      showToast(`${label} needs ${med.drug} ×${med.dose} — get it from the Med Cabinet.`);
    } else if (step === 'surgery') {
      shiftState = startSurgeryTransport(shiftState, bedIndex);
      showToast(`Wheeling ${label}'s patient to the Operating Room…`);
    }
  }

  /** Toast for a completed step — "discharged" when it emptied the bed. */
  function announceStepDone(bedIndex, before, what) {
    const patient = before.beds[bedIndex];
    const name = patientInfo.get(patient.id)?.name ?? 'The patient';
    if (!shiftState.beds[bedIndex]) {
      showToast(`${what} — ${name} is discharged! +${TREATMENT_TIP_GARD + DISCHARGE_GARD[patient.level]}g`);
    } else {
      showToast(`${what} +${TREATMENT_TIP_GARD}g — next for ${name}: ${TREATMENT_LABELS[currentStep(shiftState.beds[bedIndex])]}.`);
    }
  }

  // -- Overlay input ------------------------------------------------------------------

  const PANEL = { x: 110, y: 64, w: 740, h: 480 };
  const CLOSE_RECT = { x: PANEL.x + PANEL.w - 40, y: PANEL.y + 12, w: 28, h: 28 };

  function closeOverlay() {
    if (!overlay) return;
    if (overlay.kind === 'karen') return; // she won't be ignored — answer her
    if (overlay.kind === 'coffee-pour' && (overlay.pouring || overlay.grade)) return;
    if (TASK_OVERLAYS.has(overlay.kind)) shiftState = cancelTask(shiftState);
    overlay = null;
  }

  function triageButtonRects() {
    const w = 170;
    const gap = 20;
    const startX = CANVAS_WIDTH / 2 - (TRIAGE_LEVELS.length * w + (TRIAGE_LEVELS.length - 1) * gap) / 2;
    return TRIAGE_LEVELS.map((level, i) => ({ level: level.id, x: startX + i * (w + gap), y: 462, w, h: 50 }));
  }

  function chooseTriage(levelId) {
    const patientId = overlay.patientId;
    const queued = shiftState.triageQueue.find((p) => p.id === patientId);
    if (!queued) { overlay = null; return; }
    const bedIndex = freeBedIndex(shiftState);
    shiftState = resolveTriage(shiftState, patientId, levelId);
    overlay = null;
    const actual = findTriageLevel(queued.level);
    const name = patientInfo.get(patientId)?.name ?? 'Patient';
    if (levelId === queued.level) showToast(`${name} → ${bedLabel(bedIndex)} (${actual.name}). Good call.`);
    else showToast(`Not quite — ${name} is ${actual.name}. The charge nurse corrected it. ${name} → ${bedLabel(bedIndex)}.`, 3.6);
  }

  function sampleSkillCheck() {
    if (overlay.flash && !overlay.flash.good && overlay.flash.seconds > 0.6) return; // brief lockout after a miss
    const zone = skillCheckSuccessZone(overlay.task, shakyHandsZoneScale(currentIntensity()));
    const hit = isSkillCheckSuccess(overlay.gauge, zone);
    const resolve = overlay.task === 'surgery' ? resolveSurgery : resolveBedTask;
    if (!hit) {
      shiftState = resolve(shiftState, false);
      flash('Missed!', false);
      overlay.gauge = 0;
      overlay.direction = 1;
      return;
    }
    overlay.hits += 1;
    if (overlay.hits < overlay.required) {
      flash(`${SURGERY_STAGES[overlay.hits - 1]} done!`, true);
      return;
    }
    const before = shiftState;
    const bedIndex = shiftState.activeTask.bedIndex;
    shiftState = resolve(shiftState, true);
    const task = overlay.task;
    overlay = null;
    announceStepDone(bedIndex, before, task === 'surgery' ? 'Surgery went well' : `${TREATMENT_LABELS[task]} done`);
  }

  /**
   * A click on the Oxygen scene: a heart is one good pump (three finish
   * the step), a skull is a missed skill check — a mistake — and fades out
   * so the same slip can't cost twice.
   */
  function handleOxygenClick(x, y) {
    const item = overlay.items
      .filter((it) => !it.found && Math.hypot(it.x - x, it.y - y) <= OXYGEN_HIT_RADIUS)
      .sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))[0] ?? null;
    const result = gradeOxygenClick(item);
    if (result === 'nothing') return;
    item.found = true;
    if (result === 'miss') {
      shiftState = resolveBedTask(shiftState, false);
      flash('A skull — missed pump!', false);
      return;
    }
    overlay.hits += 1;
    overlay.squeeze = 1;
    if (overlay.hits < overlay.required) {
      flash('Good pump!', true);
      return;
    }
    const before = shiftState;
    const bedIndex = shiftState.activeTask.bedIndex;
    shiftState = resolveBedTask(shiftState, true);
    overlay = null;
    announceStepDone(bedIndex, before, 'Breathing easier — Oxygen done');
  }

  function finishBandageTrace() {
    if (overlay?.kind !== 'bandage' || !overlay.tracing) return;
    overlay.tracing = false;
    const grade = gradeBandageTrace(overlay.samples, overlay.path);
    if (grade.success) {
      const before = shiftState;
      const bedIndex = shiftState.activeTask.bedIndex;
      shiftState = resolveBedTask(shiftState, true);
      overlay.closeIn = 0.8;
      overlay.flash = { text: 'Neatly dressed!', good: true, seconds: 0.8 };
      announceStepDone(bedIndex, before, 'Bandaged');
    } else {
      shiftState = resolveBedTask(shiftState, false);
      flash(grade.coverage < 0.85 ? 'Cover the whole wound — start to end!' : 'Too wobbly — stay on the line!', false);
      overlay.samples = [];
    }
  }

  function medsBottleRects() {
    const cols = 4;
    const w = 120;
    const h = 112;
    const gapX = 26;
    const startX = CANVAS_WIDTH / 2 - (cols * w + (cols - 1) * gapX) / 2;
    return overlay.bottles.map((b, i) => ({ ...b, index: i, x: startX + (i % cols) * (w + gapX), y: 176 + Math.floor(i / cols) * (h + 14), w, h }));
  }

  function medsDoseRects() {
    const w = 96;
    const gap = 18;
    const startX = CANVAS_WIDTH / 2 + 20;
    return DOSE_CHOICES.map((dose, i) => ({ dose, x: startX + i * (w + gap), y: 470, w, h: 46 }));
  }

  function pickDose(dose) {
    if (!overlay.picked) {
      flash('Pick a bottle first.', false);
      return;
    }
    const result = gradeMedsPick(overlay.order, overlay.picked, dose);
    if (result === 'correct') {
      const bedIndex = shiftState.activeTask.bedIndex;
      const drug = overlay.order.drug;
      shiftState = resolveMedsDispense(shiftState, true);
      overlay = null;
      showToast(`Got ${drug} × ${dose} — take them to ${bedLabel(bedIndex)}.`);
      return;
    }
    shiftState = resolveMedsDispense(shiftState, false);
    flash(result === 'wrong-drug' ? 'Wrong medication — read the label!' : 'Wrong dose — check the order!', false);
    overlay.picked = null;
  }

  function karenButtonRects() {
    const w = 170;
    const h = 42;
    return {
      explain: { x: CANVAS_WIDTH / 2 - w - 12, y: 470, w, h },
      letCut: { x: CANVAS_WIDTH / 2 + 12, y: 470, w, h },
    };
  }

  function answerKaren(outcome) {
    shiftState = resolveKarenEvent(shiftState, outcome);
    overlay = null;
    showToast(outcome === 'explain'
      ? `She calms down and waits her turn. (Later: a thank-you card, +${KAREN_CALMED_TIP_GARD}g)`
      : 'She barges ahead — the whole waiting room is furious.');
  }

  function onOverlayClick(x, y) {
    if (insideRect(CLOSE_RECT, x, y) && overlay.kind !== 'karen' && overlay.kind !== 'coffee-pour') {
      closeOverlay();
      return;
    }
    if (overlay.kind === 'triage') {
      const hit = triageButtonRects().find((r) => insideRect(r, x, y));
      if (hit) chooseTriage(hit.level);
    } else if (overlay.kind === 'skill') {
      sampleSkillCheck();
    } else if (overlay.kind === 'oxygen') {
      handleOxygenClick(x, y);
    } else if (overlay.kind === 'meds') {
      const bottle = medsBottleRects().find((r) => insideRect(r, x, y));
      if (bottle) { overlay.picked = bottle.name; return; }
      const dose = medsDoseRects().find((r) => insideRect(r, x, y));
      if (dose) pickDose(dose.dose);
    } else if (overlay.kind === 'karen') {
      const b = karenButtonRects();
      if (insideRect(b.explain, x, y)) answerKaren('explain');
      else if (insideRect(b.letCut, x, y)) answerKaren('letCut');
    }
  }

  // -- Coffee Pour (ported from Library Shift) ----------------------------------------

  const COFFEE_RESULT_SECONDS = 1.2;
  const COFFEE_RESULT_TEXT = {
    perfect: `Perfect pour! Fully refreshed, +${COFFEE_MOOD_RESTORE.perfect} Mood, +${COFFEE_PERFECT_TIP_GARD} Gard tip.`,
    good: `Nice cup — feeling better. +${COFFEE_MOOD_RESTORE.good} Mood.`,
    sloppy: `A bit sloppy, but coffee is coffee. +${COFFEE_MOOD_RESTORE.sloppy} Mood.`,
    spilled: 'Ow! Hot coffee all over your scrubs — −50 Sanity.',
  };
  const COFFEE_SPLASH_SECONDS = 6;
  let coffeeSplashSeconds = 0;

  function startCoffeePour() {
    if (overlay?.kind === 'coffee-pour' && !overlay.grade) overlay.pouring = true;
  }

  function stopCoffeePour() {
    if (overlay?.kind === 'coffee-pour' && overlay.pouring && !overlay.grade) finishCoffeePour();
  }

  function finishCoffeePour() {
    overlay.pouring = false;
    overlay.grade = gradeCoffeePour(overlay.fill, overlay.band);
    overlay.closeIn = COFFEE_RESULT_SECONDS;
    shiftState = brewCoffee(shiftState, overlay.grade);
    if (overlay.grade === 'spilled') coffeeSplashSeconds = COFFEE_SPLASH_SECONDS;
    showToast(COFFEE_RESULT_TEXT[overlay.grade]);
  }

  // -- Hallucinations (Library Shift's v2.16, ER-flavored) ------------------------------

  const WHISPERS = ['code blue…', 'beep… beep… beep…', 'bed five is empty', "you missed a dose", 'they never left', 'who paged me?', 'turn around', 'flatline…'];
  let halluc = { figures: [], whispers: [], ghosts: [], flicker: 0, scare: 0, ghostCounter: 0 };

  function currentIntensity() {
    return shiftState && shiftState.phase === 'playing' ? hallucinationIntensity(shiftState.sanity) : 0;
  }

  function resetHallucinations() {
    halluc = { figures: [], whispers: [], ghosts: [], flicker: 0, scare: 0, ghostCounter: halluc.ghostCounter };
  }

  function updateHallucinations(dt) {
    const i = currentIntensity();
    if (i <= 0) {
      if (halluc.figures.length || halluc.whispers.length || halluc.ghosts.length) resetHallucinations();
      return;
    }
    const age = (list) => list.map((it) => ({ ...it, age: it.age + dt })).filter((it) => it.age < it.life);
    halluc.figures = age(halluc.figures);
    halluc.whispers = age(halluc.whispers);
    halluc.ghosts = age(halluc.ghosts);
    halluc.flicker = Math.max(0, halluc.flicker - dt);
    halluc.scare = Math.max(0, halluc.scare - dt);
    if (i > 0.3 && random() < 0.35 * i * dt) halluc.figures.push({ x: 80 + random() * (CANVAS_WIDTH - 160), y: 180 + random() * 360, age: 0, life: 0.8 + random() * 1.2 });
    if (random() < 0.3 * i * dt) {
      halluc.whispers.push({ text: WHISPERS[Math.floor(random() * WHISPERS.length)], x: 120 + random() * (CANVAS_WIDTH - 240), y: 160 + random() * 360, age: 0, life: 2.6 });
    }
    if (random() < 0.12 * i * dt) halluc.flicker = 0.18;
    if (i >= 1 && random() < 0.04 * dt) halluc.scare = 0.45;
    if (i >= 0.5 && halluc.ghosts.length === 0 && random() < 0.06 * i * dt) halluc.ghosts.push({ id: `ghost-${halluc.ghostCounter++}`, age: 0, life: 15 });
    if (!overlay && shiftState.carried?.kind === 'meds' && random() < MEDS_DROP_CHANCE_PER_SECOND * i * dt) {
      shiftState = dropCarriedMeds(shiftState);
      showToast('Your hands shake — the pills scatter across the floor. Fetch them again.');
    }
  }

  function drawShadowFigure(fx, fy, alpha, scale = 1) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#0c1418';
    ctx.beginPath();
    ctx.arc(fx, fy - 62 * scale, 13 * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(fx - 18 * scale, fy);
    ctx.quadraticCurveTo(fx - 20 * scale, fy - 40 * scale, fx - 9 * scale, fy - 52 * scale);
    ctx.lineTo(fx + 9 * scale, fy - 52 * scale);
    ctx.quadraticCurveTo(fx + 20 * scale, fy - 40 * scale, fx + 18 * scale, fy);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#ff5050';
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(fx + dir * 4.5 * scale, fy - 63 * scale, 1.8 * scale, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawHallucinations() {
    const i = currentIntensity();
    if (i <= 0) return;
    const t = performance.now() / 1000;
    for (const f of halluc.figures) {
      const fade = Math.sin((f.age / f.life) * Math.PI);
      drawShadowFigure(f.x, f.y, 0.55 * fade * (0.7 + 0.3 * Math.sin(t * 30)));
    }
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = 'italic 15px Georgia, serif';
    for (const w of halluc.whispers) {
      const fade = Math.sin((w.age / w.life) * Math.PI);
      ctx.fillStyle = `rgba(40,90,90,${0.8 * fade})`;
      ctx.fillText(w.text, w.x + Math.sin(t * 2 + w.x) * 6, w.y - w.age * 8);
    }
    ctx.restore();
    const pulse = 0.85 + 0.15 * Math.sin(t * 2.2);
    const v = ctx.createRadialGradient(CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2, 90 + 170 * (1 - i), CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2, 560);
    v.addColorStop(0, 'rgba(0,25,30,0)');
    v.addColorStop(0.6, `rgba(0,25,30,${0.45 * i * pulse})`);
    v.addColorStop(1, `rgba(0,15,20,${0.9 * i * pulse})`);
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    if (halluc.flicker > 0) {
      ctx.fillStyle = 'rgba(0,10,15,0.55)';
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    }
    if (halluc.scare > 0) {
      ctx.fillStyle = `rgba(0,10,10,${0.6 * (halluc.scare / 0.45)})`;
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      drawShadowFigure(CANVAS_WIDTH / 2, CANVAS_HEIGHT + 120, halluc.scare / 0.45, 4.2);
    }
  }

  // -- Overlay updates ----------------------------------------------------------------

  function updateOverlay(dt) {
    if (!overlay) return;
    if (overlay.flash) {
      overlay.flash.seconds -= dt;
      if (overlay.flash.seconds <= 0) overlay.flash = null;
    }
    if (overlay.kind === 'oxygen') {
      overlay.squeeze = Math.max(0, overlay.squeeze - dt * 3);
      for (const it of overlay.items) if (it.found) it.fade = Math.min(1, it.fade + dt * 2.5);
    } else if (overlay.kind === 'skill') {
      const speed = skillCheckSweepSpeed(currentShiftNumber, overlay.task) * shakyHandsSweepMultiplier(currentIntensity());
      overlay.gauge += overlay.direction * speed * dt;
      if (overlay.gauge >= 1) { overlay.gauge = 1; overlay.direction = -1; } else if (overlay.gauge <= 0) { overlay.gauge = 0; overlay.direction = 1; }
    } else if (overlay.kind === 'bandage' && overlay.closeIn > 0) {
      overlay.closeIn -= dt;
      if (overlay.closeIn <= 0) overlay = null;
    } else if (overlay.kind === 'coffee-pour') {
      if (overlay.grade) {
        overlay.closeIn -= dt;
        if (overlay.closeIn <= 0) overlay = null;
      } else if (overlay.pouring) {
        overlay.fill = Math.min(1, overlay.fill + dt / COFFEE_POUR_SECONDS_TO_BRIM);
        if (overlay.fill >= 1) finishCoffeePour();
      }
    }
  }

  // -- Canvas input ----------------------------------------------------------------

  function onCanvasClick(e) {
    if (!running) return;
    const { x, y } = canvasCoordsFromEvent(e);
    if (overlay) {
      onOverlayClick(x, y);
      return;
    }
    if (shiftState?.phase === 'playing') {
      const slot = triageSlotAtPoint(x, y);
      if (slot) {
        pendingTriageAction = { kind: slot.kind, id: slot.id };
        commitStationTarget(stationOfKind('triage-desk'), null);
        return;
      }
    }
    pendingTriageAction = null;
    commitStationTarget(stationAtPoint(x, y, stations), { x, y });
  }

  function onCanvasPointerDown(e) {
    if (!running || !overlay) return;
    if (overlay.kind === 'coffee-pour') {
      e.preventDefault();
      startCoffeePour();
    } else if (overlay.kind === 'bandage' && overlay.closeIn <= 0) {
      const p = canvasCoordsFromEvent(e);
      if (insideRect(CLOSE_RECT, p.x, p.y)) return;
      e.preventDefault();
      overlay.tracing = true;
      overlay.samples = [p];
    }
  }

  function onCanvasPointerMove(e) {
    if (overlay?.kind === 'bandage' && overlay.tracing) {
      overlay.samples.push(canvasCoordsFromEvent(e));
      return;
    }
    if (overlay) { canvas.style.cursor = ''; return; }
    const { x, y } = canvasCoordsFromEvent(e);
    hoverStation = stationAtPoint(x, y, stations);
    canvas.style.cursor = hoverStation || triageSlotAtPoint(x, y) ? 'pointer' : '';
  }

  function onWindowPointerUp() {
    stopCoffeePour();
    finishBandageTrace();
  }

  function onCanvasMouseLeave() {
    hoverStation = null;
  }

  function onKeyDown(e) {
    if (!running) return;
    if (overlay) {
      if (e.key === 'Escape') { e.preventDefault(); closeOverlay(); return; }
      const digit = Number(e.key);
      if (overlay.kind === 'triage' && digit >= 1 && digit <= TRIAGE_LEVELS.length) {
        e.preventDefault();
        chooseTriage(TRIAGE_LEVELS[digit - 1].id);
        return;
      }
      if (overlay.kind === 'meds') {
        if (e.key === 'Backspace') { e.preventDefault(); overlay.picked = null; return; }
        if (!overlay.picked && digit >= 1 && digit <= overlay.bottles.length) { e.preventDefault(); overlay.picked = overlay.bottles[digit - 1].name; return; }
        if (overlay.picked && DOSE_CHOICES.includes(digit)) { e.preventDefault(); pickDose(digit); return; }
      }
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        if (e.repeat) return;
        if (overlay.kind === 'coffee-pour') startCoffeePour();
        else if (overlay.kind === 'skill') sampleSkillCheck();
      }
      return;
    }
    if (e.key === 'Enter' && hoverStation) {
      e.preventDefault();
      commitStationTarget(hoverStation, null);
    }
  }

  function onKeyUp(e) {
    if (e.key === ' ' || e.key === 'Enter') stopCoffeePour();
  }

  // -- Shift lifecycle ------------------------------------------------------------------

  function beginShift() {
    waitingAtOffice = false;
    coffeeSplashSeconds = 0;
    resetHallucinations();
    lastSeenBonusGard = 0;
    gardPops = [];
    currentShiftNumber = save.currentShift;
    karenShiftNumber = karenShiftForSeed(save.karenSeed);
    shiftState = startShiftState(createInitialState(currentShiftNumber, karenShiftNumber));
    player = { ...PLAYER_START };
    moveTarget = null;
    overlay = null;
    pendingTriageAction = null;
    karenAvailable = false;
    patientInfo.clear();
    scheduledEvents = scheduleShiftEvents();
    lastTimestamp = null;
    running = true;
    paused = false;
    showScreen(null);
    renderHud();
    if (rafHandle === null) rafHandle = window.requestAnimationFrame(loop);
  }

  function startShift() {
    requestFullscreen();
    beginShift();
  }

  function endShift() {
    running = false;
    if (rafHandle !== null) {
      window.cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
    const payout = shiftState.payout ?? 0;
    save.monthToDateGard += payout;
    const isFinalShift = currentShiftNumber >= SHIFTS_PER_MONTH;
    if (isFinalShift) save.bestRunTotal = Math.max(save.bestRunTotal, save.monthToDateGard);
    else save.currentShift = currentShiftNumber + 1;
    persistSave(storageAvailable, save);

    const screen = elements.paycheckScreen;
    screen.root.dataset.outcome = shiftState.mistakeCount > 0 ? 'upset' : 'ok';
    screen.root.dataset.final = isFinalShift ? 'true' : 'false';
    screen.title.textContent = isFinalShift ? 'Final Paycheck' : 'Handover';
    const s = shiftState;
    const parts = [
      s.mistakeCount > 0 ? `${s.mistakeCount} mistake${s.mistakeCount === 1 ? '' : 's'}` : 'No mistakes',
      `${s.discharged} discharged`,
      `${s.rating}★ (${Math.round(paycheckMultiplierForRating(s.rating) * 100)}% pay)`,
    ];
    if (s.transfers > 0) parts.push(`${s.transfers} transferred out`);
    const hallucinationCut = Math.round((1 - hallucinationPayMultiplier(s.zeroSanitySeconds)) * 100);
    if (hallucinationCut > 0) parts.push(`−${hallucinationCut}% for hallucinating`);
    screen.outcome.textContent = parts.join(' · ');
    screen.shiftTotal.textContent = `${payout} Gard`;
    screen.monthTotal.textContent = `${save.monthToDateGard} Gard`;
    screen.nextShiftButton.classList.toggle('hidden', isFinalShift);
    screen.newMonthButton.classList.toggle('hidden', !isFinalShift);
    screen.finalBlock.classList.toggle('hidden', !isFinalShift);
    if (isFinalShift) {
      if (screen.earningsInput) screen.earningsInput.value = String(save.monthToDateGard);
      if (screen.shiftsInput) screen.shiftsInput.value = String(SHIFTS_PER_MONTH);
      if (screen.submitButton) screen.submitButton.disabled = false;
    }
    renderHud();
    showScreen('paycheck');
  }

  function startNewMonth() {
    save.currentShift = 1;
    save.monthToDateGard = 0;
    save.karenSeed = Date.now();
    persistSave(storageAvailable, save);
    startShift();
  }

  // -- Rendering: floor and stations -------------------------------------------------------

  const TILE = 40;

  function drawFloor() {
    ctx.fillStyle = '#e4efe9';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    for (let row = 0; row * TILE < CANVAS_HEIGHT; row++) {
      for (let col = 0; col * TILE < CANVAS_WIDTH; col++) {
        if ((row + col) % 2 === 0) {
          ctx.fillStyle = '#dbe9e2';
          ctx.fillRect(col * TILE, row * TILE, TILE, TILE);
        }
        if ((row * 7 + col * 13) % 23 === 0) {
          ctx.fillStyle = 'rgba(90,140,120,0.08)';
          ctx.fillRect(col * TILE + 8, row * TILE + 12, 6, 6);
        }
      }
    }
    ctx.strokeStyle = 'rgba(80,120,105,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= CANVAS_WIDTH; x += TILE) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, CANVAS_HEIGHT); }
    for (let y = 0; y <= CANVAS_HEIGHT; y += TILE) { ctx.moveTo(0, y + 0.5); ctx.lineTo(CANVAS_WIDTH, y + 0.5); }
    ctx.stroke();

    // A guide stripe on the floor leading from triage to the beds.
    ctx.fillStyle = 'rgba(217,83,79,0.18)';
    ctx.fillRect(0, 262, 790, 6);
    ctx.fillStyle = 'rgba(95,168,106,0.2)';
    ctx.fillRect(0, 456, 790, 6);

    // Back wall with the ER sign.
    drawRoundRect(ctx, 0, 0, CANVAS_WIDTH, 58, 0, '#f4f1ea');
    ctx.fillStyle = 'rgba(58,42,42,0.12)';
    ctx.fillRect(0, 56, CANVAS_WIDTH, 3);
    drawRoundRect(ctx, 744, 14, 190, 30, 6, '#d9534f');
    ctx.fillStyle = CREAM;
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('✚ EMERGENCY', 839, 30);

    // Break-room rug under the coffee machine.
    const coffee = stationOfKind('coffee-machine');
    drawRoundRect(ctx, coffee.x - 70, coffee.y - 62, 190, 120, 16, 'rgba(194,138,90,0.18)');
    drawWallClock();
  }

  function drawWallClock() {
    if (!shiftState) return;
    const label = inGameTimeLabel(shiftState.clockSeconds, shiftState.totalClockSeconds);
    const match = /^(\d+):(\d+) (AM|PM)$/.exec(label);
    if (!match) return;
    const hour = Number(match[1]) % 12;
    const minute = Number(match[2]);
    const cx = 520;
    const cy = 29;
    ctx.fillStyle = CREAM;
    ctx.beginPath();
    ctx.arc(cx, cy, 20, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#6a7a74';
    ctx.lineWidth = 3;
    ctx.stroke();
    const hand = (angle, len, width) => {
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.sin(angle) * len, cy - Math.cos(angle) * len);
      ctx.stroke();
    };
    ctx.strokeStyle = '#3a2a2a';
    hand(((hour + minute / 60) / 12) * Math.PI * 2, 10, 2.5);
    hand((minute / 60) * Math.PI * 2, 15, 1.5);
  }

  function drawOfficeDetail(st) {
    const hw = st.w / 2;
    const hh = st.h / 2;
    drawRoundRect(ctx, -hw + 12, -hh + 8, st.w - 24, st.h - 8, [6, 6, 0, 0], 'rgba(60,90,110,0.18)');
    ctx.strokeStyle = 'rgba(60,90,110,0.3)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-hw + 18, -hh + 26, st.w - 36, 22);
    ctx.strokeRect(-hw + 18, 8, st.w - 36, 24);
    drawRoundRect(ctx, -26, -hh + 12, 52, 10, 2, '#e8cf8a');
    ctx.fillStyle = '#6a5a3a';
    ctx.font = 'bold 6.5px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('CHARGE NURSE', 0, -hh + 17.5);
    ctx.fillStyle = '#c9a24a';
    ctx.beginPath();
    ctx.arc(hw - 20, 4, 3.2, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawTriageDeskDetail(st) {
    const hw = st.w / 2;
    // Counter top and front.
    drawRoundRect(ctx, -hw + 4, -6, st.w - 8, 34, 6, '#c9d8e4');
    drawRoundRect(ctx, -hw + 4, -6, st.w - 8, 8, [6, 6, 0, 0], '#e6eef4');
    // Monitor.
    drawRoundRect(ctx, -34, -34, 34, 24, 3, '#3a4650');
    drawRoundRect(ctx, -31, -31, 28, 18, 2, '#8fd6c8');
    ctx.strokeStyle = '#2f7a6a';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-30, -22); ctx.lineTo(-22, -22); ctx.lineTo(-19, -29); ctx.lineTo(-15, -16); ctx.lineTo(-12, -22); ctx.lineTo(-4, -22);
    ctx.stroke();
    ctx.fillStyle = '#3a4650';
    ctx.fillRect(-20, -10, 6, 4);
    // Clipboard.
    drawRoundRect(ctx, 12, -30, 22, 28, 2, '#a8794a');
    drawRoundRect(ctx, 15, -26, 16, 21, 1, CREAM);
    drawRoundRect(ctx, 18, -32, 10, 5, 1, '#8a8a90');
    ctx.fillStyle = 'rgba(58,42,42,0.4)';
    for (let i = 0; i < 4; i++) ctx.fillRect(17, -22 + i * 4, 12, 1.2);
    // Red cross sign.
    drawRoundRect(ctx, -hw + 10, -st.h / 2 + 6, 20, 20, 4, CREAM);
    ctx.fillStyle = '#d9534f';
    ctx.fillRect(-hw + 17, -st.h / 2 + 9, 6, 14);
    ctx.fillRect(-hw + 13, -st.h / 2 + 13, 14, 6);
  }

  function drawMedCabinetDetail(st) {
    const hw = st.w / 2;
    const hh = st.h / 2;
    drawRoundRect(ctx, -hw + 8, -hh + 8, st.w - 16, st.h - 16, 4, '#f2f4f6');
    ctx.strokeStyle = 'rgba(58,70,80,0.35)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-hw + 8, -hh + 8, st.w - 16, st.h - 16);
    ctx.beginPath();
    ctx.moveTo(0, -hh + 8);
    ctx.lineTo(0, hh - 8);
    ctx.stroke();
    const colors = MEDICATIONS.map((m) => m.color);
    for (let shelf = 0; shelf < 3; shelf++) {
      const sy = -hh + 30 + shelf * 20;
      ctx.fillStyle = 'rgba(58,70,80,0.25)';
      ctx.fillRect(-hw + 10, sy, st.w - 20, 2);
      for (let b = 0; b < 6; b++) {
        const bx = -hw + 14 + b * 10 + (b >= 3 ? 4 : 0);
        drawRoundRect(ctx, bx, sy - 11, 7, 11, 1.5, colors[(shelf * 6 + b) % colors.length]);
        ctx.fillStyle = CREAM;
        ctx.fillRect(bx + 1, sy - 7, 5, 3);
      }
    }
    drawRoundRect(ctx, -9, -hh + 2, 18, 12, 3, '#d9534f');
    ctx.fillStyle = CREAM;
    ctx.fillRect(-1.5, -hh + 4, 3, 8);
    ctx.fillRect(-5, -hh + 6.5, 10, 3);
  }

  function drawOperatingRoomDetail(st) {
    const hw = st.w / 2;
    const hh = st.h / 2;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(-hw, -hh, st.w, st.h, 10);
    ctx.clip();
    ctx.fillStyle = '#bfe0d2';
    ctx.fillRect(-hw, -hh, st.w, st.h);
    ctx.strokeStyle = 'rgba(60,120,100,0.18)';
    ctx.lineWidth = 1;
    for (let gx = -hw; gx < hw; gx += 14) { ctx.beginPath(); ctx.moveTo(gx, -hh); ctx.lineTo(gx, hh); ctx.stroke(); }
    for (let gy = -hh; gy < hh; gy += 14) { ctx.beginPath(); ctx.moveTo(-hw, gy); ctx.lineTo(hw, gy); ctx.stroke(); }
    // Overhead lamp glow.
    const glow = ctx.createRadialGradient(0, -6, 4, 0, -6, 60);
    glow.addColorStop(0, 'rgba(255,255,230,0.85)');
    glow.addColorStop(1, 'rgba(255,255,230,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(-hw, -hh, st.w, st.h);
    ctx.restore();
    // Table with a sheet.
    drawRoundRect(ctx, -22, -46, 44, 86, 8, '#8a98a4');
    drawRoundRect(ctx, -19, -43, 38, 80, 6, '#e8f2f0');
    drawRoundRect(ctx, -12, -40, 24, 12, 5, CREAM);
    // Lamp rim.
    ctx.strokeStyle = '#6a7a84';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, -6, 18, 0, Math.PI * 2);
    ctx.stroke();
    // Instrument tray + monitor.
    drawRoundRect(ctx, hw - 30, 20, 22, 30, 3, '#c8ccd4');
    ctx.fillStyle = '#7a8088';
    for (let i = 0; i < 3; i++) ctx.fillRect(hw - 26 + i * 6, 25, 2, 20);
    drawRoundRect(ctx, -hw + 8, -hh + 10, 26, 20, 3, '#3a4650');
    ctx.strokeStyle = '#7fd68a';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-hw + 10, -hh + 21); ctx.lineTo(-hw + 17, -hh + 21); ctx.lineTo(-hw + 20, -hh + 14); ctx.lineTo(-hw + 23, -hh + 26); ctx.lineTo(-hw + 26, -hh + 21); ctx.lineTo(-hw + 32, -hh + 21);
    ctx.stroke();
    // A patient on the table while the operation's under way.
    if (shiftState?.activeTask?.kind === 'surgery') {
      drawHospitalPerson(ctx, 0, 6, { personalityKey: patientInfo.get(shiftState.activeTask.patientId)?.personalityKey, scale: 0.6 });
      drawRoundRect(ctx, -18, -14, 36, 50, 5, '#7fb8a4');
    }
  }

  // Ported verbatim from library-game.js so the two machines match.
  function drawCoffeeMachineDetail(st) {
    const half = st.w / 2;
    // Bean hopper on top: a clear trapezoid full of beans.
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.beginPath();
    ctx.moveTo(-12, -half + 4);
    ctx.lineTo(12, -half + 4);
    ctx.lineTo(7, -half + 16);
    ctx.lineTo(-7, -half + 16);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#6a4a30';
    for (const [bx, by] of [[-6, -half + 9], [0, -half + 8], [6, -half + 9], [-3, -half + 12], [3, -half + 12], [0, -half + 14.5]]) {
      ctx.beginPath();
      ctx.ellipse(bx, by, 2.1, 1.4, 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
    // Machine body (a slightly lighter top band for a metallic read).
    drawRoundRect(ctx, -half + 9, -half + 16, half * 2 - 18, half * 2 - 24, 7, '#7a5a42');
    drawRoundRect(ctx, -half + 9, -half + 16, half * 2 - 18, 10, [7, 7, 0, 0], '#8f6c50');
    // Display + buttons.
    drawRoundRect(ctx, -10, -half + 19, 20, 5, 1.5, '#9fe0a8');
    for (const [bx, color] of [[-half + 17, '#e8b95a'], [half - 17, '#e06a5b']]) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(bx, -half + 21.5, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    // Recessed brewing bay.
    drawRoundRect(ctx, -half + 15, -half + 30, half * 2 - 30, half + 4, 5, '#4a3424');
    // Group head + spouts.
    drawRoundRect(ctx, -9, -half + 30, 18, 6, 2, '#b0a090');
    ctx.fillStyle = '#b0a090';
    ctx.fillRect(-5, -half + 35, 3, 5);
    ctx.fillRect(2, -half + 35, 3, 5);
    // A coffee drip.
    ctx.fillStyle = '#c47f4e';
    ctx.fillRect(-0.75, -half + 40, 1.5, 4);
    // Cup with coffee + handle.
    drawRoundRect(ctx, -8, half - 25, 16, 12, [1, 1, 4, 4], '#fdf8ee');
    drawRoundRect(ctx, -6.5, half - 24, 13, 2.5, 1, '#6a4a30');
    ctx.strokeStyle = '#fdf8ee';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(9, half - 19.5, 3.2, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
    // Drip tray grate.
    drawRoundRect(ctx, -half + 13, half - 13, half * 2 - 26, 5, 2, '#b0a090');
    ctx.fillStyle = 'rgba(58,42,42,0.4)';
    for (let gx = -half + 17; gx < half - 15; gx += 5) ctx.fillRect(gx, half - 12, 1.5, 3);
    // Steam wisps curling out of the bay.
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1.5;
    for (const dx of [-14, 14]) {
      ctx.beginPath();
      ctx.moveTo(dx, half - 26);
      ctx.quadraticCurveTo(dx - 4, half - 32, dx, half - 38);
      ctx.quadraticCurveTo(dx + 4, half - 43, dx, half - 48);
      ctx.stroke();
    }
  }

  const STATION_COLORS = {
    office: '#d6e2ea',
    'triage-desk': '#f2e2c8',
    'med-cabinet': '#d9e4ec',
    'operating-room': '#bfe0d2',
    'coffee-machine': '#e3cdb4',
  };
  const STATION_DETAILS = {
    office: drawOfficeDetail,
    'triage-desk': drawTriageDeskDetail,
    'med-cabinet': drawMedCabinetDetail,
    'operating-room': drawOperatingRoomDetail,
    'coffee-machine': drawCoffeeMachineDetail,
  };

  function stationOutline(st, highlightColor) {
    const isHovered = hoverStation?.id === st.id;
    const isTarget = moveTarget?.station?.id === st.id;
    ctx.strokeStyle = highlightColor ?? (isTarget ? '#e0a83a' : (isHovered ? '#7fb0d6' : 'rgba(58,42,42,0.3)'));
    ctx.lineWidth = highlightColor || isTarget || isHovered ? 3 : 2;
    ctx.beginPath();
    ctx.roundRect(-st.w / 2 + 1, -st.h / 2 + 1, st.w - 2, st.h - 2, 8);
    ctx.stroke();
  }

  function drawStation(st) {
    if (st.kind === 'bed') { drawBed(st); return; }
    const locked = st.kind === 'office' && shiftState && !isOfficeReady(shiftState) && shiftState.phase !== 'paycheck';
    ctx.save();
    ctx.translate(Math.round(st.x), Math.round(st.y));
    drawRoundRect(ctx, -st.w / 2, -st.h / 2, st.w, st.h, 10, locked ? '#c4c8cc' : STATION_COLORS[st.kind]);
    STATION_DETAILS[st.kind]?.(st);
    if (locked) {
      drawRoundRect(ctx, -14, -12, 28, 28, 14, 'rgba(255,251,246,0.92)');
      ctx.strokeStyle = '#5a5060';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, -2, 5.5, Math.PI, 0);
      ctx.stroke();
      drawRoundRect(ctx, -7.5, 1, 15, 11, 3, '#5a5060');
    }
    const pulse = (st.kind === 'operating-room' && shiftState?.carried?.kind === 'gurney')
      || (st.kind === 'med-cabinet' && shiftState && !shiftState.carried && shiftState.beds.some((b) => currentStep(b) === 'meds'));
    stationOutline(st, pulse ? `rgba(224,168,58,${0.55 + 0.45 * Math.sin(performance.now() / 180)})` : null);
    drawLabelChip(ctx, 0, st.h / 2 + 13, labelForStation(st), 'bold 11px sans-serif');
    ctx.restore();
  }

  function drawBed(st) {
    const patient = shiftState?.beds[st.bedIndex] ?? null;
    const hw = st.w / 2;
    const hh = st.h / 2;
    ctx.save();
    ctx.translate(st.x, st.y);
    // Privacy curtain on its rail, bunched to the left.
    ctx.strokeStyle = 'rgba(90,110,120,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-hw - 6, -hh - 4);
    ctx.lineTo(hw + 6, -hh - 4);
    ctx.stroke();
    ctx.fillStyle = '#a9cfe0';
    ctx.beginPath();
    ctx.moveTo(-hw - 6, -hh - 4);
    for (let i = 0; i <= 4; i++) ctx.lineTo(-hw - 6 + (i % 2 ? 6 : 0), -hh - 4 + i * 30);
    ctx.lineTo(-hw - 12, hh);
    ctx.lineTo(-hw - 12, -hh - 4);
    ctx.closePath();
    ctx.fill();
    // Frame, mattress, pillow.
    drawRoundRect(ctx, -hw, -hh, st.w, st.h, 10, '#9aa6b0');
    drawRoundRect(ctx, -hw + 5, -hh + 5, st.w - 10, st.h - 10, 7, '#f6f8fa');
    drawRoundRect(ctx, -hw + 16, -hh + 9, st.w - 32, 18, 8, '#ffffff');
    ctx.strokeStyle = 'rgba(58,70,80,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(-hw + 16, -hh + 9, st.w - 32, 18, 8);
    ctx.stroke();

    if (patient && !patient.inSurgery) {
      const info = patientInfo.get(patient.id);
      const level = findTriageLevel(patient.level);
      drawHospitalPerson(ctx, 0, 0, { personalityKey: info?.personalityKey, scale: 0.75 });
      // Blanket in a tint of their triage color, folded back at the chest.
      drawRoundRect(ctx, -hw + 9, -24, st.w - 18, hh + 16, 6, shadeColor(level.color, 0.55));
      drawRoundRect(ctx, -hw + 9, -24, st.w - 18, 8, [6, 6, 0, 0], shadeColor(level.color, 0.75));
      ctx.fillStyle = PERSON_TEMPLATES[info?.personalityKey]?.headColor ?? '#e0ac69';
      for (const dx of [-14, 14]) {
        ctx.beginPath();
        ctx.arc(dx, -12, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      // Triage badge and patience bar.
      ctx.fillStyle = level.color;
      ctx.beginPath();
      ctx.arc(hw - 10, -hh + 10, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = CREAM;
      ctx.lineWidth = 2;
      ctx.stroke();
      const f = Math.max(0, Math.min(1, patient.patienceRemainingSeconds / patient.patienceMaxSeconds));
      drawRoundRect(ctx, -34, hh - 16, 68, 7, 3.5, 'rgba(58,42,42,0.25)');
      drawRoundRect(ctx, -34, hh - 16, 68 * f, 7, 3.5, f > 0.5 ? '#7fd68a' : (f > 0.25 ? '#e0a83a' : '#e06a5b'));
    }

    const mine = shiftState?.carried?.kind === 'meds' && shiftState.carried.bedIndex === st.bedIndex;
    stationOutline(st, mine ? `rgba(224,168,58,${0.55 + 0.45 * Math.sin(performance.now() / 180)})` : null);
    drawLabelChip(ctx, 0, hh + 13, bedLabel(st.bedIndex), 'bold 11px sans-serif');

    if (patient) {
      const step = currentStep(patient);
      if (patient.inSurgery) {
        drawLabelChip(ctx, 0, -hh - 16, 'In the OR', 'bold 10px sans-serif', '#3a6a5a', CREAM);
      } else {
        const text = step === 'meds' ? `Meds: ${findCondition(patient.conditionId).med.drug} ×${findCondition(patient.conditionId).med.dose}` : TREATMENT_LABELS[step];
        drawLabelChip(ctx, 0, -hh - 16, `${patient.step + 1}/${patient.plan.length} ${text}`, 'bold 10px sans-serif', '#2f5f6f', CREAM);
      }
    }
    ctx.restore();
  }

  function drawTriageQueue() {
    for (const slot of triageSlots()) {
      if (slot.kind === 'ghost') {
        ctx.save();
        ctx.globalAlpha = 0.35 + 0.2 * Math.sin(performance.now() / 90);
        drawHospitalPerson(ctx, slot.x + Math.sin(performance.now() / 140) * 2, slot.y, { personalityKey: 'grandma', scale: 0.62 });
        ctx.restore();
        drawLabelChip(ctx, slot.x, slot.y + 20, '???', 'bold 9px sans-serif');
        continue;
      }
      if (slot.kind === 'karen') {
        drawHospitalPerson(ctx, slot.x, slot.y, { personalityKey: 'karen', scale: 0.62, angryTint: true });
        drawLabelChip(ctx, slot.x, slot.y + 20, 'Karen!', 'bold 10px sans-serif');
        continue;
      }
      const info = patientInfo.get(slot.id);
      drawHospitalPerson(ctx, slot.x, slot.y, { personalityKey: info?.personalityKey, scale: 0.62 });
      drawLabelChip(ctx, slot.x, slot.y + 20, info?.name ?? '', 'bold 9px sans-serif');
      if (slot.waitFraction != null) {
        const f = Math.max(0, Math.min(1, slot.waitFraction));
        drawRoundRect(ctx, slot.x - 18, slot.y + 30, 36, 5, 2.5, 'rgba(58,42,42,0.25)');
        drawRoundRect(ctx, slot.x - 18, slot.y + 30, 36 * f, 5, 2.5, f > 0.5 ? '#7fd68a' : (f > 0.25 ? '#e0a83a' : '#e06a5b'));
      }
    }
    const total = shiftState?.triageQueue.length ?? 0;
    if (total > QUEUE_VISIBLE_MAX) {
      const desk = stationOfKind('triage-desk');
      drawLabelChip(ctx, desk.x + 150, desk.y + desk.h / 2 + QUEUE_SLOT_OFFSET_Y - 20, `+${total - QUEUE_VISIBLE_MAX} waiting`, 'bold 10px sans-serif');
    }
  }

  function drawPillBottle(x, y, color, s = 1) {
    drawRoundRect(ctx, x - 6 * s, y - 7 * s, 12 * s, 16 * s, 2.5 * s, color);
    drawRoundRect(ctx, x - 7 * s, y - 11 * s, 14 * s, 5 * s, 1.5 * s, '#f2f0ea');
    drawRoundRect(ctx, x - 5 * s, y - 2 * s, 10 * s, 6 * s, 1 * s, CREAM);
  }

  function drawGurney(x, y, patientId) {
    drawRoundRect(ctx, x - 16, y - 34, 32, 64, 6, '#9aa6b0');
    drawRoundRect(ctx, x - 13, y - 31, 26, 58, 5, '#f6f8fa');
    for (const [wx, wy] of [[-12, 32], [12, 32], [-12, -36], [12, -36]]) {
      ctx.fillStyle = '#4a4a52';
      ctx.beginPath();
      ctx.arc(x + wx, y + wy, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    const info = patientInfo.get(patientId);
    ctx.fillStyle = PERSON_TEMPLATES[info?.personalityKey]?.headColor ?? '#e0ac69';
    ctx.beginPath();
    ctx.arc(x, y - 20, 8, 0, Math.PI * 2);
    ctx.fill();
    drawRoundRect(ctx, x - 12, y - 12, 24, 38, 4, '#a9cfe0');
  }

  let lastFrameDrewPlayer = false;

  function drawPlayer() {
    lastFrameDrewPlayer = true;
    const sanity = shiftState ? shiftState.sanity : SANITY_MAX;
    const stress = sanity < HALLUCINATION_START_SANITY ? (HALLUCINATION_START_SANITY - sanity) / HALLUCINATION_START_SANITY : 0;
    const carried = shiftState?.carried;
    if (carried?.kind === 'gurney') drawGurney(player.x + 40, player.y - 6, carried.patientId);
    drawHospitalPerson(ctx, player.x, player.y, { personalityKey: 'nurse', stress });
    if (coffeeSplashSeconds > 0) drawCoffeeSplash();
    drawLabelChip(ctx, player.x, player.y + 24, PLAYER_NAME, 'bold 10px sans-serif');
    if (carried?.kind === 'meds') {
      const order = findCondition(shiftState.beds[carried.bedIndex]?.conditionId)?.med;
      const color = MEDICATIONS.find((m) => m.name === order?.drug)?.color ?? '#e8b440';
      drawPillBottle(player.x + 20, player.y - 80, color, 1.1);
    }
  }

  function drawCoffeeSplash() {
    const s = PERSON_SCALE;
    ctx.save();
    ctx.globalAlpha = Math.min(1, coffeeSplashSeconds / 1.5);
    ctx.fillStyle = 'rgba(106,74,48,0.85)';
    for (const [dx, dy, r] of [[-5, -19, 4.2], [3, -14, 3.4], [6, -21, 2.6], [-2, -10, 2.4], [-8, -13, 2], [9, -9, 1.8]]) {
      ctx.beginPath();
      ctx.arc(player.x + dx * s, player.y + dy * s, r * s, 0, Math.PI * 2);
      ctx.fill();
    }
    // Steam curling off the stain.
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1.5;
    const t = performance.now() / 300;
    for (const dx of [-6, 4]) {
      ctx.beginPath();
      ctx.moveTo(player.x + dx * s, player.y - 24 * s);
      ctx.quadraticCurveTo(player.x + (dx - 3 + Math.sin(t)) * s, player.y - 30 * s, player.x + dx * s, player.y - 36 * s);
      ctx.stroke();
    }
    ctx.restore();
  }

  // -- Rendering: canvas HUD -------------------------------------------------------------

  function drawStatBar(y, label, value, max, colorHigh, font) {
    const x = 14;
    const width = 130;
    const height = 16;
    const percent = Math.round(value);
    const frac = Math.max(0, Math.min(1, value / max));
    const fill = percent > 50 ? colorHigh : (percent > 20 ? '#e0a83a' : '#e06a5b');
    drawRoundRect(ctx, x, y, width, height, 8, 'rgba(255,251,246,0.9)');
    drawRoundRect(ctx, x + 2, y + 2, Math.max(0, (width - 4) * frac), height - 4, 6, fill);
    ctx.strokeStyle = 'rgba(58,42,42,0.3)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, 8);
    ctx.stroke();
    ctx.fillStyle = LABEL_TEXT_COLOR;
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${label} ${percent}%`, x + width / 2, y + height / 2 + 0.5);
  }

  function drawRatingStars() {
    const rating = shiftState ? shiftState.rating : RATING_MAX;
    const x0 = 152;
    const cy = 25;
    drawRoundRect(ctx, x0 - 4, cy - 11, 5 * 20 + 8, 22, 11, 'rgba(255,251,246,0.9)');
    for (let i = 0; i < RATING_MAX; i++) {
      const cx = x0 + 10 + i * 20;
      drawStar(ctx, cx, cy, 8, 3.6, 'rgba(58,42,42,0.18)');
      const fill = Math.max(0, Math.min(1, rating - i));
      if (fill > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(cx - 9, cy - 9, 18 * fill, 18);
        ctx.clip();
        drawStar(ctx, cx, cy, 8, 3.6, '#e8b95a');
        ctx.restore();
      }
    }
  }

  let lastSeenBonusGard = 0;
  let gardPops = [];

  function trackGardPops(dt) {
    const net = shiftState ? shiftState.bonusGard : 0;
    if (net !== lastSeenBonusGard) gardPops.push({ amount: net - lastSeenBonusGard, age: 0 });
    lastSeenBonusGard = net;
    gardPops = gardPops.map((pop) => ({ ...pop, age: pop.age + dt })).filter((pop) => pop.age < 1.4);
  }

  function drawGardCounter() {
    const bonus = shiftState ? shiftState.bonusGard : 0;
    const x = 264;
    const y = 14;
    const w = 176;
    const h = 22;
    drawRoundRect(ctx, x, y, w, h, 11, 'rgba(255,251,246,0.9)');
    ctx.fillStyle = '#c28a2c';
    ctx.beginPath();
    ctx.arc(x + 13, y + 11, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f2cf6a';
    ctx.beginPath();
    ctx.arc(x + 13, y + 11, 6.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#a8741e';
    ctx.font = 'bold 8px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('G', x + 13, y + 11.5);
    ctx.fillStyle = LABEL_TEXT_COLOR;
    ctx.textAlign = 'left';
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText(`+${bonus}g shift`, x + 26, y + 11.5);
    ctx.font = '10px sans-serif';
    ctx.fillStyle = 'rgba(58,42,42,0.7)';
    ctx.textAlign = 'right';
    ctx.fillText(`Month ${save.monthToDateGard}g`, x + w - 9, y + 11.5);
    for (const pop of gardPops) {
      const t = pop.age / 1.4;
      ctx.globalAlpha = 1 - t;
      ctx.font = 'bold 15px sans-serif';
      ctx.textAlign = 'left';
      const popY = y + h + 20 - t * 10;
      const text = `${pop.amount >= 0 ? '+' : '−'}${Math.abs(pop.amount)}g`;
      ctx.strokeStyle = CREAM;
      ctx.lineWidth = 3.5;
      ctx.lineJoin = 'round';
      ctx.strokeText(text, x + 26, popY);
      ctx.fillStyle = pop.amount >= 0 ? '#b07a1e' : '#c0392b';
      ctx.fillText(text, x + 26, popY);
      ctx.globalAlpha = 1;
    }
  }

  // -- Rendering: overlays ------------------------------------------------------------

  function drawPanel(title, subtitle) {
    ctx.fillStyle = 'rgba(20,30,30,0.55)';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    drawRoundRect(ctx, PANEL.x, PANEL.y, PANEL.w, PANEL.h, 18, '#f4f1ea');
    ctx.strokeStyle = 'rgba(58,42,42,0.2)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(PANEL.x, PANEL.y, PANEL.w, PANEL.h, 18);
    ctx.stroke();
    ctx.fillStyle = LABEL_TEXT_COLOR;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = 'bold 21px sans-serif';
    ctx.fillText(title, CANVAS_WIDTH / 2, PANEL.y + 38);
    if (subtitle) {
      ctx.font = '13px sans-serif';
      ctx.fillStyle = 'rgba(58,42,42,0.75)';
      ctx.fillText(subtitle, CANVAS_WIDTH / 2, PANEL.y + 60);
    }
    if (overlay.kind !== 'karen') {
      drawRoundRect(ctx, CLOSE_RECT.x, CLOSE_RECT.y, CLOSE_RECT.w, CLOSE_RECT.h, 14, 'rgba(58,42,42,0.12)');
      ctx.strokeStyle = LABEL_TEXT_COLOR;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(CLOSE_RECT.x + 9, CLOSE_RECT.y + 9);
      ctx.lineTo(CLOSE_RECT.x + 19, CLOSE_RECT.y + 19);
      ctx.moveTo(CLOSE_RECT.x + 19, CLOSE_RECT.y + 9);
      ctx.lineTo(CLOSE_RECT.x + 9, CLOSE_RECT.y + 19);
      ctx.stroke();
    }
  }

  function drawFlash(y) {
    if (!overlay.flash) return;
    ctx.save();
    ctx.globalAlpha = Math.min(1, overlay.flash.seconds / 0.3);
    drawLabelChip(ctx, CANVAS_WIDTH / 2, y, overlay.flash.text, 'bold 15px sans-serif', overlay.flash.good ? '#5fa86a' : '#d9534f', CREAM);
    ctx.restore();
  }

  function wrapText(text, cx, y, maxWidth, lineHeight) {
    let line = '';
    let lineY = y;
    for (const word of text.split(' ')) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        ctx.fillText(line, cx, lineY);
        line = word;
        lineY += lineHeight;
      } else {
        line = test;
      }
    }
    if (line) ctx.fillText(line, cx, lineY);
  }

  function drawTriageOverlay() {
    const queued = shiftState.triageQueue.find((p) => p.id === overlay.patientId);
    if (!queued) return;
    const info = patientInfo.get(queued.id);
    const condition = findCondition(queued.conditionId);
    const v = info.vitals;
    drawPanel('Triage', 'Read the vitals and pick a priority (or press 1 / 2 / 3).');

    drawRoundRect(ctx, PANEL.x + 30, 140, 190, 300, 14, '#e2ece8');
    drawHospitalPerson(ctx, PANEL.x + 125, 380, { personalityKey: info.personalityKey, scale: 1.7 });

    const left = PANEL.x + 250;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = LABEL_TEXT_COLOR;
    ctx.font = 'bold 18px sans-serif';
    ctx.fillText(info.name, left, 162);
    ctx.font = 'italic 14px Georgia, serif';
    ctx.fillStyle = 'rgba(58,42,42,0.85)';
    ctx.fillText(`“${condition.complaint}”`, left, 188);

    const rows = [
      ['Heart rate', `${v.hr} bpm`],
      ['Blood pressure', `${v.systolic}/${v.diastolic}`],
      ['SpO₂', `${v.spo2}%`],
      ['Temperature', `${v.temp.toFixed(1)}°C`],
    ];
    rows.forEach(([name, value], i) => {
      const y = 214 + i * 34;
      drawRoundRect(ctx, left, y, 330, 28, 8, i % 2 ? '#ebe6dc' : '#f9f6f0');
      ctx.fillStyle = 'rgba(58,42,42,0.75)';
      ctx.font = '14px sans-serif';
      ctx.fillText(name, left + 12, y + 19);
      ctx.fillStyle = LABEL_TEXT_COLOR;
      ctx.font = 'bold 15px ui-monospace, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(value, left + 318, y + 19);
      ctx.textAlign = 'left';
    });
    ctx.font = '12px sans-serif';
    TRIAGE_LEGEND.forEach((line, i) => {
      ctx.fillStyle = TRIAGE_LEVELS[i].color;
      ctx.beginPath();
      ctx.arc(left + 6, 362 + i * 20, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(58,42,42,0.8)';
      ctx.fillText(line, left + 18, 366 + i * 20);
    });

    triageButtonRects().forEach((r, i) => {
      const level = findTriageLevel(r.level);
      drawRoundRect(ctx, r.x, r.y, r.w, r.h, 10, level.color);
      ctx.fillStyle = CREAM;
      ctx.textAlign = 'center';
      ctx.font = 'bold 16px sans-serif';
      ctx.fillText(`${i + 1}  ${level.name}`, r.x + r.w / 2, r.y + 22);
      ctx.font = '12px sans-serif';
      ctx.fillText(level.label, r.x + r.w / 2, r.y + 40);
    });
  }

  const SKILL_TITLES = {
    vitals: ['Vitals Check', 'Stop the marker in the gold zone to log the reading.'],
    iv: ['Start an IV', 'The needle sways — tap when it lines up with the vein.'],
    surgery: ['Surgery', 'Three steady hands: Incision, Repair, Sutures.'],
  };

  function skillBar() {
    return { x: 170, y: 440, w: CANVAS_WIDTH - 340, h: 26 };
  }

  function drawSkillOverlay() {
    const [title, subtitle] = SKILL_TITLES[overlay.task];
    drawPanel(title, subtitle);
    const bar = skillBar();
    const zone = skillCheckSuccessZone(overlay.task, shakyHandsZoneScale(currentIntensity()));
    const patientId = shiftState.activeTask?.patientId;
    const info = patientInfo.get(patientId);
    const t = performance.now() / 1000;

    if (overlay.task === 'vitals') {
      drawRoundRect(ctx, 250, 146, 460, 220, 12, '#1e2a30');
      ctx.strokeStyle = '#7fd68a';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      for (let px = 0; px <= 300; px += 3) {
        const phase = ((px + t * 160) % 110);
        let dy = 0;
        if (phase > 40 && phase < 46) dy = -48 * Math.sin(((phase - 40) / 6) * Math.PI);
        else if (phase > 46 && phase < 52) dy = 18 * Math.sin(((phase - 46) / 6) * Math.PI);
        else if (phase > 70 && phase < 86) dy = -8 * Math.sin(((phase - 70) / 16) * Math.PI);
        const x = 270 + px;
        if (px === 0) ctx.moveTo(x, 266 + dy); else ctx.lineTo(x, 266 + dy);
      }
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.textBaseline = 'alphabetic';
      const v = info?.vitals;
      const readouts = [['HR', v ? `${v.hr}` : '--', '#7fd68a'], ['BP', v ? `${v.systolic}/${v.diastolic}` : '--', '#e8b95a'], ['SpO₂', v ? `${v.spo2}%` : '--', '#7fc7e0']];
      readouts.forEach(([label, value, color], i) => {
        ctx.fillStyle = color;
        ctx.font = '11px sans-serif';
        ctx.fillText(label, 690, 180 + i * 60);
        ctx.font = 'bold 26px ui-monospace, monospace';
        ctx.fillText(value, 690, 208 + i * 60);
      });
    } else if (overlay.task === 'iv') {
      const skin = PERSON_TEMPLATES[info?.personalityKey]?.headColor ?? '#e0ac69';
      drawRoundRect(ctx, bar.x - 20, 250, bar.w + 40, 110, 50, skin);
      ctx.fillStyle = 'rgba(58,42,42,0.08)';
      ctx.fillRect(bar.x - 20, 335, bar.w + 40, 10);
      // The vein lines up with the gold zone.
      const veinX = bar.x + 0.5 * bar.w;
      const veinW = Math.max(6, zone.width * bar.w * 0.6);
      ctx.strokeStyle = 'rgba(70,90,170,0.75)';
      ctx.lineWidth = veinW;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(veinX - 10, 256);
      ctx.quadraticCurveTo(veinX + 12, 305, veinX - 6, 354);
      ctx.stroke();
      ctx.lineCap = 'butt';
      // Needle following the marker.
      const nx = bar.x + overlay.gauge * bar.w;
      drawRoundRect(ctx, nx - 7, 150, 14, 60, 4, '#e8eef2');
      drawRoundRect(ctx, nx - 9, 140, 18, 12, 3, '#7fb0d6');
      ctx.strokeStyle = '#8a9098';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(nx, 210);
      ctx.lineTo(nx, 262);
      ctx.stroke();
    } else if (overlay.task === 'surgery') {
      drawRoundRect(ctx, 230, 140, 500, 230, 14, '#5f9e86');
      const skin = PERSON_TEMPLATES[info?.personalityKey]?.headColor ?? '#e0ac69';
      drawRoundRect(ctx, 380, 190, 200, 130, 16, skin);
      ctx.strokeStyle = 'rgba(58,42,42,0.25)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(410, 255);
      ctx.lineTo(550, 255);
      ctx.stroke();
      ctx.setLineDash([]);
      const done = overlay.hits;
      if (done >= 1) {
        ctx.strokeStyle = '#b03a32';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(410, 255);
        ctx.lineTo(550, 255);
        ctx.stroke();
      }
      if (done >= 2) {
        ctx.strokeStyle = '#3a3a44';
        ctx.lineWidth = 2;
        for (let sx = 420; sx <= 540; sx += 16) {
          ctx.beginPath();
          ctx.moveTo(sx - 4, 247);
          ctx.lineTo(sx + 4, 263);
          ctx.stroke();
        }
      }
      ctx.fillStyle = CREAM;
      ctx.font = 'bold 15px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      const stage = SURGERY_STAGES[Math.min(done, SURGERY_STAGES.length - 1)];
      ctx.fillText(`Stage ${Math.min(done + 1, 3)} of 3: ${stage}`, CANVAS_WIDTH / 2, 166);
      // Scalpel at the marker.
      const sx = bar.x + overlay.gauge * bar.w;
      ctx.save();
      ctx.translate(sx, 352);
      ctx.rotate(-0.5);
      drawRoundRect(ctx, -4, -40, 8, 34, 3, '#c8ccd4');
      ctx.fillStyle = '#eef2f6';
      ctx.beginPath();
      ctx.moveTo(-4, -6);
      ctx.lineTo(4, -6);
      ctx.lineTo(0, 10);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // Shared timing bar.
    drawRoundRect(ctx, bar.x, bar.y, bar.w, bar.h, 10, 'rgba(255,251,246,0.95)');
    drawRoundRect(ctx, bar.x + zone.start * bar.w, bar.y, zone.width * bar.w, bar.h, 6, '#f2d98a');
    ctx.strokeStyle = 'rgba(58,42,42,0.4)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(bar.x, bar.y, bar.w, bar.h, 10);
    ctx.stroke();
    const mx = bar.x + overlay.gauge * bar.w;
    ctx.fillStyle = '#c65f7c';
    ctx.beginPath();
    ctx.moveTo(mx, bar.y - 4);
    ctx.lineTo(mx - 8, bar.y - 17);
    ctx.lineTo(mx + 8, bar.y - 17);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(mx - 1.5, bar.y, 3, bar.h);

    if (overlay.required > 1) {
      for (let i = 0; i < overlay.required; i++) {
        ctx.fillStyle = i < overlay.hits ? '#5fa86a' : 'rgba(58,42,42,0.2)';
        ctx.beginPath();
        ctx.arc(CANVAS_WIDTH / 2 - 24 + i * 24, 498, 8, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    drawFlash(406);
  }

  function drawHeart(x, y, size, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y + size * 0.9);
    ctx.bezierCurveTo(x - size * 1.3, y + size * 0.1, x - size * 0.9, y - size * 0.95, x, y - size * 0.35);
    ctx.bezierCurveTo(x + size * 0.9, y - size * 0.95, x + size * 1.3, y + size * 0.1, x, y + size * 0.9);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    ctx.ellipse(x - size * 0.42, y - size * 0.3, size * 0.18, size * 0.11, -0.6, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawSkull(x, y, size) {
    ctx.fillStyle = '#efeadf';
    ctx.beginPath();
    ctx.arc(x, y - size * 0.15, size * 0.8, 0, Math.PI * 2);
    ctx.fill();
    drawRoundRect(ctx, x - size * 0.45, y + size * 0.35, size * 0.9, size * 0.45, size * 0.12, '#efeadf');
    ctx.strokeStyle = 'rgba(58,42,42,0.35)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(x, y - size * 0.15, size * 0.8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#2a2226';
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(x + dir * size * 0.32, y - size * 0.12, size * 0.22, size * 0.26, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.moveTo(x, y + size * 0.12);
    ctx.lineTo(x - size * 0.1, y + size * 0.3);
    ctx.lineTo(x + size * 0.1, y + size * 0.3);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#2a2226';
    ctx.lineWidth = 1.2;
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(x + i * size * 0.2, y + size * 0.45);
      ctx.lineTo(x + i * size * 0.2, y + size * 0.75);
      ctx.stroke();
    }
  }

  function drawOxygenOverlay() {
    drawPanel('Oxygen', 'Find the hearts to pump the bag — three good pumps. Skulls are missed pumps!');
    const info = patientInfo.get(shiftState.activeTask?.patientId);
    const t = performance.now() / 1000;
    const squeeze = overlay.squeeze;

    // Left column: the patient with a mask, tubed to the bag above.
    drawRoundRect(ctx, PANEL.x + 24, 142, 230, 336, 14, '#e2ece8');
    if (info) drawHospitalPerson(ctx, PANEL.x + 110, 420, { personalityKey: info.personalityKey, scale: 1.25 });
    drawRoundRect(ctx, PANEL.x + 94, 352, 32, 22, 9, 'rgba(160,210,230,0.9)');
    ctx.strokeStyle = '#9aa6b0';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(PANEL.x + 126, 362);
    ctx.quadraticCurveTo(PANEL.x + 200, 330, PANEL.x + 190, 262);
    ctx.stroke();
    ctx.fillStyle = '#7fb8d0';
    ctx.beginPath();
    ctx.ellipse(PANEL.x + 190, 210, 40 - 12 * squeeze, 52 - 10 * squeeze, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#4f8aa8';
    ctx.lineWidth = 3;
    ctx.stroke();
    drawRoundRect(ctx, PANEL.x + 176, 150 + 8 * squeeze, 28, 14, 5, '#5a7080');
    if (squeeze > 0) {
      ctx.fillStyle = `rgba(200,235,250,${squeeze})`;
      for (const [dx, dy, r] of [[-26, -22, 9], [-40, -36, 6], [-14, -40, 5]]) {
        ctx.beginPath();
        ctx.arc(PANEL.x + 110 + dx, 352 + dy, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // The scene: bobbing hearts (pulsing) and skulls.
    drawRoundRect(ctx, OXYGEN_SCENE.x - 30, OXYGEN_SCENE.y - 30, OXYGEN_SCENE.w + 60, OXYGEN_SCENE.h + 60, 16, '#ece6da');
    for (const it of overlay.items) {
      const bob = Math.sin(t * 2 + it.phase) * 4;
      const alpha = it.kind === 'skull' ? 1 - it.fade : 1;
      if (alpha <= 0) continue;
      ctx.save();
      ctx.globalAlpha = alpha;
      if (it.kind === 'heart') {
        const pulse = it.found ? 1 : 1 + 0.08 * Math.sin(t * 6 + it.phase);
        drawHeart(it.x, it.y + bob, 20 * pulse, it.found ? 'rgba(224,72,79,0.25)' : '#e0484f');
        if (it.found) drawLabelChip(ctx, it.x, it.y + bob, '✓', 'bold 12px sans-serif', '#5fa86a', CREAM);
      } else {
        drawSkull(it.x, it.y + bob, 21);
        if (it.found) {
          ctx.strokeStyle = '#d9534f';
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.moveTo(it.x - 16, it.y + bob - 18);
          ctx.lineTo(it.x + 16, it.y + bob + 14);
          ctx.moveTo(it.x + 16, it.y + bob - 18);
          ctx.lineTo(it.x - 16, it.y + bob + 14);
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    for (let i = 0; i < overlay.required; i++) {
      ctx.globalAlpha = 1;
      drawHeart(OXYGEN_SCENE.x + OXYGEN_SCENE.w / 2 - 30 + i * 30, 506, 9, i < overlay.hits ? '#e0484f' : 'rgba(58,42,42,0.2)');
    }
    drawFlash(160);
  }

  function drawBandageOverlay() {
    drawPanel('Bandage', 'Hold and trace the dashed line along the wound, start to end.');
    const info = patientInfo.get(shiftState.activeTask?.patientId);
    const skin = PERSON_TEMPLATES[info?.personalityKey]?.headColor ?? '#e0ac69';
    drawRoundRect(ctx, 200, 170, 560, 260, 40, skin);
    const path = overlay.path;
    // The wound: a jagged red line along the path.
    ctx.strokeStyle = '#b03a32';
    ctx.lineWidth = 5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    path.forEach((p, i) => {
      if (i === 0) { ctx.moveTo(p.x, p.y); return; }
      const prev = path[i - 1];
      const mx = (prev.x + p.x) / 2;
      const my = (prev.y + p.y) / 2 + (i % 2 ? 6 : -6);
      ctx.lineTo(mx, my);
      ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
    // Tolerance band and dashed guide.
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = BANDAGE_TOLERANCE_PX * 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    path.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();
    ctx.strokeStyle = CREAM;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 7]);
    ctx.beginPath();
    path.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();
    ctx.setLineDash([]);
    // Start/end markers.
    const start = path[0];
    const end = path[path.length - 1];
    ctx.fillStyle = '#5fa86a';
    ctx.beginPath();
    ctx.arc(start.x, start.y, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#d9534f';
    ctx.beginPath();
    ctx.arc(end.x, end.y, 9, 0, Math.PI * 2);
    ctx.fill();
    drawLabelChip(ctx, start.x, start.y - 22, 'START', 'bold 10px sans-serif');
    // The gauze laid so far.
    if (overlay.samples.length > 1) {
      ctx.strokeStyle = 'rgba(250,250,245,0.95)';
      ctx.lineWidth = 16;
      ctx.beginPath();
      overlay.samples.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
      ctx.strokeStyle = 'rgba(200,200,190,0.6)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
    drawFlash(470);
  }

  function drawMedsOverlay() {
    const bedIndex = shiftState.activeTask?.bedIndex ?? 0;
    const name = patientInfo.get(shiftState.activeTask?.patientId)?.name ?? '';
    drawPanel('Med Cabinet', 'Pick the ordered medication, then the dose (keys: bottle 1–8, then dose 1–3).');
    drawRoundRect(ctx, CANVAS_WIDTH / 2 - 210, 134, 420, 30, 8, '#2f5f6f');
    ctx.fillStyle = CREAM;
    ctx.font = 'bold 15px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`Order · ${bedLabel(bedIndex)} · ${name}: ${overlay.order.drug} × ${overlay.order.dose}`, CANVAS_WIDTH / 2, 149);

    medsBottleRects().forEach((b, i) => {
      const picked = overlay.picked === b.name;
      drawRoundRect(ctx, b.x, b.y, b.w, b.h, 10, picked ? '#fbe9b8' : '#ffffff');
      ctx.strokeStyle = picked ? '#e0a83a' : 'rgba(58,42,42,0.2)';
      ctx.lineWidth = picked ? 3 : 1.5;
      ctx.beginPath();
      ctx.roundRect(b.x, b.y, b.w, b.h, 10);
      ctx.stroke();
      const cx = b.x + b.w / 2;
      drawRoundRect(ctx, cx - 18, b.y + 22, 36, 48, 6, b.color);
      drawRoundRect(ctx, cx - 21, b.y + 12, 42, 14, 4, '#f2f0ea');
      drawRoundRect(ctx, cx - 15, b.y + 36, 30, 22, 3, CREAM);
      ctx.fillStyle = 'rgba(58,42,42,0.5)';
      ctx.fillRect(cx - 10, b.y + 42, 20, 2);
      ctx.fillRect(cx - 10, b.y + 48, 14, 2);
      ctx.fillStyle = LABEL_TEXT_COLOR;
      ctx.font = 'bold 12px sans-serif';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(b.name, cx, b.y + 90);
      ctx.font = '10px sans-serif';
      ctx.fillStyle = 'rgba(58,42,42,0.55)';
      ctx.fillText(String(i + 1), b.x + 10, b.y + 16);
    });

    ctx.textAlign = 'right';
    ctx.fillStyle = LABEL_TEXT_COLOR;
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText(overlay.picked ? `${overlay.picked} — dose:` : 'Dose:', CANVAS_WIDTH / 2 + 6, 499);
    medsDoseRects().forEach((r) => {
      drawRoundRect(ctx, r.x, r.y, r.w, r.h, 10, overlay.picked ? '#7fb0d6' : '#c8d0d6');
      ctx.fillStyle = CREAM;
      ctx.textAlign = 'center';
      ctx.font = 'bold 15px sans-serif';
      ctx.fillText(`× ${r.dose}`, r.x + r.w / 2, r.y + 29);
    });
    drawFlash(118);
  }

  function drawKarenOverlay() {
    drawPanel('An angry relative', null);
    drawHospitalPerson(ctx, CANVAS_WIDTH / 2, 410, { personalityKey: 'karen', scale: 1.4, angryTint: true });
    drawRoundRect(ctx, 180, 118, CANVAS_WIDTH - 360, 96, 12, CREAM);
    ctx.fillStyle = LABEL_TEXT_COLOR;
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    wrapText(KAREN_LINE, CANVAS_WIDTH / 2, 154, CANVAS_WIDTH - 400, 22);
    ctx.font = '12px sans-serif';
    ctx.fillText(`${Math.max(0, Math.ceil(shiftState.karen.timerSecondsRemaining))}s to respond`, CANVAS_WIDTH / 2, 202);
    const b = karenButtonRects();
    drawRoundRect(ctx, b.explain.x, b.explain.y, b.explain.w, b.explain.h, 8, '#5fa86a');
    drawRoundRect(ctx, b.letCut.x, b.letCut.y, b.letCut.w, b.letCut.h, 8, '#e0a83a');
    ctx.fillStyle = CREAM;
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText('Explain Triage', b.explain.x + b.explain.w / 2, b.explain.y + 27);
    ctx.fillText('Let Her Cut In', b.letCut.x + b.letCut.w / 2, b.letCut.y + 27);
  }

  function drawCoffeePourOverlay() {
    ctx.fillStyle = 'rgba(20,30,30,0.55)';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    const cx = CANVAS_WIDTH / 2;
    drawRoundRect(ctx, cx - 210, 110, 420, 400, 18, '#f2e9da');
    ctx.fillStyle = LABEL_TEXT_COLOR;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText('Pour a Coffee', cx, 145);
    ctx.font = '13px sans-serif';
    ctx.fillText('Hold mouse/tap or Space/Enter to pour. Let go in the gold band.', cx, 167);

    // Machine head + spout above the cup.
    drawRoundRect(ctx, cx - 70, 180, 140, 34, 8, '#7a5a42');
    drawRoundRect(ctx, cx - 24, 214, 48, 12, 3, '#b0a090');
    ctx.fillStyle = '#9fe0a8';
    ctx.fillRect(cx - 40, 190, 26, 8);
    ctx.fillStyle = overlay.pouring ? '#e06a5b' : '#e8b95a';
    ctx.beginPath();
    ctx.arc(cx + 44, 197, 6, 0, Math.PI * 2);
    ctx.fill();

    // Cup geometry: a slightly tapered mug, fill measured bottom -> brim.
    const cupTop = 268;
    const cupBottom = 450;
    const cupH = cupBottom - cupTop;
    const topHalfW = 78;
    const bottomHalfW = 64;
    const halfWAt = (y) => bottomHalfW + (topHalfW - bottomHalfW) * ((cupBottom - y) / cupH);
    const yForFill = (f) => cupBottom - f * cupH;

    // Stream while pouring.
    if (overlay.pouring) {
      ctx.fillStyle = '#6a4a30';
      const surfaceY = yForFill(overlay.fill);
      ctx.fillRect(cx - 3, 226, 6, surfaceY - 226);
    }

    // Saucer, mug body (cream), handle.
    drawRoundRect(ctx, cx - 110, cupBottom + 4, 220, 14, 7, '#e3d6c2');
    ctx.strokeStyle = '#fdf8ee';
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.arc(cx + topHalfW + 6, cupTop + 70, 30, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
    ctx.fillStyle = '#fdf8ee';
    ctx.beginPath();
    ctx.moveTo(cx - topHalfW, cupTop);
    ctx.lineTo(cx + topHalfW, cupTop);
    ctx.lineTo(cx + bottomHalfW, cupBottom);
    ctx.quadraticCurveTo(cx, cupBottom + 10, cx - bottomHalfW, cupBottom);
    ctx.closePath();
    ctx.fill();

    // Coffee inside the cup, clipped to the mug's inner shape.
    ctx.save();
    ctx.beginPath();
    const inset = 8;
    ctx.moveTo(cx - topHalfW + inset, cupTop + 2);
    ctx.lineTo(cx + topHalfW - inset, cupTop + 2);
    ctx.lineTo(cx + bottomHalfW - inset, cupBottom - inset);
    ctx.lineTo(cx - bottomHalfW + inset, cupBottom - inset);
    ctx.closePath();
    ctx.clip();
    ctx.fillStyle = '#efe4d2';
    ctx.fillRect(cx - topHalfW, cupTop, topHalfW * 2, cupH);
    const surfaceY = yForFill(overlay.fill);
    ctx.fillStyle = '#6a4a30';
    ctx.fillRect(cx - topHalfW, surfaceY, topHalfW * 2, cupBottom - surfaceY);
    ctx.fillStyle = '#c49a6c'; // crema on top
    ctx.fillRect(cx - topHalfW, surfaceY, topHalfW * 2, Math.min(6, cupBottom - surfaceY));

    // Target band.
    const bandTop = yForFill(overlay.band.high);
    const bandBottom = yForFill(overlay.band.low);
    ctx.fillStyle = 'rgba(242,217,138,0.45)';
    ctx.fillRect(cx - topHalfW, bandTop, topHalfW * 2, bandBottom - bandTop);
    ctx.strokeStyle = '#e0a83a';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    for (const y of [bandTop, bandBottom]) {
      ctx.beginPath();
      ctx.moveTo(cx - topHalfW, y);
      ctx.lineTo(cx + topHalfW, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();

    // Side markers so the band reads even when the coffee covers it.
    ctx.fillStyle = '#e0a83a';
    for (const dir of [-1, 1]) {
      const bx = cx + dir * (halfWAt(bandTop) + 12);
      ctx.beginPath();
      ctx.moveTo(bx - dir * 8, (bandTop + bandBottom) / 2);
      ctx.lineTo(bx, bandTop);
      ctx.lineTo(bx, bandBottom);
      ctx.closePath();
      ctx.fill();
    }

    // Spill: coffee sloshes over the rim and splashes out at you.
    if (overlay.grade === 'spilled') {
      ctx.fillStyle = '#6a4a30';
      for (const [sx, sy, r] of [[-40, -40, 9], [30, -55, 7], [-10, -70, 6], [55, -25, 5], [-62, -18, 5], [12, -88, 4]]) {
        ctx.beginPath();
        ctx.arc(cx + sx, cupTop + sy, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#6a4a30';
      for (const [dx, len] of [[-topHalfW + 4, 30], [-topHalfW + 22, 16], [topHalfW - 10, 24]]) {
        drawRoundRect(ctx, cx + dx, cupTop - 2, 7, len, 3.5, '#6a4a30');
      }
      ctx.beginPath();
      ctx.ellipse(cx - 30, cupBottom + 12, 34, 5, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Steam once it's done.
    if (overlay.grade && overlay.grade !== 'spilled') {
      ctx.strokeStyle = 'rgba(120,100,80,0.45)';
      ctx.lineWidth = 3;
      for (const dx of [-24, 0, 24]) {
        ctx.beginPath();
        ctx.moveTo(cx + dx, cupTop - 6);
        ctx.quadraticCurveTo(cx + dx - 8, cupTop - 18, cx + dx, cupTop - 30);
        ctx.quadraticCurveTo(cx + dx + 8, cupTop - 40, cx + dx, cupTop - 50);
        ctx.stroke();
      }
    }

    // Result banner.
    if (overlay.grade) {
      const label = { perfect: 'Perfect!', good: 'Good', sloppy: 'Sloppy', spilled: 'Spilled!' }[overlay.grade];
      const color = { perfect: '#e0a83a', good: '#7fb0d6', sloppy: '#a08a7a', spilled: '#e06a5b' }[overlay.grade];
      drawRoundRect(ctx, cx - 70, 474, 140, 30, 15, color);
      ctx.fillStyle = '#fdf8ee';
      ctx.font = 'bold 16px sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, cx, 489);
      ctx.textBaseline = 'alphabetic';
    }
  }

  function drawOverlay() {
    if (!overlay) return;
    ctx.save();
    if (overlay.kind === 'triage') drawTriageOverlay();
    else if (overlay.kind === 'skill') drawSkillOverlay();
    else if (overlay.kind === 'oxygen') drawOxygenOverlay();
    else if (overlay.kind === 'bandage') drawBandageOverlay();
    else if (overlay.kind === 'meds') drawMedsOverlay();
    else if (overlay.kind === 'karen') drawKarenOverlay();
    else if (overlay.kind === 'coffee-pour') drawCoffeePourOverlay();
    ctx.restore();
  }

  function render() {
    lastFrameDrewPlayer = false;
    const intensity = currentIntensity();
    const shake = intensity > 0.6 ? (intensity - 0.6) * 5 : 0;
    ctx.save();
    if (shake > 0) ctx.translate((random() - 0.5) * shake, (random() - 0.5) * shake);
    drawFloor();
    stations.forEach(drawStation);
    drawTriageQueue();
    drawPlayer();
    drawHallucinations();
    ctx.restore();
    drawStatBar(14, 'Sanity', shiftState ? shiftState.sanity : SANITY_MAX, SANITY_MAX, '#7fd68a', sanityFontReady ? 'bold 11px "Caprasimo", sans-serif' : 'bold 11px sans-serif');
    drawStatBar(36, 'Mood', shiftState ? shiftState.wardMood : WARD_MOOD_MAX, WARD_MOOD_MAX, '#7fb0d6', 'bold 10px sans-serif');
    drawRatingStars();
    drawGardCounter();
    drawOverlay();
  }

  // -- Game loop ---------------------------------------------------------------------------

  function loop(timestamp) {
    if (!running || paused) { rafHandle = null; return; }
    if (lastTimestamp === null) lastTimestamp = timestamp;
    const dt = Math.min(0.1, (timestamp - lastTimestamp) / 1000);
    lastTimestamp = timestamp;

    if (!overlay) updatePlayer(dt);

    const before = shiftState;
    shiftState = tick(shiftState, dt);

    // A task overlay whose task the engine dropped (patient transferred, or
    // the clock ran out) closes with an explanation.
    if (overlay && TASK_OVERLAYS.has(overlay.kind) && !shiftState.activeTask && !(overlay.closeIn > 0)) {
      overlay = null;
      if (shiftState.phase === 'playing') showToast('Too late — the patient was transferred to another hospital.');
    }
    if (overlay && (overlay.kind === 'triage' || overlay.kind === 'coffee-pour') && shiftState.phase !== 'playing') overlay = null;
    if (overlay?.kind === 'triage' && !shiftState.triageQueue.some((p) => p.id === overlay.patientId)) {
      overlay = null;
      showToast('They got tired of waiting and left.');
    }
    if (overlay?.kind === 'karen' && !shiftState.karen.active) {
      overlay = null;
      showToast('Karen shoves past you to the front of the line.');
    }

    if (shiftState.transfers > before.transfers) {
      showToast(`A patient waited too long and was transferred out — mistake, −${RATING_PENALTY_PER_WALKOUT}★`);
    } else if (shiftState.walkouts > before.walkouts) {
      showToast(`Someone in the triage line gave up and left — −${RATING_PENALTY_PER_WALKOUT}★`);
    }
    if (before.phase === 'playing' && shiftState.phase === 'closing-wait') {
      showToast("7:00 PM — handover time. Head to the Charge Nurse's office.", 4);
    }

    trackGardPops(dt);
    coffeeSplashSeconds = Math.max(0, coffeeSplashSeconds - dt);
    updateHallucinations(dt);

    if (waitingAtOffice && isOfficeReady(shiftState) && !overlay) {
      if (isPlayerAtOffice()) { enterOfficeNow(); return; }
      waitingAtOffice = false;
    }

    if (shiftState.phase === 'playing') processScheduledEvents();
    updateOverlay(dt);
    updateHoverHint();
    renderHud();
    render();
    rafHandle = window.requestAnimationFrame(loop);
  }

  // -- Fullscreen / visibility ----------------------------------------------------------------

  function requestFullscreen() {
    if (document.fullscreenElement) return;
    document.getElementById('hospital-game-container')?.requestFullscreen?.().catch(() => {});
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) requestFullscreen();
    else document.exitFullscreen?.().catch(() => {});
  }

  function onFullscreenChange() {
    elements.fullscreenButton.textContent = document.fullscreenElement ? 'Exit Fullscreen' : 'Fullscreen';
  }

  function onVisibilityChange() {
    paused = document.hidden;
    if (!paused && running && rafHandle === null) {
      lastTimestamp = null;
      rafHandle = window.requestAnimationFrame(loop);
    }
  }

  // -- Wiring ---------------------------------------------------------------------------------

  canvas.addEventListener('click', onCanvasClick);
  canvas.addEventListener('pointerdown', onCanvasPointerDown);
  canvas.addEventListener('pointermove', onCanvasPointerMove);
  canvas.addEventListener('mouseleave', onCanvasMouseLeave);
  window.addEventListener('pointerup', onWindowPointerUp);
  window.addEventListener('pointercancel', onWindowPointerUp);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  document.addEventListener('visibilitychange', onVisibilityChange);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  elements.fullscreenButton.addEventListener('click', toggleFullscreen);
  elements.startScreen.shiftButton.addEventListener('click', startShift);
  elements.paycheckScreen.nextShiftButton.addEventListener('click', startShift);
  elements.paycheckScreen.newMonthButton.addEventListener('click', startNewMonth);
  elements.paycheckScreen.submitButton?.addEventListener('click', () => {
    // Disabling a submit button synchronously in its own click handler
    // suppresses the form submit (the same bug the other games fixed).
    window.setTimeout(() => { elements.paycheckScreen.submitButton.disabled = true; }, 0);
  });

  function teardown() {
    running = false;
    if (rafHandle !== null) {
      window.cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
    if (toastTimeoutHandle) window.clearTimeout(toastTimeoutHandle);
    canvas.removeEventListener('click', onCanvasClick);
    canvas.removeEventListener('pointerdown', onCanvasPointerDown);
    canvas.removeEventListener('pointermove', onCanvasPointerMove);
    canvas.removeEventListener('mouseleave', onCanvasMouseLeave);
    window.removeEventListener('pointerup', onWindowPointerUp);
    window.removeEventListener('pointercancel', onWindowPointerUp);
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    document.body.removeEventListener('htmx:beforeSwap', onBeforeSwap);
    if (teardownActiveInstance === teardown) teardownActiveInstance = null;
  }

  function onBeforeSwap(e) {
    if (e.target && e.target.id === 'main-content') teardown();
  }
  document.body.addEventListener('htmx:beforeSwap', onBeforeSwap);
  teardownActiveInstance = teardown;

  // Test-only hooks for e2e/hospital-shift.spec.js: the real shift clock is
  // 6–10 real minutes and spawns are random, so tests read exact positions
  // and force spawns here, then drive the same click/key paths a player uses.
  window.__hospitalShiftTestHooks = {
    getStations: () => stations.map((s) => ({ ...s })),
    getPlayerPosition: () => ({ ...player }),
    setPlayerPosition: (x, y) => { player = { x, y }; },
    isPlayerMoving: () => moveTarget !== null,
    getShiftState: () => shiftState,
    getOverlay: () => (overlay ? JSON.parse(JSON.stringify(overlay)) : null),
    getTriageSlots: () => triageSlots(),
    getTriageButtonRects: () => triageButtonRects(),
    getMedsLayout: () => (overlay?.kind === 'meds' ? { bottles: medsBottleRects(), doses: medsDoseRects() } : null),
    getKarenButtonRects: () => karenButtonRects(),
    getCloseRect: () => ({ ...CLOSE_RECT }),
    getPatientInfo: (id) => patientInfo.get(id) ?? null,
    spawnPatientNow: (conditionId) => (shiftState?.phase === 'playing' ? spawnPatient(conditionId) : null),
    setSkillGauge(pos) { if (overlay?.kind === 'skill') { overlay.gauge = pos; overlay.direction = 0; } },
    setCoffeePourFill(fill) { if (overlay?.kind === 'coffee-pour' && !overlay.grade) overlay.fill = fill; },
    setSanity(value) { if (shiftState) shiftState = { ...shiftState, sanity: value }; },
    setWardMood(value) { if (shiftState) shiftState = { ...shiftState, wardMood: value }; },
    forceKarenShiftNow() {
      if (!shiftState) return;
      shiftState = { ...shiftState, karen: { ...shiftState.karen, shiftNumber: currentShiftNumber } };
      karenAvailable = true;
    },
    spawnGhostNow() { halluc.ghosts.push({ id: `ghost-${halluc.ghostCounter++}`, age: 0, life: 60 }); },
    getHallucinations: () => ({ intensity: currentIntensity(), ghosts: halluc.ghosts.length }),
    wasPlayerDrawnLastFrame: () => lastFrameDrewPlayer,
    skipToClosing() {
      // Jump the clock to its last instant so only a tiny tick passes —
      // patience and Sanity don't drain by the whole remaining shift.
      if (!running || shiftState?.phase !== 'playing') return;
      shiftState = tick({ ...shiftState, clockSeconds: 0.001 }, 0.01);
      shiftState = { ...shiftState, closingWaitSecondsRemaining: 0 };
      overlay = null;
    },
  };

  showScreen('start');
  renderHud();
  return teardown;
}

let teardownActiveInstance = null;

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

function bootstrap() {
  const canvas = document.getElementById('hospital-canvas');
  if (!canvas) return;
  const byId = (id) => document.getElementById(id);
  init(canvas, {
    hud: { shift: byId('hospital-hud-shift'), clock: byId('hospital-hud-clock'), status: byId('hospital-hud-status') },
    hoverHint: byId('hospital-interact-hint'),
    toast: byId('hospital-toast'),
    fullscreenButton: byId('hospital-fullscreen-button'),
    startScreen: { root: byId('hospital-start-screen'), shiftButton: byId('hospital-start-shift-button') },
    paycheckScreen: {
      root: byId('hospital-paycheck-screen'),
      title: byId('hospital-paycheck-title'),
      outcome: byId('hospital-paycheck-outcome'),
      shiftTotal: byId('hospital-paycheck-shift-total'),
      monthTotal: byId('hospital-paycheck-month-total'),
      finalBlock: byId('hospital-final-paycheck-block'),
      earningsInput: byId('hospital-paycheck-earnings-input'),
      shiftsInput: byId('hospital-paycheck-shifts-input'),
      submitButton: byId('hospital-paycheck-submit-button'),
      nextShiftButton: byId('hospital-paycheck-next-shift-button'),
      newMonthButton: byId('hospital-paycheck-new-month-button'),
    },
  });
}

if (typeof document !== 'undefined') {
  bootstrap();
  // A module's top level runs once per document, so an HTMX revisit
  // (navigate away and back) would leave a fresh but inert canvas — re-run
  // bootstrap on every #main-content swap (the fix every game here uses).
  document.body.addEventListener('htmx:afterSwap', (e) => {
    if (e.target && e.target.id === 'main-content') bootstrap();
  });
}
