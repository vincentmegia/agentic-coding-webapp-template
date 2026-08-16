// Kitchen Shift canvas engine: rendering, input, station interaction,
// customer/order spawning, and localStorage progress persistence
// (docs/features/cooking-game.md, "Client-side Behavior (non-HTMX)" and
// "Business Rules / Validation").
//
// This file owns everything HTMX cannot model for /kitchen-shift: the
// `requestAnimationFrame` loop, keyboard movement/interaction, customer
// spawning, HUD/order-queue updates, and the single `localStorage`
// progress key. Order-queue/table/closing-sequence *transitions* are
// delegated to the pure `./cooking/engine-state.js` module rather than
// reimplemented inline here — this file only decides *when* those
// transitions happen (an interact key was pressed near a station, a frame
// elapsed) and *how* to draw/store the result. Recipe/cook-timing/shift-ramp/
// paycheck math is delegated the same way to `./cooking/rules.js`, and
// station-position/interaction-range math to `./cooking/floor-plan.js`.
//
// External file, no inline <script> tag, per this codebase's CSP-compatible
// convention (see fishing-game.js, theme-toggle.js). Loaded as an ES module:
//
//   <script type="module" src="/static/js/cooking-game.js"></script>
//
// from web/templates/pages/cooking-game.html — see this file's exported
// `init()` doc comment below for the DOM contract that page must provide.
//
// Deliberate v1 scope cut (documented, not an accidental gap): ingredient/
// dish/station rendering uses flat canvas primitives + text labels, not
// loaded sprite images — unlike the Fishing Game, which shipped flat
// circles first and added real SVG sprites in a later pass. This game
// follows the same "ship the working mechanic first" precedent; swapping
// in real sprite art is a follow-up, not required for the mechanic itself
// to work. Movement is keyboard-only (arrows/WASD + Space/Enter to
// interact) — mouse/touch controls are an open question in the feature
// doc, intentionally not built for v1.
//
// Nothing below touches `document`/`window`/canvas at module-evaluation
// time: every DOM read/write happens inside `init()` or functions it
// calls, and the only top-level side effect is the auto-bootstrap at the
// bottom of this file, guarded by `typeof document !== 'undefined'`.

import {
  availableDishes,
  findDish,
  cookSuccessZone,
  isCookSuccess,
  cookSweepSpeed,
  customerArrivalIntervalSeconds,
  customerPatienceSeconds,
  tableCapacity,
  shiftPaycheck,
  SHIFTS_PER_MONTH,
  SHIFT_CLOCK_SECONDS,
  PHYSICAL_TABLE_COUNT,
  FRIDGE_INGREDIENTS,
  CABINET_INGREDIENTS,
} from './cooking/rules.js';
import {
  createInitialState,
  addOrder,
  serveDish,
  tick,
  cleanTable,
  washDishes,
  shutDown,
} from './cooking/engine-state.js';
import {
  buildStations,
  nearestStation,
  clampToCanvas,
  PLAYER_START,
} from './cooking/floor-plan.js';

// ---------------------------------------------------------------------------
// localStorage progress (doc: "a single localStorage key")
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'cooking-game:v1';

const TABLE_IDS = Array.from({ length: PHYSICAL_TABLE_COUNT }, (_, i) => i + 1);

/** Gear keys and their shop definitions (doc: "Gear upgrades", illustrative costs/levels — tune during build). */
export const GEAR_DEFS = {
  runningShoes: { label: 'Running Shoes', baseCost: 250, costGrowth: 1.5, maxLevel: 5 },
  biggerTray: { label: 'Bigger Tray', baseCost: 300, costGrowth: 1.5, maxLevel: 5 },
  sharpKnife: { label: 'Sharp Knife', baseCost: 280, costGrowth: 1.5, maxLevel: 5 },
  // Capped at level 2, not 5: tableCapacity() (rules.js) already clamps at
  // PHYSICAL_TABLE_COUNT — a 3rd+ level would cost Gard for zero effect.
  extraTableService: { label: 'Extra Table Service', baseCost: 400, costGrowth: 1.6, maxLevel: 2 },
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
 * or when storage is unavailable — never throws (doc's Testing Plan:
 * "corrupted or missing localStorage data falls back to defaults without
 * an error").
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
    // persisting (same convention as the Fishing Game).
  }
}

function gearCost(key, currentLevel) {
  const def = GEAR_DEFS[key];
  return Math.round(def.baseCost * Math.pow(def.costGrowth, currentLevel));
}

// ---------------------------------------------------------------------------
// Gear effects (applied every frame from the current save — doc: "levels
// only ever go up ... apply starting the next round/shift")
// ---------------------------------------------------------------------------

const PLAYER_BASE_SPEED = 160; // px/s
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
 * Ingredients dish still needs, given what's already in a (possibly
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
// Rendering constants
// ---------------------------------------------------------------------------

const FLOOR_COLOR = '#5b3a24';
const STATION_BOX_SIZE = 56;
const TABLE_BOX_SIZE = 44;

const STATION_COLORS = {
  fridge: '#7fb3d5',
  cabinet: '#c9a66b',
  stove: '#d97a52',
  oven: '#b5563c',
  sink: '#8fb9a8',
  shutdown: '#6b6b6b',
  'boss-office': '#9b7bb8',
  table: '#4a3018',
};

const STATION_LABELS = {
  fridge: 'Fridge',
  cabinet: 'Cabinet',
  stove: 'Stove',
  oven: 'Oven',
  sink: 'Sink',
  shutdown: 'Shutdown',
  'boss-office': "Duke's Office",
};

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// init()
// ---------------------------------------------------------------------------

/**
 * Wires up the canvas game loop against a page's DOM elements.
 *
 * DOM contract:
 *   hud: { shift, clock, status }
 *   orderQueue                    — <ul> repopulated with the active order/pending-customer list every frame.
 *   interactHint                  — shown/hidden with contextual "what will Space do here" text.
 *   startScreen: {
 *     root, gard, bestMonth, storageNotice (optional),
 *     shiftButton, shopButton (optional)
 *   }
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
  const storageAvailable = probeStorageAvailable();
  let save = loadSave(storageAvailable);

  if (elements.startScreen.storageNotice) {
    elements.startScreen.storageNotice.classList.toggle('hidden', storageAvailable);
  }

  const random = Math.random;
  const world = { width: canvas.width, height: canvas.height };
  const stations = buildStations(TABLE_IDS);

  let currentShiftNumber = save.currentShift;
  let shiftState = null;
  let player = { ...PLAYER_START };
  let input = { up: false, down: false, left: false, right: false, interact: false };
  let pendingInteractPress = false;
  let pendingCustomers = {}; // { [tableId]: dishName }
  let inventory = []; // raw ingredient names
  let heldDish = null; // finished dish name, or null
  let activeOrderTableId = null; // which order gathering/cooking currently targets
  let cookMiniGame = null; // { dishName, station, gaugePosition, direction, zone }
  let holdAction = null; // { stationId, remaining } — closing-sequence hold-to-complete
  let timeSinceCustomerSpawn = 0;
  let currentNearestStation = null;
  let running = false;
  let rafHandle = null;
  let lastTimestamp = null;
  let paused = false;

  // -- Screen visibility -----------------------------------------------

  function showScreen(which) {
    elements.startScreen.root.classList.toggle('hidden', which !== 'start');
    elements.paycheckScreen.root.classList.toggle('hidden', which !== 'paycheck');
    elements.shopScreen.root.classList.toggle('hidden', which !== 'shop');
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
    if (save.monthToDateGard < cost) return; // functionally disabled, not just visually
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

  // -- HUD / order queue / interact hint -----------------------------------

  function formatClock(seconds) {
    const s = Math.max(0, Math.ceil(seconds));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}:${String(rem).padStart(2, '0')}`;
  }

  function renderHud() {
    elements.hud.shift.textContent = `${currentShiftNumber}/${SHIFTS_PER_MONTH}`;
    elements.hud.clock.textContent = formatClock(shiftState.clockSeconds);
    elements.hud.status.textContent = shiftState.shiftUpset ? 'Customer upset' : 'Going well';
  }

  // Dish names come only from rules.js's hardcoded RECIPE_BANDS, never
  // visitor input, so plain textContent assignment (no HTML injection
  // risk) covers this safely without escaping.
  function renderOrderQueue() {
    const items = [];
    for (const tableId of TABLE_IDS) {
      const pendingDish = pendingCustomers[tableId];
      if (pendingDish) {
        items.push({ text: `Table ${tableId}: wants to order (${pendingDish})`, active: false });
      }
    }
    for (const order of shiftState.orders) {
      const secondsLeft = Math.max(0, Math.ceil(order.patienceRemainingSeconds));
      items.push({
        text: `Table ${order.tableId}: ${order.dishName} — ${secondsLeft}s`,
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

  function playingHintFor(station) {
    if (station.kind === 'table') {
      const pendingDish = pendingCustomers[station.tableId];
      if (pendingDish) return `Press Space to take the order (${pendingDish})`;
      const order = shiftState.orders.find((o) => o.tableId === station.tableId);
      if (order) {
        if (heldDish) {
          return heldDish === order.dishName
            ? `Press Space to serve ${order.dishName}`
            : `Wrong dish! Press Space to serve anyway`;
        }
        return `Order: ${order.dishName}`;
      }
      return '';
    }
    if (station.kind === 'fridge' || station.kind === 'cabinet') {
      const order = activeOrderTableId != null
        ? shiftState.orders.find((o) => o.tableId === activeOrderTableId)
        : null;
      if (!order) return 'Take an order first';
      const dish = findDish(order.dishName);
      if (!dish) return '';
      const stationIngredients = station.kind === 'fridge' ? FRIDGE_INGREDIENTS : CABINET_INGREDIENTS;
      const missing = missingIngredientsForDish(dish, inventory).filter((ing) => stationIngredients.includes(ing));
      if (missing.length === 0) return 'Nothing needed here';
      if (inventory.length >= carryCapacityForSave(save)) return 'Tray full';
      return `Press Space to grab ${missing[0]}`;
    }
    if (station.kind === 'stove' || station.kind === 'oven') {
      if (cookMiniGame && cookMiniGame.station === station.kind) return 'Press Space when the gauge is centered!';
      const order = activeOrderTableId != null
        ? shiftState.orders.find((o) => o.tableId === activeOrderTableId)
        : null;
      if (!order) return '';
      const dish = findDish(order.dishName);
      if (!dish || dish.station !== station.kind) return '';
      const missing = missingIngredientsForDish(dish, inventory);
      if (missing.length > 0) return `Need: ${missing.join(', ')}`;
      return `Press Space to cook ${dish.name}`;
    }
    return '';
  }

  function updateInteractHint() {
    const station = currentNearestStation;
    let text = '';

    if (station) {
      if (shiftState.phase === 'playing') {
        text = playingHintFor(station);
      } else if (shiftState.phase === 'closing-clean' && station.kind === 'table') {
        const tableState = shiftState.tables[station.tableId];
        if (tableState && tableState.dirty && !tableState.occupied) {
          text = holdAction && holdAction.stationId === station.id
            ? `Cleaning… hold Space (${holdAction.remaining.toFixed(1)}s)`
            : 'Hold Space to clean this table';
        }
      } else if (shiftState.phase === 'closing-dishes' && station.kind === 'sink') {
        text = holdAction && holdAction.stationId === station.id
          ? `Washing dishes… hold Space (${holdAction.remaining.toFixed(1)}s)`
          : `Hold Space to wash ${shiftState.dirtyDishCount} dirty dish${shiftState.dirtyDishCount === 1 ? '' : 'es'}`;
      } else if (shiftState.phase === 'closing-shutdown' && station.kind === 'shutdown') {
        text = 'Press Space to shut down for the night';
      } else if (shiftState.phase === 'paycheck' && station.kind === 'boss-office') {
        text = 'Press Space to see Duke for your paycheck';
      }
    }

    if (text) {
      elements.interactHint.textContent = text;
      elements.interactHint.classList.remove('hidden');
    } else {
      elements.interactHint.classList.add('hidden');
    }
  }

  // -- Shift lifecycle ------------------------------------------------

  function startShift() {
    currentShiftNumber = save.currentShift;
    shiftState = createInitialState(TABLE_IDS);
    player = { ...PLAYER_START };
    pendingCustomers = {};
    inventory = [];
    heldDish = null;
    activeOrderTableId = null;
    cookMiniGame = null;
    holdAction = null;
    timeSinceCustomerSpawn = 0;
    input = { up: false, down: false, left: false, right: false, interact: false };
    pendingInteractPress = false;
    lastTimestamp = null;
    running = true;
    paused = false;
    showScreen(null);
    currentNearestStation = nearestStation(player.x, player.y, stations);
    updateInteractHint();
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

  // -- Input ------------------------------------------------------------

  function isInteractKey(key) {
    return key === ' ' || key === 'Spacebar' || key === 'Enter';
  }

  function onKeyDown(e) {
    if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') input.up = true;
    if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') input.down = true;
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') input.left = true;
    if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') input.right = true;
    if (isInteractKey(e.key)) {
      // Rising-edge only — ignore OS key-repeat while held, so a single
      // press fires exactly one edge-triggered action (take order/serve/
      // cook-start); the closing-sequence hold actions read `input.interact`
      // itself (continuously true while held), not this flag.
      if (!input.interact) pendingInteractPress = true;
      input.interact = true;
      e.preventDefault(); // avoid page scroll on Space
    }
  }

  function onKeyUp(e) {
    if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') input.up = false;
    if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') input.down = false;
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') input.left = false;
    if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') input.right = false;
    if (isInteractKey(e.key)) input.interact = false;
  }

  function onVisibilityChange() {
    paused = document.hidden;
    if (!paused && running && rafHandle === null) {
      lastTimestamp = null;
      rafHandle = window.requestAnimationFrame(loop);
    }
  }

  // -- Simulation ---------------------------------------------------------

  function updatePlayer(deltaSeconds) {
    const speed = walkSpeedForSave(save);
    let dx = 0;
    let dy = 0;
    if (input.up) dy -= 1;
    if (input.down) dy += 1;
    if (input.left) dx -= 1;
    if (input.right) dx += 1;
    if (dx !== 0 && dy !== 0) {
      dx *= Math.SQRT1_2;
      dy *= Math.SQRT1_2;
    }
    const next = clampToCanvas(player.x + dx * speed * deltaSeconds, player.y + dy * speed * deltaSeconds);
    player.x = next.x;
    player.y = next.y;
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
  }

  // -- Interaction handling -------------------------------------------

  function handleTableInteract(tableId) {
    const pendingDish = pendingCustomers[tableId];
    if (pendingDish) {
      const patience = customerPatienceSeconds(currentShiftNumber, save.gear.regularsPatience);
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
      shiftState = serveDish(shiftState, tableId, heldDish);
      heldDish = null;
    } else {
      activeOrderTableId = tableId;
    }
  }

  function handleGatherInteract(stationKind) {
    if (activeOrderTableId == null) return;
    const order = shiftState.orders.find((o) => o.tableId === activeOrderTableId);
    if (!order) {
      activeOrderTableId = null;
      return;
    }
    const dish = findDish(order.dishName);
    if (!dish) return;

    const stationIngredients = stationKind === 'fridge' ? FRIDGE_INGREDIENTS : CABINET_INGREDIENTS;
    const missing = missingIngredientsForDish(dish, inventory);
    const grabbable = missing.filter((ing) => stationIngredients.includes(ing));
    if (grabbable.length === 0) return;
    if (inventory.length >= carryCapacityForSave(save)) return;

    inventory.push(grabbable[0]);

    // "None"-station dishes (e.g. Garden Salad) need no cook step — once
    // every ingredient is gathered, assemble it into a held dish right here.
    if (dish.station === 'none' && missingIngredientsForDish(dish, inventory).length === 0) {
      inventory = removeDishIngredientsFromInventory(dish, inventory);
      heldDish = dish.name;
    }
  }

  function handleCookInteract(stationKind) {
    if (cookMiniGame) {
      const dish = findDish(cookMiniGame.dishName);
      const success = isCookSuccess(cookMiniGame.gaugePosition, cookMiniGame.zone);
      if (dish) inventory = removeDishIngredientsFromInventory(dish, inventory);
      if (success) heldDish = cookMiniGame.dishName;
      cookMiniGame = null;
      return;
    }

    if (activeOrderTableId == null) return;
    const order = shiftState.orders.find((o) => o.tableId === activeOrderTableId);
    if (!order) return;
    const dish = findDish(order.dishName);
    if (!dish || dish.station !== stationKind) return;
    const missing = missingIngredientsForDish(dish, inventory);
    if (missing.length > 0) return;

    cookMiniGame = {
      dishName: dish.name,
      station: stationKind,
      gaugePosition: 0,
      direction: 1,
      zone: cookSuccessZone(save.gear.sharpKnife),
    };
  }

  function handlePlayingInteract() {
    const station = currentNearestStation;
    if (!station) return;
    if (station.kind === 'table') handleTableInteract(station.tableId);
    else if (station.kind === 'fridge' || station.kind === 'cabinet') handleGatherInteract(station.kind);
    else if (station.kind === 'stove' || station.kind === 'oven') handleCookInteract(station.kind);
  }

  function handleHoldInteract(deltaSeconds, isHeld) {
    const station = currentNearestStation;
    const validTarget = station && (
      (shiftState.phase === 'closing-clean' && station.kind === 'table'
        && shiftState.tables[station.tableId] && shiftState.tables[station.tableId].dirty
        && !shiftState.tables[station.tableId].occupied)
      || (shiftState.phase === 'closing-dishes' && station.kind === 'sink')
    );

    if (!isHeld || !validTarget) {
      holdAction = null;
      return;
    }
    if (!holdAction || holdAction.stationId !== station.id) {
      holdAction = { stationId: station.id, remaining: cleaningDurationForSave(save) };
    }
    holdAction.remaining -= deltaSeconds;
    if (holdAction.remaining <= 0) {
      shiftState = station.kind === 'table' ? cleanTable(shiftState, station.tableId) : washDishes(shiftState);
      holdAction = null;
    }
  }

  // -- Rendering ----------------------------------------------------------

  function drawTableContents(station) {
    const tableId = station.tableId;
    const tableState = shiftState.tables[tableId];
    const pendingDish = pendingCustomers[tableId];
    const order = shiftState.orders.find((o) => o.tableId === tableId);

    if (pendingDish) {
      ctx.fillStyle = '#ffd27a';
      ctx.beginPath();
      ctx.arc(0, -TABLE_BOX_SIZE / 2 - 10, 6, 0, Math.PI * 2);
      ctx.fill();
    } else if (order) {
      ctx.fillStyle = '#7fd68a';
      ctx.beginPath();
      ctx.arc(0, -TABLE_BOX_SIZE / 2 - 10, 6, 0, Math.PI * 2);
      ctx.fill();

      const patienceMax = customerPatienceSeconds(currentShiftNumber, save.gear.regularsPatience);
      const frac = Math.max(0, Math.min(1, order.patienceRemainingSeconds / patienceMax));
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillRect(-16, -TABLE_BOX_SIZE / 2 - 22, 32, 4);
      ctx.fillStyle = frac > 0.3 ? '#7fd68a' : '#e06a5b';
      ctx.fillRect(-16, -TABLE_BOX_SIZE / 2 - 22, 32 * frac, 4);
    } else if (tableState.dirty) {
      ctx.fillStyle = '#e06a5b';
      ctx.font = '9px sans-serif';
      ctx.fillText('dirty', 0, 0);
    } else if (shiftState.phase !== 'playing') {
      ctx.fillStyle = '#7fd68a';
      ctx.font = '9px sans-serif';
      ctx.fillText('clean', 0, 0);
    }
  }

  function drawStation(station) {
    const isNear = currentNearestStation && currentNearestStation.id === station.id;
    const size = station.kind === 'table' ? TABLE_BOX_SIZE : STATION_BOX_SIZE;

    ctx.save();
    ctx.translate(station.x, station.y);
    ctx.fillStyle = STATION_COLORS[station.kind] || '#8a6a4a';
    ctx.strokeStyle = isNear ? '#ffd27a' : 'rgba(255,255,255,0.25)';
    ctx.lineWidth = isNear ? 3 : 1.5;
    roundRect(ctx, -size / 2, -size / 2, size, size, 8);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#fff8ec';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(STATION_LABELS[station.kind] || `Table ${station.tableId}`, 0, size / 2 + 12);

    if (station.kind === 'table') {
      drawTableContents(station);
    } else if (station.kind === 'sink' && shiftState.dirtyDishCount > 0) {
      ctx.fillStyle = '#fff';
      ctx.fillText(String(shiftState.dirtyDishCount), 0, 0);
    }

    ctx.restore();
  }

  function drawPlayer() {
    ctx.save();
    ctx.translate(player.x, player.y);
    ctx.fillStyle = '#f4c95d';
    ctx.beginPath();
    ctx.arc(0, 0, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#3a2418';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#fff8ec';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    if (heldDish) {
      ctx.fillText(heldDish, 0, -24);
    } else if (inventory.length > 0) {
      ctx.font = '9px sans-serif';
      ctx.fillText(inventory.join(', '), 0, -24);
    }
    ctx.restore();
  }

  function drawCookGauge() {
    const barWidth = 200;
    const barHeight = 14;
    const x = world.width / 2 - barWidth / 2;
    const y = world.height / 2 - barHeight / 2;

    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x - 10, y - 26, barWidth + 20, barHeight + 40);

    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(x, y, barWidth, barHeight);

    const zone = cookMiniGame.zone;
    ctx.fillStyle = '#7fd68a';
    ctx.fillRect(x + zone.start * barWidth, y, zone.width * barWidth, barHeight);

    const markerX = x + cookMiniGame.gaugePosition * barWidth;
    ctx.fillStyle = '#fff8ec';
    ctx.fillRect(markerX - 2, y - 4, 4, barHeight + 8);

    ctx.fillStyle = '#fff8ec';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`Cooking ${cookMiniGame.dishName}`, x + barWidth / 2, y - 10);
    ctx.restore();
  }

  function render() {
    ctx.fillStyle = FLOOR_COLOR;
    ctx.fillRect(0, 0, world.width, world.height);

    stations.forEach((station) => drawStation(station));
    drawPlayer();
    if (cookMiniGame) drawCookGauge();
  }

  // -- Game loop ------------------------------------------------------

  function loop(timestamp) {
    if (!running || paused) { rafHandle = null; return; }
    if (lastTimestamp === null) lastTimestamp = timestamp;
    const deltaSeconds = Math.min(0.1, (timestamp - lastTimestamp) / 1000);
    lastTimestamp = timestamp;

    updatePlayer(deltaSeconds);
    currentNearestStation = nearestStation(player.x, player.y, stations);

    if (shiftState.phase === 'playing') {
      shiftState = tick(shiftState, deltaSeconds);
      if (shiftState.phase === 'playing') {
        timeSinceCustomerSpawn += deltaSeconds;
        maybeSpawnCustomer();
        updateCookMiniGame(deltaSeconds);
        if (cookMiniGame && (!currentNearestStation || currentNearestStation.kind !== cookMiniGame.station)) {
          cookMiniGame = null; // walked away — cancelled, ingredients preserved
        }
      } else {
        // Shift clock just hit zero this frame — moving into closing.
        cookMiniGame = null;
        pendingCustomers = {};
      }
    }

    const justPressed = pendingInteractPress;
    pendingInteractPress = false;

    if (shiftState.phase === 'playing' && justPressed) {
      handlePlayingInteract();
    } else if (shiftState.phase === 'closing-clean' || shiftState.phase === 'closing-dishes') {
      handleHoldInteract(deltaSeconds, input.interact);
    } else if (shiftState.phase === 'closing-shutdown' && justPressed
      && currentNearestStation && currentNearestStation.kind === 'shutdown') {
      shiftState = shutDown(shiftState);
    } else if (shiftState.phase === 'paycheck' && justPressed
      && currentNearestStation && currentNearestStation.kind === 'boss-office') {
      endShift();
      return; // endShift() stops the loop — no further frame to schedule
    }

    updateInteractHint();
    renderHud();
    renderOrderQueue();
    render();

    rafHandle = window.requestAnimationFrame(loop);
  }

  // -- Event wiring -----------------------------------------------------

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  document.addEventListener('visibilitychange', onVisibilityChange);

  elements.startScreen.shiftButton.addEventListener('click', startShift);
  if (elements.startScreen.shopButton) elements.startScreen.shopButton.addEventListener('click', openShop);
  elements.paycheckScreen.nextShiftButton.addEventListener('click', startShift);
  elements.paycheckScreen.newMonthButton.addEventListener('click', startNewMonth);
  elements.paycheckScreen.shopButton.addEventListener('click', openShop);
  if (elements.paycheckScreen.submitButton) {
    elements.paycheckScreen.submitButton.addEventListener('click', () => {
      // Same real bug fixed in fishing-game.js's round-over submit handler:
      // disabling a submit <button> synchronously in its own click handler
      // suppresses the form's default submit action (what triggers htmx's
      // hx-post interception) in both Chromium and WebKit. Defer the
      // disable by one tick so the real submission fires first.
      setTimeout(() => { elements.paycheckScreen.submitButton.disabled = true; }, 0);
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
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    document.body.removeEventListener('htmx:beforeSwap', teardown);
    if (teardownActiveInstance === teardown) teardownActiveInstance = null;
  }

  // Doc's Cleanup requirement: tear down on HTMX nav-away, not just full
  // page unload. Same target-check reasoning as fishing-game.js's
  // equivalent listener — htmx:beforeSwap bubbles for every htmx swap on
  // the page (including this page's own leaderboard fragment refresh), so
  // only the real #main-content page-level swap should tear this down.
  document.body.addEventListener('htmx:beforeSwap', (e) => {
    if (e.target && e.target.id === 'main-content') teardown();
  });

  teardownActiveInstance = teardown;

  // Test-only debug hooks for e2e/cooking-game.spec.js — reaching a
  // shift's end "naturally" means waiting out a full SHIFT_CLOCK_SECONDS
  // countdown, too slow for a reliable browser test. These drive the exact
  // same real transitions (tick/cleanTable/washDishes/shutDown from
  // ./cooking/engine-state.js, then the real endShift() below) real play
  // uses — nothing here is a parallel/faked "test mode". Left
  // unconditional, same reasoning as the Fishing Game's equivalent hook
  // (personal portfolio site, no stakes, no existing env-flag mechanism).
  if (typeof window !== 'undefined') {
    window.__cookingGameTestHooks = {
      /** Fast-forwards straight through the closing sequence via real transitions. */
      skipToClosing() {
        if (!running || !shiftState || shiftState.phase !== 'playing') return;
        shiftState = tick(shiftState, SHIFT_CLOCK_SECONDS + 1);
        pendingCustomers = {};
        cookMiniGame = null;
        for (const id of TABLE_IDS) shiftState = cleanTable(shiftState, id);
        shiftState = washDishes(shiftState);
        shiftState = shutDown(shiftState);
      },
      /** Marks the current shift upset via a real wrong-dish serve, before skipToClosing(). */
      forceUpset() {
        if (!running || !shiftState || shiftState.phase !== 'playing') return;
        shiftState = serveDish(shiftState, TABLE_IDS[0], '__test-nonexistent-dish__');
      },
      /** Runs the real endShift() paycheck flow once shutdown is complete. */
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
    interactHint: document.getElementById('cooking-interact-hint'),
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
