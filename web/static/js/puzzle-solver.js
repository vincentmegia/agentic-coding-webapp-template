// Puzzle Solver canvas engine: grid rendering, pointer input, and the DFS
// solve animation (docs/features/puzzle-solver.md, "User Flow", "Visual
// Direction", "Business Rules / Validation"). This file owns everything
// HTMX cannot model for /puzzle-solver: the toolbar wiring, the pointer-
// driven click/drag grid editing, the canvas draw loop, and the solve
// animation's `setInterval`. Every actual state *transition* (placing
// Start/End, painting/erasing a wall, resetting) is delegated to the pure
// `./puzzle/grid-state.js` module; the DFS algorithm itself lives entirely
// in the pure `./puzzle/dfs.js` module. This file only decides *when* those
// functions run (a click happened, a drag entered a new cell, Solve was
// pressed) and *how* to draw the result — it never reimplements grid-state
// mutation or search logic inline.
//
// Unlike Fishing Game/Kitchen Shift, there is no persisted save, no
// leaderboard, and the intrinsic canvas size never changes at runtime (doc's
// Out of scope: "no resizable/zoomable canvas") — so, unlike
// fishing-game.js's resizeCanvasToDisplaySize(), this file never touches
// canvas.width/height after load. It only ever converts a pointer event's
// CSS-pixel position into this fixed 600×600 coordinate space, the same
// ratio conversion fishing-game.js's canvasXFromEvent() uses for its own
// (also fixed-size) canvas.
//
// This canvas *does* follow the site's light/dark toggle (doc's Visual
// Direction — unlike Fishing Game's fixed dark-ocean palette, a flat grid of
// colored cells reads fine in both themes), so every "Organic" token color
// used below is read live from the site's CSS custom properties
// (`--color-surface`, `--color-ink`, etc. — see docs/skills/tailwind-ui/
// SKILL.md's Visual Style and web/static/css/app.css's `@theme` block) via
// `getComputedStyle` rather than hardcoded once, and a MutationObserver on
// `<html>`'s class attribute (the mechanism theme-toggle.js actually flips —
// see that file) triggers a redraw whenever the toggle changes it.
//
// External file, no inline <script> tag, per this codebase's CSP-compatible
// convention (see fishing-game.js, theme-toggle.js) and
// docs/features/home.md's Security Considerations. Loaded as an ES module:
//
//   <script type="module" src="/static/js/puzzle-solver.js"></script>
//
// from web/templates/pages/puzzle-solver.html — see this file's exported
// `init()` doc comment below for the DOM contract that page provides.
//
// Nothing below touches `document`/`window`/canvas at module-evaluation
// time: every DOM read/write happens inside `init()` or functions it calls,
// and the only top-level side effect is the auto-bootstrap at the bottom of
// this file, itself guarded by `typeof document !== 'undefined'` so
// importing this module under Node (e.g. `node --check`) never touches a
// nonexistent DOM — same convention as fishing-game.js.

import { ROWS, COLS, solveDFS } from './puzzle/dfs.js';
import { createGridState, setStart, setEnd, paintWall, eraseWall, resetGrid, isReadyToSolve } from './puzzle/grid-state.js';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Milliseconds between revealing each successive cell in DFS's visitOrder
 * during the solve animation. A fixed value, not a user-facing speed
 * control — per the doc's Business Rules ("a fixed interval is proposed ...
 * the actual per-cell delay value is a tuning choice best made by eye"),
 * this is a first-pass number, not a designed/tested constant. Overridable
 * via window.__puzzleSolverTestHooks.setAnimationIntervalMs (below) so
 * e2e/puzzle-solver.spec.js isn't stuck waiting out a multi-second
 * animation on a full 900-cell grid just to assert the end state.
 */
let animationIntervalMs = 10;

// ---------------------------------------------------------------------------
// Palette (doc's Visual Direction — read live so a theme toggle repaints
// correctly; see file header)
// ---------------------------------------------------------------------------

function readColorToken(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function currentPalette() {
  return {
    surface: readColorToken('--color-surface'),
    surface2: readColorToken('--color-surface-2'),
    ink: readColorToken('--color-ink'),
    // Start = sage (accent), End = terracotta (primary) — matching this
    // site's existing accent/primary meaning elsewhere (bullets/badges vs.
    // links/CTAs), not a new color pairing invented for this feature.
    accent: readColorToken('--color-accent'),
    primary: readColorToken('--color-primary'),
  };
}

// Visited/path overlay colors are deliberately fixed (not theme tokens) —
// same reasoning as fishing-game.js's HAZARD_BANDS colors: these are
// *state* indicators (amber = explored, sage = final path) whose meaning
// must stay legible and consistent regardless of the site's light/dark
// toggle, not decorative surface chrome that should shift with it. The
// amber fill is translucent specifically so it reads correctly layered over
// either an empty (surface) or already-explored cell without a second color
// ramp per theme.
const VISITED_FILL = 'rgba(230, 168, 44, 0.38)';
const PATH_STROKE = 'rgba(32, 30, 29, 0.55)';

// ---------------------------------------------------------------------------
// init()
// ---------------------------------------------------------------------------

/**
 * Wires up and starts the Puzzle Solver against a real canvas + toolbar/
 * status elements. Does nothing at import time (see file header) — must be
 * called explicitly once the page's DOM exists.
 *
 * DOM contract (`elements`):
 *   toolButtons: { start, end, wall, erase }  — the four mutually-exclusive placement/drawing tool buttons.
 *   solveButton, resetButton, clearPathButton — action buttons.
 *   status                                     — #puzzle-status text node (role="status" in the template).
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} elements - see DOM contract above.
 * @returns {() => void} a teardown function (also auto-invoked on htmx nav-away).
 */
export function init(canvas, elements) {
  // Tear down any previous instance first — defensive against init() being
  // called twice without an intervening navigation, same guard
  // fishing-game.js's init() uses.
  if (typeof teardownActiveInstance === 'function') teardownActiveInstance();

  const ctx = canvas.getContext('2d');
  const cellSize = canvas.width / COLS;

  let state = createGridState(ROWS, COLS);

  // No tool is selected by default (ACTIVE_TOOL_DEFAULT = null), rather than
  // defaulting to e.g. 'wall' — an unselected toolbar means a stray click on
  // the canvas before the visitor has consciously picked a tool does
  // nothing, instead of silently painting a wall under their cursor. The
  // doc's User Flow always has the visitor click a tool button first, so
  // this default costs nothing in the intended flow and avoids a footgun in
  // an unintended one.
  let activeTool = null; // 'start' | 'end' | 'wall' | 'erase' | null

  // Transient visualization state (not part of GridState — grid-state.js's
  // contract is walls/start/end only, per the doc's UI module list). Reset
  // by Reset Grid, Clear Path, and — per the doc's Business Rules — any
  // wall/start/end edit made after a completed solve.
  let visitedCells = []; // {row,col}[], the prefix of the last solve's visitOrder revealed so far
  let pathCells = null; // {row,col}[] | null, only set once the reveal animation finishes with a path

  let editingLocked = false; // true only while the solve animation is running
  let animationTimer = null;
  let isDragging = false;
  let lastDragCellKey = null;

  // -- Rendering ----------------------------------------------------------

  function drawStartIcon(cx, cy, r) {
    // A simple right-pointing "play" triangle, white against the sage fill —
    // doc's Visual Direction: "sage-tinted fill with a small flag or
    // play-triangle icon".
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.35, cy - r * 0.5);
    ctx.lineTo(cx - r * 0.35, cy + r * 0.5);
    ctx.lineTo(cx + r * 0.45, cy);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }

  function drawEndIcon(cx, cy, r) {
    // A simple target (ring + dot), white against the terracotta fill —
    // doc's Visual Direction: "terracotta-tinted fill with a small flag or
    // target icon".
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.42, 0, Math.PI * 2);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1.5, r * 0.12);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.16, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }

  function render() {
    const palette = currentPalette();
    const visitedKeys = new Set(visitedCells.map((cell) => `${cell.row},${cell.col}`));
    const pathKeys = new Set((pathCells || []).map((cell) => `${cell.row},${cell.col}`));

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Base pass: empty/wall fill + visited/path overlay, per-cell. Grid
    // lines are drawn as each cell's own stroked rect rather than a
    // separate line pass, so they never need re-aligning against the fills.
    for (let row = 0; row < ROWS; row += 1) {
      for (let col = 0; col < COLS; col += 1) {
        const key = `${row},${col}`;
        const x = col * cellSize;
        const y = row * cellSize;

        // Walls use --color-ink (dark in light mode, light-on-dark in dark
        // mode) rather than a single fixed hex — it stays a strongly
        // contrasting, visually "solid" fill in both themes without a
        // dedicated wall-color token, per the doc's "solid dark/umber fill"
        // requirement (umber isn't a token this site has; ink already reads
        // as solid/opaque in both palettes).
        ctx.fillStyle = state.walls.has(key) ? palette.ink : palette.surface;
        ctx.fillRect(x, y, cellSize, cellSize);

        if (visitedKeys.has(key)) {
          ctx.fillStyle = VISITED_FILL;
          ctx.fillRect(x, y, cellSize, cellSize);
        }
        if (pathKeys.has(key)) {
          // Solid sage fill layered over the visited color (doc's Visual
          // Direction), plus a thicker border so the path route reads at a
          // glance even where it overlaps the visited trail.
          ctx.fillStyle = palette.accent;
          ctx.fillRect(x, y, cellSize, cellSize);
          ctx.strokeStyle = PATH_STROKE;
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 1, y + 1, cellSize - 2, cellSize - 2);
        }

        ctx.strokeStyle = palette.surface2;
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, cellSize - 1, cellSize - 1);
      }
    }

    // Start/End drawn last, always on top, so they're never obscured by the
    // visited/path overlay even if a solve somehow ran with a stale
    // visualization still showing.
    if (state.start) {
      const cx = state.start.col * cellSize + cellSize / 2;
      const cy = state.start.row * cellSize + cellSize / 2;
      ctx.fillStyle = palette.accent;
      ctx.fillRect(state.start.col * cellSize, state.start.row * cellSize, cellSize, cellSize);
      drawStartIcon(cx, cy, cellSize / 2);
    }
    if (state.end) {
      const cx = state.end.col * cellSize + cellSize / 2;
      const cy = state.end.row * cellSize + cellSize / 2;
      ctx.fillStyle = palette.primary;
      ctx.fillRect(state.end.col * cellSize, state.end.row * cellSize, cellSize, cellSize);
      drawEndIcon(cx, cy, cellSize / 2);
    }
  }

  // -- Status line ----------------------------------------------------------

  function setStatus(text) {
    elements.status.textContent = text;
  }

  // Reflects the current *editing* state (not mid-solve) — called after
  // every edit and after Reset/Clear Path. The mid-solve/solved statuses
  // are set directly by runSolve()/finishSolve() instead, since those don't
  // depend on isReadyToSolve() the way idle editing does.
  function setStatusForEditingState() {
    setStatus(isReadyToSolve(state) ? 'Ready to solve.' : 'Set a start and end cell to solve.');
  }

  // -- Toolbar/button UI sync ------------------------------------------------

  function setToolButtonsUI() {
    const pressedMap = { start: elements.toolButtons.start, end: elements.toolButtons.end, wall: elements.toolButtons.wall, erase: elements.toolButtons.erase };
    Object.keys(pressedMap).forEach((tool) => {
      const button = pressedMap[tool];
      const pressed = activeTool === tool;
      button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
      // aria-pressed already conveys selection to assistive tech (doc's
      // Definition of Done: "conveyed via aria-pressed ... not color alone")
      // — these two classes are the *sighted* echo of the same state, kept
      // in sync from the same boolean rather than a second source of truth.
      button.classList.toggle('bg-primary', pressed);
      button.classList.toggle('text-white', pressed);
      button.classList.toggle('bg-surface', !pressed);
      button.classList.toggle('text-ink', !pressed);
    });
  }

  function setEditingLocked(locked) {
    editingLocked = locked;
    [elements.toolButtons.start, elements.toolButtons.end, elements.toolButtons.wall, elements.toolButtons.erase, elements.resetButton, elements.clearPathButton].forEach((button) => {
      button.disabled = locked;
    });
    updateSolveButtonState();
  }

  function updateSolveButtonState() {
    elements.solveButton.disabled = editingLocked || !isReadyToSolve(state);
  }

  // -- Editing --------------------------------------------------------------

  // Any wall/start/end edit made after a completed solve implicitly clears
  // the stale visited/path overlay (doc's Business Rules: "so a
  // visualization never renders next to walls that no longer produced it").
  // A no-op edit (e.g. clicking End's own cell in Start mode) still calls
  // this — harmless, since clearVisualization() on an already-empty
  // overlay is a no-op itself.
  function clearVisualization() {
    if (visitedCells.length === 0 && pathCells === null) return;
    visitedCells = [];
    pathCells = null;
  }

  function applyToolToCell(row, col) {
    if (editingLocked || !activeTool) return;
    if (activeTool === 'start') state = setStart(state, row, col);
    else if (activeTool === 'end') state = setEnd(state, row, col);
    else if (activeTool === 'wall') state = paintWall(state, row, col);
    else if (activeTool === 'erase') state = eraseWall(state, row, col);
    clearVisualization();
    updateSolveButtonState();
    setStatusForEditingState();
    render();
  }

  function cellFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    // Convert the rendered CSS-pixel position into this canvas's fixed
    // 600×600 coordinate space — the same ratio conversion fishing-game.js's
    // canvasXFromEvent() uses, but never followed by a resize of the
    // intrinsic canvas itself (see file header).
    const x = (cssX / rect.width) * canvas.width;
    const y = (cssY / rect.height) * canvas.height;
    const col = Math.min(COLS - 1, Math.max(0, Math.floor(x / cellSize)));
    const row = Math.min(ROWS - 1, Math.max(0, Math.floor(y / cellSize)));
    return { row, col };
  }

  function onPointerDown(e) {
    if (editingLocked || !activeTool) return;
    canvas.setPointerCapture(e.pointerId);
    const { row, col } = cellFromEvent(e);
    lastDragCellKey = `${row},${col}`;
    // Start/End place once per pointer-down only — a drag must not drop a
    // trail of markers, per the doc's contract for this file. Wall/Erase
    // are drag-painted, so the first cell is applied here too, then every
    // newly entered cell during the drag in onPointerMove.
    isDragging = activeTool === 'wall' || activeTool === 'erase';
    applyToolToCell(row, col);
  }

  function onPointerMove(e) {
    if (!isDragging || editingLocked) return;
    const { row, col } = cellFromEvent(e);
    const key = `${row},${col}`;
    if (key === lastDragCellKey) return;
    lastDragCellKey = key;
    applyToolToCell(row, col);
  }

  function onPointerUp() {
    isDragging = false;
    lastDragCellKey = null;
  }

  // -- Solve ------------------------------------------------------------

  function runSolve() {
    if (editingLocked || !isReadyToSolve(state)) return;
    setEditingLocked(true);
    setStatus('Solving…');

    const result = solveDFS({ rows: ROWS, cols: COLS, walls: state.walls, start: state.start, end: state.end });
    visitedCells = [];
    pathCells = null;
    let revealIndex = 0;

    if (animationTimer !== null) window.clearInterval(animationTimer);
    animationTimer = window.setInterval(() => {
      if (revealIndex >= result.visitOrder.length) {
        window.clearInterval(animationTimer);
        animationTimer = null;
        finishSolve(result);
        return;
      }
      visitedCells.push(result.visitOrder[revealIndex]);
      revealIndex += 1;
      render();
    }, animationIntervalMs);
  }

  function finishSolve(result) {
    if (result.path) {
      pathCells = result.path;
      // Edge count (cells - 1), not cell count — "N steps" reads as "N
      // moves from Start to End", which is one less than the number of
      // cells the path visits (Start itself isn't a step).
      const steps = Math.max(0, result.path.length - 1);
      setStatus(`Path found — ${steps} step${steps === 1 ? '' : 's'}.`);
    } else {
      setStatus('No path found — End is unreachable.');
    }
    render();
    setEditingLocked(false);
  }

  // -- Wiring ---------------------------------------------------------

  function selectTool(tool) {
    if (editingLocked) return;
    activeTool = tool;
    setToolButtonsUI();
  }

  elements.toolButtons.start.addEventListener('click', () => selectTool('start'));
  elements.toolButtons.end.addEventListener('click', () => selectTool('end'));
  elements.toolButtons.wall.addEventListener('click', () => selectTool('wall'));
  elements.toolButtons.erase.addEventListener('click', () => selectTool('erase'));

  elements.solveButton.addEventListener('click', runSolve);
  elements.clearPathButton.addEventListener('click', () => {
    if (editingLocked) return;
    clearVisualization();
    render();
  });
  elements.resetButton.addEventListener('click', () => {
    if (editingLocked) return;
    state = resetGrid(state);
    clearVisualization();
    updateSolveButtonState();
    setStatusForEditingState();
    render();
  });

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);

  // Theme reactivity (file header): redraw whenever <html>'s class attribute
  // changes (theme-toggle.js's setTheme() flips .dark/.light there) or the
  // OS-level scheme changes with no cookie/class override yet.
  const themeObserver = new MutationObserver(() => render());
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  const darkMediaQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  if (darkMediaQuery && darkMediaQuery.addEventListener) darkMediaQuery.addEventListener('change', render);

  function teardown() {
    if (animationTimer !== null) {
      window.clearInterval(animationTimer);
      animationTimer = null;
    }
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerUp);
    themeObserver.disconnect();
    if (darkMediaQuery && darkMediaQuery.removeEventListener) darkMediaQuery.removeEventListener('change', render);
    document.body.removeEventListener('htmx:beforeSwap', onBeforeSwap);
    if (teardownActiveInstance === teardown) teardownActiveInstance = null;
  }

  // Same htmx:beforeSwap-on-#main-content-only convention as
  // fishing-game.js's teardown wiring (see that file's extensive comment on
  // why the target check matters) — tears down the animation timer and
  // listeners on real page-level navigation away from /puzzle-solver, not
  // on unrelated local swaps (this page has none of its own, but the guard
  // costs nothing and keeps the pattern identical across every canvas page).
  function onBeforeSwap(e) {
    if (e.target && e.target.id === 'main-content') teardown();
  }
  document.body.addEventListener('htmx:beforeSwap', onBeforeSwap);

  teardownActiveInstance = teardown;

  // Test-only debug hook for e2e/puzzle-solver.spec.js, same convention as
  // fishing-game.js's window.__fishingGameTestHooks: the default
  // animationIntervalMs is tuned for a pleasant real-visitor animation, not
  // for a test suite that needs to assert the *end* state of a solve
  // (doc's Testing Plan) without waiting out a multi-second reveal on a
  // large grid. Left unconditional (no build/env flag) for the same reason
  // fishing-game.js gives: a personal portfolio site with no stakes riding
  // on a harmless no-op-in-production global.
  if (typeof window !== 'undefined') {
    window.__puzzleSolverTestHooks = {
      /** @param {number} ms */
      setAnimationIntervalMs(ms) {
        animationIntervalMs = ms;
      },
    };
  }

  setToolButtonsUI();
  updateSolveButtonState();
  setStatusForEditingState();
  render();

  return teardown;
}

let teardownActiveInstance = null;

// ---------------------------------------------------------------------------
// Auto-bootstrap (browser only) — same convention as fishing-game.js's
// bootstrap(): guarded so importing this module (e.g. `node --check`) never
// touches `document`. init() itself never queries the DOM on its own, so
// this is the only place this file looks elements up by ID.
// ---------------------------------------------------------------------------

function bootstrap() {
  const canvas = document.getElementById('puzzle-canvas');
  if (!canvas) return; // this page isn't mounted — no-op, same convention as fishing-game.js

  const elements = {
    toolButtons: {
      start: document.getElementById('puzzle-tool-start'),
      end: document.getElementById('puzzle-tool-end'),
      wall: document.getElementById('puzzle-tool-wall'),
      erase: document.getElementById('puzzle-tool-erase'),
    },
    solveButton: document.getElementById('puzzle-solve-button'),
    resetButton: document.getElementById('puzzle-reset-button'),
    clearPathButton: document.getElementById('puzzle-clear-path-button'),
    status: document.getElementById('puzzle-status'),
  };

  init(canvas, elements);
}

if (typeof document !== 'undefined') {
  bootstrap();

  // A `<script type="module">`'s top-level code runs at most once per
  // resolved URL for the whole document's lifetime (per spec) — so if the
  // visitor navigates away from /puzzle-solver and back via HTMX later in
  // the same tab, htmx recreates and re-inserts this <script> tag, but the
  // browser does NOT re-execute it, meaning the plain `bootstrap()` call
  // above never fires again and the freshly swapped-in #puzzle-canvas is
  // never wired up (a real bug this shipped with — a revisit left a
  // completely blank, non-interactive canvas). document.body survives every
  // #main-content swap, so registering this listener once, during whichever
  // visit happens to be this file's one-and-only execution, keeps it alive
  // to catch every later swap too. init()'s own teardown-previous-instance
  // guard (see its doc comment) makes calling bootstrap() again here safe
  // even on the very first swap, where this listener and the direct call
  // above can both fire for the same navigation.
  document.body.addEventListener('htmx:afterSwap', (e) => {
    if (e.target && e.target.id === 'main-content') bootstrap();
  });
}
