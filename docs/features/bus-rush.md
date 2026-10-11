# Feature: Bus Rush

## Status

`Shipped` — implemented and verified against a real Postgres: Go unit +
DB-gated e2e tests, `node --test` rules tests, and `e2e/bus-rush.spec.js`
(Chromium + WebKit). Tuning numbers remain illustrative. No `/projects`
screenshot yet (placeholder tile).

## Summary

A top-down canvas driving game at `/bus-rush`: the player has stolen a bus
and flees the police across four lanes of oncoming traffic and five
Singapore districts (levels), collecting fares and dodging cars, vans and
trucks while police cruisers chase from behind. Fares earn tokens, which
are spent between runs in a depot shop on upgrades — chiefly a faster
engine. A public Postgres leaderboard shows the best runs.

## Problem / Motivation

Another "personal interests" mini-game alongside the Fishing Game, Kitchen
Shift and Library Shift, and a playful companion to the Bus Stop Finder. It
reuses the Fishing Game's proven loop (run → tokens → shop → stronger run)
and its leaderboard stack, so it adds a new game without new infrastructure.

## Scope

**In scope:**

* Canvas game: four lanes, the bus in the lower part of the screen (with
  room behind it for pursuing police), oncoming traffic coming down the
  screen toward it. Left/right changes lane; up/down accelerates/brakes.
  Speed is manual — the bus holds whatever speed it has unless ↑ or ↓ is
  held.
* Speed is the core trade-off: driving faster covers more distance (score)
  but traffic arrives faster. The Engine upgrade raises top speed.
* Fares (coins) spawn in lanes; collecting one adds to the run's fares.
* Lives: a collision with a car or van costs one life, drops the bus to
  the current district's speed floor, and grants a short invulnerability
  window (`HIT_GRACE_SECONDS`). The run ends at zero lives.
* Trucks (from 800 m) and semi trucks (from 1500 m) are lethal: touching
  one ends the run instantly, regardless of lives left or grace.
* **Bananas**: some trucks and semis (60%) are leaky and drop 1–2
  bananas from their rear as they come down the screen. A dropped banana
  lies still on the road, so it falls in behind its truck. Running one
  over makes the bus skid one lane left or right at random (inward at the
  road edge), with steering locked for `SKID_SECONDS` (0.5 s) and a wobble.
  It costs no life, but the skid can throw the bus into traffic or a
  cruiser. Police cruisers slip on bananas the same way (one lane over,
  no re-aiming for `SKID_SECONDS`), so luring a pursuer over one can skid
  it into traffic for a wreck — or into the bus, which is still Busted.
* **Police pursuit** (the bus is stolen): cruisers close in from behind
  whenever they're faster than the bus and re-aim at its lane after a short
  reaction delay. Police are **lethal**: any contact with a cruiser,
  pursuer or roadblock, ends the run as "Busted!", lives and grace
  notwithstanding. A cruiser that touches oncoming
  traffic wrecks, which earns bonus score and tokens, so baiting them into
  traffic is a strategy. Further in, some traffic rows are **roadblocks**
  (rows of oncoming cruisers, still passable). A 1–5 star **wanted level**
  scales pursuit speed, cruiser count, reaction time, roadblock chance and
  wreck bonus.
* **Levels** (districts in one continuous run): every 800 m
  (`LEVEL_DISTANCE`) the bus escapes into the next of five districts —
  CBD → Heartland → Expressway → Industrial → Changi (the last is
  endless). Each has its own scenery (see UI's Art style), crossfaded on
  entry with a "LEVEL n / district" banner and a checkpoint bonus
  (250 × district index). Entering a district refills lives to full
  (`maxLives`, so Bumpers count) and makes the bus faster: each district
  raises both the speed floor and top speed by `LEVEL_SPEED_STEP`
  (1.5 m/s, ~5 km/h), with an extra kick of 2 × that on entry. Each
  district starts the wanted level one star higher; every 10 fares adds
  another.
* Depot shop between runs (tokens → leveled upgrades): Engine (top speed),
  Steering (faster lane changes), Bumpers (+1 life), Fare Box (more tokens
  per fare).
* Progress (tokens, upgrade levels, bests) in `localStorage`, same as the
  Fishing Game — there are no visitor accounts.
* Public leaderboard (Postgres), submitted voluntarily with a display name.
* A `/projects` card ("Play now", HTMX nav).
* Touch controls: on-screen ◀ ▲ ▼ ▶ buttons, plus tapping the canvas's left
  or right half to change lane.

**Out of scope:**

* Server-authoritative gameplay or anti-cheat — same reasoning as the
  Fishing Game's Scope: coarse server-side bounds only.
* Header nav link (projects card only, matching the other games).
* Real-Singapore bus routes/data — this is an arcade game, not tied to the
  Bus Stop Finder's LTA data.

---

## User Flow

```text
1. Visitor opens /bus-rush (or "Play now" on /projects).
2. Start screen ("Hot-wired and ready?") shows tokens, best score, best
   distance and the controls; "Start Run" / "Depot Shop".
3. Run: a "LEVEL 1 / CBD" banner, then traffic and fares scroll down while
   police close in from behind; the player switches lanes and manages
   speed. Every 800 m a new district begins (banner, bonus, lives refilled).
4. A car/van hit costs a life; a truck, semi or any police car ends the run
   at once. When the run ends, the Run Over screen ("Busted!" / "Flattened
   by a truck!" / "New best run!") shows distance, fares, level reached,
   police wrecked, score and tokens earned, with an optional leaderboard
   submit.
5. "Depot Shop" spends tokens on upgrades; "Drive Again" starts a new run.
```

---

## UI

```text
web/templates/
├── pages/bus-rush.html                (canvas, HUD, start/run-over overlays)
└── components/
    ├── bus-rush-shop.html             (upgrade shop overlay)
    └── bus-rush-leaderboard.html      (leaderboard fragment)
web/static/js/
├── bus-rush.js                        (canvas loop, input, localStorage, DOM wiring)
└── busrush/rules.js (+ rules.test.js) (pure game rules, `node --test`)
```

**HUD** (above the canvas): Distance, Speed (km/h), Score, Lives, Fares,
Level (district number) and Wanted (★☆☆☆☆). Four per row on mobile,
all seven in one row from `sm`.

**Run Over** overlay: title, Distance, Fares collected, Level reached
("3 · Expressway"), Police wrecked, Score, Tokens earned, the leaderboard
form, and "Drive Again" / "Depot Shop".

**Art style**: flat top-down vector art in the site's warm Organic
palette, lit from the top-left. Each district's static roadside and road
surface is painted once into a seeded offscreen tile (`buildScenery`,
themed by `DISTRICTS`) that scrolls seamlessly, so per-frame cost stays
small; tiles are built on first use and pre-warmed just before each
district boundary. Shared across districts: asphalt grain, cracks, patches,
manholes, worn lane paint, striped kerbs and street lamps. Per district:

| District | Roadside |
| --- | --- |
| CBD | plaza paving, office-tower rooftops (aircon units, water tanks), street trees in planters, bus shelters with yellow zigzag bays |
| Heartland | grass verge, rain trees (some in bloom), shrubs, bus shelters |
| Expressway | guardrails instead of footpaths, yellow edge lines, trees, lamps twice as often |
| Industrial | dusty verge, stacked shipping containers, yellow/black hazard kerbs, street trees |
| Changi | a dense avenue of trees with pink bougainvillea blooms |

Trees are sized to overhang the footpath and kerb so they read at the
canvas edge. Vehicles are drawn live with body shading, glass, wheels,
mirrors and lights; about 15% of cars are taxis. Trucks and semis carry
red/white rear chevrons and side tape to show they're lethal. Police
cruisers are white with a chequered navy livery and a flashing red/blue
light bar (pursuers face up the screen, roadblock cars face down); a
pursuer still off-screen shows as a red/blue glow on the bottom edge, and
a wrecked cruiser is left charred and smoking. Bananas are curved yellow
peels with brown tips that spin out of a truck's back; a skid twists the
bus and pops a "SKID!" label. Coins spin, the bus's brake
lights come on when braking, fare pickups throw sparks and a "+$", hits
shake the screen and scatter debris, and the level banner fades in and out
across the road. The canvas is backed at `devicePixelRatio` (capped at 2)
so it stays sharp on high-DPI screens.

| State             | Behavior |
| ----------------- | -------- |
| Default           | Start screen over an idle road. |
| Loading           | Leaderboard shows "Loading leaderboard…" until its `load` request returns. |
| Empty             | Leaderboard: "No scores yet — be the first!" |
| Error             | Leaderboard: "Couldn't load the leaderboard."; the game still works. Storage unavailable: start screen notes progress won't be saved. |
| Success           | Submitting a score swaps in the refreshed leaderboard and disables the submit button. |

---

## HTMX Interactions

| Trigger                | Method | Endpoint               | Target                   | Swap        | Indicator |
| ---------------------- | ------ | ---------------------- | ------------------------ | ----------- | --------- |
| Page load              | GET    | `/bus-rush/leaderboard` | `#bus-rush-leaderboard` | `outerHTML` | `#bus-rush-leaderboard-loading` |
| Run Over "Submit"      | POST   | `/bus-rush/score`       | `#bus-rush-leaderboard` | `outerHTML` | `#bus-rush-leaderboard-loading` |

"Reset Progress" in the shop is destructive and asks `confirm()` first
(client-side only; it clears `localStorage`, never server data).

---

## Routes / Handlers

| Method | Path                    | Handler                    | Auth required | Notes |
| ------ | ----------------------- | -------------------------- | ------------- | ----- |
| GET    | `/bus-rush`             | `BusRushHandler.Index`       | no | Page shell; no DB read. |
| GET    | `/bus-rush/leaderboard` | `BusRushHandler.Leaderboard` | no | Top 20 fragment. |
| POST   | `/bus-rush/score`       | `BusRushHandler.SubmitScore` | no | Form-encoded `player_name`, `score`, `distance_meters`; rate-limited 5/min per client. |

---

## Data Model

`migrations/008_create_bus_rush_scores.sql`

| Table             | Column          | Type        | Constraints | Notes |
| ----------------- | --------------- | ----------- | ----------- | ----- |
| `bus_rush_scores` | `id`            | BIGINT identity | PK | |
|                   | `player_name`   | TEXT        | 1–20 chars | trimmed server-side |
|                   | `score`         | INT         | 0–999999   | |
|                   | `distance_meters` | INT       | 0–999999   | |
|                   | `created_at`    | TIMESTAMPTZ | default now() | |

Index on `score DESC` for the top-N query.

---

## Business Rules / Validation

All numbers live in `web/static/js/busrush/rules.js` and are tunable; the
*shape* is what's fixed:

* **Speed** (`stepSpeed`): between `minSpeed(level)` and
  `maxSpeed(engineLevel, level)` — the district raises both by
  `LEVEL_SPEED_STEP`. Holding up accelerates, down brakes (brake wins if
  both are held), neither holds speed. A hit resets speed to the current
  district's floor.
* **Traffic**: oncoming vehicles close in at the bus's speed *plus* their
  own (`TRAFFIC_SPEED`, one shared value so rows never drift into each
  other), so they arrive faster when the bus is faster. Spawns come in
  rows; a row never blocks all four lanes (`pickBlockedLanes`), so every
  row is passable. Rows get denser (`maxBlockedLanes`) and closer
  (`rowSpacingPx`, down to `ROW_SPACING_MIN`) with distance; vans unlock at
  300 m, trucks at 800 m, semis at 1500 m (`VEHICLES`).
* **Collisions** (`livesAfterHit`): a vehicle marked `lethal` in
  `VEHICLES` (truck, semi) or `POLICE_CAR` takes every life, even during
  post-hit grace; anything else takes one life, or none while grace is
  active. Bumpers therefore never save you from a truck or the police.
* **Bananas** (`bananaDrops`, `skidLane`): only lethal non-police vehicles
  (truck, semi) carry cargo; each is leaky with `BANANA_TRUCK_CHANCE` and
  then drops 1–2 bananas at rear heights within
  [`BANANA_DROP_MIN_Y`, `BANANA_DROP_MAX_Y`] (20–220 px), so every banana
  starts high enough on screen to be dodged. A dropped banana slides and
  spins briefly, then scrolls at the bus's speed (world-stationary). A skid
  always moves exactly one lane and never off the road. Bananas affect the
  bus and pursuing police (a banana is used up by whichever runs it over
  first), not oncoming traffic.
* **Fare placement** (`fareOffset`): a fare sits centred in the clear gap
  behind its row — between the tail of the vehicle in its lane (if any)
  and the next row's front — with `FARE_CLEARANCE` to spare. (It used to
  sit at a fixed half-spacing, which overlapped semis at tight spacing.)
  Fares and traffic scroll together, so clear at spawn stays clear; a unit
  test checks every vehicle length at every spacing.
* **Row spacing floor** must fit the longest vehicle (the semi), the bus,
  and one unupgraded lane change at top speed — a unit test enforces this,
  so adding a longer vehicle means raising `ROW_SPACING_MIN`.
* **Score** = `floor(distance) + fares × 25 + bonus` — speed pays via
  distance; the bonus is each wrecked cruiser's `policeWreckPoints(stars)`
  (50 × stars) plus each district's `checkpointPoints`.
* **Wanted** = `min(5, district + 1 + floor(fares / 10))`.
* **Tokens per run** = `fares × fareValue(fareBoxLevel) + floor(distance / 100) + wrecks × WRECK_TOKENS`.
* **Police** (`wantedLevel`, `policeSpeed`, `maxPolice`,
  `policeReactionSeconds`, `roadblockChance` in `rules.js`): pursuit speed
  is pegged to an unupgraded bus's top speed *in the current district*
  (`POLICE_PACE`, 80% at one star up to 96% at five), so a stock bus at
  full throttle always pulls away — slowly at high stars — and police
  catch you only when you brake or a hit drops you to the floor. (An
  earlier flat per-star speed outpaced the per-level speed-up, so by
  Heartland a stock bus could no longer outrun them.) The first cruiser
  arrives `POLICE_FIRST_SECONDS` into a run, later ones every
  `POLICE_SPAWN_SECONDS` up to `maxPolice` (1/1/2/2/3 by star). New
  pursuers spawn just below the screen, 130 px behind the bus's rear.
  Pursuers never overtake the bus (alongside at most), and are "lost"
  once far enough behind. Roadblocks (from `ROADBLOCK_MIN_DISTANCE`, 600 m;
  chance 6% per star above one) move at traffic speed and use
  `pickBlockedLanes`, so they keep the every-row-is-passable guarantee;
  roadblock rows carry no fare.
* **Upgrades**: cost grows per level (`upgradeCost`); every upgrade has a
  max level and the buy button disables at max or when tokens are short.
* **Leaderboard bounds** (server, mirrored by CHECK constraints): name
  trimmed and 1–20 runes; score and distance 0–999999.

---

## Security Considerations

* **Authz**: public, like the other game leaderboards.
* **Destructive actions**: Reset Progress confirms first; local only.
* **Input handling**: server validates bounds before insert; names are
  rendered via `html/template` escaping. Per-client in-memory rate limiter
  (`scoreSubmitLimiter`, shared with the other games). Same CSRF gap as the
  other score routes (no CSRF infra yet — see `PagesHandler.Logout`).
* **Secrets**: none.

---

## Testing Plan

* [x] `rules.test.js`: speed bounds (per Engine level and per district),
      lane-blocking never blocks all lanes, row spacing shrinks and floors
      and still fits a lane change at the fastest district's top speed,
      fares never overlap a vehicle, score/token formulas (incl. wreck
      bonus), upgrade costs/max, lethal vs. one-life hits, wanted level,
      police scaling (a stock bus at full throttle outruns every star in
      every district), roadblock chance, district progression and
      checkpoint points, banana drops (only trucks/semis, inside the drop
      window) and skids (always exactly one lane, never off the road).
* [x] Go: validation bounds, service rejects invalid input before the repo,
      handler empty/populated/escaped leaderboard, 400 on bad input, 429 on
      flood, error fragment on DB failure.
* [x] `cmd/server/e2e_test.go`: real round-trip through `bus_rush_scores`.
* [x] Playwright `e2e/bus-rush.spec.js` (Chromium + WebKit): overlays on
      load; a run starts and ↑ raises speed; crash → tokens → shop purchase
      persists across reload; trucks and semis are instant game over; a car
      costs one life; run-over → leaderboard submit; HTMX revisit still
      wires the game; a police ram is instantly "Busted!"; crossing 800 m
      enters level 2 (faster, higher wanted level, "2 · Heartland" on Run
      Over); a new level refills lives; at full throttle with no damage,
      level 2 police fall behind; running over a banana skids the bus one
      lane over, ignores steering mid-skid, and costs no life; a police car
      that runs over a banana skids one lane over. Plus
      `e2e/projects.spec.js`'s card tests.
* Test hooks (`window.__busRushTestHooks`, used only by tests): `crash()`,
  `spawn(kind)` (a vehicle in the bus's lane), `banana()` (one just ahead
  of the bus), `policeBanana()` (a non-re-aiming cruiser behind the bus
  with a banana at its nose), `policeRam()`,
  `warp(meters)`, `noTraffic()`, `snapshot()` (status, level, km/h, lane,
  skidding, bananas on the road, wanted, each pursuer's gap behind the
  bus, pursuer lanes, pursuers skidding), `grantTokens(n)`.

---

## Definition of Done

* [x] User flow works end-to-end.
* [x] All UI states implemented.
* [x] Reset Progress confirms.
* [x] Migration with working Down.
* [x] Handler/service/repository boundaries followed.
* [x] Keyboard and touch playable; overlays are focusable buttons.
* [x] Tests in the Testing Plan pass.
