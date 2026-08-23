import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createGridState,
  setStart,
  setEnd,
  paintWall,
  eraseWall,
  resetGrid,
  isReadyToSolve,
} from './grid-state.js';
import { cellKey } from './dfs.js';

describe('createGridState', () => {
  test('starts empty: no walls, no Start/End', () => {
    const state = createGridState(5, 5);
    assert.equal(state.rows, 5);
    assert.equal(state.cols, 5);
    assert.equal(state.walls.size, 0);
    assert.equal(state.start, null);
    assert.equal(state.end, null);
  });

  test('defaults to the production 30x30 size', () => {
    const state = createGridState();
    assert.equal(state.rows, 30);
    assert.equal(state.cols, 30);
  });
});

describe('setStart / setEnd', () => {
  test('setStart places Start and moves it on a later call', () => {
    let state = createGridState(5, 5);
    state = setStart(state, 1, 1);
    assert.deepEqual(state.start, { row: 1, col: 1 });

    state = setStart(state, 2, 2);
    assert.deepEqual(state.start, { row: 2, col: 2 });
  });

  test('setStart is a no-op when targeting the cell End currently occupies', () => {
    let state = createGridState(5, 5);
    state = setEnd(state, 3, 3);
    const before = state;

    state = setStart(state, 3, 3);
    assert.equal(state, before); // unchanged (same reference), not just deep-equal
    assert.equal(state.start, null);
  });

  test('setEnd is a no-op when targeting the cell Start currently occupies', () => {
    let state = createGridState(5, 5);
    state = setStart(state, 1, 1);
    const before = state;

    state = setEnd(state, 1, 1);
    assert.equal(state, before);
    assert.equal(state.end, null);
  });

  test('setStart clears a wall sitting at the target cell', () => {
    let state = createGridState(5, 5);
    state = paintWall(state, 2, 2);
    assert.ok(state.walls.has(cellKey(2, 2)));

    state = setStart(state, 2, 2);
    assert.equal(state.walls.has(cellKey(2, 2)), false);
    assert.deepEqual(state.start, { row: 2, col: 2 });
  });

  test('setEnd clears a wall sitting at the target cell', () => {
    let state = createGridState(5, 5);
    state = paintWall(state, 4, 4);
    state = setEnd(state, 4, 4);
    assert.equal(state.walls.has(cellKey(4, 4)), false);
    assert.deepEqual(state.end, { row: 4, col: 4 });
  });

  test('functions never mutate the state object passed in', () => {
    const state = createGridState(5, 5);
    const wallsBefore = state.walls;
    setStart(state, 0, 0);
    assert.equal(state.start, null);
    assert.equal(state.walls, wallsBefore);
  });
});

describe('paintWall / eraseWall', () => {
  test('paintWall adds a wall cell', () => {
    let state = createGridState(5, 5);
    state = paintWall(state, 1, 2);
    assert.ok(state.walls.has(cellKey(1, 2)));
  });

  test('paintWall is a no-op on the Start cell', () => {
    let state = createGridState(5, 5);
    state = setStart(state, 1, 1);
    const before = state;

    state = paintWall(state, 1, 1);
    assert.equal(state, before);
    assert.equal(state.walls.size, 0);
  });

  test('paintWall is a no-op on the End cell', () => {
    let state = createGridState(5, 5);
    state = setEnd(state, 3, 3);
    const before = state;

    state = paintWall(state, 3, 3);
    assert.equal(state, before);
    assert.equal(state.walls.size, 0);
  });

  test('eraseWall removes a wall cell', () => {
    let state = createGridState(5, 5);
    state = paintWall(state, 1, 2);
    state = eraseWall(state, 1, 2);
    assert.equal(state.walls.has(cellKey(1, 2)), false);
  });

  test('eraseWall is a no-op when the cell has no wall', () => {
    const state = createGridState(5, 5);
    const result = eraseWall(state, 1, 2);
    assert.equal(result, state);
  });
});

describe('resetGrid', () => {
  test('clears walls and Start/End back to createGridState\'s empty shape', () => {
    let state = createGridState(5, 5);
    state = setStart(state, 0, 0);
    state = setEnd(state, 4, 4);
    state = paintWall(state, 2, 2);

    state = resetGrid(state);
    assert.equal(state.walls.size, 0);
    assert.equal(state.start, null);
    assert.equal(state.end, null);
    assert.equal(state.rows, 5);
    assert.equal(state.cols, 5);
  });
});

describe('isReadyToSolve', () => {
  test('false until both Start and End are set', () => {
    let state = createGridState(5, 5);
    assert.equal(isReadyToSolve(state), false);

    state = setStart(state, 0, 0);
    assert.equal(isReadyToSolve(state), false);

    state = setEnd(state, 4, 4);
    assert.equal(isReadyToSolve(state), true);
  });
});
