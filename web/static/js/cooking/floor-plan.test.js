import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStations,
  stationsInRange,
  nearestStation,
  clampToCanvas,
  INTERACTION_RADIUS,
  CANVAS_SIZE,
} from './floor-plan.js';

const TABLE_IDS = [1, 2, 3, 4];

describe('buildStations', () => {
  test('includes one entry per fixed station plus one per table id', () => {
    const stations = buildStations(TABLE_IDS);
    const kinds = stations.map((s) => s.kind);
    for (const kind of ['fridge', 'cabinet', 'stove', 'oven', 'sink', 'shutdown', 'boss-office']) {
      assert.ok(kinds.includes(kind), `missing station kind ${kind}`);
    }
    assert.equal(stations.filter((s) => s.kind === 'table').length, TABLE_IDS.length);
  });
});

describe('stationsInRange / nearestStation', () => {
  const stations = [
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 100, y: 0 },
  ];

  test('reports a station in range when the player stands on top of it', () => {
    const inRange = stationsInRange(0, 0, stations);
    assert.equal(inRange.length, 1);
    assert.equal(inRange[0].id, 'a');
  });

  test('reports no stations in range when the player is far from all of them', () => {
    const inRange = stationsInRange(500, 500, stations);
    assert.equal(inRange.length, 0);
    assert.equal(nearestStation(500, 500, stations), null);
  });

  test('a station exactly at the interaction radius boundary counts as in range', () => {
    const boundaryStations = [{ id: 'a', x: INTERACTION_RADIUS, y: 0 }];
    const inRange = stationsInRange(0, 0, boundaryStations);
    assert.equal(inRange.length, 1);
  });

  test('a station just past the interaction radius is out of range', () => {
    const justPast = [{ id: 'a', x: INTERACTION_RADIUS + 0.5, y: 0 }];
    assert.equal(stationsInRange(0, 0, justPast).length, 0);
  });

  test('nearestStation returns the closest of several in-range stations', () => {
    const close = [
      { id: 'far', x: 30, y: 0 },
      { id: 'near', x: 10, y: 0 },
    ];
    const nearest = nearestStation(0, 0, close);
    assert.equal(nearest.id, 'near');
  });

  test('an exact-distance tie resolves deterministically to the earlier input entry', () => {
    const tied = [
      { id: 'first', x: 10, y: 0 },
      { id: 'second', x: -10, y: 0 },
    ];
    const nearest = nearestStation(0, 0, tied);
    assert.equal(nearest.id, 'first');
  });
});

describe('clampToCanvas', () => {
  test('leaves an in-bounds position unchanged', () => {
    const { x, y } = clampToCanvas(200, 200);
    assert.equal(x, 200);
    assert.equal(y, 200);
  });

  test('clamps a negative position up to the margin', () => {
    const { x, y } = clampToCanvas(-50, -50, 16);
    assert.equal(x, 16);
    assert.equal(y, 16);
  });

  test('clamps an out-of-bounds position down to canvas size minus the margin', () => {
    const { x, y } = clampToCanvas(CANVAS_SIZE + 50, CANVAS_SIZE + 50, 16);
    assert.equal(x, CANVAS_SIZE - 16);
    assert.equal(y, CANVAS_SIZE - 16);
  });
});
