# Feature: Hospital Shift

## Status

`Shipped` — implemented and covered by tests. JS: the pure modules in
`web/static/js/hospital/` (71 `node --test` tests); `web/static/js/
hospital-game.js` wires them to the canvas. Go: handler/service/validation
tests plus a real-Postgres round trip in `cmd/server/e2e_test.go`.
Playwright: `e2e/hospital-shift.spec.js` (15 tests, Chromium + WebKit),
driving the real click/key paths with coordinates from
`window.__hospitalShiftTestHooks`. Manually checked with screenshots of a
full shift (every minigame, Karen, coffee, hallucinations, handover) with
zero console errors. `/projects` card uses a real screenshot
(`web/static/images/hospital/screenshot.png`).

Additions made during the build, beyond the original scope list: an ×
button (and Escape) backs out of any minigame without a mistake
(`cancelTask`), since a Red patient can arrive while you're mid-bandage;
the Med Cabinet always shows the ordered drug's look-alikes (Amoxicillin/
Amoxapine, Albuterol/Atenolol, Epinephrine/Ephedrine…).

## Summary

A fourth "Shift" canvas mini-game, `/hospital-shift`, sibling to Kitchen
Shift and Library Shift: the player is an ER nurse working 30 shifts —
triaging arriving patients, then treating them in the ward's beds through
patient-care minigames (Vitals Check, Oxygen, IV, Bandage, Meds Dispensing,
Surgery), earning **Gard** (the site's shared game currency).

## Problem / Motivation

The user asked for a new project, "hospital shift." When asked, they chose:

* **Role:** ER nurse — triage the queue, assign beds, treat patients.
* **Structure:** mirror Library Shift — canvas top-down map, click-to-move,
  timed shift, minigame overlays, Sanity + Coffee Machine, hallucinations,
  a scripted difficult-visitor event, Postgres leaderboard, `localStorage`
  progress, shared `people.js` art.
* **Minigames:** all four offered (Triage sort, Meds dispensing, Vitals
  check, Bandage/IV), plus, in their words: "for the vitals checks and the
  stuff that pumps oxygen and surgeries i want there to be skill checks
  when they did it." So Vitals, Oxygen (bag-valve pumping) and Surgery
  started as timing-bar **skill checks**; Oxygen later became a
  find-the-hearts search where skulls stand for missed checks (see Scope).

## Scope

**In scope (v1):**

* `GET /hospital-shift` page + canvas game shell (960×600), click-to-move on
  two floors (see below), same architecture as Library Shift: pure DOM-free
  logic modules (`web/static/js/hospital/{rules,engine-state,floor-plan}.js`,
  `node --test`-covered) driven by one canvas engine
  (`web/static/js/hospital-game.js`).
* **30 shifts** in three 10-shift tiers. The shift clock runs 7:00 AM →
  7:00 PM over 600/480/360 real seconds (same slow pace as Library Shift),
  and patient volume grows each tier.
* **Triage**: patients queue at the Triage Desk with a wait timer. Click
  one → walk to the desk → **Triage Sort**: read their complaint and
  vitals (HR, BP, SpO₂, temperature) and pick Red / Yellow / Green.
  Correct or not, the patient is then put in a free bed (a wrong call is a
  mistake). No free bed → the desk says so and the patient keeps waiting.
* **Beds** (4): each bedded patient has an ordered treatment plan from
  their condition, shows the current step as a chip over the bed, and has a
  treatment-patience bar (shorter for Red). Running out = the patient is
  transferred to another hospital: a mistake and −1.5★.
* **Treatments** (each step is one minigame):
  * **Vitals Check** (skill check, 1 hit) — stop the marker on the
    heartbeat in the gold zone of an ECG strip.
  * **Oxygen** (find the hearts) — hearts and skulls bob around the
    scene beside the patient's bag-valve mask. Each heart clicked is one
    good pump (three finish it); a skull is a missed skill check — a
    mistake — and fades out so one slip can't cost twice. Changed from a
    3-hit timing bar at the user's request ("make it find hearts and
    there will be skulls that symbol missed skill checks").
  * **IV** (skill check, 1 hit, narrower) — the needle sways over the arm;
    tap when it's over the vein.
  * **Surgery** (skill check, 3 stages: Incision → Repair → Sutures,
    narrowest zone) — the patient must first be wheeled from their bed to
    the Operating Room (the player carries the gurney), then operated on
    there; afterwards they return to their bed.
  * **Bandage** (precision trace) — needs a **bandage roll** from the
    Supply Cart upstairs in hand (without one the bed says where to get
    it, and its chip reads "Bandage (roll: 2F)"); then hold and trace the
    dashed line along the wound, graded on coverage and accuracy. A
    finished dressing uses up the roll; a botched one or backing out
    keeps it. Any patient's Bandage step can use any roll.
  * **Meds** (Meds Dispensing) — at the Med Cabinet, pick the ordered
    drug from bottles with look-alike names and the right dose, carry it to
    the patient's bed.
  * A missed skill check, failed trace, or wrong drug/dose is a mistake;
    the minigame stays open for an immediate retry (Library Shift's
    retry-on-failure).
  * Finishing a step tips +5 Gard; finishing the last step discharges the
    patient for a Red/Yellow/Green bonus (60/40/25 Gard) and frees the bed.
* **Karen** (the scripted difficult visitor): once per run on a shift
  rolled from 10–15, an angry relative storms the Triage Desk demanding her
  mother be seen first. "Explain Triage" (+30 Gard) or "Let Her Cut In" (a
  mistake and −50 Ward Mood); a 12 s timer auto-resolves as the latter.
* **Ward Mood** (Library Mood's analog): starts at 100, −25 per mistake,
  raised by coffee (below),
  scales new patients' wait and treatment patience (×1.0 → ×0.6), drives
  the HUD status (Calm / Busy / Chaotic).
* **Sanity + Coffee Machine**: Sanity drains passively and −15 per mistake,
  slowing the walk; the break room's Coffee Machine opens Library Shift's
  **Coffee Pour** — machine art and pour screen copied verbatim from
  Library Shift (perfect +100 Sanity & 10 Gard tip, good +70, sloppy +40,
  spilled −50 and a coffee stain). Unlike Library Shift, coffee also lifts
  **Ward Mood** (`COFFEE_MOOD_RESTORE`: perfect +20, good +12, sloppy +6,
  spilled 0) — the user asked for "the coffee also improve the mood".
* **Hallucinations** below 25 Sanity (Library Shift's v2.16 system, ER
  flavored): vignette, shadow figures, whispers ("code blue…", "bed five
  is empty"), flicker, shake; shaky hands (narrower/faster skill checks),
  carried meds can slip from your hands, ghost patients in the triage line
  (walking up to one costs 5 Sanity), and a pay cut for time at 0 Sanity.
* **Star rating**: 5★ each shift, −1.5★ per walk-out (a queued patient
  whose wait runs out, or a bed transfer); the rating scales the payout.
* **Handover & paycheck**: at 7:00 PM a 20 s handover wait begins, then the
  Charge Nurse's office opens; walking in pays the shift: `shiftPaycheck
  (mistakes)` (4000 − 500 per mistake, floor 500) + bonuses, × rating ÷ 5,
  × the hallucination multiplier. Shift 30 shows a Final Paycheck with
  leaderboard submission.
* Big expressive characters via `web/static/js/shared/people.js` — a new
  `scrubs` outfit (V-neck, chest pocket, stethoscope) for the player,
  **Nurse Maya Santos**, and the existing patient designs; bedded patients
  are drawn lying down under a blanket.
* `localStorage` progress (`hospital-game:v1`), Postgres leaderboard
  (`hospital_scores`), `/projects` card.

* **Two floors + Supply Cart** (added after v1 — the user asked for a
  supply cart for bandages "and make a second floor where they are on",
  and for bandage steps to be more common): the 1st Floor is the ER; the
  2nd Floor is the **Supply Room**, holding only the **Supply Cart**
  (take a bandage roll; one carried item at a time, same as meds or the
  gurney). Library Shift's three ways between floors: **Stairs** and an
  **Elevator** at the same spot on both floors, and the HUD's
  `#hospital-floor-button` ("Go Upstairs"/"Go Downstairs"); all instant,
  allowed in every phase so you can always come back down for handover.
  You land beside the fixture you used. Patients keep ticking while you're
  upstairs. Hallucinations can make you drop a carried roll, like meds.
  New bandage conditions: **Kitchen burn** (green: vitals, bandage),
  **Dog bite** (yellow: vitals, bandage, Amoxicillin ×1) and **Bad fall**
  (yellow: vitals, bandage, IV) — bandage now appears in 7 of 14 plans.

* **Busier ER** (added after the user asked to "make it more busier"):
  patients per shift raised from 6/9/12 to **12/16/22** by tier, and
  arrivals are spread evenly (`patientArrivalTimes`: two in the opening
  4–20 s, then one per equal slice of the window up to 85% of the shift)
  instead of uniformly random, so there are no long dead spells. Three
  background staff wander the floors — Dr. Okafor and an Orderly in the ER
  (routes kept clear of the triage line), a Stock tech in the Supply Room.
* **Helping staff** (the user then asked what the workers do, and picked
  all three proposed jobs — engine-state.js "Helping staff", rules.js
  section 15):
  - **Dr. Okafor** (automatic): when a bedded patient drops below 30% of
    their patience (`DOCTOR_ASSIST_PATIENCE_FRACTION`) he walks over and
    finishes their current step — any step but surgery, never the patient
    you're mid-minigame with or carrying meds for — and tops their patience
    back up to 50%. No step tip (you didn't do it), but a discharge he
    completes still pays. Then a 50 s cooldown (also his delay at shift
    start).
  - **Orderly** (click him): wheels the most urgent surgery patient to the
    OR (`orderlyTakePatient` → `orderlyDeliverToOR`); their patience is
    paused from pickup until the operation. The OR table holds one waiting
    patient (`orPatient`); walk to the OR with free hands to operate. His
    label reads "Orderly (click: to OR)" whenever someone's waiting.
  - **Stock tech** (click him): 35 s upstairs, then 25 s in the ER with
    bandage rolls ("Stock tech · rolls (click)"). Clicking him makes him
    wait while you walk over, then he hands you a roll — no trip upstairs.

**Out of scope (v1):**

* First Person Mode, Reading Nook-style mood restore, 0-Mood
  penalties, shops/gear — Library Shift grew these over many follow-ups;
  v1 ships the mechanics the user chose.
* Mobile-specific controls beyond tap-to-move.
* Image assets (canvas primitives only, as every game here).

---

## User Flow

```text
1. Player opens /hospital-shift (Projects grid "Play now").
2. Start screen → "Start Shift" (also requests fullscreen).
3. Patients arrive at the Triage Desk queue. Click one → walk to the desk →
   Triage Sort: read vitals, pick Red/Yellow/Green → patient goes to a bed.
4. Click a bed → walk to it → its current step opens:
   - Vitals / IV: a skill check at the bed; Oxygen: find the hearts, avoid the skulls.
   - Bandage: get a roll from the Supply Cart on the 2nd Floor (Stairs,
     Elevator or "Go Upstairs"), come back down, trace the wound.
   - Meds: the bed says "Meds"; walk to the Med Cabinet → pick drug + dose →
     carry it back to the bed.
   - Surgery: at the bed you take the gurney; walk to the Operating Room →
     three-stage skill check → patient returns to the bed.
5. Last step done → discharged (+Gard), bed frees.
6. Coffee Machine any time: Coffee Pour restores Sanity and lifts Ward Mood.
7. 7:00 PM → 20 s handover → enter the Charge Nurse's office → paycheck.
8. Repeat for 30 shifts (Karen once, shift 10–15). Shift 30: Final Paycheck +
   optional leaderboard submission; "Start New Month" resets.
```

---

## Visual Direction

Same as Library Shift: canvas primitives at 960×600, Organic palette, big
characters at Library Shift's 1.55 scale, label chips, the Caprasimo
Sanity label. The ER floor is pale mint vinyl tiles. Stations: Triage Desk
(top), Charge Nurse's office (top-left), Med Cabinet (top-right), four
curtained beds across the middle, Operating Room (right, green-tiled),
break-room Coffee Machine (bottom-left), Stairs (top-right) and Elevator
(bottom-right) — Library Shift's art for both. The 2nd Floor Supply Room
has warm grey tiles, wall shelving of gauze boxes and linen, and the steel
Supply Cart stacked with bandage rolls in the middle; it pulses while a
bed is waiting on a dressing and your hands are free. Minigames are full-canvas
overlays; each skill check has its own scene (ECG monitor, bag-valve mask,
arm with vein, surgical field) over one shared timing bar.

---

## UI

```text
web/templates/pages/hospital-shift.html          # {{define "hospital-shift-content"}}
web/templates/components/hospital-leaderboard.html
```

| State   | Behavior |
| ------- | -------- |
| Default | Start screen → ER floor gameplay. |
| Loading | HTMX nav uses `#nav-loading`; leaderboard uses `#leaderboard-loading`. |
| Empty   | Leaderboard with no rows: "No scores yet — be the first!" |
| Error   | Leaderboard failure renders an inline "Couldn't load the leaderboard." fragment. |
| Success | Score submission swaps in the refreshed leaderboard. |

---

## HTMX Interactions

| Trigger                  | Method | Endpoint                       | Target                  | Swap        | Indicator |
| ------------------------ | ------ | ------------------------------ | ----------------------- | ----------- | --------- |
| Projects "Play now" card | GET    | `/hospital-shift`              | `#main-content`         | `outerHTML` | `#nav-loading` |
| Leaderboard load         | GET    | `/hospital-shift/leaderboard`  | `#hospital-leaderboard` | `outerHTML` | `#leaderboard-loading` |
| Final Paycheck submit    | POST   | `/hospital-shift/score`        | `#hospital-leaderboard` | `outerHTML` | `#leaderboard-loading` |

---

## Routes / Handlers

| Method | Path                          | Handler                          | Auth | Notes |
| ------ | ----------------------------- | -------------------------------- | ---- | ----- |
| GET    | `/hospital-shift`             | `HospitalShiftHandler.Index`       | no | `ContentTemplate: "hospital-shift-content"`. |
| GET    | `/hospital-shift/leaderboard` | `HospitalShiftHandler.Leaderboard` | no | Bare fragment. |
| POST   | `/hospital-shift/score`       | `HospitalShiftHandler.SubmitScore` | no | Own per-IP `scoreSubmitLimiter` (5/min). |

---

## Data Model

`migrations/010_create_hospital_scores.sql`:

| Column           | Type        | Constraints |
| ---------------- | ----------- | ----------- |
| id               | BIGINT      | GENERATED ALWAYS AS IDENTITY PRIMARY KEY |
| player_name      | TEXT        | NOT NULL, 1–20 chars |
| total_earnings   | INT         | NOT NULL, 0–300000 (30 clean shifts with bonuses can pass Library Shift's 100000 cap) |
| shifts_completed | INT         | NOT NULL, 1–30 |
| created_at       | TIMESTAMPTZ | NOT NULL DEFAULT now() |

Index `idx_hospital_scores_earnings (total_earnings DESC)`. Leaderboard-only,
like every other game; all run state lives in `localStorage`.

---

## Business Rules / Validation

All numbers are named constants in `web/static/js/hospital/rules.js`.

* **Tiers**: shifts 1–10 / 11–20 / 21–30; clock 600/480/360 s; patients
  per shift 12/16/22; two arrive in the first 4–20 s, the rest spread evenly.
* **Conditions** (`CONDITIONS`): each has a triage level, a complaint, an
  ordered treatment plan and (when it has a Meds step) a drug + dose.
  Surgery cases (appendicitis, crash injuries) only arrive from shift 4
  (`SURGERY_START_SHIFT`), so the first shifts teach the basic steps.
* **Triage vitals**: `vitalsForLevel(level, rolls)` generates vitals that
  `triageLevelForVitals` classifies back to that same level — Red: SpO₂ <
  90, HR > 130 or systolic BP < 90; Yellow: temp ≥ 38.5 °C or HR 101–130;
  Green: everything normal. The overlay prints this legend, so it's a real
  read-the-chart decision, not a guess.
* **Patience**: queue wait 90 s → 45 s floor by shift (Library Shift's
  `queueWaitSecondsForShift`); treatment patience by level (Red 90, Yellow
  120, Green 150 s) shrinking up to 35% by shift 30. Both × Ward Mood
  multiplier at arrival/bedding. A patient in surgery (gurney carried) has
  their patience paused.
* **Skill checks** (`SKILL_CHECKS`): zone width / hits — Vitals 0.22 / 1,
  IV 0.16 / 1, Surgery 0.14 / 3. Sweep speed ramps with
  shift number; shaky hands shrink the zone to 50% and speed it 1.6× at full
  hallucination.
* **Bandage trace**: graded by `gradeBandageTrace(samples, path)` —
  success needs ≥ 85% of the path covered (`BANDAGE_MIN_COVERAGE`) and ≥ 70%
  of samples within 16 px of it (`BANDAGE_MIN_ACCURACY`). Releasing early
  grades what was traced.
* **Meds**: the cabinet fills the oldest bed whose current step is Meds.
  Only one item (meds, a gurney or a bandage roll) can be carried at a time.
* **Payout**: `max(0, shiftPaycheck(mistakes) + bonusGard) × rating/5 ×
  hallucinationPayMultiplier`. Bonuses: step tips, discharges, coffee tips,
  Karen.
* **Closing**: in-flight work is abandoned at 7:00 PM; no penalty beyond
  what already happened.

---

## Security Considerations

* `/hospital-shift` and its leaderboard GET are public; the score POST is
  rate-limited per IP with its own limiter.
* `player_name`/`total_earnings`/`shifts_completed` validated server-side
  against the same bounds as the CHECK constraints
  (`internal/service/hospital_validation.go`); player names are rendered
  through html/template auto-escaping.
* Same documented no-CSRF gap as the other games' score routes.
* No new secrets/config.

---

## Testing Plan

* [x] Go: handler tests (index, leaderboard, score happy/validation/
      rate-limit/DB-error), validation + service tests, real-Postgres
      round trip in `cmd/server/e2e_test.go`.
* [x] JS (`node --test`): tiers/clock label, Karen seed range, vitals ↔
      triage agreement, condition gating, skill-check zones, bandage
      grading, every engine-state transition (triage, bed tasks, meds,
      surgery transport, patience transfers, Karen, coffee, closing,
      payout), floor-plan geometry.
* [x] Playwright (`e2e/hospital-shift.spec.js`, Chromium + WebKit): start →
      triage a patient → vitals skill check → meds → bandage → surgery →
      coffee → Karen → handover → paycheck → final-shift leaderboard
      submit; HTMX revisit stays interactive. Uses
      `window.__hospitalShiftTestHooks` for exact coordinates/timing.
* [x] Manual browser check: a click-driven shift with zero console errors,
      (the canvas uses its own fixed palette, like the other games).

---

## Open Questions

* Tuning (patience, zone widths, volumes) is implementation-time and
  expected to change after the user plays it.

---

## Definition of Done

* [x] User flow works end-to-end.
* [x] All UI states implemented.
* [x] Migration with a working Down.
* [x] Handler/service/repository boundaries followed.
* [x] Accessibility: Enter on a hovered station walks to it; skill checks
      accept Space/Enter; Triage Sort accepts 1/2/3; Meds accepts number
      keys. Bandage trace stays pointer-only (precision tracing has no
      keyboard equivalent — same stance as Library Shift's scene search).
* [x] Tests in the Testing Plan pass.
* [x] `/hospital-shift` on the Projects grid (real screenshot).
