// Fishing Game canvas engine: rendering, input, collision, spawning, and
// localStorage progress persistence (docs/features/fishing-game.md,
// "Client-side Behavior (non-HTMX)" and "Business Rules / Validation").
//
// This file owns everything HTMX cannot model for /fishing-game: the
// `requestAnimationFrame` loop, keyboard/touch steering, sprite spawning
// and movement, collision detection, HUD updates, and the single
// `localStorage` progress key. All round-state *transitions* (lives,
// streak, invulnerability, depth cap) are delegated to the pure
// `./fishing/engine-state.js` module rather than reimplemented inline here
// — this file only decides *when* those transitions happen (a collision
// was detected, a frame elapsed) and *how* to draw/store the result.
// Fish-variety/spawn-weight/descent-speed/token math is delegated the same
// way to `./fishing/rules.js`.
//
// External file, no inline <script> tag, per this codebase's CSP-compatible
// convention (see theme-toggle.js, header-scroll.js, resume-print.js) and
// docs/features/home.md's Security Considerations. Loaded as an ES module
// (it uses `import`), e.g.:
//
//   <script type="module" src="/static/js/fishing-game.js"></script>
//
// from web/templates/pages/fishing-game.html (a separate, not-yet-built
// task) — see this file's exported `init()` doc comment below for the DOM
// contract that page must provide.
//
// Nothing below touches `document`/`window`/canvas at module-evaluation
// time: every DOM read/write happens inside `init()` or functions it
// calls, and the only top-level side effect is the auto-bootstrap at the
// bottom of this file, itself guarded by `typeof document !== 'undefined'`
// so importing this module under Node (e.g. `node --check`, or an
// import-only smoke test) never touches a nonexistent DOM.

import { fishSpawnPool, streakMultiplier, roundTokens, descentSpeed, DEPTH_CAP_MILES, sonarLookaheadSeconds } from './fishing/rules.js';
import { createInitialState, applyHazardHit, applyFishCatch, advance, DEFAULT_LIVES } from './fishing/engine-state.js';
import { scrollOffsetForFrame, spawnY, scrollSprite, isOffScreen } from './fishing/world-scroll.js';
import { castProgress, boatOpacityForDepth } from './fishing/boat-visuals.js';

// ---------------------------------------------------------------------------
// localStorage progress (doc: "reads/writes a single localStorage key")
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'fishing-game:v1';

/**
 * rules.js's `descentSpeed()` documents its own units as "arbitrary game
 * units" (its comment: "e.g. px/frame at 60fps") — deliberately left for
 * the canvas layer to interpret, since rules.js has no notion of a canvas
 * or frame rate. This is that interpretation: depth-miles descended per
 * second at the base speed (1.0). A 1000-mile round completes in roughly
 * 1000 / DEPTH_MILES_PER_SECOND_AT_BASE_SPEED seconds at minimum speed,
 * proportionally faster as descentSpeed ramps toward its max (5.0).
 */
const DEPTH_MILES_PER_SECOND_AT_BASE_SPEED = 8;

/**
 * Fixed y-positions for the boat hull and the hook hanging from it (doc's
 * Visual Direction: "The boat/rod is the only screen-fixed element ... it
 * sits anchored near the top of the canvas and never moves vertically").
 * Neither value ever changes during play — only `boat.x` does, driven by
 * input. BOAT_Y reuses the old fixed-diver y (~70px, per this task's brief).
 * HOOK_Y sits further down (within the doc's suggested ~140-200px band) and
 * doubles as the collision-detection anchor for fish/hazard overlap — the
 * functional replacement for the old diver's single hitbox position.
 */
const BOAT_Y = 70;
const HOOK_Y = 170;

/** Gear keys and their shop definitions (doc: "Gear upgrades", illustrative costs/levels — tune during build). */
export const GEAR_DEFS = {
  hullPlating: { label: 'Hull Plating', baseCost: 40, costGrowth: 1.6, maxLevel: 5 },
  ballastThrusters: { label: 'Ballast Thrusters', baseCost: 35, costGrowth: 1.6, maxLevel: 5 },
  magneticLure: { label: 'Magnetic Lure', baseCost: 35, costGrowth: 1.6, maxLevel: 5 },
  sonarRange: { label: 'Sonar Range', baseCost: 30, costGrowth: 1.6, maxLevel: 5 },
  goldenBait: { label: 'Golden Bait', baseCost: 45, costGrowth: 1.7, maxLevel: 5 },
  // Once-per-round safety net, not a stacking stat (doc: "deliberately not
  // just another flat number") — modeled as a single level 0/1 unlock.
  emergencyBallast: { label: 'Emergency Ballast', baseCost: 60, costGrowth: 1, maxLevel: 1 },
};

function defaultSave() {
  const gear = {};
  Object.keys(GEAR_DEFS).forEach((key) => { gear[key] = 0; });
  return { version: 1, tokens: 0, gear, bestScore: 0, bestDepth: 0 };
}

/** Feature-detects a real, usable localStorage (private browsing / disabled storage safe). */
function probeStorageAvailable() {
  try {
    const probeKey = '\0fishing-game-probe';
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
  if (typeof value.tokens !== 'number' || !Number.isFinite(value.tokens)) return false;
  if (typeof value.bestScore !== 'number' || !Number.isFinite(value.bestScore)) return false;
  if (typeof value.bestDepth !== 'number' || !Number.isFinite(value.bestDepth)) return false;
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
    save.tokens = Math.max(0, parsed.tokens);
    save.bestScore = Math.max(0, parsed.bestScore);
    save.bestDepth = Math.max(0, parsed.bestDepth);
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
    // Storage became unavailable mid-session (quota, private-mode edge
    // case) — the game stays fully playable for the rest of this session
    // per the doc; it just silently stops persisting.
  }
}

function gearCost(key, currentLevel) {
  const def = GEAR_DEFS[key];
  return Math.round(def.baseCost * Math.pow(def.costGrowth, currentLevel));
}

// ---------------------------------------------------------------------------
// Gear effects (applied only at round start — doc: "apply starting the next
// round, not retroactively to a round in progress")
// ---------------------------------------------------------------------------

function livesForSave(save) {
  return DEFAULT_LIVES + save.gear.hullPlating;
}

function steeringSpeedForSave(save) {
  // px/second lateral speed; each Ballast Thrusters level adds 15%.
  return 220 * (1 + 0.15 * save.gear.ballastThrusters);
}

function catchRadiusForSave(save) {
  // Base hook hitbox radius plus a per-level Magnetic Lure bonus.
  return 18 + 6 * save.gear.magneticLure;
}

/** Golden Bait is not modeled in rules.js's fishSpawnPool (that function's
 * weighting is fixed by the doc to depth+streak only); applied as a local
 * post-process that further boosts the pool's higher-point entries, kept
 * entirely inside this file so rules.js's contract is untouched. */
function applyGoldenBaitBias(pool, goldenBaitLevel) {
  if (!goldenBaitLevel) return pool;
  const boost = 0.15 * goldenBaitLevel;
  const maxPoints = Math.max(...pool.map((f) => f.points));
  return pool.map((f) => ({
    ...f,
    weight: f.points === maxPoints ? f.weight * (1 + boost) : f.weight,
  }));
}

function weightedPick(pool, random) {
  const totalWeight = pool.reduce((sum, item) => sum + item.weight, 0);
  let roll = random() * totalWeight;
  for (const item of pool) {
    roll -= item.weight;
    if (roll <= 0) return item;
  }
  return pool[pool.length - 1];
}

// ---------------------------------------------------------------------------
// Hazards (doc's Business Rules "Hazards" table — free 2D positioning, not
// lanes)
// ---------------------------------------------------------------------------

const HAZARD_BANDS = [
  { min: 0, max: 200, name: 'Jellyfish', slug: 'jellyfish', speed: 40, hitboxRadius: 14, behavior: 'drift' },
  { min: 200, max: 500, name: 'Rock / mine', slug: 'rock', speed: 15, hitboxRadius: 26, behavior: 'drift' },
  { min: 500, max: 800, name: 'Eel', slug: 'eel', speed: 110, hitboxRadius: 16, behavior: 'erratic' },
  { min: 800, max: DEPTH_CAP_MILES, name: 'Shark', slug: 'shark', speed: 150, hitboxRadius: 22, behavior: 'seek' },
];

function hazardBandFor(depthMiles) {
  const depth = Math.min(Math.max(depthMiles, 0), DEPTH_CAP_MILES);
  return HAZARD_BANDS.find((band) => depth >= band.min && (depth < band.max || band.max === DEPTH_CAP_MILES))
    || HAZARD_BANDS[HAZARD_BANDS.length - 1];
}

/** Hazard spawn interval shrinks (more frequent) with depth, per the doc. */
function hazardSpawnIntervalSeconds(depthMiles) {
  const depth = Math.min(Math.max(depthMiles, 0), DEPTH_CAP_MILES);
  const MIN_INTERVAL = 0.9;
  const MAX_INTERVAL = 3.0;
  return MAX_INTERVAL - (MAX_INTERVAL - MIN_INTERVAL) * (depth / DEPTH_CAP_MILES);
}

function fishSpawnIntervalSeconds() {
  return 1.1;
}

function slugifyFishName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// ---------------------------------------------------------------------------
// Sprite factories
// ---------------------------------------------------------------------------

let spriteIdCounter = 0;
function nextSpriteId() {
  spriteIdCounter += 1;
  return spriteIdCounter;
}

// Sprite images (doc's Client-side Behavior "Sprite image rendering"): real
// fish-*.svg/hazard-*.svg art (web/static/images/fishing/) in place of the
// flat-circle placeholder. Module-level, not per-`init()` instance, so an
// `Image` loaded on an earlier round/page visit stays cached across "Dive
// Again" and repeated `init()` calls rather than being re-fetched every
// round. Keyed by "kind:imageSlug" (not just imageSlug) since fish and
// hazard files live in separate namespaces but a slug collision between them
// isn't otherwise ruled out. One `Image` object per distinct variety — every
// on-screen sprite of that variety shares it, never one fetch per instance.
const spriteImageCache = new Map();

function spriteImagePath(kind, imageSlug) {
  return `/static/images/fishing/${kind === 'fish' ? 'fish' : 'hazard'}-${imageSlug}.svg`;
}

function getSpriteImage(kind, imageSlug) {
  const key = `${kind}:${imageSlug}`;
  let image = spriteImageCache.get(key);
  if (!image) {
    image = new Image();
    image.src = spriteImagePath(kind, imageSlug);
    spriteImageCache.set(key, image);
  }
  return image;
}

// Sprites now spawn just past the bottom edge (`spawnY`, from world-scroll.js)
// instead of off the left/right edges — their vertical motion is driven
// entirely by the shared world-scroll offset applied in the game loop, not
// an independent per-sprite vertical velocity (doc's Business Rules:
// "Horizontal movement is free/continuous ... There is no vertical
// positioning to speak of"). `vx` here is only ever a horizontal
// wobble/chase component layered on top of that shared scroll.

function spawnFishSprite(worldWidth, worldHeight, depthMiles, streak, goldenBaitLevel, random) {
  const pool = applyGoldenBaitBias(fishSpawnPool(depthMiles, streak), goldenBaitLevel);
  const picked = weightedPick(pool, random);
  const wobbleDirection = random() < 0.5 ? -1 : 1;
  return {
    id: nextSpriteId(),
    kind: 'fish',
    name: picked.name,
    points: picked.points,
    rare: !!picked.rare,
    imageSlug: slugifyFishName(picked.name),
    x: 30 + random() * Math.max(1, worldWidth - 60),
    y: spawnY(worldHeight),
    vx: wobbleDirection * (20 + random() * 30),
    hitboxRadius: picked.rare ? 20 : 14,
  };
}

function spawnHazardSprite(worldWidth, worldHeight, depthMiles, random) {
  const band = hazardBandFor(depthMiles);
  const wobbleDirection = random() < 0.5 ? -1 : 1;
  return {
    id: nextSpriteId(),
    kind: 'hazard',
    name: band.name,
    imageSlug: band.slug,
    behavior: band.behavior,
    x: 30 + random() * Math.max(1, worldWidth - 60),
    y: spawnY(worldHeight),
    vx: wobbleDirection * band.speed,
    speed: band.speed,
    hitboxRadius: band.hitboxRadius,
  };
}

// ---------------------------------------------------------------------------
// Collision
// ---------------------------------------------------------------------------

function circlesOverlap(ax, ay, ar, bx, by, br) {
  const dx = ax - bx;
  const dy = ay - by;
  const distance = Math.sqrt(dx * dx + dy * dy);
  return distance <= ar + br;
}

// ---------------------------------------------------------------------------
// init()
// ---------------------------------------------------------------------------

/**
 * Wires up and starts the Fishing Game against a real canvas + HUD/overlay
 * elements. Does nothing at import time (see file header) — must be called
 * explicitly once the page's DOM exists.
 *
 * DOM contract (`elements`) — see this file's accompanying report for the
 * full rationale; every key below is required unless noted optional:
 *
 *   canvas                       <canvas id="fishing-canvas">, the game surface.
 *   hud: {
 *     depth, score, lives, tokens, streak   — HUD text nodes, updated every frame while playing.
 *     sonarCallout                 — optional; names the upcoming hazard when Sonar Range's lookahead window is active, hidden otherwise.
 *   }
 *   startScreen: {
 *     root                        — #fishing-start-screen, shown before a round starts.
 *     tokens, bestScore, bestDepth — text nodes populated from the save on init/round-end.
 *     diveButton                  — "Start Dive" button.
 *     shopButton                  — optional "Open Shop" button from the start screen.
 *     storageNotice                — optional; unhidden when localStorage is unavailable.
 *   }
 *   roundOverScreen: {
 *     root                        — #fishing-round-over-screen.
 *     title                        — "You were caught!" / "You reached the abyss!".
 *     fishCaught, score, depth, tokens — summary text nodes.
 *     nameInput                    — optional leaderboard display-name <input>.
 *     scoreInput, depthInput       — optional hidden inputs an hx-post submit form reads
 *                                    (this file sets their `.value`; it does not itself POST —
 *                                    see the doc's HTMX Interactions table).
 *     submitButton                 — optional; disabled once already submitted this round.
 *     diveAgainButton, shopButton  — buttons.
 *   }
 *   shopScreen: {
 *     root                        — #fishing-shop-screen.
 *     tokens                       — balance text node.
 *     closeButton, resetButton     — buttons; resetButton triggers a native confirm().
 *     gearItems: { [gearKey]: { levelText, costText, buyButton } }
 *                                  — one entry per key in `GEAR_DEFS`
 *                                    ('hullPlating', 'ballastThrusters',
 *                                    'magneticLure', 'sonarRange',
 *                                    'goldenBait', 'emergencyBallast').
 *   }
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} elements - see DOM contract above (hud/startScreen/roundOverScreen/shopScreen).
 * @returns {() => void} a teardown function (also auto-invoked on htmx nav-away).
 */
export function init(canvas, elements) {
  // Tear down any previous instance first — defensive against init() being
  // called twice without an intervening navigation (e.g. hot reload during
  // development).
  if (typeof teardownActiveInstance === 'function') teardownActiveInstance();

  const ctx = canvas.getContext('2d');
  const storageAvailable = probeStorageAvailable();
  let save = loadSave(storageAvailable);

  if (elements.startScreen.storageNotice) {
    elements.startScreen.storageNotice.classList.toggle('hidden', storageAvailable);
  }

  const random = Math.random;

  let world = { width: canvas.width, height: canvas.height };
  // The boat/line/hook move together as a single rigid horizontal unit
  // (doc's Business Rules: "the hook has no independent movement relative
  // to the boat") — `boat.x` is the one position every input method drives.
  // Vertical position is never tracked here; BOAT_Y/HOOK_Y are fixed
  // constants (see their doc comment above).
  let boat = { x: world.width / 2, vx: 0 };
  let input = { left: false, right: false, dragTargetX: null, mouseTargetX: null };
  let sprites = [];
  let timeSinceFishSpawn = 0;
  let timeSinceHazardSpawn = 0;
  // Accumulated world-scroll distance (px), used only to phase the
  // repeating background pattern — sprite positions themselves are moved
  // directly via world-scroll.js's `scrollSprite` each frame, not derived
  // from this accumulator.
  let worldScrollOffset = 0;
  let state = null; // engine-state RoundState, set by startRound()
  let running = false;
  let rafHandle = null;
  let lastTimestamp = null;
  let paused = false;
  let submittedThisRound = false;
  let fishCaughtCount = 0;

  // -- Screen visibility -----------------------------------------------

  function showScreen(which) {
    elements.startScreen.root.classList.toggle('hidden', which !== 'start');
    elements.roundOverScreen.root.classList.toggle('hidden', which !== 'round-over');
    elements.shopScreen.root.classList.toggle('hidden', which !== 'shop');
  }

  // -- Start screen -------------------------------------------------------

  function renderStartScreen() {
    elements.startScreen.tokens.textContent = String(save.tokens);
    elements.startScreen.bestScore.textContent = String(Math.round(save.bestScore));
    elements.startScreen.bestDepth.textContent = String(Math.round(save.bestDepth));
    showScreen('start');
  }

  // -- Shop -----------------------------------------------------------

  function renderShop() {
    elements.shopScreen.tokens.textContent = String(save.tokens);
    Object.keys(GEAR_DEFS).forEach((key) => {
      const row = elements.shopScreen.gearItems[key];
      if (!row) return;
      const level = save.gear[key];
      const def = GEAR_DEFS[key];
      const maxed = level >= def.maxLevel;
      row.levelText.textContent = String(level);
      row.costText.textContent = maxed ? 'MAX' : String(gearCost(key, level));
      if (row.buyButton) {
        const affordable = !maxed && save.tokens >= gearCost(key, level);
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
    if (save.tokens < cost) return; // functionally disabled, not just visually — doc's UI table
    save.tokens -= cost;
    save.gear[key] = level + 1;
    persistSave(storageAvailable, save);
    renderShop();
  }

  function openShop() {
    renderShop();
    showScreen('shop');
  }

  function resetProgress() {
    if (!window.confirm('Reset all fishing game progress? This clears your tokens, gear, and best score/depth and cannot be undone.')) {
      return;
    }
    save = defaultSave();
    persistSave(storageAvailable, save);
    renderShop();
    renderStartScreen();
  }

  // -- HUD --------------------------------------------------------------

  function renderHud() {
    elements.hud.depth.textContent = Math.round(state.depthMiles).toString();
    elements.hud.score.textContent = Math.round(state.score).toString();
    elements.hud.lives.textContent = String(Math.max(0, state.lives));
    elements.hud.tokens.textContent = String(save.tokens);
    elements.hud.streak.textContent = streakMultiplier(state.milesSinceLastHit).toFixed(2) + 'x';
  }

  // Purely informational per the same discipline as the cast animation/boat
  // fade above: this only ever writes to a HUD text node's content/visibility.
  // It never gates or delays real hazard spawning or collision detection —
  // those still run on the actual `hazardSpawnIntervalSeconds`/
  // `timeSinceHazardSpawn` values untouched by this function.
  function updateSonarCallout(name) {
    if (!elements.hud.sonarCallout) return;
    if (name) {
      elements.hud.sonarCallout.textContent = `Sonar: ${name} incoming`;
      elements.hud.sonarCallout.classList.remove('hidden');
    } else {
      elements.hud.sonarCallout.classList.add('hidden');
    }
  }

  // -- Round lifecycle ----------------------------------------------------

  function startRound() {
    state = createInitialState({
      lives: livesForSave(save),
      emergencyBallastCharged: save.gear.emergencyBallast > 0,
    });
    sprites = [];
    timeSinceFishSpawn = 0;
    timeSinceHazardSpawn = 0;
    boat = { x: world.width / 2, vx: 0 };
    worldScrollOffset = 0;
    submittedThisRound = false;
    fishCaughtCount = 0;
    lastTimestamp = null;
    running = true;
    paused = false;
    showScreen(null);
    renderHud();
    updateSonarCallout(null);
    if (rafHandle === null) rafHandle = window.requestAnimationFrame(loop);
  }

  function endRound() {
    running = false;
    if (rafHandle !== null) {
      window.cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
    updateSonarCallout(null);

    const tokensEarned = roundTokens(state.score, state.depthMiles);
    save.tokens += tokensEarned;
    save.bestScore = Math.max(save.bestScore, state.score);
    save.bestDepth = Math.max(save.bestDepth, state.depthMiles);
    persistSave(storageAvailable, save);

    const outcome = state.roundStatus; // 'caught' | 'reached-abyss'
    elements.roundOverScreen.root.dataset.outcome = outcome;
    elements.roundOverScreen.title.textContent = outcome === 'reached-abyss'
      ? 'You reached the abyss!'
      : 'You were caught!';
    elements.roundOverScreen.fishCaught.textContent = String(fishCaughtCount);
    elements.roundOverScreen.score.textContent = String(Math.round(state.score));
    elements.roundOverScreen.depth.textContent = String(Math.round(state.depthMiles));
    elements.roundOverScreen.tokens.textContent = String(tokensEarned);
    if (elements.roundOverScreen.scoreInput) elements.roundOverScreen.scoreInput.value = String(Math.round(state.score));
    if (elements.roundOverScreen.depthInput) elements.roundOverScreen.depthInput.value = String(Math.round(state.depthMiles));
    if (elements.roundOverScreen.submitButton) elements.roundOverScreen.submitButton.disabled = false;

    showScreen('round-over');
  }

  // -- Input ------------------------------------------------------------

  function onKeyDown(e) {
    const isMovementKey = e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A'
      || e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D';
    // A stale mouseTargetX (the cursor's last position over the canvas,
    // possibly from well before this keypress — e.g. wherever it sat when
    // "Start Dive" was clicked) must not silently regain control the
    // instant this key is released. Invalidate it here so keyboard fully
    // owns boat.x until the mouse actually moves again (which sets a fresh
    // mouseTargetX via onMouseMove) — otherwise updateBoat()'s keyboard >
    // drag > mouse priority order only holds while a key is *held*, and the
    // boat visibly snaps/eases back toward the old mouse position on
    // release.
    if (isMovementKey) input.mouseTargetX = null;
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') input.left = true;
    if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') input.right = true;
  }
  function onKeyUp(e) {
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') input.left = false;
    if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') input.right = false;
  }

  function canvasXFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    return ((clientX - rect.left) / rect.width) * world.width;
  }

  // Pointer Events unify mouse/touch/pen — 'pointerdown'/'pointermove'
  // fire for a plain desktop mouse click too, not just touch. Drag-to-steer
  // is documented as a touch/mobile mechanic (desktop already has instant
  // hover-tracking via onMouseMove below); without this guard, so much as
  // clicking the canvas — or holding the button while moving, a very
  // natural instinct — silently switched a mouse user onto this branch's
  // speed-capped easing instead of onMouseMove's instant tracking, which is
  // exactly what kept mouse steering feeling laggy even after mouseTargetX
  // itself was made instant. `e.pointerType` is `undefined` (not `'mouse'`)
  // for the legacy TouchEvents these two also handle via the
  // touchstart/touchmove listeners below, so touch drag is unaffected.
  function onPointerDown(e) {
    if (e.pointerType === 'mouse') return;
    input.dragTargetX = canvasXFromEvent(e);
  }
  function onPointerMove(e) {
    if (e.pointerType === 'mouse') return;
    if (input.dragTargetX === null) return;
    input.dragTargetX = canvasXFromEvent(e);
  }
  function onPointerUp() {
    input.dragTargetX = null;
  }

  // Desktop mouse steering (doc's Input section: "moving the mouse over the
  // canvas sets the boat's target horizontal position") — unlike
  // onPointerDown/Move above (a click-and-hold drag, still used for touch),
  // this tracks the cursor continuously with no button needed. Reuses the
  // same canvasXFromEvent CSS-vs-canvas-pixel conversion. Priority between
  // this, drag, and keyboard is resolved in updateBoat(), not here.
  function onMouseMove(e) {
    input.mouseTargetX = canvasXFromEvent(e);
  }
  function onMouseLeave() {
    input.mouseTargetX = null;
  }

  function onVisibilityChange() {
    paused = document.hidden;
    if (!paused && running && rafHandle === null) {
      lastTimestamp = null;
      rafHandle = window.requestAnimationFrame(loop);
    }
  }

  // -- Simulation ---------------------------------------------------------

  function updateBoat(deltaSeconds) {
    const steeringSpeed = steeringSpeedForSave(save);
    // Keyboard directly sets velocity and overrides any in-flight
    // mouse/drag target tracking while a key is held, so the three input
    // methods never fight each other over the one shared position (doc:
    // "All three input methods drive the same single horizontal position").
    const keyboardActive = input.left || input.right;
    if (keyboardActive) {
      let dx = 0;
      if (input.left) dx -= 1;
      if (input.right) dx += 1;
      boat.x += dx * steeringSpeed * deltaSeconds;
    } else if (input.dragTargetX !== null) {
      const dx = input.dragTargetX - boat.x;
      boat.x += Math.max(-steeringSpeed * deltaSeconds, Math.min(steeringSpeed * deltaSeconds, dx));
    } else if (input.mouseTargetX !== null) {
      // Instant 1:1 tracking, not rate-limited like keyboard/drag: the
      // mouse "sets the boat's target horizontal position" (doc's Input
      // section) rather than a direction to steer in, so the boat's x
      // should just *be* the cursor's x every frame. Capping this to
      // steeringSpeed (as keyboard/drag do) made the boat visibly lag
      // behind any normal-speed mouse movement across the canvas.
      boat.x = input.mouseTargetX;
    }
    boat.x = Math.max(16, Math.min(world.width - 16, boat.x));
  }

  function updateSprite(sprite, deltaSeconds) {
    // Vertical motion belongs entirely to the shared world scroll (applied
    // separately in loop() via world-scroll.js's scrollSprite) — this
    // function only ever touches `x` (doc's Business Rules: "movement" for
    // every sprite here "is a horizontal-only component layered on top of
    // the shared upward scroll").
    if (sprite.kind === 'hazard' && sprite.behavior === 'seek') {
      // Shark: actively steers horizontally toward the boat/hook's current
      // x-position (doc) — there's no vertical target to chase since the
      // hook's y is fixed.
      const dx = boat.x - sprite.x;
      if (Math.abs(dx) > 0.5) {
        sprite.x += Math.sign(dx) * sprite.speed * deltaSeconds;
      }
      return;
    }
    if (sprite.kind === 'hazard' && sprite.behavior === 'erratic') {
      // Eel: fast, erratic movement — now expressed purely horizontally.
      sprite.vx = (sprite.vx || 0) + (random() - 0.5) * 240 * deltaSeconds;
      sprite.vx = Math.max(-sprite.speed * 1.5, Math.min(sprite.speed * 1.5, sprite.vx));
    }
    sprite.x += sprite.vx * deltaSeconds;
    // Keep horizontal wobble/chase within the play area rather than
    // drifting off the side indefinitely (despawning is now solely a
    // function of the vertical world scroll via isOffScreen, not horizontal
    // position).
    if (sprite.x < 20) {
      sprite.x = 20;
      sprite.vx = Math.abs(sprite.vx);
    } else if (sprite.x > world.width - 20) {
      sprite.x = world.width - 20;
      sprite.vx = -Math.abs(sprite.vx);
    }
  }

  function handleCollisions() {
    const catchRadius = catchRadiusForSave(save);
    const remaining = [];
    for (const sprite of sprites) {
      const hookRadius = sprite.kind === 'fish' ? catchRadius : 18;
      const overlapping = circlesOverlap(boat.x, HOOK_Y, hookRadius, sprite.x, sprite.y, sprite.hitboxRadius);
      if (!overlapping) {
        remaining.push(sprite);
        continue;
      }
      // Fish/hazard overlap resolves independently, per the doc — no
      // priority between a catch and a hit in the same frame.
      if (sprite.kind === 'fish') {
        state = applyFishCatch(state, sprite);
        fishCaughtCount += 1;
        continue; // caught fish is removed
      }
      if (sprite.kind === 'hazard') {
        state = applyHazardHit(state, state.elapsedSeconds);
        remaining.push(sprite); // hazard sprite persists past a hit
        continue;
      }
      remaining.push(sprite);
    }
    sprites = remaining;
  }

  function loop(timestamp) {
    if (!running || paused) { rafHandle = null; return; }
    if (lastTimestamp === null) lastTimestamp = timestamp;
    const deltaSeconds = Math.min(0.1, (timestamp - lastTimestamp) / 1000);
    lastTimestamp = timestamp;

    updateBoat(deltaSeconds);

    const streak = streakMultiplier(state.milesSinceLastHit);
    const speed = descentSpeed(state.depthMiles, state.elapsedSeconds);
    const deltaMiles = speed * DEPTH_MILES_PER_SECOND_AT_BASE_SPEED * deltaSeconds;
    const { state: advanced } = advance(state, deltaMiles, deltaSeconds);
    state = advanced;

    // World scroll: feed the *same* `speed` value used for the depth-miles
    // conversion above into world-scroll.js, per the doc's explicit
    // requirement that visual scroll rate and scoring-relevant descent
    // speed never diverge (see world-scroll.js's module doc comment).
    const scrollOffsetPx = scrollOffsetForFrame(speed, deltaSeconds);
    worldScrollOffset += scrollOffsetPx;

    timeSinceFishSpawn += deltaSeconds;
    timeSinceHazardSpawn += deltaSeconds;
    if (timeSinceFishSpawn >= fishSpawnIntervalSeconds()) {
      timeSinceFishSpawn = 0;
      sprites.push(spawnFishSprite(world.width, world.height, state.depthMiles, streak, save.gear.goldenBait, random));
    }
    if (timeSinceHazardSpawn >= hazardSpawnIntervalSeconds(state.depthMiles)) {
      timeSinceHazardSpawn = 0;
      sprites.push(spawnHazardSprite(world.width, world.height, state.depthMiles, random));
    }

    // Sonar Range gear's HUD callout: purely informational — names the next
    // hazard once its predicted spawn falls within the purchased gear
    // level's lookahead window. Reads (never writes) `state.depthMiles`,
    // `timeSinceHazardSpawn`, and `save.gear.sonarRange`; never gates or
    // delays the real spawn/collision logic above. Runs after the spawn
    // block above so that on the frame a hazard actually spawns,
    // `timeSinceHazardSpawn` has already reset to 0 and the callout clears
    // itself with no special-casing.
    const hazardLookahead = sonarLookaheadSeconds(save.gear.sonarRange);
    const timeUntilNextHazard = hazardSpawnIntervalSeconds(state.depthMiles) - timeSinceHazardSpawn;
    const upcomingHazardName = hazardLookahead > 0 && timeUntilNextHazard <= hazardLookahead
      ? hazardBandFor(state.depthMiles).name
      : null;
    updateSonarCallout(upcomingHazardName);

    // Horizontal wobble/chase first (mutates in place, existing
    // convention), then the shared vertical scroll (pure — returns new
    // sprite objects per world-scroll.js's contract), then drop anything
    // that has scrolled past the top edge.
    sprites.forEach((s) => updateSprite(s, deltaSeconds));
    sprites = sprites.map((s) => scrollSprite(s, scrollOffsetPx)).filter((s) => !isOffScreen(s));
    handleCollisions();
    renderHud();
    render();

    if (state.roundStatus !== 'playing') {
      endRound();
      return;
    }

    rafHandle = window.requestAnimationFrame(loop);
  }

  // -- Rendering ----------------------------------------------------------

  const OCEAN_TOP = '#0b3d59';
  const OCEAN_BOTTOM = '#01111f';

  // Tile size (px) for the scrolling water background — a simple repeating
  // horizontal-line pattern, phased by `worldScrollOffset` so it reads as
  // continuously flowing water (doc's World scroll note: the actual visual
  // fix for "I don't see it going down"). Purely decorative; no collision
  // relevance.
  const BG_TILE_SIZE = 90;

  function drawScrollingBackground() {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    const shift = worldScrollOffset % BG_TILE_SIZE;
    const rowCount = Math.ceil(world.height / BG_TILE_SIZE) + 2;
    for (let i = -1; i <= rowCount; i += 1) {
      const y = i * BG_TILE_SIZE - shift;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(world.width, y);
      ctx.stroke();
    }
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  // Boat/rod/fisherman + line + hook, drawn with canvas primitives (no image
  // asset — matches how fish/hazard sprites already render as placeholder
  // shapes; see the doc's Open Questions on diver.svg being superseded). The
  // line runs straight from the rod tip to the (cast-animated) hook
  // position: no independent swing, since the whole assembly only ever
  // moves horizontally as one rigid unit via `boat.x`.
  //
  // Purely cosmetic per the doc's Business Rules callout: `cast` and
  // `boatOpacity` below only ever change what's drawn and how transparent it
  // is. handleCollisions() elsewhere uses the real, constant `boat.x`/
  // `HOOK_Y` regardless of either value.
  function drawBoat() {
    const x = boat.x;
    const cast = castProgress(state.elapsedSeconds);
    const boatOpacity = boatOpacityForDepth(state.depthMiles);

    const rodTipX = x + 22;
    const rodTipY = BOAT_Y - 20;

    // Hull, rod, and fisherman fade together with depth (doc's Visual
    // Direction: "the boat/fisherman/rod group gradually fades"). Scoped
    // with save()/restore() rather than resetting globalAlpha manually so
    // canvas state can't leak into whatever draws next.
    ctx.save();
    ctx.globalAlpha = boatOpacity;

    // Hull.
    ctx.beginPath();
    ctx.moveTo(x - 26, BOAT_Y);
    ctx.lineTo(x + 26, BOAT_Y);
    ctx.lineTo(x + 18, BOAT_Y + 14);
    ctx.lineTo(x - 18, BOAT_Y + 14);
    ctx.closePath();
    ctx.fillStyle = '#6b4423';
    ctx.fill();
    ctx.strokeStyle = '#3d2814';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Rod.
    ctx.beginPath();
    ctx.moveTo(x + 8, BOAT_Y);
    ctx.lineTo(rodTipX, rodTipY);
    ctx.strokeStyle = '#c9a063';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Fisherman — a small flat silhouette (body + head) standing in the
    // hull near the rod's base, holding the rod (doc's Visual Direction: "A
    // fisherman figure stands in the boat"). Same solid-fill-plus-stroke,
    // no-gradient style as the hull above and the fish/hazard sprites in
    // render().
    const fishermanX = x + 6;
    const feetY = BOAT_Y;
    const bodyTopY = BOAT_Y - 20;
    const headRadius = 5;
    const headCenterY = bodyTopY - headRadius;
    ctx.fillStyle = '#2b2118';
    ctx.strokeStyle = '#150f0a';
    ctx.lineWidth = 1.5;
    // Body: a small trapezoid (narrower at the shoulders, wider at the feet).
    ctx.beginPath();
    ctx.moveTo(fishermanX - 5, feetY);
    ctx.lineTo(fishermanX - 3, bodyTopY);
    ctx.lineTo(fishermanX + 3, bodyTopY);
    ctx.lineTo(fishermanX + 5, feetY);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // Head.
    ctx.beginPath();
    ctx.arc(fishermanX, headCenterY, headRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.restore();

    // Line + hook: always drawn at full opacity, in a separate pass after
    // restoring alpha, so they're never affected by boatOpacity (doc: "the
    // line and hook stay fully visible throughout"). The drawn endpoint is
    // interpolated from the rod tip (cast=0, start of round) to the real
    // hook position (cast=1, ~CAST_ANIMATION_SECONDS in) — the cast
    // animation only changes where this is drawn, never the real hook
    // position handleCollisions() uses.
    const drawnHookX = lerp(rodTipX, x, cast);
    const drawnHookY = lerp(rodTipY, HOOK_Y, cast);

    // Line, from the rod tip to the (possibly still-casting) hook position.
    ctx.beginPath();
    ctx.moveTo(rodTipX, rodTipY);
    ctx.lineTo(drawnHookX, drawnHookY);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Hook. Note this is only the drawn position — handleCollisions() uses
    // boat.x/HOOK_Y directly, independent of `cast`.
    ctx.beginPath();
    ctx.arc(drawnHookX, drawnHookY, 6, 0.3, Math.PI * 1.7);
    ctx.strokeStyle = '#e8e8e8';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  function render() {
    const gradient = ctx.createLinearGradient(0, 0, 0, world.height);
    gradient.addColorStop(0, OCEAN_TOP);
    gradient.addColorStop(1, OCEAN_BOTTOM);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, world.width, world.height);

    drawScrollingBackground();

    sprites.forEach((sprite) => {
      const image = getSpriteImage(sprite.kind, sprite.imageSlug);
      // Only draw the real sprite once its Image is confirmed loaded and
      // valid — `naturalWidth > 0` rules out a failed load that still
      // reports `complete` (the browser's documented behavior for a broken
      // image src). Otherwise fall back to the original flat-circle
      // rendering, per the UI states table's "Sprite image failed/slow to
      // load" row — never a blank gap or a broken-image glyph, and never
      // blocking the rest of the frame while an image is still loading.
      if (image.complete && image.naturalWidth > 0) {
        const size = sprite.hitboxRadius * 2.2;
        ctx.drawImage(image, sprite.x - size / 2, sprite.y - size / 2, size, size);
      } else {
        ctx.beginPath();
        ctx.fillStyle = sprite.kind === 'fish' ? (sprite.rare ? '#ffd54a' : '#5ec8ff') : '#ff5a5a';
        ctx.arc(sprite.x, sprite.y, sprite.hitboxRadius, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    const invulnerable = state.elapsedSeconds < state.invulnerableUntil;
    // Flicker feedback during the invulnerability window (doc's UI table:
    // "Brief visual/knockback feedback with a flicker").
    const flickerVisible = !invulnerable || Math.floor(state.elapsedSeconds * 10) % 2 === 0;
    if (flickerVisible) {
      drawBoat();
    }
  }

  // -- Wiring ---------------------------------------------------------

  function resizeCanvasToDisplaySize() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      canvas.width = rect.width;
      canvas.height = rect.height;
      world = { width: canvas.width, height: canvas.height };
    }
  }

  resizeCanvasToDisplaySize();
  window.addEventListener('resize', resizeCanvasToDisplaySize);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mouseleave', onMouseLeave);
  canvas.addEventListener('touchstart', onPointerDown, { passive: true });
  canvas.addEventListener('touchmove', onPointerMove, { passive: true });
  canvas.addEventListener('touchend', onPointerUp, { passive: true });
  document.addEventListener('visibilitychange', onVisibilityChange);

  elements.startScreen.diveButton.addEventListener('click', startRound);
  if (elements.startScreen.shopButton) elements.startScreen.shopButton.addEventListener('click', openShop);
  elements.roundOverScreen.diveAgainButton.addEventListener('click', startRound);
  elements.roundOverScreen.shopButton.addEventListener('click', openShop);
  if (elements.roundOverScreen.submitButton) {
    elements.roundOverScreen.submitButton.addEventListener('click', () => {
      // Actual submission is an hx-post per the doc's HTMX Interactions
      // table — this file only guards against a double-submit for the same
      // round; the request/response itself is not this file's concern.
      submittedThisRound = true;
      // Deferred one tick (real bug fixed here, caught by
      // e2e/fishing-game.spec.js's leaderboard-submission test): a submit
      // <button>'s default action — actually submitting its form, which is
      // what triggers htmx's hx-post interception — runs synchronously
      // right after this click listener returns, but only if the button is
      // still enabled at that point. Disabling it inline, in this same
      // handler, suppressed that default action entirely in both Chromium
      // and WebKit, so the leaderboard submission silently never fired.
      // setTimeout(0) lets the real submission happen first; it still
      // disables the button well before any realistic second click.
      setTimeout(() => { elements.roundOverScreen.submitButton.disabled = true; }, 0);
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
    window.removeEventListener('resize', resizeCanvasToDisplaySize);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('mousemove', onMouseMove);
    canvas.removeEventListener('mouseleave', onMouseLeave);
    canvas.removeEventListener('touchstart', onPointerDown);
    canvas.removeEventListener('touchmove', onPointerMove);
    canvas.removeEventListener('touchend', onPointerUp);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    document.body.removeEventListener('htmx:beforeSwap', teardown);
    if (teardownActiveInstance === teardown) teardownActiveInstance = null;
  }

  // Doc's Cleanup requirement: tear down on HTMX nav-away, not just full
  // page unload, so a backgrounded loop from a previous /fishing-game visit
  // doesn't keep running after #main-content is swapped for another page.
  //
  // htmx:beforeSwap bubbles to document.body for EVERY htmx swap anywhere on
  // the page, not just page-level navigation — including this very page's
  // own #fishing-leaderboard fragment refreshing itself (its hx-trigger="load"
  // self-swap, and every later leaderboard-submit swap). Without the target
  // check below, that unrelated local refresh was mistaken for "navigating
  // away," tearing down every input listener (keyboard/mouse/touch) moments
  // after page load while the render loop itself kept running — depth,
  // scoring, and spawning all looked completely normal, only steering was
  // silently dead, which is why this needed real interactive testing to
  // catch rather than the existing automated suite (none of which drives
  // actual keyboard/mouse input). Only tear down for the real page-level
  // swap, identified by its target being #main-content itself.
  document.body.addEventListener('htmx:beforeSwap', (e) => {
    if (e.target && e.target.id === 'main-content') teardown();
  });

  teardownActiveInstance = teardown;

  // Test-only debug hook for e2e/fishing-game.spec.js. Reaching round-over
  // "naturally" depends on Math.random()-driven fish/hazard spawn timing
  // (a hazard hit) or a full 1000-mile descent, either of which is too slow
  // and/or flaky to wait out reliably from a browser test. This hook drives
  // the exact same transitions real play uses — applyHazardHit/advance from
  // ./fishing/engine-state.js, then the real endRound() below — so a
  // test-forced round-over exercises the identical code path a real round
  // would; nothing here is a parallel/faked "test mode". Left unconditional
  // (no build/env flag) since this is a personal portfolio site with no
  // stakes riding on the game, and this codebase has no existing env-flag
  // mechanism worth inventing just to hide a harmless no-op-in-production
  // global.
  if (typeof window !== 'undefined') {
    window.__fishingGameTestHooks = {
      /**
       * Forces the in-progress round to end via the real round-over path.
       * @param {'caught'|'reached-abyss'} [outcome='caught']
       */
      forceRoundOver(outcome) {
        if (!running || !state || state.roundStatus !== 'playing') return;
        if (outcome === 'reached-abyss') {
          state = advance(state, DEPTH_CAP_MILES, 0).state;
        } else {
          // Apply real hazard hits, each timed just past the previous
          // invulnerability window, until lives reach 0. An Emergency
          // Ballast charge (if any) absorbs the first one for free, exactly
          // as in real play, before subsequent hits start costing lives —
          // the loop just keeps calling the same real transition either way.
          let guard = 0;
          while (state.roundStatus === 'playing' && state.lives > 0 && guard < 20) {
            state = applyHazardHit(state, state.invulnerableUntil + 0.01);
            guard += 1;
          }
        }
        if (state.roundStatus !== 'playing') endRound();
      },
    };
  }

  renderStartScreen();

  return teardown;
}

let teardownActiveInstance = null;

// ---------------------------------------------------------------------------
// Auto-bootstrap (browser only) — guarded so importing this module (e.g.
// `node --check`, or a test importing it for a syntax/shape smoke check)
// never touches `document`. See file header and point (b) of this task's
// brief: init() itself takes elements as arguments and never queries the
// DOM on its own, so this block is the *only* place this file looks
// elements up by ID — kept intentionally thin.
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
  const canvas = document.getElementById('fishing-canvas');
  if (!canvas) return; // this page isn't mounted — no-op, same convention as carousel.js

  const shopRoot = document.getElementById('fishing-shop-screen');

  const elements = {
    hud: {
      depth: document.getElementById('fishing-hud-depth'),
      score: document.getElementById('fishing-hud-score'),
      lives: document.getElementById('fishing-hud-lives'),
      tokens: document.getElementById('fishing-hud-tokens'),
      streak: document.getElementById('fishing-hud-streak'),
      sonarCallout: document.getElementById('fishing-sonar-callout'),
    },
    startScreen: {
      root: document.getElementById('fishing-start-screen'),
      tokens: document.getElementById('fishing-start-tokens'),
      bestScore: document.getElementById('fishing-start-best-score'),
      bestDepth: document.getElementById('fishing-start-best-depth'),
      diveButton: document.getElementById('fishing-start-dive-button'),
      shopButton: document.getElementById('fishing-start-shop-button'),
      storageNotice: document.getElementById('fishing-storage-notice'),
    },
    roundOverScreen: {
      root: document.getElementById('fishing-round-over-screen'),
      title: document.getElementById('fishing-round-over-title'),
      fishCaught: document.getElementById('fishing-round-over-fish-caught'),
      score: document.getElementById('fishing-round-over-score'),
      depth: document.getElementById('fishing-round-over-depth'),
      tokens: document.getElementById('fishing-round-over-tokens'),
      nameInput: document.getElementById('fishing-round-over-name-input'),
      scoreInput: document.getElementById('fishing-round-over-score-input'),
      depthInput: document.getElementById('fishing-round-over-depth-input'),
      submitButton: document.getElementById('fishing-round-over-submit-button'),
      diveAgainButton: document.getElementById('fishing-round-over-dive-again-button'),
      shopButton: document.getElementById('fishing-round-over-shop-button'),
    },
    shopScreen: {
      root: shopRoot,
      tokens: document.getElementById('fishing-shop-tokens'),
      closeButton: document.getElementById('fishing-shop-close-button'),
      resetButton: document.getElementById('fishing-shop-reset-button'),
      gearItems: queryGearItems(shopRoot),
    },
  };

  init(canvas, elements);
}

if (typeof document !== 'undefined') {
  bootstrap();
}
