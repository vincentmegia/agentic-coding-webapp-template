# Feature: Puzzle Solver

## Status

`Shipped` — implemented and verified. `GET /puzzle-solver` renders the real
page (toolbar + 600×600 canvas grid); `web/static/js/puzzle/dfs.js` and
`web/static/js/puzzle/grid-state.js` are pure, DOM-free logic modules
covered by `node --test` unit tests (23 tests, all passing); `web/static/js/
puzzle-solver.js` wires them to the canvas (pointer/touch grid editing,
theme-reactive redraws, the animated DFS reveal); `e2e/puzzle-solver.spec.js`
covers the full user flow (empty-grid load state, Solve-button gating,
toolbar tool switching, a solvable case, a fully-enclosed no-path case,
Reset Grid, a revisit-via-HTMX regression case (below), and a
no-console-errors smoke test) — 16 tests, passing on both Chromium and
WebKit. `/projects` and the landing page's "Selected work" section each
picked up a third card linking into it
(`docs/features/projects.md`, `docs/features/landing-page.md`); the header
nav is untouched, same gradual-rollout pattern the other two games started
with.

`grid-state.js` ended up **immutable** — every function returns a new
`GridState` rather than mutating its input — because that's what this
codebase's actual `fishing/engine-state.js` convention turned out to be
when checked, not the "mutate in place" guess this doc's Business Rules
discussion assumed while it was still `Proposed`. Callers reassign, e.g.
`state = setStart(state, row, col)`.

`puzzle-solver.js` exposes a test-only `window.__puzzleSolverTestHooks
.setAnimationIntervalMs(ms)` hook (mirroring `fishing-game.js`'s equivalent)
so `e2e/puzzle-solver.spec.js` can collapse the per-cell reveal animation
during a solve instead of waiting out several real seconds on a
near-full-grid DFS — the production default interval is untouched and still
just a first-pass "tuned by eye" value, per this doc's earlier note that
speed isn't a user-facing control.

The `/projects` card now has a real screenshot too
(`web/static/images/puzzle/screenshot.png`), same live-Playwright-capture
convention as the other two games: Start/End placed, a hand-built maze
drawn (a fully enclosed 7×6 dead-end pocket with a single doorway, plus a
couple of smaller obstacles further along), solved, then captured — so the
pocket's fully-explored "visited" cells (amber), the maze walls (black),
and the solved path threading out to End (sage, ending at the terracotta
End marker) are all visible at once, clipped to the card's 16:10 aspect
the same way the Fishing Game screenshot's own doc comment describes.

**Later change**: a real, user-reported bug — navigating to `/puzzle-solver`
via the `/projects` "Play now" link, then away, then back again via that
same link within the same browser tab, rendered a completely blank,
non-interactive canvas the second time (gridlines gone, every button
inert). Root cause: `puzzle-solver.js`'s DOM wiring (`bootstrap()`) only
ran from a plain top-level call executed once when the module's code first
ran — but a `<script type="module">`'s top-level code executes at most once
per resolved URL for the whole page's lifetime, by spec. htmx recreates and
re-inserts the `<script>` tag on every HTMX navigation back to the page,
but the browser does not re-execute an already-evaluated module, so that
top-level call never fired again and the freshly swapped-in `#puzzle-canvas`
was left completely unwired. Fixed by also re-running `bootstrap()` from a
persistent `htmx:afterSwap` listener on `document.body` — registered once,
during whichever visit happens to be this file's one actual execution, and
still alive for every later swap since `document.body` survives every
`#main-content` swap (`init()`'s existing tear-down-previous-instance guard
already made re-running `bootstrap()` safe; the fix only needed to make sure
it actually got called again). Covered by a new regression test in
`e2e/puzzle-solver.spec.js` ("revisiting via HTMX after navigating away")
that drives the exact real-world path and asserts genuine interactivity
(not just that the canvas element is present) on the second visit.

This is a **systemic bug in this codebase's `type="module"` +
htmx-navigation pattern, not something specific to this feature** —
`fishing-game.js` and `cooking-game.js` use the exact same bootstrap-once
pattern and were confirmed, while investigating this report, to have the
identical latent bug (their "Start Dive"/equivalent button silently does
nothing on a second HTMX visit in the same tab). It was invisible there
only because their idle start screen is static HTML that still looks
correct even when totally unwired, unlike this feature's canvas, which
draws its entire primary content immediately and so fails loudly. The user
confirmed they wanted both fixed too, so the identical `htmx:afterSwap`
re-bootstrap fix was applied to `fishing-game.js` and `cooking-game.js` in
the same pass, each with its own new regression test
(`e2e/fishing-game.spec.js`'s "revisiting via HTMX after navigating away";
`e2e/projects.spec.js`'s "revisiting Kitchen Shift via HTMX after
navigating away", since no dedicated `e2e/cooking-game.spec.js` exists) —
see those two docs' own "Later change" notes for the full per-game
writeup. Both full suites were re-verified afterward, including
Fishing Game's against a real Postgres instance.

## Summary

A client-side pathfinding visualizer at `/puzzle-solver`: a 30×30 grid where
the visitor marks a single start cell and a single end cell, draws walls
anywhere else on the grid, then clicks "Solve" to watch a depth-first search
explore the grid cell-by-cell and — if reachable — highlight the path it
found from start to end.

## Problem / Motivation

CLAUDE.md's Planned Content names Projects as a place to link out to past
and in-progress work; the site's own two mini-games (Fishing Game, Kitchen
Shift) already establish a pattern of small, playable, canvas-based demos
living directly on the site rather than only linked out to. A pathfinding
visualizer is a classic, self-contained way to show an algorithm working
step by step, and — unlike the other two mini-games — needs no Postgres
table, no score, and no persistence, so it's a much smaller feature to spec
and build while still fitting the same "canvas demo, own URL" shape.

## Scope

**In scope:**

* `GET /puzzle-solver`: a page with a fixed 30×30 canvas grid and a toolbar
  above it (`Start`, `End`, `Wall`, `Erase Wall`, `Solve`, `Reset Grid`).
* Placing exactly one Start cell and one End cell by clicking the grid in
  the corresponding tool mode; placing a new one moves the existing marker
  rather than allowing a second.
* Drawing walls: click-and-drag in `Wall` mode paints wall cells; click-and-
  drag in `Erase Wall` mode clears them. Start/End cells can't be walled
  over (see Business Rules).
* A DFS solve: an iterative, stack-based depth-first search from Start to
  End over the four orthogonal neighbors (no diagonals), animated — cells
  are revealed as "visited" in the order DFS explores them, and once End is
  reached, the traced path from Start to End is highlighted distinctly from
  the rest of the visited cells.
* A "no path found" end state when DFS exhausts every reachable cell without
  reaching End (walls fully enclose it).
* A "Reset Grid" control that clears walls, Start, End, and any
  visualization back to an empty grid.
* A lighter "Clear Path" control that clears only the last solve's
  visited/path visualization, keeping the current walls/Start/End so the
  visitor can tweak walls and re-solve without rebuilding the whole grid.
* Basic keyboard/touch-friendly interaction (tap-to-place, touch-drag to
  paint walls) — no mouse-only requirement.
* A third `/projects` card and a third landing-page "Selected work" card,
  both linking straight into `/puzzle-solver`, matching how Fishing Game and
  Kitchen Shift are listed (`docs/features/projects.md`,
  `docs/features/landing-page.md`).

**Out of scope:**

* Any server-side involvement beyond serving the page — no Postgres table,
  no migration, no leaderboard, no score, no saved runs. This is a fully
  client-side tool; see Data Model.
* Persistence of grid state (walls/Start/End) across page loads —
  `localStorage` or otherwise. A refresh always starts from an empty grid.
* Any algorithm other than DFS — no BFS/Dijkstra/A* comparison mode, no
  algorithm picker. If that's wanted later it's a separate pass on top of
  this doc.
* An adjustable solve-speed control, step/pause/rewind controls, or a
  "shortest path" guarantee — DFS finds *a* path, not the shortest one, and
  this feature doesn't pretend otherwise (see Business Rules).
* Grid sizes other than 30×30, or a resizable/zoomable canvas.
* Header nav integration — reachable at its own URL plus the `/projects`
  and landing-page cards, same gradual-rollout pattern the other two games
  started with (CLAUDE.md's Status note).
* Mobile-specific layout beyond the canvas scaling responsively in its
  existing aspect-ratio wrapper (same technique as Fishing Game/Kitchen
  Shift) — no pinch-zoom/pan for very narrow screens.

---

## User Flow

```text
1. User navigates to /puzzle-solver (via its own URL, the /projects grid,
   or the landing page's "Selected work" section).
2. Page loads: an empty 30×30 grid renders in the canvas, toolbar shows
   Start/End/Wall/Erase Wall/Solve/Reset Grid/Clear Path, with a status line
   ("Set a start and end cell to solve.").
3. User clicks "Start" (tool becomes active/highlighted in the toolbar),
   then clicks a grid cell — that cell becomes the Start marker. Clicking a
   different cell while still in Start mode moves the marker instead of
   adding a second one.
4. User clicks "End" and repeats the same for the End marker (Start and End
   can't land on the same cell — clicking End's cell while in Start mode,
   or vice versa, is a no-op: that click is ignored and the existing
   marker stays exactly where it was).
5. User clicks "Wall", then clicks and drags across the grid — every empty
   cell the drag passes over becomes a wall, live, as the drag happens.
   Dragging back over an already-walled cell during the same drag has no
   effect (it doesn't erase). Start/End cells are skipped by the drag (see
   Business Rules).
6. User clicks "Erase Wall" and drags back over some of those cells to
   clear them, same click-and-drag mechanic in reverse.
7. Once both Start and End are set, "Solve" becomes enabled (it's disabled
   and shows a tooltip/status hint otherwise). User clicks "Solve".
8. Grid editing (Wall/Erase Wall/Start/End tools) is disabled while solving.
   The canvas animates DFS's exploration: each cell DFS visits is revealed
   in a "visited" color, in the exact order the algorithm explores them,
   including cells it later backtracks away from.
9a. If DFS reaches End: the animation pauses briefly, then the traced
    Start→End path is redrawn in a distinct "path" color/style over the
    visited cells, and the status line reports success (e.g. "Path found —
    47 steps.").
9b. If DFS exhausts the stack without reaching End: every reachable cell
    ends up shown as visited, no path is drawn, and the status line reports
    "No path found — End is unreachable."
10. After a solve (either outcome), grid editing re-enables. User can click
    "Clear Path" to wipe the visited/path overlay and solve again with the
    same walls/Start/End, click "Reset Grid" to start over from empty, or
    directly start editing walls again (which implicitly clears the stale
    overlay the same way "Clear Path" does, since an old visualization next
    to freshly edited walls would be misleading).
```

---

## Visual Direction

Follows `tailwind-ui`'s Visual Style principles (warm cream ground,
terracotta/sage accents, Caprasimo + Figtree); specifics for this feature:

* The grid canvas uses the site's own light/dark-aware "Organic" tokens
  rather than a fixed scene palette — unlike Fishing Game's ocean or Kitchen
  Shift's floor plan, there's no "scene" here to commit to one look for; a
  grid of flat colored cells reads fine in both themes, so (unlike those two
  games) this canvas *does* follow the site's dark-mode toggle.
* **Empty cell**: `bg-surface` fill with a thin `bg-surface-2` gridline
  border, so the grid reads as a grid at a glance.
  * **Wall cell**: solid dark/umber fill, visually "solid" and distinct
    from every other cell state.
* **Start cell**: sage-tinted fill with a small flag or play-triangle icon.
* **End cell**: terracotta-tinted fill with a small flag or target icon.
* **Visited cell** (during/after a solve): a light amber/gold fade-in,
  applied in explore order to sell the step-by-step animation.
* **Path cell** (post-solve, Start→End route only): solid sage fill with a
  slightly thicker cell border, layered over the visited color so the path
  is legible on top of the amber trail rather than replacing it.
* Canvas is a fixed intrinsic 600×600 (20px per cell, 30 cells), styled
  responsively inside an `aspect-[1/1]` wrapper the same way Fishing
  Game/Kitchen Shift scale their fixed-size canvases
  (`docs/features/fishing-game.md`'s canvas `width`/`height` attribute
  note).

---

## UI

```text
web/templates/pages/
└── puzzle-solver.html        # toolbar + canvas shell

web/static/js/
├── puzzle-solver.js          # entry point: canvas draw loop, input handling, DOM/toolbar wiring
└── puzzle/
    ├── dfs.js                # pure: iterative DFS over a grid → {visitOrder, path | null}
    ├── dfs.test.js
    ├── grid-state.js         # pure: wall/start/end mutation + validation helpers
    └── grid-state.test.js
```

States this feature's UI must handle:

| State                          | Behavior |
| ------------------------------- | -------- |
| Empty grid                      | No Start/End/walls; Solve disabled. |
| Editing (Start/End/Wall/Erase)  | Active tool highlighted in toolbar; grid updates live on click/drag. |
| Ready to solve                  | Both Start and End set; Solve enabled. |
| Solving (animating)             | Grid editing tools disabled; visited cells reveal in explore order. |
| Solved — path found             | Path highlighted over visited cells; status line shows step count. |
| Solved — no path found          | All reachable cells shown visited; status line reports unreachable. |
| Reset                           | "Reset Grid" returns to the Empty grid state. |

---

## HTMX Interactions

None. This page is a single full load with no partial-page HTMX fragments —
every interaction (tool selection, wall drawing, solving) is pure
client-side canvas/JS state, same as the core play loop of Fishing
Game/Kitchen Shift. The only HTMX involved is the standard in-site nav link
*to* `/puzzle-solver` from `/projects` and the landing page, per
`docs/features/home.md`'s existing nav conventions.

---

## Routes / Handlers

| Method | Path             | Handler                  | Auth required | Notes |
| ------ | ---------------- | ------------------------- | ------------- | ----- |
| GET    | `/puzzle-solver` | `PagesHandler.PuzzleSolver` | no          | Renders the static page shell; no service/repository layer needed since there's no server-side state. |

---

## Data Model

None. No new tables, no migration — this feature has no server-side state to
persist (see Scope's Out of scope).

---

## Business Rules / Validation

* **Adjacency**: DFS moves only to the four orthogonal neighbors (up,
  right, down, left) of the current cell — no diagonal movement. Neighbors
  are visited in a fixed order (up, right, down, left) so the same grid
  always produces the same explore order and path; this determinism is
  what makes the animation reproducible, not an implementation detail to
  hide.
* **DFS finds *a* path, not the shortest one.** The status line and any
  copy on the page should not imply optimality — this is a demonstration of
  how DFS explores, not a shortest-path tool. (BFS/Dijkstra/A* are
  explicitly out of scope, not "coming later" — see Scope.)
* **Start/End cannot be walled.** The Wall-mode drag skips any cell that is
  currently Start or End; placing a new Start/End on a cell that currently
  holds a wall clears that wall as part of placing the marker.
* **Start and End cannot occupy the same cell.** Clicking a cell that
  already holds the *other* marker while in Start or End mode is a no-op —
  it does not move, delete, or overwrite that other marker.
* **Solve requires both Start and End set.** The Solve button is disabled
  (not merely a no-op) until both exist.
* **Grid is locked during the solve animation.** Wall/Erase Wall/Start/End
  tools are disabled while a solve is animating, re-enabled once it
  finishes (path found or exhausted).
* **Editing walls after a solve implicitly clears the stale
  visited/path overlay** — same effect as clicking "Clear Path" — so a
  visualization never renders next to walls that no longer produced it.

---

## Security Considerations

* **Authz**: none — public page, no auth, no destructive server-side
  action (there is no server-side state at all).
* **Destructive actions**: "Reset Grid" clears local canvas/JS state only;
  nothing to confirm since nothing persists past the page.
* **Input handling**: no server input at all — page is static HTML/JS/CSS.
* **Secrets**: none introduced.

---

## Testing Plan

* `dfs.js` unit tests (`node --test`, matching the `rules.js` convention in
  `web/static/js/fishing/`, `web/static/js/cooking/`): solvable grid
  returns a path connecting Start→End via only orthogonal steps; grid fully
  enclosing End returns no path; deterministic explore order given a fixed
  neighbor-visit order; Start-adjacent-to-End trivial case; Start-equals-
  End edge case if reachable via the UI at all (should be prevented per
  Business Rules, but the pure function should still handle it sanely).
* `grid-state.js` unit tests: wall drag skips Start/End cells; placing
  Start/End clears a wall at that cell; Reset clears every piece of state;
  Clear Path clears only visited/path, not walls/Start/End.
* Playwright e2e (`e2e/puzzle-solver.spec.js`, Chromium + WebKit): place
  Start and End, draw a wall, run Solve, assert the path/visited cells
  render and the status line reflects success; build a fully enclosing wall
  around End and assert the "no path found" status line.
* `internal/handler/template_test.go`-style Go test asserting `GET
  /puzzle-solver` renders 200 with the expected content template, mirroring
  the other pages' route tests.

---

## Definition of Done

* [ ] User flow works end-to-end, including edge cases above (no path
      found, Start/End click-on-other-marker no-op, wall-through-marker
      prevention).
* [ ] All states in the UI table are implemented.
* [ ] `GET /puzzle-solver` wired into the mux, `/projects`, and the landing
      page's Selected work section.
* [ ] Handler/service/repository boundaries followed where they apply
      (`go-backend`) — here, effectively just the handler, since there's no
      service/repository layer.
* [ ] Accessibility checked (keyboard reachability of toolbar controls,
      focus states, contrast of cell-state colors, semantic HTML for the
      toolbar/status line — the canvas itself is inherently non-semantic,
      same accepted tradeoff as the other two canvas games).
* [ ] Tests cover the behavior in the Testing Plan above.
