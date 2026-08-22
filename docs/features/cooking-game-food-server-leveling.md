# Kitchen Shift — Round Tiers (formerly "Food Server Leveling")

## Status

`Shipped` (v3.14). A sibling of `cooking-game-food-server.md` (which this
extends — that doc's Gear upgrades section links here), not a replacement
for any part of it. Fold this doc into `cooking-game-food-server.md` as a
new section on its next full doc pass.

**This doc originally proposed a different design** — a "food server
level," 1 through 5, driven by a new persisted `totalShiftsCompleted`
lifetime counter that never reset. That design was fully specified and
partially implemented (`rules.js`'s `foodServerLevel`/
`foodServerLevelStars`/`unlockedTableCount`/`baseCapacityForLevel`,
`floor-plan.js`'s `isTableUnlocked`/`unlockedStations`) before the user
asked for something different: each *round* (shift) to carry its own
real-time limit as well, in three progressively harder ten-shift bands
across the month, rather than a lifetime stat that only a returning
veteran would ever see change. The floor-plan table-unlock geometry
(`isTableUnlocked`/`unlockedStations`, still keyed 1-5) survived that
pivot untouched; everything driven off lifetime shifts was replaced with
functions driven off the *current* shift number. What follows describes
the shipped round-tier design, not the original lifetime proposal.

## Summary

The month runs **30 shifts** (raised from 20), split into **three
10-shift round tiers**. Each tier has its own real-time shift-clock
budget and its own dining-room size — both grow harder together as the
month goes on:

| Tier | Shifts | Shift clock | Grid shape | Tables open | Base order capacity |
| ---- | ------ | ------------ | ----------- | -------------- | ---------------------- |
| 1    | 1–10   | 5 min (300s) | 3x2 (centered box) | 6  | 1 |
| 2    | 11–20  | 3 min (180s) | 6x3 (centered box) | 18 | 3 |
| 3    | 21–30  | 2 min (120s) | 8x4 (centered box, packed tight) | 30 | 5 |

Unlike the original lifetime-based proposal, this is driven directly by
`save.currentShift` — the same counter "Start New Month" already resets
to 1 — so **every fresh month starts back at Tier 1's small, slow-paced
dining room** and builds back up to the full, fast-paced 30-table floor
by the final band. There is no separate persisted leveling stat.

## Problem / Motivation

(Unchanged from the original proposal.) Before this shipped, every shift
rendered the full 6x5, 30-table dining room and let even a brand-new
player juggle 5 simultaneous orders before spending a single Gard on
gear — maximal from a player's very first table, with no sense of
*earning* the full restaurant, and (per the later round-tier request) no
sense of the *pace* of a shift changing either.

## Mechanic

**This section describes the current, final implementation** — the
unlock mechanism went through two earlier designs first (an entrance-
first row scheme, then a center-out row scheme) before landing here; see
"Table size doubled..." below for why, and don't take either earlier
scheme as still-live behavior if you've seen an older version of this
doc or an older commit.

`floor-plan.js`'s `isTableUnlocked(tableId, level)` is now simply
`tableId <= unlockedTableCount(level)` — the first N ids (1-indexed) are
open, full stop. Which *specific* ids that is no longer encodes any
centering or row logic; centering is handled entirely by *where* those N
tables are drawn (`tableGridPosition`/`TABLE_GRID_SHAPES`, a fresh
near-square grid computed for whatever count is currently unlocked — 3x2
at 6 tables, 6x3 at 18, 8x4 at 30), not by which ids are chosen. `rules.js`
still maps tier → an `unlockedTableCount`-compatible level (1/3/5) so the
three tiers land exactly on 6/18/30 open tables:

```js
// web/static/js/cooking/rules.js
export const ROUND_TIER_COUNT = 3;
export const ROUND_TIER_SHIFT_SPAN = 10;
export const ROUND_TIER_CLOCK_SECONDS = [300, 180, 120];
export const ROUND_TIER_FLOOR_LEVEL = [1, 3, 5];
export const TABLES_PER_FLOOR_LEVEL = 6;

export function roundTier(shiftNumber) { /* 1..3, ceil(shift / 10) */ }
export function roundTierStars(tier) { /* '★★☆'-style, 3 chars */ }
export function shiftClockSecondsForShift(shiftNumber) { /* ROUND_TIER_CLOCK_SECONDS[roundTier(shiftNumber) - 1] */ }
export function tableUnlockLevelForShift(shiftNumber) { /* ROUND_TIER_FLOOR_LEVEL[roundTier(shiftNumber) - 1] */ }
export function unlockedTableCountForShift(shiftNumber) { /* tableUnlockLevelForShift(shiftNumber) * TABLES_PER_FLOOR_LEVEL */ }
export function baseCapacityForShift(shiftNumber) { /* tableUnlockLevelForShift(shiftNumber) */ }

export function tableCapacity(shiftNumber, extraTableServiceLevel) {
  const base = baseCapacityForShift(shiftNumber);
  const gearLevel = Number.isFinite(extraTableServiceLevel) && extraTableServiceLevel > 0 ? extraTableServiceLevel : 0;
  return Math.min(unlockedTableCountForShift(shiftNumber), base + gearLevel * TABLE_CAPACITY_PER_EXTRA_TABLE_SERVICE_LEVEL);
}
```

`cooking-game.js` reads `tableUnlockLevelForShift(currentShiftNumber)`
live (via a `currentTableUnlockLevel()` helper) everywhere the dining
room's size gates behavior: `maybeSpawnCustomer`'s available-table
filter, click/hover hit-testing (`unlockedStations`), and `drawStation`'s
locked-table rendering. The shift clock itself is set from
`shiftClockSecondsForShift(currentShiftNumber)` at `createInitialState`'s
`clockSeconds` override, both for the real shift (`beginShift`) and the
one-time intro scene (`playIntro`), and `inGameTimeLabel` takes that same
total as an explicit second argument so the HUD's restaurant-time-of-day
display always maps the *actual* clock length for that tier, not a
fixed one.

Kitchen-station exemption is unchanged from the original proposal:
kitchen-room stations (fridge, cabinet, cookware closet, stove, oven,
cleaning closet) are never gated — only dining tables.

**Table positioning changed twice after first shipping** — history, not
current behavior (see "Table size doubled..." below for what actually
ships today): originally entrance-first (the row nearest the entrance
opened first, growing back toward Duke's Office), the same shape as the
original v3.13 proposal. The user then asked for the visible tables to
be "organize[d] in a more symmetrical setting and vertically and
horizontally center[ed]" — a single open row pinned to the
entrance-adjacent edge left a large, lopsided empty gap above it, so
`isTableUnlocked` briefly switched to opening the room's *center* row
first and growing outward symmetrically. That row-based scheme (center-
out or otherwise) was itself fully replaced shortly after — by the box-
grid layout (`tableGridPosition`/`TABLE_GRID_SHAPES`) the "Mechanic"
section above and "Table size doubled..." below both describe — once
doubling the table size made a single 100px-tall row read as a thin
strip rather than a box. No row-position concept exists in the code
anymore at all.

### Locked tables are not rendered at all

The original proposal called for a locked table to stay visible on
canvas, desaturated/dimmed with an "Opens at ★★★" (later "Opens Shift
11") label — previewing what leveling up would earn, like a shop's
greyed-out next-tier gear. Shipped that way initially, then the user
explicitly asked for the opposite: **"tables not available should not
be visible."** `drawStation` now returns immediately for any table
`isTableUnlocked` reports as locked for the current tier — no box, no
chairs, no label, nothing drawn — so the dining room visually *is*
exactly as big as what's currently open, rather than previewing a bigger
room the player can't use yet. Locked tables remain excluded from
`maybeSpawnCustomer` and click/hover hit-testing exactly as before; this
change is rendering-only. The `requiredTierForTable`/`tierStartShift`
helpers that computed the old label's shift number were dead code once
locked tables stopped drawing a label at all, and were removed.

### Open tables no longer show a "Table N" caption

Alongside the centering request, the user asked to "remove the table
caption." `drawStation` now skips the label-chip draw entirely for
`kind === 'table'` (every other station — Fridge, Duke's Office, the
front counter, etc. — keeps its label unchanged). A table's identity
is still readable elsewhere when it matters: the hover tooltip
(`hoverHintFor`) and the Orders sidebar both still say "Table N," since
those are functional (which table an order belongs to), not decorative.

### Table size doubled, decorative star pillows removed, and the layout redesigned around a centered box grid

Next, the user asked to double the table's size, remove the decorative
"star pillow" chairs (`cooking-game.js`'s `drawChairPillows`, drawn
around every table), and "follow a box layout as much as possible."
`TABLE_BOX_SIZE` doubled (50 → 100); `drawChairPillows` and its call
site were deleted outright, not just hidden.

Doubling the box size made the *old* fixed 6x5 grid physically too tall
for the room, and the center-out row scheme above would have shown a
single 100px-tall row as a thin horizontal strip rather than a box.
Both problems are solved together: `floor-plan.js`'s `buildStations` now
takes the current `level` and lays out *only the tables unlocked at that
level* fresh, in a near-square grid picked per count
(`TABLE_GRID_SHAPES`: 6→3x2, 18→6x3, 30→8x4), centered within the room's
available space (`TABLE_AREA_X`/`TABLE_AREA_Y`) every time. `isTableUnlocked`
simplified to "is this id among the first N" — which specific ids are
open no longer needs to encode centering, since the *layout* now
recenters itself for whatever count is open. `cooking-game.js` rebuilds
`stations` (now `let`, not `const`) once per shift start
(`beginShift`/`playIntro`), since the tier — and therefore the layout —
can only change between shifts, not mid-shift.

Before the AskUserQuestion (below) was resolved, one confirmed physical
conflict shaped this: 30 tables at 100px each cannot fit the room with
comfortable spacing. The user chose to pack tightly rather than shrink
the table size, enlarge the canvas, or scale table size per tier — so
30's 8x4 shape (32 slots, 2 unused, last row of 6 centered under the
rows above) runs ~5px *tighter* than the box is tall between rows, a
small, deliberate, accepted overlap at the single densest tier. Every
other count (6, 12, 18, 24) fits with comfortable (40-60px) gaps. One
real bug this surfaced and fixed: the tightened bottom row initially
collided with the Counter/Coffee Machine's label chip, which flips to
draw *above* their box when it doesn't fit below the canvas edge — the
room's usable y-range (`TABLE_AREA_Y`) accounts for that flipped-label
space now, not just the fixtures' own boxes.

### Table size now scales per tier, and tables are circles

After the flat 100px size shipped, the user reported Tier 1's tables (a
sparse 6-table room) looked "too big" and asked me to "use creative
thinking to see how to scale it properly," alongside making tables
circles instead of squares. This is a *different* decision from the
"pack tightly" one above — that one was specifically about whether Tier
3's fully-open, 30-table room could keep the full 100px size (yes, by
packing tighter); this one is about Tier 1 and 2's sparser rooms looking
visually oversized even though they had plenty of unused space. Both
stand together: Tier 3 (level 5) is untouched by this change and still
packs tightly at exactly 100px.

`tableBoxSizeForLevel(level)` (`floor-plan.js`) now scales the box
itself: 64px at level 1 (deliberately smaller than `STATION_BOX_SIZE`'s
70px, so a rookie server's small, quiet room doesn't need furniture
sized for the full rush) growing linearly by 9px/level to 100px at level
5. `preferredSpacingForSize(size) = size * 1.6` replaces the old flat
160px preferred spacing, so the gap-to-box ratio (~0.6x) stays constant
at every tier instead of only being tuned for the 100px case;
`axisSpacing`/`tableGridPosition` both take `size` as an explicit
parameter now. `preferredSpacingForSize(100) === 160` exactly, so level
5's layout is a byte-for-byte no-op (pinned by a regression test).

Tables draw as filled circles now (`cooking-game.js`'s `drawStation`,
`ctx.arc` instead of `drawRoundRect`) — every other station kind (doors,
fridge, counter, etc.) keeps its unchanged rounded-rect look; only the
`kind === 'table'` branch changed. Table hit-testing is unchanged — it's
still the existing rectangular bounding-box test
(`stationAtPoint`/`isTableUnlocked`), a deliberate simplification (only
the drawn shape changed, not the geometry the game reasons about).
Because table size now varies by tier, `drawTableContents` (the seated
customer/patience bar) and the order speech bubble both switched from
reading the flat `TABLE_BOX_SIZE` constant to each table's own live
`station.size`, so they stay correctly positioned at every tier — this
also means the `TABLE_BOX_SIZE` import was no longer needed in
`cooking-game.js` and was removed there (it's still exported from
`floor-plan.js`, representing the level-5 ceiling).

Implemented by two parallel background agents against a precise,
decoupled contract (one owning `floor-plan.js`'s sizing math, one owning
`cooking-game.js`'s circle rendering and `station.size` fixes) — the
split worked cleanly because `cooking-game.js`'s only obligation was "use
the live `station.size`, never a hardcoded number," which is correct
regardless of whatever specific values the sizing agent chose.

### Why shift number, not a lifetime stat

The original proposal chose a lifetime counter specifically so a
returning veteran wouldn't "de-level" every month. The user's follow-up
request explicitly asked for the opposite once time limits entered the
picture: **every month should build from a small, slow-paced service up
to the full, fast-paced one**, the same shape every month, not a
one-time unlock a veteran would only ever see once. Driving both the
clock and the table count off `currentShift` (which already resets
monthly) delivers that directly, and removes an entire persisted-field
migration (`totalShiftsCompleted`) that the lifetime design needed and
this one doesn't.

### Why gear stays parallel, not sequential

Unchanged reasoning from the original proposal: Extra Table Service is
still purchasable at any shift — `tableCapacity`'s
`Math.min(unlockedTableCountForShift(shiftNumber), ...)` means gear
bought well ahead of a tier change doesn't raise capacity past however
many tables are physically open yet, but isn't wasted either — it takes
effect the moment the next tier opens more tables. No gear item in this
shop is level-gated; this one isn't the exception either.

### Why Tier 1 stays at exactly one table, one order

Unchanged from the original proposal's "why level 1 stays at exactly
one:" taken literally, not softened to 2. Olive & Oliver may queue behind
Mel's table at Tier 1 capacity — left as an ordinary consequence of the
existing spawn-queue logic (`maybeSpawnCustomer`) rather than
special-cased away, consistent with this game's "simple, uniform rules
over special cases" philosophy. Karen (shift 12) now lands early in Tier
2 (capacity 3, 18 tables open) rather than the original proposal's
"already level 3" framing — still comfortably past Tier 1's harshest
constraint.

### UI/feedback

* The start screen shows the upcoming shift's round tier as filled/empty
  stars (`roundTierStars(roundTier(save.currentShift))`, e.g. "★★☆"),
  alongside month-to-date/best-month Gard.
* The moment a shift boundary crosses into a new tier (checked in
  `endShift()` when `save.currentShift` advances), a **"Tier up!"** toast
  (`showToast`, reused as-is) fires on the paycheck screen, naming the
  new star rating and how many tables just opened.
* Stars are plain `★`/`☆` Unicode characters, same as every other
  star-branded UI in this game (Startime Diner's own star theme) — no new
  image asset.

## Data Model

No new `localStorage` save field. Round tier is computed live from
`save.currentShift`, which already existed and already resets on "Start
New Month" — exactly the behavior this design wants. (The original
proposal's `totalShiftsCompleted` field was implemented and then removed
before shipping, once the round-tier request superseded it — it never
reached a released save shape, so no migration/back-compat concern.)

`SHIFTS_PER_MONTH` (`rules.js`) raised from 20 to 30 to divide evenly
into three round tiers. The `cooking_scores` leaderboard table's CHECK
constraints and the server-side validation bounds in
`internal/service/cooking_validation.go` widened to match: `shifts_completed`
up to 30 (was 20), `total_earnings` up to 150,000 (was 100,000 — the
per-shift payout formula is unchanged, so the theoretical max rose from
20 × 4,000 = 80,000 to 30 × 4,000 = 120,000; both bounds keep the same
~25% headroom above their respective theoretical max). See migration
`004_widen_cooking_scores_round_tiers.sql`.

## Testing Plan

All covered in `web/static/js/cooking/rules.test.js`:

* [x] `roundTier`: correct tier at every 10-shift band boundary, never
      exceeds `ROUND_TIER_COUNT`, monotonically non-decreasing across the
      month, non-positive/non-finite input treated as shift 1.
* [x] `roundTierStars`: always `ROUND_TIER_COUNT` characters, clamps
      out-of-range/non-finite input.
* [x] `shiftClockSecondsForShift`: matches `ROUND_TIER_CLOCK_SECONDS` at
      the start of each tier, never increases as the shift number grows.
* [x] `tableUnlockLevelForShift`/`unlockedTableCountForShift`: Tier 1
      opens exactly 6 tables, Tier 3 opens all 30, monotonically
      non-decreasing across the month.
* [x] `baseCapacityForShift`: exactly 1 at shift 1, monotonically
      non-decreasing, tops out at 5.
* [x] `tableCapacity(shiftNumber, extraTableServiceLevel)`: Tier 3
      reproduces the pre-round-tiers flat numbers exactly, for every
      existing Extra Table Service level (0–8) — a regression guard that
      an established player's end-game numbers are unchanged; a fresh
      shift-1 save caps at exactly 1 regardless of gear level, gear never
      raises capacity past that tier's unlocked table count.
* [x] `inGameTimeLabel(clockSecondsRemaining, totalClockSeconds)`: honors
      an explicit non-default total (e.g. Tier 1's 300s), not just the
      legacy 90s default.

`floor-plan.test.js`'s "buildStations table layout (v3.15 centered box
grid)" suite additionally covers: unlocked tables' bounding box is
centered on the room's exact x/y midpoints; every table stays within
canvas bounds at every level; unlocked tables never overlap beyond a
small, explicitly-tolerated amount (see "Table size doubled..." above)
at the densest levels; the same table id lands at a different position
at a different level (proving the layout really does recompute, not
reuse a fixed grid); `buildStations` with no level argument defaults to
the full 30-table layout.

`floor-plan.test.js` additionally covers `tableBoxSizeForLevel` (exact
values 64/73/82/91/100, monotonic, clamps out-of-range/non-finite input
the same as every other level-clamping function in this file), a
regression-pin proving level 5's table positions are byte-for-byte
unchanged from before the size-scaling change, and that a level's tables
all report `size === tableBoxSizeForLevel(level)`.

Manually verified end-to-end via Playwright against a live dev server:
fresh save starts at Tier 1 (★☆☆, 1/30, 8:30 AM), showing a 3x2 block of
6 small (64px) circular tables centered in the room, visibly smaller than
the fixture stations around them, no star pillows, no "Table N"
captions; a save seeded at shift 11 shows ★★☆ and an 18-table 6x3 block
of noticeably larger (82px) circles; a save seeded at shift 21 shows
★★★ and all 30 tables at full (100px) size in an 8x4 block (last row of
6 centered underneath), with the Counter/Coffee Machine labels fully
clear of the tightened bottom row. A full click-to-walk-to-order
interaction (clicking Mel's table, player walking over, her order
appearing in the queue) was exercised against the new positions and
produced no console errors at any tier. `go test ./...` (including the
`DATABASE_URL`-gated end-to-end suite, run against a real Postgres) and
`npm run test:unit` (262/262 at the time — later work in this same doc's
history, e.g. the customer-sanity mechanic, added more; see
`cooking-game.md`'s own changelog for the current total) both green.
