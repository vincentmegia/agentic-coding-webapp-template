# Feature: Library Shift

## Status

`Shipped` — implemented and covered by tests. Go: handler tests
(`internal/handler/library_game_test.go`), service/validation tests
(`internal/service/library_service_test.go`/`library_validation_test.go`),
and a real-Postgres end-to-end subtest in `cmd/server/e2e_test.go`
("library shift routes round-trip through the real library_scores table").
JS: `web/static/js/library/{rules,engine-state,floor-plan}.js` are pure,
DOM-free logic modules covered by `node --test` (109 game-logic tests plus
`floor-plan.test.js`'s own suite); `web/static/js/library-game.js` wires
them to the canvas (click-to-move, the two-floor Stairs/Elevator/HUD-button
switch, the big personality-parameterized characters, all five minigame
overlays, Karen's scripted event, the Sanity/Mood bars, fullscreen,
`localStorage` persistence). `e2e/library-game.spec.js` drives the full
click-to-play loop end to end (17 tests, passing on both Chromium and
WebKit) using `window.__libraryGameTestHooks` to get exact coordinates/
timing rather than waiting out this game's deliberately slow real-time
shift clocks or guessing at randomly-scattered item positions — see that
file's own header comment. `/library-game` is on the `/projects` grid with
a real screenshot (`web/static/images/library/screenshot.png`). Manually
verified in a real browser: a full click-driven shift (shelving, a Coin
Hunt book, a fine, a borrow request, the Coffee Machine, Karen, closing-wait,
payout) and dark mode, both with zero console errors. Recipe/volume/
skill-check magnitudes remain illustrative/tunable, as called out throughout
this doc — nothing in that tuning blocks calling this Shipped.

**v1.1 character body redesign** — the user tried the shipped game and
reported not liking the character shape; they confirmed they wanted an
"articulated humanoid" (a visible neck/shoulders and distinct arms, not a
chibi/rounder direction) when asked to pick a direction. The root cause
of the original blob look: `drawLibraryPerson`'s arm rectangles sat
*underneath* the torso rectangle's x-range (only a ~1px sliver poking out
past the torso's rounded corners), and the head circle's bottom edge
overlapped directly into the torso's top edge with no gap — so arms were
functionally invisible and there was no neck. Fixed by narrowing the
torso so the arms sit fully outside its width (touching its edge, not
hidden behind it) and inserting a small skin-tone neck rectangle between
the head and the torso. Re-verified via a cropped Playwright screenshot
at native pixel size: both arms and a clear neck are now visible on the
player and every patron/personality template (they all share this one
draw function). The `/projects` grid screenshot
(`web/static/images/library/screenshot.png`) was recaptured with the new
shape. No logic changed — `node --test`/`go test ./...` unaffected (450/450
JS, Go green).

**v1.2 distinct skin tones per personality** — the user pointed out every
personality template's `headColor` was nearly the same light tan
(`#e3c2a0`/`#f0d9c0`/`#f6dcb8`/`#f0cba0`), so patrons didn't actually read
as having different skin tones despite the personality system's distinct
faces/hair/outfits. Spread across a genuinely distinct range instead —
Grumpy Regular `#c68642` (medium-tan), Shy Student `#ffdbac` (light),
Cheerful Kid `#8d5524` (deep brown, hair darkened to `#2a1a10` to pair
naturally with it), Karen `#e0ac69` (medium) — re-verified via a cropped
screenshot of all three regular patrons side by side. Projects-grid
screenshot recaptured again. `node --test`/`go test ./...` unaffected
(450/450 JS, Go green) — cosmetic-only change.

**v1.3 First Person Mode** — built per the Scope addition above (the
user's explicit "seeing in first person and seeing anything but
yourself"): a new `web/static/js/library/first-person.js` pure module
(angle/distance projection math — `projectEntity`/`projectScene`/
`screenXForAngleOffset`/`scaleForDistance`/`groundScreenY`/
`findInteractTarget`, plus turning/moving helpers — fully unit-tested,
`first-person.test.js`) driving a billboard-sprite camera in
`library-game.js`: a floor/horizon gradient, every visible station/patron
on the current floor projected by angle-and-distance from the player
(FOV-culled, back-to-front painter's-algorithm sort) and drawn with the
exact same `drawLibraryPerson`/station-drawing primitives Top-Down mode
uses, just at a computed screen position/scale instead of a world
position — no separate sprite art needed. A new `#library-camera-button`
toggles instantly between modes with no loss of position/floor; a new
`#library-fp-controls` cluster (turn left/right, move forward/back,
interact) plus arrow-key equivalents drive movement, since click-to-move
doesn't apply without a visible top-down floor; the interact
action/prompt calls the exact same station-arrival logic the Top-Down
click path already uses, not a duplicate. All five minigame overlays,
the Sanity/Mood bars, and the HUD clock are unchanged and confirmed
working identically in both camera modes.

**Two real bugs found during verification** (the implementing agent's
own manual-verification pass stalled/timed out before completing, so
these were caught in a follow-up verification pass instead):

1. **Stale compiled CSS made the on-screen Interact button unclickable.**
   `web/templates/pages/library-game.html`'s new `#library-fp-controls`
   bar uses `bottom-2` (among other new Tailwind classes), but
   `web/static/css/output.css` hadn't been rebuilt since those classes
   were added to the template, so the compiled stylesheet had no
   `.bottom-2` rule at all. With no `bottom` value, the browser fell back
   to the element's normal-flow static position — rendering the entire
   control bar directly below the canvas, outside
   `#library-canvas-wrapper`'s `overflow: hidden` box, where every button
   was geometrically present but visually/interactively unreachable
   (Playwright's actionability check reported the wrapper `<div>` itself
   intercepting every click). Fixed by rebuilding CSS
   (`npm run build:css`) — a build-step gap, not a logic bug, but a real
   regression a manual click-through would have caught immediately.
2. **Entering 2nd Floor left the player facing exactly backward.**
   `floor-plan.js`'s `FLOOR_1_ENTRY_POINT`/`FLOOR_2_ENTRY_POINT` are both
   defined as exactly the canvas center (`{x: 480, y: 300}` on the
   960x600 canvas), and `defaultFacingTowardCenter` computes "face toward
   the center" via `angleTo` from the player's own position — which, at
   an entry point, already IS the center. That's a zero-distance
   `Math.atan2(0, -0)` call, which JavaScript defines as returning `PI`
   (not `0`), so every arrival at either floor's entry point silently
   faced the player exactly backward instead of at the intended default.
   Fixed by having `defaultFacingTowardCenter` special-case near-zero
   distance and return `0` directly. Covered by a new regression test
   (`first-person.test.js`'s "a player already exactly at the center
   faces 0 (north), not PI").

Re-verified after both fixes: `node --test web/static/js/library/*.test.js`
(175/175, including the new regression test), full `npm run test:unit`
(498/498), `go build`/`go vet`/`go test ./...` clean, and
`e2e/library-game.spec.js`'s full 23-test suite green on both Chromium and
WebKit, including every First Person test (camera toggle, sprite
visibility, turn/move controls, Coffee Machine interaction via the Enter
key, and the Stairs floor-switch/facing-reset test that exercised bug #2
directly). Manually screenshotted First Person Mode via Playwright to
confirm it reads as a genuine first-person view (floor/horizon split,
centered crosshair, distance-scaled patron/station billboards, no player
avatar, control buttons along the bottom) rather than a re-skinned
top-down camera.

**v1.4 book titles on the front cover** — the user reported "the mini
games have problems... i dunno what book it is" for the Coin Hunt/Return
Cart/borrow-request flows (Find the Book already showed titles on its
candidate books; the others never rendered a title anywhere).
`spawnBook` now assigns each Return Cart book a `title` (via the existing
`titleForGenre` pool, already used for borrow requests) — a plain field
on the object `addBookToCart`/`pickUpBook` (engine-state.js) already pass
through untouched, so no pure-logic-layer change was needed to carry it
to `carriedBook`. Rendered in three places: the Return Cart's own book
covers, the Coin Hunt overlay's header (`Coin Hunt — "<title>" — find
every coin and bill`), and the front-desk borrow slot (a label chip below
the patron, same treatment as the fine amount chip).

**Two real overflow bugs caught during visual review** (not caught by
the automated suite, since it drives every minigame via exact coordinates
from `getOverlay()`/`getReturnCartSlots()` rather than actually reading
rendered text — a gap worth knowing about for any future purely-cosmetic
text change):

1. A title text wider than a Return Cart book's ~22px-wide cover bled
   directly into the neighboring book 30px away, since nothing clipped
   the draw — two adjacent books' titles visually merged into one
   unreadable smear. Fixed by widening each cover (22x30 → 26x32) and the
   cart's per-slot spacing (30px → 34px) *and*, more importantly, clipping
   the title draw to the book's own cover rect (`ctx.clip()`) so any
   remaining overflow is cropped cleanly rather than spilling outward
   regardless of title length.
2. Front-desk slots sit only 46px apart; `drawLabelChip` auto-sizes to
   its text's full width with no wrapping or truncation, so a full title
   like "Complete Grammar Guide" rendered a chip wider than the slot
   spacing itself, overlapping the neighboring slot's own chip. Fixed
   with a new `truncateForChip` helper (measures against the real font,
   appends "…" only if needed) capping the borrow slot's title chip to a
   safe width.

Re-verified via cropped Playwright screenshots at native scale: three
Return Cart books with different long titles show fully distinct,
non-overlapping cover text; a front-desk fine chip ("45g") and an
adjacent borrow-title chip ("The Sil…") render side by side with no
overlap; the Coin Hunt header fits a full title on one line inside its
box. `node --test web/static/js/library/*.test.js` (175/175, unaffected —
this is a pure-rendering change) and `e2e/library-game.spec.js`'s full
23-test suite (both Chromium and WebKit) still green, confirming the
widened Return Cart spacing didn't break click hit-testing on any book.

**v1.5 the neck still read as disconnected in real play** — the user
reported, with a screenshot from an actual play session, that a
character's "body is not great its seperated from the body its looking
disfigured" — the head visibly floating above the shoulders with a gap
of bare background between them. v1.1's neck (`drawLibraryPerson`) was
sized to just exactly bridge the head circle's bottom edge and the
torso's top edge (touching, not overlapping) — this session's own
Playwright screenshots of that geometry (both at native canvas
resolution and at the front-desk's smaller 0.62 scale) rendered it as
connected, so the exact-edges approach wasn't reproduced as broken here,
but the user's own screenshot from a real browser session is the ground
truth. Rather than chase a rendering-environment difference further, the
neck was made unconditionally robust: it now overlaps 2px *into* both the
head circle and the torso rect (grown from 6×4 to 10×8, at `y-26*s` to
`y-18*s` instead of exactly `y-24*s` to `y-20*s`) so there is no shared
edge for any renderer's sub-pixel handling to expose a seam on. Re-verified
via the same native-resolution screenshot technique as v1.1 — the neck now
reads as a solid, unambiguous column between head and shoulders. `node
--test web/static/js/library/*.test.js` (175/175) and
`e2e/library-game.spec.js` (23/23, both Chromium and WebKit) unaffected —
pure-rendering change, no logic touched.

## Summary

A third canvas mini-game, `/library-game`, sibling to Kitchen Shift and the
Fishing Game: the player works library shifts, returning books to their
correct shelves (via one of several book-specific skill-check minigames) and
processing patron fines (via a coin/bill-sorting minigame at the fines
counter), earning **Gard** — this site's existing in-game currency, already
established by Kitchen Shift's shift payouts — over a 30-shift run. A
scripted disruptive patron ("Karen") appears once, on a shift randomly chosen
from 10–15.

## Problem / Motivation

The user asked for a new library-themed game reusing this codebase's
existing game conventions (shift structure, Gard currency, a Karen-style
disruptive-customer beat, procedural pixel-art characters with faces) but
with its own core mechanic: book-shelving skill checks and a fines-counter
sorting minigame, instead of Kitchen Shift's cooking/serving loop.

## Scope

**In scope (v1):**

* `GET /library-game` page + canvas game shell, click-to-move floor plan,
  mirroring Kitchen Shift's v2+ architecture (canvas-primitive rendering,
  no image assets, `image-rendering` not needed since there's no pixel
  upscaling requirement beyond what "pixel art" primitives already look
  like — see Visual Direction).
* **30 shifts**, split into three 10-shift tiers (reusing Kitchen Shift's
  round-tier pattern: shift clock shrinks and return/fine volume grows each
  tier) — see Business Rules.
* **Return-cart shelving loop**: books accumulate on a Return Cart at the
  front desk; the player carries one at a time to its correct shelf
  (matched by a genre/color-coded call number) and completes a
  **Shelf Skill-Check** minigame (a timing bar — stop a moving indicator in
  a target zone) to shelve it.
* **Coin Hunt books**: a subset of returned books instead trigger a
  hidden-object minigame (find every coin and every dollar bill scattered
  among the book's pages) before they can be shelved; found currency is
  added to the shift's Gard total as a bonus.
* **Fines counter loop**: patrons at the front desk occasionally pay a
  fine (Gard only, per the user's "for the fines its gard only"); the
  player carries that payment to the Fines Counter station and completes a
  **Fines Sort** minigame (find and click every gold coin and Gard bill
  among decoy clutter in a register-drawer scene) to bank it.
* **Borrowing loop** (the mirror image of shelving): a patron at the front
  desk requests a specific book; the player must go to the shelves and
  complete a **Find the Book** minigame (search among the shelved books
  for the one matching the patron's request, among visually similar
  decoys — same "search the scene" shape as Coin Hunt, but the target is
  a single correct book rather than every coin/bill) and then complete a
  **Checkout Skill-Check** (a timing-bar check, same mechanic as the
  Shelf Skill-Check) to hand it over. Failing either step costs the
  patron's patience, same consequence class as a late/failed shelving.
* **Karen event**: once per 30-shift run, on a shift chosen randomly from
  10–15 at month start (deterministic per save, mirroring how Kitchen
  Shift's own scripted customers are chosen) — a disruptive patron who
  returns an overdue book without paying its fine and argues, draining a
  restaurant-mood-equivalent stat (see Business Rules) if mishandled.
* **Player Sanity + Coffee Machine**: a player-only Sanity stat (0-100,
  same scale/shape as Kitchen Shift's own Sanity — passively drains over
  the shift and drains further per mistake, slows walk speed as it drops)
  and a **Coffee Machine** station (in a staff break room, or tucked near
  the Fines Counter) that restores Sanity to full when the player
  interacts with it — mirrors Kitchen Shift's Coffee Machine mechanic
  exactly (`SANITY_MAX`/`SANITY_DRAIN_PER_SECOND`/
  `walkSpeedMultiplierForSanity` in `rules.js`), reused rather than
  reinvented. Distinct from `libraryMood` (Business Rules), which tracks
  the library's reputation, not the player's own stress.
* **Big, expressive pixel characters**: canvas-primitive rendering scaled
  up beyond Kitchen Shift's base scale (per "make the characters BIG"),
  each built from a shared `drawLibraryPerson` helper (the same
  head/body/anime-face composition pattern as Kitchen Shift's
  `drawPixelPerson`/`drawAnimeFace`) parameterized by a **personality
  template** (distinct face-expression parameters — eyebrow angle, mouth
  curve, eye shape — plus hair/outfit palette, not just a palette swap) so
  patrons visibly read as different people (Grumpy Regular, Shy Student,
  Cheerful Kid, Karen, etc.).
* Shift-end Gard payout (base amount, plus Coin Hunt/fines bonuses, minus a
  per-mistake penalty — same shape as Kitchen Shift's `shiftPaycheck`),
  client-side `localStorage` progress persistence, and a Postgres-backed
  public leaderboard (`library_scores`, mirroring `cooking_scores`).
* **Two floors, the 2nd purely for more books**: mirroring Kitchen Shift's
  Dining/Kitchen room split (`docs/features/cooking-game.md`'s "v3.1 room
  split"), a **1st Floor** keeps every non-shelf station (Front Desk,
  Return Cart, the Fines Counter, the Coffee Machine, Boss's Office) plus
  some Bookshelves, and a **2nd Floor** holds additional Bookshelves only
  — more genres/more shelf capacity, per the user's "for more books,"
  not a relocation of any other station. The two floors share one canvas,
  never shown at once, reachable via **three** independent routes on each
  floor: a **Stairs** station, an **Elevator** station, and a "Go
  Upstairs"/"Go Downstairs" HUD button — the user asked for stairs *and*
  an elevator specifically, so both exist side by side rather than
  picking one, same reasoning Kitchen Shift applied when the user asked
  for both a door and a button ("v3.1 room split"). All three switch
  instantly with no loading state (no ride/climb animation gating it) and
  reposition the player at that floor's entry point.
  Switching floors must work in every shift phase, including
  `closing-wait` — a borrow/shelving trip could still be in progress on
  the 2nd Floor when the clock hits 11 PM, and the player must be able to
  come back down to reach the (1st-Floor-only) Boss's Office.
* **First Person Mode**: an HUD toggle switching the camera from the
  default top-down click-to-move view to a genuine first-person
  perspective — the player sees the world from their character's own
  eyes (floor/stations/patrons ahead of them) and does not see their own
  avatar at all, per the user's explicit "seeing in first person and
  seeing anything but yourself." Since there's no 3D engine or wall
  textures anywhere in this codebase, the view is a lightweight
  billboard-sprite perspective (a simple floor/horizon gradient, with
  stations and patrons drawn as the same existing canvas-primitive art —
  `drawLibraryPerson`, station shapes — scaled and horizontally
  positioned by their angle/distance from the player, not a textured
  raycast engine). Click-to-move doesn't apply in this mode, so it adds
  its own controls: turn left/right and move forward/back (arrow keys or
  on-screen buttons), plus a "look at a station, then interact" prompt
  for whichever station is centered in view within range, functionally
  equivalent to clicking that station in Top-Down mode. All five minigame
  overlays are unchanged and camera-mode-agnostic (they're already
  full-canvas takeovers). Switching modes is instant and preserves the
  player's position/floor; it's a pure alternate camera+control scheme,
  not a separate game mode with different rules.
* `/library-game` added to the `/projects` grid (`internal/handler/
  pages.go`'s `projectItems`), following the exact Fishing Game/Kitchen
  Shift/Puzzle Solver pattern.

**Out of scope (v1):**

* Any second art style pass (this ships pixel-primitive art directly, no
  "v1 primitives → v2 restyle" split like Kitchen Shift went through) —
  the user asked for pixel + big expressive faces from the start, so that
  is v1, not a later redesign.
* Gear/shop upgrades, leveling systems, or a second scripted recurring
  patron beyond Karen — Kitchen Shift only grew these over many follow-up
  sessions; v1 here ships the mechanics the user actually asked for and
  nothing speculative.
* Mobile/touch-specific controls beyond what click/tap-to-move already
  gives for free (same stance Kitchen Shift took).
* Real hand-drawn or generated sprite/image assets — same constraint as
  every other game on this site (no image-generation tool available);
  "pixel" here means canvas-primitive rendering at a blocky scale, as
  established by Kitchen Shift's own Visual Direction notes.

---

## User Flow

```text
1. Player navigates to /library-game (via the Projects grid's "Play now").
2. Start screen → "Start Shift" launches Shift 1 on the library floor plan.
3. Books pile up on the Return Cart over the shift. Player clicks a book,
   carries it (click-to-move) to the shelf matching its color-coded genre.
4. Arriving at the correct shelf launches the Shelf Skill-Check minigame
   (most books) or the Coin Hunt minigame (marked books) — success shelves
   the book and, for Coin Hunt books, adds found Gard to the shift total.
5. Separately, patrons occasionally arrive at the front desk to pay a fine.
   Accepting the payment sends the player to the Fines Counter, where the
   Fines Sort minigame (find every coin/bill in the drawer) banks it.
5b. Other patrons instead arrive requesting to borrow a specific book.
    Accepting the request sends the player to the shelves for the Find
    the Book minigame (locate the requested book among decoys), then back
    to the patron for the Checkout Skill-Check (a timing-bar check) to
    complete the loan.
6. Shift clock hits 11:00 PM → a 20-second closing wait begins (the Boss's
   Office door stays locked/non-interactive until it elapses — walking up
   to it early does nothing); once the 20 seconds pass, the boss lets the
   player in, and entering the office collects the shift's paycheck —
   payout screen shows Gard earned this shift (base + bonuses − mistakes)
   and updates the running total.
7. Steps 3-6 repeat for 30 shifts, in three difficulty tiers (1-10/11-20/
   21-30). On the Karen shift (randomly 10-15), an extra scripted patron
   event plays out at the front desk.
8. After shift 30, a Final Paycheck screen totals the run and offers
   leaderboard submission (player name + total Gard), same flow as Kitchen
   Shift's Final Paycheck.
```

---

## Visual Direction

Canvas-primitive rendering, matching Kitchen Shift's proven approach (flat
shapes scaled to a fixed internal resolution — no external image/sprite
assets exist or are generatable in this environment):

* **Floor plan**: a library floor — Front Desk (patron queue + fine
  payments), Return Cart, several color-coded Bookshelves (one per genre),
  a Fines Counter station (separate room or distinct floor area from the
  desk, so "carrying the payment to the counter" is a real click-to-move
  trip, not instantaneous), reading tables/chairs as background dressing.
* **Big characters**: `drawLibraryPerson` scales noticeably larger than
  Kitchen Shift's player scale (that game's own v3.3 changelog is the
  precedent for "characters read too small, make them bigger" — this game
  starts at that larger scale instead of needing a later bump).
* **Faces with personality**: every character gets an anime-style
  procedural face (big eyes, brow, mouth) via a shared face-drawing helper,
  but — unlike Kitchen Shift's one-size-fits-most `drawAnimeFace` — each
  personality template supplies its own expression parameters (e.g.
  Grumpy Regular: down-angled brows, flat mouth; Cheerful Kid: raised
  brows, wide smile; Karen: sharply angled brows, small tight mouth,
  reddish face tint during her scripted outburst) so patrons are visually
  distinguishable at a glance, not palette-swapped clones.
* **Sanity bar gets a distinct font**: Kitchen Shift's on-canvas Sanity
  label renders in a plain `'bold 10px sans-serif'` (`cooking-game.js`'s
  `drawSanityBar`) — this game's Sanity bar instead uses the site's own
  display font, **Caprasimo** (already self-hosted via `@font-face` in
  `web/static/css/app.css`, no new font file needed), e.g. `` `bold 11px
  "Caprasimo", sans-serif` `` with the generic family kept as a fallback.
  Since a canvas draw issued before a `@font-face` finishes loading
  silently falls back to the generic font with no error, the renderer
  must `await document.fonts.ready` (or `document.fonts.load(...)`)
  before the first frame that draws the Sanity bar, or retry the draw
  once the font's load promise resolves.
* **A visible clock**: the 8:00 AM-11:00 PM in-game time
  (`inGameTimeLabel`) is shown two ways — the HUD's `#library-hud-clock`
  text (already wired by the backend template) for at-a-glance tracking,
  and a diegetic **wall clock** drawn as floor decoration on the 1st
  Floor (analog clock face, hands positioned per the current in-game
  time) purely for scene flavor — the HUD text is the actual source of
  truth a player tracks time by, the wall clock is not a second
  interactive/authoritative display, just set dressing.
* **Minigame overlays** render on-canvas, not as separate DOM panels,
  matching Kitchen Shift's fridge/cabinet panel precedent where it makes
  sense but as full-canvas takeovers for the two "search the scene"
  minigames (Coin Hunt, Fines Sort), since both need a larger interactive
  area than a HUD-sized panel.

---

## UI

```text
web/templates/pages/
└── library-game.html          # {{define "library-game-content"}}
web/templates/components/
└── library-leaderboard.html   # leaderboard fragment (mirrors
                                # cooking-leaderboard.html)
```

States (see `tailwind-ui` for the full state list):

| State    | Behavior |
| -------- | -------- |
| Default  | Start screen → floor plan gameplay. |
| Loading  | HTMX nav swap uses `#nav-loading`, same as every other route. |
| Empty    | Leaderboard with zero rows renders an empty-state message, same as Kitchen Shift's leaderboard fragment. |
| Error    | Leaderboard fetch failure renders an inline error state in the fragment, same as `writeCookingLeaderboardError`'s pattern. |
| Success  | Score submission refreshes the leaderboard fragment with the new row visible. |

---

## HTMX Interactions

| Trigger                     | Method | Endpoint                       | Target                    | Swap        | Indicator |
| ---------------------------- | ------ | -------------------------------- | -------------------------- | ----------- | --------- |
| Projects "Play now" card     | GET    | `/library-game`                  | `#main-content`            | `outerHTML` | `#nav-loading` |
| Leaderboard panel open/refresh | GET  | `/library-game/leaderboard`      | `#library-leaderboard`     | `innerHTML` | local     |
| Final Paycheck submit form   | POST   | `/library-game/score`            | `#library-leaderboard-panel` | `outerHTML` | local     |

Confirmation required for destructive actions:

* "Reset progress" (clears `localStorage` save) — same confirm-dialog
  convention as Kitchen Shift/Fishing Game.

---

## Routes / Handlers

| Method | Path                       | Handler                       | Auth required | Notes |
| ------ | --------------------------- | -------------------------------- | ------------- | ----- |
| GET    | `/library-game`              | `LibraryGameHandler.Index`       | no            | Sets `ContentTemplate: "library-game-content"`. |
| GET    | `/library-game/leaderboard`  | `LibraryGameHandler.Leaderboard`  | no            | Bare fragment. |
| POST   | `/library-game/score`        | `LibraryGameHandler.SubmitScore`  | no            | Rate-limited per-IP, mirrors `CookingGameHandler.SubmitScore`. |

Registered in `cmd/server/main.go`'s `newMux`, following the exact
Fishing/Cooking game registration pattern (handler + service + repository
wiring in `cmd/server/main.go`'s dependency construction).

---

## Data Model

```sql
-- migrations/005_create_library_scores.sql
```

| Table           | Column           | Type        | Constraints                                         | Notes |
| ---------------- | ---------------- | ----------- | ----------------------------------------------------- | ----- |
| library_scores   | id               | BIGINT      | GENERATED ALWAYS AS IDENTITY PRIMARY KEY              | |
| library_scores   | player_name      | TEXT        | NOT NULL, length 1–20                                 | |
| library_scores   | total_earnings   | INT         | NOT NULL, range 0–100000                              | Gard total across the run. |
| library_scores   | shifts_completed | INT         | NOT NULL, range 1–30                                  | Wider than `cooking_scores`' 1-20 since this game always runs 30 shifts. |
| library_scores   | created_at       | TIMESTAMPTZ | NOT NULL DEFAULT now()                                | |

Same "leaderboard only, no per-player server-side state" posture as
`cooking_scores`/`fishing_scores` — in-progress shift state, Gard, and
shelf/book layout live in `localStorage` (`library-game:v1` key), not
Postgres, per this doc's Security Considerations and every other game's
established precedent.

---

## Business Rules / Validation

* **Shift tiers**: Tier 1 (shifts 1-10), Tier 2 (11-20), Tier 3 (21-30) —
  each with its own shift-clock budget and Return Cart/fine volume,
  mirroring Kitchen Shift's round-tier shape (`SHIFTS_PER_MONTH = 30`,
  reused directly rather than picking a different number).
* **In-game clock, paced slower than Kitchen Shift's**: each shift covers
  an 8:00 AM–11:00 PM library day (15 in-game hours, same
  `inGameTimeLabel`-style formatting as Kitchen Shift's clock), but the
  user explicitly asked that time not "go so fast" — Kitchen Shift
  compresses its own full day into a 120-300s real-time shift clock,
  which reads as very fast. This game's real-time shift-clock budgets per
  tier must be long enough that the 15-hour day advances at a noticeably
  slower, more readable pace: **600s/480s/360s (10/8/6 real minutes)**
  for Tiers 1/2/3, not Kitchen Shift's 300s/180s/120s — still shrinking
  per tier for difficulty, just from a much higher floor. (Tunable at
  implementation time like everything else in this section, but must stay
  well above Kitchen Shift's numbers, not just copy them.)
* **Karen shift**: chosen once per save as `randomInt(10, 15)` at month
  start (a fresh "Start New Month" re-rolls it, same as any other
  per-month scripted state), stored in the `localStorage` save so it's
  stable across a page reload mid-run.
* **Book routing**: every book has a genre/shelf id; shelving at the wrong
  shelf either blocks the skill-check from starting (preferred, avoids a
  silent wrong-shelf mistake — mirrors Kitchen Shift's dish-must-match-
  order strictness) or counts as a mistake if forced through, deferred as
  an implementation-agent decision within this doc's spirit.
* **Coin Hunt frequency**: a configurable fraction of returned books (e.g.
  ~1 in 5) are Coin Hunt books, tuned by a named constant, not hardcoded
  inline — matching this codebase's convention of named, doc-referenced
  tuning constants (`SHIFT_PAYCHECK_FULL`, etc. in Kitchen Shift's
  `rules.js`).
* **Payout**: `shiftPaycheck(mistakeCount)` — a base amount minus a flat
  per-mistake penalty, floored above zero (never a hard game-over),
  matching Kitchen Shift's `shiftPaycheck` shape exactly; Coin Hunt finds
  and fines processed add on top rather than replacing the base.
* **Closing wait**: when the shift clock reaches 11:00 PM, the game enters
  a `closing-wait` phase (named alongside Kitchen Shift's own
  `closing-clean`/`closing-dishes` phase-naming convention) lasting
  exactly 20 real seconds; the Boss's Office station is non-interactive
  until that timer elapses, at which point it becomes enterable and
  walking in immediately triggers the paycheck (no further confirmation
  step) — "the boss will let you inside" once the wait is over, not
  before.
* **Sanity/Coffee Machine**: Sanity drains passively and per-mistake
  exactly as Kitchen Shift's does (same constants, reused); visiting the
  Coffee Machine station restores it to full, with no cooldown or limit
  on how often it can be used per shift, matching Kitchen Shift's own
  Coffee Machine rule.
* **Fines are Gard-only**: the Fines Sort minigame's clutter never
  includes any other currency type as a "correct" pick — only coins and
  Gard bills count; other clutter items are decoys that do nothing if
  clicked (not penalized), keeping the minigame about finding the right
  items, not punishing exploration.
* **Find the Book decoys**: the Find the Book minigame's shelf scene
  includes several visually-similar wrong books (same shelf/genre color,
  different title) alongside the one correct match — clicking a wrong
  book is a miss (costs time/patience) but not an instant mistake,
  matching the Fines Sort minigame's "decoys do nothing punitive by
  themselves" posture; only running out of the patron's patience while
  searching counts as a mistake.

---

## Security Considerations

* **Authz**: `/library-game` and its leaderboard GET are unauthenticated,
  matching Fishing Game/Kitchen Shift. `POST /library-game/score` is
  rate-limited per-IP via a dedicated `scoreSubmitLimiter` instance (own
  limit/window, not shared with the other two games' limiters).
* **Input handling**: `player_name`/`total_earnings`/`shifts_completed`
  validated server-side against the same bounds as the DB CHECK
  constraints before insert (mirrors `internal/service/
  cooking_validation.go`'s pattern) — never trust client-submitted Gard
  totals beyond range-checking them.
* **No new secrets/config** introduced by this feature.

---

## Testing Plan

* [x] Go: handler tests for `/library-game`, `/library-game/leaderboard`,
      `/library-game/score` (happy path, validation-rejection path,
      rate-limit path) — mirrors `cooking_game_test.go`.
* [x] Go: `internal/service/library_validation_test.go` /
      `library_service_test.go` — mirrors the cooking-game equivalents.
* [x] Real-Postgres end-to-end subtest in `cmd/server/e2e_test.go` — round
      trip through the real `library_scores` table.
* [x] JS (`node --test`): shift-tier math, Karen-shift selection range
      (always 10-15), `shiftPaycheck` payout math, Coin Hunt frequency
      constant, Shelf Skill-Check pass/fail thresholds (`library/rules.test.js`,
      `library/engine-state.test.js`, `library/floor-plan.test.js` — 109
      pure game-logic tests plus the floor-plan geometry suite).
* [x] Playwright (`e2e/library-game.spec.js`): start screen → floor plan →
      shelve a normal book (Shelf Skill-Check) → shelve a Coin Hunt book →
      process a fine at the Fines Counter (Fines Sort) → fulfill a borrow
      request (Find the Book → Checkout Skill-Check) → full shift →
      payout screen → leaderboard submission round-trip; plus the
      HTMX-revisit regression class already known to bite every canvas
      game on this site (`docs/features/cooking-game.md`'s "Another real
      bug" note) — visiting `/library-game`, navigating away, and
      returning must still be fully interactive. Also covers the two-floor
      Stairs/Elevator/HUD-button switch (including mid-`closing-wait`) and
      both Karen outcomes. 17 tests, passing on both Chromium and WebKit.
      Real click-to-play coordinates come from `window.__libraryGameTestHooks`
      (see that file's header comment) rather than waiting out this game's
      600/480/360-real-second shift clocks or guessing at randomly-scattered
      item positions.
* [x] Manual verification in a real browser: a full click-driven shift
      (shelving, Coin Hunt, a fine, a borrow request, the Coffee Machine,
      a forced Karen event, closing-wait, payout) and dark mode, both with
      zero console errors.

---

## Open Questions

* Exact skill-check difficulty curve per tier, exact Coin Hunt frequency
  constant, and exact fine/Return Cart volume per tier are left as
  implementation-time tuning, same as Kitchen Shift's own recipe/gear
  magnitudes ("illustrative/tunable... nothing in that tuning blocks
  calling this Shipped"). **Landed values** (`web/static/js/library/
  rules.js`): `COIN_HUNT_FREQUENCY=0.2`, `ROUND_TIER_RETURN_VOLUME=[6,10,16]`,
  `ROUND_TIER_FINE_VOLUME=[2,4,6]`, `ROUND_TIER_BORROW_VOLUME=[2,4,6]`,
  `ROUND_TIER_CLOCK_SECONDS=[600,480,360]` (per the "don't go so fast"
  request — deliberately far above Kitchen Shift's 300/180/120).
* **Resolved**: wrong-shelf attempts block the Shelf Skill-Check from
  starting at all (`arriveAtShelf`) rather than counting as a forced
  mistake — no silent wrong-shelf penalty is possible.
* **Resolved**: Karen's scripted beat — a forced, two-outcome event with a
  12-second timer (`KAREN_EVENT_TIMER_SECONDS`) firing once on her
  deterministically-seeded shift (`karenShiftForSeed`, stable per save,
  re-rolled on "Start New Month"). `collectFine` (handled well) banks
  `KAREN_FINE_AMOUNT_GARD` (60) with no cost; `letItSlide` (mishandled) —
  or letting her 12-second timer expire unresolved, which auto-resolves
  as `letItSlide` — counts as a mistake and drains `libraryMood` by
  `KAREN_MOOD_PENALTY` (50, double the normal per-mistake drain) plus the
  standard Sanity hit. See `engine-state.js`'s `startKarenEvent`/
  `resolveKarenEvent`.
* Failure semantics for the other minigames (landed, not left open): Shelf/
  Checkout Skill-Check and Fines Sort failures count a mistake but let the
  player retry immediately with the item still in hand; only a borrow
  request's search-phase patience timing out drops the request outright,
  matching this doc's "only running out of the patron's patience while
  searching counts as a mistake" Business Rule for Find the Book.

---

## Definition of Done

* [x] User flow works end-to-end, including edge cases above.
* [x] All states in the UI table are implemented.
* [x] Migration written, reviewed, includes a working `Down`.
* [x] Handler/service/repository boundaries followed (`go-backend`).
* [x] Accessibility checked: hovering a station and pressing Enter walks to
      it, same as Kitchen Shift's own click-only-plus-Enter posture; the
      shared Shelf/Checkout Skill-Check overlay also accepts Space/Enter as
      a non-pointer alternative to clicking. The two "search the scene"
      minigames (Coin Hunt, Fines Sort, Find the Book) remain pointer-only,
      matching Kitchen Shift's precedent that scene-search interactions
      need pointer precision ("where feasible" — a keyboard equivalent for
      *finding* a specific scattered item isn't).
* [x] Tests cover the behavior in the Testing Plan above.
* [x] `/library-game` added to the Projects grid with a real screenshot.
* [x] No open questions remain unresolved.
