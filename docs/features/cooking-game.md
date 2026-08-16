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

**v2 redesign** — the user tried v1 and reported keyboard movement not
responding, and separately asked for a different control scheme entirely
(point-and-click, matching how they described wanting to interact with the
fridge/stations), plus a long list of world-building and scope requests in
the same session. Rather than debug the keyboard input path, controls were
replaced outright with click-to-move/click-to-interact (see Client-side
Behavior) — this also resolves the open question about touch controls,
since clicks and taps are the same pointer event. Also shipped in this
pass:

* **30 tables** (up from 4), a much bigger 960x600 floor plan (up from
  480x480) — "make the game bigger" — with a Cookware Closet (Pan/Baking
  Tray/Rice Cooker; every Stove dish needs a Pan, every Oven dish a Baking
  Tray, picked up once and kept for the rest of the shift), the Sink
  restyled as a **Cleaning Closet**, and every closet/fridge/cabinet/boss's-
  office station now renders as a door that visually opens while its panel
  or action is active.
* A **pixel-art visual treatment**: the canvas renders at a fixed, modest
  internal resolution and is scaled up with `image-rendering: pixelated`
  (a real CSS class, not an inline `style` — see the CSP bug note below),
  giving the flat color-block primitives a blocky, retro look without
  needing hand-drawn sprite assets.
* A **Fullscreen** toggle on the game container (native Fullscreen API).
* A **front counter** fixture (replacing the old plain "shutdown" box) and
  a stationary **security guard** figure near the entrance — the latter is
  cosmetic only, not an interactive station (see Business Rules).
* An **in-game restaurant clock** (8:30 AM–11:30 PM) replacing the HUD's
  mm:ss countdown — the same underlying shift-clock seconds, just
  formatted as a time of day (`rules.js`'s `inGameTimeLabel`).
* Three recurring/scripted customers, layered on top of the normal random
  arrival pool (Business Rules has the full rundown): **Mel**, sweet and
  kind, always the first customer seated every shift, with her own usual
  order and extra patience; **Olive & Oliver**, an engaged couple who
  always arrive together right after Mel, sharing one table and one order;
  and **Karen**, a one-time disruptive customer on shift 12, with a short
  fuse whose failure ripples into upsetting one other table too.

**Real CSP bug found and fixed during manual verification**: an inline
`style="image-rendering: pixelated"` on the canvas and an inline
`style="width: 0%"` on the cook-gauge fill bar were both silently blocked
by this site's strict CSP (`default-src 'self'`, no `style-src`
exception — `internal/middleware/middleware.go`) — console showed "Applying
inline style violates the following Content Security Policy directive."
Fixed by moving the static pixelation rule into a real CSS class
(`.pixel-canvas` in `app.css`) and the static zero-width default into a
Tailwind class (`w-0`); the gauge fill's *dynamic* width update still uses
`element.style.width = ...` from JS, which is CSSOM property assignment,
not an HTML `style` attribute, and is unaffected by this CSP — the same
pattern `carousel.js` already used safely for `.style.display`/
`.style.transitionDuration`.

Manually re-verified end-to-end in a real browser after the redesign:
click-to-move across the 30-table floor, station panels (fridge/cabinet/
cookware closet) opening on arrival, gathering + cooking + serving,
Mel's guaranteed first appearance with her patience bonus and thank-you
line, Olive & Oliver's guaranteed second appearance and shared order, the
full closing sequence via a real click on the boss's office door, and zero
console errors throughout.

## Summary

A playable top-down, click-controlled restaurant sim at `/kitchen-shift`,
set at a diner named **Startime Diner**: across an 8:30 AM–11:30 PM shift,
the player clicks tables to take orders, clicks the fridge/cabinet/cookware
closet to gather ingredients and cookware, and clicks the stove/oven to
cook — the player automatically walks to whatever's clicked and interacts
with it. Every shift ends with a closing sequence (clean the dirty tables,
wash the dishes at the Cleaning Closet, shut the restaurant down at the
front counter, then walk to the boss's office) where Duke hands over that
shift's paycheck — a flat 4,000 Gard, or only 2,000 Gard if a customer was
upset during the shift. The game runs for 20 shifts — "the month" — after
which Duke hands over a final paycheck, and the player can submit that
month's total Gard earned to a public leaderboard. Gard also funds an
upgrade shop between shifts (faster walking, more carrying capacity, easier
cook timing, more simultaneous tables out of a 30-table dining room, longer
customer patience, faster cleanup), persisted in `localStorage` across
months. The floor plan renders in a blocky, pixel-art style and can go
fullscreen; a security guard stands watch by the door, and alongside the
normal rotation of random diners, three recurring characters show up —
sweet regular Mel (always first), engaged couple Olive & Oliver (always
right after her), and, on shift 12 only, a demanding one-off customer
named Karen.

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

* A canvas-based top-down restaurant floor plan, 960x600, rendered
  pixel-art style: **click-only controls** — click empty floor to walk
  there, click a station (a table, the fridge, the stove, anywhere) and the
  player walks over and automatically interacts with it on arrival. Fixed
  stations: 30 tables (a 6x5 grid), the fridge, cabinet, cleaning closet,
  cookware closet, stove, oven, a front counter, and the boss's office.
* An order system: tables periodically seat a customer with an order;
  walking up to (clicking) an occupied table takes the order into an
  on-screen queue with a per-customer patience timer.
* Ingredient gathering: clicking the fridge or cabinet walks the player
  over and opens a picker panel of that station's items; clicking an item
  in the panel adds it to the player's limited carrying inventory.
* Cookware: a dedicated Cookware Closet (Pan, Baking Tray, Rice Cooker),
  same click-to-open-panel pattern as the fridge/cabinet — every Stove
  dish needs a Pan and every Oven dish needs a Baking Tray, acquired once
  and kept for the rest of the shift (not consumed per dish).
* Cooking: walking to the stove or oven with the right ingredients and
  cookware in hand automatically starts a timed mini-game (a sweeping
  gauge); clicking the "Cook!" button while the sweep is inside the success
  window finishes the dish; missing the window burns/ruins the ingredients
  and the player must re-gather and retry.
* Serving: carrying a finished dish to the table that ordered it (click the
  table) fulfills the order. Serving the wrong dish, or a customer's
  patience running out first, upsets that customer — and even a single
  upset customer in a shift is enough to cut that whole shift's paycheck in
  half (see Business Rules).
* A shift clock, displayed as an in-game restaurant time of day (8:30
  AM–11:30 PM): new customers/orders stop spawning at zero, any orders
  still queued are auto-failed, and the shift moves into its closing
  sequence.
* A four-step closing sequence, in order: clean every dirty table, wash the
  dishes at the cleaning closet, walk to the front counter and shut the
  restaurant down, then walk to the boss's office to collect that shift's
  paycheck. Each closing action auto-completes over a short duration once
  the player arrives (no separate "hold" input needed under click controls).
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
  simultaneous table capacity (up to the full 30), customer patience, and
  dish/table cleanup speed — all aimed at avoiding an upset customer, since
  Gard-per-shift is otherwise flat (see Business Rules).
* Three recurring/scripted customers layered on the normal random-arrival
  pool: **Mel** (always the first customer every shift, her own usual
  order, extra patience, a thank-you line), **Olive & Oliver** (an engaged
  couple, always the second arrival every shift, sharing one table and one
  order), and **Karen** (a one-time disruptive customer on shift 12 only,
  short patience, and a ripple effect that upsets one other table if she's
  mishandled). See Business Rules for the full rundown of each.
* A stationary security guard figure near the entrance — cosmetic only, not
  an interactive station.
* A Fullscreen toggle on the game container (native Fullscreen API).
* A small public leaderboard (Postgres-backed): top monthly Gard totals
  across all visitors, submitted voluntarily at month-end with a
  self-chosen display name.
* Mid-month resumability: current shift number, month-to-date Gard, and
  shop levels persist in `localStorage` across a page reload — a player who
  closes the tab mid-month resumes at the start of their current shift
  rather than losing the whole month (unlike the Fishing Game's much
  shorter, fully-ephemeral single round — see Business Rules).

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
2. User clicks "Start Shift". The floor plan renders: fridge, cabinet,
   cleaning closet, cookware closet, stove, oven, a 6x5 grid of 30 tables,
   the front counter, the (locked) boss's office door, a stationary
   security guard near the entrance, and the player character. A HUD
   overlays the canvas: shift number (n/20), the in-game clock (starts at
   8:30 AM), this shift's status (no customer upset yet vs. upset), and the
   order queue. Mel — always the first customer of the shift — and, right
   after her, Olive & Oliver, seat themselves before the normal random
   arrival rotation begins.
3. Customers begin seating themselves at tables at intervals (faster in
   later shifts). Clicking an occupied table walks the player over and
   automatically takes its order into the queue, showing the requested dish
   and a patience timer — no separate confirm step.
4. Player clicks the fridge or cabinet; once they've walked over, a picker
   panel opens listing that station's items. Clicking an item adds it to
   the carrying inventory (capacity limited, upgradeable) — for a dish that
   needs cooking, the player also needs its cookware (Pan or Baking Tray),
   picked the same way from the Cookware Closet, once per shift.
5. Player clicks the stove or oven (whichever the dish needs). Once they've
   walked over, if they're holding the right ingredients and cookware, a
   sweeping gauge mini-game starts automatically; clicking "Cook!" while the
   sweep is inside the success zone finishes the dish, missing it
   burns/ruins the ingredients (cookware isn't lost), which must be
   re-gathered from scratch. Some dishes (Garden Salad, Mel's order, Olive
   & Oliver's order) need no cooking at all — they finish assembling the
   moment their last ingredient is gathered.
6. Player clicks the table that ordered the held dish — the order clears
   from the queue, and the table (and the dish it was served on) becomes
   dirty. Clicking the wrong table, or a table whose dish doesn't match, is
   rejected — the dish is wasted and that customer is now upset. A customer
   whose patience timer expires before being served also leaves upset, and
   still leaves the table dirty.
7. When the shift clock hits zero, no further customers seat themselves and
   any still-queued orders auto-fail (upsetting those customers too). The
   floor plan switches into closing mode: every dirty table shows a mess
   indicator, and the cleaning closet shows the shift's stack of dirty
   dishes.
8. Player clicks each dirty table; once they've walked over, cleaning
   starts automatically and finishes after a short duration (faster with
   Quick Clean gear) — walking away before it finishes cancels it, no
   partial credit. Same pattern at the cleaning closet to wash the
   accumulated dishes. Once every table is clean and the dishes are washed,
   the front counter becomes clickable; clicking it walks the player over
   and shuts the restaurant down automatically. Only then does the boss's
   office door unlock; clicking it walks the player there and collects the
   shift's paycheck.
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
* **Pixel-art style** (v2, per the user's explicit request): every station,
  person, and UI element on the canvas is a canvas-drawn primitive — flat
  color-block rectangles, no rounded corners, no anti-aliasing (blocky
  "pixel people" for the player/customers/guard: a head, torso, two legs,
  each a plain rect) — rendered at a fixed, modest internal resolution and
  scaled up via a real `image-rendering: pixelated` CSS class (`.pixel-canvas`
  in `app.css` — **not** an inline `style` attribute; see the Status note's
  CSP bug), which turns flat shapes into a blocky, retro look without
  needing hand-drawn sprite assets. This supersedes v1's plain
  (non-pixelated) primitive rendering; loaded sprite images remain a
  possible future follow-up (Open Questions), still not required for the
  mechanics to work.
* The canvas game scene (floor plan, player, customers, stations) uses its
  own fixed warm "diner" palette regardless of site light/dark mode, the
  same reasoning as the Fishing Game's fixed ocean palette — a game scene
  commits to one look. The HUD, start screen, shop, and leaderboard chrome
  around the canvas fully follow the site's dark mode.
* The restaurant is named **Startime Diner** — the name appears in the page
  heading/start screen and paycheck-screen copy (e.g. "Startime Diner —
  Shift {n}"), not just an internal label.
* The boss is named **Duke** — the boss's-office hover tooltip and the
  paycheck screen refer to him by name (e.g. "Duke hands you 4,000 Gard"),
  not just "the boss."
* **Doors**: the fridge, cabinet, cleaning closet, cookware closet, and
  boss's office all render with a door handle and visually "open" (an
  inset lighter panel) while their picker panel is showing, dishes are
  being washed there, or (for the boss's office) once shutdown is complete
  and it's unlocked — matching the user's "when our mouse clicks the fridge
  (e.g.) ... the fridge door opens" request. The front counter and stove/
  oven are plain fixtures, not doors.
* **Recurring characters** each read as visually distinct at their table, a
  small pixel-person plus (for most of them) a colored marker rect above
  their head: Karen in red with a yellow marker; Mel in her favorite
  yellow (`MEL_FAVORITE_COLOR`) with a pale dandelion-puff marker; Olive &
  Oliver render as *two* people at their shared table, in Olive's green
  and Oliver's blue respectively, not the usual single figure. A normal
  random customer is a plain warm tan, no marker.
* **Security guard**: a stationary pixel-person near the entrance/counter,
  dark uniform color with a small badge-colored marker and a "Security"
  label — purely decorative (Business Rules), always present, every shift.
* The order queue and patience timers use a monospace/tabular-figure
  treatment for the same reason as the Fishing Game's HUD numbers; so does
  the HUD's in-game clock.
* Station click/hover affordance: the nearest station under the cursor
  gets a highlight outline (hover), and the station currently targeted by
  an in-flight walk gets a brighter one (click-target) — the click-driven
  equivalent of the Fishing Game's "hook touches sprite" moment, since
  there's no natural collision here.
* The HUD's shift-status indicator (Business Rules) reads clearly at a
  glance as "still going well" vs. "a customer got upset" — e.g. a
  simple two-state icon/color, not a number, since the underlying rule
  itself is binary.

---

## UI

```text
web/templates/
├── pages/
│   └── cooking-game.html         # canvas + HUD + start/paycheck/shop/panel/gauge overlays
└── components/
    ├── cooking-shop.html         # gear upgrade list (level, effect, cost, buy button)
    └── cooking-leaderboard.html  # top-N monthly totals fragment (also the HTMX partial)

web/static/
├── css/app.css                    # .pixel-canvas (image-rendering: pixelated) — see Status note's CSP bug
├── images/cooking/                # not populated — see Visual Direction's sprite-image note
└── js/
    ├── cooking-game.js           # canvas game loop, click input, station panels, localStorage progress
    └── cooking/
        ├── rules.js               # pure: recipes, cookware, cook-timing zone, paycheck rule, shift ramp,
        │                          #       Karen/Mel/Olive & Oliver constants, in-game clock formatting
        ├── engine-state.js        # pure: order queue, inventory, shift phase transitions (incl. closing steps)
        └── floor-plan.js          # pure: station positions/sizes, click hit-testing, walk-approach geometry
```

States this feature's UI must handle:

| State                        | Behavior |
| ----------------------------- | -------- |
| Start screen                   | Shows month-to-date Gard/shop levels/best month from `localStorage`, shop entry point, leaderboard, "Start Shift" (or "Resume Shift {n}"). |
| Playing — floor plan            | Canvas game loop running; HUD (in-game clock, shift status, order queue) updates every frame; player walks toward the current click target. |
| Hover tooltip                   | Shows the hovered station's name/status (e.g. a table's order, "Duke's Office (locked)") — mouse-hover only, no click needed. |
| Station picker panel            | Fridge/cabinet/cookware-closet panel open, listing that station's items as clickable buttons; owned cookware shown checked/disabled. |
| Cooking mini-game               | Sweeping gauge overlay + "Cook!" button while a cook/bake action is active; walking away cancels it, ingredients preserved. |
| Toast                           | Brief transient message (missing ingredient/cookware, Karen's opening line, her ripple notice, Mel's thank-you). |
| Order missed / customer leaves  | Brief visual feedback (customer sprite leaves, table marked dirty); shift status flips to "upset". |
| Wrong dish served               | Brief rejection feedback; dish removed from inventory; shift status flips to "upset". |
| Closing — cleaning tables        | Dirty tables show a mess indicator; clicking one auto-cleans over a short duration; cleaning closet/counter inactive until all tables clean. |
| Closing — washing dishes          | Cleaning closet clickable once tables are clean; shows remaining dirty-dish count; counter inactive until washed. |
| Closing — shut down              | Front counter clickable only once tables are clean and dishes are washed. |
| Boss's office                   | Door clickable (and visually "open") only once shutdown is complete. |
| Paycheck screen                 | Upset/no-upset outcome, this shift's Gard payout, month-to-date total, "Open Shop" / "Start Next Shift". |
| Final paycheck (shift 20)        | Month summary, "Submit to leaderboard" field, "Start New Month". |
| Shop                             | Upgrade list, affordable vs. too-expensive visually distinguished; buying disabled once balance can't cover next level. |
| Fullscreen                       | Toggling the button enters/exits Fullscreen API on the game container; canvas keeps its aspect ratio either way. |
| Leaderboard loading              | Local loading indicator while the fragment fetches. |
| Leaderboard empty                | "No scores yet — be the first!" |
| Leaderboard error                | Generic "couldn't load the leaderboard" message; rest of page still works. |
| `localStorage` unavailable       | Game still fully playable for the session; progress resets to defaults each visit, small notice explains why — never a hard error. |
| Reduced motion                   | Gameplay canvas itself can't fully honor `prefers-reduced-motion` (movement is the mechanic), but all surrounding UI transitions (shop, paycheck screens, panels) do. |
| No loaded sprite images           | Every station/ingredient/dish/person renders as a canvas primitive, so there's no image-load/failure state to handle (Visual Direction). Revisit once real sprite art lands. |

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
* **Click-to-move and click-to-interact** (v2, replacing an earlier
  keyboard-arrows/WASD version — see the Status note): a single `click`
  listener on the canvas hit-tests the click point against every station's
  box (`floor-plan.js`'s `stationAtPoint`, pure/testable). Clicking a
  station sets a walk target computed by `floor-plan.js`'s `approachPoint`
  — a point just outside that station's box, along the line back toward
  the player's current position, so the player always approaches from
  whichever side they're already standing on and never overlaps the
  station's sprite. Clicking empty floor just sets a walk target with no
  station attached. Every frame, the player moves toward the current
  target at a capped speed (boosted by Running Shoes); on arrival, if the
  target had a station attached, `handleArrival()` dispatches on the
  current shift phase and that station's kind (take/serve at a table, open
  a picker panel at the fridge/cabinet/cookware closet, start cooking at
  the stove/oven, or the phase-gated closing actions). A separate
  `mousemove` listener drives the hover tooltip (`hoverHintFor()`) without
  moving the player. Movement is paused (not read) while a station panel
  is open.
* **Order queue, upset tracking, and shift phases**: `engine-state.js`
  (pure, no DOM/canvas access) owns the order queue — adding an order,
  ticking down patience timers, auto-failing an expired order — plus a
  single `shiftUpset` boolean that latches `true` the moment any order is
  missed or the wrong dish is served, and the shift-phase state machine
  (`playing` → `closing-clean` → `closing-dishes` → `closing-shutdown` →
  `paycheck`). Mirrors the Fishing Game's `engine-state.js` role for round
  state. `failOrderAt()` (added for Karen's ripple effect) forces a
  specific table's order to fail the same way a patience timeout does,
  callable directly rather than only via the clock.
* **Station picker panels**: fridge/cabinet/cookware-closet arrival opens
  a DOM overlay (`#cooking-station-panel`, not canvas-drawn — a real
  picker needs real buttons) listing that station's full item set; each
  click adds the ingredient to inventory (if capacity allows) or marks the
  cookware as acquired for the rest of the shift. A "none"-station dish
  (Garden Salad, Mel's order, Olive & Oliver's order) auto-assembles into
  a held dish the moment its last ingredient is gathered — no separate
  cooking step.
* **Cooking mini-game**: a sweeping gauge (0 to 1, ping-ponging) starts
  automatically on arriving at a stove/oven while holding the right
  ingredients and cookware; clicking the "Cook!" button samples the
  gauge's current position against the dish's success zone (`rules.js`) —
  inside it, the dish finishes; outside it, the ingredients are ruined
  (cookware is never consumed). Sweep speed and the zone's width are pure
  functions of shift number and the Sharp Knife gear level, so they're
  unit-testable the same way `descentSpeed()` is for the Fishing Game.
  Clicking a new walk target elsewhere cancels an in-progress mini-game
  (ingredients preserved); clicking the same stove/oven again while it's
  running is a no-op, not a restart.
* **Closing-sequence auto-timers**: arriving at a dirty table (in
  `closing-clean`) or the cleaning closet (in `closing-dishes`) starts a
  short timer (`cleaningDurationForSave`, shortened by Quick Clean) that
  completes the real action (`cleanTable`/`washDishes`) automatically —
  replacing the keyboard version's "hold the interact key" mechanic, which
  doesn't map to a click. Clicking a different target before it completes
  cancels it, no partial credit.
* **Karen / Mel / Olive & Oliver**: `maybeSpawnCustomer()` special-cases
  the first two spawns of every shift — the first is always Mel
  (`MEL_DISH`, extra patience via `MEL_PATIENCE_BONUS_SECONDS`), the
  second is always Olive & Oliver (`COUPLE_DISH`, rendered as two people at
  one table) — before falling back to the normal random pool. Karen is
  spawned once, immediately, only on `isKarenShift(currentShiftNumber)`
  (shift 12), with her own short `KAREN_PATIENCE_SECONDS`. Her ripple
  effect and Mel's/the couple's "stop tracking once resolved" cleanup both
  compare `shiftState.orders` before/after each `tick()` call to detect a
  timeout (a successful or wrong-dish serve is detected synchronously in
  the table-arrival handler instead, since that doesn't go through `tick`).
* **Security guard**: drawn every frame at a fixed canvas position,
  independent of `stations`/`floor-plan.js` entirely — it's not
  interactive, so it never needed to be a real station.
* **Fullscreen**: `toggleFullscreen()` calls `requestFullscreen()`/
  `exitFullscreen()` on the canvas's parent container (the same element
  the CSS `aspect-[960/600]` box lives on), so the canvas keeps its true
  proportions in both windowed and fullscreen display.
* **Progress persistence**: a single `localStorage` key
  (`cooking-game:v2` — bumped from `v1` since this redesign changes enough
  client-only state shape that a stale v1 save isn't worth attempting to
  migrate) holding `{monthToDateGard, currentShift, gear: {...levels},
  bestMonthTotal}`.
* **Reduced motion**: same accepted gap as the Fishing Game — gameplay
  canvas can't fully honor the preference, but every non-gameplay transition
  (shop, paycheck, station-panel screens) does.
* **Cleanup**: loop torn down (canceled `requestAnimationFrame`, listeners
  removed) on HTMX nav-away, not just full page unload; a pending toast
  `setTimeout` is also cleared.

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

  | Shift range | Dish              | Station | Cookware | Ingredients                      |
  | ------------- | ------------------- | --------- | ---------- | ----------------------------------- |
  | 1–5             | Garden Salad          | none (cabinet/fridge only) | none | Lettuce + Tomato        |
  | 1–5             | Grilled Cheese         | Stove     | Pan | Bread + Cheese                       |
  | 6–10            | Burger                 | Stove     | Pan | Buns + Patty + Lettuce                 |
  | 6–10            | Pancakes                | Stove     | Pan | Flour + Egg + Milk                    |
  | 11–15           | Roast Chicken           | Oven      | Baking Tray | Chicken + Herbs                       |
  | 11–15           | Pasta                   | Stove     | Pan | Noodles + Sauce                       |
  | 16–20           | Steak Dinner            | Stove     | Pan | Steak + Potato + Herbs                |
  | 16–20           | Soufflé (signature)      | Oven      | Baking Tray | Egg + Cheese + Flour                  |

  A dish's ingredients come from the Fridge (cold: Cheese, Milk, Chicken,
  Patty, Steak, Lettuce, Tomato, Egg, Lemonade, Matcha) or the Cabinet (dry:
  Bread, Flour, Noodles, Herbs, Buns, Sauce, Potato, Star Cake, Cake).
  Which dishes customers can order is drawn only from bands unlocked up to
  the current shift, same "grows, never shrinks" shape as the Fishing
  Game's fish-band gating. Lemonade/Matcha/Star Cake/Cake exist only for
  Mel's and Olive & Oliver's dedicated orders below — no `RECIPE_BANDS`
  dish uses them, so they never show up in a normal random customer's
  order.
* **Cookware**: every Stove dish needs a Pan and every Oven dish needs a
  Baking Tray (a Rice Cooker also lives in the Cookware Closet, present for
  flavor but not required by any current dish). Unlike ingredients,
  cookware is a one-time pickup per shift — acquired once from the
  Cookware Closet, it's available for every dish that needs it for the
  rest of the shift, never consumed or re-gathered, and a burned/ruined
  dish only loses its ingredients, not its cookware.
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
* **In-game clock**: the shift's real-time countdown (`SHIFT_CLOCK_SECONDS`,
  illustrative, tune during build) is displayed as a restaurant time of
  day, 8:30 AM at shift start to 11:30 PM when the clock hits zero
  (`rules.js`'s `inGameTimeLabel`, a linear map from remaining clock
  seconds onto that range) — a cosmetic display choice layered on the same
  underlying countdown every other shift-timing function already uses, not
  a second independent clock.
* **Shift ramp**: customer arrival rate increases and patience timers
  shorten as shift number increases, and simultaneous active tables/orders
  is capped by both the physical table count (30) and the Extra Table
  Service gear level, whichever is lower.
* **Closing sequence order is enforced**, matching the explicit
  clean → wash dishes → shut down → get paid order from the feature
  request, not a cosmetic sequence the player could skip or reorder: the
  cleaning closet isn't clickable until every table is clean, the front
  counter isn't clickable until the cleaning closet's dirty-dish stack (one
  dish per serve — successful, wrong, or missed doesn't matter, a dish or
  pan still got used — accumulated that shift) is fully washed, and the
  boss's office door isn't clickable until shutdown is complete.
* **Gear upgrades** (illustrative costs/magnitudes, same "tune during build"
  status as the recipe table above), 5 levels each unless noted, cost curve
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
  | Extra Table Service        | +3 simultaneous active tables per level (8 levels, base 5 → capped at the physical 30) |
  | Regular's Patience          | +patience-timer duration per customer                      |
  | Quick Clean                | Reduces per-table cleaning and dish-washing time            |

* **Karen, Mel, and Olive & Oliver** — three named customers layered on top
  of the normal random-arrival pool (`availableDishes`), none of whom ever
  come from that pool themselves:
  * **Mel** (`MEL_DISH`, `"Mel's Usual"` — Lemonade, Star Cake, and Egg,
    station `none`) is always the very first customer seated, every single
    shift — not a random chance. Sweet, kind, and caring; favorite color
    yellow, favorite flower a dandelion (both cosmetic, Visual Direction).
    She gets `MEL_PATIENCE_BONUS_SECONDS` (15s) on top of the normal
    patience for that shift, and serving her correctly shows
    `MEL_THANK_YOU_LINE`. If she's mishandled (missed or served wrong),
    that's a normal `shiftUpset` latch like anyone else — no extra
    penalty; she's understanding, not vindictive.
  * **Olive & Oliver** (`COUPLE_DISH`, `"Olive & Oliver's Order"` — Matcha
    and Cake, station `none`) always arrive together right after Mel,
    every shift — the second guaranteed spawn, before the random pool
    resumes. An engaged couple sharing one table and one order, not two
    separate orders. Olive: brave, smart, neat, favorite color green
    (`OLIVE_FAVORITE_COLOR`), favorite flower tulips. Oliver: intelligent,
    brave, favorite color blue (`OLIVER_FAVORITE_COLOR`), favorite flower
    rose — his usual order is the same as his fiancée's, which is why they
    share `COUPLE_DISH` rather than each getting their own. No special
    patience/ripple mechanic; purely a recurring-cast/rendering distinction
    (Visual Direction: rendered as two people at one table).
  * **Karen** (`KAREN_SHIFT_NUMBER` = 12, one of the "12 or 18" the user
    offered — picked to keep this a single well-defined trigger) appears
    once, immediately at shift start, on that one shift only — not part of
    the normal spawn timer. Her line (`KAREN_LINE`, shown the moment she's
    seated): "HEY YOU THERE COME OVER HERE." Much shorter patience
    (`KAREN_PATIENCE_SECONDS` = 12s) than a normal customer at that shift.
    If her order isn't served correctly in time (missed or wrong dish),
    that's a normal `shiftUpset` latch *plus* a ripple effect: one other
    currently-active order (picked at random, if any exist) is force-failed
    too (`engine-state.js`'s `failOrderAt`) — she's rude enough to sour the
    mood for someone else. Served correctly, no ripple, business as usual.
* **Security guard**: a stationary figure near the entrance/counter — "there's
  security to protect the place." Cosmetic only: not a `floor-plan.js`
  station, no click target, no interaction, no effect on Karen or anyone
  else. Present every shift, unconditionally.
* **Mid-month resume**: month-to-date Gard, current shift number, and shop
  levels persist across a reload; an in-progress shift's floor-plan state
  (order queue, inventory, acquired cookware, table/dish cleanliness, the
  `shiftUpset` flag, and whether Mel/Karen/Olive & Oliver have already
  appeared or been resolved this shift) does not — returning mid-shift
  restarts that shift from its beginning, same forfeiture principle as the
  Fishing Game's abandoned-round rule, just scoped to one shift instead of
  the whole run since a month is a much longer investment to fully discard.
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
* [ ] `failOrderAt` fails the active order at a specific table on demand
      (Karen's ripple effect), exactly like a patience timeout, and is a
      no-op if that table has no active order or the shift has left
      `playing`.
* [ ] Shift-phase state machine (`engine-state.js`): `playing` only
      transitions to `closing-clean` when the shift clock hits zero (and
      skips straight to `closing-dishes` if every table already happens to
      be clean — the idle-shift soft-lock regression from the v1 pass);
      `closing-clean` only transitions to `closing-dishes` once every table
      is clean; `closing-dishes` only transitions to `closing-shutdown` once
      the dirty-dish stack is fully washed; `closing-shutdown` only
      transitions to `paycheck` after the shutdown action fires — each gate
      is independently unit-tested, not just the happy path through all
      four.
* [ ] `floor-plan.js`: `stationAtPoint` correctly hit-tests each station's
      box (including an exact-edge boundary case) and returns `null` for a
      point over no station; `approachPoint` returns a point exactly
      `standoffDistance` from the station center along the line back to the
      player's current position, and returns the player's own position
      unchanged if they're already within that distance.
* [ ] Shift-to-shift ramp (customer arrival rate, patience duration, sweep
      speed) moves in the documented direction as shift number increases,
      unit-tested at representative shift numbers.
* [ ] `inGameTimeLabel`: a full clock reads 8:30 AM, a zeroed clock reads
      11:30 PM, the halfway point reads the halfway time of day, a noon
      crossover reads "12:00 PM" (not "0:00 PM"), and out-of-range/
      non-finite input clamps rather than producing a nonsense time.
* [ ] Every `RECIPE_BANDS` dish's cookware matches its station (Pan for
      Stove, Baking Tray for Oven, `null` for the station-less dish), and
      every ingredient (including `MEL_DISH`'s and `COUPLE_DISH`'s) resolves
      to a real `FRIDGE_INGREDIENTS`/`CABINET_INGREDIENTS` entry.
* [ ] `MEL_DISH` and `COUPLE_DISH` are never present in `availableDishes`'s
      output at any shift number — only the two scripted spawns ever order
      them.
* [ ] `isKarenShift` is true only at `KAREN_SHIFT_NUMBER`.
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
      upsets (real clicks, plus the `skipToClosing`/`collectPaycheck` test
      hooks to fast-forward the closing sequence's real-time waits) →
      paycheck screen shows 4,000 Gard → shop purchase reflected next
      shift.
* [ ] `e2e/`: play a shift that includes one missed or wrong-served order
      (the `forceUpset` test hook, or a real wrong-dish click) → paycheck
      screen shows 2,000 Gard instead of 4,000.
* [ ] `e2e/`: play all 20 shifts (test hooks to fast-forward each closing
      sequence) → Final Paycheck screen → submit score → leaderboard shows
      the new entry → test cleans up its own row.
* [ ] `e2e/`: click a station and confirm the player walks to it and the
      correct action fires on arrival (station panel opens for fridge/
      cabinet/cookware closet, order taken/served at a table); clicking
      empty floor just walks there with no side effect.
* [ ] `e2e/`: Mel is the first customer of a fresh shift and Olive & Oliver
      the second, every time — not just probabilistically.
* [ ] `e2e/`: the Recipe Book opens (before and during a shift), lists every
      dish including Mel's and Olive & Oliver's, and its Close button is
      always reachable regardless of viewport/canvas height (regression
      coverage for the clipped-Close-button bug below).
* [ ] No console errors (including no CSP violations) on `/kitchen-shift` —
      specifically covers inline `style=""` attributes, which this shell's
      CSP silently blocks (a real bug found during v2's manual
      verification, see the Status note).

---

## Open Questions

* Exact shift-clock duration and customer arrival/patience curves are all
  illustrative and need a real playtesting pass before being called final,
  the same status the Fishing Game's numbers started at.
* **Resolved**: touch controls — v2's click-only redesign already handles
  this, since a tap and a click are the same pointer event; no separate
  virtual d-pad/button scheme is needed the way keyboard-based movement
  would have required.
* Whether nav/`/projects`/landing-page integration (deliberately out of
  scope, see Scope) happens as an immediate fast-follow or waits
  indefinitely, same open-ended status the Fishing Game's own nav placement
  has been through multiple revisions of.
* **Resolved (v1)**: dish washing is one interaction that clears the whole
  shift's stack at once. **Superseded in v2**: with keyboard controls gone,
  this is now an auto-timer that starts on arrival at the cleaning closet
  and completes after a short duration (Quick Clean gear shortens it),
  rather than a held key — same "clears the whole stack in one action" and
  "not scaled to dish count" shape, different trigger mechanism.
* Real hand-authored SVG sprite art (ingredients/dishes/stations),
  deliberately deferred in favor of the v2 pixel-art canvas-primitive
  treatment (Visual Direction) — left open the same way the Fishing Game's
  own flat-circle-to-real-sprite upgrade was, rather than blocking on art
  production.
* **Resolved**: a real, previously-shipped bug where any *new* Tailwind
  utility class introduced only in a template (not already used elsewhere
  in the codebase) silently did nothing until `make css` regenerated
  `output.css` — Tailwind v4's `@source` scanning is a build step, not a
  runtime one. Caught when the Recipe Book's and station panel's
  `max-h-full` fix (below) appeared to have no effect at all until the CSS
  was rebuilt. Not a design gap, just a reminder that a template-only edit
  in this codebase isn't automatically live.
* **Resolved**: the Recipe Book's (and the fridge/cabinet/cookware-closet
  station panel's) card could be taller than the canvas itself — a real
  risk since the canvas's rendered height varies with viewport/column
  width while the card's content doesn't — and the parent's
  `overflow-hidden` silently clipped the excess, including the Close
  button, leaving it unclickable. Fixed by capping the whole card
  (`max-h-full overflow-y-auto`), not just its inner list, on both panels.
* Rice Cooker sits in the Cookware Closet but no current dish requires it
  (Business Rules) — the user asked for it "e.g." alongside Pan, not as a
  strict requirement; whether a future dish should use it, or whether it's
  purely flavor/future-proofing, is left open.
* Karen's shift was picked as 12 out of the "12 or 18" the user offered,
  to keep this a single well-defined trigger; whether 18 should also get a
  (the same or a different) scripted event, or Karen should move/duplicate
  there instead, is left open.

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
