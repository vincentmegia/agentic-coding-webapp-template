// Pure, DOM-free round-state management for the Fishing Game
// (docs/features/fishing-game.md's Business Rules / Validation and Testing
// Plan). Mirrors rules.js's contract: no DOM/canvas/localStorage/timer
// dependencies, so it can be unit-tested with `node --test` and imported
// unchanged by the canvas game loop (fishing-game.js). All state
// transitions for a single in-progress round live here — fishing-game.js
// calls into these functions rather than reimplementing lives/streak/
// invulnerability/depth-cap logic inline inside its
// `requestAnimationFrame` callback, which is what makes that logic
// testable independent of canvas timing (see the doc's Testing Plan).
//
// State shape (`RoundState`):
//   {
//     lives: number,                 // remaining lives; round ends at 0
//     milesSinceLastHit: number,     // depth-miles since the last hazard
//                                    // hit (or round start) — feeds
//                                    // rules.js's streakMultiplier()
//     depthMiles: number,            // current depth, only ever increases
//     elapsedSeconds: number,        // elapsed round time, only increases
//     score: number,                 // accumulated score this round
//     invulnerableUntil: number,     // a clock value (same units/clock the
//                                    // caller passes into applyHazardHit —
//                                    // e.g. elapsedSeconds or
//                                    // performance.now()/1000); hits are
//                                    // ignored while `now < invulnerableUntil`
//     emergencyBallastCharged: bool, // true if the once-per-round shield
//                                    // is available to absorb the next hit
//     roundStatus: 'playing' | 'caught' | 'reached-abyss',
//   }
//
// This module never reads a clock itself (no Date.now()/performance.now()
// calls) — every function that needs "now" or a time delta takes it as an
// explicit argument, so behavior is fully deterministic and testable.

import { streakMultiplier, descentSpeed, DEPTH_CAP_MILES } from './rules.js';

export { DEPTH_CAP_MILES };

/** Starting lives for a fresh round (Hull Plating gear level 0, per the doc). */
export const DEFAULT_LIVES = 3;

/** Invulnerability window after a hit (real or shield-absorbed), in seconds. */
export const INVULNERABILITY_SECONDS = 1.2;

/**
 * Builds a fresh round-start state. `overrides` lets the caller apply gear
 * effects that take hold "starting the next round" (doc: Gear upgrades) —
 * e.g. `{ lives: 3 + hullPlatingLevel, emergencyBallastCharged: ownsEmergencyBallast }`
 * — without this module knowing anything about gear/shop/token bookkeeping.
 *
 * @param {Partial<RoundState>} [overrides]
 * @returns {RoundState}
 */
export function createInitialState(overrides = {}) {
  return {
    lives: DEFAULT_LIVES,
    milesSinceLastHit: 0,
    depthMiles: 0,
    elapsedSeconds: 0,
    score: 0,
    invulnerableUntil: 0,
    emergencyBallastCharged: false,
    roundStatus: 'playing',
    ...overrides,
  };
}

function isInvulnerable(state, now) {
  return Number.isFinite(now) && now < state.invulnerableUntil;
}

/**
 * Applies a single hazard collision at time `now` (same clock the caller
 * will later pass as `now` on subsequent calls — e.g. running
 * `elapsedSeconds`). Pure: returns a new state object, never mutates
 * `state`.
 *
 * Behavior (doc's Business Rules "Lives and hit recovery" + the explicit
 * gap-fix that a shield-absorbed hit still grants i-frames):
 *   - No-op (returns `state` unchanged) if the round has already ended, or
 *     if currently invulnerable (`now < state.invulnerableUntil`).
 *   - Otherwise, if Emergency Ballast is charged: consume it
 *     (`emergencyBallastCharged` -> false), do NOT lose a life, do NOT
 *     reset `milesSinceLastHit`, but DO start the invulnerability window.
 *   - Otherwise: lose exactly one life, reset `milesSinceLastHit` to 0,
 *     start the invulnerability window, and transition `roundStatus` to
 *     'caught' if lives reach 0.
 *
 * @param {RoundState} state
 * @param {number} now - current clock value, same units as `invulnerableUntil`.
 * @param {{invulnerabilitySeconds?: number}} [options] - override the
 *   default 1.2s window (mainly for tests).
 * @returns {RoundState}
 */
export function applyHazardHit(state, now, options = {}) {
  if (state.roundStatus !== 'playing') return state;
  if (isInvulnerable(state, now)) return state;

  const invulnerabilitySeconds = Number.isFinite(options.invulnerabilitySeconds)
    ? options.invulnerabilitySeconds
    : INVULNERABILITY_SECONDS;
  const invulnerableUntil = (Number.isFinite(now) ? now : 0) + invulnerabilitySeconds;

  if (state.emergencyBallastCharged) {
    return {
      ...state,
      emergencyBallastCharged: false,
      invulnerableUntil,
    };
  }

  const lives = state.lives - 1;
  return {
    ...state,
    lives,
    milesSinceLastHit: 0,
    invulnerableUntil,
    roundStatus: lives <= 0 ? 'caught' : state.roundStatus,
  };
}

/**
 * Applies a single fish catch. Pure: returns a new state object.
 *
 * Adds `fish.points * streakMultiplier(state.milesSinceLastHit)` to score
 * (rules.js owns the multiplier curve — this function only reads it, never
 * reimplements it). A no-op if the round has already ended. Deliberately
 * independent of `applyHazardHit`: the doc's "Fish/hazard overlap" rule
 * says a catch and a hit in the same frame both resolve, so callers should
 * call this and `applyHazardHit` unconditionally for whatever overlaps
 * occurred that frame, never skipping one because the other also fired.
 *
 * @param {RoundState} state
 * @param {{points: number}} fish
 * @returns {RoundState}
 */
export function applyFishCatch(state, fish) {
  if (state.roundStatus !== 'playing') return state;

  const points = fish && Number.isFinite(fish.points) ? fish.points : 0;
  const multiplier = streakMultiplier(state.milesSinceLastHit);

  return {
    ...state,
    score: state.score + points * multiplier,
  };
}

/**
 * Advances depth and elapsed time by one simulation step. Pure: returns a
 * new state object plus the descent speed the caller should use to move
 * sprites this step (not persisted onto the state itself — the state shape
 * doesn't carry a `speed` field, since it's a per-call derived value, not
 * round-progress data).
 *
 * `deltaMiles` must be depth-miles descended this step (not raw on-screen
 * path length — rules.js's streakMultiplier is explicit that weaving
 * side-to-side must not build streak faster than descending straight down,
 * and that same unit feeds `milesSinceLastHit` here).
 *
 * Transitions `roundStatus` to 'reached-abyss' the moment `depthMiles`
 * reaches `DEPTH_CAP_MILES`, even at full lives (doc: reaching the cap is
 * its own success state, independent of the lives/hit system). A no-op if
 * the round has already ended.
 *
 * @param {RoundState} state
 * @param {number} deltaMiles - depth-miles descended this step (negative/non-finite treated as 0).
 * @param {number} deltaSeconds - seconds elapsed this step (negative/non-finite treated as 0).
 * @returns {{state: RoundState, speed: number}}
 */
export function advance(state, deltaMiles, deltaSeconds) {
  if (state.roundStatus !== 'playing') {
    return { state, speed: descentSpeedFor(state) };
  }

  const milesDelta = Number.isFinite(deltaMiles) && deltaMiles > 0 ? deltaMiles : 0;
  const secondsDelta = Number.isFinite(deltaSeconds) && deltaSeconds > 0 ? deltaSeconds : 0;

  const depthMiles = Math.min(DEPTH_CAP_MILES, state.depthMiles + milesDelta);
  const elapsedSeconds = state.elapsedSeconds + secondsDelta;
  const milesSinceLastHit = state.milesSinceLastHit + milesDelta;

  const nextState = {
    ...state,
    depthMiles,
    elapsedSeconds,
    milesSinceLastHit,
    roundStatus: depthMiles >= DEPTH_CAP_MILES ? 'reached-abyss' : state.roundStatus,
  };

  return { state: nextState, speed: descentSpeedFor(nextState) };
}

function descentSpeedFor(state) {
  return descentSpeed(state.depthMiles, state.elapsedSeconds);
}
