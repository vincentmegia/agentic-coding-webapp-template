// Pure, DOM-free grid-editing state management for the Puzzle Solver
// (docs/features/puzzle-solver.md's Business Rules / Validation and Testing
// Plan). Mirrors fishing/engine-state.js's contract: no DOM/canvas/timer
// dependencies, unit-tested with `node --test`, and imported unchanged by
// puzzle-solver.js's toolbar/input handling. Every function here is pure —
// it returns a *new* GridState object and never mutates the one passed in
// — the same convention fishing/engine-state.js's applyHazardHit/
// applyFishCatch/advance already use, so callers can freely diff/undo/log
// states without worrying about aliasing.
//
// State shape (`GridState`):
//   {
//     rows: number,
//     cols: number,
//     walls: Set<string>,             // cellKey-encoded wall cells (dfs.js's cellKey)
//     start: {row, col} | null,
//     end: {row, col} | null,
//   }

import { ROWS, COLS, cellKey } from './dfs.js';

/**
 * Builds a fresh, empty grid state: no walls, no Start/End.
 *
 * @param {number} [rows]
 * @param {number} [cols]
 * @returns {GridState}
 */
export function createGridState(rows = ROWS, cols = COLS) {
  return {
    rows,
    cols,
    walls: new Set(),
    start: null,
    end: null,
  };
}

function sameCell(a, b) {
  return !!a && !!b && a.row === b.row && a.col === b.col;
}

/**
 * Places Start at (row, col). No-op (returns `state` unchanged) if that
 * cell currently holds End — per the doc's Business Rules ("Start and End
 * cannot occupy the same cell"), that click is ignored rather than moving
 * or deleting End. Otherwise moves Start there and clears any wall
 * occupying that cell (doc: "placing a new Start/End on a cell that
 * currently holds a wall clears that wall as part of placing the marker").
 *
 * @param {GridState} state
 * @param {number} row
 * @param {number} col
 * @returns {GridState}
 */
export function setStart(state, row, col) {
  if (sameCell(state.end, { row, col })) return state;

  const walls = new Set(state.walls);
  walls.delete(cellKey(row, col));

  return { ...state, walls, start: { row, col } };
}

/**
 * Places End at (row, col). Symmetric to `setStart` — see its doc comment.
 *
 * @param {GridState} state
 * @param {number} row
 * @param {number} col
 * @returns {GridState}
 */
export function setEnd(state, row, col) {
  if (sameCell(state.start, { row, col })) return state;

  const walls = new Set(state.walls);
  walls.delete(cellKey(row, col));

  return { ...state, walls, end: { row, col } };
}

/**
 * Adds a wall at (row, col). No-op if that cell currently holds Start or
 * End (doc: "Start/End cannot be walled — the Wall-mode drag skips any
 * cell that is currently Start or End").
 *
 * @param {GridState} state
 * @param {number} row
 * @param {number} col
 * @returns {GridState}
 */
export function paintWall(state, row, col) {
  if (sameCell(state.start, { row, col }) || sameCell(state.end, { row, col })) {
    return state;
  }

  const walls = new Set(state.walls);
  walls.add(cellKey(row, col));

  return { ...state, walls };
}

/**
 * Removes a wall at (row, col), if present. No-op if that cell isn't
 * currently a wall.
 *
 * @param {GridState} state
 * @param {number} row
 * @param {number} col
 * @returns {GridState}
 */
export function eraseWall(state, row, col) {
  const key = cellKey(row, col);
  if (!state.walls.has(key)) return state;

  const walls = new Set(state.walls);
  walls.delete(key);

  return { ...state, walls };
}

/**
 * Clears walls and Start/End back to an empty grid, keeping the current
 * `rows`/`cols` (docs/features/puzzle-solver.md's "Reset Grid" control).
 *
 * @param {GridState} state
 * @returns {GridState}
 */
export function resetGrid(state) {
  return createGridState(state.rows, state.cols);
}

/**
 * True iff both Start and End are set — the doc's precondition for
 * enabling the Solve button ("Solve requires both Start and End set").
 *
 * @param {GridState} state
 * @returns {boolean}
 */
export function isReadyToSolve(state) {
  return !!state.start && !!state.end;
}
