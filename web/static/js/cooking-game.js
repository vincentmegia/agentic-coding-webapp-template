// Kitchen Shift canvas engine: rendering, input, station interaction,
// customer/order spawning, and localStorage progress persistence
// (docs/features/cooking-game.md, "Client-side Behavior (non-HTMX)" and
// "Business Rules / Validation").
//
// v2 REDESIGN (superseding an earlier keyboard-arrows/WASD version): the
// user reported "I can't move" against that version and asked for
// point-and-click controls instead — click a station and the player walks
// over and interacts with it automatically; click empty floor and the
// player just walks there. This file no longer reads any keyboard input
// for movement at all. It also grew the floor plan to 30 tables, added a
// Cookware Closet (Pan/Baking Tray/Rice Cooker) with per-dish cookware
// requirements, restyled the fridge/cabinet/cleaning-closet/boss's-office
// as doors that visually "open" while their panel/action is active, added
// a front counter fixture (replacing a plain "shutdown" box), a fullscreen
// toggle, and a one-time scripted "Karen" customer event on shift 12.
//
// v3 restyle (see "Coquette rendering constants" below): dropped v2's
// pixel-art treatment for a soft pastel "coquette" look.
//
// v3.1 room split: the fridge/cabinet/cookware-closet/stove/oven/cleaning-
// closet no longer sit "in random places" alongside the dining tables —
// they now live in a separate Kitchen room, reachable from Dining through
// a kitchen-door station (and back via a dining-door station in Kitchen),
// plus a "roomButton" DOM shortcut that switches instantly from anywhere.
// Only the active room's stations render or hit-test at any moment
// (`stationsInRoom`, floor-plan.js) — see `currentRoom`/`switchRoom` below.
//
// This file owns everything HTMX cannot model for /kitchen-shift: the
// `requestAnimationFrame` loop, click-driven movement/station-interaction,
// customer spawning, HUD/order-queue updates, and the single
// `localStorage` progress key. Order-queue/table/closing-sequence
// *transitions* are delegated to the pure `./cooking/engine-state.js`
// module rather than reimplemented inline here. Recipe/cook-timing/
// shift-ramp/paycheck/Karen math is delegated the same way to
// `./cooking/rules.js`, and station-position/click-hit-testing/movement
// geometry to `./cooking/floor-plan.js`.
//
// External file, no inline <script> tag, per this codebase's CSP-compatible
// convention. Loaded as an ES module:
//
//   <script type="module" src="/static/js/cooking-game.js"></script>
//
// from web/templates/pages/cooking-game.html — see this file's exported
// `init()` doc comment below for the DOM contract that page must provide.

import {
  availableDishes,
  findDish,
  RECIPE_BANDS,
  cookSuccessZone,
  isCookSuccess,
  cookSweepSpeed,
  customerArrivalIntervalSeconds,
  customerPatienceSeconds,
  tableCapacity,
  shiftPaycheck,
  isKarenShift,
  inGameTimeLabel,
  SHIFTS_PER_MONTH,
  SHIFT_CLOCK_SECONDS,
  PHYSICAL_TABLE_COUNT,
  FRIDGE_INGREDIENTS,
  CABINET_INGREDIENTS,
  COOKWARE_ITEMS,
  KAREN_LINE,
  KAREN_PATIENCE_SECONDS,
  MEL_DISH,
  MEL_THANK_YOU_LINE,
  MEL_PATIENCE_BONUS_SECONDS,
  MEL_FAVORITE_COLOR,
  COUPLE_DISH,
  OLIVE_FAVORITE_COLOR,
  OLIVER_FAVORITE_COLOR,
  walkSpeedMultiplierForSanity,
} from './cooking/rules.js';
import {
  createInitialState,
  addOrder,
  serveDish,
  tick,
  cleanTable,
  washDishes,
  shutDown,
  failOrderAt,
  restoreSanity,
  SANITY_MAX,
} from './cooking/engine-state.js';
import {
  buildStations,
  stationsInRoom,
  stationAtPoint,
  approachPoint,
  clampToCanvas,
  PLAYER_START,
  PLAYER_STOP_MARGIN,
  ROOM_DINING,
  ROOM_KITCHEN,
  KITCHEN_ENTRY_POINT,
  DINING_ENTRY_POINT,
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  TABLE_BOX_SIZE,
} from './cooking/floor-plan.js';

// ---------------------------------------------------------------------------
// localStorage progress (doc: "a single localStorage key")
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'cooking-game:v2';

const TABLE_IDS = Array.from({ length: PHYSICAL_TABLE_COUNT }, (_, i) => i + 1);

/** Gear keys and their shop definitions (doc: "Gear upgrades", illustrative costs/levels — tune during build). */
export const GEAR_DEFS = {
  runningShoes: { label: 'Running Shoes', baseCost: 250, costGrowth: 1.5, maxLevel: 5 },
  biggerTray: { label: 'Bigger Tray', baseCost: 300, costGrowth: 1.5, maxLevel: 5 },
  sharpKnife: { label: 'Sharp Knife', baseCost: 280, costGrowth: 1.5, maxLevel: 5 },
  extraTableService: { label: 'Extra Table Service', baseCost: 400, costGrowth: 1.6, maxLevel: 8 },
  regularsPatience: { label: "Regular's Patience", baseCost: 220, costGrowth: 1.5, maxLevel: 5 },
  quickClean: { label: 'Quick Clean', baseCost: 200, costGrowth: 1.4, maxLevel: 5 },
};

function defaultSave() {
  const gear = {};
  Object.keys(GEAR_DEFS).forEach((key) => { gear[key] = 0; });
  return { version: 1, monthToDateGard: 0, currentShift: 1, gear, bestMonthTotal: 0 };
}

/** Feature-detects a real, usable localStorage (private browsing / disabled storage safe). */
function probeStorageAvailable() {
  try {
    const probeKey = '\0cooking-game-probe';
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
  if (typeof value.bestMonthTotal !== 'number' || !Number.isFinite(value.bestMonthTotal)) return false;
  if (!value.gear || typeof value.gear !== 'object') return false;
  return true;
}

/**
 * Loads saved progress, falling back to defaults on missing/corrupted data
 * or when storage is unavailable — never throws.
 */
export function loadSave(storageAvailable) {
  if (!storageAvailable) return defaultSave();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultSave();
    const parsed = JSON.parse(raw);
    if (!isValidSaveShape(parsed)) return defaultSave();
    const save = defaultSave();
    save.monthToDateGard = Math.max(0, parsed.monthToDateGard);
    save.currentShift = Math.min(SHIFTS_PER_MONTH, Math.max(1, Math.round(parsed.currentShift)));
    save.bestMonthTotal = Math.max(0, parsed.bestMonthTotal);
    Object.keys(GEAR_DEFS).forEach((key) => {
      const level = parsed.gear[key];
      save.gear[key] = typeof level === 'number' && Number.isFinite(level) && level >= 0
        ? Math.min(level, GEAR_DEFS[key].maxLevel)
        : 0;
    });
    return save;
  } catch {
    return defaultSave();
  }
}

function persistSave(storageAvailable, save) {
  if (!storageAvailable) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(save));
  } catch {
    // Storage became unavailable mid-session — the game stays fully
    // playable for the rest of this session; it just silently stops
    // persisting.
  }
}

function gearCost(key, currentLevel) {
  const def = GEAR_DEFS[key];
  return Math.round(def.baseCost * Math.pow(def.costGrowth, currentLevel));
}

// ---------------------------------------------------------------------------
// Gear effects
// ---------------------------------------------------------------------------

/** Base walking speed, px/s — higher than the old keyboard version's, since the floor plan is much bigger now. */
const PLAYER_BASE_SPEED = 220;
const BASE_CARRY_CAPACITY = 3;
const BASE_CLEAN_SECONDS = 1.5;
const CLEAN_SECONDS_PER_QUICK_CLEAN_LEVEL = 0.2;

function walkSpeedForSave(save) {
  return PLAYER_BASE_SPEED * (1 + 0.15 * save.gear.runningShoes);
}

function carryCapacityForSave(save) {
  return BASE_CARRY_CAPACITY + save.gear.biggerTray;
}

function cleaningDurationForSave(save) {
  return Math.max(0.4, BASE_CLEAN_SECONDS - save.gear.quickClean * CLEAN_SECONDS_PER_QUICK_CLEAN_LEVEL);
}

// ---------------------------------------------------------------------------
// Recipe helpers
// ---------------------------------------------------------------------------

/**
 * Ingredients a dish still needs, given what's already in a (possibly
 * partial, possibly irrelevant-to-this-dish) inventory bag. Treats
 * inventory as a multiset — an ingredient already held satisfies at most
 * one required copy.
 */
function missingIngredientsForDish(dish, inventory) {
  const remaining = [...inventory];
  const missing = [];
  for (const ingredient of dish.ingredients) {
    const idx = remaining.indexOf(ingredient);
    if (idx === -1) {
      missing.push(ingredient);
    } else {
      remaining.splice(idx, 1);
    }
  }
  return missing;
}

function removeDishIngredientsFromInventory(dish, inventory) {
  const next = [...inventory];
  for (const ingredient of dish.ingredients) {
    const idx = next.indexOf(ingredient);
    if (idx !== -1) next.splice(idx, 1);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Coquette rendering constants
// ---------------------------------------------------------------------------
//
// v3 restyle: the user tried the v2 pixel-art look, then asked for
// "coquette" instead — a soft, pastel, ribbon-and-bow aesthetic (their
// reference: pale pink/white lace, soft linework). Real illustrated
// anime-style art needs actual drawn/generated sprite assets, which this
// canvas-primitive renderer doesn't have (see Open Questions) — what
// follows is the closest honest approximation buildable from flat shapes:
// a pastel palette, rounded corners everywhere (via ctx.roundRect, not
// square pixel corners), round heads, and small bow/star accent shapes.
// The hard pixelation from v2 (image-rendering: pixelated, forcing a
// blocky nearest-neighbor upscale) is dropped for the same reason — a soft
// style needs smooth scaling, not jagged edges — see cooking-game.html's
// canvas element, which no longer carries the .pixel-canvas class.

const FLOOR_COLOR = '#fbeef1';
const FLOOR_TILE_COLOR = '#f5dbe2';
const FLOOR_TILE_SIZE = 40;

const STATION_COLORS = {
  fridge: '#bcdcf2',
  cabinet: '#f7e2b8',
  toilet: '#cfe8ec',
  'cleaning-closet': '#c9e8d8',
  'cookware-closet': '#e6cbe8',
  stove: '#f7c6b0',
  oven: '#f2a8a0',
  counter: '#f2d98a',
  'coffee-machine': '#d9bfa3',
  'boss-office': '#dcc2ea',
  table: '#fdf1e4',
  'kitchen-door': '#f2c9a0',
  'dining-door': '#f2c9a0',
};

const STATION_LABELS = {
  fridge: 'Fridge',
  cabinet: 'Cabinet',
  toilet: 'Restroom',
  'cleaning-closet': 'Cleaning Closet',
  'cookware-closet': 'Cookware Closet',
  stove: 'Stove',
  oven: 'Oven',
  counter: 'Counter',
  'coffee-machine': 'Coffee Machine',
  'boss-office': "Duke's Office",
  'kitchen-door': 'To Kitchen',
  'dining-door': 'To Dining',
};

/** Which station kinds render as a "door" (rect + handle dot, opens while active) vs a plain fixture. */
const DOOR_KINDS = new Set(['fridge', 'cabinet', 'toilet', 'cleaning-closet', 'cookware-closet', 'boss-office', 'kitchen-door', 'dining-door']);

const STATION_CORNER_RADIUS = 14;

function drawPixelRect(ctx, x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

function drawRoundRect(ctx, x, y, w, h, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h), r);
  ctx.fill();
}

/** A small bow (two triangular loops + a center knot) — the coquette style's signature accent. */
function drawBow(ctx, x, y, color, scale = 1) {
  const s = scale;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - 8 * s, y - 5 * s);
  ctx.lineTo(x - 8 * s, y + 5 * s);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + 8 * s, y - 5 * s);
  ctx.lineTo(x + 8 * s, y + 5 * s);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, 3 * s, 0, Math.PI * 2);
  ctx.fill();
}

/** A five-point star — the restaurant's star theme (table pillows, the sign, floor accents). */
function drawStar(ctx, cx, cy, outerRadius, innerRadius, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outerRadius : innerRadius;
    const angle = (Math.PI / 5) * i - Math.PI / 2;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

/**
 * A soft, round-headed pixel-person: rounded-rect limbs/torso (pants,
 * shirt), a circular head, an optional hair "cap" (upper-half circle) and
 * a bow accent — reused for the player, customers, Karen/Olive & Oliver,
 * and the security guard. Mel gets her own `drawMel` instead of this
 * generic version (see below) — her look has specific accessories the
 * user described, not just a recolor.
 */
function drawPixelPerson(ctx, x, y, { bodyColor, headColor, pantsColor = null, hairColor = null, scale = 1, marker = null, bowColor = null }) {
  const s = scale;
  const pants = pantsColor || bodyColor;
  drawRoundRect(ctx, x - 8 * s, y - 4 * s, 6 * s, 14 * s, 2 * s, pants); // left leg
  drawRoundRect(ctx, x + 2 * s, y - 4 * s, 6 * s, 14 * s, 2 * s, pants); // right leg
  drawRoundRect(ctx, x - 12 * s, y - 22 * s, 6 * s, 16 * s, 3 * s, bodyColor); // left arm
  drawRoundRect(ctx, x + 6 * s, y - 22 * s, 6 * s, 16 * s, 3 * s, bodyColor); // right arm
  drawRoundRect(ctx, x - 11 * s, y - 24 * s, 22 * s, 20 * s, 6 * s, bodyColor); // torso (shirt)

  ctx.fillStyle = headColor;
  ctx.beginPath();
  ctx.arc(x, y - 32 * s, 9 * s, 0, Math.PI * 2);
  ctx.fill();

  if (hairColor) {
    ctx.fillStyle = hairColor;
    ctx.beginPath();
    ctx.arc(x, y - 35 * s, 9.5 * s, Math.PI, 0); // an upper-half "cap" over the head
    ctx.fill();
  }
  if (bowColor) drawBow(ctx, x + 8 * s, y - 43 * s, bowColor, s * 0.8);
  if (marker) {
    ctx.fillStyle = marker;
    ctx.beginPath();
    ctx.arc(x, y - 46 * s, 3 * s, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Mel: sweet, kind, and caring — favorite color a soft creamy light
 * yellow and white, favorite flowers dandelions/tulips/roses, favorite
 * hobby drawing and cycling. Her usual outfit (all per the user's
 * description): a dandelion tucked behind her ear, a yellow hair clip, her
 * hair tied up in a white ribbon, a yellow shirt with a small flower
 * pattern, and a plain white skirt. A dedicated draw function rather than
 * a `drawPixelPerson` recolor, since her look is a specific outfit, not
 * just different colors on the generic template.
 */
function drawMel(ctx, x, y, scale) {
  const s = scale;
  drawPixelPerson(ctx, x, y, {
    bodyColor: '#fff3c4', // creamy light yellow shirt
    headColor: '#f6dcb8',
    pantsColor: '#ffffff', // plain white skirt
    hairColor: '#e8b84b',
    scale: s,
  });

  // Small flower pattern on her shirt.
  ctx.fillStyle = '#f6a6c1';
  [[-4, -14], [3, -10], [-2, -7]].forEach(([dx, dy]) => {
    ctx.beginPath();
    ctx.arc(x + dx * s, y + dy * s, 1.4 * s, 0, Math.PI * 2);
    ctx.fill();
  });

  // White ribbon tying her hair up.
  drawBow(ctx, x + 7 * s, y - 44 * s, '#ffffff', s * 0.85);

  // Yellow hair clip.
  drawRoundRect(ctx, x - 3 * s, y - 41 * s, 4 * s, 2 * s, 1 * s, '#ffd23f');

  // A dandelion tucked behind her ear — a small cream puff with a few wisps.
  ctx.fillStyle = '#fdfaf0';
  ctx.beginPath();
  ctx.arc(x - 10 * s, y - 34 * s, 3 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#fdfaf0';
  ctx.lineWidth = Math.max(1, s * 0.6);
  for (const angle of [-0.6, 0, 0.6]) {
    ctx.beginPath();
    ctx.moveTo(x - 10 * s, y - 34 * s);
    ctx.lineTo(x - 10 * s + Math.cos(angle) * 4 * s, y - 34 * s - 4 * s + Math.sin(angle) * 2 * s);
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// init()
// ---------------------------------------------------------------------------

/**
 * Wires up the canvas game loop against a page's DOM elements.
 *
 * DOM contract:
 *   hud: { shift, clock, status } — Sanity is drawn on-canvas (drawSanityBar), not in the HUD.
 *   orderQueue                    — <ul> repopulated with the active order/pending-customer list every frame.
 *   hoverHint                     — shown/hidden with the hovered station's name/status (mouse-hover tooltip, not a "press key" prompt).
 *   toast                         — brief transient message banner (e.g. missing-ingredient hints, Karen's line).
 *   fullscreenButton              — toggles Fullscreen API on the game container.
 *   roomButton (optional)         — instant Dining/Kitchen room switch shortcut; label/aria-pressed follow the current room.
 *   recipeBookButton              — opens the recipe book (see below); available before and during a shift.
 *   recipeBook: { root, list, closeButton } — a static reference list of every known dish, rendered once.
 *   cookGauge: { root, button }   — the cook-timing mini-game's click-to-sample overlay.
 *   stationPanel: { root, title, list, closeButton } — fridge/cabinet/cookware-closet's browsable item picker.
 *   startScreen: { root, gard, bestMonth, storageNotice (optional), shiftButton, shopButton (optional) }
 *   paycheckScreen: {
 *     root, title, outcome, shiftTotal, monthTotal,
 *     finalBlock, nameInput (optional), earningsInput (optional),
 *     shiftsInput (optional), submitButton (optional),
 *     nextShiftButton, newMonthButton, shopButton
 *   }
 *   shopScreen: {
 *     root, gard, closeButton, resetButton,
 *     gearItems: { [gearKey]: { levelText, costText, buyButton } }
 *   }
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} elements
 * @returns {() => void} a teardown function (also auto-invoked on htmx nav-away).
 */
export function init(canvas, elements) {
  if (typeof teardownActiveInstance === 'function') teardownActiveInstance();

  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true; // coquette look: soft curves, not blocky pixels
  const storageAvailable = probeStorageAvailable();
  let save = loadSave(storageAvailable);

  if (elements.startScreen.storageNotice) {
    elements.startScreen.storageNotice.classList.toggle('hidden', storageAvailable);
  }

  const random = Math.random;
  const world = { width: CANVAS_WIDTH, height: CANVAS_HEIGHT };
  const stations = buildStations(TABLE_IDS);

  let currentShiftNumber = save.currentShift;
  let shiftState = null;
  let player = { ...PLAYER_START };
  let currentRoom = ROOM_DINING; // ROOM_DINING | ROOM_KITCHEN — only this room's stations render/hit-test
  let moveTarget = null; // { x, y, station: station|null }
  let hoverStation = null;
  let pendingCustomers = {}; // { [tableId]: dishName }
  let inventory = []; // raw ingredient names
  let cookware = new Set(); // acquired this shift, never consumed
  let heldDish = null; // finished dish name, or null
  let activeOrderTableId = null; // which order gathering/cooking currently targets
  let cookMiniGame = null; // { dishName, station, gaugePosition, direction, zone }
  let closingTimer = null; // { stationId, kind: 'table'|'cleaning-closet', tableId?, remaining }
  let activePanel = null; // 'fridge' | 'cabinet' | 'cookware' | null
  let recipeBookOpen = false;
  let karen = null; // { tableId } while her order is live and unresolved this shift
  let mel = null; // { tableId } while her order is live and unresolved this shift
  let melSpawnedThisShift = false; // she's always the first customer seated every shift
  let couple = null; // { tableId } while Olive & Oliver's order is live and unresolved this shift
  let coupleSpawnedThisShift = false; // they always arrive right after Mel every shift
  let timeSinceCustomerSpawn = 0;
  let running = false;
  let rafHandle = null;
  let lastTimestamp = null;
  let paused = false;
  let toastTimeoutHandle = null;

  // -- Screen visibility -----------------------------------------------

  function showScreen(which) {
    elements.startScreen.root.classList.toggle('hidden', which !== 'start');
    elements.paycheckScreen.root.classList.toggle('hidden', which !== 'paycheck');
    elements.shopScreen.root.classList.toggle('hidden', which !== 'shop');
  }

  function showToast(text, seconds = 2.5) {
    elements.toast.textContent = text;
    elements.toast.classList.remove('hidden');
    if (toastTimeoutHandle) window.clearTimeout(toastTimeoutHandle);
    toastTimeoutHandle = window.setTimeout(() => { elements.toast.classList.add('hidden'); }, seconds * 1000);
  }

  // -- Start screen -------------------------------------------------------

  function renderStartScreen() {
    elements.startScreen.gard.textContent = `${save.monthToDateGard} Gard`;
    elements.startScreen.bestMonth.textContent = `${save.bestMonthTotal} Gard`;
    elements.startScreen.shiftButton.textContent = save.currentShift > 1
      ? `Resume Shift ${save.currentShift}`
      : 'Start Shift';
    showScreen('start');
  }

  // -- Shop -----------------------------------------------------------

  function renderShop() {
    elements.shopScreen.gard.textContent = `${save.monthToDateGard} Gard`;
    Object.keys(GEAR_DEFS).forEach((key) => {
      const row = elements.shopScreen.gearItems[key];
      if (!row) return;
      const level = save.gear[key];
      const def = GEAR_DEFS[key];
      const maxed = level >= def.maxLevel;
      row.levelText.textContent = String(level);
      row.costText.textContent = maxed ? 'MAX' : String(gearCost(key, level));
      if (row.buyButton) {
        const affordable = !maxed && save.monthToDateGard >= gearCost(key, level);
        row.buyButton.disabled = !affordable;
        row.buyButton.classList.toggle('opacity-50', !affordable);
      }
    });
  }

  function buyGear(key) {
    const def = GEAR_DEFS[key];
    if (!def) return;
    const level = save.gear[key];
    if (level >= def.maxLevel) return;
    const cost = gearCost(key, level);
    if (save.monthToDateGard < cost) return;
    save.monthToDateGard -= cost;
    save.gear[key] = level + 1;
    persistSave(storageAvailable, save);
    renderShop();
  }

  function openShop() {
    renderShop();
    showScreen('shop');
  }

  function resetProgress() {
    if (!window.confirm('Reset all Kitchen Shift progress? This clears your Gard, shop levels, and best month total, and cannot be undone.')) {
      return;
    }
    save = defaultSave();
    persistSave(storageAvailable, save);
    renderShop();
    renderStartScreen();
  }

  // -- HUD / order queue / hover hint --------------------------------------

  function renderHud() {
    elements.hud.shift.textContent = `${currentShiftNumber}/${SHIFTS_PER_MONTH}`;
    elements.hud.clock.textContent = inGameTimeLabel(shiftState.clockSeconds);
    elements.hud.status.textContent = shiftState.shiftUpset ? 'Customer upset' : 'Going well';
  }

  function renderOrderQueue() {
    const items = [];
    for (const tableId of TABLE_IDS) {
      const pendingDish = pendingCustomers[tableId];
      if (pendingDish) {
        const isKarenTable = karen && karen.tableId === tableId;
        const isMelTable = mel && mel.tableId === tableId;
        const isCoupleTable = couple && couple.tableId === tableId;
        const suffix = isKarenTable ? ' — looks upset already' : (isMelTable ? ' — it\'s Mel!' : (isCoupleTable ? ' — Olive & Oliver' : ''));
        items.push({ text: `Table ${tableId}: wants to order (${pendingDish})${suffix}`, active: false });
      }
    }
    for (const order of shiftState.orders) {
      const secondsLeft = Math.max(0, Math.ceil(order.patienceRemainingSeconds));
      const isKarenTable = karen && karen.tableId === order.tableId;
      const isMelTable = mel && mel.tableId === order.tableId;
      const isCoupleTable = couple && couple.tableId === order.tableId;
      let label = `Table ${order.tableId}: `;
      if (isKarenTable) label = `Table ${order.tableId} (Karen!): `;
      else if (isMelTable) label = `Table ${order.tableId} (Mel): `;
      else if (isCoupleTable) label = `Table ${order.tableId} (Olive & Oliver): `;
      items.push({
        text: `${label}${order.dishName} — ${secondsLeft}s`,
        active: order.tableId === activeOrderTableId,
      });
    }

    elements.orderQueue.textContent = '';
    if (items.length === 0) {
      const li = document.createElement('li');
      li.className = 'text-muted';
      li.textContent = 'No orders yet.';
      elements.orderQueue.appendChild(li);
      return;
    }
    for (const item of items) {
      const li = document.createElement('li');
      if (item.active) li.className = 'font-semibold text-ink';
      li.textContent = item.text;
      elements.orderQueue.appendChild(li);
    }
  }

  function hoverHintFor(station) {
    if (!station) return '';
    if (station.kind === 'table') {
      const pendingDish = pendingCustomers[station.tableId];
      if (pendingDish) return `Table ${station.tableId}: wants to order`;
      const order = shiftState.orders.find((o) => o.tableId === station.tableId);
      if (order) return `Table ${station.tableId}: ${order.dishName}`;
      const t = shiftState.tables[station.tableId];
      if (t && t.dirty) return `Table ${station.tableId}: dirty`;
      return `Table ${station.tableId}`;
    }
    if (station.kind === 'boss-office' && shiftState.phase !== 'paycheck') return "Duke's Office (locked)";
    if (station.kind === 'counter' && shiftState.phase !== 'closing-shutdown') return 'Counter';
    return STATION_LABELS[station.kind] || '';
  }

  function updateHoverHint() {
    const text = hoverHintFor(hoverStation);
    if (text) {
      elements.hoverHint.textContent = text;
      elements.hoverHint.classList.remove('hidden');
    } else {
      elements.hoverHint.classList.add('hidden');
    }
  }

  // -- Station panels (fridge / cabinet / cookware closet) ----------------

  const PANEL_ITEMS = { fridge: FRIDGE_INGREDIENTS, cabinet: CABINET_INGREDIENTS, cookware: COOKWARE_ITEMS };
  const PANEL_TITLES = { fridge: 'Fridge', cabinet: 'Cabinet', cookware: 'Cookware Closet' };

  function pickIngredient(item) {
    if (inventory.length >= carryCapacityForSave(save)) {
      showToast('Tray full');
      return;
    }
    inventory.push(item);
    maybeAutoAssembleActiveDish();
  }

  function pickCookware(item) {
    cookware.add(item);
  }

  function maybeAutoAssembleActiveDish() {
    if (activeOrderTableId == null) return;
    const order = shiftState.orders.find((o) => o.tableId === activeOrderTableId);
    if (!order) return;
    const dish = findDish(order.dishName);
    if (!dish || dish.station !== 'none') return;
    if (missingIngredientsForDish(dish, inventory).length === 0) {
      inventory = removeDishIngredientsFromInventory(dish, inventory);
      heldDish = dish.name;
    }
  }

  function renderPanel() {
    if (!activePanel) return;
    elements.stationPanel.title.textContent = PANEL_TITLES[activePanel];
    elements.stationPanel.list.textContent = '';
    for (const item of PANEL_ITEMS[activePanel]) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      const owned = activePanel === 'cookware' && cookware.has(item);
      button.textContent = owned ? `${item} ✓` : item;
      button.className = 'w-full rounded-card border border-line bg-surface px-3 py-2 text-left text-sm text-ink transition-colors duration-150 hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50';
      if (owned) button.disabled = true;
      button.addEventListener('click', () => {
        if (activePanel === 'cookware') pickCookware(item);
        else pickIngredient(item);
        renderPanel();
      });
      li.appendChild(button);
      elements.stationPanel.list.appendChild(li);
    }
  }

  function openPanel(kind) {
    activePanel = kind;
    renderPanel();
    elements.stationPanel.root.classList.remove('hidden');
  }

  function closePanel() {
    activePanel = null;
    elements.stationPanel.root.classList.add('hidden');
  }

  // -- Recipe book ------------------------------------------------------

  // Static content (every known dish never changes mid-session), so this
  // only actually builds the list once — reopening just toggles visibility.
  let recipeBookRendered = false;

  function describeDish(dish) {
    const station = dish.station === 'none' ? 'No cooking needed' : (dish.station === 'stove' ? 'Stove' : 'Oven');
    const cookware = dish.cookware ? ` + ${dish.cookware}` : '';
    return `${station}${cookware} — ${dish.ingredients.join(', ')}`;
  }

  function renderRecipeBook() {
    if (recipeBookRendered) return;
    recipeBookRendered = true;

    const addEntry = (name, dish, note) => {
      const li = document.createElement('li');
      li.className = 'rounded-card border border-line p-3';
      const title = document.createElement('p');
      title.className = 'text-sm font-medium text-ink';
      title.textContent = note ? `${name} (${note})` : name;
      const desc = document.createElement('p');
      desc.className = 'text-xs text-muted';
      desc.textContent = describeDish(dish);
      li.append(title, desc);
      elements.recipeBook.list.appendChild(li);
    };

    RECIPE_BANDS.forEach((band) => {
      band.dishes.forEach((dish) => addEntry(dish.name, dish, `unlocks shift ${band.minShift}`));
    });
    addEntry(MEL_DISH.name, MEL_DISH, "Mel's favorite — always her order");
    addEntry(COUPLE_DISH.name, COUPLE_DISH, "Olive & Oliver's favorite");
  }

  function openRecipeBook() {
    renderRecipeBook();
    recipeBookOpen = true;
    elements.recipeBook.root.classList.remove('hidden');
  }

  function closeRecipeBook() {
    recipeBookOpen = false;
    elements.recipeBook.root.classList.add('hidden');
  }

  // -- Shift lifecycle ------------------------------------------------

  function spawnKarenIfDue() {
    karen = null;
    if (!isKarenShift(currentShiftNumber)) return;
    const availableTableIds = TABLE_IDS.filter((id) => !shiftState.tables[id].occupied);
    if (availableTableIds.length === 0) return;
    const tableId = availableTableIds[Math.floor(random() * availableTableIds.length)];
    const dishes = availableDishes(currentShiftNumber);
    const dish = dishes[Math.floor(random() * dishes.length)];
    pendingCustomers[tableId] = dish.name;
    karen = { tableId };
    showToast(KAREN_LINE, 5);
  }

  function startShift() {
    currentShiftNumber = save.currentShift;
    shiftState = createInitialState(TABLE_IDS);
    player = { ...PLAYER_START };
    currentRoom = ROOM_DINING;
    updateRoomButton();
    moveTarget = null;
    pendingCustomers = {};
    inventory = [];
    cookware = new Set();
    heldDish = null;
    activeOrderTableId = null;
    cookMiniGame = null;
    closingTimer = null;
    activePanel = null;
    mel = null;
    melSpawnedThisShift = false;
    couple = null;
    coupleSpawnedThisShift = false;
    timeSinceCustomerSpawn = 0;
    lastTimestamp = null;
    running = true;
    paused = false;
    closePanel();
    elements.cookGauge.root.classList.add('hidden');
    showScreen(null);
    spawnKarenIfDue();
    renderHud();
    renderOrderQueue();
    if (rafHandle === null) rafHandle = window.requestAnimationFrame(loop);
  }

  function endShift() {
    running = false;
    if (rafHandle !== null) {
      window.cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }

    const paycheck = shiftPaycheck(shiftState.shiftUpset);
    save.monthToDateGard += paycheck;
    const isFinalShift = currentShiftNumber >= SHIFTS_PER_MONTH;
    if (isFinalShift) {
      save.bestMonthTotal = Math.max(save.bestMonthTotal, save.monthToDateGard);
    } else {
      save.currentShift = currentShiftNumber + 1;
    }
    persistSave(storageAvailable, save);

    elements.paycheckScreen.root.dataset.outcome = shiftState.shiftUpset ? 'upset' : 'ok';
    elements.paycheckScreen.root.dataset.final = isFinalShift ? 'true' : 'false';
    elements.paycheckScreen.outcome.textContent = shiftState.shiftUpset
      ? "Duke isn't thrilled — a customer left upset"
      : 'Duke says great job';
    elements.paycheckScreen.shiftTotal.textContent = `${paycheck} Gard`;
    elements.paycheckScreen.monthTotal.textContent = `${save.monthToDateGard} Gard`;
    elements.paycheckScreen.nextShiftButton.classList.toggle('hidden', isFinalShift);
    elements.paycheckScreen.newMonthButton.classList.toggle('hidden', !isFinalShift);
    elements.paycheckScreen.finalBlock.classList.toggle('hidden', !isFinalShift);
    if (isFinalShift) {
      if (elements.paycheckScreen.earningsInput) elements.paycheckScreen.earningsInput.value = String(save.monthToDateGard);
      if (elements.paycheckScreen.shiftsInput) elements.paycheckScreen.shiftsInput.value = String(SHIFTS_PER_MONTH);
      if (elements.paycheckScreen.submitButton) elements.paycheckScreen.submitButton.disabled = false;
    }

    showScreen('paycheck');
  }

  function startNewMonth() {
    save.currentShift = 1;
    save.monthToDateGard = 0;
    persistSave(storageAvailable, save);
    startShift();
  }

  // -- Karen ripple effect ----------------------------------------------

  function triggerKarenRipple() {
    const others = shiftState.orders.filter((o) => o.tableId !== karen.tableId);
    if (others.length > 0) {
      const victim = others[Math.floor(random() * others.length)];
      shiftState = failOrderAt(shiftState, victim.tableId);
      showToast('Karen upset another table too!', 3);
    }
    karen = null;
  }

  // -- Movement + station interaction --------------------------------

  function canvasCoordsFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * world.width,
      y: ((e.clientY - rect.top) / rect.height) * world.height,
    };
  }

  function cancelCookMiniGame() {
    cookMiniGame = null;
    elements.cookGauge.root.classList.add('hidden');
  }

  function onCanvasClick(e) {
    if (activePanel || recipeBookOpen || !running) return;
    const { x, y } = canvasCoordsFromEvent(e);
    const station = stationAtPoint(x, y, stationsInRoom(stations, currentRoom));

    if (cookMiniGame) {
      if (station && station.kind === cookMiniGame.station) return; // still cooking here — ignore
      cancelCookMiniGame();
    }
    if (closingTimer && (!station || station.id !== closingTimer.stationId)) {
      closingTimer = null;
    }

    if (station) {
      const standoff = station.size / 2 + PLAYER_STOP_MARGIN;
      const approach = approachPoint(station.x, station.y, player.x, player.y, standoff);
      moveTarget = { x: approach.x, y: approach.y, station };
    } else {
      moveTarget = { x, y, station: null };
    }
  }

  function onCanvasMouseMove(e) {
    const { x, y } = canvasCoordsFromEvent(e);
    hoverStation = stationAtPoint(x, y, stationsInRoom(stations, currentRoom));
  }

  function onCanvasMouseLeave() {
    hoverStation = null;
  }

  function updatePlayer(deltaSeconds) {
    if (!moveTarget) return;
    const dx = moveTarget.x - player.x;
    const dy = moveTarget.y - player.y;
    const dist = Math.hypot(dx, dy);
    // Sanity multiplies on top of the gear-based speed (rules.js's
    // walkSpeedMultiplierForSanity) — tired legs from a rough shift, not a
    // separate speed system. shiftState is only null before the very first
    // "Start Shift" click; SANITY_MAX (full speed) covers that case.
    const sanityMultiplier = walkSpeedMultiplierForSanity(shiftState ? shiftState.sanity : SANITY_MAX);
    const step = walkSpeedForSave(save) * sanityMultiplier * deltaSeconds;

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

  function handleTableArrival(tableId) {
    const pendingDish = pendingCustomers[tableId];
    if (pendingDish) {
      const isKarenTable = karen && karen.tableId === tableId;
      const isMelTable = mel && mel.tableId === tableId;
      let patience = customerPatienceSeconds(currentShiftNumber, save.gear.regularsPatience);
      if (isKarenTable) patience = KAREN_PATIENCE_SECONDS;
      else if (isMelTable) patience += MEL_PATIENCE_BONUS_SECONDS;
      const maxOrders = tableCapacity(save.gear.extraTableService);
      const next = addOrder(shiftState, tableId, pendingDish, patience, maxOrders);
      if (next !== shiftState) {
        shiftState = next;
        delete pendingCustomers[tableId];
        activeOrderTableId = tableId;
      }
      return;
    }

    const order = shiftState.orders.find((o) => o.tableId === tableId);
    if (!order) return;
    if (heldDish) {
      const isKarenTable = karen && karen.tableId === tableId;
      const isMelTable = mel && mel.tableId === tableId;
      const isCoupleTable = couple && couple.tableId === tableId;
      const matched = order.dishName === heldDish;
      shiftState = serveDish(shiftState, tableId, heldDish);
      heldDish = null;
      if (isKarenTable) {
        if (matched) karen = null;
        else triggerKarenRipple();
      }
      if (isMelTable) {
        if (matched) showToast(MEL_THANK_YOU_LINE, 4);
        mel = null;
      }
      if (isCoupleTable) couple = null;
    } else {
      activeOrderTableId = tableId;
    }
  }

  function handleGatherArrival(stationKind) {
    openPanel(stationKind === 'fridge' ? 'fridge' : 'cabinet');
  }

  function handleCookArrival(stationKind) {
    if (activeOrderTableId == null) {
      showToast('Take an order first');
      return;
    }
    const order = shiftState.orders.find((o) => o.tableId === activeOrderTableId);
    if (!order) {
      activeOrderTableId = null;
      return;
    }
    const dish = findDish(order.dishName);
    if (!dish || dish.station !== stationKind) {
      showToast(dish && dish.station === 'none' ? `${dish.name} doesn't need cooking` : "Can't cook that here");
      return;
    }
    if (dish.cookware && !cookware.has(dish.cookware)) {
      showToast(`Need a ${dish.cookware} from the Cookware Closet`);
      return;
    }
    const missing = missingIngredientsForDish(dish, inventory);
    if (missing.length > 0) {
      showToast(`Need: ${missing.join(', ')}`);
      return;
    }

    cookMiniGame = {
      dishName: dish.name,
      station: stationKind,
      gaugePosition: 0,
      direction: 1,
      zone: cookSuccessZone(save.gear.sharpKnife),
    };
    elements.cookGauge.root.classList.remove('hidden');
  }

  function sampleCookGauge() {
    if (!cookMiniGame) return;
    const dish = findDish(cookMiniGame.dishName);
    const success = isCookSuccess(cookMiniGame.gaugePosition, cookMiniGame.zone);
    if (dish) inventory = removeDishIngredientsFromInventory(dish, inventory);
    if (success) heldDish = cookMiniGame.dishName;
    else showToast(`${cookMiniGame.dishName} came out wrong — ingredients lost`);
    cancelCookMiniGame();
  }

  function startClosingTimerIfValid(station) {
    if (shiftState.phase === 'closing-clean' && station.kind === 'table') {
      const t = shiftState.tables[station.tableId];
      if (!t || t.occupied || !t.dirty) return;
      closingTimer = { stationId: station.id, kind: 'table', tableId: station.tableId, remaining: cleaningDurationForSave(save) };
    } else if (shiftState.phase === 'closing-dishes' && station.kind === 'cleaning-closet') {
      closingTimer = { stationId: station.id, kind: 'cleaning-closet', remaining: cleaningDurationForSave(save) };
    }
  }

  // Room switching works in every shift phase, not just 'playing' — the
  // closing sequence needs both rooms (dirty tables and the counter/boss's
  // office are in Dining, the cleaning closet is in Kitchen), so gating
  // the doors to one phase would make the game unwinnable mid-closing.
  function switchRoom(room, entryPoint) {
    currentRoom = room;
    player.x = entryPoint.x;
    player.y = entryPoint.y;
    moveTarget = null;
    hoverStation = null;
    updateRoomButton();
  }

  function handleArrival(station) {
    if (station.kind === 'kitchen-door') return switchRoom(ROOM_KITCHEN, KITCHEN_ENTRY_POINT);
    if (station.kind === 'dining-door') return switchRoom(ROOM_DINING, DINING_ENTRY_POINT);
    if (shiftState.phase === 'playing') {
      if (station.kind === 'table') return handleTableArrival(station.tableId);
      if (station.kind === 'fridge' || station.kind === 'cabinet') return handleGatherArrival(station.kind);
      if (station.kind === 'cookware-closet') return openPanel('cookware');
      if (station.kind === 'stove' || station.kind === 'oven') return handleCookArrival(station.kind);
      if (station.kind === 'coffee-machine') {
        shiftState = restoreSanity(shiftState);
        showToast('Coffee! Feeling sharper.');
        return;
      }
      return;
    }
    if (shiftState.phase === 'closing-clean' && station.kind === 'table') return startClosingTimerIfValid(station);
    if (shiftState.phase === 'closing-dishes' && station.kind === 'cleaning-closet') return startClosingTimerIfValid(station);
    if (shiftState.phase === 'closing-shutdown' && station.kind === 'counter') {
      shiftState = shutDown(shiftState);
      return;
    }
    if (shiftState.phase === 'paycheck' && station.kind === 'boss-office') {
      endShift();
    }
  }

  function maybeSpawnCustomer() {
    const interval = customerArrivalIntervalSeconds(currentShiftNumber);
    if (timeSinceCustomerSpawn < interval) return;
    timeSinceCustomerSpawn = 0;

    const maxOrders = tableCapacity(save.gear.extraTableService);
    const activeCount = shiftState.orders.length + Object.keys(pendingCustomers).length;
    if (activeCount >= maxOrders) return;

    const availableTableIds = TABLE_IDS.filter((id) => !shiftState.tables[id].occupied && !pendingCustomers[id]);
    if (availableTableIds.length === 0) return;

    const tableId = availableTableIds[Math.floor(random() * availableTableIds.length)];

    if (!melSpawnedThisShift) {
      melSpawnedThisShift = true;
      pendingCustomers[tableId] = MEL_DISH.name;
      mel = { tableId };
      return;
    }

    if (!coupleSpawnedThisShift) {
      coupleSpawnedThisShift = true;
      pendingCustomers[tableId] = COUPLE_DISH.name;
      couple = { tableId };
      return;
    }

    const dishes = availableDishes(currentShiftNumber);
    const dish = dishes[Math.floor(random() * dishes.length)];
    pendingCustomers[tableId] = dish.name;
  }

  function updateCookMiniGame(deltaSeconds) {
    if (!cookMiniGame) return;
    const speed = cookSweepSpeed(currentShiftNumber);
    cookMiniGame.gaugePosition += cookMiniGame.direction * speed * deltaSeconds;
    if (cookMiniGame.gaugePosition >= 1) {
      cookMiniGame.gaugePosition = 1;
      cookMiniGame.direction = -1;
    } else if (cookMiniGame.gaugePosition <= 0) {
      cookMiniGame.gaugePosition = 0;
      cookMiniGame.direction = 1;
    }
    elements.cookGauge.fill.style.width = `${(cookMiniGame.gaugePosition * 100).toFixed(1)}%`;
  }

  function updateClosingTimer(deltaSeconds) {
    if (!closingTimer) return;
    closingTimer.remaining -= deltaSeconds;
    if (closingTimer.remaining <= 0) {
      if (closingTimer.kind === 'table') shiftState = cleanTable(shiftState, closingTimer.tableId);
      else shiftState = washDishes(shiftState);
      closingTimer = null;
    }
  }

  // -- Rendering ----------------------------------------------------------

  // Fixed, hand-placed decorative star positions on the floor — a light
  // watermark, not a per-tile pattern (too busy/costly to redraw every
  // tile every frame), matching "make the restaurant star themed."
  const FLOOR_STAR_POSITIONS = [
    { x: 170, y: 210 }, { x: 790, y: 210 }, { x: 170, y: 420 }, { x: 790, y: 420 },
    { x: 480, y: 300 },
  ];

  function drawFloor() {
    drawPixelRect(ctx, 0, 0, world.width, world.height, FLOOR_COLOR);
    for (let x = 0; x < world.width; x += FLOOR_TILE_SIZE) {
      for (let y = 0; y < world.height; y += FLOOR_TILE_SIZE) {
        if (((x / FLOOR_TILE_SIZE) + (y / FLOOR_TILE_SIZE)) % 2 === 0) {
          drawPixelRect(ctx, x, y, FLOOR_TILE_SIZE, FLOOR_TILE_SIZE, FLOOR_TILE_COLOR);
        }
      }
    }
    for (const p of FLOOR_STAR_POSITIONS) {
      drawStar(ctx, p.x, p.y, 10, 4, 'rgba(255,255,255,0.35)');
    }

    // The star-themed sign and the entrance/exit marker only make sense in
    // the Dining room (the Kitchen has no entrance/exit of its own — its
    // only way out is the dining-door station) — both purely decorative
    // text, not interactive stations (the user asked "where is the
    // entrance/exit" — this answers it directly rather than adding a new
    // clickable station for something with no separate mechanic). Stations
    // draw on top of the floor, so the sign must sit somewhere no station
    // box or label chip ever occupies — Duke's Office (x 445-515) owns the
    // top-center column including its label chip below it, so the sign is
    // offset well clear of that column instead of centered on it.
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (currentRoom === ROOM_DINING) {
      ctx.fillStyle = '#c65f7c';
      ctx.font = 'bold 13px sans-serif';
      ctx.fillText('✨ Startime Diner ✨', 240, 18);

      // Placed clear of the counter/coffee-machine boxes that already
      // occupy the rest of the bottom row.
      ctx.fillStyle = 'rgba(198,95,124,0.6)';
      ctx.font = '10px sans-serif';
      ctx.fillText('★ Entrance / Exit ★', 650, world.height - 10);
    } else {
      ctx.fillStyle = '#c65f7c';
      ctx.font = 'bold 13px sans-serif';
      ctx.fillText('✨ Kitchen ✨', 240, 18);
    }
    ctx.restore();
  }

  function isStationOpen(station) {
    if (station.kind === 'fridge') return activePanel === 'fridge';
    if (station.kind === 'cabinet') return activePanel === 'cabinet';
    if (station.kind === 'cookware-closet') return activePanel === 'cookware';
    if (station.kind === 'cleaning-closet') return closingTimer && closingTimer.stationId === station.id;
    if (station.kind === 'boss-office') return shiftState.phase === 'paycheck';
    return false;
  }

  function drawTableContents(station) {
    const tableId = station.tableId;
    const tableState = shiftState.tables[tableId];
    const pendingDish = pendingCustomers[tableId];
    const order = shiftState.orders.find((o) => o.tableId === tableId);
    const isKarenTable = karen && karen.tableId === tableId;
    const isMelTable = mel && mel.tableId === tableId;
    const isCoupleTable = couple && couple.tableId === tableId;
    const half = TABLE_BOX_SIZE / 2;

    if (pendingDish || order) {
      if (isMelTable) {
        drawMel(ctx, 0, half + 8, 0.85);
      } else if (isCoupleTable) {
        // Olive & Oliver: a couple sharing one table — two people, not one.
        drawPixelPerson(ctx, -17, half + 8, { bodyColor: OLIVE_FAVORITE_COLOR, headColor: '#f6dcc0', pantsColor: '#fdf1e4', hairColor: '#7a4a2e', bowColor: '#ffffff', scale: 0.78 });
        drawPixelPerson(ctx, 17, half + 8, { bodyColor: OLIVER_FAVORITE_COLOR, headColor: '#f6dcc0', pantsColor: '#2c3140', hairColor: '#33261a', scale: 0.78 });
      } else {
        drawPixelPerson(ctx, 0, half + 8, {
          bodyColor: isKarenTable ? '#e88ba0' : '#f2c88a',
          headColor: '#f6dcc0',
          pantsColor: isKarenTable ? '#2a2a2a' : '#5a3a22',
          hairColor: isKarenTable ? '#3a2a2a' : '#6b4a30',
          bowColor: isKarenTable ? '#2a2a2a' : null,
          scale: 0.85,
          marker: isKarenTable ? '#ffe066' : null,
        });
      }
    }

    if (order) {
      let patienceMax = customerPatienceSeconds(currentShiftNumber, save.gear.regularsPatience);
      if (isKarenTable) patienceMax = KAREN_PATIENCE_SECONDS;
      else if (isMelTable) patienceMax += MEL_PATIENCE_BONUS_SECONDS;
      const frac = Math.max(0, Math.min(1, order.patienceRemainingSeconds / patienceMax));
      drawRoundRect(ctx, -16, -half - 14, 32, 4, 2, 'rgba(90,50,60,0.2)');
      drawRoundRect(ctx, -16, -half - 14, 32 * frac, 4, 2, frac > 0.3 ? '#7fd68a' : '#e06a5b');
    } else if (tableState.dirty) {
      ctx.fillStyle = '#c65f7c';
      ctx.font = 'bold 9px sans-serif';
      ctx.fillText('dirty', 0, 4);
    } else if (shiftState.phase !== 'playing') {
      ctx.fillStyle = '#4a9d5a';
      ctx.font = 'bold 9px sans-serif';
      ctx.fillText('clean', 0, 4);
    }
  }

  // Dark, warm text color used for every on-canvas label — the pastel
  // "coquette" floor/station palette is light, so the old cream/white
  // label text (readable against the v2 dark-wood palette) would have
  // gone almost invisible; this is the fix for "where is the coffee
  // machine???", not just a style choice.
  const LABEL_TEXT_COLOR = '#5a3a4a';

  /** Small rounded chip behind a label so it stays legible over any station color. */
  function drawLabelChip(ctx, cx, cy, text, font) {
    ctx.font = font;
    const textWidth = ctx.measureText(text).width;
    const paddingX = 5;
    const chipW = textWidth + paddingX * 2;
    const chipH = 14;
    drawRoundRect(ctx, cx - chipW / 2, cy - chipH / 2, chipW, chipH, 6, 'rgba(255,251,246,0.85)');
    ctx.fillStyle = LABEL_TEXT_COLOR;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, cx, cy + 0.5);
  }

  // Star-themed "pillows" on the chairs around each table, per the user's
  // "star themed pillows on the chairs" request.
  const PILLOW_COLOR = '#f7b8cf';
  function drawChairPillows(half) {
    const chairs = [
      { dx: -half - 11, dy: 4 },
      { dx: half + 11, dy: 4 },
      { dx: 0, dy: -half - 11 },
    ];
    chairs.forEach(({ dx, dy }) => drawStar(ctx, dx, dy, 6, 3, PILLOW_COLOR));
  }

  function drawStation(station) {
    const isHovered = hoverStation && hoverStation.id === station.id;
    const isTarget = moveTarget && moveTarget.station && moveTarget.station.id === station.id;
    const size = station.size;
    const half = size / 2;

    ctx.save();
    ctx.translate(Math.round(station.x), Math.round(station.y));

    if (station.kind === 'table') {
      drawChairPillows(half);
    }

    const open = isStationOpen(station);
    const baseColor = STATION_COLORS[station.kind] || '#8a6a4a';
    drawRoundRect(ctx, -half, -half, size, size, STATION_CORNER_RADIUS, open ? '#fbf3df' : baseColor);

    if (DOOR_KINDS.has(station.kind)) {
      // Door handle: a small round knob, and (while "open") an inset panel reading as an ajar door.
      if (open) {
        drawRoundRect(ctx, -half + 6, -half + 6, size - 12, size - 12, STATION_CORNER_RADIUS - 4, baseColor);
      }
      ctx.fillStyle = '#7a5a4a';
      ctx.beginPath();
      ctx.arc(half - 9, 0, 3, 0, Math.PI * 2);
      ctx.fill();
    } else if (station.kind === 'counter') {
      drawRoundRect(ctx, -half, -half + 10, size, 10, 4, '#e8b95a');
    }

    ctx.strokeStyle = isTarget ? '#ffb3c6' : (isHovered ? '#f2d98a' : 'rgba(90,50,60,0.3)');
    ctx.lineWidth = isTarget || isHovered ? 3 : 2;
    ctx.beginPath();
    ctx.roundRect(-half + 1, -half + 1, size - 2, size - 2, STATION_CORNER_RADIUS - 1);
    ctx.stroke();

    // Flip the label above the box for stations hugging the bottom edge
    // (counter/coffee-machine) — otherwise the chip would draw partly or
    // fully off-canvas and become invisible, same root cause as "where is
    // the coffee machine???".
    const labelBelowFits = station.y + half + 13 + 7 <= CANVAS_HEIGHT;
    const labelY = labelBelowFits ? half + 13 : -half - 13;
    drawLabelChip(ctx, 0, labelY, STATION_LABELS[station.kind] || `Table ${station.tableId}`, 'bold 11px sans-serif');

    if (station.kind === 'table') {
      drawTableContents(station);
    } else if (station.kind === 'cleaning-closet' && shiftState.dirtyDishCount > 0) {
      ctx.fillStyle = LABEL_TEXT_COLOR;
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(shiftState.dirtyDishCount), 0, 0);
    }

    ctx.restore();
  }

  function drawPlayer() {
    drawPixelPerson(ctx, Math.round(player.x), Math.round(player.y), {
      bodyColor: '#6fa0d8',
      headColor: '#f4c99a',
      pantsColor: '#3a4a5a',
      hairColor: '#3a2a1a',
      bowColor: '#ffffff',
      scale: 1,
    });

    if (heldDish || inventory.length > 0) {
      drawLabelChip(ctx, Math.round(player.x), Math.round(player.y) - 38, heldDish || inventory.join(', '), 'bold 10px sans-serif');
    }
  }

  // Security guard — a stationary decorative figure near the entrance/
  // counter ("there's security to protect the place"). Purely visual: not
  // a floor-plan.js station, not clickable, no interaction of its own —
  // just presence, standing watch by the door the same way real diners
  // often post someone near the entrance.
  const SECURITY_GUARD_POSITION = { x: 560, y: 545 };

  function drawSecurityGuard() {
    drawPixelPerson(ctx, SECURITY_GUARD_POSITION.x, SECURITY_GUARD_POSITION.y, {
      bodyColor: '#4a5468',
      headColor: '#caa27a',
      pantsColor: '#242c38',
      hairColor: '#14181f', // reads as a dark cap
      bowColor: '#e0c25a', // a small badge ribbon
      scale: 0.9,
      marker: '#e0c25a',
    });
    drawLabelChip(ctx, SECURITY_GUARD_POSITION.x, SECURITY_GUARD_POSITION.y + 40, 'Security', 'bold 10px sans-serif');
  }

  // On-canvas Sanity bar, drawn inside the scene itself (moved off the
  // surrounding HUD per the user's "add the sanity bar inside the game
  // instead of outside") — a small heart-topped bar pinned to the
  // top-left corner of the floor plan.
  function drawSanityBar() {
    const x = 14;
    const y = 14;
    const width = 130;
    const height = 16;
    const sanityPercent = Math.round(shiftState.sanity);
    const frac = Math.max(0, Math.min(1, shiftState.sanity / SANITY_MAX));
    const fillColor = sanityPercent > 50 ? '#7fd68a' : (sanityPercent > 20 ? '#e0a83a' : '#e06a5b');

    ctx.save();
    drawRoundRect(ctx, x, y, width, height, 8, 'rgba(255,251,246,0.85)');
    drawRoundRect(ctx, x + 2, y + 2, Math.max(0, (width - 4) * frac), height - 4, 6, fillColor);
    ctx.strokeStyle = 'rgba(90,50,60,0.3)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, 8);
    ctx.stroke();

    ctx.fillStyle = LABEL_TEXT_COLOR;
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`Sanity ${sanityPercent}%`, x + width / 2, y + height / 2 + 0.5);
    ctx.restore();
  }

  function render() {
    drawFloor();
    stationsInRoom(stations, currentRoom).forEach((station) => drawStation(station));
    // Guard stands watch by the Dining entrance — not a Kitchen fixture.
    if (currentRoom === ROOM_DINING) drawSecurityGuard();
    drawPlayer();
    drawSanityBar();
  }

  // -- Game loop ------------------------------------------------------

  function loop(timestamp) {
    if (!running || paused) { rafHandle = null; return; }
    if (lastTimestamp === null) lastTimestamp = timestamp;
    const deltaSeconds = Math.min(0.1, (timestamp - lastTimestamp) / 1000);
    lastTimestamp = timestamp;

    if (!activePanel && !recipeBookOpen) updatePlayer(deltaSeconds);

    if (shiftState.phase === 'playing') {
      const beforeTick = shiftState;
      shiftState = tick(shiftState, deltaSeconds);
      if (karen) {
        const hadOrder = beforeTick.orders.some((o) => o.tableId === karen.tableId);
        const stillHasOrder = shiftState.orders.some((o) => o.tableId === karen.tableId);
        if (hadOrder && !stillHasOrder) triggerKarenRipple();
      }
      if (mel) {
        // No ripple for Mel — she's sweet and understanding, even kept
        // waiting. Just stop tracking her once her order is gone, whether
        // served (handled synchronously in handleTableArrival, which
        // already nulled her out) or timed out (here).
        const hadOrder = beforeTick.orders.some((o) => o.tableId === mel.tableId);
        const stillHasOrder = shiftState.orders.some((o) => o.tableId === mel.tableId);
        if (hadOrder && !stillHasOrder) mel = null;
      }
      if (couple) {
        const hadOrder = beforeTick.orders.some((o) => o.tableId === couple.tableId);
        const stillHasOrder = shiftState.orders.some((o) => o.tableId === couple.tableId);
        if (hadOrder && !stillHasOrder) couple = null;
      }
      if (shiftState.phase === 'playing') {
        timeSinceCustomerSpawn += deltaSeconds;
        maybeSpawnCustomer();
        updateCookMiniGame(deltaSeconds);
      } else {
        cancelCookMiniGame();
        pendingCustomers = {};
        karen = null;
        mel = null;
        couple = null;
      }
    } else {
      updateClosingTimer(deltaSeconds);
    }

    updateHoverHint();
    renderHud();
    renderOrderQueue();
    render();

    rafHandle = window.requestAnimationFrame(loop);
  }

  // -- Room toggle button -------------------------------------------------

  // A DOM shortcut alongside the canvas's own kitchen-door/dining-door
  // stations — the user asked for both "a door to the kitchen" and "a
  // button to enter the kitchen"; this button switches instantly from
  // wherever the player currently stands, no walk-up needed.
  function updateRoomButton() {
    if (!elements.roomButton) return;
    const inKitchen = currentRoom === ROOM_KITCHEN;
    elements.roomButton.textContent = inKitchen ? 'Back to Dining' : 'Enter Kitchen';
    elements.roomButton.setAttribute('aria-pressed', String(inKitchen));
  }

  function toggleRoomButton() {
    if (currentRoom === ROOM_DINING) {
      switchRoom(ROOM_KITCHEN, KITCHEN_ENTRY_POINT);
    } else {
      switchRoom(ROOM_DINING, DINING_ENTRY_POINT);
    }
  }

  // -- Fullscreen -------------------------------------------------------

  function toggleFullscreen() {
    const container = canvas.parentElement;
    if (!document.fullscreenElement) {
      container.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }

  function onVisibilityChange() {
    paused = document.hidden;
    if (!paused && running && rafHandle === null) {
      lastTimestamp = null;
      rafHandle = window.requestAnimationFrame(loop);
    }
  }

  // -- Event wiring -----------------------------------------------------

  canvas.addEventListener('click', onCanvasClick);
  canvas.addEventListener('mousemove', onCanvasMouseMove);
  canvas.addEventListener('mouseleave', onCanvasMouseLeave);
  document.addEventListener('visibilitychange', onVisibilityChange);
  elements.fullscreenButton.addEventListener('click', toggleFullscreen);
  elements.recipeBookButton.addEventListener('click', openRecipeBook);
  elements.roomButton?.addEventListener('click', toggleRoomButton);
  elements.recipeBook.closeButton.addEventListener('click', closeRecipeBook);
  elements.cookGauge.button.addEventListener('click', sampleCookGauge);
  elements.stationPanel.closeButton.addEventListener('click', closePanel);

  elements.startScreen.shiftButton.addEventListener('click', startShift);
  if (elements.startScreen.shopButton) elements.startScreen.shopButton.addEventListener('click', openShop);
  elements.paycheckScreen.nextShiftButton.addEventListener('click', startShift);
  elements.paycheckScreen.newMonthButton.addEventListener('click', startNewMonth);
  elements.paycheckScreen.shopButton.addEventListener('click', openShop);
  if (elements.paycheckScreen.submitButton) {
    elements.paycheckScreen.submitButton.addEventListener('click', () => {
      // Same real bug fixed in fishing-game.js's round-over submit handler:
      // disabling a submit <button> synchronously in its own click handler
      // suppresses the form's default submit action. Defer by one tick.
      window.setTimeout(() => { elements.paycheckScreen.submitButton.disabled = true; }, 0);
    });
  }
  elements.shopScreen.closeButton.addEventListener('click', renderStartScreen);
  elements.shopScreen.resetButton.addEventListener('click', resetProgress);
  Object.keys(GEAR_DEFS).forEach((key) => {
    const row = elements.shopScreen.gearItems[key];
    if (row && row.buyButton) row.buyButton.addEventListener('click', () => buyGear(key));
  });

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
    document.removeEventListener('visibilitychange', onVisibilityChange);
    document.body.removeEventListener('htmx:beforeSwap', teardown);
    if (teardownActiveInstance === teardown) teardownActiveInstance = null;
  }

  // Doc's Cleanup requirement: tear down on HTMX nav-away, not just full
  // page unload. Same target-check reasoning as fishing-game.js's
  // equivalent listener.
  document.body.addEventListener('htmx:beforeSwap', (e) => {
    if (e.target && e.target.id === 'main-content') teardown();
  });

  teardownActiveInstance = teardown;

  // Test-only debug hooks for e2e/cooking-game.spec.js — reaching a
  // shift's end "naturally" means waiting out a full SHIFT_CLOCK_SECONDS
  // countdown, too slow for a reliable browser test. These drive the exact
  // same real transitions (tick/cleanTable/washDishes/shutDown from
  // ./cooking/engine-state.js, then the real endShift() below) real play
  // uses. Real clicks (via Playwright mouse events against the canvas) are
  // used for everything else — these hooks exist only to fast-forward the
  // closing sequence's real-time waits, same reasoning as the v1 hooks.
  if (typeof window !== 'undefined') {
    window.__cookingGameTestHooks = {
      skipToClosing() {
        if (!running || !shiftState || shiftState.phase !== 'playing') return;
        shiftState = tick(shiftState, SHIFT_CLOCK_SECONDS + 1);
        pendingCustomers = {};
        cancelCookMiniGame();
        for (const id of TABLE_IDS) shiftState = cleanTable(shiftState, id);
        shiftState = washDishes(shiftState);
        shiftState = shutDown(shiftState);
      },
      forceUpset() {
        if (!running || !shiftState || shiftState.phase !== 'playing') return;
        shiftState = serveDish(shiftState, TABLE_IDS[0], '__test-nonexistent-dish__');
      },
      collectPaycheck() {
        if (!shiftState || shiftState.phase !== 'paycheck') return;
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

function queryGearItems(shopRoot) {
  const gearItems = {};
  Object.keys(GEAR_DEFS).forEach((key) => {
    const row = shopRoot ? shopRoot.querySelector(`[data-gear-key="${key}"]`) : null;
    if (!row) return;
    gearItems[key] = {
      levelText: row.querySelector('[data-gear-level]'),
      costText: row.querySelector('[data-gear-cost]'),
      buyButton: row.querySelector('[data-gear-buy]'),
    };
  });
  return gearItems;
}

function bootstrap() {
  const canvas = document.getElementById('cooking-canvas');
  if (!canvas) return; // this page isn't mounted — no-op, same convention as fishing-game.js

  const shopRoot = document.getElementById('cooking-shop-screen');

  const elements = {
    hud: {
      shift: document.getElementById('cooking-hud-shift'),
      clock: document.getElementById('cooking-hud-clock'),
      status: document.getElementById('cooking-hud-status'),
    },
    orderQueue: document.getElementById('cooking-order-queue'),
    hoverHint: document.getElementById('cooking-interact-hint'),
    toast: document.getElementById('cooking-toast'),
    fullscreenButton: document.getElementById('cooking-fullscreen-button'),
    roomButton: document.getElementById('cooking-room-button'),
    recipeBookButton: document.getElementById('cooking-recipe-book-button'),
    recipeBook: {
      root: document.getElementById('cooking-recipe-book'),
      list: document.getElementById('cooking-recipe-book-list'),
      closeButton: document.getElementById('cooking-recipe-book-close-button'),
    },
    cookGauge: {
      root: document.getElementById('cooking-gauge'),
      fill: document.getElementById('cooking-gauge-fill'),
      button: document.getElementById('cooking-gauge-button'),
    },
    stationPanel: {
      root: document.getElementById('cooking-station-panel'),
      title: document.getElementById('cooking-station-panel-title'),
      list: document.getElementById('cooking-station-panel-list'),
      closeButton: document.getElementById('cooking-station-panel-close-button'),
    },
    startScreen: {
      root: document.getElementById('cooking-start-screen'),
      gard: document.getElementById('cooking-start-gard'),
      bestMonth: document.getElementById('cooking-start-best-month'),
      storageNotice: document.getElementById('cooking-storage-notice'),
      shiftButton: document.getElementById('cooking-start-shift-button'),
      shopButton: document.getElementById('cooking-start-shop-button'),
    },
    paycheckScreen: {
      root: document.getElementById('cooking-paycheck-screen'),
      title: document.getElementById('cooking-paycheck-title'),
      outcome: document.getElementById('cooking-paycheck-outcome'),
      shiftTotal: document.getElementById('cooking-paycheck-shift-total'),
      monthTotal: document.getElementById('cooking-paycheck-month-total'),
      finalBlock: document.getElementById('cooking-final-paycheck-block'),
      nameInput: document.getElementById('cooking-paycheck-name-input'),
      earningsInput: document.getElementById('cooking-paycheck-earnings-input'),
      shiftsInput: document.getElementById('cooking-paycheck-shifts-input'),
      submitButton: document.getElementById('cooking-paycheck-submit-button'),
      nextShiftButton: document.getElementById('cooking-paycheck-next-shift-button'),
      newMonthButton: document.getElementById('cooking-paycheck-new-month-button'),
      shopButton: document.getElementById('cooking-paycheck-shop-button'),
    },
    shopScreen: {
      root: shopRoot,
      gard: document.getElementById('cooking-shop-gard'),
      closeButton: document.getElementById('cooking-shop-close-button'),
      resetButton: document.getElementById('cooking-shop-reset-button'),
      gearItems: queryGearItems(shopRoot),
    },
  };

  init(canvas, elements);
}

if (typeof document !== 'undefined') {
  bootstrap();
}
