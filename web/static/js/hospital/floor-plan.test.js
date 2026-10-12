import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  buildStations,
  stationAtPoint,
  standoffFor,
  approachPoint,
  clampToCanvas,
  PLAYER_START,
  PLAYER_STOP_MARGIN,
} from './floor-plan.js';

describe('floor plan', () => {
  const stations = buildStations(4);

  test('has every station kind and one bed per index', () => {
    const kinds = new Set(stations.map((s) => s.kind));
    for (const kind of ['office', 'triage-desk', 'med-cabinet', 'operating-room', 'coffee-machine', 'bed']) assert.ok(kinds.has(kind), kind);
    assert.deepEqual(stations.filter((s) => s.kind === 'bed').map((s) => s.bedIndex), [0, 1, 2, 3]);
  });

  test('stations fit on the canvas and never overlap', () => {
    for (const s of stations) {
      assert.ok(s.x - s.w / 2 >= 0 && s.x + s.w / 2 <= CANVAS_WIDTH, s.id);
      assert.ok(s.y - s.h / 2 >= 0 && s.y + s.h / 2 <= CANVAS_HEIGHT, s.id);
    }
    for (let i = 0; i < stations.length; i++) {
      for (let j = i + 1; j < stations.length; j++) {
        const a = stations[i];
        const b = stations[j];
        const overlapX = Math.abs(a.x - b.x) < (a.w + b.w) / 2;
        const overlapY = Math.abs(a.y - b.y) < (a.h + b.h) / 2;
        assert.ok(!(overlapX && overlapY), `${a.id} overlaps ${b.id}`);
      }
    }
  });

  test('the player starts clear of every station', () => {
    assert.equal(stationAtPoint(PLAYER_START.x, PLAYER_START.y, stations), null);
  });

  test('stationAtPoint hits inside a box and misses outside', () => {
    const bed = stations.find((s) => s.id === 'bed-0');
    assert.equal(stationAtPoint(bed.x, bed.y + bed.h / 2 - 1, stations), bed);
    assert.equal(stationAtPoint(bed.x, bed.y + bed.h / 2 + 1, stations), null);
  });

  test('approaching a bed from below stops just under its box', () => {
    const bed = stations.find((s) => s.id === 'bed-2');
    const standoff = standoffFor(bed, bed.x, 560);
    assert.equal(standoff, bed.h / 2 + PLAYER_STOP_MARGIN);
    const stop = approachPoint(bed.x, bed.y, bed.x, 560, standoff);
    assert.equal(stop.x, bed.x);
    assert.equal(stop.y, bed.y + standoff);
  });

  test('approaching from the side uses the half-width', () => {
    const or = stations.find((s) => s.kind === 'operating-room');
    assert.equal(standoffFor(or, or.x - 300, or.y), or.w / 2 + PLAYER_STOP_MARGIN);
  });

  test('a player already in range stays put; clampToCanvas keeps them on screen', () => {
    assert.deepEqual(approachPoint(100, 100, 110, 100, 50), { x: 110, y: 100 });
    assert.deepEqual(clampToCanvas(-50, 9999), { x: 24, y: CANVAS_HEIGHT - 24 });
  });
});
