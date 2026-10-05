// Bus Rush: canvas loop, input, localStorage progress, and DOM wiring
// (docs/features/bus-rush.md). Every rule/number lives in ./busrush/rules.js;
// this file only applies them frame by frame and draws the result.
//
// Nothing touches the DOM at module evaluation except the bootstrap at the
// bottom, which re-runs on every HTMX swap into #main-content — a module
// script only executes once per page lifetime, so a revisit via HTMX would
// otherwise leave the new canvas unwired (see fishing-game.js's bootstrap
// comment for the original bug).

import {
  LANES,
  PX_PER_METER,
  MIN_SPEED,
  TRAFFIC_SPEED,
  HIT_GRACE_SECONDS,
  BUS_LENGTH,
  DISTANCE_MAX,
  UPGRADES,
  VEHICLES,
  stepSpeed,
  toKmh,
  laneChangeSeconds,
  maxLives,
  runScore,
  runTokens,
  upgradeCost,
  canBuy,
  rowSpacingPx,
  pickBlockedLanes,
  openLanes,
  pickVehicle,
  rectsOverlap,
  livesAfterHit,
} from './busrush/rules.js';

const STORAGE_KEY = 'bus-rush:v1';

const WIDTH = 480;
const HEIGHT = 640;
const SHOULDER = 40;
const LANE_WIDTH = (WIDTH - SHOULDER * 2) / LANES;
const BUS_WIDTH = 54;
const BUS_Y = HEIGHT - BUS_LENGTH - 36;
const FARE_RADIUS = 13;
const FARE_CHANCE = 0.7;

const VEHICLE_COLORS = ['#2f6db5', '#e0e0e0', '#2b2b2b', '#c9a227', '#3f8f5a', '#8e44ad', '#d35400'];

function laneCenter(lane) {
  return SHOULDER + LANE_WIDTH * lane + LANE_WIDTH / 2;
}

// ---------------------------------------------------------------------------
// Progress (localStorage)
// ---------------------------------------------------------------------------

function defaultProgress() {
  return {
    tokens: 0,
    bestScore: 0,
    bestDistance: 0,
    upgrades: Object.fromEntries(Object.keys(UPGRADES).map((k) => [k, 0])),
  };
}

function storageAvailable() {
  try {
    const probe = '__bus-rush-probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

function wholeNumber(n) {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// Corrupt or missing data falls back to defaults field by field.
function loadProgress() {
  const progress = defaultProgress();
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return progress;
    progress.tokens = wholeNumber(saved.tokens);
    progress.bestScore = wholeNumber(saved.bestScore);
    progress.bestDistance = wholeNumber(saved.bestDistance);
    Object.keys(UPGRADES).forEach((key) => {
      const lvl = wholeNumber(saved.upgrades && saved.upgrades[key]);
      progress.upgrades[key] = Math.min(lvl, UPGRADES[key].maxLevel);
    });
  } catch {
    // fall through with defaults
  }
  return progress;
}

function saveProgress(progress) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // storage unavailable — the start screen already says so
  }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

function drawRoad(ctx, scroll) {
  ctx.fillStyle = '#6b8f4e';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Kerbs and roadside trees scroll with the road.
  ctx.fillStyle = '#b9b2a3';
  ctx.fillRect(SHOULDER - 8, 0, 8, HEIGHT);
  ctx.fillRect(WIDTH - SHOULDER, 0, 8, HEIGHT);
  const treeGap = 140;
  const treeOffset = scroll % treeGap;
  ctx.fillStyle = '#3e6b35';
  for (let y = -treeGap + treeOffset; y < HEIGHT + treeGap; y += treeGap) {
    ctx.beginPath();
    ctx.arc(14, y, 11, 0, Math.PI * 2);
    ctx.arc(WIDTH - 14, y + treeGap / 2, 11, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = '#3b3b3b';
  ctx.fillRect(SHOULDER, 0, WIDTH - SHOULDER * 2, HEIGHT);

  // Dashed lane dividers.
  const dash = 36;
  const gap = 28;
  const offset = scroll % (dash + gap);
  ctx.fillStyle = '#f2efe6';
  for (let lane = 1; lane < LANES; lane++) {
    const x = SHOULDER + LANE_WIDTH * lane - 2;
    for (let y = -dash - gap + offset; y < HEIGHT; y += dash + gap) {
      ctx.fillRect(x, y, 4, dash);
    }
  }
  // Solid edge lines.
  ctx.fillRect(SHOULDER + 4, 0, 3, HEIGHT);
  ctx.fillRect(WIDTH - SHOULDER - 7, 0, 3, HEIGHT);
}

// Oncoming vehicle, nose pointing down the screen.
function drawVehicle(ctx, v) {
  const x = v.x - v.width / 2;
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  roundRect(ctx, x + 3, v.y + 4, v.width, v.length, 8);
  ctx.fill();

  if (v.kind === 'semi') {
    // Tractor at the front (bottom), long hazard-striped trailer behind.
    const cab = 36;
    const trailer = v.length - cab - 6;
    ctx.fillStyle = '#e8e4da';
    roundRect(ctx, x, v.y, v.width, trailer, 3);
    ctx.fill();
    ctx.fillStyle = '#c0392b';
    for (let y = v.y + 8; y < v.y + trailer - 4; y += 22) {
      ctx.fillRect(x + 4, y, v.width - 8, 6);
    }
    ctx.fillStyle = '#555';
    ctx.fillRect(x + v.width / 2 - 4, v.y + trailer, 8, 6); // hitch
    ctx.fillStyle = v.color;
    roundRect(ctx, x + 3, v.y + v.length - cab, v.width - 6, cab, 8);
    ctx.fill();
    ctx.fillStyle = '#9fd3f0';
    ctx.fillRect(x + 8, v.y + v.length - 15, v.width - 16, 9);
    ctx.fillStyle = '#fff6c2';
    ctx.fillRect(x + 6, v.y + v.length - 4, 9, 3);
    ctx.fillRect(x + v.width - 15, v.y + v.length - 4, 9, 3);
    return;
  }

  if (v.kind === 'truck') {
    const cab = 34;
    ctx.fillStyle = '#d8d4cc';
    roundRect(ctx, x, v.y, v.width, v.length - cab - 4, 4);
    ctx.fill();
    ctx.fillStyle = v.color;
    roundRect(ctx, x + 2, v.y + v.length - cab, v.width - 4, cab, 7);
    ctx.fill();
    ctx.fillStyle = '#9fd3f0';
    ctx.fillRect(x + 7, v.y + v.length - 14, v.width - 14, 8);
    return;
  }

  ctx.fillStyle = v.color;
  roundRect(ctx, x, v.y, v.width, v.length, v.kind === 'van' ? 7 : 12);
  ctx.fill();
  ctx.fillStyle = '#9fd3f0';
  const glass = v.kind === 'van' ? 14 : 12;
  ctx.fillRect(x + 6, v.y + v.length - glass - 14, v.width - 12, glass); // windscreen
  ctx.fillRect(x + 8, v.y + 10, v.width - 16, 8); // rear window
  ctx.fillStyle = '#fff6c2';
  ctx.fillRect(x + 4, v.y + v.length - 5, 9, 4); // headlights
  ctx.fillRect(x + v.width - 13, v.y + v.length - 5, 9, 4);
}

function drawFare(ctx, f) {
  ctx.fillStyle = '#f2c94c';
  ctx.beginPath();
  ctx.arc(f.x, f.y, FARE_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#b8860b';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = '#7a5a00';
  ctx.font = 'bold 15px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('$', f.x, f.y + 1);
}

function drawBus(ctx, x, flashing) {
  if (flashing) ctx.globalAlpha = 0.4;
  const left = x - BUS_WIDTH / 2;
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  roundRect(ctx, left + 3, BUS_Y + 5, BUS_WIDTH, BUS_LENGTH, 10);
  ctx.fill();

  ctx.fillStyle = '#c4532d';
  roundRect(ctx, left, BUS_Y, BUS_WIDTH, BUS_LENGTH, 10);
  ctx.fill();
  ctx.fillStyle = '#9fd3f0';
  ctx.fillRect(left + 6, BUS_Y + 6, BUS_WIDTH - 12, 12); // windscreen
  ctx.fillStyle = '#7fb6d4';
  for (let y = BUS_Y + 24; y < BUS_Y + BUS_LENGTH - 10; y += 14) {
    ctx.fillRect(left + 3, y, 5, 10);
    ctx.fillRect(left + BUS_WIDTH - 8, y, 5, 10);
  }
  ctx.fillStyle = '#f2efe6';
  ctx.fillRect(left + 14, BUS_Y + 34, BUS_WIDTH - 28, 22); // roof hatch
  ctx.fillStyle = '#c4532d';
  ctx.font = 'bold 13px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('88', x, BUS_Y + 46);
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------

let teardownCurrent = null;

/**
 * Wires one mounted page. `el` holds every element bootstrap() looked up.
 * Returns a teardown that removes window-level listeners and stops the loop,
 * so a later bootstrap (HTMX revisit) never leaves two games running.
 */
function init(canvas, el) {
  if (teardownCurrent) teardownCurrent();

  const ctx = canvas.getContext('2d');
  const hasStorage = storageAvailable();
  let progress = loadProgress();
  let run = null;
  let rafHandle = null;
  let lastTime = 0;
  let idleScroll = 0;
  const input = { accelerate: false, brake: false };

  // --- screens ------------------------------------------------------------

  function show(screen) {
    [el.start.root, el.runOver.root, el.shop.root].forEach((s) => s && s.classList.toggle('hidden', s !== screen));
  }

  function renderStart() {
    el.start.tokens.textContent = progress.tokens;
    el.start.bestScore.textContent = progress.bestScore;
    el.start.bestDistance.textContent = `${progress.bestDistance} m`;
    if (el.start.storageNotice) el.start.storageNotice.classList.toggle('hidden', hasStorage);
  }

  function renderShop() {
    el.shop.tokens.textContent = progress.tokens;
    Object.entries(el.shop.items).forEach(([key, item]) => {
      const lvl = progress.upgrades[key];
      const cost = upgradeCost(key, lvl);
      item.level.textContent = cost === null ? `${lvl} (max)` : lvl;
      item.cost.textContent = cost === null ? '—' : cost;
      item.buy.disabled = !canBuy(key, lvl, progress.tokens);
      item.buy.textContent = cost === null ? 'Maxed' : 'Buy';
    });
  }

  function openShop() {
    renderShop();
    show(el.shop.root);
    el.shop.close.focus();
  }

  function closeShop() {
    renderStart();
    show(el.start.root);
    el.start.startButton.focus();
  }

  // --- HUD ----------------------------------------------------------------

  function renderHud() {
    const r = run;
    el.hud.distance.textContent = `${r ? Math.floor(r.distance) : 0} m`;
    el.hud.speed.textContent = `${toKmh(r ? r.speed : 0)} km/h`;
    el.hud.score.textContent = r ? runScore(r.distance, r.fares) : 0;
    el.hud.lives.textContent = r ? r.lives : maxLives(progress.upgrades.bumpers);
    el.hud.fares.textContent = r ? r.fares : 0;
  }

  // --- run lifecycle ------------------------------------------------------

  function startRun() {
    run = {
      status: 'playing',
      distance: 0,
      speed: MIN_SPEED,
      fares: 0,
      lives: maxLives(progress.upgrades.bumpers),
      grace: 0,
      lane: 1,
      busX: laneCenter(1),
      vehicles: [],
      fareItems: [],
      sinceRow: 0,
      prevOpen: null,
      scroll: 0,
    };
    input.accelerate = false;
    input.brake = false;
    show(null);
    renderHud();
    canvas.focus({ preventScroll: true });
  }

  function endRun() {
    if (!run || run.status !== 'playing') return;
    run.status = 'over';
    const distance = Math.min(Math.floor(run.distance), DISTANCE_MAX);
    const score = runScore(run.distance, run.fares);
    const tokens = runTokens(run.distance, run.fares, progress.upgrades.fareBox);

    progress.tokens += tokens;
    const newBest = score > progress.bestScore;
    progress.bestScore = Math.max(progress.bestScore, score);
    progress.bestDistance = Math.max(progress.bestDistance, distance);
    saveProgress(progress);

    const titles = [];
    if (run.killedBy) titles.push(`Flattened by a ${run.killedBy}!`);
    if (newBest) titles.push('New best run!');
    el.runOver.title.textContent = titles.length ? titles.join(' ') : 'Run over';
    el.runOver.distance.textContent = `${distance} m`;
    el.runOver.fares.textContent = run.fares;
    el.runOver.score.textContent = score;
    el.runOver.tokens.textContent = `+${tokens}`;
    el.runOver.scoreInput.value = score;
    el.runOver.distanceInput.value = distance;
    el.runOver.submit.disabled = false;
    el.runOver.submit.textContent = 'Submit';
    show(el.runOver.root);
    renderHud();
    el.runOver.again.focus();
  }

  function hit(r, vehicle) {
    const lives = livesAfterHit(r.lives, vehicle, r.grace);
    if (lives === r.lives) return; // grace absorbed it
    r.lives = lives;
    r.speed = MIN_SPEED;
    r.grace = HIT_GRACE_SECONDS;
    if (r.lives <= 0) {
      r.killedBy = vehicle && vehicle.lethal ? vehicle.kind : null;
      endRun();
    }
  }

  function spawnRow(r, overshoot) {
    const blocked = pickBlockedLanes(Math.random, r.distance, r.prevOpen);
    const open = openLanes(blocked);
    r.prevOpen = open;
    blocked.forEach((lane) => {
      const kind = pickVehicle(Math.random, r.distance);
      r.vehicles.push({
        kind: kind.kind,
        lethal: Boolean(kind.lethal),
        x: laneCenter(lane),
        y: -kind.length + overshoot,
        width: kind.width,
        length: kind.length,
        color: VEHICLE_COLORS[Math.floor(Math.random() * VEHICLE_COLORS.length)],
      });
    });
    // A fare sits mid-gap behind this row, in any lane — sometimes one
    // that takes a risky lane change to reach.
    if (Math.random() < FARE_CHANCE) {
      const lane = Math.floor(Math.random() * LANES);
      r.fareItems.push({ x: laneCenter(lane), y: overshoot - rowSpacingPx(r.distance) / 2 });
    }
  }

  function update(dt) {
    const r = run;
    r.speed = stepSpeed(r.speed, input, dt, progress.upgrades.engine);
    r.distance = Math.min(r.distance + r.speed * dt, DISTANCE_MAX);
    r.grace = Math.max(0, r.grace - dt);
    r.scroll += r.speed * dt * PX_PER_METER;

    // Lane change: slide toward the target lane at one lane per
    // laneChangeSeconds.
    const targetX = laneCenter(r.lane);
    const step = (LANE_WIDTH / laneChangeSeconds(progress.upgrades.steering)) * dt;
    r.busX = Math.abs(targetX - r.busX) <= step ? targetX : r.busX + Math.sign(targetX - r.busX) * step;

    // Traffic and fares close in at the bus's speed plus traffic's own.
    const closing = (r.speed + TRAFFIC_SPEED) * dt * PX_PER_METER;
    r.vehicles.forEach((v) => { v.y += closing; });
    r.fareItems.forEach((f) => { f.y += closing; });
    r.vehicles = r.vehicles.filter((v) => v.y < HEIGHT);
    r.fareItems = r.fareItems.filter((f) => f.y - FARE_RADIUS < HEIGHT);

    r.sinceRow += closing;
    const spacing = rowSpacingPx(r.distance);
    if (r.sinceRow >= spacing) {
      r.sinceRow -= spacing;
      spawnRow(r, r.sinceRow);
    }

    // Slightly forgiving hitboxes so a near-miss reads as a near-miss.
    const bus = { x: r.busX - BUS_WIDTH / 2 + 5, y: BUS_Y + 6, w: BUS_WIDTH - 10, h: BUS_LENGTH - 10 };
    for (const v of r.vehicles) {
      if (rectsOverlap(bus, { x: v.x - v.width / 2 + 3, y: v.y + 3, w: v.width - 6, h: v.length - 6 })) {
        hit(r, v);
        if (r.status !== 'playing') return;
      }
    }
    r.fareItems = r.fareItems.filter((f) => {
      const caught = rectsOverlap(bus, { x: f.x - FARE_RADIUS, y: f.y - FARE_RADIUS, w: FARE_RADIUS * 2, h: FARE_RADIUS * 2 });
      if (caught) r.fares += 1;
      return !caught;
    });
  }

  function draw() {
    const r = run;
    drawRoad(ctx, r ? r.scroll : idleScroll);
    if (r) {
      r.fareItems.forEach((f) => drawFare(ctx, f));
      r.vehicles.forEach((v) => drawVehicle(ctx, v));
      const flashing = r.grace > 0 && Math.floor(r.grace * 10) % 2 === 0;
      drawBus(ctx, r.busX, flashing);
    } else {
      drawBus(ctx, laneCenter(1), false);
    }
  }

  function loop(now) {
    // Clamp dt so a backgrounded tab doesn't teleport traffic on return.
    const dt = lastTime ? Math.min((now - lastTime) / 1000, 0.05) : 0;
    lastTime = now;
    if (run && run.status === 'playing') {
      update(dt);
      renderHud();
    } else if (!run) {
      idleScroll += dt * 40;
    }
    draw();
    rafHandle = window.requestAnimationFrame(loop);
  }

  // --- input --------------------------------------------------------------

  function steer(dir) {
    if (!run || run.status !== 'playing') return;
    run.lane = Math.min(Math.max(run.lane + dir, 0), LANES - 1);
  }

  function isTyping(target) {
    return target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
  }

  function onKeyDown(e) {
    if (isTyping(e.target) || !run || run.status !== 'playing') return;
    const key = e.key.toLowerCase();
    if (key === 'arrowleft' || key === 'a') { if (!e.repeat) steer(-1); }
    else if (key === 'arrowright' || key === 'd') { if (!e.repeat) steer(1); }
    else if (key === 'arrowup' || key === 'w') input.accelerate = true;
    else if (key === 'arrowdown' || key === 's') input.brake = true;
    else return;
    e.preventDefault(); // keep arrows from scrolling the page mid-run
  }

  function onKeyUp(e) {
    const key = e.key.toLowerCase();
    if (key === 'arrowup' || key === 'w') input.accelerate = false;
    if (key === 'arrowdown' || key === 's') input.brake = false;
  }

  function onCanvasPointerDown(e) {
    if (!run || run.status !== 'playing') return;
    const rect = canvas.getBoundingClientRect();
    steer(e.clientX - rect.left < rect.width / 2 ? -1 : 1);
  }

  const controlCleanups = el.controls.map((button) => {
    const action = button.dataset.busRushControl;
    const held = action === 'faster' ? 'accelerate' : action === 'slower' ? 'brake' : null;
    const down = (e) => {
      e.preventDefault();
      if (held) input[held] = true;
      else steer(action === 'left' ? -1 : 1);
    };
    const up = () => { if (held) input[held] = false; };
    // Keyboard activation (Enter/Space) of ◀/▶ arrives as a click with
    // detail 0; pointer presses are already handled on pointerdown.
    const click = (e) => { if (!held && e.detail === 0) steer(action === 'left' ? -1 : 1); };
    button.addEventListener('pointerdown', down);
    button.addEventListener('pointerup', up);
    button.addEventListener('pointerleave', up);
    button.addEventListener('pointercancel', up);
    button.addEventListener('click', click);
    return () => {
      button.removeEventListener('pointerdown', down);
      button.removeEventListener('pointerup', up);
      button.removeEventListener('pointerleave', up);
      button.removeEventListener('pointercancel', up);
      button.removeEventListener('click', click);
    };
  });

  // Element listeners die with the swapped-out DOM; only window-level ones
  // need explicit teardown.
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  canvas.addEventListener('pointerdown', onCanvasPointerDown);
  canvas.tabIndex = 0;

  el.start.startButton.addEventListener('click', startRun);
  el.start.shopButton.addEventListener('click', openShop);
  el.runOver.again.addEventListener('click', startRun);
  el.runOver.shopButton.addEventListener('click', openShop);
  el.shop.close.addEventListener('click', closeShop);
  el.shop.reset.addEventListener('click', () => {
    if (!window.confirm('Reset all Bus Rush progress? Tokens, upgrades and bests will be cleared.')) return;
    progress = defaultProgress();
    saveProgress(progress);
    renderShop();
    renderHud();
  });
  Object.entries(el.shop.items).forEach(([key, item]) => {
    item.buy.addEventListener('click', () => {
      const cost = upgradeCost(key, progress.upgrades[key]);
      if (cost === null || progress.tokens < cost) return;
      progress.tokens -= cost;
      progress.upgrades[key] += 1;
      saveProgress(progress);
      renderShop();
      renderHud();
    });
  });

  // One submission per run: lock the button once the leaderboard swap
  // succeeds.
  if (el.runOver.form) {
    el.runOver.form.addEventListener('htmx:afterRequest', (e) => {
      if (e.detail && e.detail.successful) {
        el.runOver.submit.disabled = true;
        el.runOver.submit.textContent = 'Submitted';
      }
    });
  }

  // Test-only hook for e2e/bus-rush.spec.js: a natural crash depends on
  // random traffic, so tests call crash() to apply real hits through the
  // same hit()/endRun() path real play uses. Harmless in production, same
  // reasoning as fishing-game.js's __fishingGameTestHooks.
  window.__busRushTestHooks = {
    crash() {
      let guard = 0;
      while (run && run.status === 'playing' && guard < 50) {
        run.grace = 0;
        hit(run);
        guard += 1;
      }
    },
    // Drops one vehicle of `kind` into the bus's lane just above the
    // screen, so it collides through the real update() path.
    spawn(kind) {
      const def = VEHICLES.find((v) => v.kind === kind);
      if (!run || run.status !== 'playing' || !def) return;
      run.vehicles.push({
        kind: def.kind,
        lethal: Boolean(def.lethal),
        x: laneCenter(run.lane),
        y: -def.length,
        width: def.width,
        length: def.length,
        color: VEHICLE_COLORS[0],
      });
    },
    grantTokens(n) {
      progress.tokens += n;
      saveProgress(progress);
      renderStart();
    },
  };

  renderStart();
  renderHud();
  show(el.start.root);
  rafHandle = window.requestAnimationFrame(loop);

  teardownCurrent = () => {
    if (rafHandle !== null) window.cancelAnimationFrame(rafHandle);
    rafHandle = null;
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    controlCleanups.forEach((fn) => fn());
    teardownCurrent = null;
  };
}

// ---------------------------------------------------------------------------
// DOM lookup — the only place this file queries elements by ID.
// ---------------------------------------------------------------------------

function bootstrap() {
  const canvas = document.getElementById('bus-rush-canvas');
  if (!canvas) {
    // Navigated away: stop the old loop and listeners.
    if (teardownCurrent) teardownCurrent();
    return;
  }
  const $ = (id) => document.getElementById(id);
  const shopRoot = $('bus-rush-shop-screen');
  const items = {};
  Object.keys(UPGRADES).forEach((key) => {
    const row = shopRoot && shopRoot.querySelector(`[data-upgrade-key="${key}"]`);
    if (!row) return;
    items[key] = {
      level: row.querySelector('[data-upgrade-level]'),
      cost: row.querySelector('[data-upgrade-cost]'),
      buy: row.querySelector('[data-upgrade-buy]'),
    };
  });
  const submit = $('bus-rush-submit-button');

  init(canvas, {
    hud: {
      distance: $('bus-rush-hud-distance'),
      speed: $('bus-rush-hud-speed'),
      score: $('bus-rush-hud-score'),
      lives: $('bus-rush-hud-lives'),
      fares: $('bus-rush-hud-fares'),
    },
    start: {
      root: $('bus-rush-start-screen'),
      tokens: $('bus-rush-start-tokens'),
      bestScore: $('bus-rush-start-best-score'),
      bestDistance: $('bus-rush-start-best-distance'),
      storageNotice: $('bus-rush-storage-notice'),
      startButton: $('bus-rush-start-button'),
      shopButton: $('bus-rush-start-shop-button'),
    },
    runOver: {
      root: $('bus-rush-run-over-screen'),
      title: $('bus-rush-run-over-title'),
      distance: $('bus-rush-run-over-distance'),
      fares: $('bus-rush-run-over-fares'),
      score: $('bus-rush-run-over-score'),
      tokens: $('bus-rush-run-over-tokens'),
      form: submit && submit.form,
      submit,
      scoreInput: $('bus-rush-score-input'),
      distanceInput: $('bus-rush-distance-input'),
      again: $('bus-rush-again-button'),
      shopButton: $('bus-rush-run-over-shop-button'),
    },
    shop: {
      root: shopRoot,
      tokens: $('bus-rush-shop-tokens'),
      close: $('bus-rush-shop-close-button'),
      reset: $('bus-rush-shop-reset-button'),
      items,
    },
    controls: [...document.querySelectorAll('[data-bus-rush-control]')],
  });
}

if (typeof document !== 'undefined') {
  bootstrap();
  document.body.addEventListener('htmx:afterSwap', (e) => {
    if (e.target && e.target.id === 'main-content') bootstrap();
  });
}
