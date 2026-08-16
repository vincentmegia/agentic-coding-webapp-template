import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStations,
  stationAtPoint,
  approachPoint,
  clampToCanvas,
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  STATION_BOX_SIZE,
  TABLE_BOX_SIZE,
} from './floor-plan.js';

const TABLE_IDS = Array.from({ length: 30 }, (_, i) => i + 1);

describe('buildStations', () => {
  test('includes one entry per fixed station plus one per table id', () => {
    const stations = buildStations(TABLE_IDS);
    const kinds = stations.map((s) => s.kind);
    for (const kind of ['fridge', 'cabinet', 'cleaning-closet', 'cookware-closet', 'stove', 'oven', 'counter', 'coffee-machine', 'boss-office']) {
      assert.ok(kinds.includes(kind), `missing station kind ${kind}`);
    }
    assert.equal(stations.filter((s) => s.kind === 'table').length, TABLE_IDS.length);
  });

  test('every table gets a distinct position', () => {
    const stations = buildStations(TABLE_IDS);
    const tables = stations.filter((s) => s.kind === 'table');
    const positions = new Set(tables.map((t) => `${t.x},${t.y}`));
    assert.equal(positions.size, tables.length);
  });

  test('every station stays within the canvas bounds', () => {
    const stations = buildStations(TABLE_IDS);
    for (const s of stations) {
      const half = s.size / 2;
      assert.ok(s.x - half >= 0 && s.x + half <= CANVAS_WIDTH, `${s.id} out of horizontal bounds`);
      assert.ok(s.y - half >= 0 && s.y + half <= CANVAS_HEIGHT, `${s.id} out of vertical bounds`);
    }
  });
});

describe('stationAtPoint', () => {
  const stations = [
    { id: 'a', x: 100, y: 100, size: 50 },
    { id: 'b', x: 300, y: 100, size: 50 },
  ];

  test('finds the station whose box contains the point', () => {
    assert.equal(stationAtPoint(100, 100, stations).id, 'a');
    assert.equal(stationAtPoint(90, 110, stations).id, 'a');
  });

  test('returns null when the point is over no station', () => {
    assert.equal(stationAtPoint(200, 100, stations), null);
  });

  test('a point exactly on the box edge counts as a hit', () => {
    // box half-size is 25, so (125, 100) is exactly the right edge of station "a".
    assert.equal(stationAtPoint(125, 100, stations).id, 'a');
  });

  test('a point just past the box edge is a miss', () => {
    assert.equal(stationAtPoint(125.5, 100, stations), null);
  });

  test('boxes for different-sized stations (table vs door fixture) both hit-test correctly', () => {
    const mixed = [
      { id: 'table-1', kind: 'table', x: 0, y: 0, size: TABLE_BOX_SIZE },
      { id: 'fridge', kind: 'fridge', x: 500, y: 0, size: STATION_BOX_SIZE },
    ];
    assert.equal(stationAtPoint(TABLE_BOX_SIZE / 2 - 1, 0, mixed).id, 'table-1');
    assert.equal(stationAtPoint(500 + STATION_BOX_SIZE / 2 - 1, 0, mixed).id, 'fridge');
  });
});

describe('approachPoint', () => {
  test('stops standoffDistance away from the station, along the line toward the player', () => {
    // Player is due east of the station; approach point should also be due east.
    const point = approachPoint(0, 0, 100, 0, 30);
    assert.equal(point.y, 0);
    assert.ok(Math.abs(point.x - 30) < 1e-9);
  });

  test('if the player is already within standoffDistance, they do not move', () => {
    const point = approachPoint(0, 0, 10, 0, 30);
    assert.deepEqual(point, { x: 10, y: 0 });
  });

  test('approaches from whichever side the player currently stands on', () => {
    const fromWest = approachPoint(0, 0, -100, 0, 30);
    assert.ok(fromWest.x < 0);
    const fromNorth = approachPoint(0, 0, 0, -100, 30);
    assert.ok(fromNorth.y < 0);
  });

  test('the returned point is always exactly standoffDistance from the station when outside it', () => {
    const point = approachPoint(50, 50, 200, 300, 40);
    const dist = Math.hypot(point.x - 50, point.y - 50);
    assert.ok(Math.abs(dist - 40) < 1e-9);
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

  test('clamps an out-of-bounds position down to canvas size minus the margin, per axis', () => {
    const { x, y } = clampToCanvas(CANVAS_WIDTH + 50, CANVAS_HEIGHT + 50, 16);
    assert.equal(x, CANVAS_WIDTH - 16);
    assert.equal(y, CANVAS_HEIGHT - 16);
  });
});
