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

import { fishSpawnPool, streakMultiplier, roundTokens, descentSpeed, DEPTH_CAP_MILES } from './fishing/rules.js';
import { createInitialState, applyHazardHit, applyFishCatch, advance, DEFAULT_LIVES } from './fishing/engine-state.js';

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
  // Base diver hitbox radius plus a per-level Magnetic Lure bonus.
  return 18 + 6 * save.gear.magneticLure;
}

function visibilityRangeForSave(save) {
  // How far ahead (px) sprites become visible/spawn-relevant; Sonar Range
  // does not change collision, only how early sprites appear on screen.
  return 1.0 + 0.12 * save.gear.sonarRange;
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

function spawnFishSprite(worldWidth, depthMiles, streak, goldenBaitLevel, random) {
  const pool = applyGoldenBaitBias(fishSpawnPool(depthMiles, streak), goldenBaitLevel);
  const picked = weightedPick(pool, random);
  const fromLeft = random() < 0.5;
  return {
    id: nextSpriteId(),
    kind: 'fish',
    name: picked.name,
    points: picked.points,
    rare: !!picked.rare,
    imageSlug: slugifyFishName(picked.name),
    x: fromLeft ? -30 : worldWidth + 30,
    y: 40 + random() * 200,
    vx: (fromLeft ? 1 : -1) * (40 + random() * 40),
    hitboxRadius: picked.rare ? 20 : 14,
  };
}

function spawnHazardSprite(worldWidth, depthMiles, random) {
  const band = hazardBandFor(depthMiles);
  const fromLeft = random() < 0.5;
  return {
    id: nextSpriteId(),
    kind: 'hazard',
    name: band.name,
    imageSlug: band.slug,
    behavior: band.behavior,
    x: fromLeft ? -30 : worldWidth + 30,
    y: 40 + random() * 200,
    vx: (fromLeft ? 1 : -1) * band.speed,
    vy: 0,
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
  let diver = { x: world.width / 2, y: 70, vx: 0 };
  let input = { left: false, right: false, dragTargetX: null };
  let sprites = [];
  let timeSinceFishSpawn = 0;
  let timeSinceHazardSpawn = 0;
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

  // -- Round lifecycle ----------------------------------------------------

  function startRound() {
    state = createInitialState({
      lives: livesForSave(save),
      emergencyBallastCharged: save.gear.emergencyBallast > 0,
    });
    sprites = [];
    timeSinceFishSpawn = 0;
    timeSinceHazardSpawn = 0;
    diver = { x: world.width / 2, y: 70, vx: 0 };
    submittedThisRound = false;
    fishCaughtCount = 0;
    lastTimestamp = null;
    running = true;
    paused = false;
    showScreen(null);
    renderHud();
    if (rafHandle === null) rafHandle = window.requestAnimationFrame(loop);
  }

  function endRound() {
    running = false;
    if (rafHandle !== null) {
      window.cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }

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

  function onPointerDown(e) {
    input.dragTargetX = canvasXFromEvent(e);
  }
  function onPointerMove(e) {
    if (input.dragTargetX === null) return;
    input.dragTargetX = canvasXFromEvent(e);
  }
  function onPointerUp() {
    input.dragTargetX = null;
  }

  function onVisibilityChange() {
    paused = document.hidden;
    if (!paused && running && rafHandle === null) {
      lastTimestamp = null;
      rafHandle = window.requestAnimationFrame(loop);
    }
  }

  // -- Simulation ---------------------------------------------------------

  function updateDiver(deltaSeconds) {
    const steeringSpeed = steeringSpeedForSave(save);
    if (input.dragTargetX !== null) {
      const dx = input.dragTargetX - diver.x;
      diver.x += Math.max(-steeringSpeed * deltaSeconds, Math.min(steeringSpeed * deltaSeconds, dx));
    } else {
      let dx = 0;
      if (input.left) dx -= 1;
      if (input.right) dx += 1;
      diver.x += dx * steeringSpeed * deltaSeconds;
    }
    diver.x = Math.max(16, Math.min(world.width - 16, diver.x));
  }

  function updateSprite(sprite, deltaSeconds) {
    if (sprite.kind === 'hazard' && sprite.behavior === 'seek') {
      // Shark: actively steers toward the diver's current position (doc).
      const dx = diver.x - sprite.x;
      const dy = diver.y - sprite.y;
      const distance = Math.sqrt(dx * dx + dy * dy) || 1;
      sprite.x += (dx / distance) * sprite.speed * deltaSeconds;
      sprite.y += (dy / distance) * sprite.speed * deltaSeconds;
      return;
    }
    if (sprite.kind === 'hazard' && sprite.behavior === 'erratic') {
      // Eel: fast, erratic — jitter vy each frame within a band.
      sprite.vy = (sprite.vy || 0) + (random() - 0.5) * 200 * deltaSeconds;
      sprite.vy = Math.max(-80, Math.min(80, sprite.vy));
      sprite.y = Math.max(20, Math.min(world.height - 20, sprite.y + sprite.vy * deltaSeconds));
    }
    sprite.x += sprite.vx * deltaSeconds;
  }

  function pruneOffscreen() {
    sprites = sprites.filter((s) => s.x > -60 && s.x < world.width + 60);
  }

  function handleCollisions() {
    const catchRadius = catchRadiusForSave(save);
    const remaining = [];
    for (const sprite of sprites) {
      const diverRadius = sprite.kind === 'fish' ? catchRadius : 18;
      const overlapping = circlesOverlap(diver.x, diver.y, diverRadius, sprite.x, sprite.y, sprite.hitboxRadius);
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

    updateDiver(deltaSeconds);

    const streak = streakMultiplier(state.milesSinceLastHit);
    const speed = descentSpeed(state.depthMiles, state.elapsedSeconds);
    const deltaMiles = speed * DEPTH_MILES_PER_SECOND_AT_BASE_SPEED * deltaSeconds;
    const { state: advanced } = advance(state, deltaMiles, deltaSeconds);
    state = advanced;

    timeSinceFishSpawn += deltaSeconds;
    timeSinceHazardSpawn += deltaSeconds;
    if (timeSinceFishSpawn >= fishSpawnIntervalSeconds()) {
      timeSinceFishSpawn = 0;
      sprites.push(spawnFishSprite(world.width, state.depthMiles, streak, save.gear.goldenBait, random));
    }
    if (timeSinceHazardSpawn >= hazardSpawnIntervalSeconds(state.depthMiles)) {
      timeSinceHazardSpawn = 0;
      sprites.push(spawnHazardSprite(world.width, state.depthMiles, random));
    }

    sprites.forEach((s) => updateSprite(s, deltaSeconds));
    pruneOffscreen();
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

  function render() {
    const gradient = ctx.createLinearGradient(0, 0, 0, world.height);
    gradient.addColorStop(0, OCEAN_TOP);
    gradient.addColorStop(1, OCEAN_BOTTOM);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, world.width, world.height);

    sprites.forEach((sprite) => {
      ctx.beginPath();
      ctx.fillStyle = sprite.kind === 'fish' ? (sprite.rare ? '#ffd54a' : '#5ec8ff') : '#ff5a5a';
      ctx.arc(sprite.x, sprite.y, sprite.hitboxRadius, 0, Math.PI * 2);
      ctx.fill();
    });

    const invulnerable = state.elapsedSeconds < state.invulnerableUntil;
    // Flicker feedback during the invulnerability window (doc's UI table:
    // "Brief visual/knockback feedback with a flicker").
    const flickerVisible = !invulnerable || Math.floor(state.elapsedSeconds * 10) % 2 === 0;
    if (flickerVisible) {
      // Drawn at the same radius used for fish-catch collision so this
      // placeholder circle honestly reflects the diver's actual hitbox
      // until the hand-authored diver.svg (a separate task) replaces it.
      ctx.beginPath();
      ctx.fillStyle = '#f2f2f2';
      ctx.arc(diver.x, diver.y, catchRadiusForSave(save), 0, Math.PI * 2);
      ctx.fill();
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
      elements.roundOverScreen.submitButton.disabled = true;
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
  document.body.addEventListener('htmx:beforeSwap', teardown);

  teardownActiveInstance = teardown;

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
