// Library Shift canvas engine: rendering, input, station interaction,
// patron/book spawning, and localStorage progress persistence
// (docs/features/library-game.md). Mirrors Kitchen Shift's
// `cooking-game.js` architecture closely — same `bootstrap()`/`init()`
// split, same `requestAnimationFrame` loop, same click-to-move geometry
// (`canvasCoordsFromEvent`'s letterbox-aware coordinate mapping, ported
// verbatim — see that function's own comment below for why a naive version
// is a real, previously-shipped bug on that game), same Fullscreen
// handling, same htmx-revisit bootstrap fix. All shift-state transitions
// (Return Cart/fines/borrow-request queues, Karen's scripted event, the
// shift clock, closing-wait) are delegated to the pure `./library/
// engine-state.js` module; shift-tier/payout/skill-check/Karen-seed math to
// `./library/rules.js`; station-position/click-hit-testing/movement
// geometry to `./library/floor-plan.js`. This file owns everything HTMX
// cannot model: the render loop, canvas input, patron/book spawning
// pacing, the four minigame overlays (Shelf/Checkout Skill-Check share one
// timing-bar component; Coin Hunt/Fines Sort/Find the Book share one
// "scattered items on a scene" shape), and the single `localStorage`
// progress key.
//
// Two floors (doc's Scope): 1st Floor holds every non-shelf station (Front
// Desk, Return Cart, the Fines Counter, the Coffee Machine, Boss's Office)
// plus some Bookshelves; 2nd Floor holds only the remaining Bookshelves —
// purely additional shelving. Three independent, instant ways to switch
// floors (no ride/climb animation, allowed in every shift phase including
// 'closing-wait'): a Stairs station, a visually distinct Elevator station,
// and the `#library-floor-button` HUD shortcut — see `./library/
// floor-plan.js`'s header comment for the full reasoning.
//
// No DOM overlay elements exist for the five minigames (Shelf/Checkout
// Skill-Check, Coin Hunt, Fines Sort, Find the Book) — the backend's
// library-game.html template intentionally ships none (see its own header
// comment: "not this backend PR's [to build]"). Every minigame therefore
// renders as a full-canvas overlay drawn directly by this file's `render()`
// and reads input through the same canvas click/keydown listeners as normal
// movement, gated by the `overlay` variable — see `onCanvasClick`.
//
// External file, no inline <script> tag, per this codebase's CSP-compatible
// convention. Loaded as an ES module:
//
//   <script type="module" src="/static/js/library-game.js"></script>
//
// from web/templates/pages/library-game.html.

import {
  SHIFTS_PER_MONTH,
  shiftClockSecondsForShift,
  returnVolumeForShift,
  fineVolumeForShift,
  borrowVolumeForShift,
  inGameTimeLabel,
  karenShiftForSeed,
  KAREN_LINE,
  GENRES,
  findGenre,
  isCoinHuntBook,
  COIN_HUNT_ITEM_VALUE_GARD,
  COIN_HUNT_ITEMS_PER_BOOK,
  fineAmountForRoll,
  skillCheckSuccessZone,
  isSkillCheckSuccess,
  skillCheckSweepSpeed,
  borrowPatienceSeconds,
  LIBRARY_MOOD_MAX,
  SANITY_MAX,
  walkSpeedMultiplierForSanity,
} from './library/rules.js';
import {
  createInitialState,
  startShift as startShiftState,
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
} from './library/engine-state.js';
import {
  buildStations,
  stationsOnFloor,
  stationAtPoint,
  approachPoint,
  clampToCanvas,
  entryPointForFloor,
  PLAYER_START,
  PLAYER_STOP_MARGIN,
  FLOOR_1,
  FLOOR_2,
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
} from './library/floor-plan.js';

// ---------------------------------------------------------------------------
// localStorage progress (doc's Data Model: "in-progress shift state, Gard,
// and shelf/book layout live in localStorage, not Postgres")
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'library-game:v1';

function defaultSave() {
  return {
    version: 1,
    monthToDateGard: 0,
    currentShift: 1,
    bestRunTotal: 0,
    // Karen's shift is randomInt(10,15) derived deterministically from this
    // seed (rules.js's karenShiftForSeed) so it stays stable across a page
    // reload mid-run, but re-rolls on "Start New Month" (doc's Business
    // Rules: "Karen shift").
    karenSeed: Date.now(),
  };
}

function probeStorageAvailable() {
  try {
    const probeKey = '\0library-game-probe';
    window.localStorage.setItem(probeKey, '1');
    window.localStorage.removeItem(probeKey);
    return true;
  } catch {
    return false;
  }
}

function isValidSaveShape(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.version !== 1) return false;
  if (typeof value.monthToDateGard !== 'number' || !Number.isFinite(value.monthToDateGard)) return false;
  if (typeof value.currentShift !== 'number' || !Number.isFinite(value.currentShift)) return false;
  if (typeof value.bestRunTotal !== 'number' || !Number.isFinite(value.bestRunTotal)) return false;
  if (typeof value.karenSeed !== 'number' || !Number.isFinite(value.karenSeed)) return false;
  return true;
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
    // Storage became unavailable mid-session — stays fully playable, just
    // silently stops persisting, same posture as Kitchen Shift's.
  }
}

// ---------------------------------------------------------------------------
// Drawing primitives (ported from cooking-game.js's own — no image assets
// anywhere on this site, canvas-primitives-only convention)
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

function drawLabelChip(ctx, x, y, text, font) {
  if (!text) return;
  ctx.save();
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const metrics = ctx.measureText(text);
  const paddingX = 7;
  const w = metrics.width + paddingX * 2;
  const h = 16;
  drawRoundRect(ctx, x - w / 2, y - h / 2, w, h, 6, 'rgba(255,251,246,0.92)');
  ctx.strokeStyle = 'rgba(58,42,42,0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - h / 2, w, h, 6);
  ctx.stroke();
  ctx.fillStyle = LABEL_TEXT_COLOR;
  ctx.fillText(text, x, y + 0.5);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Big, expressive pixel characters (doc's Visual Direction: "make the
// characters BIG," a personality-template system with distinct
// expression parameters, not palette swaps of one face)
// ---------------------------------------------------------------------------

/** Base draw scale — noticeably bigger than Kitchen Shift's own player scale (that game's drawPixelPerson body proportions, reused here at a higher `s`). */
export const LIBRARY_PERSON_SCALE = 1.55;

/**
 * Personality templates: each supplies its own brow angle (positive tilts
 * outer ends up — a "surprised/cheerful" brow; negative tilts them down — a
 * "grumpy/angry" brow), mouth curve (positive = smile, negative = frown,
 * magnitude = how pronounced), eye shape, and hair/outfit palette — the
 * doc's explicit "not just a recolor" requirement.
 */
export const PERSONALITY_TEMPLATES = {
  grumpyRegular: {
    label: 'Grumpy Regular',
    bodyColor: '#7d8570', pantsColor: '#5a5f4f', headColor: '#e3c2a0', hairColor: '#5a5248',
    eyeColor: '#3a2a2a', eyeShape: 'narrow', browAngle: -0.8, mouthCurve: -1.4, blush: false,
  },
  shyStudent: {
    label: 'Shy Student',
    bodyColor: '#a7c4d1', pantsColor: '#5c7480', headColor: '#f0d9c0', hairColor: '#3a2a20',
    eyeColor: '#2a2a3a', eyeShape: 'roundSmall', browAngle: 0.15, mouthCurve: 0.3, blush: true,
  },
  cheerfulKid: {
    label: 'Cheerful Kid',
    bodyColor: '#f2b6c6', pantsColor: '#e0899f', headColor: '#f6dcb8', hairColor: '#caa24a',
    eyeColor: '#2a2a2a', eyeShape: 'bigRound', browAngle: 0.7, mouthCurve: 1.6, blush: true,
  },
  karen: {
    label: 'Karen',
    bodyColor: '#d94f4f', pantsColor: '#8f2f2f', headColor: '#f0cba0', hairColor: '#d6b23e',
    eyeColor: '#3a2a2a', eyeShape: 'narrow', browAngle: -1.3, mouthCurve: -0.6, blush: false,
  },
};

const PERSONALITY_KEYS = ['grumpyRegular', 'shyStudent', 'cheerfulKid'];

function personalityForIndex(i) {
  return PERSONALITY_KEYS[i % PERSONALITY_KEYS.length];
}

function drawLibraryFace(ctx, x, y, s, personality, angryTint) {
  const headCenterY = y - 34 * s;
  const eyeY = headCenterY + 1 * s;

  for (const dir of [-1, 1]) {
    const ex = x + dir * 3.7 * s;
    let rx = 1.9 * s;
    let ry = 2.6 * s;
    if (personality.eyeShape === 'bigRound') { rx = 2.4 * s; ry = 3 * s; }
    else if (personality.eyeShape === 'narrow') { rx = 2.1 * s; ry = 1.3 * s; }
    else if (personality.eyeShape === 'roundSmall') { rx = 1.4 * s; ry = 1.8 * s; }

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(ex, eyeY, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = personality.eyeColor;
    ctx.beginPath();
    ctx.arc(ex, eyeY + 0.3 * s, Math.min(rx, ry) * 0.62, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(ex - 0.5 * s, eyeY - 0.5 * s, 0.5 * s, 0, Math.PI * 2);
    ctx.fill();

    // Eyebrow — angle mirrors between the two eyes (a V-shape frown reads
    // as angled DOWN toward the nose on both sides, not literally parallel
    // tilted lines), so `dir` flips the sign for the outer-vs-inner end.
    ctx.strokeStyle = personality.eyeColor;
    ctx.lineWidth = Math.max(1, 0.7 * s);
    const tilt = personality.browAngle * dir * 2.4 * s;
    ctx.beginPath();
    ctx.moveTo(ex - dir * 1.8 * s, eyeY - 3.6 * s - tilt);
    ctx.lineTo(ex + dir * 1.8 * s, eyeY - 3.6 * s + tilt);
    ctx.stroke();
  }

  if (personality.blush) {
    ctx.fillStyle = 'rgba(247,155,175,0.55)';
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(x + dir * 5.8 * s, headCenterY + 3.2 * s, 1.6 * s, 1 * s, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Mouth: curve sign/magnitude from personality.mouthCurve — a small arc
  // whose bow direction and depth vary, rather than one fixed smile shape.
  ctx.strokeStyle = '#8a4a4a';
  ctx.lineWidth = Math.max(1, 0.8 * s);
  const mouthY = headCenterY + 5 * s;
  const curve = personality.mouthCurve;
  ctx.beginPath();
  if (Math.abs(curve) < 0.5) {
    // Near-flat/tight mouth (Karen, a wary neutral) — a short straight line.
    ctx.moveTo(x - 1.6 * s, mouthY);
    ctx.lineTo(x + 1.6 * s, mouthY);
  } else if (curve > 0) {
    ctx.arc(x, mouthY - 1.2 * s * Math.min(curve, 1.6), 1.6 * s * Math.min(1 + curve * 0.3, 2.2), 0.15 * Math.PI, 0.85 * Math.PI);
  } else {
    ctx.arc(x, mouthY + 2.4 * s, 1.8 * s, 1.15 * Math.PI, 1.85 * Math.PI);
  }
  ctx.stroke();

  if (angryTint) {
    ctx.fillStyle = 'rgba(214,60,60,0.32)';
    ctx.beginPath();
    ctx.arc(x, headCenterY, 10 * s, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * The shared big-character draw helper (doc's `drawLibraryPerson`): body +
 * head + hair + a personality-parameterized face. `angryTint` is Karen's
 * "reddish face tint during her scripted outburst" (doc's Visual
 * Direction), passed independently of her base template so it only applies
 * while her event is actually active.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {{personalityKey?: string, scale?: number, angryTint?: boolean}} [opts]
 */
export function drawLibraryPerson(ctx, x, y, opts = {}) {
  const personality = PERSONALITY_TEMPLATES[opts.personalityKey] || PERSONALITY_TEMPLATES.shyStudent;
  const s = (opts.scale ?? 1) * LIBRARY_PERSON_SCALE;
  const pants = personality.pantsColor || personality.bodyColor;

  drawRoundRect(ctx, x - 9 * s, y - 4 * s, 7 * s, 16 * s, 2 * s, pants);
  drawRoundRect(ctx, x + 2 * s, y - 4 * s, 7 * s, 16 * s, 2 * s, pants);
  drawRoundRect(ctx, x - 13 * s, y - 24 * s, 7 * s, 18 * s, 3 * s, personality.bodyColor);
  drawRoundRect(ctx, x + 6 * s, y - 24 * s, 7 * s, 18 * s, 3 * s, personality.bodyColor);
  drawRoundRect(ctx, x - 12 * s, y - 26 * s, 24 * s, 22 * s, 7 * s, personality.bodyColor);

  ctx.fillStyle = personality.headColor;
  ctx.beginPath();
  ctx.arc(x, y - 34 * s, 10 * s, 0, Math.PI * 2);
  ctx.fill();

  if (personality.hairColor) {
    ctx.fillStyle = personality.hairColor;
    ctx.beginPath();
    ctx.arc(x, y - 37 * s, 10.5 * s, Math.PI, 0);
    ctx.fill();
  }

  drawLibraryFace(ctx, x, y, s, personality, Boolean(opts.angryTint));
}

// ---------------------------------------------------------------------------
// Book flavor titles (per-genre pools — decorative only, no gameplay stake)
// ---------------------------------------------------------------------------

const TITLE_POOLS = {
  mystery: ['The Silent Clue', 'Midnight Ledger', 'The Locked Room', 'A Quiet Alibi', 'The Missing Hour'],
  romance: ['Second Chances', 'The Letter Never Sent', 'Sunset in Gard', 'Two Left Umbrellas', 'A Promise Kept'],
  scifi: ['The Last Signal', 'Orbit Drift', 'Colony Nine', 'The Glass Engine', 'Beyond the Static'],
  kids: ['The Brave Little Fox', 'Bedtime for Dragons', 'The Cloud Garden', 'A Very Silly Day', 'The Tiny Explorer'],
  reference: ["The Gardener's Almanac", 'Complete Grammar Guide', 'World Atlas, Revised', 'Field Guide to Birds', 'The Home Repair Book'],
};

function titleForGenre(genreId, random) {
  const pool = TITLE_POOLS[genreId] || ['Untitled'];
  return pool[Math.floor(random() * pool.length)];
}

// ---------------------------------------------------------------------------
// Scattered-item scene helper (shared shape behind Coin Hunt / Fines Sort /
// Find the Book — doc: "same 'search the scene' shape")
// ---------------------------------------------------------------------------

const SCENE_X = [120, 840];
const SCENE_Y = [180, 480];

/** Scatters `count` points inside the scene bounds with a minimum separation, retrying on overlap (bounded attempts, falls back to whatever fits). */
function scatterPoints(count, random, minDist = 70) {
  const points = [];
  for (let i = 0; i < count; i++) {
    let placed = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      const candidate = {
        x: SCENE_X[0] + random() * (SCENE_X[1] - SCENE_X[0]),
        y: SCENE_Y[0] + random() * (SCENE_Y[1] - SCENE_Y[0]),
      };
      if (points.every((p) => Math.hypot(p.x - candidate.x, p.y - candidate.y) >= minDist)) {
        placed = candidate;
        break;
      }
      placed = candidate; // last attempt's candidate if every retry collided
    }
    points.push(placed);
  }
  return points;
}

// ---------------------------------------------------------------------------
// init()
// ---------------------------------------------------------------------------

/**
 * Wires up the canvas game loop against library-game.html's DOM elements.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} elements
 * @returns {() => void} a teardown function (also auto-invoked on htmx nav-away).
 */
export function init(canvas, elements) {
  if (typeof teardownActiveInstance === 'function') teardownActiveInstance();

  const ctx = canvas.getContext('2d');
  const storageAvailable = probeStorageAvailable();
  let save = loadSave(storageAvailable);
  const random = Math.random;
  const world = { width: CANVAS_WIDTH, height: CANVAS_HEIGHT };

  let stations = buildStations(GENRES);
  let currentFloor = FLOOR_1;
  let player = { ...PLAYER_START };
  let moveTarget = null; // { x, y, station: station|null }
  let hoverStation = null;

  let currentShiftNumber = save.currentShift;
  let karenShiftNumber = karenShiftForSeed(save.karenSeed);
  let karenAvailable = false; // true once her scheduled appearance time has passed this shift, until triggered

  let shiftState = null;
  let running = false;
  let paused = false;
  let lastTimestamp = null;
  let rafHandle = null;
  let toastTimeoutHandle = null;

  let scheduledEvents = [];
  let bookIdCounter = 0;
  let fineIdCounter = 0;
  let borrowIdCounter = 0;
  const bookCatalog = new Map(); // bookId -> { genreId, title } — for borrow requests, whose engine-state shape only carries an opaque bookId.

  let overlay = null; // one of the five minigame overlays, or null
  let pendingFrontDeskAction = null; // { kind: 'fine'|'borrow'|'karen', id? } queued by clicking a front-desk slot, executed on arrival
  let pendingCartPickupId = null; // queued by clicking a Return Cart book, executed on arrival

  let sanityFontReady = false;
  document.fonts.ready.then(() => { sanityFontReady = true; }).catch(() => {});

  // -- Save / toast / screen helpers --------------------------------------

  function showToast(text, seconds = 2.5) {
    elements.toast.textContent = text;
    elements.toast.classList.remove('hidden');
    if (toastTimeoutHandle) window.clearTimeout(toastTimeoutHandle);
    toastTimeoutHandle = window.setTimeout(() => {
      elements.toast.classList.add('hidden');
    }, seconds * 1000);
  }

  function showScreen(name) {
    elements.startScreen.root.classList.toggle('hidden', name !== 'start');
    elements.paycheckScreen.root.classList.toggle('hidden', name !== 'paycheck');
  }

  function renderStartScreen() {
    showScreen('start');
  }

  function renderHud() {
    elements.hud.shift.textContent = `${currentShiftNumber}/${SHIFTS_PER_MONTH}`;
    if (!shiftState) {
      elements.hud.clock.textContent = '--:--';
      elements.hud.status.textContent = 'Quiet';
      return;
    }
    elements.hud.clock.textContent = inGameTimeLabel(shiftState.clockSeconds, shiftState.totalClockSeconds);
    if (shiftState.phase === 'closing-wait') {
      elements.hud.status.textContent = isBossOfficeReady(shiftState) ? 'Closing — boss is ready' : 'Closing up…';
    } else if (shiftState.phase === 'paycheck') {
      elements.hud.status.textContent = 'Shift complete';
    } else if (shiftState.libraryMood > 70) {
      elements.hud.status.textContent = 'Calm';
    } else if (shiftState.libraryMood > 30) {
      elements.hud.status.textContent = 'Tense';
    } else {
      elements.hud.status.textContent = 'Frustrated patrons';
    }
  }

  function updateFloorButton() {
    if (!elements.floorButton) return;
    const upstairs = currentFloor === FLOOR_2;
    elements.floorButton.textContent = upstairs ? 'Go Downstairs' : 'Go Upstairs';
    elements.floorButton.setAttribute('aria-pressed', String(upstairs));
  }

  const STATION_LABELS = {
    'front-desk': 'Front Desk',
    'return-cart': 'Return Cart',
    'fines-counter': 'Fines Counter',
    'coffee-machine': 'Coffee Machine',
    'boss-office': "Boss's Office",
    stairs: 'Stairs',
    elevator: 'Elevator',
    bookshelf: null, // resolved per-station via genreId below
  };

  function labelForStation(station) {
    if (station.kind === 'bookshelf') {
      const genre = findGenre(station.genreId);
      return genre ? `${genre.name} Shelf` : 'Bookshelf';
    }
    if (station.kind === 'boss-office' && shiftState && shiftState.phase !== 'closing-wait' && shiftState.phase !== 'paycheck') {
      return "Boss's Office (locked)";
    }
    return STATION_LABELS[station.kind] || '';
  }

  function updateHoverHint() {
    if (overlay || !running) {
      elements.hoverHint.classList.add('hidden');
      return;
    }
    if (!hoverStation) {
      elements.hoverHint.classList.add('hidden');
      return;
    }
    elements.hoverHint.textContent = labelForStation(hoverStation);
    elements.hoverHint.classList.remove('hidden');
  }

  // -- Movement geometry ----------------------------------------------------

  // Letterbox-aware coordinate mapping — ported verbatim from
  // cooking-game.js's own `canvasCoordsFromEvent` (see that file's header
  // comment above this function for the full "its not working when i click
  // it" bug writeup this fixes): the canvas's CSS box (getBoundingClientRect)
  // isn't always 960:600, especially in fullscreen where app.css's
  // `:fullscreen` override lets #library-canvas-wrapper flex-fill whatever
  // space is under the HUD bar. object-fit: contain letterboxes the actual
  // rendered content inside that box; this computes the real content
  // rectangle and maps against that instead of the raw box.
  function canvasCoordsFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const worldAspect = world.width / world.height;
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
      x: ((e.clientX - rect.left - offsetX) / contentWidth) * world.width,
      y: ((e.clientY - rect.top - offsetY) / contentHeight) * world.height,
    };
  }

  function commitStationTarget(station, rawPoint) {
    if (station) {
      const standoff = station.size / 2 + PLAYER_STOP_MARGIN;
      const approach = approachPoint(station.x, station.y, player.x, player.y, standoff);
      moveTarget = { x: approach.x, y: approach.y, station };
    } else if (rawPoint) {
      moveTarget = { x: rawPoint.x, y: rawPoint.y, station: null };
    }
  }

  function updatePlayer(deltaSeconds) {
    if (!moveTarget) return;
    const sanityMultiplier = walkSpeedMultiplierForSanity(shiftState ? shiftState.sanity : SANITY_MAX);
    const step = 240 * sanityMultiplier * deltaSeconds;
    const dx = moveTarget.x - player.x;
    const dy = moveTarget.y - player.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= step || dist === 0) {
      const clamped = clampToCanvas(moveTarget.x, moveTarget.y);
      player.x = clamped.x;
      player.y = clamped.y;
      const arrivedStation = moveTarget.station;
      moveTarget = null;
      if (arrivedStation) handleArrival(arrivedStation);
    } else {
      const next = clampToCanvas(player.x + (dx / dist) * step, player.y + (dy / dist) * step);
      player.x = next.x;
      player.y = next.y;
    }
  }

  function switchFloor(floor) {
    currentFloor = floor;
    const entry = entryPointForFloor(floor);
    player.x = entry.x;
    player.y = entry.y;
    moveTarget = null;
    hoverStation = null;
    updateFloorButton();
  }

  // -- Front Desk / Return Cart queue slots ---------------------------------

  const SLOT_VISIBLE_MAX = 3;

  function frontDeskSlots() {
    if (!shiftState) return [];
    const slots = [];
    if (karenAvailable && !shiftState.karen.triggered) {
      slots.push({ kind: 'karen', id: 'karen' });
    }
    shiftState.finesQueue.slice(0, SLOT_VISIBLE_MAX).forEach((f) => slots.push({ kind: 'fine', id: f.id, amountGard: f.amountGard }));
    shiftState.borrowQueue.slice(0, SLOT_VISIBLE_MAX).forEach((r) => slots.push({ kind: 'borrow', id: r.id, bookId: r.bookId }));
    return slots.map((slot, i) => {
      const desk = stations.find((s) => s.kind === 'front-desk');
      const totalWidth = (slots.length - 1) * 46;
      return { ...slot, x: desk.x - totalWidth / 2 + i * 46, y: desk.y + desk.size / 2 + 58 };
    });
  }

  function frontDeskSlotAtPoint(x, y) {
    if (currentFloor !== FLOOR_1) return null;
    return frontDeskSlots().find((slot) => Math.hypot(slot.x - x, slot.y - y) <= 26) || null;
  }

  function returnCartSlots() {
    if (!shiftState) return [];
    const cart = stations.find((s) => s.kind === 'return-cart');
    return shiftState.returnCart.slice(0, 5).map((book, i) => ({
      ...book,
      x: cart.x - 60 + (i % 5) * 30,
      y: cart.y + cart.size / 2 + 34,
    }));
  }

  function returnCartSlotAtPoint(x, y) {
    if (currentFloor !== FLOOR_1) return null;
    return returnCartSlots().find((book) => Math.hypot(book.x - x, book.y - y) <= 18) || null;
  }

  // -- Patron/book spawn scheduling -----------------------------------------

  function scheduleShiftEvents() {
    const total = shiftState.totalClockSeconds;
    const events = [];
    const bookCount = returnVolumeForShift(currentShiftNumber);
    const fineCount = fineVolumeForShift(currentShiftNumber);
    const borrowCount = borrowVolumeForShift(currentShiftNumber);
    for (let i = 0; i < bookCount; i++) events.push({ type: 'book', at: random() * total * 0.85 });
    for (let i = 0; i < fineCount; i++) events.push({ type: 'fine', at: random() * total * 0.85 });
    for (let i = 0; i < borrowCount; i++) events.push({ type: 'borrow', at: random() * total * 0.85 });
    if (currentShiftNumber === karenShiftNumber) {
      events.push({ type: 'karen', at: total * 0.3 });
    }
    events.sort((a, b) => a.at - b.at);
    return events;
  }

  function spawnBook(forceCoinHunt) {
    const genre = GENRES[Math.floor(random() * GENRES.length)];
    const isCoinHunt = forceCoinHunt ?? isCoinHuntBook(random());
    const book = { id: `book-${bookIdCounter++}`, genreId: genre.id, isCoinHunt };
    shiftState = addBookToCart(shiftState, book);
  }

  function spawnFine(forcedAmount) {
    const amountGard = Number.isFinite(forcedAmount) ? forcedAmount : fineAmountForRoll(random());
    shiftState = addFineToQueue(shiftState, { id: `fine-${fineIdCounter++}`, amountGard });
  }

  function spawnBorrow() {
    const genre = GENRES[Math.floor(random() * GENRES.length)];
    const bookId = `borrow-book-${borrowIdCounter++}`;
    const title = titleForGenre(genre.id, random);
    bookCatalog.set(bookId, { genreId: genre.id, title });
    shiftState = addBorrowRequest(shiftState, {
      id: `borrow-${borrowIdCounter}`,
      bookId,
      patienceSeconds: borrowPatienceSeconds(currentShiftNumber),
    });
  }

  function processScheduledEvents() {
    if (!shiftState || shiftState.phase !== 'playing') return;
    const elapsed = shiftState.totalClockSeconds - shiftState.clockSeconds;
    while (scheduledEvents.length && scheduledEvents[0].at <= elapsed) {
      const event = scheduledEvents.shift();
      if (event.type === 'book') spawnBook();
      else if (event.type === 'fine') spawnFine();
      else if (event.type === 'borrow') spawnBorrow();
      else if (event.type === 'karen') karenAvailable = true;
    }
  }

  // -- Overlays: shared skill-check timing bar ------------------------------

  function openSkillCheckOverlay(context) {
    overlay = { kind: 'skill-check', context, gaugePosition: 0, direction: 1 };
  }

  function openCoinHuntOverlay() {
    const points = scatterPoints(COIN_HUNT_ITEMS_PER_BOOK, random, 90);
    overlay = {
      kind: 'coin-hunt',
      items: points.map((p, i) => ({ ...p, id: i, found: false, isBill: i % 2 === 1 })),
    };
  }

  const FINES_SORT_REAL_COUNT = 4;
  const FINES_SORT_DECOY_COUNT = 5;
  const DECOY_KINDS = ['paperclip', 'pen', 'button', 'key', 'stamp'];

  function openFinesSortOverlay() {
    const points = scatterPoints(FINES_SORT_REAL_COUNT + FINES_SORT_DECOY_COUNT, random, 70);
    const items = points.map((p, i) => {
      if (i < FINES_SORT_REAL_COUNT) return { ...p, id: i, found: false, real: true, isBill: i % 2 === 1 };
      return { ...p, id: i, found: false, real: false, decoyKind: DECOY_KINDS[(i - FINES_SORT_REAL_COUNT) % DECOY_KINDS.length] };
    });
    overlay = { kind: 'fines-sort', items };
  }

  const FIND_THE_BOOK_DECOY_COUNT = 5;

  function openFindTheBookOverlay(genreId, correctTitle) {
    const genre = findGenre(genreId);
    const points = scatterPoints(FIND_THE_BOOK_DECOY_COUNT + 1, random, 80);
    const correctIndex = Math.floor(random() * points.length);
    const items = points.map((p, i) => ({
      ...p,
      id: i,
      title: i === correctIndex ? correctTitle : titleForGenre(genreId, random),
      correct: i === correctIndex,
      color: genre ? genre.color : '#8a6a4a',
    }));
    overlay = { kind: 'find-the-book', items, genreId };
  }

  function openKarenOverlay() {
    overlay = { kind: 'karen' };
  }

  function updateOverlay(deltaSeconds) {
    if (!overlay) return;
    if (overlay.kind === 'skill-check') {
      const speed = skillCheckSweepSpeed(currentShiftNumber);
      overlay.gaugePosition += overlay.direction * speed * deltaSeconds;
      if (overlay.gaugePosition >= 1) { overlay.gaugePosition = 1; overlay.direction = -1; }
      else if (overlay.gaugePosition <= 0) { overlay.gaugePosition = 0; overlay.direction = 1; }
    }
  }

  // -- Arrival dispatch ------------------------------------------------------

  function handleArrival(station) {
    if (station.kind === 'stairs' || station.kind === 'elevator') {
      switchFloor(station.targetFloor);
      return;
    }
    if (!shiftState) return;

    if (station.kind === 'front-desk') {
      if (shiftState.activeBorrow?.stage === 'checkout') {
        openSkillCheckOverlay('checkout');
        return;
      }
      if (pendingFrontDeskAction) {
        const action = pendingFrontDeskAction;
        pendingFrontDeskAction = null;
        if (action.kind === 'fine') {
          const before = shiftState;
          shiftState = acceptFine(shiftState, action.id);
          if (shiftState !== before) showToast('Accepted a fine payment — take it to the Fines Counter.');
        } else if (action.kind === 'borrow') {
          const before = shiftState;
          shiftState = acceptBorrowRequest(shiftState, action.id);
          if (shiftState !== before) showToast('Took a borrow request — find the book on the shelves.');
        } else if (action.kind === 'karen') {
          const before = shiftState;
          shiftState = startKarenEvent(shiftState);
          if (shiftState !== before) openKarenOverlay();
        }
      }
      return;
    }

    if (station.kind === 'return-cart') {
      if (pendingCartPickupId) {
        const id = pendingCartPickupId;
        pendingCartPickupId = null;
        const before = shiftState;
        shiftState = pickUpBook(shiftState, id);
        if (shiftState !== before) showToast('Picked up a book — take it to its shelf.');
      }
      return;
    }

    if (station.kind === 'bookshelf') {
      if (shiftState.carriedBook) {
        const before = shiftState;
        shiftState = arriveAtShelf(shiftState, station.genreId);
        if (shiftState !== before) {
          if (shiftState.shelfCheck?.kind === 'coin-hunt') openCoinHuntOverlay();
          else openSkillCheckOverlay('shelf');
        } else {
          const genre = findGenre(station.genreId);
          showToast(`Wrong shelf — this book belongs on the ${genre ? genre.name : ''} shelf.`);
        }
      }
      if (shiftState.activeBorrow?.stage === 'searching') {
        const entry = bookCatalog.get(shiftState.activeBorrow.bookId);
        if (entry && entry.genreId === station.genreId) {
          openFindTheBookOverlay(station.genreId, entry.title);
        }
      }
      return;
    }

    if (station.kind === 'fines-counter') {
      if (shiftState.carriedFine) {
        const before = shiftState;
        shiftState = arriveAtFinesCounter(shiftState);
        if (shiftState !== before && shiftState.finesSortActive) openFinesSortOverlay();
      }
      return;
    }

    if (station.kind === 'coffee-machine') {
      const before = shiftState;
      shiftState = restoreSanity(shiftState);
      if (shiftState !== before) showToast('Coffee! Feeling sharper.');
      return;
    }

    if (station.kind === 'boss-office') {
      if (isBossOfficeReady(shiftState)) {
        shiftState = enterBossOffice(shiftState);
        endShift();
      } else if (shiftState.phase === 'playing') {
        showToast('The boss will let you in after closing.');
      }
    }
  }

  // -- Overlay input ----------------------------------------------------------

  function resolveSkillCheck() {
    const success = isSkillCheckSuccess(overlay.gaugePosition, skillCheckSuccessZone());
    if (overlay.context === 'shelf') {
      shiftState = resolveShelfSkillCheck(shiftState, success);
      showToast(success ? 'Shelved!' : 'Missed the mark — try again.');
      if (success) overlay = null;
      else { overlay.gaugePosition = 0; overlay.direction = 1; } // immediate retry, still carrying the book
    } else {
      shiftState = resolveCheckoutSkillCheck(shiftState, success);
      showToast(success ? 'Checked out — thank you!' : 'Fumbled the checkout — try again.');
      if (success) overlay = null;
      else { overlay.gaugePosition = 0; overlay.direction = 1; }
    }
  }

  function handleCoinHuntClick(x, y) {
    const item = overlay.items.find((it) => !it.found && Math.hypot(it.x - x, it.y - y) <= 20);
    if (!item) return;
    item.found = true;
    if (overlay.items.every((it) => it.found)) {
      const total = overlay.items.length * COIN_HUNT_ITEM_VALUE_GARD;
      shiftState = resolveCoinHunt(shiftState, total);
      showToast(`Found every coin — +${total} Gard!`);
      overlay = null;
    }
  }

  function handleFinesSortClick(x, y) {
    const item = overlay.items.find((it) => !it.found && Math.hypot(it.x - x, it.y - y) <= 20);
    if (!item) return;
    item.found = true;
    if (!item.real) return; // decoy clutter — inert, no penalty (doc's Business Rules)
    const remainingReal = overlay.items.some((it) => it.real && !it.found);
    if (!remainingReal) {
      shiftState = resolveFinesSort(shiftState, true);
      showToast('Fine banked!');
      overlay = null;
    }
  }

  function handleFindTheBookClick(x, y) {
    const item = overlay.items.find((it) => Math.hypot(it.x - x, it.y - y) <= 20);
    if (!item) return;
    if (item.correct) {
      shiftState = resolveFindTheBook(shiftState, true);
      showToast('Found it!');
      overlay = null;
    } else {
      showToast('Not the one…');
    }
  }

  function handleKarenClick(x, y) {
    const buttons = karenButtonRects();
    if (x >= buttons.collect.x && x <= buttons.collect.x + buttons.collect.w
      && y >= buttons.collect.y && y <= buttons.collect.y + buttons.collect.h) {
      shiftState = resolveKarenEvent(shiftState, 'collectFine');
      showToast('Collected the overdue fine.');
      overlay = null;
    } else if (x >= buttons.slide.x && x <= buttons.slide.x + buttons.slide.w
      && y >= buttons.slide.y && y <= buttons.slide.y + buttons.slide.h) {
      shiftState = resolveKarenEvent(shiftState, 'letItSlide');
      showToast('Let it slide — the library will hear about this.');
      overlay = null;
    }
  }

  function karenButtonRects() {
    const w = 150;
    const h = 40;
    return {
      collect: { x: CANVAS_WIDTH / 2 - w - 10, y: 430, w, h },
      slide: { x: CANVAS_WIDTH / 2 + 10, y: 430, w, h },
    };
  }

  function onOverlayClick(x, y) {
    if (overlay.kind === 'skill-check') resolveSkillCheck();
    else if (overlay.kind === 'coin-hunt') handleCoinHuntClick(x, y);
    else if (overlay.kind === 'fines-sort') handleFinesSortClick(x, y);
    else if (overlay.kind === 'find-the-book') handleFindTheBookClick(x, y);
    else if (overlay.kind === 'karen') handleKarenClick(x, y);
  }

  // -- Canvas input -----------------------------------------------------------

  function onCanvasClick(e) {
    if (!running) return;
    const { x, y } = canvasCoordsFromEvent(e);

    if (overlay) {
      onOverlayClick(x, y);
      return;
    }

    if (shiftState && shiftState.phase === 'playing') {
      const slot = frontDeskSlotAtPoint(x, y);
      if (slot) {
        if (slot.kind === 'karen') pendingFrontDeskAction = { kind: 'karen' };
        else pendingFrontDeskAction = { kind: slot.kind, id: slot.id };
        const desk = stations.find((s) => s.kind === 'front-desk');
        commitStationTarget(desk, null);
        return;
      }

      if (!shiftState.carriedBook) {
        const book = returnCartSlotAtPoint(x, y);
        if (book) {
          pendingCartPickupId = book.id;
          const cart = stations.find((s) => s.kind === 'return-cart');
          commitStationTarget(cart, null);
          return;
        }
      }
    }

    const station = stationAtPoint(x, y, stationsOnFloor(stations, currentFloor));
    commitStationTarget(station, { x, y });
  }

  function onCanvasMouseMove(e) {
    if (overlay) return;
    const { x, y } = canvasCoordsFromEvent(e);
    hoverStation = stationAtPoint(x, y, stationsOnFloor(stations, currentFloor));
  }

  function onCanvasMouseLeave() {
    hoverStation = null;
  }

  function onKeyDown(e) {
    if (overlay && (e.key === ' ' || e.key === 'Enter')) {
      e.preventDefault();
      // Sample at the overlay's center — a keyboard-reachable equivalent to
      // clicking, satisfying this game's accessibility requirement for a
      // non-pointer alternative to the timing-bar minigame specifically
      // (the two "search the scene" minigames still need pointer precision,
      // same as Kitchen Shift's own click-only station interactions).
      if (overlay.kind === 'skill-check') resolveSkillCheck();
      return;
    }
    if (e.key !== 'Enter') return;
    if (overlay || !running || !hoverStation) return;
    e.preventDefault();
    commitStationTarget(hoverStation, null);
  }

  // -- Shift lifecycle ----------------------------------------------------

  function beginShift() {
    currentShiftNumber = save.currentShift;
    karenShiftNumber = karenShiftForSeed(save.karenSeed);
    shiftState = startShiftState(createInitialState(currentShiftNumber, karenShiftNumber));
    player = { ...PLAYER_START };
    currentFloor = FLOOR_1;
    updateFloorButton();
    moveTarget = null;
    overlay = null;
    pendingFrontDeskAction = null;
    pendingCartPickupId = null;
    karenAvailable = false;
    bookCatalog.clear();
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
    if (isFinalShift) {
      save.bestRunTotal = Math.max(save.bestRunTotal, save.monthToDateGard);
    } else {
      save.currentShift = currentShiftNumber + 1;
    }
    persistSave(storageAvailable, save);

    elements.paycheckScreen.root.dataset.outcome = shiftState.mistakeCount > 0 ? 'upset' : 'ok';
    elements.paycheckScreen.root.dataset.final = isFinalShift ? 'true' : 'false';
    elements.paycheckScreen.title.textContent = isFinalShift ? 'Final Paycheck' : 'Closing up';
    elements.paycheckScreen.outcome.textContent = shiftState.mistakeCount > 0
      ? `${shiftState.mistakeCount} mistake${shiftState.mistakeCount === 1 ? '' : 's'} this shift`
      : 'Went well';
    elements.paycheckScreen.shiftTotal.textContent = `${payout} Gard`;
    elements.paycheckScreen.monthTotal.textContent = `${save.monthToDateGard} Gard`;
    elements.paycheckScreen.nextShiftButton.classList.toggle('hidden', isFinalShift);
    elements.paycheckScreen.newMonthButton.classList.toggle('hidden', !isFinalShift);
    elements.paycheckScreen.finalBlock.classList.toggle('hidden', !isFinalShift);
    if (isFinalShift) {
      if (elements.paycheckScreen.earningsInput) elements.paycheckScreen.earningsInput.value = String(save.monthToDateGard);
      if (elements.paycheckScreen.shiftsInput) elements.paycheckScreen.shiftsInput.value = String(SHIFTS_PER_MONTH);
      if (elements.paycheckScreen.submitButton) elements.paycheckScreen.submitButton.disabled = false;
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

  // -- Rendering ------------------------------------------------------------

  const STATION_COLORS = {
    'front-desk': '#f2d98a',
    'return-cart': '#d9bfa3',
    'fines-counter': '#f7c6b0',
    'coffee-machine': '#e6cbe8',
    'boss-office': '#dcc2ea',
    stairs: '#b8cde0',
    elevator: '#c9a7d1',
  };

  function drawFloor() {
    ctx.fillStyle = '#f4ead9';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    ctx.strokeStyle = 'rgba(120,90,60,0.08)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= CANVAS_WIDTH; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, CANVAS_HEIGHT);
      ctx.stroke();
    }
    for (let y = 0; y <= CANVAS_HEIGHT; y += 40) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(CANVAS_WIDTH, y);
      ctx.stroke();
    }

    ctx.fillStyle = '#8a6a4a';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(currentFloor === FLOOR_1 ? '1st Floor' : '2nd Floor', CANVAS_WIDTH / 2, 24);

    if (currentFloor === FLOOR_1) drawWallClock();
  }

  /**
   * Decorative analog wall clock (Visual Direction addition: "a clock to
   * track time" — the authoritative reading is `#library-hud-clock`'s
   * `inGameTimeLabel` text; this is purely diegetic floor dressing echoing
   * it). Hands are derived by parsing that same formatted label rather than
   * duplicating rules.js's internal minutes-since-midnight math, so the two
   * displays can never drift apart.
   */
  function drawWallClock() {
    if (!shiftState) return;
    const label = inGameTimeLabel(shiftState.clockSeconds, shiftState.totalClockSeconds);
    const match = /^(\d+):(\d+)\s(AM|PM)$/.exec(label);
    if (!match) return;
    const hour12 = Number(match[1]);
    const minute = Number(match[2]);
    const period = match[3];
    const hour24 = (hour12 % 12) + (period === 'PM' ? 12 : 0);

    // Positioned in the gap between the Front Desk and Boss's Office boxes
    // (both at y=90, x=480/700) rather than centered on the station row —
    // avoids overlapping either box or its label chip.
    const cx = 595;
    const cy = 58;
    const r = 20;
    ctx.save();
    drawRoundRect(ctx, cx - r - 4, cy - r - 4, (r + 4) * 2, (r + 4) * 2, 8, '#8a6a4a');
    ctx.fillStyle = '#fdf8ee';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#5a4a3a';
    ctx.lineWidth = 2;
    ctx.stroke();
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2;
      const x1 = cx + Math.cos(angle) * (r - 4);
      const y1 = cy + Math.sin(angle) * (r - 4);
      const x2 = cx + Math.cos(angle) * (r - 8);
      const y2 = cy + Math.sin(angle) * (r - 8);
      ctx.strokeStyle = '#5a4a3a';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    const minuteAngle = (minute / 60) * Math.PI * 2 - Math.PI / 2;
    const hourAngle = ((hour24 % 12) + minute / 60) / 12 * Math.PI * 2 - Math.PI / 2;
    ctx.strokeStyle = '#3a2a2a';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(hourAngle) * (r * 0.5), cy + Math.sin(hourAngle) * (r * 0.5));
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(minuteAngle) * (r * 0.75), cy + Math.sin(minuteAngle) * (r * 0.75));
    ctx.stroke();
    ctx.fillStyle = '#3a2a2a';
    ctx.beginPath();
    ctx.arc(cx, cy, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawStation(station) {
    const isHovered = hoverStation && hoverStation.id === station.id;
    const isTarget = moveTarget && moveTarget.station && moveTarget.station.id === station.id;
    const half = station.size / 2;
    const genre = station.kind === 'bookshelf' ? findGenre(station.genreId) : null;
    const baseColor = genre ? genre.color : (STATION_COLORS[station.kind] || '#8a6a4a');
    const locked = station.kind === 'boss-office' && shiftState
      && shiftState.phase !== 'closing-wait' && shiftState.phase !== 'paycheck';

    ctx.save();
    ctx.translate(Math.round(station.x), Math.round(station.y));

    if (station.kind === 'elevator') {
      // Visually distinct from Stairs (below) — a rounded shape with
      // "doors" down the middle, reading as a different fixture at a
      // glance (doc's "so they read as two different fixtures").
      drawRoundRect(ctx, -half, -half, station.size, station.size, 16, baseColor);
      ctx.fillStyle = 'rgba(255,251,246,0.85)';
      ctx.fillRect(-2, -half + 8, 4, station.size - 16);
    } else if (station.kind === 'stairs') {
      drawRoundRect(ctx, -half, -half, station.size, station.size, 6, baseColor);
      ctx.fillStyle = 'rgba(90,70,50,0.35)';
      for (let i = 0; i < 4; i++) {
        ctx.fillRect(-half + 8, -half + 10 + i * 14, station.size - 16, 6);
      }
    } else {
      drawRoundRect(ctx, -half, -half, station.size, station.size, 10, locked ? '#b8b0b8' : baseColor);
      if (locked) {
        ctx.strokeStyle = '#5a5060';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, -6, 6, Math.PI, 0);
        ctx.stroke();
        ctx.fillStyle = '#5a5060';
        ctx.beginPath();
        ctx.roundRect(-8, -2, 16, 12, 3);
        ctx.fill();
      }
      if (station.kind === 'bookshelf') {
        ctx.fillStyle = 'rgba(255,251,246,0.6)';
        for (let i = -1; i <= 1; i++) ctx.fillRect(i * 12 - 3, -half + 8, 6, station.size - 16);
      }
      if (station.kind === 'coffee-machine') {
        ctx.fillStyle = '#5a3a22';
        ctx.fillRect(-half + 12, -half + 10, station.size - 24, station.size * 0.45);
      }
      if (station.kind === 'fines-counter') {
        ctx.fillStyle = 'rgba(255,251,246,0.7)';
        ctx.fillRect(-half + 8, half - 20, station.size - 16, 12);
      }
    }

    ctx.strokeStyle = isTarget ? '#e0a83a' : (isHovered ? '#7fb0d6' : 'rgba(58,42,42,0.3)');
    ctx.lineWidth = isTarget || isHovered ? 3 : 2;
    ctx.beginPath();
    ctx.roundRect(-half + 1, -half + 1, station.size - 2, station.size - 2, 8);
    ctx.stroke();

    const label = labelForStation(station);
    if (label) {
      const labelBelowFits = station.y + half + 13 + 7 <= CANVAS_HEIGHT;
      drawLabelChip(ctx, 0, labelBelowFits ? half + 13 : -half - 13, label, 'bold 11px sans-serif');
    }

    ctx.restore();
  }

  function drawReturnCartBooks() {
    if (currentFloor !== FLOOR_1) return;
    for (const book of returnCartSlots()) {
      const genre = findGenre(book.genreId);
      drawRoundRect(ctx, book.x - 9, book.y - 12, 18, 24, 2, genre ? genre.color : '#8a6a4a');
      ctx.fillStyle = 'rgba(255,251,246,0.5)';
      ctx.fillRect(book.x - 9, book.y - 12, 3, 24);
      if (book.isCoinHunt) drawStar(ctx, book.x + 8, book.y - 14, 5, 2, '#f2d98a');
    }
    const cart = stations.find((s) => s.kind === 'return-cart');
    if (shiftState && shiftState.returnCart.length > 5) {
      drawLabelChip(ctx, cart.x, cart.y + cart.size / 2 + 60, `+${shiftState.returnCart.length - 5} more`, 'bold 10px sans-serif');
    }
  }

  const SLOT_PERSONALITY_CACHE = new Map();
  function personalityForSlot(slot, index) {
    if (slot.kind === 'karen') return 'karen';
    if (!SLOT_PERSONALITY_CACHE.has(slot.id)) SLOT_PERSONALITY_CACHE.set(slot.id, personalityForIndex(index));
    return SLOT_PERSONALITY_CACHE.get(slot.id);
  }

  function drawFrontDeskSlots() {
    if (currentFloor !== FLOOR_1) return;
    const slots = frontDeskSlots();
    slots.forEach((slot, i) => {
      const personality = personalityForSlot(slot, i);
      drawLibraryPerson(ctx, slot.x, slot.y, { personalityKey: personality, scale: 0.62, angryTint: slot.kind === 'karen' });
      if (slot.kind === 'fine') {
        drawStar(ctx, slot.x + 14, slot.y - 60, 6, 2.5, '#f2d98a');
        drawLabelChip(ctx, slot.x, slot.y + 20, `${slot.amountGard}g`, 'bold 9px sans-serif');
      } else if (slot.kind === 'borrow') {
        const entry = bookCatalog.get(slot.bookId);
        const genre = entry ? findGenre(entry.genreId) : null;
        drawRoundRect(ctx, slot.x + 8, slot.y - 66, 10, 14, 1, genre ? genre.color : '#8a6a4a');
      } else if (slot.kind === 'karen') {
        drawLabelChip(ctx, slot.x, slot.y + 20, 'Karen!', 'bold 10px sans-serif');
      }
    });
    const total = (shiftState?.finesQueue.length || 0) + (shiftState?.borrowQueue.length || 0);
    const shown = Math.min(shiftState?.finesQueue.length || 0, SLOT_VISIBLE_MAX) + Math.min(shiftState?.borrowQueue.length || 0, SLOT_VISIBLE_MAX);
    if (total > shown) {
      const desk = stations.find((s) => s.kind === 'front-desk');
      drawLabelChip(ctx, desk.x, desk.y + desk.size / 2 + 92, `+${total - shown} waiting`, 'bold 10px sans-serif');
    }
  }

  function currentPlayerBadge() {
    if (shiftState?.carriedBook) {
      const genre = findGenre(shiftState.carriedBook.genreId);
      return { color: genre ? genre.color : '#8a6a4a', kind: 'book' };
    }
    if (shiftState?.carriedFine) return { color: '#f2d98a', kind: 'coin' };
    return null;
  }

  function drawPlayer() {
    drawLibraryPerson(ctx, player.x, player.y, { personalityKey: 'shyStudent', scale: 1 });
    const badge = currentPlayerBadge();
    if (badge) {
      if (badge.kind === 'book') drawRoundRect(ctx, player.x + 16, player.y - 86, 12, 16, 2, badge.color);
      else drawStar(ctx, player.x + 20, player.y - 82, 7, 3, badge.color);
    }
  }

  function drawSanityBar() {
    const x = 14;
    const y = 14;
    const width = 130;
    const height = 16;
    const sanityPercent = Math.round(shiftState ? shiftState.sanity : SANITY_MAX);
    const frac = Math.max(0, Math.min(1, sanityPercent / SANITY_MAX));
    const fillColor = sanityPercent > 50 ? '#7fd68a' : (sanityPercent > 20 ? '#e0a83a' : '#e06a5b');

    ctx.save();
    drawRoundRect(ctx, x, y, width, height, 8, 'rgba(255,251,246,0.85)');
    drawRoundRect(ctx, x + 2, y + 2, Math.max(0, (width - 4) * frac), height - 4, 6, fillColor);
    ctx.strokeStyle = 'rgba(58,42,42,0.3)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, 8);
    ctx.stroke();

    ctx.fillStyle = LABEL_TEXT_COLOR;
    // Doc's Visual Direction: the Sanity bar's label uses the site's own
    // display font (Caprasimo), not a generic sans-serif — but a canvas
    // draw issued before a self-hosted @font-face resolves silently falls
    // back with no error, so this only switches to the Caprasimo family
    // once `document.fonts.ready` has resolved (see `sanityFontReady`
    // above); every later frame in this 60fps loop retries the draw, so a
    // missed first frame or two self-corrects immediately.
    ctx.font = sanityFontReady ? 'bold 11px "Caprasimo", sans-serif' : 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`Sanity ${sanityPercent}%`, x + width / 2, y + height / 2 + 0.5);
    ctx.restore();
  }

  function drawLibraryMoodBar() {
    const x = 14;
    const y = 36;
    const width = 130;
    const height = 16;
    const moodPercent = Math.round(shiftState ? shiftState.libraryMood : LIBRARY_MOOD_MAX);
    const frac = Math.max(0, Math.min(1, moodPercent / LIBRARY_MOOD_MAX));
    const fillColor = moodPercent > 50 ? '#7fb0d6' : (moodPercent > 20 ? '#e0a83a' : '#e06a5b');

    ctx.save();
    drawRoundRect(ctx, x, y, width, height, 8, 'rgba(255,251,246,0.85)');
    drawRoundRect(ctx, x + 2, y + 2, Math.max(0, (width - 4) * frac), height - 4, 6, fillColor);
    ctx.strokeStyle = 'rgba(58,42,42,0.3)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, 8);
    ctx.stroke();
    ctx.fillStyle = LABEL_TEXT_COLOR;
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`Mood ${moodPercent}%`, x + width / 2, y + height / 2 + 0.5);
    ctx.restore();
  }

  // -- Overlay rendering ------------------------------------------------------

  function drawOverlayBackdrop() {
    ctx.fillStyle = 'rgba(30,20,20,0.55)';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  }

  function drawSkillCheckOverlay() {
    drawOverlayBackdrop();
    const zone = skillCheckSuccessZone();
    const barX = 130;
    const barW = CANVAS_WIDTH - 260;
    const barY = CANVAS_HEIGHT / 2 - 10;
    const barH = 24;

    ctx.fillStyle = '#fdf8ee';
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(overlay.context === 'shelf' ? 'Shelf Skill-Check' : 'Checkout Skill-Check', CANVAS_WIDTH / 2, barY - 40);
    ctx.font = '13px sans-serif';
    ctx.fillText('Click, tap, or press Space/Enter to stop the marker in the gold zone', CANVAS_WIDTH / 2, barY - 16);

    drawRoundRect(ctx, barX, barY, barW, barH, 10, 'rgba(255,251,246,0.9)');
    drawRoundRect(ctx, barX + zone.start * barW, barY, zone.width * barW, barH, 6, '#f2d98a');
    ctx.strokeStyle = 'rgba(58,42,42,0.4)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(barX, barY, barW, barH, 10);
    ctx.stroke();

    const markerX = barX + overlay.gaugePosition * barW;
    ctx.fillStyle = '#c65f7c';
    ctx.beginPath();
    ctx.moveTo(markerX, barY - 6);
    ctx.lineTo(markerX - 7, barY - 18);
    ctx.lineTo(markerX + 7, barY - 18);
    ctx.closePath();
    ctx.fill();
  }

  function drawCoinIcon(x, y, isBill) {
    if (isBill) {
      drawRoundRect(ctx, x - 12, y - 7, 24, 14, 2, '#7fb06a');
      ctx.strokeStyle = '#4a6a3a';
      ctx.lineWidth = 1;
      ctx.strokeRect(x - 9, y - 4, 18, 8);
    } else {
      ctx.fillStyle = '#f2d98a';
      ctx.beginPath();
      ctx.arc(x, y, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#c9a13a';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  function drawDecoyIcon(x, y, kind) {
    ctx.strokeStyle = '#8a8a8a';
    ctx.fillStyle = '#b8b8b8';
    ctx.lineWidth = 2;
    if (kind === 'paperclip') {
      ctx.beginPath();
      ctx.ellipse(x, y, 4, 9, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (kind === 'pen') {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(0.5);
      drawRoundRect(ctx, -3, -12, 6, 24, 2, '#6a8ab0');
      ctx.restore();
    } else if (kind === 'key') {
      ctx.beginPath();
      ctx.arc(x - 4, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(x, y - 2, 12, 4);
    } else if (kind === 'stamp') {
      drawRoundRect(ctx, x - 8, y - 6, 16, 12, 2, '#c98a8a');
    } else {
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawCoinHuntOverlay() {
    drawOverlayBackdrop();
    drawRoundRect(ctx, 90, 140, CANVAS_WIDTH - 180, 360, 16, '#fdf3df');
    ctx.fillStyle = LABEL_TEXT_COLOR;
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Coin Hunt — find every coin and bill', CANVAS_WIDTH / 2, 170);
    for (const item of overlay.items) {
      if (item.found) continue;
      drawCoinIcon(item.x, item.y, item.isBill);
    }
    const foundCount = overlay.items.filter((i) => i.found).length;
    ctx.font = '14px sans-serif';
    ctx.fillText(`${foundCount} / ${overlay.items.length} found`, CANVAS_WIDTH / 2, 470);
  }

  function drawFinesSortOverlay() {
    drawOverlayBackdrop();
    drawRoundRect(ctx, 90, 140, CANVAS_WIDTH - 180, 360, 16, '#efe6d8');
    ctx.fillStyle = LABEL_TEXT_COLOR;
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Fines Sort — find every coin and Gard bill', CANVAS_WIDTH / 2, 170);
    for (const item of overlay.items) {
      if (item.found) continue;
      if (item.real) drawCoinIcon(item.x, item.y, item.isBill);
      else drawDecoyIcon(item.x, item.y, item.decoyKind);
    }
    const foundReal = overlay.items.filter((i) => i.real && i.found).length;
    const totalReal = overlay.items.filter((i) => i.real).length;
    ctx.font = '14px sans-serif';
    ctx.fillText(`${foundReal} / ${totalReal} found`, CANVAS_WIDTH / 2, 470);
  }

  function drawFindTheBookOverlay() {
    drawOverlayBackdrop();
    drawRoundRect(ctx, 90, 140, CANVAS_WIDTH - 180, 360, 16, '#f2e9da');
    ctx.fillStyle = LABEL_TEXT_COLOR;
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'center';
    const genre = findGenre(overlay.genreId);
    ctx.fillText(`Find the requested book (${genre ? genre.name : ''})`, CANVAS_WIDTH / 2, 170);
    for (const item of overlay.items) {
      drawRoundRect(ctx, item.x - 20, item.y - 14, 40, 28, 3, item.color);
      ctx.fillStyle = '#fdf8ee';
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'center';
      const words = item.title.split(' ');
      ctx.fillText(words.slice(0, 2).join(' '), item.x, item.y - 1);
      if (words.length > 2) ctx.fillText(words.slice(2, 4).join(' '), item.x, item.y + 9);
    }
  }

  function drawKarenOverlay() {
    drawOverlayBackdrop();
    drawLibraryPerson(ctx, CANVAS_WIDTH / 2, 340, { personalityKey: 'karen', scale: 1.3, angryTint: true });
    drawRoundRect(ctx, 130, 150, CANVAS_WIDTH - 260, 90, 12, '#fdf8ee');
    ctx.fillStyle = LABEL_TEXT_COLOR;
    ctx.font = 'bold 15px sans-serif';
    ctx.textAlign = 'center';
    wrapText(KAREN_LINE, CANVAS_WIDTH / 2, 185, CANVAS_WIDTH - 300, 20);
    ctx.font = '12px sans-serif';
    ctx.fillText(`${Math.max(0, Math.ceil(shiftState.karen.timerSecondsRemaining))}s to respond`, CANVAS_WIDTH / 2, 225);

    const buttons = karenButtonRects();
    drawRoundRect(ctx, buttons.collect.x, buttons.collect.y, buttons.collect.w, buttons.collect.h, 8, '#7fb0d6');
    drawRoundRect(ctx, buttons.slide.x, buttons.slide.y, buttons.slide.w, buttons.slide.h, 8, '#e0a83a');
    ctx.fillStyle = '#fdf8ee';
    ctx.font = 'bold 13px sans-serif';
    ctx.fillText('Collect the Fine', buttons.collect.x + buttons.collect.w / 2, buttons.collect.y + buttons.collect.h / 2 + 4);
    ctx.fillText('Let It Slide', buttons.slide.x + buttons.slide.w / 2, buttons.slide.y + buttons.slide.h / 2 + 4);
  }

  function wrapText(text, cx, y, maxWidth, lineHeight) {
    const words = text.split(' ');
    let line = '';
    let lineY = y;
    for (const word of words) {
      const testLine = line ? `${line} ${word}` : word;
      if (ctx.measureText(testLine).width > maxWidth && line) {
        ctx.fillText(line, cx, lineY);
        line = word;
        lineY += lineHeight;
      } else {
        line = testLine;
      }
    }
    if (line) ctx.fillText(line, cx, lineY);
  }

  function drawOverlay() {
    if (!overlay) return;
    if (overlay.kind === 'skill-check') drawSkillCheckOverlay();
    else if (overlay.kind === 'coin-hunt') drawCoinHuntOverlay();
    else if (overlay.kind === 'fines-sort') drawFinesSortOverlay();
    else if (overlay.kind === 'find-the-book') drawFindTheBookOverlay();
    else if (overlay.kind === 'karen') drawKarenOverlay();
  }

  function render() {
    drawFloor();
    stationsOnFloor(stations, currentFloor).forEach((station) => drawStation(station));
    drawReturnCartBooks();
    drawFrontDeskSlots();
    drawPlayer();
    drawSanityBar();
    drawLibraryMoodBar();
    drawOverlay();
  }

  // -- Game loop --------------------------------------------------------------

  function loop(timestamp) {
    if (!running || paused) { rafHandle = null; return; }
    if (lastTimestamp === null) lastTimestamp = timestamp;
    const deltaSeconds = Math.min(0.1, (timestamp - lastTimestamp) / 1000);
    lastTimestamp = timestamp;

    if (!overlay) updatePlayer(deltaSeconds);

    const beforeBorrowStage = shiftState.activeBorrow?.stage;
    const beforeKarenActive = shiftState.karen.active;
    shiftState = tick(shiftState, deltaSeconds);

    if (beforeBorrowStage === 'searching' && !shiftState.activeBorrow && overlay?.kind === 'find-the-book') {
      overlay = null;
      showToast('They gave up waiting…');
    }
    if (beforeKarenActive && !shiftState.karen.active && overlay?.kind === 'karen') {
      overlay = null;
      showToast('Karen stormed off without paying.');
    }

    if (shiftState.phase === 'playing') processScheduledEvents();

    updateOverlay(deltaSeconds);
    updateHoverHint();
    renderHud();
    render();

    rafHandle = window.requestAnimationFrame(loop);
  }

  // -- Fullscreen ---------------------------------------------------------

  function requestFullscreen() {
    if (document.fullscreenElement) return;
    const container = document.getElementById('library-game-container');
    container.requestFullscreen?.().catch(() => {});
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

  // -- Event wiring ---------------------------------------------------------

  canvas.addEventListener('click', onCanvasClick);
  canvas.addEventListener('mousemove', onCanvasMouseMove);
  canvas.addEventListener('mouseleave', onCanvasMouseLeave);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('visibilitychange', onVisibilityChange);
  elements.fullscreenButton.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  elements.floorButton?.addEventListener('click', () => switchFloor(currentFloor === FLOOR_1 ? FLOOR_2 : FLOOR_1));

  elements.startScreen.shiftButton.addEventListener('click', startShift);
  elements.paycheckScreen.nextShiftButton.addEventListener('click', startShift);
  elements.paycheckScreen.newMonthButton.addEventListener('click', startNewMonth);
  if (elements.paycheckScreen.submitButton) {
    elements.paycheckScreen.submitButton.addEventListener('click', () => {
      // Same real bug fixed in cooking-game.js/fishing-game.js's round-over
      // submit handlers: disabling a submit <button> synchronously in its
      // own click handler suppresses the form's default submit action.
      window.setTimeout(() => { elements.paycheckScreen.submitButton.disabled = true; }, 0);
    });
  }

  function teardown() {
    running = false;
    if (rafHandle !== null) {
      window.cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
    if (toastTimeoutHandle) window.clearTimeout(toastTimeoutHandle);
    canvas.removeEventListener('click', onCanvasClick);
    canvas.removeEventListener('mousemove', onCanvasMouseMove);
    canvas.removeEventListener('mouseleave', onCanvasMouseLeave);
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    document.body.removeEventListener('htmx:beforeSwap', teardown);
    if (teardownActiveInstance === teardown) teardownActiveInstance = null;
  }

  document.body.addEventListener('htmx:beforeSwap', (e) => {
    if (e.target && e.target.id === 'main-content') teardown();
  });

  teardownActiveInstance = teardown;

  // Test-only debug hooks for e2e/library-game.spec.js — real-time shift
  // clocks here run 600/480/360 real seconds (doc's Business Rules,
  // deliberately much slower than Kitchen Shift's), far too slow to wait
  // out in a browser test. These expose exact canvas-space coordinates
  // (front-desk slots, Return Cart books, overlay item positions, the
  // skill-check gauge) so Playwright can drive the SAME real click path a
  // player uses, converted to page coordinates via the canvas's own
  // getBoundingClientRect — not a bypass of the UI, same spirit as Kitchen
  // Shift's own test-hooks comment.
  if (typeof window !== 'undefined') {
    window.__libraryGameTestHooks = {
      getPlayerPosition: () => ({ ...player }),
      isPlayerMoving: () => moveTarget !== null,
      getCurrentFloor: () => currentFloor,
      getStations: () => stations.map((s) => ({ ...s })),
      getFrontDeskSlots: () => frontDeskSlots(),
      getReturnCartSlots: () => returnCartSlots(),
      getOverlay: () => (overlay ? JSON.parse(JSON.stringify(overlay)) : null),
      getShiftState: () => shiftState,
      isBossOfficeReady: () => shiftState && isBossOfficeReady(shiftState),
      spawnBookNow(isCoinHunt) { if (shiftState?.phase === 'playing') spawnBook(Boolean(isCoinHunt)); },
      spawnFineNow(amount) { if (shiftState?.phase === 'playing') spawnFine(amount); },
      spawnBorrowNow() { if (shiftState?.phase === 'playing') spawnBorrow(); },
      makeKarenAvailableNow() { karenAvailable = true; },
      forceKarenShiftNow() {
        // Karen's real shift is a deterministic hash of the save's seed
        // (rules.js's karenShiftForSeed) — this overrides
        // shiftState.karen.shiftNumber to the current shift directly so a
        // test doesn't need to hunt for (or reseed to land on) her actual
        // randomized shift.
        if (!shiftState) return;
        shiftState = { ...shiftState, karen: { ...shiftState.karen, shiftNumber: currentShiftNumber } };
        karenAvailable = true;
      },
      getActiveBorrowInfo() {
        const bookId = shiftState?.activeBorrow?.bookId;
        return bookId ? { bookId, ...bookCatalog.get(bookId) } : null;
      },
      setSkillCheckGauge(pos) { if (overlay?.kind === 'skill-check') overlay.gaugePosition = pos; },
      skipToClosing() {
        if (!running || !shiftState || shiftState.phase !== 'playing') return;
        shiftState = tick(shiftState, shiftState.totalClockSeconds + 1);
        shiftState = tick(shiftState, 9999);
        overlay = null;
      },
      collectPaycheck() {
        if (!shiftState || !isBossOfficeReady(shiftState)) return;
        shiftState = enterBossOffice(shiftState);
        endShift();
      },
    };
  }

  renderStartScreen();

  return teardown;
}

let teardownActiveInstance = null;

// ---------------------------------------------------------------------------
// Auto-bootstrap (browser only)
// ---------------------------------------------------------------------------

function bootstrap() {
  const canvas = document.getElementById('library-canvas');
  if (!canvas) return; // this page isn't mounted — no-op, same convention as cooking-game.js

  const elements = {
    hud: {
      shift: document.getElementById('library-hud-shift'),
      clock: document.getElementById('library-hud-clock'),
      status: document.getElementById('library-hud-status'),
    },
    hoverHint: document.getElementById('library-interact-hint'),
    toast: document.getElementById('library-toast'),
    fullscreenButton: document.getElementById('library-fullscreen-button'),
    floorButton: document.getElementById('library-floor-button'),
    startScreen: {
      root: document.getElementById('library-start-screen'),
      shiftButton: document.getElementById('library-start-shift-button'),
    },
    paycheckScreen: {
      root: document.getElementById('library-paycheck-screen'),
      title: document.getElementById('library-paycheck-title'),
      outcome: document.getElementById('library-paycheck-outcome'),
      shiftTotal: document.getElementById('library-paycheck-shift-total'),
      monthTotal: document.getElementById('library-paycheck-month-total'),
      finalBlock: document.getElementById('library-final-paycheck-block'),
      earningsInput: document.getElementById('library-paycheck-earnings-input'),
      shiftsInput: document.getElementById('library-paycheck-shifts-input'),
      submitButton: document.getElementById('library-paycheck-submit-button'),
      nextShiftButton: document.getElementById('library-paycheck-next-shift-button'),
      newMonthButton: document.getElementById('library-paycheck-new-month-button'),
    },
  };

  init(canvas, elements);
}

if (typeof document !== 'undefined') {
  bootstrap();

  // A `<script type="module">`'s top-level code runs at most once per
  // resolved URL for the whole document's lifetime — so a revisit via HTMX
  // (navigate away from /library-game and back) recreates #library-canvas
  // but does NOT re-execute this file, leaving the freshly swapped-in start
  // screen visually intact but completely inert. Same real, previously-
  // shipped bug documented in cooking-game.js's own bootstrap() comment
  // (see that file for the full writeup) — fixed the identical way here:
  // document.body survives every #main-content swap, so this listener,
  // registered once during this file's one-and-only execution, re-runs
  // bootstrap() on every later swap too. init()'s own
  // teardown-previous-instance guard makes calling bootstrap() again safe
  // even when this listener and the direct call above both fire for the
  // same navigation.
  document.body.addEventListener('htmx:afterSwap', (e) => {
    if (e.target && e.target.id === 'main-content') bootstrap();
  });
}
