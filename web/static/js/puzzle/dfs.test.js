import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { solveDFS, cellKey, ROWS, COLS } from './dfs.js';

function walk(cells) {
  // Asserts every consecutive pair in `cells` is an orthogonal single step.
  for (let i = 1; i < cells.length; i += 1) {
    const a = cells[i - 1];
    const b = cells[i];
    const dist = Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
    assert.equal(dist, 1, `step ${i} (${JSON.stringify(a)} -> ${JSON.stringify(b)}) is not an orthogonal single step`);
  }
}

describe('cellKey', () => {
  test('encodes row,col as a plain string', () => {
    assert.equal(cellKey(0, 0), '0,0');
    assert.equal(cellKey(3, 12), '3,12');
  });
});

describe('solveDFS', () => {
  test('exports the production grid size constants', () => {
    assert.equal(ROWS, 30);
    assert.equal(COLS, 30);
  });

  test('finds a path on an open grid, connecting start to end via orthogonal steps only', () => {
    const { path } = solveDFS({
      rows: 5,
      cols: 5,
      walls: new Set(),
      start: { row: 0, col: 0 },
      end: { row: 4, col: 4 },
    });

    assert.ok(path);
    assert.deepEqual(path[0], { row: 0, col: 0 });
    assert.deepEqual(path[path.length - 1], { row: 4, col: 4 });
    walk(path);
  });

  test('trivial case: start adjacent to end', () => {
    // End is immediately to the "right" of Start, but DFS's fixed priority
    // explores "up" first — so it wanders up through (0,1)/(0,2) before
    // landing on End, illustrating the doc's "DFS finds *a* path, not the
    // shortest one" rule. `path`, though, is reconstructed from each
    // cell's *first-discovery* parent, and End's right-neighbor edge from
    // Start was recorded the moment Start was first expanded — before the
    // up branch ever ran — so the reconstructed path still shortcuts
    // straight there even though `visitOrder` visibly wandered first.
    const { path, visitOrder } = solveDFS({
      rows: 3,
      cols: 3,
      walls: new Set(),
      start: { row: 1, col: 1 },
      end: { row: 1, col: 2 },
    });

    assert.deepEqual(path, [{ row: 1, col: 1 }, { row: 1, col: 2 }]);
    assert.deepEqual(visitOrder, [
      { row: 1, col: 1 },
      { row: 0, col: 1 },
      { row: 0, col: 2 },
      { row: 1, col: 2 },
    ]);
  });

  test('trivial case: start equals end', () => {
    const { path, visitOrder } = solveDFS({
      rows: 3,
      cols: 3,
      walls: new Set(),
      start: { row: 1, col: 1 },
      end: { row: 1, col: 1 },
    });

    assert.deepEqual(path, [{ row: 1, col: 1 }]);
    assert.deepEqual(visitOrder, [{ row: 1, col: 1 }]);
  });

  test('returns path: null and a visitOrder covering every reachable cell when end is fully enclosed', () => {
    // 3x3 grid; wall off every neighbor of the center cell (1,1) so it's
    // unreachable from the corner start.
    const walls = new Set([cellKey(0, 1), cellKey(1, 0), cellKey(1, 2), cellKey(2, 1)]);
    const { path, visitOrder } = solveDFS({
      rows: 3,
      cols: 3,
      walls,
      start: { row: 0, col: 0 },
      end: { row: 1, col: 1 },
    });

    assert.equal(path, null);
    // Reachable region from (0,0) excludes the walled-off center and
    // everything beyond it: (0,0),(0,2),(2,0),(2,2) are isolated from
    // (0,0) too since every path must cross a walled cell adjacent to the
    // center — only (0,0) itself remains reachable.
    assert.deepEqual(visitOrder, [{ row: 0, col: 0 }]);
  });

  test('deterministic explore order given the fixed up, right, down, left priority', () => {
    // Open 3x3 grid, start at the center so all four directions are
    // available and their priority order is exactly observable.
    const { visitOrder } = solveDFS({
      rows: 3,
      cols: 3,
      walls: new Set(),
      start: { row: 1, col: 1 },
      end: { row: -1, col: -1 }, // unreachable sentinel: exhaust the whole search
    });

    // From (1,1): up=(0,1), right=(1,2), down=(2,1), left=(1,0).
    // DFS explores "up" first, then recurses into (0,1)'s own up/right/
    // down/left before ever returning to (1,1)'s remaining right/down/left
    // branches — this exact sequence is the deterministic contract under
    // test, not merely "all 9 cells visited".
    assert.deepEqual(visitOrder, [
      { row: 1, col: 1 },
      { row: 0, col: 1 },
      { row: 0, col: 2 },
      { row: 1, col: 2 },
      { row: 2, col: 2 },
      { row: 2, col: 1 },
      { row: 2, col: 0 },
      { row: 1, col: 0 },
      { row: 0, col: 0 },
    ]);
  });

  test('never steps onto a wall cell', () => {
    // Wall off the center only, forcing any start->end path around the
    // edge rather than blocking it outright (blocking both of (0,0)'s only
    // two in-bounds neighbors would isolate it entirely, which is a
    // different case already covered above).
    const walls = new Set([cellKey(1, 1)]);
    const { path } = solveDFS({
      rows: 3,
      cols: 3,
      walls,
      start: { row: 0, col: 0 },
      end: { row: 2, col: 2 },
    });

    assert.ok(path);
    path.forEach((cell) => {
      assert.equal(walls.has(cellKey(cell.row, cell.col)), false);
    });
  });
});
