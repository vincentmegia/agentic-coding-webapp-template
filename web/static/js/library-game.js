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
  finesStartShiftForSeed,
  FIRST_BORROW_ARRIVAL_SECONDS,
  queueWaitSecondsForShift,
  RATING_MAX,
  RATING_PENALTY_PER_WALKOUT,
  paycheckMultiplierForRating,
  READING_MOOD_RESTORE,
  hallucinationIntensity,
  shakyHandsZoneScale,
  shakyHandsSweepMultiplier,
  BOOK_DROP_CHANCE_PER_SECOND,
  HALLUCINATION_START_SANITY,
  hallucinationPayMultiplier,
  moodPayMultiplier,
  COMPLAINT_GARD,
  SHELVED_BOOK_TIP_GARD,
  UNSHELVED_BOOK_PENALTY_GARD,
  MESSY_CART_THRESHOLD,
  READING_PAGES,
  READING_SECONDS_PER_PAGE,
  TILL_DENOMINATIONS,
  tillCountResult,
  coffeePourTargetBand,
  gradeCoffeePour,
  COFFEE_POUR_SECONDS_TO_BRIM,
  COFFEE_PERFECT_TIP_GARD,
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
  finishReading,
  dropCarriedBook,
  startleFromHallucination,
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
import { READING_STORIES } from './library/stories.js';
import {
  defaultFacingTowardCenter,
  projectScene,
  findInteractTarget,
  turnFacing,
  stepForward,
  MOVE_SPEED_PIXELS_PER_SECOND,
} from './library/first-person.js';

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

/** Truncates `text` (adding "…") to fit within `maxWidth` at `font`, measured via the same canvas context text will render in — used wherever a label chip's width must stay bounded (e.g. front-desk slots sitting only 46px apart) rather than auto-sizing to a title of arbitrary length. */
function truncateForChip(ctx, text, maxWidth, font) {
  ctx.save();
  ctx.font = font;
  if (ctx.measureText(text).width <= maxWidth) {
    ctx.restore();
    return text;
  }
  let truncated = text;
  while (truncated.length > 1 && ctx.measureText(`${truncated}…`).width > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  ctx.restore();
  return `${truncated}…`;
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
    bodyColor: '#7d8570', pantsColor: '#5a5f4f', headColor: '#c68642', hairColor: '#5a5248',
    eyeColor: '#3a2a2a', eyeShape: 'narrow', browAngle: -0.8, mouthCurve: -1.4, blush: false,
    hairStyle: 'receding', outfit: 'cardigan', glasses: true, shoeColor: '#4a3a32',
  },
  shyStudent: {
    label: 'Shy Student',
    bodyColor: '#a7c4d1', pantsColor: '#5c7480', headColor: '#ffdbac', hairColor: '#3a2a20',
    eyeColor: '#2a2a3a', eyeShape: 'roundSmall', browAngle: 0.15, mouthCurve: 0.3, blush: true,
    hairStyle: 'bangs', outfit: 'collar', glasses: false, shoeColor: '#3a3440',
  },
  cheerfulKid: {
    label: 'Cheerful Kid',
    bodyColor: '#f2b6c6', pantsColor: '#e0899f', headColor: '#8d5524', hairColor: '#2a1a10',
    eyeColor: '#2a2a2a', eyeShape: 'bigRound', browAngle: 0.7, mouthCurve: 1.6, blush: true,
    hairStyle: 'pigtails', outfit: 'overalls', glasses: false, shoeColor: '#c65f7c',
  },
  // v2.12 — more distinct patron designs (user: "make the characters
  // have different designs"), plus the player's own librarian look.
  librarian: {
    label: 'Coral James',
    bodyColor: '#f3ead8', pantsColor: '#4a4a5a', headColor: '#d9a06b', hairColor: '#7a3b2e', accentColor: '#5f8a6a',
    eyeColor: '#2a2a2a', eyeShape: 'bigRound', browAngle: 0.3, mouthCurve: 1.1, blush: true,
    hairStyle: 'bun', outfit: 'vestLanyard', glasses: true, shoeColor: '#5a3a2a',
  },
  teen: {
    label: 'Teen',
    bodyColor: '#6a7bd0', pantsColor: '#3a3f5a', headColor: '#f1c27d', hairColor: '#1e1e28', accentColor: '#4f5db0',
    eyeColor: '#2a2a3a', eyeShape: 'narrow', browAngle: 0, mouthCurve: 0.2, blush: false,
    hairStyle: 'spiky', outfit: 'hoodie', accessory: 'headphones', shoeColor: '#e8e8e8',
  },
  grandma: {
    label: 'Grandma',
    bodyColor: '#b48ab8', pantsColor: '#6a5a70', headColor: '#f5d6c0', hairColor: '#e6e2dc', accentColor: '#e8b95a',
    eyeColor: '#3a2a2a', eyeShape: 'roundSmall', browAngle: 0.4, mouthCurve: 1.2, blush: true,
    hairStyle: 'bun', outfit: 'shawl', glasses: true, shoeColor: '#6a4a3a',
  },
  businessman: {
    label: 'Businessman',
    bodyColor: '#3f4a5c', pantsColor: '#2e3644', headColor: '#a8754a', hairColor: '#2a2018', accentColor: '#c0392b',
    eyeColor: '#2a2a2a', eyeShape: 'narrow', browAngle: -0.3, mouthCurve: -0.3, blush: false,
    hairStyle: 'sidePart', outfit: 'suitTie', shoeColor: '#1e1e1e',
  },
  artist: {
    label: 'Artist',
    bodyColor: '#e3a45a', pantsColor: '#e3a45a', headColor: '#ffdbac', hairColor: '#c0603a', accentColor: '#2f4858',
    eyeColor: '#2a3a2a', eyeShape: 'bigRound', browAngle: 0.5, mouthCurve: 0.9, blush: true,
    hairStyle: 'long', outfit: 'dress', accessory: 'beret', shoeColor: '#2f4858',
  },
  bearded: {
    label: 'Bearded Guy',
    bodyColor: '#b0453a', pantsColor: '#4a5a6a', headColor: '#e0ac69', hairColor: '#6a4a2a', accentColor: '#3a2a2a',
    eyeColor: '#2a2a2a', eyeShape: 'roundSmall', browAngle: -0.2, mouthCurve: 0.6, blush: false,
    hairStyle: 'beanie', outfit: 'flannel', accessory: 'beard', hatColor: '#3f7a6a', shoeColor: '#5a3a22',
  },
  curly: {
    label: 'Curly',
    bodyColor: '#fdf8ee', pantsColor: '#5a7aa0', headColor: '#6b4226', hairColor: '#1a120c', accentColor: '#e06a5b',
    eyeColor: '#1a1a1a', eyeShape: 'bigRound', browAngle: 0.4, mouthCurve: 1.4, blush: false,
    hairStyle: 'curly', outfit: 'stripes', shoeColor: '#e06a5b',
  },
  karen: {
    label: 'Karen',
    bodyColor: '#d94f4f', pantsColor: '#8f2f2f', headColor: '#e0ac69', hairColor: '#d6b23e',
    eyeColor: '#3a2a2a', eyeShape: 'narrow', browAngle: -1.3, mouthCurve: -0.6, blush: false,
    hairStyle: 'bob', outfit: 'blazer', glasses: false, shoeColor: '#2a2020',
  },
};

/** Every design a regular patron can have (not Karen, not the player). */
export const PATRON_PERSONALITY_KEYS = ['grumpyRegular', 'shyStudent', 'cheerfulKid', 'teen', 'grandma', 'businessman', 'artist', 'bearded', 'curly'];

/** The player character's name (v2.12) — shown on a name tag under the sprite. */
export const PLAYER_NAME = 'Coral James';

/**
 * Picks a patron's design from their id, so the same patron always looks
 * the same and different patrons spread across all designs (replacing the
 * old 3-design cycle by queue position).
 */
function personalityForId(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PATRON_PERSONALITY_KEYS[h % PATRON_PERSONALITY_KEYS.length];
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
 * Mixes a `#rrggbb` color toward black (negative `amount`) or white
 * (positive), for cheap one-step shading of the flat-color primitives
 * below without hand-picking a second hex per palette entry.
 */
function shadeColor(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const target = amount < 0 ? 0 : 255;
  const t = Math.abs(amount);
  const mix = (c) => Math.round(c + (target - c) * t);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** Hair that sits *behind* the head circle (drawn before it): bob volume, pigtails. */
function drawBackHair(ctx, x, headY, s, personality) {
  const color = personality.hairColor;
  if (personality.hairStyle === 'long') {
    drawRoundRect(ctx, x - 12 * s, headY - 6 * s, 24 * s, 22 * s, 6 * s, color);
  } else if (personality.hairStyle === 'curly') {
    ctx.fillStyle = color;
    for (let i = 0; i <= 8; i++) {
      const a = Math.PI * (0.95 + i * 0.1375);
      ctx.beginPath();
      ctx.arc(x + Math.cos(a) * 10.5 * s, headY - 1 * s + Math.sin(a) * 10.5 * s, 4.6 * s, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(x + dir * 11 * s, headY + 3 * s, 4 * s, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (personality.hairStyle === 'bun') {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, headY - 12.5 * s, 4.8 * s, 0, Math.PI * 2);
    ctx.fill();
  } else if (personality.hairStyle === 'bob') {
    drawRoundRect(ctx, x - 12.5 * s, headY - 6 * s, 25 * s, 15 * s, 5 * s, color);
  } else if (personality.hairStyle === 'pigtails') {
    ctx.fillStyle = color;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(x + dir * 12 * s, headY - 1 * s, 4.2 * s, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#f2d98a';
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(x + dir * 9.6 * s, headY - 3 * s, 1.6 * s, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Hair that sits *over* the head circle (drawn after it, before the face). */
function drawFrontHair(ctx, x, headY, s, personality) {
  const color = personality.hairColor;
  ctx.fillStyle = color;
  if (personality.hairStyle === 'receding') {
    // Thinning on top: side tufts above the ears plus a thin crown band.
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(x + dir * 8.6 * s, headY - 3 * s, 2.6 * s, 4.2 * s, dir * 0.25, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(x, headY - 1.5 * s, 10.3 * s, Math.PI * 1.08, Math.PI * 1.92);
    ctx.arc(x, headY + 1 * s, 10.3 * s, Math.PI * 1.85, Math.PI * 1.15, true);
    ctx.fill();
    return;
  }

  if (personality.hairStyle === 'beanie') {
    // Tufts of hair under a knit beanie with a fold-up band and a pompom.
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(x + dir * 8.8 * s, headY - 0.5 * s, 2.4 * s, 3.4 * s, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    const hat = personality.hatColor || '#3f7a6a';
    ctx.fillStyle = hat;
    ctx.beginPath();
    ctx.arc(x, headY - 3 * s, 11 * s, Math.PI, 0);
    ctx.fill();
    drawRoundRect(ctx, x - 11.5 * s, headY - 4.5 * s, 23 * s, 4 * s, 1.5 * s, shadeColor(hat, -0.2));
    ctx.fillStyle = shadeColor(hat, 0.35);
    ctx.beginPath();
    ctx.arc(x, headY - 14.5 * s, 2.8 * s, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  // Every other style starts from a full cap over the top of the head.
  ctx.beginPath();
  ctx.arc(x, headY - 2.5 * s, 10.6 * s, Math.PI, 0);
  ctx.fill();

  if (personality.hairStyle === 'bangs') {
    // A soft fringe of three scallops across the forehead, plus side locks.
    for (const dx of [-5.5, 0, 5.5]) {
      ctx.beginPath();
      ctx.ellipse(x + dx * s, headY - 3.6 * s, 3.6 * s, 2.4 * s, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const dir of [-1, 1]) {
      drawRoundRect(ctx, x + (dir < 0 ? -10.6 : 7.6) * s, headY - 3 * s, 3 * s, 8 * s, 1.5 * s, color);
    }
  } else if (personality.hairStyle === 'bob') {
    // The asymmetric swoop: a heavy side-part sweeping down over one brow.
    ctx.beginPath();
    ctx.moveTo(x - 10.6 * s, headY - 2.5 * s);
    ctx.quadraticCurveTo(x - 2 * s, headY - 6 * s, x + 9 * s, headY - 1 * s);
    ctx.lineTo(x + 10.6 * s, headY - 2.5 * s);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = shadeColor(color, -0.25);
    ctx.lineWidth = Math.max(1, 0.6 * s);
    ctx.beginPath();
    ctx.moveTo(x - 3 * s, headY - 12 * s);
    ctx.quadraticCurveTo(x - 1 * s, headY - 7 * s, x + 6 * s, headY - 4 * s);
    ctx.stroke();
  } else if (personality.hairStyle === 'spiky') {
    for (let i = 0; i < 5; i++) {
      const bx = x + (i - 2) * 4.4 * s;
      ctx.beginPath();
      ctx.moveTo(bx - 3 * s, headY - 9 * s);
      ctx.lineTo(bx + (i - 2) * 0.8 * s, headY - 16 * s);
      ctx.lineTo(bx + 3 * s, headY - 9 * s);
      ctx.closePath();
      ctx.fill();
    }
  } else if (personality.hairStyle === 'sidePart') {
    ctx.beginPath();
    ctx.moveTo(x - 10.6 * s, headY - 2.5 * s);
    ctx.quadraticCurveTo(x - 4 * s, headY - 7 * s, x + 6 * s, headY - 4 * s);
    ctx.lineTo(x + 10.6 * s, headY - 2.5 * s);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = shadeColor(personality.headColor, -0.15);
    ctx.lineWidth = Math.max(1, 0.6 * s);
    ctx.beginPath();
    ctx.moveTo(x - 4 * s, headY - 12.5 * s);
    ctx.lineTo(x - 3 * s, headY - 6.5 * s);
    ctx.stroke();
  } else if (personality.hairStyle === 'long') {
    for (const dx of [-5, 0, 5]) {
      ctx.beginPath();
      ctx.ellipse(x + dx * s, headY - 4 * s, 4 * s, 2.4 * s, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (personality.hairStyle === 'curly') {
    for (const dx of [-6, -2, 2, 6]) {
      ctx.beginPath();
      ctx.arc(x + dx * s, headY - 6 * s, 3.2 * s, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (personality.hairStyle === 'bun') {
    // Hair pulled back: a tidy cap with a center part.
    ctx.strokeStyle = shadeColor(color, -0.25);
    ctx.lineWidth = Math.max(1, 0.6 * s);
    ctx.beginPath();
    ctx.moveTo(x, headY - 12.5 * s);
    ctx.lineTo(x, headY - 6 * s);
    ctx.stroke();
  } else if (personality.hairStyle === 'pigtails') {
    // A short center part.
    ctx.strokeStyle = shadeColor(personality.headColor, -0.1);
    ctx.lineWidth = Math.max(1, 0.6 * s);
    ctx.beginPath();
    ctx.moveTo(x, headY - 12.5 * s);
    ctx.lineTo(x, headY - 8 * s);
    ctx.stroke();
  }
}

/** Torso-level clothing detail, drawn on top of the plain shirt shape. */
function drawOutfitDetail(ctx, x, y, s, personality) {
  const torsoTop = y - 26 * s;
  if (personality.outfit === 'cardigan') {
    // Open cardigan over a lighter shirt: a center V of shirt plus buttons.
    ctx.fillStyle = '#efe6d2';
    ctx.beginPath();
    ctx.moveTo(x - 4 * s, torsoTop + 2 * s);
    ctx.lineTo(x + 4 * s, torsoTop + 2 * s);
    ctx.lineTo(x + 1.5 * s, y - 5 * s);
    ctx.lineTo(x - 1.5 * s, y - 5 * s);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = shadeColor(personality.bodyColor, -0.35);
    for (const dy of [-18, -13, -8]) {
      ctx.beginPath();
      ctx.arc(x + 3.4 * s, y + dy * s, 0.9 * s, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (personality.outfit === 'collar') {
    // A white collar and a backpack strap across one shoulder.
    ctx.fillStyle = '#fdf8ee';
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(x, torsoTop + 4 * s);
      ctx.lineTo(x + dir * 5 * s, torsoTop + 1 * s);
      ctx.lineTo(x + dir * 4 * s, torsoTop + 5.5 * s);
      ctx.closePath();
      ctx.fill();
    }
    drawRoundRect(ctx, x + 5 * s, torsoTop + 1 * s, 2.6 * s, 19 * s, 1.2 * s, '#c47f4e');
  } else if (personality.outfit === 'overalls') {
    // Overall bib + straps in the pants color, with two gold buttons.
    const bib = personality.pantsColor;
    drawRoundRect(ctx, x - 6 * s, y - 16 * s, 12 * s, 12 * s, 2.5 * s, bib);
    for (const dir of [-1, 1]) {
      drawRoundRect(ctx, x + (dir < 0 ? -7 : 4.6) * s, torsoTop + 1 * s, 2.4 * s, 11 * s, 1 * s, bib);
    }
    ctx.fillStyle = '#f2d98a';
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(x + dir * 4.4 * s, y - 14 * s, 1 * s, 0, Math.PI * 2);
      ctx.fill();
    }
    drawRoundRect(ctx, x - 2.5 * s, y - 12 * s, 5 * s, 3.5 * s, 1 * s, shadeColor(bib, -0.15));
  } else if (personality.outfit === 'vestLanyard') {
    // Sweater vest over a cream shirt, plus a lanyard with a name badge.
    const vest = personality.accentColor;
    ctx.fillStyle = vest;
    ctx.beginPath();
    ctx.moveTo(x - 10 * s, torsoTop + 2 * s);
    ctx.lineTo(x - 3.5 * s, torsoTop + 2 * s);
    ctx.lineTo(x, torsoTop + 9 * s);
    ctx.lineTo(x + 3.5 * s, torsoTop + 2 * s);
    ctx.lineTo(x + 10 * s, torsoTop + 2 * s);
    ctx.lineTo(x + 10 * s, y - 6 * s);
    ctx.lineTo(x - 10 * s, y - 6 * s);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#c0392b';
    ctx.lineWidth = Math.max(1, 0.7 * s);
    ctx.beginPath();
    ctx.moveTo(x - 3.5 * s, torsoTop + 1 * s);
    ctx.lineTo(x - 1 * s, y - 14 * s);
    ctx.moveTo(x + 3.5 * s, torsoTop + 1 * s);
    ctx.lineTo(x + 1 * s, y - 14 * s);
    ctx.stroke();
    drawRoundRect(ctx, x - 3 * s, y - 14.5 * s, 6 * s, 7 * s, 1 * s, '#fdf8ee');
    ctx.fillStyle = '#5b6cc0';
    ctx.fillRect(x - 2 * s, y - 13.5 * s, 4 * s, 1.4 * s);
  } else if (personality.outfit === 'hoodie') {
    // Hood bunched behind the neck, kangaroo pocket, drawstrings.
    const dark = personality.accentColor;
    drawRoundRect(ctx, x - 8 * s, torsoTop - 1 * s, 16 * s, 5 * s, 2.5 * s, dark);
    drawRoundRect(ctx, x - 6.5 * s, y - 13 * s, 13 * s, 6 * s, 2 * s, dark);
    ctx.strokeStyle = '#fdf8ee';
    ctx.lineWidth = Math.max(1, 0.6 * s);
    for (const dx of [-2, 2]) {
      ctx.beginPath();
      ctx.moveTo(x + dx * s, torsoTop + 3 * s);
      ctx.lineTo(x + dx * s, torsoTop + 9 * s);
      ctx.stroke();
    }
  } else if (personality.outfit === 'shawl') {
    // A knitted shawl draped over the shoulders, pinned with a brooch.
    ctx.fillStyle = personality.accentColor;
    ctx.beginPath();
    ctx.moveTo(x - 12 * s, torsoTop + 1 * s);
    ctx.lineTo(x + 12 * s, torsoTop + 1 * s);
    ctx.lineTo(x, y - 9 * s);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#c0392b';
    ctx.beginPath();
    ctx.arc(x, torsoTop + 5 * s, 1.5 * s, 0, Math.PI * 2);
    ctx.fill();
  } else if (personality.outfit === 'suitTie') {
    // Suit jacket with a white shirt V and a tie.
    ctx.fillStyle = '#fdf8ee';
    ctx.beginPath();
    ctx.moveTo(x - 4 * s, torsoTop + 1 * s);
    ctx.lineTo(x + 4 * s, torsoTop + 1 * s);
    ctx.lineTo(x, y - 9 * s);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = personality.accentColor;
    ctx.beginPath();
    ctx.moveTo(x - 1.4 * s, torsoTop + 2 * s);
    ctx.lineTo(x + 1.4 * s, torsoTop + 2 * s);
    ctx.lineTo(x + 1.8 * s, y - 11 * s);
    ctx.lineTo(x, y - 9 * s);
    ctx.lineTo(x - 1.8 * s, y - 11 * s);
    ctx.closePath();
    ctx.fill();
  } else if (personality.outfit === 'dress') {
    // A flared skirt over the upper legs, with a little collar.
    ctx.fillStyle = shadeColor(personality.bodyColor, -0.08);
    ctx.beginPath();
    ctx.moveTo(x - 10 * s, y - 7 * s);
    ctx.lineTo(x + 10 * s, y - 7 * s);
    ctx.lineTo(x + 13 * s, y + 1 * s);
    ctx.lineTo(x - 13 * s, y + 1 * s);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#fdf8ee';
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(x + dir * 2.5 * s, torsoTop + 2 * s, 2.5 * s, 0, Math.PI);
      ctx.fill();
    }
  } else if (personality.outfit === 'stripes') {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x - 11 * s, torsoTop, 22 * s, 21 * s, 6 * s);
    ctx.clip();
    ctx.fillStyle = personality.accentColor;
    for (let i = 0; i < 5; i++) ctx.fillRect(x - 11 * s, torsoTop + 3 * s + i * 4 * s, 22 * s, 1.8 * s);
    ctx.restore();
  } else if (personality.outfit === 'flannel') {
    // Plaid: darker vertical and horizontal bands.
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x - 11 * s, torsoTop, 22 * s, 21 * s, 6 * s);
    ctx.clip();
    ctx.fillStyle = 'rgba(40,20,20,0.28)';
    for (let i = -2; i <= 2; i++) ctx.fillRect(x + i * 5 * s - 0.9 * s, torsoTop, 1.8 * s, 21 * s);
    for (let j = 0; j < 4; j++) ctx.fillRect(x - 11 * s, torsoTop + 3 * s + j * 5 * s, 22 * s, 1.8 * s);
    ctx.restore();
    ctx.fillStyle = '#fdf8ee';
    for (const dy of [-18, -13, -8]) {
      ctx.beginPath();
      ctx.arc(x, y + dy * s, 0.8 * s, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (personality.outfit === 'blazer') {
    // Sharp lapels over a white blouse, plus a pearl necklace.
    ctx.fillStyle = '#fdf8ee';
    ctx.beginPath();
    ctx.moveTo(x - 4.5 * s, torsoTop + 1 * s);
    ctx.lineTo(x + 4.5 * s, torsoTop + 1 * s);
    ctx.lineTo(x, y - 10 * s);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = shadeColor(personality.bodyColor, -0.25);
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(x + dir * 4.5 * s, torsoTop + 1 * s);
      ctx.lineTo(x + dir * 1 * s, y - 11 * s);
      ctx.lineTo(x + dir * 7 * s, torsoTop + 6 * s);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = '#fdf8ee';
    for (const dx of [-3, -1.5, 0, 1.5, 3]) {
      ctx.beginPath();
      ctx.arc(x + dx * s, torsoTop + 3 * s + Math.abs(dx) * -0.5 * s + 1.5 * s, 0.8 * s, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawGlasses(ctx, x, headY, s) {
  const eyeY = headY + 1 * s;
  ctx.strokeStyle = '#3a2a2a';
  ctx.lineWidth = Math.max(1, 0.7 * s);
  for (const dir of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(x + dir * 3.9 * s, eyeY, 3.1 * s, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(x - 0.8 * s, eyeY - 0.5 * s);
  ctx.lineTo(x + 0.8 * s, eyeY - 0.5 * s);
  ctx.stroke();
}

/**
 * The shared big-character draw helper (doc's `drawLibraryPerson`): body +
 * head + hair + a personality-parameterized face. `angryTint` is Karen's
 * "reddish face tint during her scripted outburst" (doc's Visual
 * Direction), passed independently of her base template so it only applies
 * while her event is actually active.
 *
 * v2 art pass: proportions follow Kitchen Shift's `drawPixelPerson` (the
 * user: the library bodies "feel ugly" next to the kitchen's) — a wide,
 * rounded torso the head sits directly on (no separate neck to read as a
 * gap), short arms peeking out either side with hands, short legs with
 * shoes, and a soft ground shadow. Each personality also gets its own
 * hairstyle and outfit detail instead of differing by palette alone.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {{personalityKey?: string, scale?: number, angryTint?: boolean}} [opts]
 */
export function drawLibraryPerson(ctx, x, y, opts = {}) {
  const base = PERSONALITY_TEMPLATES[opts.personalityKey] || PERSONALITY_TEMPLATES.shyStudent;
  // v2.16 `opts.stress` (0..1, the player's low-Sanity stress): worried
  // brows, a growing frown and smaller pupils, plus eye bags and a sweat
  // drop drawn after the face (user: "when sanity drops below 25 make the
  // facial expression change").
  const stress = Math.max(0, Math.min(1, opts.stress ?? 0));
  const personality = stress > 0
    ? {
      ...base,
      browAngle: base.browAngle + (1.1 - base.browAngle) * stress,
      mouthCurve: base.mouthCurve + (-1.3 - base.mouthCurve) * stress,
      eyeShape: stress > 0.6 ? 'roundSmall' : base.eyeShape,
      blush: base.blush && stress < 0.5,
    }
    : base;
  const s = (opts.scale ?? 1) * LIBRARY_PERSON_SCALE;
  const pants = personality.pantsColor || personality.bodyColor;
  const headY = y - 34 * s;

  // Ground shadow.
  ctx.fillStyle = 'rgba(58,42,42,0.14)';
  ctx.beginPath();
  ctx.ellipse(x, y + 9 * s, 11 * s, 2.6 * s, 0, 0, Math.PI * 2);
  ctx.fill();

  // Legs + shoes.
  drawRoundRect(ctx, x - 7 * s, y - 8 * s, 6 * s, 14 * s, 2 * s, pants);
  drawRoundRect(ctx, x + 1 * s, y - 8 * s, 6 * s, 14 * s, 2 * s, pants);
  const shoe = personality.shoeColor || '#4a3a32';
  drawRoundRect(ctx, x - 8 * s, y + 4 * s, 7.5 * s, 4.5 * s, 2 * s, shoe);
  drawRoundRect(ctx, x + 0.5 * s, y + 4 * s, 7.5 * s, 4.5 * s, 2 * s, shoe);

  // Arms (sleeves) peek ~3 units out past the torso on each side, with hands.
  const sleeve = shadeColor(personality.bodyColor, -0.08);
  drawRoundRect(ctx, x - 14 * s, y - 23 * s, 6 * s, 15 * s, 3 * s, sleeve);
  drawRoundRect(ctx, x + 8 * s, y - 23 * s, 6 * s, 15 * s, 3 * s, sleeve);
  ctx.fillStyle = personality.headColor;
  for (const dir of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(x + dir * 11 * s, y - 8 * s, 2.7 * s, 0, Math.PI * 2);
    ctx.fill();
  }

  // Torso — its top tucks up under the head circle, so the head always
  // reads as attached (v1.5's floating-head report can't recur: there is
  // no neck seam at all any more).
  drawRoundRect(ctx, x - 11 * s, y - 26 * s, 22 * s, 21 * s, 6 * s, personality.bodyColor);
  drawOutfitDetail(ctx, x, y, s, personality);

  drawBackHair(ctx, x, headY, s, personality);

  ctx.fillStyle = personality.headColor;
  ctx.beginPath();
  ctx.arc(x, headY, 10 * s, 0, Math.PI * 2);
  ctx.fill();
  // Ears.
  for (const dir of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(x + dir * 9.8 * s, headY + 1.5 * s, 2 * s, 0, Math.PI * 2);
    ctx.fill();
  }

  if (personality.hairColor) drawFrontHair(ctx, x, headY, s, personality);

  drawLibraryFace(ctx, x, y, s, personality, Boolean(opts.angryTint));
  if (personality.glasses) drawGlasses(ctx, x, headY, s);
  if (personality.accessory) drawAccessory(ctx, x, headY, s, personality);
  if (stress > 0) drawStressMarks(ctx, x, headY, s, stress);
}

/** Eye bags and a sweat drop for a stressed (low-Sanity) face. */
function drawStressMarks(ctx, x, headY, s, stress) {
  ctx.strokeStyle = `rgba(90,60,110,${0.25 + 0.45 * stress})`;
  ctx.lineWidth = Math.max(1, 0.8 * s);
  for (const dir of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(x + dir * 3.7 * s, headY + 2.6 * s, 2 * s, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
  }
  // Sweat drop at the temple.
  ctx.fillStyle = 'rgba(140,200,240,0.9)';
  ctx.beginPath();
  const dx = x + 8.5 * s;
  const dy = headY - 3 * s;
  ctx.moveTo(dx, dy - 3 * s);
  ctx.quadraticCurveTo(dx + 2.4 * s, dy + 0.5 * s, dx, dy + 1.8 * s);
  ctx.quadraticCurveTo(dx - 2.4 * s, dy + 0.5 * s, dx, dy - 3 * s);
  ctx.fill();
  if (stress > 0.85) {
    // Frazzled: a couple of stray hairs sticking up.
    ctx.strokeStyle = 'rgba(58,42,42,0.7)';
    ctx.lineWidth = Math.max(1, 0.7 * s);
    for (const [ox, oy] of [[-3, -12], [2, -13], [6, -11]]) {
      ctx.beginPath();
      ctx.moveTo(x + ox * s, headY + oy * s);
      ctx.lineTo(x + (ox + 1.5) * s, headY + (oy - 3.5) * s);
      ctx.stroke();
    }
  }
}

/** Head accessories drawn last, over the face/hair (v2.12). */
function drawAccessory(ctx, x, headY, s, personality) {
  if (personality.accessory === 'beard') {
    // A full beard framing the jaw, with the mouth redrawn on top.
    ctx.fillStyle = personality.hairColor;
    ctx.beginPath();
    ctx.moveTo(x - 9.5 * s, headY + 1 * s);
    ctx.quadraticCurveTo(x - 9 * s, headY + 12 * s, x, headY + 12.5 * s);
    ctx.quadraticCurveTo(x + 9 * s, headY + 12 * s, x + 9.5 * s, headY + 1 * s);
    ctx.quadraticCurveTo(x + 5 * s, headY + 4 * s, x, headY + 3.5 * s);
    ctx.quadraticCurveTo(x - 5 * s, headY + 4 * s, x - 9.5 * s, headY + 1 * s);
    ctx.fill();
    ctx.strokeStyle = '#f5e6d8';
    ctx.lineWidth = Math.max(1, 0.8 * s);
    ctx.beginPath();
    ctx.arc(x, headY + 4.2 * s, 1.8 * s, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
  } else if (personality.accessory === 'headphones') {
    ctx.strokeStyle = '#2a2a33';
    ctx.lineWidth = Math.max(1.5, 1.8 * s);
    ctx.beginPath();
    ctx.arc(x, headY - 1 * s, 11.5 * s, Math.PI * 1.05, Math.PI * 1.95);
    ctx.stroke();
    for (const dir of [-1, 1]) drawRoundRect(ctx, x + (dir < 0 ? -14 : 9.5) * s, headY - 1.5 * s, 4.5 * s, 7 * s, 2 * s, '#e06a5b');
  } else if (personality.accessory === 'beret') {
    ctx.fillStyle = personality.accentColor;
    ctx.beginPath();
    ctx.ellipse(x + 2 * s, headY - 9.5 * s, 10.5 * s, 4 * s, -0.18, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(x + 1.5 * s, headY - 15 * s, 1.5 * s, 2.5 * s);
  }
}

// ---------------------------------------------------------------------------
// Book flavor titles (per-genre pools — decorative only, no gameplay stake)
// ---------------------------------------------------------------------------

const TITLE_POOLS = {
  mystery: ['The Silent Clue', 'Midnight Ledger', 'The Locked Room', 'A Quiet Alibi', 'The Missing Hour', 'Footprints in Ash', 'The Third Witness', 'Cold Case Coffee'],
  romance: ['Second Chances', 'The Letter Never Sent', 'Sunset in Gard', 'Two Left Umbrellas', 'A Promise Kept', 'Summer at the Pier', 'Ink and Roses', 'The Last Dance'],
  scifi: ['The Last Signal', 'Orbit Drift', 'Colony Nine', 'The Glass Engine', 'Beyond the Static', 'Red Dust Rising', 'The Quiet Machine', 'Starlight Archive'],
  kids: ['The Brave Little Fox', 'Bedtime for Dragons', 'The Cloud Garden', 'A Very Silly Day', 'The Tiny Explorer', 'Pip the Penguin', 'Moon Boots', 'The Lost Balloon'],
  reference: ["The Gardener's Almanac", 'Complete Grammar Guide', 'World Atlas, Revised', 'Field Guide to Birds', 'The Home Repair Book', 'Kitchen Science', 'A History of Maps', 'Pocket Dictionary'],
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
// v2.14: was [180, 480] — the top of that range overlapped each overlay's
// header line (a coin sat on the Coin Hunt title) and the bottom the
// "N / M found" counter at y=470.
const SCENE_Y = [205, 445];

/** Scatters `count` points inside the scene bounds with a minimum separation, retrying on overlap (bounded attempts, falls back to whatever fits). */
/**
 * Greedy word-wraps `title` into at most `maxLines` lines no wider than
 * `maxWidth`, stepping the font size down from `maxFont` to `minFont`
 * until it fits. Returns the font size + lines; if even `minFont` can't
 * fit, returns that size's best effort (callers clip to the book's rect).
 */
function fitTitleLines(ctx, title, maxWidth, maxLines, maxFont, minFont) {
  const words = title.split(' ');
  let best = null;
  for (let size = maxFont; size >= minFont; size -= 0.5) {
    ctx.font = `bold ${size}px sans-serif`;
    const lines = [];
    let fits = true;
    for (const word of words) {
      if (ctx.measureText(word).width > maxWidth) fits = false;
      const candidate = lines.length ? `${lines[lines.length - 1]} ${word}` : word;
      if (lines.length && ctx.measureText(candidate).width <= maxWidth) lines[lines.length - 1] = candidate;
      else lines.push(word);
    }
    if (lines.length > maxLines) fits = false;
    best = { size, lines: lines.slice(0, maxLines) };
    if (fits) return best;
  }
  return best;
}

/** Cream text on dark covers, dark text on light ones. */
function titleInkFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 170 ? '#3a2a2a' : '#fdf8ee';
}

/**
 * Draws a book's full title centered on its front cover, wrapped and
 * shrunk to fit, clipped to the cover rect so it can never bleed into a
 * neighboring book (v1.4's original overflow bug).
 */
function drawCoverTitle(ctx, title, x, y, w, h, coverColor, opts = {}) {
  const pad = opts.pad ?? 2;
  const { size, lines } = fitTitleLines(ctx, title, w - pad * 2, opts.maxLines ?? 4, opts.maxFont ?? 8, opts.minFont ?? 5);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = titleInkFor(coverColor);
  ctx.font = `bold ${size}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lineH = size * 1.15;
  const top = y + h / 2 - ((lines.length - 1) * lineH) / 2;
  lines.forEach((line, i) => ctx.fillText(line, x + w / 2, top + i * lineH));
  ctx.restore();
}

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

  // First Person Mode (docs/features/library-game.md's Scope addition) —
  // a pure alternate camera+control scheme over the SAME player.x/y/floor,
  // not a separate game mode. `cameraMode` toggles which of render()'s two
  // branches draws and which input path (click-to-move vs. turn/move/
  // interact) is active; `playerFacing` only matters in First Person but is
  // tracked unconditionally so switching floors (which picks a fresh
  // "sensible facing angle" — see `switchFloor`) doesn't need special-casing.
  let cameraMode = 'top-down'; // 'top-down' | 'first-person'
  let playerFacing = 0;
  const heldFP = { turnLeft: false, turnRight: false, forward: false, back: false };
  // Recomputed once per frame by `updateFirstPersonScene` — the projected
  // station/patron/book billboards for the current frame, and whichever one
  // (if any) is centered near the crosshair within interact range. Read by
  // both `render()`'s First Person branch and `updateHoverHint()`/
  // `attemptInteract()`, so both act on the exact same frame's projection.
  let fpScene = { projected: [], interactTarget: null };

  let currentShiftNumber = save.currentShift;
  let karenShiftNumber = karenShiftForSeed(save.karenSeed);
  let finesStartShiftNumber = finesStartShiftForSeed(save.karenSeed);
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
    'reading-nook': 'Reading Nook',
    bookshelf: null, // resolved per-station via genreId below
  };

  function labelForStation(station) {
    if (station.kind === 'bookshelf') {
      const genre = findGenre(station.genreId);
      return genre ? `${genre.name} Shelf` : 'Bookshelf';
    }
    if (station.kind === 'reading-nook' && shiftState && shiftState.readingCooldownSeconds > 0) {
      return `Reading Nook (${Math.ceil(shiftState.readingCooldownSeconds)}s)`;
    }
    if (station.kind === 'boss-office' && shiftState && shiftState.phase === 'playing') {
      return "Boss's Office (locked)";
    }
    if (station.kind === 'boss-office' && shiftState && shiftState.phase === 'closing-wait' && !isBossOfficeReady(shiftState)) {
      return `Boss's Office (${Math.ceil(shiftState.closingWaitSecondsRemaining)}s)`;
    }
    return STATION_LABELS[station.kind] || '';
  }

  /** The station a First Person interact target ultimately maps to, for hint-text purposes — front-desk slots/Return Cart books read as their parent station's label, same text a Top-Down hover over that station box would show. */
  function labelForFPTarget(target) {
    if (target.entityKind === 'station') return labelForStation(target.ref);
    if (target.entityKind === 'frontDeskSlot') return labelForStation(stations.find((s) => s.kind === 'front-desk'));
    if (target.entityKind === 'finesSlot') return labelForStation(stations.find((s) => s.kind === 'fines-counter'));
    if (target.entityKind === 'returnCartBook') return labelForStation(stations.find((s) => s.kind === 'return-cart'));
    return '';
  }

  function updateHoverHint() {
    if (overlay || !running) {
      elements.hoverHint.classList.add('hidden');
      return;
    }
    if (cameraMode === 'first-person') {
      const target = fpScene.interactTarget;
      const label = target ? labelForFPTarget(target) : '';
      if (!label) {
        elements.hoverHint.classList.add('hidden');
        return;
      }
      elements.hoverHint.textContent = label;
      elements.hoverHint.classList.remove('hidden');
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

  /** Set when the player arrives at the Boss's Office during the closing wait; the loop lets them in once it ends, as long as they're still there. */
  let waitingAtBossOffice = false;

  function enterBossOfficeNow() {
    waitingAtBossOffice = false;
    shiftState = enterBossOffice(shiftState);
    endShift();
  }

  /** Whether the player is standing at the Boss's Office (within the normal arrival distance plus a little slack). */
  function isPlayerAtBossOffice() {
    const office = stations.find((st) => st.kind === 'boss-office');
    if (!office || currentFloor !== office.floor) return false;
    return Math.hypot(player.x - office.x, player.y - office.y) <= office.size / 2 + PLAYER_STOP_MARGIN + 30;
  }

  function commitStationTarget(station, rawPoint) {
    if (station?.kind !== 'boss-office') waitingAtBossOffice = false;
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
    // "Picking a sensible default facing angle... is fine" (doc's Scope) —
    // face the new floor's room center rather than keeping whatever facing
    // happened to be current, same reasoning as `setCameraMode`'s own
    // default below. Harmless in Top-Down mode, which never reads facing.
    playerFacing = defaultFacingTowardCenter(entry.x, entry.y, CANVAS_WIDTH, CANVAS_HEIGHT);
    updateFloorButton();
  }

  // -- First Person Mode ------------------------------------------------------
  //
  // A pure alternate camera+control scheme over the same player.x/y/floor
  // (doc's Scope: "not a separate game mode with different rules"). Toggled
  // instantly by `#library-camera-button`; click-to-move doesn't apply here,
  // so it adds its own turn/move controls (keyboard + on-screen buttons) and
  // an "interact" action that calls the exact same `handleArrival` station
  // logic Top-Down's click-to-move already uses — see `attemptInteract`.

  function setCameraMode(mode) {
    if (cameraMode === mode) return;
    cameraMode = mode;
    if (mode === 'first-person') {
      playerFacing = defaultFacingTowardCenter(player.x, player.y, CANVAS_WIDTH, CANVAS_HEIGHT);
      hoverStation = null;
      moveTarget = null; // stop any in-flight Top-Down walk — First Person has its own movement
    } else {
      heldFP.turnLeft = false;
      heldFP.turnRight = false;
      heldFP.forward = false;
      heldFP.back = false;
      fpScene = { projected: [], interactTarget: null };
    }
    updateCameraButton();
    updateFPControlsVisibility();
  }

  function updateCameraButton() {
    if (!elements.cameraButton) return;
    const isFirstPerson = cameraMode === 'first-person';
    elements.cameraButton.textContent = isFirstPerson ? 'Top-Down View' : 'First Person';
    elements.cameraButton.setAttribute('aria-pressed', String(isFirstPerson));
  }

  function updateFPControlsVisibility() {
    if (!elements.fpControls?.root) return;
    elements.fpControls.root.classList.toggle('hidden', cameraMode !== 'first-person');
  }

  /** Builds this frame's First Person entity list: every station on the current floor, plus (1st Floor only, mirroring `drawFrontDeskSlots`/`drawReturnCartBooks`'s own floor gate) every front-desk patron slot and Return Cart book — the doc's "every station... and every visible patron on the current floor." */
  function buildFirstPersonEntities() {
    const entities = [];
    for (const station of stationsOnFloor(stations, currentFloor)) {
      entities.push({ id: station.id, x: station.x, y: station.y, entityKind: 'station', ref: station });
    }
    if (currentFloor === FLOOR_1) {
      frontDeskSlots().forEach((slot, i) => {
        entities.push({ id: `fd-${slot.id}`, x: slot.x, y: slot.y, entityKind: 'frontDeskSlot', ref: slot, slotIndex: i });
      });
      finesCounterSlots().forEach((slot, i) => {
        entities.push({ id: `fc-${slot.id}`, x: slot.x, y: slot.y, entityKind: 'finesSlot', ref: slot, slotIndex: i });
      });
      returnCartSlots().forEach((book) => {
        entities.push({ id: `cart-${book.id}`, x: book.x, y: book.y, entityKind: 'returnCartBook', ref: book });
      });
    }
    return entities;
  }

  /** Recomputes this frame's projection + interact target — called once per frame from `loop`, read by both `render()` and `updateHoverHint()`/`attemptInteract()` so all three act on the same frame's numbers. */
  function updateFirstPersonScene() {
    if (cameraMode !== 'first-person') {
      fpScene = { projected: [], interactTarget: null };
      return;
    }
    const projected = projectScene(
      { x: player.x, y: player.y, facing: playerFacing },
      buildFirstPersonEntities(),
      { canvasWidth: CANVAS_WIDTH },
    );
    fpScene = { projected, interactTarget: findInteractTarget(projected) };
  }

  function updateFirstPersonMovement(deltaSeconds) {
    if (cameraMode !== 'first-person') return;
    let turnDirection = 0;
    if (heldFP.turnLeft) turnDirection -= 1;
    if (heldFP.turnRight) turnDirection += 1;
    if (turnDirection !== 0) playerFacing = turnFacing(playerFacing, turnDirection, deltaSeconds);

    let moveDirection = 0;
    if (heldFP.forward) moveDirection += 1;
    if (heldFP.back) moveDirection -= 1;
    if (moveDirection !== 0) {
      const sanityMultiplier = walkSpeedMultiplierForSanity(shiftState ? shiftState.sanity : SANITY_MAX);
      const distance = MOVE_SPEED_PIXELS_PER_SECOND * sanityMultiplier * deltaSeconds;
      const next = stepForward(player.x, player.y, playerFacing, moveDirection, distance);
      const clamped = clampToCanvas(next.x, next.y);
      player.x = clamped.x;
      player.y = clamped.y;
    }
  }

  /**
   * First Person's "interact" action — the interact key/button, or a canvas
   * click while in First Person (doc: "a 'look at a station, then interact'
   * prompt... functionally equivalent to clicking that station in Top-Down
   * mode"). Deliberately calls into the SAME functions Top-Down's
   * click-to-move arrival already uses (`handleArrival`, and the same
   * pending-action queue variables `onCanvasClick` sets for a front-desk
   * slot/Return Cart book click) rather than duplicating any of that logic.
   */
  function attemptInteract() {
    if (!running || overlay || cameraMode !== 'first-person') return;
    const target = fpScene.interactTarget;
    if (!target) return;
    if (target.entityKind === 'frontDeskSlot') {
      const slot = target.ref;
      pendingFrontDeskAction = slot.kind === 'karen' ? { kind: 'karen' } : (slot.kind === 'borrow-active' ? null : { kind: slot.kind, id: slot.id });
      handleArrival(stations.find((s) => s.kind === 'front-desk'));
    } else if (target.entityKind === 'finesSlot') {
      handleArrival(stations.find((s) => s.kind === 'fines-counter'));
    } else if (target.entityKind === 'returnCartBook') {
      if (shiftState && !shiftState.carriedBook) {
        pendingCartPickupId = target.ref.id;
        handleArrival(stations.find((s) => s.kind === 'return-cart'));
      }
    } else if (target.entityKind === 'station') {
      handleArrival(target.ref);
    }
  }

  // -- Front Desk / Return Cart queue slots ---------------------------------

  const SLOT_VISIBLE_MAX = 3;
  /** How far below a station's box its patron queue stands — far enough that patrons' heads clear the station's label chip. */
  const QUEUE_SLOT_OFFSET_Y = 72;

  function frontDeskSlots() {
    if (!shiftState) return [];
    const slots = [];
    if (karenAvailable && !shiftState.karen.triggered) {
      slots.push({ kind: 'karen', id: 'karen' });
    }
    // The patron whose request you're fulfilling stays at the desk (with a
    // patience bar) instead of vanishing on accept — v2.7, user: "the
    // costermer dissapears and i didnt get the book".
    if (shiftState.activeBorrow) {
      const a = shiftState.activeBorrow;
      slots.push({
        kind: 'borrow-active', id: a.id, bookId: a.bookId, stage: a.stage,
        patienceFraction: a.patienceMaxSeconds > 0 ? a.patienceRemainingSeconds / a.patienceMaxSeconds : 1,
      });
    }
    shiftState.borrowQueue.slice(0, SLOT_VISIBLE_MAX).forEach((r) => slots.push({ kind: 'borrow', id: r.id, bookId: r.bookId, waitFraction: waitFractionOf(r) }));
    // v2.16 hallucinated patrons — not really there.
    halluc.ghosts.forEach((g) => slots.push({ kind: 'ghost', id: g.id }));
    return slots.map((slot, i) => {
      const desk = stations.find((s) => s.kind === 'front-desk');
      const totalWidth = (slots.length - 1) * 46;
      return { ...slot, x: desk.x - totalWidth / 2 + i * 46, y: desk.y + desk.size / 2 + QUEUE_SLOT_OFFSET_Y };
    });
  }

  function frontDeskSlotAtPoint(x, y) {
    if (currentFloor !== FLOOR_1) return null;
    return frontDeskSlots().find((slot) => isPointOnQueuedPatron(slot, x, y)) || null;
  }

  /**
   * Hit-tests a queued patron's whole drawn body. Their slot (x, y) is
   * their *feet*; the old 26px radius around it missed clicks on the
   * head/torso entirely (user: "how do i take the book from the
   * costermer?????"). The box spans head-top to shoes and half the 46px
   * slot pitch on each side, so neighbours never overlap.
   */
  /** A queued patron's remaining wait as 0..1, or null if they have no wait timer. */
  function waitFractionOf(entry) {
    return entry.waitMaxSeconds ? entry.waitRemainingSeconds / entry.waitMaxSeconds : null;
  }

  /** Patience bar under a patron's name chip (above their head it collided with the station's label), green -> amber -> red. */
  function drawPatienceBar(slot, fraction) {
    if (fraction == null) return;
    const f = Math.max(0, Math.min(1, fraction));
    const y = slot.y + 30;
    drawRoundRect(ctx, slot.x - 18, y, 36, 5, 2.5, 'rgba(58,42,42,0.25)');
    drawRoundRect(ctx, slot.x - 18, y, 36 * f, 5, 2.5, f > 0.5 ? '#7fd68a' : (f > 0.25 ? '#e0a83a' : '#e06a5b'));
  }

  function isPointOnQueuedPatron(slot, x, y) {
    return Math.abs(x - slot.x) <= 22 && y >= slot.y - 50 && y <= slot.y + 26;
  }

  /** Fine-paying patrons queue under the Fines Counter (v2.4), laid out the same way as the Front Desk's queue. */
  function finesCounterSlots() {
    if (!shiftState) return [];
    const counter = stations.find((s) => s.kind === 'fines-counter');
    const queue = shiftState.finesQueue.slice(0, SLOT_VISIBLE_MAX);
    const totalWidth = (queue.length - 1) * 46;
    return queue.map((f, i) => ({
      kind: 'fine', id: f.id, amountGard: f.amountGard, waitFraction: waitFractionOf(f),
      x: counter.x - totalWidth / 2 + i * 46,
      y: counter.y + counter.size / 2 + QUEUE_SLOT_OFFSET_Y,
    }));
  }

  function finesCounterSlotAtPoint(x, y) {
    if (currentFloor !== FLOOR_1) return null;
    return finesCounterSlots().find((slot) => isPointOnQueuedPatron(slot, x, y)) || null;
  }

  function returnCartSlots() {
    if (!shiftState) return [];
    const cart = stations.find((s) => s.kind === 'return-cart');
    return shiftState.returnCart.slice(0, 5).map((book, i) => ({
      ...book,
      x: cart.x - 68 + (i % 5) * 34,
      y: cart.y + cart.size / 2 + 34,
    }));
  }

  /** A Return Cart book's cover rect — 30x40, grown from 26x32 to fit full titles (34px slot pitch leaves a 4px gap). */
  function returnCartCoverRect(book) {
    return { x: book.x - 14, y: book.y - 16, w: 30, h: 40 };
  }

  function returnCartSlotAtPoint(x, y) {
    if (currentFloor !== FLOOR_1) return null;
    return returnCartSlots().find((book) => {
      const r = returnCartCoverRect(book);
      return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
    }) || null;
  }

  // -- Patron/book spawn scheduling -----------------------------------------

  function scheduleShiftEvents() {
    const total = shiftState.totalClockSeconds;
    const events = [];
    const bookCount = returnVolumeForShift(currentShiftNumber);
    const fineCount = fineVolumeForShift(currentShiftNumber, finesStartShiftNumber);
    const borrowCount = borrowVolumeForShift(currentShiftNumber);
    for (let i = 0; i < bookCount; i++) events.push({ type: 'book', at: random() * total * 0.85 });
    for (let i = 0; i < fineCount; i++) events.push({ type: 'fine', at: random() * total * 0.85 });
    for (let i = 0; i < borrowCount; i++) {
      // The first borrow patron always shows up within the opening seconds.
      const [early, late] = FIRST_BORROW_ARRIVAL_SECONDS;
      const at = i === 0 ? early + random() * (late - early) : random() * total * 0.85;
      events.push({ type: 'borrow', at });
    }
    if (currentShiftNumber === karenShiftNumber) {
      events.push({ type: 'karen', at: total * 0.3 });
    }
    events.sort((a, b) => a.at - b.at);
    return events;
  }

  function spawnBook(forceCoinHunt) {
    const genre = GENRES[Math.floor(random() * GENRES.length)];
    const isCoinHunt = forceCoinHunt ?? isCoinHuntBook(random());
    // `title` is purely cosmetic (drawn on the Return Cart cover and the
    // Coin Hunt header — user feedback: "i dunno what book it is") — it
    // rides along on the plain object engine-state.js's addBookToCart/
    // pickUpBook store and pass through verbatim (they never touch fields
    // they don't know about), so no engine-state.js/rules.js change is
    // needed to carry it all the way to `carriedBook`.
    const title = titleForGenre(genre.id, random);
    const book = { id: `book-${bookIdCounter++}`, genreId: genre.id, isCoinHunt, title };
    shiftState = addBookToCart(shiftState, book);
  }

  function spawnFine(forcedAmount) {
    const amountGard = Number.isFinite(forcedAmount) ? forcedAmount : fineAmountForRoll(random());
    shiftState = addFineToQueue(shiftState, { id: `fine-${fineIdCounter++}`, amountGard, waitSeconds: queueWaitSecondsForShift(currentShiftNumber) });
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
      waitSeconds: queueWaitSecondsForShift(currentShiftNumber),
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
    // Decoys draw *distinct* titles that never match the requested one —
    // previously each decoy rolled independently from a 5-title pool, so a
    // decoy could carry the very title being searched for (bug report: "when
    // i try to get the book the costermer borrowed i couldnt").
    const decoyTitles = (TITLE_POOLS[genreId] || []).filter((t) => t !== correctTitle);
    for (let i = decoyTitles.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [decoyTitles[i], decoyTitles[j]] = [decoyTitles[j], decoyTitles[i]];
    }
    let decoyIndex = 0;
    // Squeeze the scatter's y-range down so no book overlaps the
    // "Looking for" header line (y≈194).
    const items = points.map((p, i) => ({
      ...p,
      y: 218 + ((p.y - SCENE_Y[0]) / (SCENE_Y[1] - SCENE_Y[0])) * (SCENE_Y[1] - 218),
      id: i,
      title: i === correctIndex ? correctTitle : (decoyTitles[decoyIndex++] ?? 'Untitled'),
      correct: i === correctIndex,
      color: genre ? genre.color : '#8a6a4a',
    }));
    overlay = { kind: 'find-the-book', items, genreId };
  }

  // -- Count the Till (v2.4): count a collected fine into the Front Desk till
  // Tap coin/bill denominations (or press 1-4) to add them, Undo (or
  // Backspace) to take the last one back. Reaching the exact amount banks
  // it; going over is a miscount: a mistake, and the count resets.

  function openTillCountOverlay() {
    overlay = { kind: 'till-count', target: shiftState.carriedFine.amountGard, added: [], flash: null };
  }

  function tillButtonRects() {
    const w = 104;
    const h = 64;
    const gap = 18;
    const startX = CANVAS_WIDTH / 2 - (TILL_DENOMINATIONS.length * w + (TILL_DENOMINATIONS.length - 1) * gap) / 2;
    const denominations = TILL_DENOMINATIONS.map((value, i) => ({ value, x: startX + i * (w + gap), y: 330, w, h }));
    return { denominations, undo: { x: CANVAS_WIDTH / 2 - 60, y: 420, w: 120, h: 36 } };
  }

  function tillTotal() {
    return overlay.added.reduce((sum, v) => sum + v, 0);
  }

  function addToTill(value) {
    overlay.added.push(value);
    const result = tillCountResult(tillTotal(), overlay.target);
    if (result === 'exact') {
      shiftState = resolveTillCount(shiftState, true);
      showToast(`Counted ${overlay.target} Gard into the till — fine banked!`);
      overlay = null;
    } else if (result === 'over') {
      shiftState = resolveTillCount(shiftState, false);
      showToast(`Miscounted (${tillTotal()} Gard) — start over.`);
      overlay.added = [];
      overlay.flash = { text: 'Over! Recount', seconds: 1 };
    }
  }

  function undoTill() {
    overlay.added.pop();
  }

  function handleTillCountClick(x, y) {
    const inside = (r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
    const rects = tillButtonRects();
    const hit = rects.denominations.find(inside);
    if (hit) addToTill(hit.value);
    else if (inside(rects.undo)) undoTill();
  }

  /** The active borrow request's title, and where its shelf is (with "upstairs" for 2nd-floor genres). */
  function borrowTitle() {
    return bookCatalog.get(shiftState?.activeBorrow?.bookId)?.title ?? 'the book';
  }

  function borrowShelfLabel() {
    const entry = bookCatalog.get(shiftState?.activeBorrow?.bookId);
    const shelf = entry && stations.find((st) => st.kind === 'bookshelf' && st.genreId === entry.genreId);
    if (!shelf) return 'shelves';
    return `${labelForStation(shelf)}${shelf.floor === FLOOR_2 ? ' (upstairs)' : ''}`;
  }

  function openKarenOverlay() {
    overlay = { kind: 'karen' };
  }

  // -- Hallucinations (v2.16) -----------------------------------------------
  // Below HALLUCINATION_START_SANITY the library turns creepy, scaled by
  // rules.js's hallucinationIntensity: a pulsing vignette, shadow figures,
  // whispers, light flickers, screen shake, and at full intensity the odd
  // jump scare. Work suffers too: shaky hands (skill checks), dropped
  // books, and ghost patrons in the Front Desk line who aren't really
  // there (walking up to one costs Sanity). Coffee ends it.

  const WHISPERS = ['shhh…', 'overdue…', "they're watching", 'you missed one', 'turn around', 'quiet…', 'it was due yesterday', 'who left the lights on?'];
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

    if (i > 0.3 && random() < 0.35 * i * dt) {
      halluc.figures.push({ x: 80 + random() * (CANVAS_WIDTH - 160), y: 160 + random() * 380, age: 0, life: 0.8 + random() * 1.2 });
    }
    if (random() < 0.3 * i * dt) {
      halluc.whispers.push({
        text: WHISPERS[Math.floor(random() * WHISPERS.length)],
        x: 120 + random() * (CANVAS_WIDTH - 240), y: 140 + random() * 380, age: 0, life: 2.6,
      });
    }
    if (random() < 0.12 * i * dt) halluc.flicker = 0.18;
    if (i >= 1 && random() < 0.04 * dt) halluc.scare = 0.45;
    if (i >= 0.5 && halluc.ghosts.length === 0 && random() < 0.06 * i * dt) {
      halluc.ghosts.push({ id: `ghost-${halluc.ghostCounter++}`, age: 0, life: 15 });
    }

    // Dropped books: a carried book can slip back onto the cart.
    if (!overlay && shiftState.carriedBook && random() < BOOK_DROP_CHANCE_PER_SECOND * i * dt) {
      const before = shiftState;
      shiftState = dropCarriedBook(shiftState);
      if (shiftState !== before) showToast('Your hands shake — the book slips back onto the Return Cart.');
    }
  }

  function drawShadowFigure(fx, fy, alpha, scale = 1) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#140c18';
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
      ctx.fillStyle = `rgba(110,40,90,${0.75 * fade})`;
      ctx.fillText(w.text, w.x + Math.sin(t * 2 + w.x) * 6, w.y - w.age * 8);
    }
    ctx.restore();

    // Pulsing vignette closing in.
    const pulse = 0.85 + 0.15 * Math.sin(t * 2.2);
    const v = ctx.createRadialGradient(CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2, 90 + 170 * (1 - i), CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2, 560);
    v.addColorStop(0, 'rgba(25,0,35,0)');
    v.addColorStop(0.6, `rgba(25,0,35,${0.45 * i * pulse})`);
    v.addColorStop(1, `rgba(15,0,20,${0.9 * i * pulse})`);
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    if (halluc.flicker > 0) {
      ctx.fillStyle = 'rgba(10,0,15,0.55)';
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    }
    if (halluc.scare > 0) {
      ctx.fillStyle = `rgba(10,0,10,${0.6 * (halluc.scare / 0.45)})`;
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      drawShadowFigure(CANVAS_WIDTH / 2, CANVAS_HEIGHT + 120, halluc.scare / 0.45, 4.2);
    }
  }

  // -- Reading (v2.10): turn the pages of a short book to restore Mood -----
  // Each page "reads" itself over READING_SECONDS_PER_PAGE (a bar fills);
  // click/tap or Space/Enter turns it once full. Turning early just nudges
  // you to finish the page. The last page turn finishes the book. The ×
  // button puts the book down early: no Mood, no cooldown.

  function openReadingOverlay() {
    const storyIndex = Math.floor(random() * READING_STORIES.length);
    overlay = {
      kind: 'reading',
      storyIndex,
      title: READING_STORIES[storyIndex].title,
      page: 0,
      progress: 0,
      nudge: 0,
    };
  }

  /** Back one spread (← key) to re-read; already-read spreads can be turned again at once. */
  function previousReadingPage() {
    if (overlay?.kind !== 'reading' || overlay.page === 0) return;
    overlay.page -= 1;
    overlay.progress = 1;
  }

  function turnReadingPage() {
    if (overlay?.kind !== 'reading') return;
    if (overlay.progress < 1) {
      overlay.nudge = 0.6;
      return;
    }
    overlay.page += 1;
    overlay.progress = 0;
    if (overlay.page >= READING_PAGES) {
      const before = shiftState;
      shiftState = finishReading(shiftState);
      overlay = null;
      if (shiftState !== before) showToast(`What a lovely read — +${READING_MOOD_RESTORE} Mood.`);
    }
  }

  function readingCloseRect() {
    return { x: CANVAS_WIDTH / 2 + 288, y: 104, w: 30, h: 30 };
  }

  function handleReadingClick(x, y) {
    const r = readingCloseRect();
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
      overlay = null;
      return;
    }
    turnReadingPage();
  }

  // -- Coffee Pour (v2.2): hold to pour, release inside the gold band -------
  // Held input, unlike every other overlay's click: pointerdown on the
  // canvas or a Space/Enter keydown starts pouring, the matching
  // pointerup/keyup stops it and grades the pour (rules.js's
  // gradeCoffeePour). Reaching the brim spills and ends it automatically.
  // The result stays on screen for COFFEE_RESULT_SECONDS, then closes.

  const COFFEE_RESULT_SECONDS = 1.2;
  const COFFEE_RESULT_TEXT = {
    perfect: `Perfect pour! Fully refreshed, +${COFFEE_PERFECT_TIP_GARD} Gard tip.`,
    good: 'Nice cup — feeling better.',
    sloppy: 'A bit sloppy, but coffee is coffee.',
    spilled: 'Ow! Hot coffee all over you — −50 Sanity.',
  };

  // v2.19: after a spill, Coral wears coffee stains for a few seconds.
  const COFFEE_SPLASH_SECONDS = 6;
  let coffeeSplashSeconds = 0;

  function drawCoffeeSplash() {
    if (coffeeSplashSeconds <= 0) return;
    const s = LIBRARY_PERSON_SCALE;
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

  function openCoffeePourOverlay() {
    overlay = { kind: 'coffee-pour', fill: 0, pouring: false, band: coffeePourTargetBand(random()), grade: null, closeIn: 0 };
  }

  function startCoffeePour() {
    if (overlay?.kind === 'coffee-pour' && !overlay.grade) overlay.pouring = true;
  }

  function stopCoffeePour() {
    // Only a release that follows a press grades the pour — the keyup of
    // the very Enter press that *opened* the overlay (First Person's
    // interact key) must not end it at 0%.
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

  function onCanvasPointerDown(e) {
    if (!running || overlay?.kind !== 'coffee-pour') return;
    e.preventDefault();
    startCoffeePour();
  }

  function onWindowPointerUp() {
    stopCoffeePour();
  }

  function updateOverlay(deltaSeconds) {
    if (!overlay) return;
    if (overlay.kind === 'reading') {
      overlay.progress = Math.min(1, overlay.progress + deltaSeconds / READING_SECONDS_PER_PAGE);
      overlay.nudge = Math.max(0, overlay.nudge - deltaSeconds);
      return;
    }
    if (overlay.kind === 'till-count') {
      if (overlay.flash) {
        overlay.flash.seconds -= deltaSeconds;
        if (overlay.flash.seconds <= 0) overlay.flash = null;
      }
      return;
    }
    if (overlay.kind === 'coffee-pour') {
      if (overlay.grade) {
        overlay.closeIn -= deltaSeconds;
        if (overlay.closeIn <= 0) overlay = null;
      } else if (overlay.pouring) {
        overlay.fill = Math.min(1, overlay.fill + deltaSeconds / COFFEE_POUR_SECONDS_TO_BRIM);
        if (overlay.fill >= 1) finishCoffeePour();
      }
      return;
    }
    if (overlay.kind === 'skill-check') {
      const speed = skillCheckSweepSpeed(currentShiftNumber) * shakyHandsSweepMultiplier(currentIntensity());
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
      // A collected fine payment goes into the till first (Count the Till);
      // any queued desk action waits for the next visit.
      if (shiftState.carriedFine) {
        const before = shiftState;
        shiftState = arriveAtFrontDeskWithFine(shiftState);
        if (shiftState !== before) openTillCountOverlay();
        return;
      }
      if (pendingFrontDeskAction) {
        const action = pendingFrontDeskAction;
        pendingFrontDeskAction = null;
        if (action.kind === 'ghost') {
          halluc.ghosts = halluc.ghosts.filter((g) => g.id !== action.id);
          shiftState = startleFromHallucination(shiftState);
          showToast("…there's no one there. Your heart pounds.");
        } else if (action.kind === 'borrow') {
          const before = shiftState;
          shiftState = acceptBorrowRequest(shiftState, action.id);
          if (shiftState !== before) showToast(`Borrow request: “${borrowTitle()}” — find it on the ${borrowShelfLabel()}.`);
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
      if (shiftState.activeBorrow?.stage === 'searching' && !overlay) {
        const entry = bookCatalog.get(shiftState.activeBorrow.bookId);
        if (entry && entry.genreId === station.genreId) {
          openFindTheBookOverlay(station.genreId, entry.title);
        } else if (entry && !shiftState.carriedBook) {
          showToast(`Not here — “${entry.title}” is on the ${borrowShelfLabel()}.`);
        }
      }
      return;
    }

    if (station.kind === 'fines-counter') {
      if (shiftState.carriedFine) {
        showToast("Take the payment you're holding to the Front Desk till first.");
        return;
      }
      const before = shiftState;
      shiftState = arriveAtFinesCounter(shiftState);
      if (shiftState !== before && shiftState.finesSortActive) openFinesSortOverlay();
      return;
    }

    if (station.kind === 'reading-nook') {
      if (shiftState.phase !== 'playing') return;
      if (!canReadBook(shiftState)) {
        showToast(`Still savoring the last book — ready in ${Math.ceil(shiftState.readingCooldownSeconds)}s.`);
        return;
      }
      openReadingOverlay();
      return;
    }

    if (station.kind === 'coffee-machine') {
      if (shiftState.phase === 'playing') openCoffeePourOverlay();
      return;
    }

    if (station.kind === 'boss-office') {
      if (isBossOfficeReady(shiftState)) {
        enterBossOfficeNow();
      } else if (shiftState.phase === 'closing-wait') {
        // Wait right here: the loop lets you in the moment the wait ends.
        waitingAtBossOffice = true;
        showToast(`The boss is finishing up — wait here ${Math.ceil(shiftState.closingWaitSecondsRemaining)}s and you'll be let in.`);
      } else if (shiftState.phase === 'playing') {
        const left = Math.ceil(shiftState.clockSeconds);
        showToast(`The boss will let you in after closing — the shift ends in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}.`);
      }
    }
  }

  // -- Overlay input ----------------------------------------------------------

  function resolveSkillCheck() {
    const success = isSkillCheckSuccess(overlay.gaugePosition, skillCheckSuccessZone(shakyHandsZoneScale(currentIntensity())));
    if (overlay.context === 'shelf') {
      shiftState = resolveShelfSkillCheck(shiftState, success);
      showToast(success ? `Shelved! +${SHELVED_BOOK_TIP_GARD}g` : 'Missed the mark — try again.');
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
      showToast(`Found every coin — +${total + SHELVED_BOOK_TIP_GARD} Gard (incl. the shelving tip)!`);
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
      showToast('Payment collected — count it into the Front Desk till.');
      overlay = null;
    }
  }

  function handleFindTheBookClick(x, y) {
    const item = overlay.items.find((it) => Math.hypot(it.x - x, it.y - y) <= 20);
    if (!item) return;
    if (item.correct) {
      shiftState = resolveFindTheBook(shiftState, true);
      showToast('Found it! Bring it to the Front Desk to check it out.');
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
    else if (overlay.kind === 'till-count') handleTillCountClick(x, y);
    else if (overlay.kind === 'reading') handleReadingClick(x, y);
  }

  // -- Canvas input -----------------------------------------------------------

  function onCanvasClick(e) {
    if (!running) return;
    const { x, y } = canvasCoordsFromEvent(e);

    if (overlay) {
      onOverlayClick(x, y);
      return;
    }

    // Click-to-move doesn't apply in First Person (doc's Scope) — a canvas
    // click there is instead the same "interact" action as the interact
    // key/on-screen button, per that same section's "pressing the interact
    // key/clicking triggers the exact same station-arrival logic."
    if (cameraMode === 'first-person') {
      attemptInteract();
      return;
    }

    if (shiftState && shiftState.phase === 'playing') {
      const slot = frontDeskSlotAtPoint(x, y);
      if (slot) {
        if (slot.kind === 'karen') pendingFrontDeskAction = { kind: 'karen' };
        else if (slot.kind === 'borrow-active') pendingFrontDeskAction = null;
        else pendingFrontDeskAction = { kind: slot.kind, id: slot.id };
        const desk = stations.find((s) => s.kind === 'front-desk');
        commitStationTarget(desk, null);
        return;
      }

      const finePatron = finesCounterSlotAtPoint(x, y);
      if (finePatron) {
        commitStationTarget(stations.find((s) => s.kind === 'fines-counter'), null);
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
    if (overlay || cameraMode === 'first-person') { canvas.style.cursor = ''; return; }
    const { x, y } = canvasCoordsFromEvent(e);
    hoverStation = stationAtPoint(x, y, stationsOnFloor(stations, currentFloor));
    // A hand cursor over anything clickable (stations, queued patrons,
    // Return Cart books), so it's clear patrons can be clicked.
    const clickable = hoverStation || frontDeskSlotAtPoint(x, y) || finesCounterSlotAtPoint(x, y) || returnCartSlotAtPoint(x, y);
    canvas.style.cursor = clickable ? 'pointer' : '';
  }

  function onCanvasMouseLeave() {
    hoverStation = null;
  }

  const FP_TURN_KEYS = { ArrowLeft: 'turnLeft', ArrowRight: 'turnRight' };
  const FP_MOVE_KEYS = { ArrowUp: 'forward', ArrowDown: 'back' };

  function onKeyDown(e) {
    if (overlay?.kind === 'till-count') {
      const index = Number(e.key) - 1;
      if (Number.isInteger(index) && index >= 0 && index < TILL_DENOMINATIONS.length) {
        e.preventDefault();
        addToTill(TILL_DENOMINATIONS[index]);
        return;
      }
      if (e.key === 'Backspace') {
        e.preventDefault();
        undoTill();
        return;
      }
    }
    // Reading: ←/→ page back/forward.
    if (overlay?.kind === 'reading' && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      if (!e.repeat) {
        if (e.key === 'ArrowRight') turnReadingPage();
        else previousReadingPage();
      }
      return;
    }
    if (overlay && (e.key === ' ' || e.key === 'Enter')) {
      e.preventDefault();
      if (overlay.kind === 'coffee-pour') {
        if (!e.repeat) startCoffeePour();
        return;
      }
      if (overlay.kind === 'reading') {
        if (!e.repeat) turnReadingPage();
        return;
      }
      // Sample at the overlay's center — a keyboard-reachable equivalent to
      // clicking, satisfying this game's accessibility requirement for a
      // non-pointer alternative to the timing-bar minigame specifically
      // (the two "search the scene" minigames still need pointer precision,
      // same as Kitchen Shift's own click-only station interactions).
      if (overlay.kind === 'skill-check') resolveSkillCheck();
      return;
    }

    // First Person's own turn/move/interact keys (doc's Scope: "arrow keys
    // or on-screen buttons") — arrow keys are otherwise unused anywhere in
    // this game, so there's no conflict with the existing Enter/Space
    // handling above or below. Held (not one-shot): keydown sets the flag,
    // `onKeyUp` clears it, and `updateFirstPersonMovement` applies it every
    // frame for as long as it's held, same press-and-hold feel as the
    // on-screen buttons.
    if (cameraMode === 'first-person' && running && !overlay) {
      if (e.key in FP_TURN_KEYS || e.key in FP_MOVE_KEYS) {
        e.preventDefault();
        heldFP[FP_TURN_KEYS[e.key] ?? FP_MOVE_KEYS[e.key]] = true;
        return;
      }
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        attemptInteract();
        return;
      }
    }

    if (e.key !== 'Enter') return;
    if (overlay || !running || !hoverStation) return;
    e.preventDefault();
    commitStationTarget(hoverStation, null);
  }

  function onKeyUp(e) {
    if (e.key === ' ' || e.key === 'Enter') stopCoffeePour();
    if (e.key in FP_TURN_KEYS) heldFP[FP_TURN_KEYS[e.key]] = false;
    else if (e.key in FP_MOVE_KEYS) heldFP[FP_MOVE_KEYS[e.key]] = false;
  }

  // -- Shift lifecycle ----------------------------------------------------

  function beginShift() {
    waitingAtBossOffice = false;
    coffeeSplashSeconds = 0;
    resetHallucinations();
    lastSeenBonusGard = 0;
    gardPops = [];
    currentShiftNumber = save.currentShift;
    karenShiftNumber = karenShiftForSeed(save.karenSeed);
    finesStartShiftNumber = finesStartShiftForSeed(save.karenSeed);
    shiftState = startShiftState(createInitialState(currentShiftNumber, karenShiftNumber));
    player = { ...PLAYER_START };
    playerFacing = defaultFacingTowardCenter(player.x, player.y, CANVAS_WIDTH, CANVAS_HEIGHT);
    heldFP.turnLeft = false;
    heldFP.turnRight = false;
    heldFP.forward = false;
    heldFP.back = false;
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
    const mistakesText = shiftState.mistakeCount > 0
      ? `${shiftState.mistakeCount} mistake${shiftState.mistakeCount === 1 ? '' : 's'} this shift`
      : 'Went well';
    // v2.9: the star rating scales the payout — say so on the paycheck.
    const payPercent = Math.round(paycheckMultiplierForRating(shiftState.rating) * 100);
    const hallucinationCut = Math.round((1 - hallucinationPayMultiplier(shiftState.zeroSanitySeconds)) * 100);
    const moodCut = Math.round((1 - moodPayMultiplier(shiftState.zeroMoodSeconds)) * 100);
    elements.paycheckScreen.outcome.textContent = `${mistakesText} · ${shiftState.rating}★ rating (${payPercent}% pay)`
      + (hallucinationCut > 0 ? ` · −${hallucinationCut}% for hallucinating` : '')
      + (moodCut > 0 ? ` · −${moodCut}% for a frustrated library` : '')
      + ((shiftState.unshelvedAtClose ?? 0) > 0 ? ` · ${shiftState.unshelvedAtClose} book${shiftState.unshelvedAtClose === 1 ? '' : 's'} left unshelved (−${shiftState.unshelvedAtClose * UNSHELVED_BOOK_PENALTY_GARD}g)` : '')
      + ((shiftState.complaints ?? 0) > 0 ? ` · ${shiftState.complaints} complaint letter${shiftState.complaints === 1 ? '' : 's'} (−${shiftState.complaints * COMPLAINT_GARD}g)` : '');
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
    'coffee-machine': '#e3cdb4',
    'reading-nook': '#d9e4cc',
    'boss-office': '#dcc2ea',
    stairs: '#b8cde0',
    elevator: '#c9a7d1',
  };

  // Wooden plank floor (v2 art pass — replaces the original graph-paper
  // grid): staggered planks with a slight per-plank tone variation, fixed
  // per position so it doesn't shimmer between frames.
  const PLANK_HEIGHT = 30;
  const PLANK_LENGTH = 160;
  const PLANK_TONES = ['#efdfc4', '#ecdabd', '#f1e3ca', '#e9d6b8'];

  function drawFloor() {
    ctx.fillStyle = PLANK_TONES[0];
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    for (let row = 0; row * PLANK_HEIGHT < CANVAS_HEIGHT; row++) {
      const y = row * PLANK_HEIGHT;
      const offset = (row % 3) * (PLANK_LENGTH / 3);
      for (let x = -offset, i = 0; x < CANVAS_WIDTH; x += PLANK_LENGTH, i++) {
        ctx.fillStyle = PLANK_TONES[(row * 7 + i * 3) % PLANK_TONES.length];
        ctx.fillRect(x, y, PLANK_LENGTH, PLANK_HEIGHT);
        ctx.fillStyle = 'rgba(120,85,50,0.16)';
        ctx.fillRect(x, y, 1.5, PLANK_HEIGHT);
        // A faint grain streak.
        ctx.fillStyle = 'rgba(120,85,50,0.06)';
        ctx.fillRect(x + 24 + ((row * 37 + i * 53) % 90), y + 9 + ((row + i) % 3) * 5, 40, 1.5);
      }
      ctx.fillStyle = 'rgba(120,85,50,0.18)';
      ctx.fillRect(0, y, CANVAS_WIDTH, 1.5);
    }
    // A soft vignette toward the walls.
    const vignette = ctx.createRadialGradient(CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2, 200, CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2, 620);
    vignette.addColorStop(0, 'rgba(120,85,50,0)');
    vignette.addColorStop(1, 'rgba(120,85,50,0.12)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

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

  // -- Station detail art (v2 art pass) -------------------------------------
  // The user compared these against Kitchen Shift's stations ("the coffee
  // machine isnt well done like the kitchen") — every library station used
  // to be a flat colored box with at most one stripe. Each drawer below
  // paints recognizable fixture art in the station's own local coordinate
  // space (origin = box center, already translated/scaled by drawStation,
  // so First Person's billboards get it for free), canvas primitives only.

  /** Small deterministic PRNG so a shelf's book spines are stable across frames. */
  function seededRandom(seedText) {
    let h = 2166136261;
    for (let i = 0; i < seedText.length; i++) h = Math.imul(h ^ seedText.charCodeAt(i), 16777619);
    return () => {
      h = Math.imul(h ^ (h >>> 15), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return ((h ^= h >>> 16) >>> 0) / 4294967296;
    };
  }

  function drawBookshelfDetail(half, station, baseColor) {
    const inset = 7;
    const inner = half - inset;
    drawRoundRect(ctx, -inner, -inner, inner * 2, inner * 2, 4, shadeColor(baseColor, -0.5));
    // Two rows of tall spines (not three short ones) so each spine is long
    // enough to carry a readable title from this genre's pool.
    const rows = 2;
    const rowH = (inner * 2) / rows;
    const random = seededRandom(station.id);
    const titles = TITLE_POOLS[station.genreId] || ['Untitled'];
    let titleIndex = Math.floor(random() * titles.length);
    const spinePalette = [
      shadeColor(baseColor, 0.45), shadeColor(baseColor, 0.2), '#fdf1dc',
      shadeColor(baseColor, -0.2), '#e8b95a', shadeColor(baseColor, 0.65),
    ];
    for (let r = 0; r < rows; r++) {
      const shelfY = -inner + (r + 1) * rowH;
      let x = -inner + 2;
      while (x < inner - 4) {
        const w = Math.min(11 + Math.floor(random() * 3), inner - 2 - x);
        if (w < 8) break;
        const h = rowH - 4 - Math.floor(random() * 3);
        const color = spinePalette[Math.floor(random() * spinePalette.length)];
        const top = shelfY - 3 - h;
        drawRoundRect(ctx, x, top, w, h, 1.5, color);
        ctx.fillStyle = 'rgba(58,42,42,0.22)';
        ctx.fillRect(x, top + 1.5, w, 1);
        ctx.fillRect(x, top + h - 2.5, w, 1);
        // Title running up the spine (rotated -90°). A whole title can't be
        // legible on a ~30px spine, so this shows the full title when it
        // fits and otherwise one of the title's main words, at the largest size
        // (6.5 → 5px) that fits.
        const title = titles[titleIndex++ % titles.length];
        const avail = h - 6;
        // Each genre pool has only five titles, so the second row picks the
        // title's next-longest word instead of repeating the first row's.
        const words = title.split(' ').filter((wd) => wd.length > 2).sort((p, q) => q.length - p.length);
        let text = words.length ? words[r % words.length] : title;
        let size = 6.5;
        ctx.font = `bold ${size}px sans-serif`;
        if (ctx.measureText(title).width <= avail) text = title;
        while (size > 5 && ctx.measureText(text).width > avail) {
          size -= 0.5;
          ctx.font = `bold ${size}px sans-serif`;
        }
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, top + 3, w, h - 6);
        ctx.clip();
        ctx.translate(x + w / 2, top + h / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillStyle = titleInkFor(color);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, 0, 0.3);
        ctx.restore();
        x += w + 0.8;
      }
      drawRoundRect(ctx, -inner, shelfY - 3, inner * 2, 3, 1, shadeColor(baseColor, 0.3));
    }
  }

  function drawReturnCartDetail(half) {
    // "RETURNS" sign.
    drawRoundRect(ctx, -22, -half + 6, 44, 13, 4, '#fdf8ee');
    ctx.fillStyle = '#8a5a3a';
    ctx.font = 'bold 8px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('RETURNS', 0, -half + 12.5);
    const metal = '#8a6a4a';
    // Upright posts + push handle.
    drawRoundRect(ctx, -28, -16, 4, 40, 2, metal);
    drawRoundRect(ctx, 24, -16, 4, 40, 2, metal);
    drawRoundRect(ctx, 24, -22, 12, 4, 2, metal);
    // Two trays.
    for (const ty of [-2, 20]) drawRoundRect(ctx, -30, ty, 60, 5, 2, '#a57a52');
    // Books on each tray: upright spines, one leaning.
    const books = [['#5b6cc0', 14], ['#d65a6a', 17], ['#e8b95a', 12], ['#6aa37a', 16], ['#8a5aa0', 13]];
    books.forEach(([color, h], i) => drawRoundRect(ctx, -24 + i * 9, -2 - h, 7, h, 1, color));
    ctx.save();
    ctx.translate(20, -2);
    ctx.rotate(0.35);
    drawRoundRect(ctx, -7, -14, 7, 14, 1, '#c47f4e');
    ctx.restore();
    [['#e8b95a', 13], ['#5b6cc0', 15], ['#6aa37a', 11]].forEach(([color, h], i) => drawRoundRect(ctx, -22 + i * 9, 20 - h, 7, h, 1, color));
    drawRoundRect(ctx, 6, 13, 18, 7, 1.5, '#d65a6a'); // a book lying flat
    // Wheels.
    for (const wx of [-22, 22]) {
      ctx.fillStyle = '#3a2a2a';
      ctx.beginPath();
      ctx.arc(wx, 30, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#c9b29a';
      ctx.beginPath();
      ctx.arc(wx, 30, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawFrontDeskDetail(half) {
    // Desk: a wood front panel with a lighter countertop lip.
    drawRoundRect(ctx, -half + 4, -2, half * 2 - 8, half - 2, 6, '#b9824f');
    drawRoundRect(ctx, -half + 2, -6, half * 2 - 4, 7, 3, '#d9a66b');
    for (const px of [-half + 12, 6]) {
      ctx.strokeStyle = 'rgba(90,55,30,0.35)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(px, 7, half - 18, half - 18);
    }
    // Computer monitor on the desk.
    drawRoundRect(ctx, -28, -half + 8, 30, 22, 3, '#4a4a55');
    drawRoundRect(ctx, -25.5, -half + 10.5, 25, 16, 2, '#bcdcf2');
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillRect(-23, -half + 13, 10, 2);
    ctx.fillRect(-23, -half + 17, 15, 2);
    drawRoundRect(ctx, -16, -half + 30, 6, 6, 1, '#4a4a55');
    // A stack of books and a service bell.
    [['#5b6cc0', 0], ['#d65a6a', 1], ['#6aa37a', 2]].forEach(([color, i]) => drawRoundRect(ctx, 10 - i, -12 - i * 6, 20, 5.5, 1.5, color));
    ctx.fillStyle = '#e0a83a';
    ctx.beginPath();
    ctx.arc(-half + 14, -6, 6, Math.PI, 0);
    ctx.fill();
    ctx.fillRect(-half + 13, -14, 2, 3);
    drawRoundRect(ctx, -half + 6, -7, 16, 2.5, 1, '#8a6a4a');
    // A little potted plant on the desk's right corner.
    drawRoundRect(ctx, 30, -14, 8, 8, 2, '#c47f4e');
    ctx.fillStyle = '#6aa37a';
    for (const [dx, dy, r] of [[34, -18, 4], [31, -21, 3], [37, -22, 3]]) {
      ctx.beginPath();
      ctx.arc(dx, dy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawFinesCounterDetail(half) {
    // "FINES" plaque.
    drawRoundRect(ctx, -18, -half + 6, 36, 13, 4, '#fdf8ee');
    ctx.fillStyle = '#a0503a';
    ctx.font = 'bold 8px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('FINES', 0, -half + 12.5);
    // Counter top.
    drawRoundRect(ctx, -half + 4, 14, half * 2 - 8, half - 18, 5, '#c98a6a');
    drawRoundRect(ctx, -half + 2, 11, half * 2 - 4, 6, 3, '#e3a98a');
    // Cash register: angled display, body, keypad, cash drawer.
    drawRoundRect(ctx, -10, -18, 30, 8, 2, '#5a4a4a');
    drawRoundRect(ctx, -7, -16.5, 16, 5, 1, '#9fe0a8');
    drawRoundRect(ctx, -14, -10, 38, 21, 4, '#7a6a6a');
    ctx.fillStyle = '#fdf8ee';
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) ctx.fillRect(-9 + c * 6, -6 + r * 4.5, 4, 3);
    }
    drawRoundRect(ctx, -16, 6, 42, 6, 2, '#5a4a4a');
    // Coin stacks.
    for (const [cx, n] of [[-28, 4], [-21, 2]]) {
      for (let i = 0; i < n; i++) {
        ctx.fillStyle = i % 2 ? '#e8b95a' : '#f2d98a';
        ctx.beginPath();
        ctx.ellipse(cx, 8 - i * 3.5, 5, 2.2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(138,90,40,0.6)';
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }
    }
  }

  function drawCoffeeMachineDetail(half) {
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

  function drawBossOfficeDetail(half) {
    // A paneled office door with a brass name plaque and knob.
    drawRoundRect(ctx, -half + 12, -half + 8, half * 2 - 24, half * 2 - 8, [6, 6, 0, 0], 'rgba(90,60,90,0.18)');
    ctx.strokeStyle = 'rgba(90,60,90,0.28)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-half + 18, -half + 26, half * 2 - 36, 22);
    ctx.strokeRect(-half + 18, 10, half * 2 - 36, 22);
    drawRoundRect(ctx, -16, -half + 12, 32, 10, 2, '#e8cf8a');
    ctx.fillStyle = '#8a6a3a';
    ctx.font = 'bold 7px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('BOSS', 0, -half + 17.5);
    ctx.fillStyle = '#c9a24a';
    ctx.beginPath();
    ctx.arc(half - 20, 4, 3.2, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawReadingNookDetail(half) {
    // A round rug, a cozy armchair, a floor lamp, and an open book.
    ctx.fillStyle = '#c9a7d1';
    ctx.beginPath();
    ctx.ellipse(0, half - 14, half - 8, 9, 0, 0, Math.PI * 2);
    ctx.fill();
    drawRoundRect(ctx, -24, -14, 36, 26, 9, '#c47f4e');
    drawRoundRect(ctx, -22, 4, 32, 14, 5, '#d99a6a');
    drawRoundRect(ctx, -30, -2, 10, 24, 5, '#b06e42');
    drawRoundRect(ctx, 8, -2, 10, 24, 5, '#b06e42');
    ctx.fillStyle = '#7a4a2a';
    ctx.fillRect(-26, 21, 3, 6);
    ctx.fillRect(13, 21, 3, 6);
    const glow = ctx.createRadialGradient(28, -26, 2, 28, -26, 22);
    glow.addColorStop(0, 'rgba(255,230,150,0.75)');
    glow.addColorStop(1, 'rgba(255,230,150,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(28, -26, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#5a4a3a';
    ctx.fillRect(27, -24, 2.5, 46);
    drawRoundRect(ctx, 22, 21, 13, 3, 1.5, '#5a4a3a');
    ctx.fillStyle = '#f2d98a';
    ctx.beginPath();
    ctx.moveTo(20, -24);
    ctx.lineTo(36, -24);
    ctx.lineTo(32, -36);
    ctx.lineTo(24, -36);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#fdf8ee';
    ctx.beginPath();
    ctx.moveTo(-8, -6);
    ctx.quadraticCurveTo(-3, -9, 0, -6);
    ctx.quadraticCurveTo(3, -9, 8, -6);
    ctx.lineTo(8, 1);
    ctx.quadraticCurveTo(3, -2, 0, 1);
    ctx.quadraticCurveTo(-3, -2, -8, 1);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(58,42,42,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(0, 1);
    ctx.stroke();
  }

  function drawStairsDetail(half, station) {
    // Steps rising toward the top of the box, each a lighter tread with a
    // darker riser, plus a handrail and an up/down direction badge.
    const steps = 5;
    const stepH = (half * 2 - 16) / steps;
    for (let i = 0; i < steps; i++) {
      const y = half - 8 - (i + 1) * stepH;
      const inset = 8 + i * 2.5;
      drawRoundRect(ctx, -half + inset, y, half * 2 - inset * 2, stepH, 2, shadeColor('#b8cde0', 0.15 + i * 0.1));
      ctx.fillStyle = 'rgba(58,70,90,0.28)';
      ctx.fillRect(-half + inset, y + stepH - 3, half * 2 - inset * 2, 3);
    }
    ctx.strokeStyle = '#8a6a4a';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-half + 7, half - 10);
    ctx.lineTo(-half + 17, -half + 10);
    ctx.stroke();
    ctx.lineCap = 'butt';
    const goingUp = (station.targetFloor ?? 0) > (station.floor ?? 0);
    drawRoundRect(ctx, half - 22, -half + 5, 17, 17, 8.5, '#fdf8ee');
    ctx.fillStyle = '#5a6a80';
    ctx.beginPath();
    const ay = -half + 13.5;
    const dir = goingUp ? -1 : 1;
    ctx.moveTo(half - 13.5, ay + dir * 5);
    ctx.lineTo(half - 18.5, ay - dir * 3);
    ctx.lineTo(half - 8.5, ay - dir * 3);
    ctx.closePath();
    ctx.fill();
  }

  function drawElevatorDetail(half, station) {
    // Floor indicator over the doorway.
    drawRoundRect(ctx, -14, -half + 5, 28, 11, 4, '#3a3440');
    ctx.fillStyle = '#f2d98a';
    ctx.font = 'bold 8px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const goingUp = (station.targetFloor ?? 0) > (station.floor ?? 0);
    ctx.fillText(`${goingUp ? '▲' : '▼'} ${station.targetFloor ?? ''}`, 0, -half + 11);
    // Steel door frame + two sliding doors with a center seam.
    drawRoundRect(ctx, -26, -half + 19, 52, half * 2 - 25, 4, '#d8dde3');
    drawRoundRect(ctx, -23, -half + 22, 22.5, half * 2 - 28, 2, '#aab4bf');
    drawRoundRect(ctx, 0.5, -half + 22, 22.5, half * 2 - 28, 2, '#aab4bf');
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(-20, -half + 24, 3, half * 2 - 34);
    ctx.fillRect(3.5, -half + 24, 3, half * 2 - 34);
    // Call-button panel.
    drawRoundRect(ctx, 29, -6, 8, 16, 3, '#d8dde3');
    ctx.fillStyle = '#e0a83a';
    ctx.beginPath();
    ctx.arc(33, 2, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }

  const STATION_DETAIL_DRAWERS = {
    bookshelf: drawBookshelfDetail,
    'return-cart': drawReturnCartDetail,
    'front-desk': drawFrontDeskDetail,
    'fines-counter': drawFinesCounterDetail,
    'coffee-machine': drawCoffeeMachineDetail,
    'boss-office': drawBossOfficeDetail,
    'reading-nook': drawReadingNookDetail,
  };

  /**
   * Draws one station's box. `opts` is First Person's billboard hook (doc's
   * "draw it via the *same* existing drawing functions... whatever
   * function(s) draw station boxes"): passing `opts.scale`/`centerX`/
   * `centerY` draws this exact same art scaled and positioned anywhere on
   * screen instead of at the station's own world x/y, via a single
   * `ctx.scale` transform rather than rewriting every fixed pixel offset
   * below — Top-Down's own call site (`drawStation(station)`, no opts)
   * renders byte-for-byte as before (scale 1, centered on the station's own
   * world position, hover/target highlight and label both still apply).
   * `opts.skipLabel` skips the on-canvas label chip — First Person shows the
   * same text via `#library-interact-hint` instead (see `updateHoverHint`),
   * since a label chip glued to a shrinking/growing billboard reads poorly
   * at a distance.
   */
  function drawStation(station, opts = {}) {
    const billboard = opts.scale !== undefined;
    const scale = opts.scale ?? 1;
    const isHovered = !billboard && hoverStation && hoverStation.id === station.id;
    const isTarget = !billboard && moveTarget && moveTarget.station && moveTarget.station.id === station.id;
    const half = station.size / 2;
    const genre = station.kind === 'bookshelf' ? findGenre(station.genreId) : null;
    const baseColor = genre ? genre.color : (STATION_COLORS[station.kind] || '#8a6a4a');
    // Locked all shift and through the closing wait — v2.13: it used to
    // *look* unlocked during the 20 s closing wait while arriving did
    // nothing (user: "when i want to get into the bosses office i cannot").
    const locked = station.kind === 'boss-office' && shiftState
      && (shiftState.phase === 'playing' || (shiftState.phase === 'closing-wait' && !isBossOfficeReady(shiftState)));
    const cx = opts.centerX ?? station.x;
    const cy = opts.centerY ?? station.y;

    ctx.save();
    ctx.translate(Math.round(cx), Math.round(cy));
    ctx.scale(scale, scale);

    if (station.kind === 'elevator') {
      // Visually distinct from Stairs (below) — a rounded shape with
      // "doors" down the middle, reading as a different fixture at a
      // glance (doc's "so they read as two different fixtures").
      drawRoundRect(ctx, -half, -half, station.size, station.size, 16, baseColor);
      drawElevatorDetail(half, station);
    } else if (station.kind === 'stairs') {
      drawRoundRect(ctx, -half, -half, station.size, station.size, 6, baseColor);
      drawStairsDetail(half, station);
    } else {
      drawRoundRect(ctx, -half, -half, station.size, station.size, 10, locked ? '#b8b0b8' : baseColor);
      const detail = STATION_DETAIL_DRAWERS[station.kind];
      if (detail) detail(half, station, baseColor);
      if (locked) {
        // A padlock badge over the (greyed) office door.
        drawRoundRect(ctx, -14, -12, 28, 28, 14, 'rgba(255,251,246,0.92)');
        ctx.strokeStyle = '#5a5060';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, -2, 5.5, Math.PI, 0);
        ctx.stroke();
        drawRoundRect(ctx, -7.5, 1, 15, 11, 3, '#5a5060');
      }
    }

    ctx.strokeStyle = isTarget ? '#e0a83a' : (isHovered ? '#7fb0d6' : 'rgba(58,42,42,0.3)');
    ctx.lineWidth = isTarget || isHovered ? 3 : 2;
    ctx.beginPath();
    ctx.roundRect(-half + 1, -half + 1, station.size - 2, station.size - 2, 8);
    ctx.stroke();

    if (!opts.skipLabel) {
      const label = labelForStation(station);
      if (label) {
        const labelBelowFits = cy + half + 13 + 7 <= CANVAS_HEIGHT;
        drawLabelChip(ctx, 0, labelBelowFits ? half + 13 : -half - 13, label, 'bold 11px sans-serif');
      }
    }

    ctx.restore();
  }

  function drawReturnCartBooks() {
    if (currentFloor !== FLOOR_1) return;
    for (const book of returnCartSlots()) {
      const genre = findGenre(book.genreId);
      const color = genre ? genre.color : '#8a6a4a';
      const { x: coverX, y: coverY, w: coverW, h: coverH } = returnCartCoverRect(book);
      drawRoundRect(ctx, coverX, coverY, coverW, coverH, 2, color);
      ctx.fillStyle = 'rgba(255,251,246,0.5)';
      ctx.fillRect(coverX, coverY, 3, coverH);
      // Full title on the front cover (user: "add the title names on each
      // books") — wrapped and shrunk to fit rather than v1.4's first-four-
      // words-then-crop, which cut titles off at the cover's edges.
      if (book.title) drawCoverTitle(ctx, book.title, coverX + 3, coverY, coverW - 3, coverH, color, { maxFont: 7.5, minFont: 5 });
      if (book.isCoinHunt) drawStar(ctx, coverX + coverW - 2, coverY + 1, 5, 2, '#f2d98a');
    }
    const cart = stations.find((s) => s.kind === 'return-cart');
    if (shiftState && shiftState.returnCart.length > 5) {
      drawLabelChip(ctx, cart.x, cart.y + cart.size / 2 + 72, `+${shiftState.returnCart.length - 5} more`, 'bold 10px sans-serif');
    }
    // v2.18: a messy cart drains Mood — say so, pulsing red.
    if (shiftState && shiftState.phase === 'playing' && shiftState.returnCart.length > MESSY_CART_THRESHOLD) {
      const pulse = 0.85 + 0.15 * Math.sin(performance.now() / 200);
      ctx.save();
      ctx.globalAlpha = pulse;
      const warnY = cart.y + cart.size / 2 + 94; // below the covers and the "+N more" chip
      drawRoundRect(ctx, cart.x - 70, warnY - 9, 140, 18, 9, '#e06a5b');
      ctx.fillStyle = '#fdf8ee';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Messy cart! Mood dropping', cart.x, warnY);
      ctx.restore();
    }
  }

  const SLOT_PERSONALITY_CACHE = new Map();
  function personalityForSlot(slot, index) {
    if (slot.kind === 'karen') return 'karen';
    if (!SLOT_PERSONALITY_CACHE.has(slot.id)) SLOT_PERSONALITY_CACHE.set(slot.id, personalityForId(slot.id));
    return SLOT_PERSONALITY_CACHE.get(slot.id);
  }

  function drawFinesCounterSlots() {
    if (currentFloor !== FLOOR_1) return;
    finesCounterSlots().forEach((slot, i) => {
      drawLibraryPerson(ctx, slot.x, slot.y, { personalityKey: personalityForSlot(slot, i), scale: 0.62 });
      drawStar(ctx, slot.x + 15, slot.y - 44, 6, 2.5, '#f2d98a');
      drawPatienceBar(slot, slot.waitFraction);
      drawLabelChip(ctx, slot.x, slot.y + 20, `${slot.amountGard}g`, 'bold 9px sans-serif');
    });
    const waiting = shiftState?.finesQueue.length || 0;
    if (waiting > SLOT_VISIBLE_MAX) {
      const counter = stations.find((s) => s.kind === 'fines-counter');
      drawLabelChip(ctx, counter.x, counter.y + counter.size / 2 + QUEUE_SLOT_OFFSET_Y + 50, `+${waiting - SLOT_VISIBLE_MAX} waiting`, 'bold 10px sans-serif');
    }
  }

  function drawFrontDeskSlots() {
    if (currentFloor !== FLOOR_1) return;
    const slots = frontDeskSlots();
    slots.forEach((slot, i) => {
      const personality = personalityForSlot(slot, i);
      if (slot.kind === 'ghost') {
        ctx.save();
        ctx.globalAlpha = 0.35 + 0.2 * Math.sin(performance.now() / 90);
        drawLibraryPerson(ctx, slot.x + Math.sin(performance.now() / 140) * 2, slot.y, { personalityKey: personality, scale: 0.62 });
        ctx.restore();
        drawLabelChip(ctx, slot.x, slot.y + 20, '???', 'bold 9px sans-serif');
        return;
      }
      drawLibraryPerson(ctx, slot.x, slot.y, { personalityKey: personality, scale: 0.62, angryTint: slot.kind === 'karen' });
      if (slot.kind === 'borrow-active') {
        if (slot.stage === 'searching') {
          // Patience bar over their head, green -> amber -> red.
          drawPatienceBar(slot, slot.patienceFraction);
          drawLabelChip(ctx, slot.x, slot.y + 20, 'Waiting', 'bold 9px sans-serif');
        } else {
          drawLabelChip(ctx, slot.x, slot.y + 20, 'Check out!', 'bold 9px sans-serif');
        }
      } else if (slot.kind === 'borrow') {
        drawPatienceBar(slot, slot.waitFraction);
        const entry = bookCatalog.get(slot.bookId);
        const genre = entry ? findGenre(entry.genreId) : null;
        drawRoundRect(ctx, slot.x + 11, slot.y - 52, 10, 14, 1, genre ? genre.color : '#8a6a4a');
        // Front-desk slots sit only 46px apart (frontDeskSlots) — a full
        // title's label chip (drawLabelChip auto-sizes to text width, no
        // wrapping) can run wider than that and spill into the
        // neighboring slot's own chip, same class of overflow bug as the
        // Return Cart covers above. Truncated to a short, single-word-ish
        // snippet that reliably stays inside one slot's width instead.
        if (entry?.title) drawLabelChip(ctx, slot.x, slot.y + 20, truncateForChip(ctx, entry.title, 40, 'bold 9px sans-serif'), 'bold 9px sans-serif');
      } else if (slot.kind === 'karen') {
        drawLabelChip(ctx, slot.x, slot.y + 20, 'Karen!', 'bold 10px sans-serif');
      }
    });
    const total = shiftState?.borrowQueue.length || 0;
    const shown = Math.min(total, SLOT_VISIBLE_MAX);
    if (total > shown) {
      const desk = stations.find((s) => s.kind === 'front-desk');
      drawLabelChip(ctx, desk.x, desk.y + desk.size / 2 + QUEUE_SLOT_OFFSET_Y + 50, `+${total - shown} waiting`, 'bold 10px sans-serif');
    }
  }

  function currentPlayerBadge() {
    if (shiftState?.carriedBook) {
      const genre = findGenre(shiftState.carriedBook.genreId);
      return { color: genre ? genre.color : '#8a6a4a', kind: 'book' };
    }
    if (shiftState?.carriedFine) return { color: '#f2d98a', kind: 'coin' };
    if (shiftState?.activeBorrow?.stage === 'checkout') {
      const entry = bookCatalog.get(shiftState.activeBorrow.bookId);
      const genre = entry ? findGenre(entry.genreId) : null;
      return { color: genre ? genre.color : '#8a6a4a', kind: 'book' };
    }
    return null;
  }

  // Set by `drawPlayer` (Top-Down only — First Person never calls it, per
  // the doc's "the player's own sprite is never drawn in this mode"), reset
  // false at the top of every `render()`. Exists so a test can assert this
  // directly (`window.__libraryGameTestHooks.wasPlayerSpriteDrawnLastFrame`)
  // rather than inferring it from pixel sampling.
  let lastFrameDrewPlayerSprite = false;

  function drawPlayer() {
    lastFrameDrewPlayerSprite = true;
    const sanity = shiftState ? shiftState.sanity : SANITY_MAX;
    const stress = sanity < HALLUCINATION_START_SANITY ? (HALLUCINATION_START_SANITY - sanity) / HALLUCINATION_START_SANITY : 0;
    drawLibraryPerson(ctx, player.x, player.y, { personalityKey: 'librarian', scale: 1, stress });
    drawCoffeeSplash();
    drawLabelChip(ctx, player.x, player.y + 24, PLAYER_NAME, 'bold 10px sans-serif');
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

  // v2.15 Gard counter (user: "something ... keeping track of your gard"):
  // this shift's bonus Gard (tips, fines, Coin Hunt, Karen) plus the
  // month-to-date total banked from earlier shifts, with a floating "+N"
  // pop each time bonusGard goes up. The shift's base pay isn't included
  // until the paycheck, since it depends on mistakes and the rating.
  let lastSeenBonusGard = 0;
  let gardPops = [];

  /** This shift's Gard so far: bonuses minus complaint letters (v2.17). */
  function netShiftGard() {
    return shiftState ? shiftState.bonusGard - (shiftState.complaints ?? 0) * COMPLAINT_GARD : 0;
  }

  function trackGardPops(deltaSeconds) {
    const net = netShiftGard();
    if (net !== lastSeenBonusGard) gardPops.push({ amount: net - lastSeenBonusGard, age: 0 });
    lastSeenBonusGard = net;
    gardPops = gardPops.map((pop) => ({ ...pop, age: pop.age + deltaSeconds })).filter((pop) => pop.age < 1.4);
  }

  function drawGardCounter() {
    const bonus = netShiftGard();
    const x = 264;
    const y = 14;
    const w = 176;
    const h = 22;
    drawRoundRect(ctx, x, y, w, h, 11, 'rgba(255,251,246,0.85)');
    // Mini Gard coin.
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
    ctx.fillText(`${bonus >= 0 ? '+' : '−'}${Math.abs(bonus)}g shift`, x + 26, y + 11.5);
    ctx.font = '10px sans-serif';
    ctx.fillStyle = 'rgba(58,42,42,0.7)';
    ctx.textAlign = 'right';
    ctx.fillText(`Month ${save.monthToDateGard}g`, x + w - 9, y + 11.5);
    // "+N" pops float up and fade.
    for (const pop of gardPops) {
      const t = pop.age / 1.4;
      ctx.globalAlpha = 1 - t;
      ctx.font = 'bold 15px sans-serif';
      ctx.textAlign = 'left';
      const popY = y + h + 20 - t * 10;
      ctx.strokeStyle = '#fdf8ee';
      ctx.lineWidth = 3.5;
      ctx.lineJoin = 'round';
      const popText = `${pop.amount >= 0 ? '+' : '−'}${Math.abs(pop.amount)}g`;
      ctx.strokeText(popText, x + 26, popY);
      ctx.fillStyle = pop.amount >= 0 ? '#b07a1e' : '#c0392b';
      ctx.fillText(popText, x + 26, popY);
      ctx.globalAlpha = 1;
    }
  }

  /** v2.9 star rating, drawn to the right of the Sanity/Mood bars: five stars with half-star fills. */
  function drawRatingStars() {
    const rating = shiftState ? shiftState.rating : RATING_MAX;
    const x0 = 152;
    const cy = 25;
    drawRoundRect(ctx, x0 - 4, cy - 11, 5 * 20 + 8, 22, 11, 'rgba(255,251,246,0.85)');
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
    const zone = skillCheckSuccessZone(shakyHandsZoneScale(currentIntensity()));
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

  /**
   * A Gard coin or Gard bill (v2.14 redesign — user: "i want the designs to
   * be better for the coins and gard"). Coins: a gold disc with a raised
   * rim, an inner ring, an embossed "G" and a shine. Bills: a green banknote
   * with an inner border, a "G" seal and corner denominations, tilted a
   * little per item so a scatter doesn't look stamped. Both cast a soft
   * shadow. Shared by Coin Hunt and Fines Sort.
   */
  function drawCoinIcon(x, y, isBill, seed = 0) {
    ctx.save();
    if (isBill) {
      const tilt = (((seed * 37) % 11) - 5) * 0.045;
      ctx.translate(x, y);
      ctx.rotate(tilt);
      const w = 38;
      const h = 20;
      drawRoundRect(ctx, -w / 2 + 2, -h / 2 + 3, w, h, 3, 'rgba(58,42,42,0.18)');
      drawRoundRect(ctx, -w / 2, -h / 2, w, h, 3, '#8cc48a');
      ctx.strokeStyle = '#4f8a52';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(-w / 2, -h / 2, w, h, 3);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(240,250,232,0.85)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(-w / 2 + 3, -h / 2 + 3, w - 6, h - 6, 2);
      ctx.stroke();
      // Center seal.
      ctx.fillStyle = '#e8f4dc';
      ctx.beginPath();
      ctx.ellipse(0, 0, 6.5, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#4f8a52';
      ctx.stroke();
      ctx.fillStyle = '#3f7a46';
      ctx.font = 'bold 8px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('G', 0, 0.5);
      // Corner denominations.
      ctx.font = 'bold 5.5px sans-serif';
      ctx.fillText('10', -w / 2 + 7, -h / 2 + 6);
      ctx.fillText('10', w / 2 - 7, h / 2 - 5.5);
    } else {
      const r = 12;
      ctx.fillStyle = 'rgba(58,42,42,0.2)';
      ctx.beginPath();
      ctx.ellipse(x + 1.5, y + 3, r, r * 0.9, 0, 0, Math.PI * 2);
      ctx.fill();
      // Rim, then a gradient face.
      ctx.fillStyle = '#c28a2c';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      const face = ctx.createRadialGradient(x - 3, y - 4, 1, x, y, r - 1.5);
      face.addColorStop(0, '#fff2bf');
      face.addColorStop(0.55, '#f2cf6a');
      face.addColorStop(1, '#dca842');
      ctx.fillStyle = face;
      ctx.beginPath();
      ctx.arc(x, y, r - 1.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(160,110,30,0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, r - 4.2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#a8741e';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('G', x, y + 0.5);
      // Shine.
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 1.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(x, y, r - 3, Math.PI * 1.1, Math.PI * 1.45);
      ctx.stroke();
    }
    ctx.restore();
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
    const huntTitle = shiftState?.carriedBook?.title;
    if (huntTitle) ctx.font = 'bold 16px sans-serif'; // a bit smaller than the plain header, to keep the longest titles on one line within the box
    ctx.fillText(
      huntTitle ? `Coin Hunt — "${huntTitle}" — find every coin and bill` : 'Coin Hunt — find every coin and bill',
      CANVAS_WIDTH / 2,
      170,
    );
    for (const item of overlay.items) {
      if (item.found) continue;
      drawCoinIcon(item.x, item.y, item.isBill, item.id);
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
      if (item.real) drawCoinIcon(item.x, item.y, item.isBill, item.id);
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
    const wanted = overlay.items.find((it) => it.correct)?.title;
    if (wanted) {
      ctx.font = 'bold 15px sans-serif';
      ctx.fillStyle = '#c65f7c';
      ctx.fillText(`Looking for: “${wanted}”`, CANVAS_WIDTH / 2, 194);
    }
    for (const item of overlay.items) {
      drawRoundRect(ctx, item.x - 20, item.y - 14, 40, 28, 3, item.color);
      drawCoverTitle(ctx, item.title, item.x - 20, item.y - 14, 40, 28, item.color, { maxLines: 3, maxFont: 9, minFont: 6 });
    }
  }

  /** Greedy word-wrap of `text` into lines no wider than `maxWidth` at the current ctx.font. */
  function wrapLines(text, maxWidth) {
    const lines = [];
    let line = '';
    for (const word of text.split(' ')) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  function drawReadingOverlay() {
    drawOverlayBackdrop();
    const cx = CANVAS_WIDTH / 2;
    drawRoundRect(ctx, cx - 330, 94, 660, 440, 18, '#f2e9da');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = LABEL_TEXT_COLOR;
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText(`“${overlay.title}”`, cx, 126);
    ctx.font = '12px sans-serif';
    ctx.fillText('Read at your own pace. → / Space / Enter / click turns the page, ← goes back.', cx, 146);

    const close = readingCloseRect();
    drawRoundRect(ctx, close.x, close.y, close.w, close.h, 15, 'rgba(58,42,42,0.12)');
    ctx.fillStyle = LABEL_TEXT_COLOR;
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText('×', close.x + close.w / 2, close.y + 21);

    // Open book: two cream pages with a spine shadow and the story's text.
    const bookY = 160;
    const pageW = 290;
    const pageH = 300;
    drawRoundRect(ctx, cx - pageW - 10, bookY - 6, pageW * 2 + 20, pageH + 12, 10, '#8a5a3a');
    drawRoundRect(ctx, cx - pageW, bookY, pageW, pageH, [8, 2, 2, 8], '#fdf8ee');
    drawRoundRect(ctx, cx, bookY, pageW, pageH, [2, 8, 8, 2], '#fdf8ee');
    const spine = ctx.createLinearGradient(cx - 14, 0, cx + 14, 0);
    spine.addColorStop(0, 'rgba(58,42,42,0)');
    spine.addColorStop(0.5, 'rgba(58,42,42,0.22)');
    spine.addColorStop(1, 'rgba(58,42,42,0)');
    ctx.fillStyle = spine;
    ctx.fillRect(cx - 14, bookY, 28, pageH);

    const story = READING_STORIES[overlay.storyIndex];
    ctx.textAlign = 'left';
    ctx.fillStyle = '#3a2a2a';
    ctx.font = '17px Georgia, "Times New Roman", serif';
    for (const side of [0, 1]) {
      const pageIndex = overlay.page * 2 + side;
      const text = story.pages[pageIndex] ?? '';
      const x0 = side === 0 ? cx - pageW + 24 : cx + 24;
      wrapLines(text, pageW - 48).forEach((line, i) => ctx.fillText(line, x0, bookY + 42 + i * 25));
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(58,42,42,0.5)';
    ctx.font = '11px sans-serif';
    ctx.fillText(String(overlay.page * 2 + 1), cx - pageW / 2, bookY + pageH - 12);
    ctx.fillText(String(overlay.page * 2 + 2), cx + pageW / 2, bookY + pageH - 12);

    // A slim bar fills over the minimum time per spread; then you may turn.
    const barY = bookY + pageH + 20;
    drawRoundRect(ctx, cx - 120, barY, 240, 6, 3, 'rgba(58,42,42,0.15)');
    drawRoundRect(ctx, cx - 120, barY, 240 * overlay.progress, 6, 3, overlay.progress >= 1 ? '#7fd68a' : '#7fb0d6');
    ctx.fillStyle = LABEL_TEXT_COLOR;
    ctx.font = 'bold 13px sans-serif';
    const isLast = overlay.page >= READING_PAGES - 1;
    const ready = isLast ? 'Close the book when you\'re done →' : 'Turn the page when you\'re ready →';
    const status = overlay.progress >= 1 ? ready : (overlay.nudge > 0 ? 'Take your time — keep reading…' : 'Reading…');
    ctx.fillText(`${status}   (${overlay.page + 1}/${READING_PAGES})`, cx, barY + 26);
  }

  function drawTillCountOverlay() {
    drawOverlayBackdrop();
    const cx = CANVAS_WIDTH / 2;
    drawRoundRect(ctx, 120, 130, CANVAS_WIDTH - 240, 360, 16, '#efe6d8');
    ctx.fillStyle = LABEL_TEXT_COLOR;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText('Count the Till', cx, 165);
    ctx.font = '13px sans-serif';
    ctx.fillText(`Count exactly ${overlay.target} Gard into the till. Tap coins/bills or press 1-4; Undo or Backspace takes one back.`, cx, 187);

    // Running total vs. the fine owed, with a progress bar.
    const total = tillTotal();
    drawRoundRect(ctx, cx - 160, 205, 320, 64, 12, '#3a3440');
    ctx.fillStyle = '#9fe0a8';
    ctx.font = 'bold 30px sans-serif';
    ctx.fillText(`${total} / ${overlay.target}g`, cx, 248);
    drawRoundRect(ctx, cx - 150, 278, 300, 10, 5, 'rgba(58,42,42,0.15)');
    drawRoundRect(ctx, cx - 150, 278, 300 * Math.min(1, total / overlay.target), 10, 5, '#e0a83a');

    // What's been counted so far, as little coin/bill tokens.
    overlay.added.slice(-16).forEach((v, i, arr) => {
      const tx = cx - ((arr.length - 1) * 14) / 2 + i * 14;
      if (v >= 10) drawRoundRect(ctx, tx - 6, 298, 12, 18, 2, v === 20 ? '#7fb08a' : '#9fc4d6');
      else {
        ctx.fillStyle = v === 5 ? '#e0a83a' : '#c9a24a';
        ctx.beginPath();
        ctx.arc(tx, 307, v === 5 ? 6.5 : 5, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    const rects = tillButtonRects();
    rects.denominations.forEach((r, i) => {
      drawRoundRect(ctx, r.x, r.y, r.w, r.h, 12, '#fdf8ee');
      ctx.strokeStyle = 'rgba(58,42,42,0.25)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(r.x, r.y, r.w, r.h, 12);
      ctx.stroke();
      const mx = r.x + r.w / 2;
      const my = r.y + 26;
      if (r.value >= 10) {
        drawRoundRect(ctx, mx - 22, my - 12, 44, 24, 3, r.value === 20 ? '#7fb08a' : '#9fc4d6');
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(mx - 18, my - 8, 36, 16);
      } else {
        ctx.fillStyle = r.value === 5 ? '#e0a83a' : '#c9a24a';
        ctx.beginPath();
        ctx.arc(mx, my, r.value === 5 ? 14 : 11, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(138,90,40,0.6)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.fillStyle = LABEL_TEXT_COLOR;
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText(`${r.value}g`, mx, my + 4);
      ctx.font = '10px sans-serif';
      ctx.fillStyle = 'rgba(58,42,42,0.6)';
      ctx.fillText(`[${i + 1}]`, mx, r.y + r.h - 6);
    });

    const u = rects.undo;
    drawRoundRect(ctx, u.x, u.y, u.w, u.h, 10, overlay.added.length ? '#a08a7a' : 'rgba(160,138,122,0.4)');
    ctx.fillStyle = '#fdf8ee';
    ctx.font = 'bold 13px sans-serif';
    ctx.fillText('Undo', u.x + u.w / 2, u.y + u.h / 2 + 4);

    if (overlay.flash) {
      drawRoundRect(ctx, cx - 90, 468, 180, 28, 14, '#e06a5b');
      ctx.fillStyle = '#fdf8ee';
      ctx.font = 'bold 14px sans-serif';
      ctx.fillText(overlay.flash.text, cx, 487);
    }
  }

  function drawCoffeePourOverlay() {
    drawOverlayBackdrop();
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
    else if (overlay.kind === 'coffee-pour') drawCoffeePourOverlay();
    else if (overlay.kind === 'till-count') drawTillCountOverlay();
    else if (overlay.kind === 'reading') drawReadingOverlay();
  }

  // -- First Person rendering --------------------------------------------

  const FP_HORIZON_Y = CANVAS_HEIGHT / 2;
  const FP_CEILING_COLOR = '#e8ddc8';
  const FP_FLOOR_COLOR_NEAR = '#cbab7c';
  const FP_FLOOR_COLOR_FAR = '#b08f5e';

  /**
   * Doc's Visual Direction for First Person: "a simple background: a
   * floor-color band below a horizon line and a sky/ceiling-color band
   * above it" — no wall texture or raycast, just the two flat bands plus a
   * subtle floor gradient for a cheap sense of depth.
   */
  function drawFirstPersonBackground() {
    ctx.fillStyle = FP_CEILING_COLOR;
    ctx.fillRect(0, 0, CANVAS_WIDTH, FP_HORIZON_Y);

    const floorGradient = ctx.createLinearGradient(0, FP_HORIZON_Y, 0, CANVAS_HEIGHT);
    floorGradient.addColorStop(0, FP_FLOOR_COLOR_NEAR);
    floorGradient.addColorStop(1, FP_FLOOR_COLOR_FAR);
    ctx.fillStyle = floorGradient;
    ctx.fillRect(0, FP_HORIZON_Y, CANVAS_WIDTH, CANVAS_HEIGHT - FP_HORIZON_Y);

    ctx.strokeStyle = 'rgba(58,42,42,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, FP_HORIZON_Y);
    ctx.lineTo(CANVAS_WIDTH, FP_HORIZON_Y);
    ctx.stroke();

    ctx.fillStyle = '#8a6a4a';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(currentFloor === FLOOR_1 ? '1st Floor' : '2nd Floor', CANVAS_WIDTH / 2, 24);
  }

  /**
   * Draws one projected entity (as produced by `first-person.js`'s
   * `projectScene`) via the SAME art functions Top-Down uses —
   * `drawLibraryPerson` for a front-desk patron, `drawStation`'s billboard
   * mode for every station — per the doc's explicit instruction not to
   * reinvent the art for this camera mode. `entity.groundY` is where the
   * entity's ground-contact point sits on screen (first-person.js's
   * perspective stand-in); each branch below anchors its own art to that
   * point using its own known height, same as Top-Down anchors each shape
   * to the station/player's own y.
   */
  function drawFirstPersonEntity(entity) {
    if (entity.entityKind === 'frontDeskSlot' || entity.entityKind === 'finesSlot') {
      const slot = entity.ref;
      const personality = personalityForSlot(slot, entity.slotIndex ?? 0);
      drawLibraryPerson(ctx, entity.screenX, entity.groundY, {
        personalityKey: personality,
        scale: entity.scale * 0.62,
        angryTint: slot.kind === 'karen',
      });
      return;
    }
    if (entity.entityKind === 'returnCartBook') {
      const book = entity.ref;
      const genre = findGenre(book.genreId);
      const w = 18 * entity.scale;
      const h = 24 * entity.scale;
      drawRoundRect(ctx, entity.screenX - w / 2, entity.groundY - h, w, h, 2 * entity.scale, genre ? genre.color : '#8a6a4a');
      return;
    }
    // 'station' — anchor the box's bottom edge (not its center) to groundY,
    // so it visually "stands" on the floor band rather than floating
    // centered on the horizon.
    const station = entity.ref;
    const halfOnScreen = (station.size / 2) * entity.scale;
    drawStation(station, {
      scale: entity.scale,
      centerX: entity.screenX,
      centerY: entity.groundY - halfOnScreen,
      skipLabel: true,
    });
  }

  function drawFirstPersonCrosshair() {
    const cx = CANVAS_WIDTH / 2;
    const cy = CANVAS_HEIGHT / 2;
    const armLength = 9;
    const gap = 3;
    ctx.save();
    ctx.strokeStyle = fpScene.interactTarget ? '#e0a83a' : 'rgba(58,42,42,0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - armLength, cy);
    ctx.lineTo(cx - gap, cy);
    ctx.moveTo(cx + gap, cy);
    ctx.lineTo(cx + armLength, cy);
    ctx.moveTo(cx, cy - armLength);
    ctx.lineTo(cx, cy - gap);
    ctx.moveTo(cx, cy + gap);
    ctx.lineTo(cx, cy + armLength);
    ctx.stroke();
    ctx.restore();
  }

  function drawFirstPersonView() {
    drawFirstPersonBackground();
    // `fpScene.projected` is already sorted back-to-front by
    // `first-person.js`'s `projectScene` — drawing in that order alone
    // gives correct nearer-over-farther layering (simple painter's
    // algorithm), no per-entity z-check needed here.
    for (const entity of fpScene.projected) drawFirstPersonEntity(entity);
    drawFirstPersonCrosshair();
  }

  function render() {
    lastFrameDrewPlayerSprite = false;
    const shake = currentIntensity() > 0.6 ? (currentIntensity() - 0.6) * 5 : 0;
    ctx.save();
    if (shake > 0) ctx.translate((random() - 0.5) * shake, (random() - 0.5) * shake);
    if (cameraMode === 'first-person') {
      drawFirstPersonView();
    } else {
      drawFloor();
      stationsOnFloor(stations, currentFloor).forEach((station) => drawStation(station));
      drawReturnCartBooks();
      drawFrontDeskSlots();
      drawFinesCounterSlots();
      drawPlayer();
    }
    drawHallucinations();
    ctx.restore();
    // Doc's Scope: "Sanity/Mood bars, the HUD clock, and all five minigame
    // overlays are unchanged and must still work identically in First
    // Person Mode" — drawn unconditionally, outside the camera-mode branch
    // above, same as every other frame.
    drawSanityBar();
    drawLibraryMoodBar();
    drawRatingStars();
    drawGardCounter();
    drawOverlay();
  }

  // -- Game loop --------------------------------------------------------------

  function loop(timestamp) {
    if (!running || paused) { rafHandle = null; return; }
    if (lastTimestamp === null) lastTimestamp = timestamp;
    const deltaSeconds = Math.min(0.1, (timestamp - lastTimestamp) / 1000);
    lastTimestamp = timestamp;

    if (!overlay) {
      updatePlayer(deltaSeconds);
      updateFirstPersonMovement(deltaSeconds);
    }

    const beforeBorrowStage = shiftState.activeBorrow?.stage;
    const beforeKarenActive = shiftState.karen.active;
    const beforeWalkouts = shiftState.walkouts;
    const beforeComplaints = shiftState.complaints ?? 0;
    shiftState = tick(shiftState, deltaSeconds, { pauseBorrowPatience: overlay?.kind === 'find-the-book' });

    if (beforeBorrowStage === 'searching' && !shiftState.activeBorrow && overlay?.kind === 'find-the-book') {
      overlay = null;
      showToast('They gave up waiting…');
    }
    if (beforeKarenActive && !shiftState.karen.active && overlay?.kind === 'karen') {
      overlay = null;
      showToast('Karen stormed off without paying.');
    }

    trackGardPops(deltaSeconds);
    coffeeSplashSeconds = Math.max(0, coffeeSplashSeconds - deltaSeconds);
    updateHallucinations(deltaSeconds);

    if (waitingAtBossOffice && isBossOfficeReady(shiftState) && !overlay) {
      if (isPlayerAtBossOffice()) {
        enterBossOfficeNow();
        return;
      }
      waitingAtBossOffice = false;
    }

    if ((shiftState.complaints ?? 0) > beforeComplaints) {
      showToast(`📨 A complaint letter from the boss — −${COMPLAINT_GARD} Gard. The library's mood is at rock bottom.`);
    } else if (shiftState.walkouts > beforeWalkouts) {
      showToast(shiftState.libraryMood <= 0
        ? `A frustrated patron stormed out — −${RATING_PENALTY_PER_WALKOUT}★`
        : `A patron got tired of waiting and left — −${RATING_PENALTY_PER_WALKOUT}★`);
    }

    if (shiftState.phase === 'playing') processScheduledEvents();

    updateOverlay(deltaSeconds);
    updateFirstPersonScene();
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
  canvas.addEventListener('pointerdown', onCanvasPointerDown);
  window.addEventListener('pointerup', onWindowPointerUp);
  window.addEventListener('pointercancel', onWindowPointerUp);
  canvas.addEventListener('mousemove', onCanvasMouseMove);
  canvas.addEventListener('mouseleave', onCanvasMouseLeave);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  document.addEventListener('visibilitychange', onVisibilityChange);
  elements.fullscreenButton.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  elements.floorButton?.addEventListener('click', () => switchFloor(currentFloor === FLOOR_1 ? FLOOR_2 : FLOOR_1));
  elements.cameraButton?.addEventListener('click', () => setCameraMode(cameraMode === 'top-down' ? 'first-person' : 'top-down'));

  // First Person's on-screen turn/move buttons (doc: "on-screen buttons (for
  // parity with the existing on-screen Fullscreen/floor-switch buttons)") —
  // press-and-hold, same continuous-while-held feel as the arrow keys
  // (`onKeyDown`/`onKeyUp`), not a one-shot click. Pointer events cover
  // mouse and touch alike; `pointerleave`/`pointercancel` guard against a
  // press that ends by the pointer sliding off the button rather than a
  // clean release, which would otherwise leave the direction stuck "held."
  function bindHoldButton(button, key) {
    if (!button) return;
    const press = (e) => { e.preventDefault(); heldFP[key] = true; };
    const release = () => { heldFP[key] = false; };
    button.addEventListener('pointerdown', press);
    button.addEventListener('pointerup', release);
    button.addEventListener('pointerleave', release);
    button.addEventListener('pointercancel', release);
  }
  bindHoldButton(elements.fpControls?.turnLeftButton, 'turnLeft');
  bindHoldButton(elements.fpControls?.turnRightButton, 'turnRight');
  bindHoldButton(elements.fpControls?.forwardButton, 'forward');
  bindHoldButton(elements.fpControls?.backButton, 'back');
  elements.fpControls?.interactButton?.addEventListener('click', attemptInteract);

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
    canvas.removeEventListener('pointerdown', onCanvasPointerDown);
    window.removeEventListener('pointerup', onWindowPointerUp);
    window.removeEventListener('pointercancel', onWindowPointerUp);
    canvas.removeEventListener('mousemove', onCanvasMouseMove);
    canvas.removeEventListener('mouseleave', onCanvasMouseLeave);
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
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
      setPlayerPosition: (x, y) => { player.x = x; player.y = y; },
      isPlayerMoving: () => moveTarget !== null,
      getCurrentFloor: () => currentFloor,
      getStations: () => stations.map((s) => ({ ...s })),
      getFrontDeskSlots: () => frontDeskSlots(),
      getFinesCounterSlots: () => finesCounterSlots(),
      getFinesStartShift: () => finesStartShiftNumber,
      getTillButtonRects: () => tillButtonRects(),
      getReturnCartSlots: () => returnCartSlots(),
      getOverlay: () => (overlay ? JSON.parse(JSON.stringify(overlay)) : null),
      // First Person Mode hooks — same "expose exact state, drive the real
      // input path" spirit as the rest of this object: tests call
      // `setCameraMode`/`setPlayerFacing` to get into a known camera/facing
      // state without hunting for the right turn amount, then still drive
      // the SAME `attemptInteract`/keyboard/on-screen-button paths a real
      // player uses for movement and interaction.
      getCameraMode: () => cameraMode,
      setCameraMode: (mode) => setCameraMode(mode),
      getPlayerFacing: () => playerFacing,
      setPlayerFacing: (facing) => { playerFacing = facing; },
      getFirstPersonScene: () => JSON.parse(JSON.stringify(fpScene)),
      attemptInteractNow: () => attemptInteract(),
      wasPlayerSpriteDrawnLastFrame: () => lastFrameDrewPlayerSprite,
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
      finishReadingPageNow() { if (overlay?.kind === 'reading') overlay.progress = 1; },
      getGardPops: () => gardPops.map((pop) => ({ ...pop })),
      getHallucinations: () => ({ intensity: currentIntensity(), ghosts: halluc.ghosts.map((g) => ({ ...g })), figures: halluc.figures.length, whispers: halluc.whispers.length }),
      spawnGhostPatronNow() { halluc.ghosts.push({ id: `ghost-${halluc.ghostCounter++}`, age: 0, life: 60 }); },
      setCoffeePourFill(fill) { if (overlay?.kind === 'coffee-pour' && !overlay.grade) overlay.fill = fill; },
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
    cameraButton: document.getElementById('library-camera-button'),
    fpControls: {
      root: document.getElementById('library-fp-controls'),
      turnLeftButton: document.getElementById('library-fp-turn-left-button'),
      turnRightButton: document.getElementById('library-fp-turn-right-button'),
      forwardButton: document.getElementById('library-fp-forward-button'),
      backButton: document.getElementById('library-fp-back-button'),
      interactButton: document.getElementById('library-fp-interact-button'),
    },
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
