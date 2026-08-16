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
// a front counter fixture (replacing a plain "shutdown" box), added a
// pixel-art rendering treatment (a fixed low-res canvas upscaled with
// `image-rendering: pixelated`, blocky sharp-cornered shapes, simple
// pixel-person sprites for the player/customers), a fullscreen toggle,
// and a one-time scripted "Karen" customer event on shift 12.
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
  stationAtPoint,
  approachPoint,
  clampToCanvas,
  PLAYER_START,
  PLAYER_STOP_MARGIN,
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
// Pixel-art rendering constants
// ---------------------------------------------------------------------------

const FLOOR_COLOR = '#4a3018';
const FLOOR_TILE_COLOR = '#54371c';
const FLOOR_TILE_SIZE = 40;

const STATION_COLORS = {
  fridge: '#7fb3d5',
  cabinet: '#c9a66b',
  'cleaning-closet': '#8fb9a8',
  'cookware-closet': '#b98fae',
  stove: '#d97a52',
  oven: '#b5563c',
  counter: '#caa24a',
  'coffee-machine': '#6f4e37',
  'boss-office': '#9b7bb8',
  table: '#3a2414',
};

const STATION_LABELS = {
  fridge: 'Fridge',
  cabinet: 'Cabinet',
  'cleaning-closet': 'Cleaning Closet',
  'cookware-closet': 'Cookware Closet',
  stove: 'Stove',
  oven: 'Oven',
  counter: 'Counter',
  'coffee-machine': 'Coffee Machine',
  'boss-office': "Duke's Office",
};

/** Which station kinds render as a "door" (rect + handle dot, opens while active) vs a plain fixture. */
const DOOR_KINDS = new Set(['fridge', 'cabinet', 'cleaning-closet', 'cookware-closet', 'boss-office']);

function drawPixelRect(ctx, x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

/**
 * A blocky pixel-person: hair, head, torso (shirt), two arms, two legs
 * (pants) — reused for the player, customers, Karen/Mel/Olive & Oliver,
 * and the security guard. Bigger and more detailed than the v2 rendering
 * rework's first pass — the user reported characters were too small/plain
 * to make out on the bigger 960x600 floor plan, so this doubled the base
 * scale most callers use and split the old single-color body into
 * separate shirt/pants/hair layers, still all flat pixel-rects (no new
 * loaded art — see Visual Direction's pixel-art note).
 */
function drawPixelPerson(ctx, x, y, { bodyColor, headColor, pantsColor = null, hairColor = null, scale = 1, marker = null }) {
  const s = scale;
  const pants = pantsColor || bodyColor;
  drawPixelRect(ctx, x - 8 * s, y - 4 * s, 6 * s, 14 * s, pants); // left leg
  drawPixelRect(ctx, x + 2 * s, y - 4 * s, 6 * s, 14 * s, pants); // right leg
  drawPixelRect(ctx, x - 12 * s, y - 22 * s, 6 * s, 16 * s, bodyColor); // left arm
  drawPixelRect(ctx, x + 6 * s, y - 22 * s, 6 * s, 16 * s, bodyColor); // right arm
  drawPixelRect(ctx, x - 11 * s, y - 24 * s, 22 * s, 20 * s, bodyColor); // torso (shirt)
  drawPixelRect(ctx, x - 8 * s, y - 40 * s, 16 * s, 16 * s, headColor); // head
  if (hairColor) {
    drawPixelRect(ctx, x - 9 * s, y - 42 * s, 18 * s, 5 * s, hairColor); // hair
  }
  if (marker) {
    ctx.fillStyle = marker;
    ctx.fillRect(Math.round(x - 9 * s), Math.round(y - 47 * s), Math.round(18 * s), Math.round(5 * s));
  }
}

// ---------------------------------------------------------------------------
// init()
// ---------------------------------------------------------------------------

/**
 * Wires up the canvas game loop against a page's DOM elements.
 *
 * DOM contract:
 *   hud: { shift, clock, status, sanityFill, sanityLabel } — sanityFill is a bar's fill div, sanityLabel its "N%" text.
 *   orderQueue                    — <ul> repopulated with the active order/pending-customer list every frame.
 *   hoverHint                     — shown/hidden with the hovered station's name/status (mouse-hover tooltip, not a "press key" prompt).
 *   toast                         — brief transient message banner (e.g. missing-ingredient hints, Karen's line).
 *   fullscreenButton              — toggles Fullscreen API on the game container.
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
  ctx.imageSmoothingEnabled = false; // pixel-art look: sharp scaling, no blur
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

    const sanityPercent = Math.round((shiftState.sanity / SANITY_MAX) * 100);
    elements.hud.sanityFill.style.width = `${sanityPercent}%`;
    elements.hud.sanityFill.style.backgroundColor = sanityPercent > 50 ? '#7fd68a' : (sanityPercent > 20 ? '#e0a83a' : '#e06a5b');
    elements.hud.sanityLabel.textContent = `${sanityPercent}%`;
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
    const station = stationAtPoint(x, y, stations);

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
    hoverStation = stationAtPoint(x, y, stations);
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

  function handleArrival(station) {
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

  function drawFloor() {
    drawPixelRect(ctx, 0, 0, world.width, world.height, FLOOR_COLOR);
    for (let x = 0; x < world.width; x += FLOOR_TILE_SIZE) {
      for (let y = 0; y < world.height; y += FLOOR_TILE_SIZE) {
        if (((x / FLOOR_TILE_SIZE) + (y / FLOOR_TILE_SIZE)) % 2 === 0) {
          drawPixelRect(ctx, x, y, FLOOR_TILE_SIZE, FLOOR_TILE_SIZE, FLOOR_TILE_COLOR);
        }
      }
    }
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
      if (isCoupleTable) {
        // Olive & Oliver: a couple sharing one table — two people, not one.
        drawPixelPerson(ctx, -16, half + 6, { bodyColor: OLIVE_FAVORITE_COLOR, headColor: '#e8c9a0', pantsColor: '#33261a', hairColor: '#4a2e1a', scale: 0.62 });
        drawPixelPerson(ctx, 16, half + 6, { bodyColor: OLIVER_FAVORITE_COLOR, headColor: '#e8c9a0', pantsColor: '#33261a', hairColor: '#2a1c10', scale: 0.62 });
      } else {
        drawPixelPerson(ctx, 0, half + 6, {
          bodyColor: isKarenTable ? '#c0304a' : (isMelTable ? MEL_FAVORITE_COLOR : '#caa24a'),
          headColor: '#e8c9a0',
          pantsColor: '#33261a',
          hairColor: isKarenTable ? '#1a1a1a' : (isMelTable ? '#e8b84b' : '#5a3a22'),
          scale: 0.68,
          marker: isKarenTable ? '#ffe066' : (isMelTable ? '#fff8ec' : null), // Mel's marker: a pale dandelion-puff dot
        });
      }
    }

    if (order) {
      let patienceMax = customerPatienceSeconds(currentShiftNumber, save.gear.regularsPatience);
      if (isKarenTable) patienceMax = KAREN_PATIENCE_SECONDS;
      else if (isMelTable) patienceMax += MEL_PATIENCE_BONUS_SECONDS;
      const frac = Math.max(0, Math.min(1, order.patienceRemainingSeconds / patienceMax));
      drawPixelRect(ctx, -16, -half - 14, 32, 4, 'rgba(255,255,255,0.25)');
      drawPixelRect(ctx, -16, -half - 14, 32 * frac, 4, frac > 0.3 ? '#7fd68a' : '#e06a5b');
    } else if (tableState.dirty) {
      ctx.fillStyle = '#e06a5b';
      ctx.font = '9px monospace';
      ctx.fillText('dirty', 0, 4);
    } else if (shiftState.phase !== 'playing') {
      ctx.fillStyle = '#7fd68a';
      ctx.font = '9px monospace';
      ctx.fillText('clean', 0, 4);
    }
  }

  function drawStation(station) {
    const isHovered = hoverStation && hoverStation.id === station.id;
    const isTarget = moveTarget && moveTarget.station && moveTarget.station.id === station.id;
    const size = station.size;
    const half = size / 2;

    ctx.save();
    ctx.translate(Math.round(station.x), Math.round(station.y));

    const open = isStationOpen(station);
    const baseColor = STATION_COLORS[station.kind] || '#8a6a4a';
    drawPixelRect(ctx, -half, -half, size, size, open ? '#efe0c0' : baseColor);

    if (DOOR_KINDS.has(station.kind)) {
      // Door handle: a small dot, and (while "open") an inset panel reading as an ajar door.
      if (open) {
        drawPixelRect(ctx, -half + 6, -half + 6, size - 12, size - 12, baseColor);
      }
      ctx.fillStyle = '#2a1c10';
      ctx.fillRect(half - 12, -3, 6, 6);
    } else if (station.kind === 'counter') {
      drawPixelRect(ctx, -half, -half + 10, size, 10, '#8a6a30');
    }

    ctx.strokeStyle = isTarget ? '#ffe066' : (isHovered ? '#ffd27a' : 'rgba(0,0,0,0.35)');
    ctx.lineWidth = isTarget || isHovered ? 3 : 2;
    ctx.strokeRect(-half + 1, -half + 1, size - 2, size - 2);

    ctx.fillStyle = '#fff8ec';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(STATION_LABELS[station.kind] || `Table ${station.tableId}`, 0, half + 12);

    if (station.kind === 'table') {
      drawTableContents(station);
    } else if (station.kind === 'cleaning-closet' && shiftState.dirtyDishCount > 0) {
      ctx.fillStyle = '#fff';
      ctx.fillText(String(shiftState.dirtyDishCount), 0, 0);
    }

    ctx.restore();
  }

  function drawPlayer() {
    drawPixelPerson(ctx, Math.round(player.x), Math.round(player.y), {
      bodyColor: '#4a7fb5',
      headColor: '#f4c99a',
      pantsColor: '#33261a',
      hairColor: '#3a2a1a',
      scale: 0.75,
    });

    if (heldDish || inventory.length > 0) {
      ctx.fillStyle = '#fff8ec';
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(heldDish || inventory.join(', '), Math.round(player.x), Math.round(player.y) - 30);
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
      bodyColor: '#2f3b4a',
      headColor: '#caa27a',
      pantsColor: '#1c242e',
      hairColor: '#14181f', // reads as a dark cap
      scale: 0.72,
      marker: '#c9a227', // a small badge
    });
    ctx.fillStyle = '#fff8ec';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Security', SECURITY_GUARD_POSITION.x, SECURITY_GUARD_POSITION.y + 12);
  }

  function render() {
    drawFloor();
    stations.forEach((station) => drawStation(station));
    drawSecurityGuard();
    drawPlayer();
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
      sanityFill: document.getElementById('cooking-hud-sanity-fill'),
      sanityLabel: document.getElementById('cooking-hud-sanity-label'),
    },
    orderQueue: document.getElementById('cooking-order-queue'),
    hoverHint: document.getElementById('cooking-interact-hint'),
    toast: document.getElementById('cooking-toast'),
    fullscreenButton: document.getElementById('cooking-fullscreen-button'),
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
