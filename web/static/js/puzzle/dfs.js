// Pure, DOM-free depth-first-search solver for the Puzzle Solver
// (docs/features/puzzle-solver.md's Business Rules / Validation and Testing
// Plan). No DOM/canvas/timer dependencies, so it can be unit-tested with
// `node --test` and imported unchanged by the canvas game loop
// (puzzle-solver.js), the same "pure logic module" pattern
// web/static/js/fishing/rules.js and web/static/js/cooking/rules.js already
// establish for this codebase's other two mini-games.
//
// Adjacency and explore order are both fixed by the doc, not tunable:
// four orthogonal neighbors only (no diagonals), always attempted in the
// order up, right, down, left. That fixed order is what makes a given grid
// always produce the same `visitOrder`/`path` — the reproducibility the
// doc's animation depends on — so don't reorder DIRS below without updating
// the doc's Business Rules "Adjacency" note too.

/** Production grid size (docs/features/puzzle-solver.md's Scope: "Grid sizes
 * other than 30x30" is out of scope) — solveDFS itself stays general over
 * whatever rows/cols it's given, so tests can exercise smaller grids. */
export const ROWS = 30;
export const COLS = 30;

/**
 * Canonical string key for a cell, used for Sets/Maps of cells throughout
 * this feature (walls, visited, parent pointers) so cell identity is a
 * plain string comparison/hash rather than object identity.
 *
 * @param {number} row
 * @param {number} col
 * @returns {string}
 */
export function cellKey(row, col) {
  return `${row},${col}`;
}

/** Neighbor deltas in the fixed exploration priority: up, right, down, left. */
const DIRS = [
  [-1, 0],
  [0, 1],
  [1, 0],
  [0, -1],
];

/**
 * Iterative, stack-based depth-first search from `start` to `end` over a
 * grid with walls.
 *
 * Algorithm shape (fixed, not an implementation detail — this exact shape
 * is what makes `visitOrder` deterministic and testable): a stack seeded
 * with `start`; on each iteration, pop a cell, and if it hasn't already
 * been marked visited, mark it visited (recording it into `visitOrder`)
 * and push its unvisited, unwalled, in-bounds neighbors. Neighbors are
 * pushed in *reverse* DIRS order (left, down, right, up) so that popping
 * them back off a LIFO stack visits them in the documented priority order
 * (up, right, down, left) — whichever of those is actually available from
 * the current cell. A neighbor's parent is recorded the first time it's
 * discovered (pushed), not when it's popped/visited, which is what lets
 * `path` be reconstructed even though a cell can be pushed more than once
 * before it's actually visited.
 *
 * The search stops the moment `end` is popped and marked visited — cells
 * still sitting on the stack at that point are never visited or added to
 * `visitOrder`, matching "the exact order DFS explores them" rather than
 * every cell DFS merely queued.
 *
 * @param {object} params
 * @param {number} params.rows
 * @param {number} params.cols
 * @param {Set<string>} params.walls - cellKey-encoded wall cells
 * @param {{row: number, col: number}} params.start
 * @param {{row: number, col: number}} params.end
 * @returns {{
 *   visitOrder: Array<{row: number, col: number}>,
 *   path: Array<{row: number, col: number}> | null,
 * }} `path` is `null` when `end` is unreachable; otherwise the Start->End
 *   route, inclusive of both ends, in order from start to end.
 */
export function solveDFS({ rows, cols, walls, start, end }) {
  const startKey = cellKey(start.row, start.col);
  const endKey = cellKey(end.row, end.col);

  const visited = new Set();
  const parent = new Map();
  const visitOrder = [];
  const stack = [start];

  while (stack.length > 0) {
    const current = stack.pop();
    const currentKey = cellKey(current.row, current.col);

    if (visited.has(currentKey)) continue;
    visited.add(currentKey);
    visitOrder.push(current);

    if (currentKey === endKey) break;

    for (let i = DIRS.length - 1; i >= 0; i -= 1) {
      const [dr, dc] = DIRS[i];
      const nRow = current.row + dr;
      const nCol = current.col + dc;

      if (nRow < 0 || nRow >= rows || nCol < 0 || nCol >= cols) continue;

      const nKey = cellKey(nRow, nCol);
      if (walls.has(nKey) || visited.has(nKey)) continue;

      if (!parent.has(nKey)) parent.set(nKey, currentKey);
      stack.push({ row: nRow, col: nCol });
    }
  }

  if (!visited.has(endKey)) {
    return { visitOrder, path: null };
  }

  const path = [];
  let cursorKey = endKey;
  while (cursorKey !== startKey) {
    const [row, col] = cursorKey.split(',').map(Number);
    path.push({ row, col });
    cursorKey = parent.get(cursorKey);
  }
  path.push({ row: start.row, col: start.col });
  path.reverse();

  return { visitOrder, path };
}
