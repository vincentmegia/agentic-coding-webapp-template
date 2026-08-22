import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStations,
  stationsInRoom,
  isTableUnlocked,
  unlockedStations,
  tableBoxSizeForLevel,
  stationAtPoint,
  approachPoint,
  clampToCanvas,
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  STATION_BOX_SIZE,
  TABLE_BOX_SIZE,
  TABLE_HIT_EXTEND_DOWN,
  ROOM_DINING,
  ROOM_KITCHEN,
  KITCHEN_ENTRY_POINT,
  DINING_ENTRY_POINT,
} from './floor-plan.js';

const TABLE_IDS = Array.from({ length: 30 }, (_, i) => i + 1);

describe('buildStations', () => {
  test('includes one entry per fixed station plus one per table id', () => {
    const stations = buildStations(TABLE_IDS);
    const kinds = stations.map((s) => s.kind);
    for (const kind of ['fridge', 'cabinet', 'toilet', 'cleaning-closet', 'cookware-closet', 'stove', 'oven', 'counter', 'coffee-machine', 'boss-office', 'kitchen-door', 'dining-door']) {
      assert.ok(kinds.includes(kind), `missing station kind ${kind}`);
    }
    assert.equal(stations.filter((s) => s.kind === 'table').length, TABLE_IDS.length);
  });

  test('every table gets a hitExtendDown of TABLE_HIT_EXTEND_DOWN, covering the seated-customer sprite drawn below it', () => {
    const stations = buildStations(TABLE_IDS);
    const tables = stations.filter((s) => s.kind === 'table');
    assert.ok(tables.every((t) => t.hitExtendDown === TABLE_HIT_EXTEND_DOWN));
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

  test('every station has a room tag of either ROOM_DINING or ROOM_KITCHEN', () => {
    const stations = buildStations(TABLE_IDS);
    for (const s of stations) {
      assert.ok(s.room === ROOM_DINING || s.room === ROOM_KITCHEN, `${s.id} has no valid room tag`);
    }
  });

  test('tables, the counter, coffee machine, toilet, boss-office, and kitchen-door are all in the Dining room', () => {
    const stations = buildStations(TABLE_IDS);
    const byId = Object.fromEntries(stations.map((s) => [s.id, s]));
    for (const id of ['toilet', 'kitchen-door', 'counter', 'coffee-machine', 'boss-office', 'table-1', 'table-30']) {
      assert.equal(byId[id].room, ROOM_DINING, `${id} should be in the Dining room`);
    }
  });

  test('fridge, cabinet, cookware-closet, stove, oven, cleaning-closet, and dining-door are all in the Kitchen room', () => {
    const stations = buildStations(TABLE_IDS);
    const byId = Object.fromEntries(stations.map((s) => [s.id, s]));
    for (const id of ['fridge', 'cabinet', 'cookware-closet', 'stove', 'oven', 'cleaning-closet', 'dining-door']) {
      assert.equal(byId[id].room, ROOM_KITCHEN, `${id} should be in the Kitchen room`);
    }
  });
});

describe('stationsInRoom', () => {
  test('filters down to only the stations in the given room', () => {
    const stations = buildStations(TABLE_IDS);
    const dining = stationsInRoom(stations, ROOM_DINING);
    const kitchen = stationsInRoom(stations, ROOM_KITCHEN);
    assert.ok(dining.every((s) => s.room === ROOM_DINING));
    assert.ok(kitchen.every((s) => s.room === ROOM_KITCHEN));
    assert.equal(dining.length + kitchen.length, stations.length);
  });

  test('returns an empty list for a room with no stations', () => {
    const stations = [{ id: 'a', room: ROOM_DINING }];
    assert.deepEqual(stationsInRoom(stations, ROOM_KITCHEN), []);
  });
});

describe('isTableUnlocked', () => {
  test('level 1 unlocks exactly ids 1-6', () => {
    for (let id = 1; id <= 6; id++) {
      assert.ok(isTableUnlocked(id, 1), `id ${id} should be unlocked at level 1`);
    }
    for (let id = 7; id <= 30; id++) {
      assert.ok(!isTableUnlocked(id, 1), `id ${id} should be locked at level 1`);
    }
  });

  test('level 5 unlocks every table, ids 1-30', () => {
    for (let id = 1; id <= 30; id++) {
      assert.ok(isTableUnlocked(id, 5), `id ${id} should be unlocked at level 5`);
    }
  });

  test('each level unlocks exactly level * 6 tables', () => {
    for (let level = 1; level <= 5; level++) {
      const unlockedCount = Array.from({ length: 30 }, (_, i) => i + 1)
        .filter((id) => isTableUnlocked(id, level)).length;
      assert.equal(unlockedCount, level * 6, `level ${level} should unlock ${level * 6} tables`);
    }
  });

  test('a table stays unlocked at every level at or above the one that first opened it', () => {
    // id 24 first opens at level 4 (level 4 unlocks ids 1-24) — it should stay open at levels 4-5.
    for (let level = 4; level <= 5; level++) {
      assert.ok(isTableUnlocked(24, level), `id 24 should stay unlocked at level ${level}`);
    }
  });

  test('a non-finite or out-of-range level clamps sanely', () => {
    // Below the valid range (including non-finite) behaves like level 1.
    assert.equal(isTableUnlocked(1, 0), isTableUnlocked(1, 1));
    assert.equal(isTableUnlocked(6, 0), isTableUnlocked(6, 1));
    assert.equal(isTableUnlocked(1, -3), isTableUnlocked(1, 1));
    assert.equal(isTableUnlocked(1, NaN), isTableUnlocked(1, 1));
    assert.equal(isTableUnlocked(1, undefined), isTableUnlocked(1, 1));
    // Above the valid range behaves like level 5 (everything open).
    assert.equal(isTableUnlocked(1, 6), isTableUnlocked(1, 5));
    assert.equal(isTableUnlocked(1, 99), true);
  });
});

describe('tableBoxSizeForLevel', () => {
  test('exact values at every level, 64 to 100 in steps of 9', () => {
    assert.equal(tableBoxSizeForLevel(1), 64);
    assert.equal(tableBoxSizeForLevel(2), 73);
    assert.equal(tableBoxSizeForLevel(3), 82);
    assert.equal(tableBoxSizeForLevel(4), 91);
    assert.equal(tableBoxSizeForLevel(5), 100);
  });

  test('level 5 matches TABLE_BOX_SIZE exactly', () => {
    assert.equal(tableBoxSizeForLevel(5), TABLE_BOX_SIZE);
  });

  test('is monotonically increasing across levels 1-5', () => {
    let previous = tableBoxSizeForLevel(1);
    for (let level = 2; level <= 5; level++) {
      const size = tableBoxSizeForLevel(level);
      assert.ok(size > previous, `level ${level} should be larger than level ${level - 1}`);
      previous = size;
    }
  });

  test('a non-finite or out-of-range level clamps sanely', () => {
    // Below the valid range (including non-finite) behaves like level 1.
    assert.equal(tableBoxSizeForLevel(0), tableBoxSizeForLevel(1));
    assert.equal(tableBoxSizeForLevel(-3), tableBoxSizeForLevel(1));
    assert.equal(tableBoxSizeForLevel(NaN), tableBoxSizeForLevel(1));
    assert.equal(tableBoxSizeForLevel(undefined), tableBoxSizeForLevel(1));
    // Above the valid range behaves like level 5.
    assert.equal(tableBoxSizeForLevel(6), tableBoxSizeForLevel(5));
    assert.equal(tableBoxSizeForLevel(99), tableBoxSizeForLevel(5));
  });
});

describe('unlockedStations', () => {
  test('passes through every non-table station regardless of level', () => {
    const stations = buildStations(TABLE_IDS, 1);
    const nonTables = stations.filter((s) => s.kind !== 'table');
    const result = unlockedStations(stations, 1);
    for (const s of nonTables) {
      assert.ok(result.includes(s), `${s.id} should pass through unfiltered at level 1`);
    }
  });

  test('filters table stations by isTableUnlocked at a given level', () => {
    const stations = buildStations(TABLE_IDS, 1);
    const result = unlockedStations(stations, 1);
    const resultTableIds = result.filter((s) => s.kind === 'table').map((s) => s.tableId);
    assert.equal(resultTableIds.length, 6);
    assert.ok(resultTableIds.every((id) => id >= 1 && id <= 6));
  });

  test('a mixed list of table and non-table stations filters correctly at a mid-range level', () => {
    const mixed = [
      { id: 'fridge', kind: 'fridge' },
      { id: 'table-1', kind: 'table', tableId: 1 },
      { id: 'table-25', kind: 'table', tableId: 25 },
    ];
    const result = unlockedStations(mixed, 1);
    assert.deepEqual(result.map((s) => s.id), ['fridge', 'table-1']);
  });

  test('at level 5, every table passes through alongside every non-table station', () => {
    const stations = buildStations(TABLE_IDS, 5);
    const result = unlockedStations(stations, 5);
    assert.equal(result.length, stations.length);
  });
});

describe('buildStations table layout (v3.15 centered box grid)', () => {
  test('unlocked tables are laid out in a compact block, centered on the room\'s available x/y midpoints', () => {
    const stations = buildStations(TABLE_IDS, 1); // 6 tables unlocked, ids 1-6
    const tables = stations.filter((s) => s.kind === 'table' && s.tableId <= 6);
    const xs = tables.map((t) => t.x);
    const ys = tables.map((t) => t.y);
    const midX = (Math.min(...xs) + Math.max(...xs)) / 2;
    const midY = (Math.min(...ys) + Math.max(...ys)) / 2;
    // The room's own available-space midpoints (TABLE_AREA_X/TABLE_AREA_Y in
    // floor-plan.js: [90,870] and [165,450]) — not re-exported, so this
    // pins the observable centering behavior instead of the private
    // constants. A tiny epsilon absorbs floating-point drift from
    // preferredSpacingForSize's size*1.6 multiplication (v3.16).
    assert.ok(Math.abs(midX - 480) < 1e-9, `midX = ${midX}`);
    assert.ok(Math.abs(midY - 307.5) < 1e-9, `midY = ${midY}`);
  });

  test('a larger level lays out more tables without moving canvas bounds out of range', () => {
    for (const level of [1, 2, 3, 4, 5]) {
      const stations = buildStations(TABLE_IDS, level);
      for (const s of stations.filter((st) => st.kind === 'table')) {
        const half = s.size / 2;
        assert.ok(s.x - half >= 0 && s.x + half <= CANVAS_WIDTH, `table ${s.tableId} out of horizontal bounds at level ${level}`);
        assert.ok(s.y - half >= 0 && s.y + half <= CANVAS_HEIGHT, `table ${s.tableId} out of vertical bounds at level ${level}`);
      }
    }
  });

  test('unlocked tables stay clear of each other, or overlap only within the accepted "pack tightly" tolerance at the densest levels', () => {
    // Levels 4/5 (24/30 tables, 4 rows) deliberately pack rows ~5px closer
    // than the box is tall — the user explicitly accepted "pack tightly...
    // tables will sit close together, nearly touching" over shrinking the
    // table size or leaving physical tables permanently unreachable. For
    // two overlapping boxes, the actual overlap strip's width is the
    // *smaller* of the x/y overlap amounts (e.g. two tables stacked in the
    // same column share their full 100px width but only a few px of
    // height) — that's the number this asserts a tolerance on, not both
    // axes independently.
    const MAX_ACCEPTED_OVERLAP_PX = 10;
    for (const level of [1, 2, 3, 4, 5]) {
      const stations = buildStations(TABLE_IDS, level);
      const unlocked = stations.filter((s) => s.kind === 'table' && isTableUnlocked(s.tableId, level));
      for (let i = 0; i < unlocked.length; i++) {
        for (let j = i + 1; j < unlocked.length; j++) {
          const a = unlocked[i];
          const b = unlocked[j];
          const overlapX = a.size - Math.abs(a.x - b.x);
          const overlapY = a.size - Math.abs(a.y - b.y);
          if (overlapX > 0 && overlapY > 0) {
            assert.ok(
              Math.min(overlapX, overlapY) <= MAX_ACCEPTED_OVERLAP_PX,
              `tables ${a.tableId} and ${b.tableId} overlap too much at level ${level} (${overlapX}x${overlapY}px)`,
            );
          }
        }
      }
    }
  });

  test('the same table id can land at a different position at a different level (fresh centered layout per tier)', () => {
    const atLevel1 = buildStations(TABLE_IDS, 1).find((s) => s.tableId === 1);
    const atLevel5 = buildStations(TABLE_IDS, 5).find((s) => s.tableId === 1);
    assert.notDeepEqual({ x: atLevel1.x, y: atLevel1.y }, { x: atLevel5.x, y: atLevel5.y });
  });

  test('defaults to level 5 (every table, full layout) when no level is passed', () => {
    const withDefault = buildStations(TABLE_IDS);
    const explicitLevel5 = buildStations(TABLE_IDS, 5);
    assert.deepEqual(
      withDefault.filter((s) => s.kind === 'table').map((s) => ({ id: s.tableId, x: s.x, y: s.y })),
      explicitLevel5.filter((s) => s.kind === 'table').map((s) => ({ id: s.tableId, x: s.x, y: s.y })),
    );
  });

  test('v3.16 regression pin: level 5 positions are unchanged from before table size started scaling by level', () => {
    // Captured from buildStations(TABLE_IDS, 5) before v3.16 (table size scaling)
    // was introduced — proves preferredSpacingForSize(100) === 160 really does
    // reproduce the old flat-160 layout exactly, not just approximately.
    const expected = {
      1: { x: 90, y: 165 },
      2: { x: 201.42857142857144, y: 165 },
      30: { x: 758.5714285714286, y: 450 },
    };
    const stations = buildStations(TABLE_IDS, 5);
    for (const [id, pos] of Object.entries(expected)) {
      const s = stations.find((st) => st.kind === 'table' && st.tableId === Number(id));
      assert.equal(s.x, pos.x, `table ${id} x`);
      assert.equal(s.y, pos.y, `table ${id} y`);
      assert.equal(s.size, TABLE_BOX_SIZE, `table ${id} size`);
    }
  });

  test('v3.16: table size scales down at lower levels, and every unlocked table at a level shares that level\'s size', () => {
    assert.ok(tableBoxSizeForLevel(1) < tableBoxSizeForLevel(5));
    for (const level of [1, 2, 3, 4, 5]) {
      const stations = buildStations(TABLE_IDS, level);
      const unlocked = stations.filter((s) => s.kind === 'table' && isTableUnlocked(s.tableId, level));
      assert.ok(unlocked.length > 0);
      for (const s of unlocked) {
        assert.equal(s.size, tableBoxSizeForLevel(level), `table ${s.tableId} at level ${level} should use that level's size`);
      }
    }
  });
});

describe('room entry points', () => {
  test('KITCHEN_ENTRY_POINT and DINING_ENTRY_POINT both stay within canvas bounds', () => {
    for (const point of [KITCHEN_ENTRY_POINT, DINING_ENTRY_POINT]) {
      assert.ok(point.x >= 0 && point.x <= CANVAS_WIDTH);
      assert.ok(point.y >= 0 && point.y <= CANVAS_HEIGHT);
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

  test('hitExtendDown extends only the bottom edge of a station\'s hit box', () => {
    const half = TABLE_BOX_SIZE / 2;
    const mixed = [{ id: 'table-1', kind: 'table', x: 0, y: 0, size: TABLE_BOX_SIZE, hitExtendDown: TABLE_HIT_EXTEND_DOWN }];
    // A point covering the seated-customer sprite drawn below the table box (a real bug report:
    // "i click on them but i cant" — see TABLE_HIT_EXTEND_DOWN's doc comment) now hits.
    assert.equal(stationAtPoint(0, half + TABLE_HIT_EXTEND_DOWN, mixed).id, 'table-1');
    // Past the extended margin is still a miss.
    assert.equal(stationAtPoint(0, half + TABLE_HIT_EXTEND_DOWN + 1, mixed), null);
    // The top edge is untouched by hitExtendDown.
    assert.equal(stationAtPoint(0, -half - 1, mixed), null);
  });

  test('a station without hitExtendDown keeps the plain symmetric box', () => {
    const half = STATION_BOX_SIZE / 2;
    const mixed = [{ id: 'fridge', kind: 'fridge', x: 0, y: 0, size: STATION_BOX_SIZE }];
    assert.equal(stationAtPoint(0, half + 1, mixed), null);
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
