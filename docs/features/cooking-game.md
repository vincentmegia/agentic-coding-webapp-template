# Feature: Kitchen Shift

## Status

`Shipped` — implemented and covered by tests: Go (validation/leaderboard,
`internal/service/cooking_validation_test.go`/`cooking_service_test.go`,
`internal/handler/cooking_game_test.go`), JS (`rules.js`/`engine-state.js`/
`floor-plan.js` via `node --test`), and a real-Postgres end-to-end subtest
in `cmd/server/e2e_test.go` ("kitchen shift routes round-trip through the
real cooking_scores table"). Manually verified in a real browser session:
start screen → floor plan → station interaction/hints → a full 20-shift
month (including both a clean-shift and an upset-shift payout) → Final
Paycheck → leaderboard submission round-trip, shop open/close, no console
errors. Recipe/gear/ramp magnitudes remain illustrative/tunable, as called
out throughout Business Rules and Open Questions — nothing in that tuning
blocks calling this Shipped, matching the Fishing Game's own precedent.

**Real bug found and fixed during manual verification**: `engine-state.js`'s
`cleanTable` only checked "are all tables clean now" as a side effect of
successfully cleaning an actually-dirty table — an idle shift (the shift
clock runs out with no order ever taken or served) starts `closing-clean`
with every table already clean, so there was never a dirty table to trigger
that check, and the shift soft-locked in `closing-clean` forever with
nothing left to interact with. Fixed by having `tick()` check
all-tables-clean itself at the moment it transitions out of `playing`,
skipping straight to `closing-dishes` when nothing needs cleaning — see
`allTablesClean()` in `engine-state.js`. Covered by a regression test in
`engine-state.test.js`.

No sprite art (Visual Direction's canvas-primitives-only v1 scope cut) and
on-screen touch controls remain open, tracked in Open Questions — neither
blocks desktop keyboard play, which is what v1 targets.

## Summary

A playable top-down restaurant sim at `/kitchen-shift`, set at a diner named
**Startime Diner**: the player works a series of shifts there, walking
between tables, the fridge, the cabinet, and the stove/oven to take orders,
gather ingredients, cook or bake dishes on a timed window, and serve them
before the customer's patience runs out. Every shift ends with a closing
sequence (clean the dirty tables, wash the dishes, shut the restaurant down,
then walk to the boss's office) where the boss hands over that shift's
paycheck — a flat 4,000 Gard, or only 2,000 Gard if a customer was upset
during the shift. The game runs for 20 shifts — "the month" — after which
the boss hands over a final paycheck, and the player can submit that
month's total Gard earned to a public leaderboard. Gard also funds an
upgrade shop between shifts (faster walking, more carrying capacity, easier
cook timing, more simultaneous tables, longer customer patience, faster
cleanup), persisted in `localStorage` across months.

## Problem / Motivation

Same motivation as the Fishing Game (`docs/features/fishing-game.md`'s
Problem / Motivation): CLAUDE.md names "Personal interests" as planned
content, and a second playful, just-for-fun mini-game continues filling that
gap rather than leaving the Fishing Game as a one-off. It also reuses and
validates the same architectural pattern (canvas game, `localStorage`
meta-progression, a small Postgres-backed public leaderboard) on a
meaningfully different gameplay shape — station-to-station movement and
order fulfillment instead of an auto-scrolling descent — so it's a real
second data point for that pattern rather than a reskin of the first game.

## Scope

**In scope:**

* A canvas-based top-down restaurant floor plan: player walks (arrow keys /
  WASD) between fixed stations — tables, fridge, cabinet, stove, oven, sink,
  a shutdown point, and the boss's office.
* An order system: tables periodically seat a customer with an order; walking
  up to an occupied table and interacting takes the order into an on-screen
  queue with a per-customer patience timer.
* Ingredient gathering: the fridge and cabinet each open a small picker of
  available ingredients; picked ingredients go into the player's limited
  carrying inventory.
* Cooking: walking to the stove or oven with the right ingredients and
  interacting starts a timed mini-game (a sweeping gauge) — a second
  interaction while the sweep is inside the success window finishes the
  dish; missing the window burns/ruins the ingredients and the player must
  re-gather and retry.
* Serving: carrying a finished dish to the table that ordered it fulfills
  the order. Serving the wrong dish, or a customer's patience running out
  first, upsets that customer — and even a single upset customer in a shift
  is enough to cut that whole shift's paycheck in half (see Business Rules).
* A shift clock: new customers/orders stop spawning at zero, any orders still
  queued are auto-failed, and the shift moves into its closing sequence.
* A four-step closing sequence, in order: clean every dirty table, wash the
  dishes at the sink, walk to the shutdown point (e.g. the light
  switch/register) and shut the restaurant down, then walk to the boss's
  office to collect that shift's paycheck.
* A paycheck screen after every shift: whether any customer was upset, this
  shift's Gard payout (4,000 or 2,000), and the running month-to-date Gard
  total. Offers "Open Shop" and "Start Next Shift."
* 20 shifts = one month. Difficulty ramps across shifts (more simultaneous
  tables, faster customer arrival, shorter patience, more recipe variety
  unlocked in bands) mirroring the Fishing Game's depth-based ramp.
* Shift 20's paycheck screen becomes the "Final Paycheck of the Month": a
  month summary, an optional "Submit to leaderboard" name field, and "Start
  New Month" (shop upgrades persist; the month total resets to 0).
* A gear-style upgrade shop (persisted in `localStorage`, same shape as
  Fishing Game's): walking speed, carrying capacity, cook-timing forgiveness,
  simultaneous table capacity, customer patience, and dish/table cleanup
  speed — all aimed at avoiding an upset customer, since Gard-per-shift is
  otherwise flat (see Business Rules).
* A small public leaderboard (Postgres-backed): top monthly Gard totals
  across all visitors, submitted voluntarily at month-end with a
  self-chosen display name.
* Mid-month resumability: current shift number, month-to-date Gard, and
  shop levels persist in `localStorage` across a page reload — a player who
  closes the tab mid-month resumes at the start of their current shift
  rather than losing the whole month (unlike the Fishing Game's much
  shorter, fully-ephemeral single round — see Business Rules).
* Hand-authored SVG illustrations for ingredients, dishes, customers, and
  station furniture, matching the flat/simple illustrative style already
  used for the Fishing Game and landing carousel.

**Out of scope (v1):**

* Nav/`/projects`/landing-page integration. The Fishing Game itself shipped
  reachable only at its own URL first, then got a `/projects` card and a
  landing "Selected work" card in separate follow-up passes (see that
  feature's Status note and this repo's commit history) — this feature
  follows the same order. `/kitchen-shift` is fully playable via direct URL
  from v1; wiring it into nav/projects/landing is a likely fast-follow, not
  bundled into this doc.
* Server-authoritative gameplay / real anti-cheat — same accepted limitation
  as the Fishing Game (Security Considerations below).
* Visitor accounts, cross-device sync, or any server-side persistence of an
  individual player's Gard/shop levels/history beyond the opt-in
  leaderboard row. `localStorage` only.
* Multiplayer or real-time interaction between players.
* Sound design (music/SFX).
* Mobile-native app packaging.
* More than one restaurant "map" or station layout — one fixed floor plan
  for v1.

---

## User Flow

```text
1. User navigates to /kitchen-shift. Page loads: a start screen shows current
   month-to-date Gard (0 if starting a new month), shop levels, best month
   total (read from localStorage), the leaderboard fragment, and a "Start
   Shift" button. If localStorage shows a shift already in progress
   (mid-month resume), the button instead reads "Resume Shift {n}".
2. User clicks "Start Shift". The floor plan renders: fridge, cabinet, stove,
   oven, sink, a row of tables, the (locked) boss's office door, and the
   player character near the entrance. A HUD overlays the canvas: shift
   number (n/20), shift clock, this shift's status (no customer upset yet
   vs. upset), and the order queue.
3. Customers begin seating themselves at tables at intervals (faster in
   later shifts). Walking up to an occupied table and interacting takes its
   order into the queue, showing the requested dish and a patience timer.
4. Player walks to the fridge or cabinet, interacts to open its ingredient
   picker, and picks up the ingredients a queued order's dish requires (each
   dish's recipe is a small fixed ingredient list — see Business Rules).
   Carrying capacity is limited (upgradeable).
5. Player walks to the stove or oven (whichever the dish needs) with the
   right ingredients and interacts to start cooking: a sweeping gauge
   mini-game plays, and a second interaction while the sweep is inside the
   success zone finishes the dish; missing the zone entirely burns/ruins the
   ingredients, which must be re-gathered from scratch.
6. Player carries the finished dish to the table that ordered it and
   interacts to serve — the order clears from the queue, and the table (and
   the dish it was served on) becomes dirty. Serving the wrong dish to a
   table is rejected — the dish is wasted and that customer is now upset. A
   customer whose patience timer expires before being served also leaves
   upset, and still leaves the table dirty.
7. When the shift clock hits zero, no further customers seat themselves and
   any still-queued orders auto-fail (upsetting those customers too). The
   floor plan switches into closing mode: every dirty table shows a mess
   indicator, and the sink shows the shift's stack of dirty dishes.
8. Player walks to each dirty table and interacts to clean it, then to the
   sink to wash the accumulated dishes. Once every table is clean and the
   dishes are washed, the shutdown point (near the entrance) becomes
   interactive; the player walks there and interacts to shut the restaurant
   down. Only then does the boss's office door unlock; the player walks
   there and interacts to receive the shift's paycheck.
9. A paycheck screen shows whether any customer was upset this shift, the
   shift's Gard payout (4,000 if no one was upset, 2,000 if at least one
   was), and the running month-to-date total. Buttons: "Open Shop" and
   "Start Next Shift" (shifts 1-19), or, on shift 20, "See Final Paycheck"
   instead of "Start Next Shift."
10. In the shop (reachable from the start screen or any paycheck screen), the
    player spends month-to-date Gard leveling up gear; buying deducts the
    cost immediately and applies starting the next shift.
11. After shift 20's paycheck, the Final Paycheck screen instead shows the
    full month's Gard total, an optional "Submit to leaderboard" name field,
    and "Start New Month" (shop levels persist; month-to-date Gard resets to
    0, shift counter resets to 1).
12. User can navigate away at any time. Shop levels and month-to-date
    Gard/shift-number persist via localStorage (mid-month resume, see
    Scope); an in-progress shift itself (orders in flight, floor-plan state)
    is not saved mid-shift and restarts fresh at that shift's beginning on
    return.
```

---

## Visual Direction

Follows `tailwind-ui`'s Visual Style principles; specifics for this feature:

* The canvas game scene (floor plan, player, customers, stations) uses its
  own fixed warm "diner" palette regardless of site light/dark mode, the
  same reasoning as the Fishing Game's fixed ocean palette — a game scene
  commits to one look. The HUD, start screen, shop, and leaderboard chrome
  around the canvas fully follow the site's dark mode.
* The restaurant is named **Startime Diner** — the name appears in the page
  heading/start screen and paycheck-screen copy (e.g. "Startime Diner —
  Shift {n}"), not just an internal label.
* The boss is named **Duke** — the boss's-office interaction hint and the
  paycheck screen refer to him by name (e.g. "Duke hands you 4,000 Gard"),
  not just "the boss."
* Top-down, flat/simple shape language matching the Fishing Game's sprites.
  **v1 renders every station, ingredient, and dish as a canvas-drawn
  primitive (a colored rounded rect/circle) plus a short text label**, not
  loaded sprite images — a deliberate scope cut, not an oversight: the
  Fishing Game itself shipped flat colored circles first and added real
  SVG sprites in a later pass (`docs/features/fishing-game.md`'s Status
  note), and this feature follows that same "ship the working mechanic
  first" precedent. Swapping in real hand-authored SVG art (one icon per
  ingredient/dish/station) is a follow-up, tracked in Open Questions, not
  required for v1's mechanics to work.
* The order queue and patience timers use a monospace/tabular-figure
  treatment for the same reason as the Fishing Game's HUD numbers.
* Later-shift dishes (Business Rules' recipe table) read as visually
  "richer" (warmer accent, slightly more detail) than early ones, mirroring
  the Fishing Game's higher-value fish, even though — unlike fish — dishes
  no longer carry a point value themselves (see Business Rules' Shift
  paycheck rule); it's purely a progression/flavor cue.
* Station interaction range is communicated with a subtle highlight/glow on
  the nearest interactable station as the player walks close enough to use
  it, since there's no natural "hook touches sprite" collision moment the
  way the Fishing Game has — the player needs a clear affordance for "you
  can interact here."
* The HUD's shift-status indicator (Business Rules) reads clearly at a
  glance as "still going well" vs. "a customer got upset" — e.g. a
  simple two-state icon/color, not a number, since the underlying rule
  itself is binary.

---

## UI

```text
web/templates/
├── pages/
│   └── cooking-game.html         # canvas + HUD + start/paycheck/shop overlays
└── components/
    ├── cooking-shop.html         # gear upgrade list (level, effect, cost, buy button)
    └── cooking-leaderboard.html  # top-N monthly totals fragment (also the HTMX partial)

web/static/
├── images/cooking/                # not populated in v1 — see Visual Direction's sprite-image note
└── js/
    ├── cooking-game.js           # canvas game loop, input, localStorage progress
    └── cooking/
        ├── rules.js               # pure: recipes, cook-timing success zone, paycheck rule, shift ramp
        ├── engine-state.js        # pure: order queue, inventory, shift phase transitions (incl. closing steps)
        └── floor-plan.js          # pure: station positions, interaction-radius checks
```

States this feature's UI must handle:

| State                        | Behavior |
| ----------------------------- | -------- |
| Start screen                   | Shows month-to-date Gard/shop levels/best month from `localStorage`, shop entry point, leaderboard, "Start Shift" (or "Resume Shift {n}"). |
| Playing — floor plan            | Canvas game loop running; HUD (shift clock, shift status, order queue) updates every frame. |
| Cooking mini-game               | Sweeping gauge overlay while a cook/bake action is active. |
| Order missed / customer leaves  | Brief visual feedback (customer sprite leaves, table marked dirty); shift status flips to "upset". |
| Wrong dish served               | Brief rejection feedback; dish removed from inventory; shift status flips to "upset". |
| Closing — cleaning tables        | Dirty tables show a mess indicator; sink/shutdown point inactive until all tables clean. |
| Closing — washing dishes          | Sink interactive once tables are clean; shows remaining dirty-dish count; shutdown point inactive until washed. |
| Closing — shut down              | Shutdown point interactive only once tables are clean and dishes are washed. |
| Boss's office                   | Door interactive only once shutdown is complete. |
| Paycheck screen                 | Upset/no-upset outcome, this shift's Gard payout, month-to-date total, "Open Shop" / "Start Next Shift". |
| Final paycheck (shift 20)        | Month summary, "Submit to leaderboard" field, "Start New Month". |
| Shop                             | Upgrade list, affordable vs. too-expensive visually distinguished; buying disabled once balance can't cover next level. |
| Leaderboard loading              | Local loading indicator while the fragment fetches. |
| Leaderboard empty                | "No scores yet — be the first!" |
| Leaderboard error                | Generic "couldn't load the leaderboard" message; rest of page still works. |
| `localStorage` unavailable       | Game still fully playable for the session; progress resets to defaults each visit, small notice explains why — never a hard error. |
| Reduced motion                   | Gameplay canvas itself can't fully honor `prefers-reduced-motion` (movement is the mechanic), but all surrounding UI transitions (shop, paycheck screens) do. |
| No loaded sprite images (v1)      | N/A in v1 — every station/ingredient/dish renders as a canvas primitive + text label, so there's no image-load/failure state to handle yet (Visual Direction). Revisit once real sprite art lands. |

---

## HTMX Interactions

Same division of responsibility as the Fishing Game: the game loop itself
(canvas rendering, input, station interaction, cooking, `localStorage`) is
not modeled as HTTP requests (`htmx-ui`'s scoped exception). HTMX covers page
navigation and the leaderboard.

| Trigger                              | Method | Endpoint                    | Target                     | Swap        | `hx-push-url` | Indicator              |
| -------------------------------------- | ------ | ----------------------------- | ----------------------------- | ----------- | -------------- | ------------------------ |
| Nav → Kitchen Shift                     | GET    | `/kitchen-shift`               | `#main-content`               | `outerHTML` | `true`         | `#nav-loading`           |
| Page load (leaderboard fragment)         | GET    | `/kitchen-shift/leaderboard`   | `#cooking-leaderboard`        | `innerHTML` | n/a            | `#leaderboard-loading`   |
| "Submit to leaderboard" (final paycheck)  | POST   | `/kitchen-shift/score`         | `#cooking-leaderboard`        | `outerHTML` | n/a            | `#leaderboard-loading`   |

`POST /kitchen-shift/score` returns the same leaderboard fragment
(`cooking-leaderboard.html`), re-rendered with the new entry included if it
placed.

Confirmation required for destructive actions:

* "Reset progress" (shop screen, clears local Gard/shop levels/best
  month/in-progress shift) uses a native `confirm()` prompt before clearing
  `localStorage` — same reasoning as the Fishing Game's equivalent: local-only
  state, but irreversible from the player's point of view.

---

## Client-side Behavior (non-HTMX)

`cooking-game.js` (one external file, no inline `<script>` tags, per this
site's CSP):

* **Game loop**: `requestAnimationFrame`-driven canvas rendering of the
  floor plan, player movement, customer/order state, cook-timing gauge, HUD.
  Pauses automatically on `visibilitychange`, same as the Fishing Game.
* **Movement and interaction**: arrow keys / WASD move the player at a
  capped speed (boosted by the Running Shoes upgrade) around fixed station
  positions (`floor-plan.js`, a pure module — station coordinates and
  "is the player within interaction range of station X" checks, unit-tested
  independent of canvas rendering the same way `world-scroll.js` is for the
  Fishing Game). A single interact key (e.g. space/enter) acts on whichever
  station is currently in range, resolved once per frame; if the player is
  in range of more than one station at once (shouldn't normally happen given
  station spacing, but not physically prevented), the nearest one wins.
* **Order queue, upset tracking, and shift phases**: `engine-state.js`
  (pure, no DOM/canvas access) owns the order queue — adding an order,
  ticking down patience timers, auto-failing an expired order — plus a
  single `shiftUpset` boolean that latches `true` the moment any order is
  missed or the wrong dish is served, and the shift-phase state machine
  (`playing` → `closing-clean` → `closing-dishes` → `closing-shutdown` →
  `paycheck`). Mirrors the Fishing Game's `engine-state.js` role for round
  state.
* **Cooking mini-game**: a sweeping gauge (0 to 1, ping-ponging) starts on
  interacting with a stove/oven while holding the right ingredients; a
  second interact press samples the gauge's current position against the
  dish's success zone (`rules.js`) — inside it, the dish finishes; outside
  it, the ingredients are ruined. Sweep speed and the zone's width are pure
  functions of shift number and the Sharp Knife gear level, so they're
  unit-testable the same way `descentSpeed()` is for the Fishing Game.
* **Sprite image rendering**: same pattern as the Fishing Game's — an
  in-memory `Map` cache keyed by sprite variety, `Image` objects created and
  assigned `src` once per variety, falls back to a flat colored shape if not
  yet loaded/failed, never blocks the game loop.
* **Progress persistence**: a single `localStorage` key (e.g.
  `cooking-game:v1`) holding `{monthToDateGard, currentShift, gear:
  {...levels}, bestMonthTotal}`. Versioned key name, same rationale as the
  Fishing Game's save key.
* **Reduced motion**: same accepted gap as the Fishing Game — gameplay
  canvas can't fully honor the preference, but every non-gameplay transition
  (shop, paycheck screens) does.
* **Cleanup**: loop torn down (canceled `requestAnimationFrame`, listeners
  removed) on HTMX nav-away, not just full page unload.

---

## Routes / Handlers

| Method | Path                          | Handler                            | Auth required | Notes |
| ------ | ------------------------------- | ------------------------------------- | ------------- | ----- |
| GET    | `/kitchen-shift`                 | `CookingGameHandler.Index`            | no            | Page shell; leaderboard fragment loads via its own request. |
| GET    | `/kitchen-shift/leaderboard`     | `CookingGameHandler.Leaderboard`      | no            | Returns top-N monthly-total scores fragment. |
| POST   | `/kitchen-shift/score`           | `CookingGameHandler.SubmitScore`      | no            | Validates and inserts a leaderboard entry; returns the refreshed fragment. Rate-limited. |

---

## Data Model

```sql
-- migrations/003_create_cooking_scores.sql
CREATE TABLE cooking_scores (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    player_name      TEXT NOT NULL,
    total_earnings   INT NOT NULL,
    shifts_completed INT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cooking_scores_player_name_length CHECK (char_length(player_name) BETWEEN 1 AND 20),
    CONSTRAINT cooking_scores_earnings_range CHECK (total_earnings BETWEEN 0 AND 100000),
    CONSTRAINT cooking_scores_shifts_range CHECK (shifts_completed BETWEEN 1 AND 20)
);

CREATE INDEX idx_cooking_scores_earnings ON cooking_scores (total_earnings DESC);
```

| Table            | Column             | Type          | Constraints                | Notes |
| ------------------ | -------------------- | --------------- | ----------------------------- | ----- |
| `cooking_scores`   | `id`                  | `BIGINT`        | PK, identity                   | |
| `cooking_scores`   | `player_name`         | `TEXT`          | not null, 1–20 chars           | Self-chosen display name, rendered on the public leaderboard. |
| `cooking_scores`   | `total_earnings`      | `INT`           | not null, `0..100000`          | Gard, not dollars. A legitimate month totals `shifts_completed × (2000 or 4000)` — max 80,000 over 20 shifts — but the DB check stays a coarse sanity bound rather than re-deriving that exact formula server-side (Security Considerations). |
| `cooking_scores`   | `shifts_completed`    | `INT`           | not null, `1..20`              | Always 20 for a full month; column exists in case a future revision allows earlier submission. |
| `cooking_scores`   | `created_at`          | `TIMESTAMPTZ`   | not null, default `now()`      | |

Month-to-date Gard, shop levels, current shift number, and best month total
are **not** stored in Postgres — `localStorage` only, same reasoning as the
Fishing Game (no visitor identity to key server-side state on).
`cooking_scores` is the only server-side table this feature adds, and holds
only voluntarily-submitted, already-finished month results.

---

## Business Rules / Validation

* **Recipes, gated by shift band** (illustrative — tune during build, same
  status the Fishing Game's fish/hazard tables started at before their own
  playtesting pass). Dishes carry no individual point value — see the Shift
  paycheck rule below for why:

  | Shift range | Dish              | Station | Ingredients                      |
  | ------------- | ------------------- | --------- | ----------------------------------- |
  | 1–5             | Garden Salad          | none (cabinet/fridge only) | Lettuce + Tomato        |
  | 1–5             | Grilled Cheese         | Stove     | Bread + Cheese                       |
  | 6–10            | Burger                 | Stove     | Bun + Patty + Lettuce                 |
  | 6–10            | Pancakes                | Stove     | Flour + Egg + Milk                    |
  | 11–15           | Roast Chicken           | Oven      | Chicken + Herbs                       |
  | 11–15           | Pasta                   | Stove     | Noodles + Sauce                       |
  | 16–20           | Steak Dinner            | Stove     | Steak + Potato + Herbs                |
  | 16–20           | Soufflé (signature)      | Oven      | Egg + Cheese + Flour                  |

  A dish's ingredients come from the Fridge (cold: Cheese, Milk, Chicken,
  Patty, Steak, Lettuce, Tomato, Egg) or the Cabinet (dry: Bread, Flour,
  Noodles, Herbs, Buns, Sauce, Potato). Which dishes customers can order is
  drawn only from bands unlocked up to the current shift, same "grows, never
  shrinks" shape as the Fishing Game's fish-band gating.
* **Cook-timing is a binary success zone**, not a graded quality tier: the
  sweeping gauge has one "success" window — a second interaction while the
  sweep is inside it finishes the dish; anywhere outside it burns/ruins the
  ingredients (0 value, must re-gather). Sharp Knife gear widens the success
  window per level. Sweep speed scales up slightly with shift number, the
  cooking-side equivalent of descent speed ramping with depth in the Fishing
  Game.
* **Shift paycheck (final, not illustrative)**: every shift pays a flat
  4,000 Gard *unless* `shiftUpset` latched `true` at any point that shift —
  a missed order (patience expired) or a wrong-dish serve — in which case
  the boss pays only 2,000 Gard instead, regardless of how many other
  customers were served correctly. This is a single binary outcome per
  shift, not a per-dish or per-upset scaling number: one upset customer
  costs exactly as much as five. The tension this creates is "get through
  the whole shift without a single upset," not "maximize a running dollar
  total" — a deliberately simpler economy than the Fishing Game's
  points-and-multipliers scoring, matching how directly this was specified.
* **Startime Diner is card-only, no cash** — flavor about how the diner's
  *customers* pay for their meals, unrelated to the player's own Gard
  paycheck from the boss (which is just how much they're paid for the
  shift, not tied to any individual bill). No gameplay mechanic hangs off
  this; it may show up as ambient copy/UI (e.g. a card-reader prop at each
  table) but never as a distinct interaction.
* **Wrong-dish serves and missed orders** cost the wasted dish/ingredients
  and time, and latch that shift's `shiftUpset` flag (see Shift paycheck
  above) — but never end the shift or the month early. This game is
  lower-stakes than the Fishing Game by design (a workplace shift, not a
  survival descent): the tension is finishing the shift clean, not
  avoiding a game-over state.
* **Shift clock and ramp**: each shift runs on a fixed countdown
  (illustrative, tune during build); customer arrival rate increases and
  patience timers shorten as shift number increases, and simultaneous
  active tables/orders is capped by both physical table count and the
  Extra Table Service gear level, whichever is lower.
* **Closing sequence order is enforced**, matching the explicit
  clean → wash dishes → shut down → get paid order from the feature
  request, not a cosmetic sequence the player could skip or reorder: the
  sink isn't interactive until every table is clean, the shutdown point
  isn't interactive until the sink's dirty-dish stack (one dish per serve —
  successful, wrong, or missed doesn't matter, a dish or pan still got used
  — accumulated that shift) is fully washed, and the boss's office door
  isn't interactive until shutdown is complete.
* **Gear upgrades** (illustrative costs/magnitudes, same "tune during build"
  status as the recipe table above), 5 levels each, cost curve
  `round(baseCost × costGrowth ^ currentLevel)`. Every upgrade here targets
  avoiding an upset customer or getting through closing faster — there's no
  "earn more Gard per dish" upgrade, since a shift's payout is flat
  regardless of performance beyond the upset/no-upset outcome (Shift
  paycheck rule above):

  | Gear                 | Effect per level                                    |
  | ---------------------- | ------------------------------------------------------ |
  | Running Shoes            | +15% walking speed                                        |
  | Bigger Tray              | +1 carried ingredient slot                                 |
  | Sharp Knife               | Widens the cook-timing success zone                        |
  | Extra Table Service        | +1 simultaneous active table/order slot                    |
  | Regular's Patience          | +patience-timer duration per customer                      |
  | Quick Clean                | Reduces per-table cleaning and dish-washing time            |

* **Mid-month resume**: month-to-date Gard, current shift number, and shop
  levels persist across a reload; an in-progress shift's floor-plan state
  (order queue, inventory, table/dish cleanliness, the `shiftUpset` flag)
  does not — returning mid-shift restarts that shift from its beginning,
  same forfeiture principle as the Fishing Game's abandoned-round rule, just
  scoped to one shift instead of the whole run since a month is a much
  longer investment to fully discard.
* **Leaderboard**: top N (e.g. 20) by `total_earnings`, descending;
  submission is optional and only offered on the Final Paycheck screen
  (shift 20), never automatic, never mid-month.

---

## Security Considerations

* **Authz**: none required — public, anonymous feature like the rest of the
  unauthenticated site.
* **Input handling**: `player_name` goes through `html/template` auto-escaping
  like the Fishing Game's leaderboard; trimmed and bounds-checked
  server-side, not just via the DB constraint.
* **Untrusted score submissions**: gameplay is entirely client-side, so
  `POST /kitchen-shift/score` trusts the client's reported
  `total_earnings`/`shifts_completed`. Mitigated with the same sanity-bound
  approach as the Fishing Game (DB-matching range checks in the handler),
  not full replay validation, and deliberately not re-deriving/enforcing the
  exact `shifts_completed × (2000 or 4000)` formula server-side either —
  accepted limitation for a stakes-free arcade leaderboard.
* **Abuse / spam**: `POST /kitchen-shift/score` rate-limited (e.g. per-IP).
* **Test cleanup discipline**: any e2e test that submits a real score must
  delete its own row after asserting against it — the Fishing Game's e2e
  suite shipped without this once and left junk rows on the real
  leaderboard (`docs/features/fishing-game.md`'s Security Considerations);
  this feature's e2e test must not repeat that.
* **CSRF**: `POST /kitchen-shift/score` covered by the app's CSRF protection.
* **Secrets**: none introduced.
* **No inline `<script>` tags** — `cooking-game.js` is external, per CSP.

---

## Testing Plan

* [ ] Recipe/dish lookup returns the correct ingredient list for every dish;
      a shift number only unlocks dishes in bands up to and including its
      own band.
* [ ] Cook-timing success check: a sample inside the success zone finishes
      the dish, a sample outside it (both before and after the zone) ruins
      it; Sharp Knife level widens the zone monotonically.
* [ ] Shift paycheck rule: `shiftUpset === false` for the whole shift → 4,000
      Gard; `shiftUpset` latched `true` at any point (whether from one
      missed order or several) → 2,000 Gard for that shift, never lower and
      never scaled by how many upsets occurred.
* [ ] Order queue: adding an order respects the current table-capacity cap
      (physical tables vs. Extra Table Service level, whichever is lower);
      a patience timer reaching zero auto-fails that order, marks the table
      dirty, and latches `shiftUpset` — without needing player input.
* [ ] A wrong-dish serve latches `shiftUpset`, wastes the dish, and does not
      clear the order from the queue (the customer is still waiting).
* [ ] Shift-phase state machine (`engine-state.js`): `playing` only
      transitions to `closing-clean` when the shift clock hits zero;
      `closing-clean` only transitions to `closing-dishes` once every table
      is clean; `closing-dishes` only transitions to `closing-shutdown` once
      the sink's dirty-dish stack is fully washed; `closing-shutdown` only
      transitions to `paycheck` after the shutdown action fires — each gate
      is independently unit-tested, not just the happy path through all
      four.
* [ ] `floor-plan.js`: interaction-range checks correctly report in/out of
      range for each station at representative player positions, and the
      nearest-station tie-break resolves deterministically.
* [ ] Shift-to-shift ramp (customer arrival rate, patience duration, sweep
      speed) moves in the documented direction as shift number increases,
      unit-tested at representative shift numbers.
* [ ] Month total accumulates correctly across shifts (sum of each shift's
      4,000/2,000 payout) and resets to 0 on "Start New Month" while shop
      gear levels persist.
* [ ] `localStorage` progress (Gard, shift number, gear) persists across a
      page reload; corrupted or missing data falls back to defaults without
      an error.
* [ ] `POST /kitchen-shift/score` rejects out-of-range earnings/shift-count
      and oversized/blank `player_name` with a clear validation error.
* [ ] `player_name` containing HTML/script-like content renders as literal
      text on the leaderboard (auto-escaping regression test).
* [ ] Leaderboard fragment renders correctly empty, populated, and on a
      simulated fetch error.
* [ ] Rate limiting on `POST /kitchen-shift/score` rejects rapid repeated
      submissions from the same source.
* [ ] `e2e/`: nav → Kitchen Shift → play through a full shift with zero
      upsets (deterministic test mode as needed) → closing sequence (clean →
      wash → shut down) → boss's office → paycheck screen shows 4,000 Gard →
      shop purchase reflected next shift.
* [ ] `e2e/`: play a shift that includes one missed or wrong-served order →
      paycheck screen shows 2,000 Gard instead of 4,000.
* [ ] `e2e/`: play all 20 shifts (or a fast-forward test hook) → Final
      Paycheck screen → submit score → leaderboard shows the new entry →
      test cleans up its own row.
* [ ] No console errors (including no CSP violations) on `/kitchen-shift`.

---

## Open Questions

* Exact shift-clock duration and customer arrival/patience curves are all
  illustrative and need a real playtesting pass before being called final,
  the same status the Fishing Game's numbers started at.
* Whether `/kitchen-shift` needs its own on-screen touch controls for
  mobile/touch viewports the way the Fishing Game does, given this game
  needs an explicit "interact" action in addition to movement (not just
  directional steering) — likely yes, but the control scheme (virtual
  d-pad + a button vs. tap-to-walk-to-station) isn't decided.
* Whether nav/`/projects`/landing-page integration (deliberately out of
  scope for v1, see Scope) happens as an immediate fast-follow or waits
  indefinitely, same open-ended status the Fishing Game's own nav placement
  has been through multiple revisions of.
* **Resolved**: dish washing is one interaction that clears the whole
  shift's stack at once — implemented as a hold-to-complete action (hold
  Space at the sink), with Quick Clean gear reducing the required hold
  duration, matching table cleaning's same hold mechanic. Not scaled to
  the number of dishes accumulated.
* Real hand-authored SVG sprite art (ingredients/dishes/stations),
  deliberately deferred out of v1 in favor of canvas-drawn primitives +
  text labels (Visual Direction) — left open the same way the Fishing
  Game's own flat-circle-to-real-sprite upgrade was, rather than blocking
  v1 on art production.

---

## Definition of Done

* [ ] User flow works end-to-end, including edge cases above (missed order,
      wrong-dish serve, mid-month resume, full 20-shift month, final
      paycheck submission).
* [ ] All states in the UI table are implemented.
* [ ] Migration written, reviewed, and includes a working `Down`.
* [ ] Handler/service/repository boundaries followed (`go-backend`) for the
      leaderboard routes.
* [ ] `player_name` is rendered through `html/template` auto-escaping, with a
      passing XSS-regression test.
* [ ] `POST /kitchen-shift/score` is rate-limited and CSRF-protected.
* [ ] No inline `<script>` tags; CSP-clean on load.
* [ ] `cooking-game.js` cleans up its `requestAnimationFrame` loop and
      listeners on HTMX nav-away, not just on full page unload.
* [ ] Accessibility checked for all non-canvas UI (keyboard, focus, contrast,
      semantic HTML); the deliberate `prefers-reduced-motion` gap (gameplay
      canvas) is documented, not accidental.
* [ ] Tests cover the behavior in the Testing Plan above.
* [ ] No open questions remain unresolved (or remaining ones are explicitly
      accepted as implementation-time tuning, not design gaps).
