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
  minSpeed,
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
  fareOffset,
  WANTED_MAX,
  POLICE_FIRST_SECONDS,
  POLICE_SPAWN_SECONDS,
  POLICE_CAR,
  wantedLevel,
  policeSpeed,
  maxPolice,
  policeReactionSeconds,
  roadblockChance,
  policeWreckPoints,
  LEVELS,
  LEVEL_DISTANCE,
  LEVEL_SPEED_STEP,
  maxSpeed,
  levelAt,
  checkpointPoints,
  SKID_SECONDS,
  bananaDrops,
  skidLane,
} from './busrush/rules.js';

const STORAGE_KEY = 'bus-rush:v1';

const WIDTH = 480;
const HEIGHT = 640;
const SHOULDER = 40;
const LANE_WIDTH = (WIDTH - SHOULDER * 2) / LANES;
const BUS_WIDTH = 54;
// Room below the bus for pursuing police to close in from.
const BUS_Y = HEIGHT - BUS_LENGTH - 110;
const POLICE_LANE_SECONDS = 0.35;
const BANNER_SECONDS = 2.4;
const FADE_SECONDS = 1.2;
const FARE_RADIUS = 13;
const FARE_CHANCE = 0.7;

const VEHICLE_COLORS = ['#3f6e9e', '#e8e1d3', '#33312e', '#d9a93f', '#5f8a5b', '#8c5a7a', '#7d8a94'];

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
//
// Flat top-down vector style in the site's warm "Organic" palette, lit from
// the top-left (shadows fall down-right). The static roadside — verge,
// pavement, trees, lamps, asphalt grain, lane paint — is painted once into
// an offscreen tile that scrolls seamlessly; vehicles, the bus, fares and
// effects are drawn live every frame.

const DASH = 36;
const DASH_GAP = 28;
const SCENERY_PERIOD = (DASH + DASH_GAP) * 20; // whole dash cycles, so it tiles

const PAINT = '#f1e9d6';
const BAY_YELLOW = '#e0b54a';
const ASPHALT = '#4a4643';
const GLASS = '#2e4552';
const GLASS_SHINE = 'rgba(255,255,255,0.22)';
const HEADLIGHT = '#fff3c4';
const TAILLIGHT = '#c9402c';
const TYRE = '#1f1d1b';
const SHADOW = 'rgba(28,22,16,0.3)';
const BUS_COLOR = '#c4532d';
const BUS_ROOF = '#efe4d0';
const CARGO = '#e9e3d6';

const TAXI_COLORS = ['#2f78c4', '#e3bf3f'];
const TAXI_CHANCE = 0.15;

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

function fillRoundRect(ctx, color, x, y, w, h, r) {
  ctx.fillStyle = color;
  roundRect(ctx, x, y, w, h, r);
  ctx.fill();
}

/** Mixes a #rrggbb colour toward black (amount < 0) or white (amount > 0). */
function shade(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const target = amount < 0 ? 0 : 255;
  const a = Math.abs(amount);
  const ch = (v) => Math.round(v + (target - v) * a);
  return `rgb(${ch(n >> 16)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}

/** Deterministic PRNG so the scenery tile looks the same on every visit. */
function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Left-to-right gradient that makes a flat body read as rounded. */
function bodyGradient(ctx, color, x, w) {
  const g = ctx.createLinearGradient(x, 0, x + w, 0);
  g.addColorStop(0, shade(color, -0.3));
  g.addColorStop(0.22, color);
  g.addColorStop(0.5, shade(color, 0.12));
  g.addColorStop(0.78, color);
  g.addColorStop(1, shade(color, -0.3));
  return g;
}

/** Quadrilateral from a top edge (x1..x2 at y1) to a bottom edge (x3..x4 at y2). */
function quad(ctx, x1, x2, y1, x3, x4, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y1);
  ctx.lineTo(x4, y2);
  ctx.lineTo(x3, y2);
  ctx.closePath();
}

// --- scenery tile ------------------------------------------------------------

function drawTree(g, x, y, r, rand, bloom) {
  g.fillStyle = 'rgba(30,40,18,0.32)';
  g.beginPath();
  g.ellipse(x + 5, y + 7, r * 1.05, r, 0, 0, Math.PI * 2);
  g.fill();
  const blobs = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + rand();
    blobs.push([x + Math.cos(a) * r * 0.45, y + Math.sin(a) * r * 0.45, r * (0.5 + rand() * 0.2)]);
  }
  const layer = (color, dx, dy, k) => {
    g.fillStyle = color;
    g.beginPath();
    blobs.forEach(([bx, by, br]) => {
      g.moveTo(bx + dx + br * k, by + dy);
      g.arc(bx + dx, by + dy, br * k, 0, Math.PI * 2);
    });
    g.fill();
  };
  layer('#3d6638', 0, 0, 1);
  layer('#527f47', -2, -2, 0.78);
  layer('#6f9a5a', -4, -4, 0.45);
  // Some are in bloom (flame-of-the-forest, bougainvillea…).
  if (bloom && rand() < 0.3) {
    g.fillStyle = bloom;
    for (let i = 0; i < 9; i++) {
      g.beginPath();
      g.arc(x + (rand() - 0.5) * r * 1.4, y + (rand() - 0.5) * r * 1.4, 1.8, 0, Math.PI * 2);
      g.fill();
    }
  }
}

function drawShrub(g, x, y, rand) {
  g.fillStyle = 'rgba(30,40,18,0.28)';
  g.beginPath();
  g.ellipse(x + 3, y + 4, 7, 6, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#4c7a42';
  g.beginPath();
  g.arc(x - 3, y, 5, 0, Math.PI * 2);
  g.arc(x + 3, y + 1, 5.5, 0, Math.PI * 2);
  g.arc(x, y - 3, 5, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#6f9a5a';
  g.beginPath();
  g.arc(x - 1, y - 3, 2.5, 0, Math.PI * 2);
  g.fill();
  if (rand() < 0.5) {
    g.fillStyle = rand() < 0.5 ? '#f2e3a0' : '#e79a8a';
    g.beginPath();
    g.arc(x + 3, y - 1, 1.4, 0, Math.PI * 2);
    g.arc(x - 3, y + 2, 1.4, 0, Math.PI * 2);
    g.fill();
  }
}

/** Street lamp on the pavement, arm reaching over the road. `side` is -1 (left) or 1 (right). */
function drawLamp(g, x, y, side) {
  const head = x - side * 22;
  g.strokeStyle = 'rgba(28,22,16,0.25)';
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(x + 4, y + 6);
  g.lineTo(head + 4, y + 6);
  g.stroke();
  g.strokeStyle = '#6b6660';
  g.lineWidth = 2.5;
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(head, y);
  g.stroke();
  fillRoundRect(g, '#5a5550', x - 3, y - 3, 6, 6, 2);
  fillRoundRect(g, '#d9d2c2', head - 6, y - 3, 12, 6, 3);
  g.fillStyle = '#fff3c4';
  g.fillRect(head - 4, y - 1, 8, 2);
}

/** Bus shelter on the left verge, with a yellow-zigzag bay in the near lane. */
function drawShelter(g, y) {
  const len = 78;
  g.fillStyle = 'rgba(28,22,16,0.3)';
  g.fillRect(6, y + 6, 26, len);
  fillRoundRect(g, '#7b8f86', 2, y, 26, len, 3);
  g.fillStyle = '#8fa39a';
  for (let ry = y + 6; ry < y + len - 4; ry += 9) g.fillRect(4, ry, 22, 4);
  // Stop pole sign at the kerb.
  g.fillStyle = '#5a5550';
  g.fillRect(30, y + len + 4, 3, 3);
  fillRoundRect(g, '#e7b93f', 27, y + len - 4, 9, 8, 2);
  // Zigzag bay markings along the kerb, longer than the shelter.
  g.strokeStyle = BAY_YELLOW;
  g.lineWidth = 2;
  g.beginPath();
  const left = SHOULDER + 8;
  const right = SHOULDER + 22;
  for (let zy = y - 40, i = 0; zy <= y + len + 40; zy += 10, i++) {
    const zx = i % 2 ? right : left;
    if (i === 0) g.moveTo(zx, zy);
    else g.lineTo(zx, zy);
  }
  g.stroke();
  g.font = 'bold 13px sans-serif';
  g.fillStyle = BAY_YELLOW;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.save();
  g.translate(SHOULDER + LANE_WIDTH / 2 + 10, y + len / 2);
  g.fillText('BUS', 0, 0);
  g.restore();
}

/**
 * One district's look (index matches LEVELS in rules.js). `roadside` picks
 * what lines the verge; `path` false swaps the footpath for an expressway
 * guardrail.
 */
const DISTRICTS = [
  { // CBD: plaza paving and office-tower rooftops.
    seed: 11, verge: '#a39d93', tufts: ['#948e84', '#b0aaa0'], path: '#cfc6b6', seam: '#bdb3a2',
    kerb: ['#e6dfcf', '#8a8276'], asphalt: '#47433f', edge: PAINT,
    roadside: 'towers', shelters: true, lampGap: 320, streetTrees: true,
  },
  { // Heartland: grass, rain trees, bus shelters.
    seed: 88, verge: '#7b9a58', tufts: ['#6c8b4c', '#8eab69'], path: '#d8ccb4', seam: '#c4b79d',
    kerb: ['#e6dfcf', '#8a8276'], asphalt: ASPHALT, edge: PAINT,
    roadside: 'trees', treeChance: 0.85, treeGap: [55, 100], bloom: '#d9663f', shelters: true, lampGap: 320,
  },
  { // Expressway: guardrails, sparse trees, yellow edge lines, frequent lamps.
    seed: 21, verge: '#6d8a4c', tufts: ['#5f7c40', '#7f9c5c'], path: false,
    kerb: ['#d9d2c4', '#bfb7a8'], asphalt: '#3f3c39', edge: BAY_YELLOW,
    roadside: 'trees', treeChance: 0.85, treeGap: [60, 120], bloom: null, shelters: false, lampGap: 160,
  },
  { // Industrial: dusty verge, shipping containers, hazard-striped kerbs.
    seed: 37, verge: '#a8957a', tufts: ['#988569', '#b6a48a'], path: '#c9bea9', seam: '#b5a990',
    kerb: ['#e0c35a', '#33312e'], asphalt: '#55504b', edge: PAINT,
    roadside: 'containers', shelters: false, lampGap: 320, streetTrees: true,
  },
  { // Changi: a dense avenue of trees in bougainvillea pink.
    seed: 64, verge: '#6f9650', tufts: ['#5f8642', '#86ab66'], path: '#d8ccb4', seam: '#c4b79d',
    kerb: ['#e6dfcf', '#8a8276'], asphalt: ASPHALT, edge: PAINT,
    roadside: 'trees', treeChance: 1, treeGap: [44, 60], bloom: '#c45a9a', shelters: false, lampGap: 320,
  },
];

/** Office-tower rooftop overhanging the verge: parapet, aircon units, water tank. */
function drawRooftop(g, x, y, w, h, color, rand) {
  g.fillStyle = 'rgba(28,22,16,0.3)';
  g.fillRect(x + 4, y + 6, w, h);
  fillRoundRect(g, color, x, y, w, h, 2);
  g.strokeStyle = shade(color, -0.25);
  g.lineWidth = 1.5;
  g.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
  for (let i = 0; i < 3; i++) {
    fillRoundRect(g, '#d7d1c6', x + 3 + rand() * (w - 12), y + 6 + rand() * (h - 16), 7, 7, 1.5);
  }
  if (rand() < 0.5) {
    g.fillStyle = '#9ba3a8';
    g.beginPath();
    g.arc(x + w / 2, y + h - 12, 4, 0, Math.PI * 2);
    g.fill();
  }
}

function drawContainer(g, x, y, w, h, color) {
  g.fillStyle = 'rgba(28,22,16,0.3)';
  g.fillRect(x + 3, y + 5, w, h);
  g.fillStyle = color;
  g.fillRect(x, y, w, h);
  g.fillStyle = shade(color, -0.2);
  for (let ry = y + 4; ry < y + h - 2; ry += 5) g.fillRect(x + 1, ry, w - 2, 1.5);
  g.strokeStyle = shade(color, -0.35);
  g.lineWidth = 1;
  g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

/**
 * Paints one seamless SCENERY_PERIOD-tall strip of road and roadside for a
 * district, at the canvas's pixel ratio. Anything that could straddle the
 * tile's top/bottom edge is drawn at y, y - period and y + period so the
 * seam never shows.
 */
function buildScenery(dpr, d) {
  const tile = document.createElement('canvas');
  tile.width = WIDTH * dpr;
  tile.height = SCENERY_PERIOD * dpr;
  const g = tile.getContext('2d');
  g.scale(dpr, dpr);
  const P = SCENERY_PERIOD;
  const rand = seededRandom(d.seed);
  const wrapped = (y, fn) => [y - P, y, y + P].forEach(fn);

  // Verge with tufts.
  g.fillStyle = d.verge;
  g.fillRect(0, 0, WIDTH, P);
  for (let i = 0; i < 260; i++) {
    const side = rand() < 0.5;
    const x = side ? rand() * 24 : WIDTH - rand() * 24;
    g.fillStyle = rand() < 0.5 ? d.tufts[0] : d.tufts[1];
    g.fillRect(x, rand() * P, 2, 3);
  }

  if (d.path) {
    // Paved footpath with tile seams.
    g.fillStyle = d.path;
    g.fillRect(22, 0, 12, P);
    g.fillRect(WIDTH - 34, 0, 12, P);
    g.fillStyle = d.seam;
    for (let y = 0; y < P; y += 12) {
      g.fillRect(22, y, 12, 1);
      g.fillRect(WIDTH - 34, y, 12, 1);
    }
  } else {
    // Guardrail on posts.
    for (const x of [28, WIDTH - 31]) {
      g.fillStyle = 'rgba(28,22,16,0.25)';
      g.fillRect(x + 3, 0, 3, P);
      g.fillStyle = '#6b6660';
      for (let y = 0; y < P; y += 20) g.fillRect(x - 1, y, 5, 4);
      g.fillStyle = '#c9c3b7';
      g.fillRect(x, 0, 3, P);
    }
  }

  // Kerbs in alternating blocks — they also sell the sense of speed.
  for (let y = 0; y < P; y += 16) {
    g.fillStyle = (y / 16) % 2 ? d.kerb[1] : d.kerb[0];
    g.fillRect(SHOULDER - 6, y, 6, 16);
    g.fillRect(WIDTH - SHOULDER, y, 6, 16);
  }

  // Asphalt: base, grain, darker wheel tracks, patches, a few cracks.
  g.fillStyle = d.asphalt;
  g.fillRect(SHOULDER, 0, WIDTH - SHOULDER * 2, P);
  for (let i = 0; i < 2600; i++) {
    g.fillStyle = rand() < 0.5 ? 'rgba(255,240,220,0.06)' : 'rgba(0,0,0,0.12)';
    g.fillRect(SHOULDER + rand() * (WIDTH - SHOULDER * 2), rand() * P, 1.5, 1.5);
  }
  g.fillStyle = 'rgba(0,0,0,0.05)';
  for (let lane = 0; lane < LANES; lane++) {
    const cx = laneCenter(lane);
    g.fillRect(cx - 19, 0, 9, P);
    g.fillRect(cx + 10, 0, 9, P);
  }
  for (let i = 0; i < 4; i++) {
    const w = 30 + rand() * 50;
    const h = 30 + rand() * 70;
    const x = SHOULDER + 8 + rand() * (WIDTH - SHOULDER * 2 - w - 16);
    const y = rand() * (P - h);
    g.fillStyle = rand() < 0.5 ? 'rgba(0,0,0,0.06)' : 'rgba(255,240,220,0.035)';
    g.fillRect(x, y, w, h);
  }
  g.strokeStyle = 'rgba(0,0,0,0.25)';
  g.lineWidth = 1;
  for (let i = 0; i < 10; i++) {
    let x = SHOULDER + 10 + rand() * (WIDTH - SHOULDER * 2 - 20);
    let y = rand() * (P - 40);
    g.beginPath();
    g.moveTo(x, y);
    for (let s = 0; s < 4; s++) {
      x += (rand() - 0.5) * 12;
      y += 4 + rand() * 8;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  // Manhole covers.
  for (let i = 0; i < 3; i++) {
    const x = laneCenter(Math.floor(rand() * LANES)) + (rand() - 0.5) * 20;
    const y = 40 + rand() * (P - 80);
    g.fillStyle = '#3a3734';
    g.beginPath();
    g.arc(x, y, 9, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#5c5753';
    g.lineWidth = 1.5;
    g.stroke();
    g.beginPath();
    g.moveTo(x - 6, y);
    g.lineTo(x + 6, y);
    g.moveTo(x, y - 6);
    g.lineTo(x, y + 6);
    g.stroke();
  }

  // Lane paint, slightly worn.
  for (let lane = 1; lane < LANES; lane++) {
    const x = SHOULDER + LANE_WIDTH * lane - 2;
    for (let y = 0; y < P; y += DASH + DASH_GAP) {
      g.globalAlpha = 0.82 + rand() * 0.18;
      g.fillStyle = PAINT;
      g.fillRect(x, y, 4, DASH);
    }
  }
  g.globalAlpha = 1;
  g.fillStyle = d.edge;
  g.fillRect(SHOULDER + 4, 0, 3, P);
  g.fillRect(WIDTH - SHOULDER - 7, 0, 3, P);

  // Shelters first so roadside items and lamps never land on top of them.
  const shelterYs = d.shelters ? [P * 0.3, P * 0.8] : [];
  shelterYs.forEach((y) => drawShelter(g, y));
  const nearShelter = (y) => shelterYs.some((sy) => y > sy - 30 && y < sy + 110);

  // Every copy of a wrapped item must come out identical, so each one gets
  // its own seed rather than drawing from the shared stream.
  for (const [x, side] of [[11, -1], [WIDTH - 11, 1]]) {
    if (d.roadside === 'trees') {
      for (let y = 20; y < P; y += d.treeGap[0] + rand() * (d.treeGap[1] - d.treeGap[0])) {
        if (side === -1 && nearShelter(y)) continue;
        // Big enough to overhang the footpath and kerb, not just peek in
        // from the canvas edge.
        const r = 18 + rand() * 7;
        const jitter = side * -(4 + rand() * 4);
        const seed = Math.floor(y * 7 + x);
        const isTree = rand() < d.treeChance;
        wrapped(y, (wy) => {
          if (isTree) drawTree(g, x + jitter, wy, r, seededRandom(seed), d.bloom);
          else drawShrub(g, x, wy, seededRandom(seed));
        });
      }
    } else {
      const palette = d.roadside === 'towers'
        ? ['#bdb5a8', '#a8a097', '#c98f6b', '#8e9a94']
        : ['#c4532d', '#3f6e9e', '#5f8a5b', '#d9a93f', '#8a8276'];
      for (let y = 10; y < P - 20;) {
        const h = d.roadside === 'towers' ? 70 + rand() * 90 : 46 + rand() * 14;
        if (side === -1 && (nearShelter(y) || nearShelter(y + h))) { y += 30; continue; }
        const color = palette[Math.floor(rand() * palette.length)];
        const seed = Math.floor(y * 13 + x);
        const left = side === -1 ? -4 : WIDTH - 22;
        if (d.roadside === 'towers') drawRooftop(g, left, y, 26, h, color, seededRandom(seed));
        else drawContainer(g, side === -1 ? 1 : WIDTH - 20, y, 19, h, color);
        y += h + (d.roadside === 'towers' ? 8 + rand() * 14 : 4 + rand() * 30);
      }
    }
  }
  // Street trees in round planters along the footpath, between the lamps,
  // for districts whose verge is taken by buildings or containers.
  if (d.streetTrees) {
    for (const [x, side] of [[30, -1], [WIDTH - 30, 1]]) {
      for (let y = d.lampGap / 4; y < P; y += d.lampGap / 2) {
        if (side === -1 && nearShelter(y)) continue;
        const r = 14 + rand() * 4;
        const seed = Math.floor(y * 11 + x);
        wrapped(y, (wy) => {
          g.fillStyle = '#8a8276';
          g.beginPath();
          g.arc(x, wy, 7, 0, Math.PI * 2);
          g.fill();
          drawTree(g, x, wy, r, seededRandom(seed), d.bloom);
        });
      }
    }
  }

  for (let y = 0; y < P; y += d.lampGap) {
    const ly = y + d.lampGap / 2;
    if (!nearShelter(ly)) wrapped(ly, (wy) => drawLamp(g, 28, wy, -1));
    wrapped(y, (wy) => drawLamp(g, WIDTH - 28, wy, 1));
  }
  return tile;
}

function drawScenery(ctx, tile, scroll, dpr) {
  const offset = Math.round(((scroll % SCENERY_PERIOD) - SCENERY_PERIOD) * dpr) / dpr;
  ctx.drawImage(tile, 0, offset, WIDTH, SCENERY_PERIOD);
  ctx.drawImage(tile, 0, offset + SCENERY_PERIOD, WIDTH, SCENERY_PERIOD);
}

// --- vehicles ----------------------------------------------------------------

function drawShadow(ctx, x, y, w, l, r) {
  ctx.fillStyle = SHADOW;
  roundRect(ctx, x + 4, y + 6, w, l, r);
  ctx.fill();
}

/** Tyres peeking out from under the body at the given fractions of length. */
function drawWheels(ctx, x, y, w, l, at) {
  const wl = Math.max(10, l * 0.15);
  at.forEach((f) => {
    const wy = y + l * f - wl / 2;
    fillRoundRect(ctx, TYRE, x - 2, wy, 6, wl, 2);
    fillRoundRect(ctx, TYRE, x + w - 4, wy, 6, wl, 2);
  });
}

function drawMirrors(ctx, x, y, w, color) {
  fillRoundRect(ctx, shade(color, -0.2), x - 4, y, 5, 4, 1.5);
  fillRoundRect(ctx, shade(color, -0.2), x + w - 1, y, 5, 4, 1.5);
}

function drawGlass(ctx) {
  ctx.fillStyle = GLASS;
  ctx.fill();
}

function drawBody(ctx, color, x, y, w, l, r) {
  ctx.fillStyle = bodyGradient(ctx, color, x, w);
  roundRect(ctx, x, y, w, l, r);
  ctx.fill();
  ctx.strokeStyle = shade(color, -0.45);
  ctx.lineWidth = 1.2;
  ctx.stroke();
}

/** Oncoming lights: headlights on the nose (bottom), tail lights at the rear (top). */
function drawLights(ctx, x, y, w, l) {
  ctx.fillStyle = HEADLIGHT;
  ctx.fillRect(x + 4, y + l - 4, 9, 3);
  ctx.fillRect(x + w - 13, y + l - 4, 9, 3);
  ctx.fillStyle = TAILLIGHT;
  ctx.fillRect(x + 4, y + 1, 8, 3);
  ctx.fillRect(x + w - 12, y + 1, 8, 3);
}

function drawCar(ctx, v, x, y, w, l) {
  drawWheels(ctx, x, y, w, l, [0.2, 0.78]);
  drawBody(ctx, v.color, x, y, w, l, 12);
  drawMirrors(ctx, x, y + l * 0.6, w, v.color);
  // Rear window (narrower toward the back), roof, windscreen (wider toward the nose).
  quad(ctx, x + 10, x + w - 10, y + l * 0.18, x + 7, x + w - 7, y + l * 0.32);
  drawGlass(ctx);
  fillRoundRect(ctx, shade(v.color, 0.08), x + 7, y + l * 0.33, w - 14, l * 0.27, 4);
  quad(ctx, x + 7, x + w - 7, y + l * 0.61, x + 5, x + w - 5, y + l * 0.78);
  drawGlass(ctx);
  ctx.fillStyle = GLASS_SHINE;
  quad(ctx, x + 12, x + 18, y + l * 0.62, x + 8, x + 13, y + l * 0.77);
  ctx.fill();
  // Bonnet crease.
  ctx.strokeStyle = shade(v.color, -0.15);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + w / 2, y + l * 0.8);
  ctx.lineTo(x + w / 2, y + l - 6);
  ctx.stroke();
  if (v.taxi) {
    fillRoundRect(ctx, '#f6edd2', x + w / 2 - 9, y + l * 0.42, 18, 8, 2);
    ctx.fillStyle = '#c9402c';
    ctx.fillRect(x + w / 2 - 6, y + l * 0.42 + 3, 12, 2);
  }
  drawLights(ctx, x, y, w, l);
}

function drawVan(ctx, v, x, y, w, l) {
  drawWheels(ctx, x, y, w, l, [0.18, 0.8]);
  drawBody(ctx, v.color, x, y, w, l, 8);
  drawMirrors(ctx, x, y + l * 0.74, w, v.color);
  // Long flat roof with stiffening ribs, split rear doors.
  fillRoundRect(ctx, shade(v.color, 0.1), x + 5, y + 4, w - 10, l * 0.68, 4);
  ctx.fillStyle = shade(v.color, -0.12);
  for (let ry = y + 14; ry < y + l * 0.68; ry += 12) ctx.fillRect(x + 8, ry, w - 16, 2);
  ctx.fillRect(x + w / 2 - 0.5, y, 1, 6);
  quad(ctx, x + 6, x + w - 6, y + l * 0.74, x + 5, x + w - 5, y + l * 0.86);
  drawGlass(ctx);
  ctx.fillStyle = GLASS_SHINE;
  quad(ctx, x + 11, x + 17, y + l * 0.75, x + 8, x + 13, y + l * 0.85);
  ctx.fill();
  drawLights(ctx, x, y, w, l);
}

/** Red/white chevron band — the rear-end warning on lethal vehicles. */
function drawChevrons(ctx, x, y, w) {
  ctx.save();
  roundRect(ctx, x + 2, y + 2, w - 4, 8, 2);
  ctx.clip();
  ctx.fillStyle = '#f4efe4';
  ctx.fillRect(x, y, w, 12);
  ctx.fillStyle = '#c9402c';
  for (let sx = x - 8; sx < x + w + 8; sx += 10) {
    ctx.beginPath();
    ctx.moveTo(sx, y + 12);
    ctx.lineTo(sx + 5, y + 12);
    ctx.lineTo(sx + 11, y);
    ctx.lineTo(sx + 6, y);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawCab(ctx, color, x, y, w, len) {
  drawBody(ctx, color, x, y, w, len, 7);
  fillRoundRect(ctx, shade(color, 0.12), x + 6, y + 3, w - 12, len * 0.42, 4); // air deflector
  quad(ctx, x + 5, x + w - 5, y + len * 0.58, x + 4, x + w - 4, y + len - 7);
  drawGlass(ctx);
  ctx.fillStyle = GLASS_SHINE;
  quad(ctx, x + 10, x + 16, y + len * 0.6, x + 8, x + 13, y + len - 8);
  ctx.fill();
  drawMirrors(ctx, x - 2, y + len * 0.6, w + 4, color);
  ctx.fillStyle = HEADLIGHT;
  ctx.fillRect(x + 4, y + len - 4, 10, 3);
  ctx.fillRect(x + w - 14, y + len - 4, 10, 3);
}

function drawCargoBox(ctx, x, y, w, len) {
  drawBody(ctx, CARGO, x, y, w, len, 3);
  ctx.fillStyle = 'rgba(0,0,0,0.08)';
  for (let ry = y + 10; ry < y + len - 4; ry += 10) ctx.fillRect(x + 3, ry, w - 6, 2);
  // Reflective tape down both sides.
  ctx.fillStyle = '#c9402c';
  for (let ry = y + 4; ry < y + len - 6; ry += 14) {
    ctx.fillRect(x + 1, ry, 2, 7);
    ctx.fillRect(x + w - 3, ry, 2, 7);
  }
  drawChevrons(ctx, x, y, w);
}

function drawTruck(ctx, v, x, y, w, l) {
  const cab = 34;
  drawWheels(ctx, x, y, w, l, [0.12, 0.28, 0.86]);
  drawCargoBox(ctx, x, y, w, l - cab - 3);
  drawCab(ctx, v.color, x + 2, y + l - cab, w - 4, cab);
}

function drawSemi(ctx, v, x, y, w, l) {
  const cab = 36;
  const trailer = l - cab - 6;
  drawWheels(ctx, x, y, w, l, [0.07, 0.16, 0.25, 0.78, 0.92]);
  drawCargoBox(ctx, x, y, w, trailer);
  ctx.fillStyle = '#3a3734';
  ctx.fillRect(x + w / 2 - 5, y + trailer, 10, 7); // hitch
  drawCab(ctx, v.color, x + 3, y + l - cab, w - 6, cab);
  // Exhaust stacks behind the cab.
  ctx.fillStyle = '#9a948b';
  ctx.beginPath();
  ctx.arc(x + 7, y + l - cab + 3, 3, 0, Math.PI * 2);
  ctx.arc(x + w - 7, y + l - cab + 3, 3, 0, Math.PI * 2);
  ctx.fill();
}

// Oncoming vehicle, nose pointing down the screen.
function drawVehicle(ctx, v, t) {
  if (v.police) {
    drawPolice(ctx, v, t, false);
    return;
  }
  const x = v.x - v.width / 2;
  drawShadow(ctx, x, v.y, v.width, v.length, 8);
  if (v.kind === 'semi') drawSemi(ctx, v, x, v.y, v.width, v.length);
  else if (v.kind === 'truck') drawTruck(ctx, v, x, v.y, v.width, v.length);
  else if (v.kind === 'van') drawVan(ctx, v, x, v.y, v.width, v.length);
  else drawCar(ctx, v, x, v.y, v.width, v.length);
}

const POLICE_WHITE = '#f1ede4';
const POLICE_NAVY = '#24345a';

/** Light bar colours swap a few times a second. */
function sirenPhase(t) {
  return Math.floor(t * 6) % 2;
}

/**
 * A police cruiser: a car with a chequered navy livery and a flashing light
 * bar. Pursuers face up the screen (chasing the bus); roadblock cars face
 * down like the rest of the oncoming traffic.
 */
function drawPolice(ctx, p, t, facingUp, angle = 0) {
  const x = p.x - p.width / 2;
  const w = p.width;
  const l = p.length;
  drawShadow(ctx, x, p.y, w, l, 8);
  ctx.save();
  if (facingUp || angle) {
    ctx.translate(p.x, p.y + l / 2);
    ctx.rotate((facingUp ? Math.PI : 0) + angle);
    ctx.translate(-p.x, -(p.y + l / 2));
  }
  drawCar(ctx, { color: POLICE_WHITE }, x, p.y, w, l);
  ctx.fillStyle = POLICE_NAVY;
  for (let i = 0, cy = p.y + l * 0.12; cy < p.y + l * 0.88; i++, cy += 6) {
    if (i % 2) continue;
    ctx.fillRect(x + 1, cy, 4, 6);
    ctx.fillRect(x + w - 5, cy, 4, 6);
  }
  ctx.fillRect(x + 8, p.y + l * 0.82, w - 16, 3);
  const phase = sirenPhase(t);
  const by = p.y + l * 0.44;
  const red = phase ? '#ff4b3a' : '#7a2a22';
  const blue = phase ? '#2a3f7a' : '#4f8bff';
  fillRoundRect(ctx, '#2b2724', x + 9, by - 1, w - 18, 7, 2);
  ctx.fillStyle = red;
  ctx.fillRect(x + 10, by, (w - 20) / 2, 5);
  ctx.fillStyle = blue;
  ctx.fillRect(x + w / 2, by, (w - 20) / 2, 5);
  const glow = ctx.createRadialGradient(x + w / 2, by + 2, 2, x + w / 2, by + 2, 30);
  glow.addColorStop(0, phase ? 'rgba(255,75,58,0.35)' : 'rgba(79,139,255,0.35)');
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(x - 10, by - 28, w + 20, 60);
  ctx.restore();
}

/** A wrecked cruiser: charred, skewed, smoking. Harmless scenery. */
function drawWreck(ctx, wk, t) {
  ctx.save();
  ctx.translate(wk.x, wk.y + wk.length / 2);
  ctx.rotate(wk.angle);
  drawCar(ctx, { color: '#6a645c' }, -wk.width / 2, -wk.length / 2, wk.width, wk.length);
  ctx.fillStyle = 'rgba(30,26,22,0.55)';
  ctx.beginPath();
  ctx.arc(-6, -4, 12, 0, Math.PI * 2);
  ctx.arc(8, 8, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  for (let i = 0; i < 3; i++) {
    const k = (t * 0.8 + i / 3 + wk.angle) % 1;
    ctx.fillStyle = `rgba(90,86,80,${0.45 * (1 - k)})`;
    ctx.beginPath();
    ctx.arc(wk.x + Math.sin(k * 6 + i) * 6, wk.y + wk.length / 2 - k * 40, 7 + k * 10, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Red/blue glow on the bottom edge for a pursuer that's still off-screen. */
function drawSirenCue(ctx, p, t) {
  const color = sirenPhase(t) ? '255,75,58' : '79,139,255';
  const g = ctx.createRadialGradient(p.x, HEIGHT, 2, p.x, HEIGHT, 60);
  g.addColorStop(0, `rgba(${color},0.6)`);
  g.addColorStop(1, `rgba(${color},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(p.x - 60, HEIGHT - 60, 120, 60);
}

/** "LEVEL 2 / Heartland" card across the road; fades in and out over BANNER_SECONDS. */
function drawBanner(ctx, b) {
  ctx.globalAlpha = Math.max(0, Math.min(1, b.t / 0.4, (BANNER_SECONDS - b.t) / 0.25));
  ctx.fillStyle = 'rgba(36,30,24,0.75)';
  ctx.fillRect(0, 150, WIDTH, 92);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffb547';
  ctx.font = 'bold 34px Caprasimo, Georgia, serif';
  ctx.fillText(b.title, WIDTH / 2, 185);
  ctx.fillStyle = '#f1e9d6';
  ctx.font = '600 17px Figtree, sans-serif';
  ctx.fillText(b.sub, WIDTH / 2, 221);
  ctx.globalAlpha = 1;
}

// --- fares, bus, effects -----------------------------------------------------

/** A spinning gold fare coin; `t` is seconds, `f.phase` staggers the spin. */
function drawFare(ctx, f, t) {
  const glow = ctx.createRadialGradient(f.x, f.y, 4, f.x, f.y, FARE_RADIUS * 2);
  glow.addColorStop(0, 'rgba(255,214,102,0.45)');
  glow.addColorStop(1, 'rgba(255,214,102,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(f.x - FARE_RADIUS * 2, f.y - FARE_RADIUS * 2, FARE_RADIUS * 4, FARE_RADIUS * 4);

  const spin = Math.max(0.18, Math.abs(Math.cos(t * 3 + (f.phase || 0))));
  const rx = FARE_RADIUS * spin;
  ctx.fillStyle = SHADOW;
  ctx.beginPath();
  ctx.ellipse(f.x + 3, f.y + 5, rx, FARE_RADIUS, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#a8741a'; // coin edge
  ctx.beginPath();
  ctx.ellipse(f.x, f.y + 1.5, rx, FARE_RADIUS, 0, 0, Math.PI * 2);
  ctx.fill();
  const face = ctx.createRadialGradient(f.x - rx * 0.4, f.y - 5, 1, f.x, f.y, FARE_RADIUS);
  face.addColorStop(0, '#fff0b3');
  face.addColorStop(0.5, '#f2c94c');
  face.addColorStop(1, '#d9a22a');
  ctx.fillStyle = face;
  ctx.beginPath();
  ctx.ellipse(f.x, f.y, rx, FARE_RADIUS, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(140,96,20,0.6)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.ellipse(f.x, f.y, rx * 0.72, FARE_RADIUS * 0.72, 0, 0, Math.PI * 2);
  ctx.stroke();
  if (spin > 0.55) {
    ctx.save();
    ctx.translate(f.x, f.y + 1);
    ctx.scale(spin, 1);
    ctx.fillStyle = '#8a5e10';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('$', 0, 0);
    ctx.restore();
  }
}

/** A banana lying on the road (slipped out of a truck), curved, top-down. */
function drawBanana(ctx, b) {
  ctx.save();
  ctx.translate(b.x, b.y);
  ctx.rotate(b.angle);
  ctx.fillStyle = SHADOW;
  ctx.beginPath();
  ctx.ellipse(2, 4, 10, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineCap = 'round';
  const curve = (color, width, r, from, to) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.arc(0, -9, r, Math.PI * from, Math.PI * to);
    ctx.stroke();
  };
  curve('#b8860b', 8, 11, 0.18, 0.82);
  curve('#f2d34c', 5.5, 11, 0.2, 0.8);
  curve('rgba(255,255,255,0.45)', 1.5, 9.5, 0.3, 0.6);
  ctx.fillStyle = '#5a4320';
  [0.18, 0.82].forEach((a) => {
    ctx.beginPath();
    ctx.arc(Math.cos(Math.PI * a) * 11, -9 + Math.sin(Math.PI * a) * 11, 2.2, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();
}

/**
 * The player's bus, nose up. `braking` lights the brake lamps; `angle`
 * (radians) twists it about its centre for a banana skid.
 */
function drawBus(ctx, x, flashing, braking, angle = 0) {
  ctx.save();
  if (angle) {
    ctx.translate(x, BUS_Y + BUS_LENGTH / 2);
    ctx.rotate(angle);
    ctx.translate(-x, -(BUS_Y + BUS_LENGTH / 2));
  }
  if (flashing) ctx.globalAlpha = 0.4;
  const left = x - BUS_WIDTH / 2;
  const top = BUS_Y;
  const w = BUS_WIDTH;
  const l = BUS_LENGTH;
  drawShadow(ctx, left, top, w, l, 10);
  drawWheels(ctx, left, top, w, l, [0.2, 0.76]);
  drawBody(ctx, BUS_COLOR, left, top, w, l, 10);
  drawMirrors(ctx, left - 1, top + 6, w + 2, BUS_COLOR);

  // Windscreen across the nose.
  quad(ctx, left + 5, left + w - 5, top + 4, left + 6, left + w - 6, top + 15);
  drawGlass(ctx);
  ctx.fillStyle = GLASS_SHINE;
  quad(ctx, left + 10, left + 17, top + 5, left + 12, left + 18, top + 14);
  ctx.fill();

  // Side window strips with pillars.
  ctx.fillStyle = GLASS;
  for (let y = top + 20; y < top + l - 14; y += 13) {
    ctx.fillRect(left + 2, y, 4, 10);
    ctx.fillRect(left + w - 6, y, 4, 10);
  }

  // Cream roof with destination sign, aircon pod and a rear hatch.
  fillRoundRect(ctx, BUS_ROOF, left + 7, top + 17, w - 14, l - 28, 5);
  fillRoundRect(ctx, '#2b2724', left + 12, top + 19, w - 24, 10, 2);
  ctx.fillStyle = '#ffb547';
  ctx.font = 'bold 9px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('88', x, top + 24.5);
  fillRoundRect(ctx, '#d7ccb8', left + 11, top + 34, w - 22, 26, 4);
  ctx.strokeStyle = '#bfb39d';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let gy = top + 38; gy < top + 58; gy += 4) {
    ctx.moveTo(left + 14, gy);
    ctx.lineTo(left + w - 14, gy);
  }
  ctx.stroke();
  [x - 8, x + 8].forEach((fx) => {
    ctx.fillStyle = '#a99d88';
    ctx.beginPath();
    ctx.arc(fx, top + 47, 5, 0, Math.PI * 2);
    ctx.fill();
  });
  fillRoundRect(ctx, '#d7ccb8', left + 17, top + 65, w - 34, 10, 2);

  // Engine grille and lamps at the rear.
  ctx.fillStyle = shade(BUS_COLOR, -0.3);
  for (let gx = left + 14; gx < left + w - 14; gx += 4) ctx.fillRect(gx, top + l - 8, 2, 5);
  ctx.fillStyle = HEADLIGHT;
  ctx.fillRect(left + 4, top + 1, 9, 3);
  ctx.fillRect(left + w - 13, top + 1, 9, 3);
  if (braking) {
    const glow = ctx.createRadialGradient(x, top + l, 2, x, top + l, 34);
    glow.addColorStop(0, 'rgba(255,70,40,0.45)');
    glow.addColorStop(1, 'rgba(255,70,40,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(left - 10, top + l - 20, w + 20, 50);
  }
  ctx.fillStyle = braking ? '#ff5a3c' : '#8e2f1f';
  ctx.fillRect(left + 4, top + l - 4, 9, 3);
  ctx.fillRect(left + w - 13, top + l - 4, 9, 3);
  ctx.globalAlpha = 1;
  ctx.restore();
}

/** Sparks and debris: { x, y, vx, vy, life, max, size, color } in canvas px/s. */
function stepEffects(effects, dt) {
  for (const p of effects) {
    p.life -= dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= 1 - 2.5 * dt;
    p.vy *= 1 - 2.5 * dt;
  }
  return effects.filter((p) => p.life > 0);
}

function drawEffects(ctx, effects) {
  for (const p of effects) {
    ctx.globalAlpha = Math.max(0, p.life / p.max);
    if (p.text) {
      ctx.fillStyle = p.color;
      ctx.font = 'bold 16px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.strokeStyle = 'rgba(40,28,10,0.6)';
      ctx.lineWidth = 3;
      ctx.strokeText(p.text, p.x, p.y);
      ctx.fillText(p.text, p.x, p.y);
    } else {
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
  }
  ctx.globalAlpha = 1;
}

function burst(effects, x, y, colors, count, speed, size) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = speed * (0.4 + Math.random() * 0.6);
    const max = 0.4 + Math.random() * 0.35;
    effects.push({
      x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: max, max,
      size: size * (0.6 + Math.random() * 0.6),
      color: colors[Math.floor(Math.random() * colors.length)],
    });
  }
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
  // Back the canvas at the screen's pixel ratio so the art stays crisp; all
  // drawing still happens in WIDTH x HEIGHT logical units.
  const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
  canvas.width = WIDTH * dpr;
  canvas.height = HEIGHT * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // District tiles are built on first use (and pre-warmed just before each
  // boundary), not all up front — each one is a full-resolution canvas.
  const sceneryCache = [];
  const sceneryFor = (i) => sceneryCache[i] || (sceneryCache[i] = buildScenery(dpr, DISTRICTS[i]));
  let effects = [];
  let shake = 0;
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
    el.hud.score.textContent = r ? runScore(r.distance, r.fares, r.bonus) : 0;
    const stars = r ? wantedLevel(r.distance, r.fares) : 0;
    el.hud.level.textContent = r ? r.level + 1 : 1;
    el.hud.wanted.textContent = '★'.repeat(stars) + '☆'.repeat(WANTED_MAX - stars);
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
      bananas: [],
      skid: 0,
      sinceRow: 0,
      prevOpen: null,
      scroll: 0,
      police: [],
      wrecks: [],
      wrecked: 0,
      bonus: 0,
      policeTimer: POLICE_FIRST_SECONDS,
      level: 0,
      fadeFrom: 0,
      fade: 0,
      banner: { title: 'LEVEL 1', sub: LEVELS[0], t: BANNER_SECONDS },
    };
    input.accelerate = false;
    input.brake = false;
    effects = [];
    shake = 0;
    show(null);
    renderHud();
    canvas.focus({ preventScroll: true });
  }

  function endRun() {
    if (!run || run.status !== 'playing') return;
    run.status = 'over';
    const distance = Math.min(Math.floor(run.distance), DISTANCE_MAX);
    const score = runScore(run.distance, run.fares, run.bonus);
    const tokens = runTokens(run.distance, run.fares, progress.upgrades.fareBox, run.wrecked);

    progress.tokens += tokens;
    const newBest = score > progress.bestScore;
    progress.bestScore = Math.max(progress.bestScore, score);
    progress.bestDistance = Math.max(progress.bestDistance, distance);
    saveProgress(progress);

    const titles = [];
    if (run.killedBy) titles.push(`Flattened by a ${run.killedBy}!`);
    else if (run.busted) titles.push('Busted!');
    if (newBest) titles.push('New best run!');
    el.runOver.title.textContent = titles.length ? titles.join(' ') : 'Run over';
    el.runOver.distance.textContent = `${distance} m`;
    el.runOver.fares.textContent = run.fares;
    el.runOver.wrecked.textContent = run.wrecked;
    el.runOver.level.textContent = `${run.level + 1} · ${LEVELS[run.level]}`;
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
    r.speed = minSpeed(r.level);
    shake = vehicle && vehicle.lethal ? 0.6 : 0.35;
    const impactX = (r.busX + (vehicle ? vehicle.x : r.busX)) / 2;
    burst(effects, impactX, BUS_Y + 4, [vehicle ? vehicle.color : '#888', '#2e4552', '#f1e9d6', BUS_COLOR], 18, 260, 5);
    r.grace = HIT_GRACE_SECONDS;
    if (r.lives <= 0) {
      r.busted = Boolean(vehicle && vehicle.police);
      r.killedBy = vehicle && vehicle.lethal && !r.busted ? vehicle.kind : null;
      endRun();
    }
  }

  function spawnRow(r, overshoot) {
    if (r.noTraffic) return;
    const blocked = pickBlockedLanes(Math.random, r.distance, r.prevOpen);
    const open = openLanes(blocked);
    r.prevOpen = open;
    // A roadblock is a row of oncoming cruisers — same lanes, same speed as
    // traffic, so it keeps the "every row is passable" guarantee.
    const roadblock = Math.random() < roadblockChance(r.distance, wantedLevel(r.distance, r.fares));
    const laneLength = {};
    blocked.forEach((lane) => {
      const kind = roadblock ? POLICE_CAR : pickVehicle(Math.random, r.distance);
      const taxi = kind.kind === 'car' && Math.random() < TAXI_CHANCE;
      const palette = roadblock ? [POLICE_WHITE] : taxi ? TAXI_COLORS : VEHICLE_COLORS;
      laneLength[lane] = kind.length;
      r.vehicles.push({
        kind: kind.kind,
        lethal: Boolean(kind.lethal),
        drops: bananaDrops(Math.random, kind),
        x: laneCenter(lane),
        y: -kind.length + overshoot,
        width: kind.width,
        length: kind.length,
        color: palette[Math.floor(Math.random() * palette.length)],
        taxi,
        police: roadblock,
      });
    });
    if (roadblock) return;
    // A fare sits in the clear gap behind this row, in any lane — sometimes
    // one that takes a risky lane change to reach.
    if (Math.random() < FARE_CHANCE) {
      const lane = Math.floor(Math.random() * LANES);
      const y = overshoot + fareOffset(rowSpacingPx(r.distance), laneLength[lane] || 0, FARE_RADIUS);
      r.fareItems.push({ x: laneCenter(lane), y, phase: Math.random() * Math.PI * 2 });
    }
  }

  function update(dt) {
    const r = run;
    r.speed = stepSpeed(r.speed, input, dt, progress.upgrades.engine, r.level);
    r.distance = Math.min(r.distance + r.speed * dt, DISTANCE_MAX);
    r.grace = Math.max(0, r.grace - dt);
    r.scroll += r.speed * dt * PX_PER_METER;
    updateLevel(r, dt);

    // Lane change: slide toward the target lane at one lane per
    // laneChangeSeconds.
    const targetX = laneCenter(r.lane);
    const step = (LANE_WIDTH / laneChangeSeconds(progress.upgrades.steering)) * dt;
    r.busX = Math.abs(targetX - r.busX) <= step ? targetX : r.busX + Math.sign(targetX - r.busX) * step;

    // Traffic and fares close in at the bus's speed plus traffic's own.
    const closing = (r.speed + TRAFFIC_SPEED) * dt * PX_PER_METER;
    r.vehicles.forEach((v) => { v.y += closing; });
    updateBananas(r, dt);
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
    updatePolice(r, dt, bus);
    if (r.status !== 'playing') return;

    // Run over a banana: skid one lane over, steering locked meanwhile.
    if (r.skid <= 0) {
      const slipped = r.bananas.find((b) => rectsOverlap(bus, { x: b.x - 9, y: b.y - 5, w: 18, h: 10 }));
      if (slipped) {
        r.bananas = r.bananas.filter((b) => b !== slipped);
        r.skid = SKID_SECONDS;
        r.lane = skidLane(r.lane, Math.random);
        burst(effects, slipped.x, slipped.y, ['#f2d34c', '#b8860b', '#fff6c2'], 10, 200, 4);
        effects.push({ x: r.busX, y: BUS_Y - 14, vx: 0, vy: -60, life: 0.8, max: 0.8, text: 'SKID!', color: '#f2d34c' });
      }
    }

    r.fareItems = r.fareItems.filter((f) => {
      const caught = rectsOverlap(bus, { x: f.x - FARE_RADIUS, y: f.y - FARE_RADIUS, w: FARE_RADIUS * 2, h: FARE_RADIUS * 2 });
      if (caught) {
        r.fares += 1;
        burst(effects, f.x, f.y, ['#ffe08a', '#f2c94c', '#fff6d8'], 10, 180, 4);
        effects.push({ x: f.x, y: f.y - 14, vx: 0, vy: -70, life: 0.7, max: 0.7, text: '+$', color: '#ffe08a' });
      }
      return !caught;
    });
  }

  /** Crossing into a new district: lives refilled, checkpoint bonus, banner, scenery crossfade. */
  function updateLevel(r, dt) {
    r.fade = Math.max(0, r.fade - dt / FADE_SECONDS);
    if (r.banner) {
      r.banner.t -= dt;
      if (r.banner.t <= 0) r.banner = null;
    }
    const lvl = levelAt(r.distance);
    if (lvl !== r.level) {
      const points = checkpointPoints(lvl);
      r.bonus += points;
      const refilled = r.lives < maxLives(progress.upgrades.bumpers);
      r.lives = maxLives(progress.upgrades.bumpers);
      // A kick of speed on entry; the higher floor/ceiling keep it after.
      r.speed = Math.min(r.speed + LEVEL_SPEED_STEP * 2, maxSpeed(progress.upgrades.engine, lvl));
      r.fadeFrom = r.level;
      r.fade = 1;
      r.level = lvl;
      const sub = `${LEVELS[lvl]}  ·  +${points}${refilled ? '  ·  lives refilled' : ''}`;
      r.banner = { title: `LEVEL ${lvl + 1}`, sub, t: BANNER_SECONDS };
    } else if (lvl + 1 < LEVELS.length && r.distance % LEVEL_DISTANCE > LEVEL_DISTANCE - 150) {
      sceneryFor(lvl + 1);
    }
  }

  /**
   * Leaky trucks/semis drop a banana from their rear each time it passes one
   * of their `drops` heights. A dropped banana lies still on the road — it
   * scrolls at the bus's speed, slower than traffic, so it falls in behind
   * its truck — after a brief slide and spin as it slips out.
   */
  function updateBananas(r, dt) {
    r.skid = Math.max(0, r.skid - dt);
    for (const v of r.vehicles) {
      while (v.drops && v.drops.length && v.y >= v.drops[0]) {
        v.drops.shift();
        r.bananas.push({
          x: v.x + (Math.random() - 0.5) * 14,
          y: v.y - 4,
          vx: (Math.random() - 0.5) * 90,
          angle: Math.random() * Math.PI * 2,
          spin: (Math.random() < 0.5 ? -1 : 1) * (6 + Math.random() * 6),
        });
      }
    }
    const scroll = r.speed * PX_PER_METER * dt;
    const settle = Math.max(0, 1 - 4 * dt);
    for (const b of r.bananas) {
      b.y += scroll;
      b.x += b.vx * dt;
      b.angle += b.spin * dt;
      b.vx *= settle;
      b.spin *= settle;
    }
    r.bananas = r.bananas.filter((b) => b.y < HEIGHT + 10);
  }

  function spawnPolice(r, lane, y) {
    r.police.push({
      ...POLICE_CAR,
      color: POLICE_WHITE,
      lane,
      x: laneCenter(lane),
      y,
      retarget: 0,
    });
  }

  function wreckPolice(r, p) {
    const wanted = wantedLevel(r.distance, r.fares);
    const points = policeWreckPoints(wanted);
    r.wrecked += 1;
    r.bonus += points;
    r.wrecks.push({ x: p.x, y: p.y, width: p.width, length: p.length, angle: (Math.random() - 0.5) * 1.2 });
    burst(effects, p.x, p.y + p.length / 2, ['#f1ede4', '#24345a', '#ff4b3a', '#ffb547'], 16, 220, 5);
    effects.push({ x: p.x, y: p.y, vx: 0, vy: -60, life: 0.9, max: 0.9, text: `+${points}`, color: '#9fc4ff' });
    shake = Math.max(shake, 0.15);
  }

  /**
   * Pursuers close in from behind whenever they're faster than the bus,
   * re-aim at its lane every policeReactionSeconds (the juke window), end
   * the run on contact (Busted), and wreck themselves on any oncoming
   * vehicle.
   */
  function updatePolice(r, dt, bus) {
    const wanted = wantedLevel(r.distance, r.fares);
    r.policeTimer -= dt;
    if (r.policeTimer <= 0 && r.police.length < maxPolice(wanted)) {
      r.policeTimer = POLICE_SPAWN_SECONDS;
      const lane = Math.min(Math.max(r.lane + Math.floor(Math.random() * 3) - 1, 0), LANES - 1);
      spawnPolice(r, lane, HEIGHT + 20);
    }

    const approach = (policeSpeed(wanted, r.level) - r.speed) * PX_PER_METER;
    const laneStep = (LANE_WIDTH / POLICE_LANE_SECONDS) * dt;
    for (const p of r.police) {
      p.y -= approach * dt;
      p.y = Math.max(p.y, BUS_Y - p.length / 2); // alongside at most, never ahead
      p.skid = Math.max(0, (p.skid || 0) - dt);
      p.retarget -= dt;
      if (p.retarget <= 0 && p.skid === 0) {
        p.retarget = policeReactionSeconds(wanted);
        p.lane += Math.sign(r.lane - p.lane);
      }
      const tx = laneCenter(p.lane);
      p.x = Math.abs(tx - p.x) <= laneStep ? tx : p.x + Math.sign(tx - p.x) * laneStep;
    }

    // Keep cruisers sharing a lane from stacking on top of each other.
    r.police.sort((a, b) => a.y - b.y);
    for (let i = 1; i < r.police.length; i++) {
      for (let j = 0; j < i; j++) {
        const a = r.police[j];
        const b = r.police[i];
        if (Math.abs(a.x - b.x) < a.width && b.y < a.y + a.length + 6) b.y = a.y + a.length + 6;
      }
    }

    const box = (v) => ({ x: v.x - v.width / 2 + 3, y: v.y + 3, w: v.width - 6, h: v.length - 6 });

    // Cruisers slip on bananas too: one lane over, no re-aiming meanwhile —
    // which can throw them into traffic (a wreck) or into the bus (Busted).
    for (const p of r.police) {
      if (p.skid > 0) continue;
      const slipped = r.bananas.find((b) => rectsOverlap(box(p), { x: b.x - 9, y: b.y - 5, w: 18, h: 10 }));
      if (!slipped) continue;
      r.bananas = r.bananas.filter((b) => b !== slipped);
      p.skid = SKID_SECONDS;
      p.lane = skidLane(p.lane, Math.random);
      burst(effects, slipped.x, slipped.y, ['#f2d34c', '#b8860b', '#fff6c2'], 8, 180, 4);
      effects.push({ x: p.x, y: p.y - 10, vx: 0, vy: -60, life: 0.7, max: 0.7, text: 'SKID!', color: '#9fc4ff' });
    }

    r.police = r.police.filter((p) => {
      const crashed = r.vehicles.some((v) => rectsOverlap(box(p), box(v)));
      if (crashed) wreckPolice(r, p);
      return !crashed && p.y < HEIGHT + 220; // far enough back = lost them
    });

    for (const p of r.police) {
      if (rectsOverlap(bus, box(p))) {
        hit(r, p);
        if (r.status !== 'playing') return;
      }
    }

    r.wrecks.forEach((wk) => { wk.y += r.speed * PX_PER_METER * dt; });
    r.wrecks = r.wrecks.filter((wk) => wk.y < HEIGHT + 40);
  }

  function draw(t) {
    const r = run;
    ctx.save();
    if (shake > 0) {
      const k = shake * 14;
      ctx.translate((Math.random() - 0.5) * k, (Math.random() - 0.5) * k);
    }
    const scroll = r ? r.scroll : idleScroll;
    drawScenery(ctx, sceneryFor(r ? r.level : 0), scroll, dpr);
    if (r && r.fade > 0) {
      ctx.globalAlpha = r.fade;
      drawScenery(ctx, sceneryFor(r.fadeFrom), scroll, dpr);
      ctx.globalAlpha = 1;
    }
    if (r) {
      r.wrecks.forEach((wk) => drawWreck(ctx, wk, t));
      r.bananas.forEach((b) => drawBanana(ctx, b));
      r.fareItems.forEach((f) => drawFare(ctx, f, t));
      r.vehicles.forEach((v) => drawVehicle(ctx, v, t));
      r.police.forEach((p) => {
        if (p.y >= HEIGHT) drawSirenCue(ctx, p, t);
        else drawPolice(ctx, p, t, true, p.skid > 0 ? Math.sin(p.skid * 40) * 0.3 * (p.skid / SKID_SECONDS) : 0);
      });
      const flashing = r.grace > 0 && Math.floor(r.grace * 10) % 2 === 0;
      const wobble = r.skid > 0 ? Math.sin(r.skid * 40) * 0.3 * (r.skid / SKID_SECONDS) : 0;
      drawBus(ctx, r.busX, flashing, r.status === 'playing' && input.brake, wobble);
    } else {
      drawBus(ctx, laneCenter(1), false, false);
    }
    drawEffects(ctx, effects);
    if (r && r.banner) drawBanner(ctx, r.banner);
    ctx.restore();
    if (shake > 0) {
      ctx.fillStyle = `rgba(201,64,44,${Math.min(shake, 0.5) * 0.35})`;
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
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
    effects = stepEffects(effects, dt);
    shake = Math.max(0, shake - dt);
    draw(now / 1000);
    rafHandle = window.requestAnimationFrame(loop);
  }

  // --- input --------------------------------------------------------------

  function steer(dir) {
    if (!run || run.status !== 'playing' || run.skid > 0) return;
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
    // Puts a cruiser right behind the bus, overlapping it, so the next
    // update() rams through the real police path.
    // Stops traffic (and clears what's on screen) so a run can't take damage
    // — isolates the police chase for tests.
    noTraffic() {
      if (!run) return;
      run.noTraffic = true;
      run.vehicles = [];
    },
    // Read-only view of the chase: gap is px from the bus's rear bumper to
    // each cruiser's nose (negative = alongside/overlapping).
    snapshot() {
      if (!run) return null;
      return {
        status: run.status,
        level: run.level + 1,
        kmh: toKmh(run.speed),
        lane: run.lane,
        skidding: run.skid > 0,
        bananas: run.bananas.length,
        policeLanes: run.police.map((p) => p.lane),
        policeSkidding: run.police.filter((p) => p.skid > 0).length,
        wanted: wantedLevel(run.distance, run.fares),
        police: run.police.map((p) => Math.round(p.y - (BUS_Y + BUS_LENGTH))),
      };
    },
    // Jumps the run to `meters` so district changes can be tested.
    warp(meters) {
      if (run && run.status === 'playing') run.distance = meters;
    },
    // Drops a banana just ahead of the bus in its lane, so the next frames
    // run it over through the real skid path.
    banana() {
      if (!run || run.status !== 'playing') return;
      run.bananas.push({ x: laneCenter(run.lane), y: BUS_Y - 20, vx: 0, angle: 0, spin: 0 });
    },
    // A cruiser in the bus's lane, behind it and not re-aiming, with a
    // banana just ahead of its nose — it runs the banana over through the
    // real police path. Stops traffic so nothing else interferes.
    policeBanana() {
      if (!run || run.status !== 'playing') return;
      run.noTraffic = true;
      run.vehicles = [];
      const y = BUS_Y + BUS_LENGTH + 60;
      spawnPolice(run, run.lane, y);
      run.police[run.police.length - 1].retarget = 99;
      run.bananas.push({ x: laneCenter(run.lane), y: y - 12, vx: 0, angle: 0, spin: 0 });
    },
    policeRam() {
      if (!run || run.status !== 'playing') return;
      run.grace = 0;
      spawnPolice(run, run.lane, BUS_Y + BUS_LENGTH - 20);
    },
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
      wanted: $('bus-rush-hud-wanted'),
      level: $('bus-rush-hud-level'),
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
      wrecked: $('bus-rush-run-over-wrecked'),
      level: $('bus-rush-run-over-level'),
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
