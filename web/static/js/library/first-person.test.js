import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeAngle,
  angleTo,
  angleDiff,
  forwardVector,
  defaultFacingTowardCenter,
  projectEntity,
  isVisibleInFOV,
  screenXForAngleOffset,
  scaleForDistance,
  groundScreenY,
  projectScene,
  findInteractTarget,
  turnFacing,
  stepForward,
  DEFAULT_FOV_DEGREES,
} from './first-person.js';

describe('normalizeAngle', () => {
  test('leaves already-normalized angles unchanged', () => {
    assert.equal(normalizeAngle(0), 0);
    assert.ok(Math.abs(normalizeAngle(1) - 1) < 1e-9);
  });

  test('wraps values above PI down into (-PI, PI]', () => {
    assert.ok(Math.abs(normalizeAngle(Math.PI * 1.5) - -Math.PI / 2) < 1e-9);
    assert.ok(Math.abs(normalizeAngle(Math.PI * 3) - Math.PI) < 1e-9);
  });

  test('wraps values at/below -PI up into (-PI, PI]', () => {
    assert.ok(Math.abs(normalizeAngle(-Math.PI * 1.5) - Math.PI / 2) < 1e-9);
    assert.ok(Math.abs(normalizeAngle(-Math.PI) - Math.PI) < 1e-9);
  });
});

describe('angleTo (facing convention: 0 = north/-y, increases clockwise toward +x)', () => {
  test('straight up (-y) is angle 0', () => {
    assert.ok(Math.abs(angleTo(0, 0, 0, -100)) < 1e-9);
  });

  test('straight right (+x) is +90 degrees', () => {
    assert.ok(Math.abs(angleTo(0, 0, 100, 0) - Math.PI / 2) < 1e-9);
  });

  test('straight down (+y) is 180 degrees', () => {
    assert.ok(Math.abs(Math.abs(angleTo(0, 0, 0, 100)) - Math.PI) < 1e-9);
  });

  test('straight left (-x) is -90 degrees', () => {
    assert.ok(Math.abs(angleTo(0, 0, -100, 0) - -Math.PI / 2) < 1e-9);
  });
});

describe('forwardVector', () => {
  test('facing 0 walks toward -y', () => {
    const v = forwardVector(0);
    assert.ok(Math.abs(v.dx) < 1e-9);
    assert.ok(Math.abs(v.dy - -1) < 1e-9);
  });

  test('facing +90 degrees walks toward +x', () => {
    const v = forwardVector(Math.PI / 2);
    assert.ok(Math.abs(v.dx - 1) < 1e-9);
    assert.ok(Math.abs(v.dy) < 1e-9);
  });
});

describe('angleDiff', () => {
  test('returns 0 for identical angles', () => {
    assert.equal(angleDiff(1.2, 1.2), 0);
  });

  test('wraps the short way around the +/-PI seam', () => {
    // Almost a full turn apart the "long way" should read as a small
    // difference the "short way" — this is exactly the case a naive
    // subtraction gets wrong.
    const diff = angleDiff(-Math.PI + 0.1, Math.PI - 0.1);
    assert.ok(Math.abs(diff - 0.2) < 1e-9, `expected ~0.2, got ${diff}`);
  });
});

describe('defaultFacingTowardCenter', () => {
  test('a player north of center faces south (180 degrees)', () => {
    const facing = defaultFacingTowardCenter(480, 0, 960, 600);
    assert.ok(Math.abs(Math.abs(facing) - Math.PI) < 1e-6);
  });

  test('a player west of center faces east (+90 degrees)', () => {
    const facing = defaultFacingTowardCenter(0, 300, 960, 600);
    assert.ok(Math.abs(facing - Math.PI / 2) < 1e-6);
  });

  test('a player already exactly at the center faces 0 (north), not PI', () => {
    // Regression: floor-plan.js's FLOOR_1_ENTRY_POINT/FLOOR_2_ENTRY_POINT
    // are both exactly the canvas center (480, 300 on a 960x600 canvas), so
    // "face toward the center" from a point that IS the center is a
    // degenerate atan2(0, -0) call, which JS defines as PI, not 0 — silently
    // leaving every floor-entry player facing exactly backward.
    const facing = defaultFacingTowardCenter(480, 300, 960, 600);
    assert.strictEqual(facing, 0);
  });
});

describe('projectEntity', () => {
  test('an entity dead ahead has angleOffset 0 and the correct distance', () => {
    const player = { x: 100, y: 100, facing: 0 }; // facing north
    const { distance, angleOffset } = projectEntity(player, { x: 100, y: 40 }); // 60 north
    assert.ok(Math.abs(distance - 60) < 1e-9);
    assert.ok(Math.abs(angleOffset) < 1e-9);
  });

  test('an entity to the player\'s right (while facing north) has a positive angleOffset', () => {
    const player = { x: 100, y: 100, facing: 0 };
    const { angleOffset } = projectEntity(player, { x: 160, y: 100 });
    assert.ok(angleOffset > 0);
  });

  test('an entity behind the player has an angleOffset near +/-180 degrees', () => {
    const player = { x: 100, y: 100, facing: 0 };
    const { angleOffset } = projectEntity(player, { x: 100, y: 160 });
    assert.ok(Math.abs(Math.abs(angleOffset) - Math.PI) < 1e-9);
  });
});

describe('isVisibleInFOV', () => {
  test('dead-center and close is visible', () => {
    assert.equal(isVisibleInFOV(0, 100), true);
  });

  test('exactly at the FOV edge is still visible (inclusive boundary)', () => {
    const halfFov = (DEFAULT_FOV_DEGREES * Math.PI) / 180 / 2;
    assert.equal(isVisibleInFOV(halfFov, 100), true);
  });

  test('just past the FOV edge is not visible', () => {
    const halfFov = (DEFAULT_FOV_DEGREES * Math.PI) / 180 / 2;
    assert.equal(isVisibleInFOV(halfFov + 0.01, 100), false);
  });

  test('directly ahead but beyond maxDistance is not visible', () => {
    assert.equal(isVisibleInFOV(0, 10000), false);
  });

  test('behind the player (angleOffset ~PI) is never visible regardless of distance', () => {
    assert.equal(isVisibleInFOV(Math.PI, 10), false);
  });
});

describe('screenXForAngleOffset', () => {
  test('dead-center angleOffset maps to the horizontal midpoint', () => {
    assert.ok(Math.abs(screenXForAngleOffset(0, 960) - 480) < 1e-9);
  });

  test('the left FOV edge maps to screen x 0', () => {
    const halfFov = (DEFAULT_FOV_DEGREES * Math.PI) / 180 / 2;
    assert.ok(Math.abs(screenXForAngleOffset(-halfFov, 960)) < 1e-9);
  });

  test('the right FOV edge maps to the canvas width', () => {
    const halfFov = (DEFAULT_FOV_DEGREES * Math.PI) / 180 / 2;
    assert.ok(Math.abs(screenXForAngleOffset(halfFov, 960) - 960) < 1e-9);
  });

  test('is monotonically increasing with angleOffset', () => {
    const halfFov = (DEFAULT_FOV_DEGREES * Math.PI) / 180 / 2;
    const xs = [-halfFov, -halfFov / 2, 0, halfFov / 2, halfFov].map((a) => screenXForAngleOffset(a, 960));
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i] > xs[i - 1]);
  });
});

describe('scaleForDistance', () => {
  test('closer entities scale larger than farther ones', () => {
    assert.ok(scaleForDistance(50) > scaleForDistance(500));
  });

  test('never scales below the configured minimum', () => {
    assert.ok(scaleForDistance(1_000_000) >= 0.15);
  });

  test('never scales above the configured maximum, even extremely close', () => {
    assert.ok(scaleForDistance(0.001) <= 2.5);
  });
});

describe('groundScreenY', () => {
  test('closer entities draw lower on screen (larger Y) than farther ones', () => {
    assert.ok(groundScreenY(50) > groundScreenY(500));
  });

  test('never draws above the horizon line', () => {
    assert.ok(groundScreenY(100000) >= 300);
  });

  test('never exceeds the canvas height', () => {
    assert.ok(groundScreenY(0.01) <= 600);
  });
});

// Mirrors first-person.js's DEFAULT_MAX_DISTANCE — kept as a local literal
// so this test doesn't silently stop testing the cutoff if the constant is
// retuned without the test being revisited.
const DEFAULT_MAX_DISTANCE_TEST = 750;

describe('projectScene', () => {
  const player = { x: 480, y: 300, facing: 0 }; // facing north, mid-canvas

  test('culls entities outside the FOV', () => {
    const behind = { id: 'behind', x: 480, y: 600 }; // due south, 180 degrees off
    const result = projectScene(player, [behind], { canvasWidth: 960 });
    assert.equal(result.length, 0);
  });

  test('culls entities beyond maxDistance even when dead ahead', () => {
    const farNorth = { id: 'far', x: 480, y: 300 - (DEFAULT_MAX_DISTANCE_TEST + 50) };
    const result = projectScene(player, [farNorth], { canvasWidth: 960 });
    assert.equal(result.length, 0);
  });

  test('keeps entities inside the FOV and within range', () => {
    const ahead = { id: 'ahead', x: 480, y: 200 };
    const result = projectScene(player, [ahead], { canvasWidth: 960 });
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'ahead');
    assert.ok(typeof result[0].screenX === 'number');
    assert.ok(typeof result[0].scale === 'number');
    assert.ok(typeof result[0].groundY === 'number');
  });

  test('sorts back-to-front (farthest first, nearest last) for correct painter\'s-algorithm layering', () => {
    const near = { id: 'near', x: 480, y: 250 }; // 50 away
    const mid = { id: 'mid', x: 480, y: 150 }; // 150 away
    const far = { id: 'far', x: 480, y: 50 }; // 250 away
    const result = projectScene(player, [near, far, mid], { canvasWidth: 960 });
    assert.deepEqual(result.map((r) => r.id), ['far', 'mid', 'near']);
  });

  test('passes through extra entity fields untouched', () => {
    const entity = { id: 'x', x: 480, y: 250, entityKind: 'station', ref: { kind: 'front-desk' } };
    const result = projectScene(player, [entity], { canvasWidth: 960 });
    assert.equal(result[0].entityKind, 'station');
    assert.equal(result[0].ref.kind, 'front-desk');
  });
});

describe('findInteractTarget', () => {
  test('returns null when nothing is centered/near enough', () => {
    const projected = [{ id: 'far-off-center', angleOffset: 0.9, distance: 50 }];
    assert.equal(findInteractTarget(projected), null);
  });

  test('returns the entity when centered and within range', () => {
    const projected = [{ id: 'centered', angleOffset: 0, distance: 100 }];
    assert.equal(findInteractTarget(projected).id, 'centered');
  });

  test('excludes a centered entity that is too far away', () => {
    const projected = [{ id: 'too-far', angleOffset: 0, distance: 5000 }];
    assert.equal(findInteractTarget(projected), null);
  });

  test('of several qualifying candidates, picks the nearest one', () => {
    const projected = [
      { id: 'far', angleOffset: 0.02, distance: 140 },
      { id: 'near', angleOffset: -0.03, distance: 40 },
      { id: 'mid', angleOffset: 0.01, distance: 90 },
    ];
    assert.equal(findInteractTarget(projected).id, 'near');
  });
});

describe('turnFacing', () => {
  test('direction 0 leaves facing unchanged (aside from normalization)', () => {
    assert.equal(turnFacing(0.5, 0, 1), 0.5);
  });

  test('positive direction turns clockwise (increases facing)', () => {
    const result = turnFacing(0, 1, 1, Math.PI / 2); // 1 second at 90deg/s
    assert.ok(Math.abs(result - Math.PI / 2) < 1e-9);
  });

  test('negative direction turns counter-clockwise (decreases facing)', () => {
    const result = turnFacing(0, -1, 1, Math.PI / 2);
    assert.ok(Math.abs(result - -Math.PI / 2) < 1e-9);
  });

  test('wraps around past +/-PI', () => {
    const result = turnFacing(Math.PI - 0.1, 1, 1, 0.2);
    assert.ok(result < 0, `expected a wrapped negative angle, got ${result}`);
  });
});

describe('stepForward', () => {
  test('moving forward while facing north decreases y and leaves x unchanged', () => {
    const { x, y } = stepForward(100, 100, 0, 1, 50);
    assert.ok(Math.abs(x - 100) < 1e-9);
    assert.ok(Math.abs(y - 50) < 1e-9);
  });

  test('moving backward while facing north increases y (walks away from the forward direction)', () => {
    const { x, y } = stepForward(100, 100, 0, -1, 50);
    assert.ok(Math.abs(x - 100) < 1e-9);
    assert.ok(Math.abs(y - 150) < 1e-9);
  });

  test('moving forward while facing east (+90 degrees) increases x', () => {
    const { x, y } = stepForward(100, 100, Math.PI / 2, 1, 50);
    assert.ok(Math.abs(x - 150) < 1e-9);
    assert.ok(Math.abs(y - 100) < 1e-9);
  });
});
