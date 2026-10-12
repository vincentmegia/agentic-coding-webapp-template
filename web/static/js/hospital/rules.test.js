import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  roundTier,
  shiftClockSecondsForShift,
  patientVolumeForShift,
  inGameTimeLabel,
  karenShiftForSeed,
  KAREN_SHIFT_MIN,
  KAREN_SHIFT_MAX,
  vitalsForLevel,
  triageLevelForVitals,
  CONDITIONS,
  TREATMENTS,
  MEDICATIONS,
  MED_CABINET_BOTTLES,
  DOSE_CHOICES,
  conditionsForShift,
  conditionForRoll,
  SURGERY_START_SHIFT,
  gradeMedsPick,
  SKILL_CHECKS,
  skillCheckSuccessZone,
  isSkillCheckSuccess,
  skillCheckSweepSpeed,
  skillCheckHitsRequired,
  SURGERY_STAGES,
  nearestOnPath,
  gradeBandageTrace,
  bandagePathForRolls,
  queueWaitSecondsForShift,
  treatmentPatienceSeconds,
  patienceMultiplierForWardMood,
  walkSpeedMultiplierForSanity,
  coffeePourTargetBand,
  gradeCoffeePour,
  shiftPaycheck,
  SHIFT_PAYCHECK_MIN,
  paycheckMultiplierForRating,
  hallucinationIntensity,
  shakyHandsZoneScale,
  hallucinationPayMultiplier,
} from './rules.js';

describe('tiers and clock', () => {
  test('shifts 1-10/11-20/21-30 map to tiers 1/2/3, clamping out-of-range input', () => {
    assert.equal(roundTier(1), 1);
    assert.equal(roundTier(10), 1);
    assert.equal(roundTier(11), 2);
    assert.equal(roundTier(30), 3);
    assert.equal(roundTier(99), 3);
    assert.equal(roundTier(Number.NaN), 1);
  });

  test('the clock shrinks and patient volume grows per tier', () => {
    assert.deepEqual([1, 11, 21].map(shiftClockSecondsForShift), [600, 480, 360]);
    assert.deepEqual([1, 11, 21].map(patientVolumeForShift), [6, 9, 12]);
  });

  test('the in-game day runs 7:00 AM to 7:00 PM', () => {
    assert.equal(inGameTimeLabel(600, 600), '7:00 AM');
    assert.equal(inGameTimeLabel(300, 600), '1:00 PM');
    assert.equal(inGameTimeLabel(0, 600), '7:00 PM');
    assert.equal(inGameTimeLabel(Number.NaN, 600), '7:00 AM');
  });
});

describe('Karen', () => {
  test('her shift is always within 10-15 and stable per seed', () => {
    for (let seed = 0; seed < 500; seed++) {
      const shift = karenShiftForSeed(seed * 7919);
      assert.ok(shift >= KAREN_SHIFT_MIN && shift <= KAREN_SHIFT_MAX, `seed ${seed} -> ${shift}`);
    }
    assert.equal(karenShiftForSeed(12345), karenShiftForSeed(12345));
  });

  test('different seeds reach every shift in the range', () => {
    const seen = new Set();
    for (let seed = 0; seed < 500; seed++) seen.add(karenShiftForSeed(seed));
    assert.equal(seen.size, KAREN_SHIFT_MAX - KAREN_SHIFT_MIN + 1);
  });
});

describe('triage vitals', () => {
  test('generated vitals always classify back to their own level', () => {
    for (const level of ['red', 'yellow', 'green']) {
      for (let i = 0; i < 300; i++) {
        const rolls = [0, 1, 2, 3, 4].map((k) => ((i * 0.6180339 + k * 0.4142) % 1));
        const vitals = vitalsForLevel(level, rolls);
        assert.equal(triageLevelForVitals(vitals), level, `${level} ${JSON.stringify(vitals)}`);
      }
    }
  });

  test('each red flag alone makes a patient red', () => {
    const normal = { hr: 80, systolic: 120, diastolic: 75, spo2: 98, temp: 37 };
    assert.equal(triageLevelForVitals(normal), 'green');
    assert.equal(triageLevelForVitals({ ...normal, spo2: 86 }), 'red');
    assert.equal(triageLevelForVitals({ ...normal, hr: 140 }), 'red');
    assert.equal(triageLevelForVitals({ ...normal, systolic: 80 }), 'red');
    assert.equal(triageLevelForVitals({ ...normal, temp: 39 }), 'yellow');
    assert.equal(triageLevelForVitals({ ...normal, hr: 115 }), 'yellow');
  });

  test('missing rolls default rather than producing NaN', () => {
    const v = vitalsForLevel('yellow');
    assert.ok(Object.values(v).every(Number.isFinite));
  });
});

describe('conditions and meds', () => {
  test('every plan step is a known treatment, and meds plans name a real drug and dose', () => {
    const drugs = new Set(MEDICATIONS.map((m) => m.name));
    for (const c of CONDITIONS) {
      assert.ok(c.plan.length > 0, c.id);
      for (const step of c.plan) assert.ok(TREATMENTS.includes(step), `${c.id}: ${step}`);
      if (c.plan.includes('meds')) {
        assert.ok(drugs.has(c.med?.drug), `${c.id} drug`);
        assert.ok(DOSE_CHOICES.includes(c.med.dose), `${c.id} dose`);
      }
    }
  });

  test('every ordered drug has a look-alike decoy on the shelf', () => {
    for (const c of CONDITIONS.filter((x) => x.med)) {
      const prefix = c.med.drug[0];
      const lookAlikes = MEDICATIONS.filter((m) => m.name !== c.med.drug && m.name.startsWith(prefix));
      assert.ok(lookAlikes.length >= 1, c.med.drug);
    }
    assert.ok(MEDICATIONS.length >= MED_CABINET_BOTTLES);
  });

  test('surgery cases are held back until SURGERY_START_SHIFT', () => {
    const hasSurgery = (shift) => conditionsForShift(shift).some((c) => c.plan.includes('surgery'));
    assert.equal(hasSurgery(SURGERY_START_SHIFT - 1), false);
    assert.equal(hasSurgery(SURGERY_START_SHIFT), true);
  });

  test('conditionForRoll picks from the shift pool across the whole roll range', () => {
    const pool = conditionsForShift(1);
    assert.equal(conditionForRoll(1, 0), pool[0]);
    assert.equal(conditionForRoll(1, 0.9999), pool[pool.length - 1]);
    assert.equal(conditionForRoll(1, 1), pool[pool.length - 1]);
  });

  test('gradeMedsPick checks the drug first, then the dose', () => {
    const order = { drug: 'Albuterol', dose: 2 };
    assert.equal(gradeMedsPick(order, 'Albuterol', 2), 'correct');
    assert.equal(gradeMedsPick(order, 'Atenolol', 2), 'wrong-drug');
    assert.equal(gradeMedsPick(order, 'Albuterol', 3), 'wrong-dose');
  });
});

describe('skill checks', () => {
  test('oxygen and surgery need three hits, vitals and IV one', () => {
    assert.equal(skillCheckHitsRequired('vitals'), 1);
    assert.equal(skillCheckHitsRequired('iv'), 1);
    assert.equal(skillCheckHitsRequired('oxygen'), 3);
    assert.equal(skillCheckHitsRequired('surgery'), SURGERY_STAGES.length);
  });

  test('zones are centered and surgery is the tightest', () => {
    for (const kind of Object.keys(SKILL_CHECKS)) {
      const zone = skillCheckSuccessZone(kind);
      assert.ok(Math.abs((zone.start + zone.end) / 2 - 0.5) < 1e-9);
    }
    const widths = Object.keys(SKILL_CHECKS).map((k) => skillCheckSuccessZone(k).width);
    assert.equal(Math.min(...widths), skillCheckSuccessZone('surgery').width);
  });

  test('a shaky-hands scale shrinks the zone', () => {
    assert.ok(skillCheckSuccessZone('vitals', 0.5).width < skillCheckSuccessZone('vitals').width);
  });

  test('isSkillCheckSuccess is inclusive at the zone edges', () => {
    const zone = skillCheckSuccessZone('vitals');
    assert.equal(isSkillCheckSuccess(0.5, zone), true);
    assert.equal(isSkillCheckSuccess(zone.start, zone), true);
    assert.equal(isSkillCheckSuccess(zone.end, zone), true);
    assert.equal(isSkillCheckSuccess(zone.start - 0.01, zone), false);
    assert.equal(isSkillCheckSuccess(Number.NaN, zone), false);
  });

  test('the sweep speeds up with shift number', () => {
    assert.ok(skillCheckSweepSpeed(30, 'vitals') > skillCheckSweepSpeed(1, 'vitals'));
  });
});

describe('bandage trace', () => {
  const path = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }];

  test('nearestOnPath measures distance and position along the path', () => {
    const near = nearestOnPath({ x: 150, y: 10 }, path);
    assert.equal(near.distance, 10);
    assert.equal(near.along, 0.75);
  });

  test('a clean trace from end to end succeeds', () => {
    const samples = Array.from({ length: 60 }, (_, i) => ({ x: (i / 59) * 200, y: 3 }));
    const grade = gradeBandageTrace(samples, path);
    assert.equal(grade.coverage, 1);
    assert.equal(grade.accuracy, 1);
    assert.equal(grade.success, true);
  });

  test('stopping halfway fails on coverage', () => {
    const samples = Array.from({ length: 30 }, (_, i) => ({ x: (i / 29) * 100, y: 0 }));
    const grade = gradeBandageTrace(samples, path);
    assert.ok(grade.coverage <= 0.55);
    assert.equal(grade.success, false);
  });

  test('scribbling far off the line fails on accuracy', () => {
    const samples = Array.from({ length: 60 }, (_, i) => ({ x: (i / 59) * 200, y: i % 2 === 0 ? 0 : 60 }));
    const grade = gradeBandageTrace(samples, path);
    assert.equal(grade.coverage, 1);
    assert.ok(grade.accuracy < 0.7);
    assert.equal(grade.success, false);
  });

  test('no samples or a degenerate path is a failure, not a crash', () => {
    assert.equal(gradeBandageTrace([], path).success, false);
    assert.equal(gradeBandageTrace([{ x: 0, y: 0 }], [{ x: 0, y: 0 }]).success, false);
  });

  test('generated wound paths run left to right inside the overlay', () => {
    const p = bandagePathForRolls([0, 1, 0.5, 0.2, 0.8, 0.3]);
    assert.equal(p.length, 6);
    for (let i = 1; i < p.length; i++) assert.ok(p[i].x > p[i - 1].x);
    for (const pt of p) assert.ok(pt.y >= 240 && pt.y <= 360);
  });
});

describe('patience, mood, sanity', () => {
  test('queue wait and treatment patience shrink with shift number', () => {
    assert.equal(queueWaitSecondsForShift(1), 90);
    assert.ok(queueWaitSecondsForShift(30) >= 45 && queueWaitSecondsForShift(30) < 60);
    assert.equal(treatmentPatienceSeconds('red', 1), 90);
    assert.ok(treatmentPatienceSeconds('red', 30) < 90);
    assert.ok(treatmentPatienceSeconds('red', 1) < treatmentPatienceSeconds('green', 1));
  });

  test('Ward Mood scales patience from 1.0 down to 0.6', () => {
    assert.equal(patienceMultiplierForWardMood(100), 1);
    assert.ok(Math.abs(patienceMultiplierForWardMood(0) - 0.6) < 1e-9);
  });

  test('low Sanity slows the walk to 60%', () => {
    assert.equal(walkSpeedMultiplierForSanity(100), 1);
    assert.ok(Math.abs(walkSpeedMultiplierForSanity(0) - 0.6) < 1e-9);
  });
});

describe('coffee, pay, hallucinations', () => {
  test('coffee grading matches Library Shift', () => {
    const band = coffeePourTargetBand(0.5);
    const mid = (band.low + band.high) / 2;
    assert.equal(gradeCoffeePour(mid, band), 'perfect');
    assert.equal(gradeCoffeePour(band.high + 0.05, band), 'good');
    assert.equal(gradeCoffeePour(0.1, band), 'sloppy');
    assert.equal(gradeCoffeePour(1, band), 'spilled');
  });

  test('shiftPaycheck docks 500 per mistake down to the floor', () => {
    assert.equal(shiftPaycheck(0), 4000);
    assert.equal(shiftPaycheck(2), 3000);
    assert.equal(shiftPaycheck(50), SHIFT_PAYCHECK_MIN);
    assert.equal(shiftPaycheck(-3), 4000);
  });

  test('the rating scales pay linearly', () => {
    assert.equal(paycheckMultiplierForRating(5), 1);
    assert.equal(paycheckMultiplierForRating(3.5), 0.7);
    assert.equal(paycheckMultiplierForRating(-1), 0);
  });

  test('hallucinations start below 25 Sanity and peak at 0', () => {
    assert.equal(hallucinationIntensity(25), 0);
    assert.equal(hallucinationIntensity(0), 1);
    assert.equal(shakyHandsZoneScale(1), 0.5);
    assert.equal(hallucinationPayMultiplier(0), 1);
    assert.equal(hallucinationPayMultiplier(25), 0.96);
    assert.equal(hallucinationPayMultiplier(10000), 0.7);
  });
});
