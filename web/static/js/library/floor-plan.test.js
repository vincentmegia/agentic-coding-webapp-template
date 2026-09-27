import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStations,
  stationsOnFloor,
  stationAtPoint,
  approachPoint,
  clampToCanvas,
  entryPointForFloor,
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  STATION_BOX_SIZE,
  FLOOR_1,
  FLOOR_2,
  FLOOR_1_ENTRY_POINT,
  FLOOR_2_ENTRY_POINT,
} from './floor-plan.js';
import { GENRES } from './rules.js';

describe('buildStations', () => {
  test('includes every fixed station kind', () => {
    const stations = buildStations(GENRES);
    const kinds = stations.map((s) => s.kind);
    for (const kind of ['front-desk', 'return-cart', 'fines-counter', 'coffee-machine', 'boss-office', 'stairs', 'elevator', 'bookshelf']) {
      assert.ok(kinds.includes(kind), `missing station kind ${kind}`);
    }
  });

  test('one bookshelf per genre, no more, no less', () => {
    const stations = buildStations(GENRES);
    const shelves = stations.filter((s) => s.kind === 'bookshelf');
    assert.equal(shelves.length, GENRES.length);
    const genreIds = shelves.map((s) => s.genreId).sort();
    assert.deepEqual(genreIds, GENRES.map((g) => g.id).sort());
  });

  test('every station stays within the canvas bounds', () => {
    const stations = buildStations(GENRES);
    for (const s of stations) {
      const half = s.size / 2;
      assert.ok(s.x - half >= 0 && s.x + half <= CANVAS_WIDTH, `${s.id} out of horizontal bounds`);
      assert.ok(s.y - half >= 0 && s.y + half <= CANVAS_HEIGHT, `${s.id} out of vertical bounds`);
    }
  });

  test('every station has a floor tag of either FLOOR_1 or FLOOR_2', () => {
    const stations = buildStations(GENRES);
    for (const s of stations) {
      assert.ok(s.floor === FLOOR_1 || s.floor === FLOOR_2, `${s.id} has no valid floor tag`);
    }
  });

  test('front desk, return cart, fines counter, coffee machine, and boss office are all on 1st Floor', () => {
    const stations = buildStations(GENRES);
    const byId = Object.fromEntries(stations.map((s) => [s.id, s]));
    for (const id of ['front-desk', 'return-cart', 'fines-counter', 'coffee-machine', 'boss-office']) {
      assert.equal(byId[id].floor, FLOOR_1, `${id} should be on 1st Floor`);
    }
  });

  test('every floor has both a stairs and an elevator station, each pointing to the other floor', () => {
    const stations = buildStations(GENRES);
    for (const floor of [FLOOR_1, FLOOR_2]) {
      const onFloor = stationsOnFloor(stations, floor);
      const stairs = onFloor.find((s) => s.kind === 'stairs');
      const elevator = onFloor.find((s) => s.kind === 'elevator');
      const other = floor === FLOOR_1 ? FLOOR_2 : FLOOR_1;
      assert.ok(stairs, `floor ${floor} missing stairs`);
      assert.ok(elevator, `floor ${floor} missing elevator`);
      assert.equal(stairs.targetFloor, other);
      assert.equal(elevator.targetFloor, other);
    }
  });

  test('stairs and elevator are visually distinguishable (different positions)', () => {
    const stations = buildStations(GENRES);
    const floor1 = stationsOnFloor(stations, FLOOR_1);
    const stairs = floor1.find((s) => s.kind === 'stairs');
    const elevator = floor1.find((s) => s.kind === 'elevator');
    assert.notEqual(`${stairs.x},${stairs.y}`, `${elevator.x},${elevator.y}`);
  });

  test('2nd Floor has no front-desk/fines-counter/coffee-machine/boss-office (bookshelves only, plus stairs/elevator)', () => {
    const stations = buildStations(GENRES);
    const floor2Kinds = new Set(stationsOnFloor(stations, FLOOR_2).map((s) => s.kind));
    for (const kind of ['front-desk', 'return-cart', 'fines-counter', 'coffee-machine', 'boss-office']) {
      assert.ok(!floor2Kinds.has(kind), `2nd Floor should not have ${kind}`);
    }
  });

  test('every station gets a distinct position within its own floor', () => {
    const stations = buildStations(GENRES);
    for (const floor of [FLOOR_1, FLOOR_2]) {
      const onFloor = stationsOnFloor(stations, floor);
      const positions = new Set(onFloor.map((s) => `${s.x},${s.y}`));
      assert.equal(positions.size, onFloor.length, `floor ${floor} has overlapping stations`);
    }
  });
});

describe('stationsOnFloor', () => {
  test('filters down to only the stations on the given floor', () => {
    const stations = buildStations(GENRES);
    const floor1 = stationsOnFloor(stations, FLOOR_1);
    const floor2 = stationsOnFloor(stations, FLOOR_2);
    assert.ok(floor1.every((s) => s.floor === FLOOR_1));
    assert.ok(floor2.every((s) => s.floor === FLOOR_2));
    assert.equal(floor1.length + floor2.length, stations.length);
  });

  test('returns an empty list for a floor with no stations', () => {
    const stations = [{ id: 'a', floor: FLOOR_1 }];
    assert.deepEqual(stationsOnFloor(stations, FLOOR_2), []);
  });
});

describe('stationAtPoint', () => {
  const stations = [{ id: 'front-desk', x: 100, y: 100, size: 80 }];

  test('finds a station whose box contains the point', () => {
    assert.equal(stationAtPoint(100, 100, stations)?.id, 'front-desk');
    assert.equal(stationAtPoint(60, 60, stations)?.id, 'front-desk'); // corner of the box
  });

  test('returns null outside every station box', () => {
    assert.equal(stationAtPoint(0, 0, stations), null);
  });
});

describe('approachPoint', () => {
  test('stops standoffDistance away from the station, toward the player', () => {
    const p = approachPoint(100, 100, 300, 100, 50);
    assert.ok(Math.abs(Math.hypot(p.x - 100, p.y - 100) - 50) < 1e-6);
    assert.ok(p.x < 300); // moved toward the station, not past the player
  });

  test('does not move the player if already within standoffDistance', () => {
    const p = approachPoint(100, 100, 120, 100, 50);
    assert.deepEqual(p, { x: 120, y: 100 });
  });
});

describe('clampToCanvas', () => {
  test('clamps to the margin on every edge', () => {
    assert.deepEqual(clampToCanvas(-100, -100, 20), { x: 20, y: 20 });
    assert.deepEqual(clampToCanvas(CANVAS_WIDTH + 100, CANVAS_HEIGHT + 100, 20), {
      x: CANVAS_WIDTH - 20,
      y: CANVAS_HEIGHT - 20,
    });
  });

  test('leaves an in-bounds point unchanged', () => {
    assert.deepEqual(clampToCanvas(480, 300, 20), { x: 480, y: 300 });
  });
});

describe('entryPointForFloor', () => {
  test('returns FLOOR_1_ENTRY_POINT for FLOOR_1 and FLOOR_2_ENTRY_POINT for FLOOR_2', () => {
    assert.deepEqual(entryPointForFloor(FLOOR_1), FLOOR_1_ENTRY_POINT);
    assert.deepEqual(entryPointForFloor(FLOOR_2), FLOOR_2_ENTRY_POINT);
  });
});

void STATION_BOX_SIZE; // imported for completeness/documentation parity with the cooking floor-plan test file
