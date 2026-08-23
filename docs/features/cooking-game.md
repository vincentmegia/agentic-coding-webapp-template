# Feature: Kitchen Shift

## Status

`Shipped` — implemented and covered by tests: Go (validation/leaderboard,
`internal/service/cooking_validation_test.go`/`cooking_service_test.go`,
`internal/handler/cooking_game_test.go`), JS (`rules.js`/`engine-state.js`/
`floor-plan.js` via `node --test`), and a real-Postgres end-to-end subtest
in `cmd/server/e2e_test.go` ("kitchen shift routes round-trip through the
real cooking_scores table"). Manually verified in a real browser session:
start screen → floor plan → station interaction/hints → a full 30-shift
month (including both a clean-shift and an upset-shift payout) → Final
Paycheck → leaderboard submission round-trip, shop open/close, no console
errors. Recipe/gear/ramp magnitudes remain illustrative/tunable, as called
out throughout the rules docs and Open Questions — nothing in that tuning
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
  cosmetic only, not an interactive station (see the customer rules doc).
* An **in-game restaurant clock** (8:30 AM–11:30 PM) replacing the HUD's
  mm:ss countdown — the same underlying shift-clock seconds, just
  formatted as a time of day (`rules.js`'s `inGameTimeLabel`).
* Three recurring/scripted customers, layered on top of the normal random
  arrival pool (the customer rules doc has the full rundown): **Mel**, sweet and
  kind, guaranteed to appear exactly once every shift (v3.35: at a
  randomized point, no longer forced into the literal first slot), with
  her own usual order and extra patience; **Olive & Oliver**, an engaged
  couple sharing one table and one order, likewise guaranteed once a
  shift at a randomized point rather than unconditionally right after
  Mel; and **Karen**, a one-time disruptive customer on shift 12, with a
  short fuse whose failure ripples into upsetting one other table too.

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

**v3 restyle** — the user reported the v2 pixel-art scene was too small to
read ("i cant even see the characters") and asked for a different visual
style entirely ("coquette" — soft pastel, rounded, ribbon/bow accents, per
two reference images), plus a batch of smaller fixes surfaced by that same
screenshot: a Restroom station ("in case the customers need to take a
dump"), the Sanity bar moved from external HUD chrome onto the canvas
itself, visible Entrance/Exit signage, star-themed chair pillows, and a
named/detailed personality pass on Mel (favorite colors/flowers, outfit,
hobby). Shipped in this pass:

* **Coquette rendering pass**: replaced every pixel-art primitive (sharp
  `fillRect` boxes, blocky pixel-people) with rounded shapes
  (`ctx.roundRect`-based `drawRoundRect`), a soft pastel palette, and new
  bow/star accent shapes (`drawBow`, `drawStar`). Real illustrated anime-
  style art needs hand-drawn/generated sprite assets this canvas-primitive
  renderer doesn't have (Open Questions) — this is the closest honest
  approximation buildable from flat shapes. The `.pixel-canvas` CSS class
  and its `image-rendering: pixelated` treatment are removed entirely.
* **A dedicated `drawMel` renderer**, distinct from the generic
  `drawPixelPerson` used for every other customer: a dandelion tucked
  behind her ear, a yellow hair clip, hair tied in a white ribbon, a
  flower-patterned yellow shirt, and a plain white skirt — per the user's
  detailed character spec (Visual Direction has the full rundown).
* **A real bug fix, not just a style change**: every on-canvas label
  (station names, "dirty"/"clean," the dirty-dish count) used a cream/
  white fill color tuned for v2's dark-wood palette — against the new
  light pastel floor, that text was nearly invisible. This is the actual
  root cause behind "where is the coffee machine???," not a coincidence of
  timing. Fixed with a single dark `LABEL_TEXT_COLOR` plus a small opaque
  chip drawn behind every label (`drawLabelChip`) so it stays legible
  against any station color.
* **On-canvas Sanity bar** (`drawSanityBar`, top-left corner of the floor
  plan), replacing the external HUD's `#cooking-hud-sanity-fill`/`-label`
  DOM elements entirely — per the user's "add the sanity bar inside the
  game instead of outside."
* **A Restroom station** (`toilet` station kind) — decorative only, same
  as the Security Guard, no gameplay effect.
* **Visible Entrance/Exit and restaurant-name signage**, drawn directly on
  the floor (`drawFloor`) — answers the user's "where is the entrance and
  the exit???" literally rather than adding a new interactive station for
  something with no separate mechanic.
* **Star-themed chair pillows** (`drawChairPillows`) around every table,
  and a light star watermark scattered across the floor tile pattern.
* **A real second bug fix, caught during this same pass**: two bottom-row
  stations (Counter, Coffee Machine) sit close enough to the canvas's
  bottom edge that their labels, drawn below the box the same way every
  other station's is, rendered partially or fully off-canvas — invisible
  regardless of color. Fixed by flipping the label above the box for any
  station where it wouldn't fit below (`drawStation`'s `labelBelowFits`
  check), rather than repositioning every station's coordinates.
* **Label collisions with the floor's own decorative text**: the
  "Startime Diner" sign was originally centered over the boss's-office
  column, so Duke's Office's own label chip (drawn afterward, on top)
  clipped straight through it. Moved to a clear corner of the floor
  instead of debugging a shared column.

Manually re-verified after the restyle: JS (`node --test`, 197 tests) and
Go (`go build`/`go vet`/`go test`) suites all green, `make css` rebuilt for
the new arbitrary-value Tailwind class, zero console errors on
`/kitchen-shift`, and the floor plan visually confirmed via Playwright
screenshots — legible labels, visible Sanity bar, visible signage, no
overlapping text.

**v3.1 room split** — the user asked for the fridge/cabinet/cookware
closet/stove/oven/cleaning closet to stop being "in random places in the
dining [room]" and move into their own Kitchen, reachable through a door
and a button. The single 960x600 floor plan is now two rooms sharing that
same canvas (never shown at once, so no bigger/split canvas was needed):

* **Dining room** (the default, where every shift starts): all 30 tables,
  the front counter, boss's office, coffee machine, restroom, entrance/exit
  signage, the security guard, and a new **kitchen-door** station.
* **Kitchen room**: fridge, cabinet, cookware closet ("supply closet"),
  stove, oven, cleaning closet, and a new **dining-door** station leading
  back.
* Walking up to either door station switches the active room instantly (no
  loading state) and repositions the player near that room's entry point
  (`floor-plan.js`'s `KITCHEN_ENTRY_POINT`/`DINING_ENTRY_POINT`). An
  **"Enter Kitchen" / "Back to Dining" button** in the HUD row does the
  same switch instantly from wherever the player currently stands — the
  user asked for both "a door to the kitchen" and "a button to enter the
  kitchen," so both exist side by side rather than picking one.
* Only the active room's stations render or respond to clicks/hover
  (`floor-plan.js`'s new `stationsInRoom` filter) — the inactive room's
  stations are entirely invisible and non-interactive, not just visually
  hidden.
* **Room switching works in every shift phase, not just `playing`** — this
  was the critical constraint: the closing sequence needs both rooms
  (dirty tables and the counter/boss's office are in Dining, the cleaning
  closet is in Kitchen), so gating the doors to one phase would make a
  shift unwinnable mid-closing. Manually verified end-to-end: waited out a
  full shift clock, switched to Kitchen to wash dishes at the cleaning
  closet, switched back to Dining to shut down at the counter, then
  collected the paycheck at the boss's office — all via real clicks, zero
  console errors, `4000 Gard` payout confirmed on the paycheck screen.

**v3.2 intro sequence** — alongside the v3 restyle request, the user also
asked for a one-time intro: the player walking in from the entrance with a
specific opening line of dialogue. Shipped as a short scripted sequence
(`cooking-game.js`'s `playIntro()`) that runs exactly once, ever, on the
very first "Start Shift" click on a given device — gated on a new
`hasSeenIntro` boolean in the `cooking-game:v2` `localStorage` save (see
Client-side Behavior's Progress persistence). The player character walks
from a fixed spot near the floor's Entrance/Exit door (v3.32: a door
sprite; plain floor text at the time this intro shipped) to their
normal `PLAYER_START` position using the same movement code real gameplay
uses (`updatePlayer`, `floor-plan.js`'s geometry), then a dialogue box
reveals the line verbatim and a "Let's get to work!" button starts the
shift for real. Every later "Start Shift"/"Start Next Shift"/"Start New
Month" click skips straight to gameplay, since `hasSeenIntro` is already
`true` by then; "Reset progress" clears it back to `false` along with the
rest of the save, so the intro also replays once after a reset — treated
as a fresh save, not a special case.

**Real bug caught and fixed before shipping this**: the dialogue box's
first draft sat at the bottom of the canvas — the same region the
entrance-to-`PLAYER_START` walk crosses — so the walking player sprite was
completely hidden behind the card for the whole animation, defeating the
point of a "player walking in" cutscene. Fixed by keeping the dialogue box
hidden until the walk finishes (`moveTarget` clears), so the walk itself
is fully visible first and the dialogue only appears once the player has
actually arrived. Under `prefers-reduced-motion`, the walk is skipped
entirely (player starts already at `PLAYER_START`) and the dialogue shows
immediately — same reveal-after-arrival code path either way, since
"arrival" is instant in that case.

Manually verified via Playwright: a fresh browser/`localStorage` shows the
walk-in animation (confirmed via a mid-walk screenshot with no dialogue box
visible) followed by the dialogue box with the exact line, "Let's get to
work!" starts real gameplay, `hasSeenIntro` is persisted `true` in
`localStorage`, and a second shift (same `localStorage`, via the
`skipToClosing`/`collectPaycheck` test hooks) does not replay the intro.
Zero console errors. JS (`node --test`) and Go (`go build`/`go vet`/
`go test`) suites green; `make css` rebuilt for the intro card's new
arbitrary-value Tailwind class.

**v3.3 bigger characters + anime-style faces** — the user reported the
game reading too small and asked for bigger characters plus generated
anime-art-style faces. This project has no image/sprite assets anywhere
(every station/ingredient/dish/person is a canvas primitive — see Visual
Direction and the Open Questions entry on real sprite art, still
deliberately deferred), so "anime style" here means a new `drawAnimeFace`
helper drawn procedurally on the lower half of every character's head
circle: big vertical-oval eyes (white sclera, a colored iris, a small
sparkle highlight), thin eyebrows, two blush ovals, and a small curved
smile. It's called from inside `drawPixelPerson` itself, so every
character gets one automatically — the player, generic table customers,
Karen, Olive & Oliver, the security guard, and Mel (via her `drawMel`
wrapper, which calls `drawPixelPerson` first). Every character's `scale`
argument was also raised (player 1 → 1.25, generic customers/Karen 0.85 →
1.05, Mel 0.85 → 1.05, Olive & Oliver 0.78 → 0.95, security guard 0.9 →
1.1) — verified via Playwright screenshots that the bigger scale doesn't
cause a seated customer to visually clip into the table row below it, or
Olive & Oliver's two side-by-side sprites to overlap each other.

**Real regression caught and fixed in a later session**: the scale bump
above pushed a seated customer's legs roughly 18-19px below the table
station's own (unextended) click/hover hit box — `stationAtPoint`
(`floor-plan.js`) only ever tested a symmetric box around a station's
`x, y, size`, with no awareness that `drawTableContents` draws the
customer sprite starting *below* that box, not inside it. The visible
character was bigger than before, but the table's clickable area
wasn't, so clicking directly on a seated customer (exactly where a
player naturally aims to "hand them their order") silently missed —
reported by the user as "when i try to give customers their orders i
click on them but i cant." Fixed with a new optional `hitExtendDown`
field: `stationAtPoint` now extends a station's bottom hit-test edge by
that amount if present (stations without it, i.e. every non-table
station, keep the exact same symmetric box as before — a fully
backward-compatible change), and `buildStations` gives every table a
`hitExtendDown: TABLE_HIT_EXTEND_DOWN` (22px, comfortably covering the
customer's feet with a small buffer while staying clear of the table
row 85px below and the bottom-row counter/coffee-machine fixtures — see
`TABLE_HIT_EXTEND_DOWN`'s doc comment in `floor-plan.js` for the exact
margin math). Covered by new `floor-plan.test.js` cases, and manually
verified via Playwright: clicking at a table's world y+38 (inside the
old miss zone, inside the new extended one) now correctly takes/serves
the order.

Also fixed in the same session: the Fullscreen toggle already existed but
didn't actually do anything useful — the game container's own
`max-w-[900px]`/`aspect-[960/600]` CSS kept winning even inside the
browser's Fullscreen API state, so "Fullscreen" just centered the same
small box on a black backdrop. `app.css` now overrides both under the
native `:fullscreen` selector so the container actually fills the
display, with `object-fit: contain` on the canvas letterboxing its fixed
960x600 buffer to any screen's aspect ratio. `startShift()` also requests
Fullscreen automatically (best-effort, silently swallowed if a browser
refuses it), so "Start Shift"/"Start Next Shift"/"Start New Month" launch
the game full-size without the player needing to find the button first —
see the UI States table's Fullscreen row and Client-side Behavior's
Fullscreen entry for the full mechanism.

**v3.4 orders bar moved inside the fullscreen window** — the user then
asked for the Orders list to be "on the same window" as the game, since
it was still HUD chrome living outside `#cooking-game-container` (the
Fullscreen API target from v3.3), so it disappeared behind the game
entirely once Fullscreen engaged. The Orders `<ul>` (`#cooking-order-queue`
— unchanged, `renderOrderQueue()` still just repopulates its innerHTML,
same as before) moved from the external HUD column into a new slim bar
that's the first child of `#cooking-game-container` itself, above a new
`#cooking-canvas-wrapper` inner `<div>` that now carries the
`aspect-[960/600]` sizing (and holds the canvas plus every overlay
screen) that used to live directly on the outer container. It's a bar
above the canvas, not an absolute overlay on top of it, deliberately —
the floor plan's top row of stations (toilet, boss's office, kitchen
door) already fills that space, and an opaque overlay there would block
clicks from ever reaching them.

`toggleFullscreen()`/`requestFullscreen()` in `cooking-game.js` now look
up `#cooking-game-container` by id rather than reading
`canvas.parentElement` (which is `#cooking-canvas-wrapper` now, one level
narrower) — fullscreening just the wrapper would again leave the Orders
bar behind. `app.css`'s `:fullscreen` override was updated to match: the
outer container still fills the viewport, but `#cooking-canvas-wrapper`
switches from its normal aspect-ratio-derived height to `flex: 1 1 auto`
(filling whatever vertical space is left under the Orders bar), with
`object-fit: contain` on the canvas still letterboxing it to fit that
space. Verified via Playwright: the Orders bar renders correctly in both
windowed and fullscreen modes, and updates live (Mel's order text
appeared in the fullscreen bar within a few seconds of "Start Shift").
Immediately followed by "make the orders bigger": the "Orders" label and
list text went from `text-[10px]`/`text-xs` to `text-xs`/`text-sm`
(label) and `text-sm`/`text-base` (list, at the `sm:` breakpoint each
time), with the bar's padding, item spacing, and `max-h` all increased
to match so the bigger text has room.

**v3.5 fullscreen hid the Room/Recipes/Fullscreen buttons; Enter key added**
— the user reported "when i press my mouse its not working" trying to give
customers their orders. Two real bugs, both regressions from the fullscreen
work above:

1. Taking/serving an order at a table still worked correctly (v3.3's
   `TABLE_HIT_EXTEND_DOWN` fix held up), but the Shift/Time/Status HUD and
   the Enter Kitchen/Recipes/Fullscreen buttons were never moved into
   `#cooking-game-container` the way the Orders bar was in v3.4 — they
   still lived directly in the page's HUD column, outside the Fullscreen
   API target. The Fullscreen API renders its target element in the
   browser's own top layer, above everything else in the page, so once a
   shift auto-launched Fullscreen (v3.3's `startShift()` behavior), those
   buttons became completely unclickable — confirmed with a Playwright
   test where clicking `#cooking-room-button` timed out with "canvas...
   subtree intercepts pointer events." Without "Enter Kitchen," a player
   can still reach the Kitchen room via the canvas's own kitchen-door
   station, but "Recipes" and exiting Fullscreen had no working equivalent
   at all — likely the real substance of "my mouse isn't working." Fixed
   by moving that whole HUD+buttons row inside `#cooking-game-container`
   too, as a second bar above the Orders bar (same reasoning, same
   `border-b bg-surface-2/95` styling).
2. Added an Enter-key shortcut as the user requested ("clicks the
   mouse/enter"): a new `onKeyDown` listener triggers the exact same
   interaction as clicking, targeting whichever station the mouse is
   currently hovering (`hoverStation`, already tracked continuously by
   `onCanvasMouseMove`) — so lining the cursor up on a customer and
   pressing Enter works even if a literal click doesn't land. Both paths
   now share a `commitStationTarget(station, rawPoint)` helper factored
   out of the old `onCanvasClick` body. Guarded identically to
   `onCanvasClick` (no-op if a panel/recipe book is open or no shift is
   running) so it doesn't interfere with the Final Paycheck screen's
   leaderboard name `<input>` — `running` is already `false` by the time
   that's visible, so Enter there submits the form normally. The hover
   tooltip (`#cooking-interact-hint`) now appends " (Enter)" to surface
   the shortcut. Verified end-to-end via Playwright: click "Start Shift"
   (Fullscreen engages) → take Mel's order via a leg-click → click "Enter
   Kitchen" (previously hung) → gather her ingredients at the fridge/
   cabinet → click back to Dining → hover her table and press Enter →
   dish served, order queue empty again, zero console errors.

**v3.6 the actual root cause: letterbox-unaware click coordinates** — the
user reported v3.5's fix hadn't actually resolved anything ("ITS NOT
WORKING WHEN I CLICK IT OR PRESS ENTER"), confirmed a hard refresh, and
narrowed it to "taking the order" specifically. v3.5's own Playwright
verification had passed because its synthetic clicks were computed with
the *same* naive `rect.width`/`rect.height` formula `canvasCoordsFromEvent`
itself uses — a click position and its own inverse both being wrong in
the identical way makes a test self-consistent but doesn't catch a real
mapping bug. Re-verified instead against a simulated real 16:9 monitor
(1920x1080) in fullscreen, confirming via direct pixel-color sampling of
a screenshot (locating the Restroom station's distinct `#cfe8ec` fill)
that the actual on-screen game content was pillarboxed to x≈285-1633 of
the canvas's full 1918px-wide CSS box, not stretched across the whole
box — `object-fit: contain` (added in v3.3's Fullscreen work) really was
letterboxing the canvas as designed. The bug: `canvas.getBoundingClientRect()`
still reports the *full* box, bars included, and `canvasCoordsFromEvent`
was naively scaling clicks by that full box's width/height, silently
mapping every click to the wrong world position by however much bar
padding existed — on this test's 1920x1080/fullscreen case, that's
~192px of unaccounted-for padding on each side, an error large enough to
make nearly every click land on the wrong station or nothing at all. Real
desktop monitors are essentially never exactly 960:600, so this wasn't
an edge case — it affected every fullscreen session (which is every
session, since v3.3 auto-requests Fullscreen on "Start Shift") on any
screen whose aspect ratio didn't happen to match the game's. Fixed by
having `canvasCoordsFromEvent` compute the actual rendered content
rectangle within the box (mirroring what `object-fit: contain` draws —
comparing box aspect ratio to world aspect ratio, then pillarboxing or
letterboxing offsets accordingly) and mapping clicks against *that*
instead of the raw box. `onCanvasMouseMove` (and therefore hover/Enter
targeting too, since both share this function) gets the same fix for
free. In non-fullscreen play the box is already `aspect-[960/600]`-
locked so this is a no-op there — purely corrective for the letterboxed
case. Re-verified via Playwright at the *actual* visually-correct pixel
position (derived from the same corrected transform, not the game's own
code) on a simulated 1920x1080 screen: take order → click "Enter
Kitchen" → gather ingredients at fridge/cabinet → back to Dining → serve
via Enter key at the real hover position — full loop succeeds, zero
console errors.

**v3.7 dish icons + a carrying animation** — the user asked for "the
images of the food" to replace plain text, plus an animation of the
character carrying food, and to review a design before it landed. This
project has no image assets anywhere (see the v3.3 changelog note and
Open Questions) and no image-generation tool is available in this
environment, so — flagged to the user up front — these are flat,
canvas-drawn icons (the same technique as the character faces), not
photographic or hand-painted sprite art. A design mockup (a
claude.ai/design canvas) was built and reviewed with the user before any
game code changed, covering: icon concepts for all 10 finished dishes,
and a 3-frame concept for the player's carrying pose (current text chip
→ dish icon held on a tray → a bob frame). The user approved it as
shown ("yes, lets create the icons and apply in the game"), settling the
scope questions raised at review by default: only the 10 finished
dishes get icons; the ~19 raw ingredients in the Fridge/Cabinet
pick-lists, and a customer's own held-order indicator, stay text.

Implementation, ported from the approved mockup's SVG shapes to canvas
2D primitives:

* `drawDishIcon(ctx, cx, cy, dishName, size)` dispatches to one
  `drawXIcon(ctx)` function per dish name (`DISH_ICON_DRAWERS`), each
  assuming it's been translated/scaled into a local 100x100 box —
  `drawQuadBlob`/`drawWaveStrip` are small new shared helpers (a closed
  quadratic-curve blob for leaf/petal shapes; a wavy strip for lettuce/
  bun edges) alongside the existing `drawStar`/`drawBow`, which two
  icons reuse directly (Mel's Usual's cake gets a `drawStar`, matching
  the restaurant's existing star theme).
* `drawPersonHead` was factored out of `drawPixelPerson` (the
  head/hair/anime-face/bow/marker stack) so the new carrying pose could
  reuse it without duplicating that code.
* `drawPlayerCarrying(ctx, x, y, dishName, bobOffset)`: legs stay in
  their normal `drawPixelPerson` position; the torso/arms rotate inward
  around a small tray (`ctx.rotate` around each shoulder, mirroring the
  mockup's SVG transform), replacing the old floating dish-name text
  chip entirely when `heldDish` is set — a raw ingredient still in
  progress (`inventory`, no `heldDish` yet) keeps the plain text chip,
  per the confirmed scope. **Superseded twice since**: v3.8 moved the
  dish icon off this chest-height tray into a badge above the head (too
  small to read directly on the tray at the game's real on-screen
  size); v3.9 gave raw ingredients icons too, dropping the text chip
  they'd kept here; v3.10 moved the food back onto the tray for good,
  now sized big enough to stay legible there — see those entries below
  for the actual current behavior, which supersedes all of this bullet
  and the next one.
* The bob: a `carryBobPhase` accumulator advances (`deltaSeconds *
  CARRY_BOB_SPEED`) in `updatePlayer()` whenever the player is walking;
  `drawPlayer()` feeds `Math.sin(carryBobPhase) * CARRY_BOB_AMPLITUDE`
  into `drawPlayerCarrying` as `bobOffset` only while `heldDish` is set
  and `moveTarget` is active (standing still holding a dish shows the
  static pose, no bob) — legs stay planted while the upper body/tray
  offset moves, matching the reviewed mockup's "carry-bounce, not a new
  walk cycle" note.

Verified: a standalone preview harness rendering all 10 icons side by
side (caught and fixed two weak ones before shipping — Roast Chicken's
herb sprig read as a stray spike, redrawn shorter and closer to the
bird; Soufflé's puffy top read as a flame, redrawn as a cluster of
overlapping circles instead of one traced outline) and, in the real
game via Playwright, the full take-order → gather-ingredients →
auto-assemble → walk-while-carrying flow, screenshotted mid-walk to
confirm the tray + dish icon render correctly on the player and persist
correctly as the walk continues. `go build`/`go vet`/`go test` and
`node --test` all green.

**v3.8 the carrying icon was invisible at real game scale** — the user
reported "the server sprite doesn't show its carrying the food." v3.7's
own Playwright verification had captured the right *shapes* rendering
without errors, but every screenshot used either a large fullscreen
viewport or a cropped/zoomed-in view — never what the game actually
looks like at its normal embedded, non-fullscreen size (a ~646x404px
canvas box in a typical viewport, per `docs/features/home.md`'s
Container width rule). Re-checked against that real size instead: a
screenshot clipped to the canvas, then cropped to the player's *native,
un-upscaled* pixels (no zoom, no interpolation) — the 15px-wide dish
icon sitting on a 14px-tall tray at chest height, next to the arms and
overlapping the torso's blue, was an indistinct smudge, not
identifiable as food at all. The tray-at-chest treatment matched the
reviewed mockup faithfully, but that mockup was reviewed at a large
illustrative scale that doesn't reflect the ~24px-tall sprite the game
actually renders.

Fixed by moving the dish icon off the chest tray entirely and into a
26px circular badge above the player's head — the same position/size
class the old (legible) text chip occupied, on the plain floor
background rather than competing with the torso's color and the arms'
detail. The chest-height tray and bent-arm pose stay as-is for the
carrying *gesture*, just without an icon drawn on the tray itself now.
Re-verified the same way that caught the bug: a real (non-fullscreen)
Playwright screenshot cropped to the player's native pixel size — the
badge and its dish icon (Mel's Usual: the lemonade glass + star cake
wedge) are both clearly legible at that size, at both 1x and a 4x
inspection crop. `go build`/`go vet`/`go test` and `node --test` all
green.

**v3.9 raw ingredients get icons too (scope expanded)** — the user
reported v3.8 "still the same bug," with a screenshot showing a
`"Cheese, Milk"` text chip. That traced to correct-but-confusing
behavior, not a bug: `heldDish` was null (the ingredients hadn't been
cooked/assembled into a dish yet), so `drawPlayer()` was hitting the
`inventory.length > 0` branch — the plain text chip explicitly kept for
raw ingredients at the v3.7 design review (see that changelog note and
Open Questions). Traced and explained to the user directly, alongside
the doc passage that already described this as intentional — so there
was no actual doc-vs-implementation mismatch to fix there (a stale code
comment referencing "v3.5" instead of "v3.7" for that scope decision
was fixed in passing, though). But walking ingredients to a station
before cooking is what a player sees far more of than the brief moment
of holding a finished dish, so this was a real under-scoping — asked
the user directly (`AskUserQuestion`) whether to expand it, and they
said yes.

Added: one small icon function per `FRIDGE_INGREDIENTS`/
`CABINET_INGREDIENTS` name (rules.js) — 19 total (Cheese, Milk, Chicken,
Patty, Steak, Lettuce, Tomato, Egg, Lemonade, Matcha, Bread, Flour,
Noodles, Herbs, Buns, Sauce, Potato, Star Cake, Cake) — deliberately
simpler than the dish icons (1-2 shapes each, not a composed scene),
since several render at once, smaller. `drawDishIcon`/
`drawIngredientIcon` now share a `drawIconAt` translate/scale helper
rather than duplicating it. `drawPlayerCarrying` (v3.7/v3.8) was split
into a shared `drawPlayerHolding` (the body/pose — legs, torso, bent
arms, tray, head) plus a `drawBadge` callback, so a new
`drawPlayerCarryingIngredients` could reuse the exact same pose for a
*pill*-shaped badge (wide enough for every held item, one small icon
each) instead of the single dish's round badge. `drawPlayer()` now
branches `heldDish` → `drawPlayerCarrying`, else `inventory.length > 0`
→ `drawPlayerCarryingIngredients`, else the plain empty-handed stance —
the text-chip code path is gone entirely for both cases now.

Verified: a standalone preview harness for all 19 ingredient icons
(caught and fixed one real legibility bug before shipping — Star Cake's
white star was invisible against its pink wedge at small size, making
it indistinguishable from plain Cake; redrawn bigger and gold instead of
white, matching the egg yolk color) and, in the real game via
Playwright at real (non-fullscreen) scale, reproduced the user's exact
screenshot scenario — walk to the fridge, pick up Cheese + Milk — then
cropped to the player's native pixel size: both icons are clearly
legible in the pill badge, in the same spot the old text chip used to
be. `go build`/`go vet`/`go test` and `node --test` all green.

**v3.10 food back on the tray, stacking as it's gathered** — the user
pushed back on v3.8's badge-above-the-head placement: they wanted the
carried food to render on the tray itself for a realistic look, and to
keep stacking icons onto it as more items are gathered. v3.8 had moved
the icon off the tray specifically because a small icon there read as
an indistinct smudge at the game's real on-screen size — reconciled
this time by making the tray substantially bigger (`TRAY_RX`/
`TRAY_RY`, roughly 1.5x the original v3.7 tray) instead of relocating
the food elsewhere, so it's both on the tray and legible.
`drawPlayerHolding` (the shared body/pose helper) now returns
`{trayX, trayY, s}` instead of taking a badge-drawing callback, so
`drawPlayerCarrying`/`drawPlayerCarryingIngredients` draw straight onto
the tray afterward — after, not before, `drawPlayerHolding` draws the
head, so the food is never at risk of being drawn underneath it.

A real regression caught and fixed before shipping: the first pass
enlarged the tray without moving it, so its top edge landed exactly on
the bottom of the head — overlapping it in a real screenshot check.
Fixed by lowering the tray's vertical position (closer to the arms/
torso) rather than shrinking it back down. A single finished dish gets
one generously-sized icon (28px at the player's scale) centered on the
tray; multiple raw ingredients stack onto it as they're picked up — up
to 3 across in one row (a full recipe's worth, the common case, since
`BASE_CARRY_CAPACITY` is 3 and most dishes need exactly that many
ingredients), a second, higher row for anything beyond that (gear can
push carry capacity to 8), with icons shrinking a little as more items
join so a fuller tray still fits. Re-verified via Playwright at real
(non-fullscreen) scale, cropped to native pixel size: 3 ingredients
(Cheese, Milk, Egg) all distinguishable in one row on the tray with no
head overlap, and a finished dish (Mel's Usual) rendering large and
clear on its own. `go build`/`go vet`/`go test` and `node --test` all
green.

**v3.11 mistakes now cost Gard directly, and sour the restaurant's mood**
— the user asked to "update the rules of the game," starting with the
food server: wrong-dish serves should deduct points, customers should get
"irritated," and mistakes should raise "the ch[a]nce of leaving... with
bad review." Reviewed with the user first (two `AskUserQuestion` calls)
since this reverses a documented design decision — the old flat "4,000
unless anything went wrong, then 2,000" payout was deliberately built to
avoid per-mistake scaling. They confirmed: (1) points should replace that
flat payout, not sit alongside it, and (2) since one customer only ever
gets a single order (no do-over to escalate irritation on), "irritation"
should model the *restaurant's* mood over the whole shift, not one
customer's — a mistake makes later customers touchier, not just the one
who got the wrong dish.

Implemented as a new `reputation` stat (`rules.js`'s `REPUTATION_MAX`),
same shape as the existing Sanity stat but tracking the restaurant
instead of the player: starts full every shift, drains
`REPUTATION_DRAIN_PER_MISTAKE` (25) on every mistake (a missed order or
wrong-dish serve — `serveDish`/`failOrderAt`/`tick`'s patience-timeout and
clock-zero paths, engine-state.js) and nothing else — no passive drain,
unlike Sanity. `rules.js`'s new `patienceMultiplierForReputation`
(1.0 at full reputation, linearly down to a 0.6 floor at zero, exactly
mirroring `walkSpeedMultiplierForSanity`'s shape) is applied once, at the
moment *any* order is taken (`handleTableArrival`, cooking-game.js) —
Karen and Mel aren't exempt — so a shift that's already gone sour gives
every later customer less patience, functioning as an escalating chance
of losing them before the player even reaches their table. A real
correctness fix that came out of wiring this up: the order's patience-bar
fraction used to be computed by re-deriving "full patience" from scratch
at render time, which would have silently drifted for an older order once
reputation changed again mid-shift — fixed by having `addOrder` store the
actual patience value used as a new `patienceMaxSeconds` field on the
order itself, fixed at creation, and having the renderer read that
instead of recomputing it.

`rules.js`'s `shiftPaycheck(mistakeCount)` replaces the old
`shiftPaycheck(shiftUpset)`: `SHIFT_PAYCHECK_FULL` (4,000, unchanged)
minus `SHIFT_PAYCHECK_PENALTY_PER_MISTAKE` (500) per mistake, floored at
`SHIFT_PAYCHECK_MIN` (500) so a shift always pays *something* — this
game's existing "never a hard game-over" design extends to the paycheck
too. `shiftState.mistakeCount` (a running count, alongside the unchanged
`shiftUpset` boolean, which still drives the paycheck screen's ok/upset
UI state and dataset attribute) feeds this directly. The paycheck
screen's outcome line now reads e.g. "3 mistakes — Duke saw the reviews"
instead of a binary "went well"/"a customer left upset". A new on-canvas
Reputation bar (`drawReputationBar`, cooking-game.js) sits directly below
the existing Sanity bar, same visual treatment.

Verified via Playwright: forcing 3 mistakes (the `forceUpset` test hook)
dropped Sanity from 100% to 55% (3×15, unchanged) and Reputation from
100% to 25% (3×25, matching the new drain rate) exactly as expected, and
the resulting paycheck showed exactly `2,500 Gard` (4,000 − 3×500) with
the outcome text "3 mistakes — Duke saw the reviews". `go build`/
`go vet`/`go test`, and `node --test` (224 tests, up from 206 — new
coverage for `shiftPaycheck`'s new signature,
`clampReputation`/`patienceMultiplierForReputation`, and every mistake
path's `mistakeCount`/`reputation` effect in `engine-state.test.js`) all
green.

**Also**: this doc was split — "so it's more organized," alongside the
rule change — into this file (Status and everything not rule-specific:
Summary, Scope, User Flow, Visual Direction, UI, Client-side Behavior,
Routes/Data Model, Security, Testing Plan, Open Questions, Definition of
Done) plus three new sibling docs covering what used to be one Business
Rules / Validation section: `cooking-game-food-server.md` (recipes,
cooking, serving, the paycheck/reputation mechanics above, sanity/gear/
closing), `cooking-game-customer.md` (patience/ramp, Karen/Mel/Olive &
Oliver, the reputation-to-patience effect from the customer's side), and
`cooking-game-kitchen.md` (the Dining/Kitchen room split, cookware,
ingredient sourcing). See "Rules Documents" below.

**v3.12 an order speech bubble, and a leveling proposal** — the user
asked for a visible popup showing a customer's order the moment the
player arrives to take it, plus a new "food server level" that gates how
many simultaneous orders the player can hold (starting at one, unlocked
in stages) — and explicitly asked for the leveling mechanism to be
*proposed* in its own doc for review before it's built, since it needs
to reconcile with the table-capacity gear that already exists.

The speech bubble shipped directly (well-defined, no open design
questions): `handleTableArrival` now sets a new `orderBubble` state
(`{tableId, dishName, remaining}`) the instant a pending order is taken,
alongside the existing patience-bar/order-queue updates.
`drawOrderBubble()` (cooking-game.js) draws a small rounded bubble — the
dish's own icon (`drawDishIcon`, reused as-is) plus its name, with a
tail pointing down at the table — for `ORDER_BUBBLE_SECONDS` (2.5s)
before fading via `updateOrderBubble`, called each frame from the main
loop alongside the other per-frame timers (`updateClosingTimer`,
`updateCookMiniGame`). Drawn in absolute canvas coordinates *after*
`drawPlayer()` in `render()`, deliberately — the player sprite standing
right at that table can never cover it. Verified via Playwright:
screenshotted a live order at real (non-fullscreen) game scale, bubble
clearly legible with its icon and dish name.

The leveling mechanism itself was *not* implemented — see
`cooking-game-food-server-leveling.md`, a full proposal (mechanic,
reconciliation with the existing Extra Table Service gear, data model,
testing plan, and explicit open questions) awaiting the user's review,
per their request. `go build`/`go vet`/`go test` and `node --test` all
green (unchanged — no game-logic code touched for the leveling doc).

**v3.13/v3.14 the leveling proposal shipped, then pivoted to round
tiers** — the user reviewed the v3.12 leveling proposal, resolved its
open questions, and asked to implement it: v3.13 shipped a "food server
level" driven by a new persisted lifetime-shifts-completed counter
(`totalShiftsCompleted`, never reset by "Start New Month"), gating both
simultaneous-order capacity and how many of the 30 tables were open,
built via two parallel background agents (`rules.js`'s pure-logic pieces
and `floor-plan.js`'s table-unlock geometry) plus the `cooking-game.js`
game-loop integration by hand.

Immediately after, the user asked for a further, larger change: "each
round will have a time limit... level 1-10 will be 5mins and will only
cater to a few tables... progressive that each round level 10, 20, 30
becomes harder and more tables are introduced... a max of 30 tables."
This meant each *shift* needed its own real-time budget, not just its own
table count — and the user confirmed (via two follow-up questions) that
this should fully replace v3.13's lifetime-based system, driving both
directly off the current shift number instead, and that the shift clock
should shrink as more tables came online.

**v3.14 landed as "round tiers"**: `SHIFTS_PER_MONTH` raised from 20 to
30, split into three 10-shift tiers (1–10/11–20/21–30), each with its own
shift-clock budget (300s/180s/120s) and dining-room size (6/18/30 tables,
reusing `floor-plan.js`'s untouched row-unlock geometry via tier → row
level 1/3/5). Everything v3.13 drove off `totalShiftsCompleted` — which
was removed entirely, never having reached a released save shape — now
reads `save.currentShift` live instead, so (unlike v3.13) the dining room
and pace reset to Tier 1 every "Start New Month" rather than persisting
across a save's lifetime. The `cooking_scores` leaderboard's DB CHECK
constraints and server-side validation bounds widened to match the
longer month (migration `004_widen_cooking_scores_round_tiers.sql`,
`internal/service/cooking_validation.go`). See
`cooking-game-food-server-leveling.md` for the full shipped design,
including why it superseded v3.13 rather than sitting alongside it.
Verified via Playwright against a live dev server at Tier 1/2/3 saves,
`npm run test:unit` and `go test ./...` (including the real-Postgres
end-to-end suite) both green.

**v3.15/v3.16 table rendering reworked, twice more, per direct
follow-up feedback** — locked tables stopped rendering at all (not
dimmed), the "Table N" caption was removed from open tables, the floor
plan started laying out only the currently-unlocked tables in a
centered, near-square box per tier instead of a fixed 6x5 grid, and
tables became circles whose size scales with the tier (64px at Tier 1
up to 100px at Tier 3) instead of one flat size. Full design rationale
and decision history lives in `cooking-game-food-server-leveling.md`
(it documents this table-rendering work even though the doc's own name
now undersells its scope — see that doc's own note on this).

**v3.17 a bigger order-bubble icon** — the user asked specifically for
"the customer food icons bigger when food server interacts with the
customer for taking orders," i.e. just the order speech bubble's dish
icon (`drawOrderBubble`), not every on-canvas dish icon. `iconSize` grew
22px → 32px, with the bubble/font/icon-text-gap scaled up to match
rather than the bigger icon just overflowing a bubble sized for the old
one. Every other dish-icon appearance (the carrying tray, held-item
badges) is unchanged.

**v3.18 per-customer sanity, and the order bubble grew again** — three
more follow-ups in the same message: the order bubble "disappear[ing]
too quickly" (`ORDER_BUBBLE_SECONDS` 2.5s → 5s), its icon "a bit bigger
more" (32px → 40px, bubble/font scaled to match), and a genuinely new
mechanic — re-visiting an already-ordered table, or serving the wrong
dish, now drains that customer's own `customerSanityRemaining` stat (new
per-order field, `engine-state.js`'s `annoyCustomer`) and re-shows their
order bubble ("repeating" it); 4 such annoyances and they walk out
exactly like a patience timeout (reusing `failOrderAt`'s consequences
outright rather than duplicating them). See
`cooking-game-customer.md`'s "Per-customer sanity" section for the full
design (it's a per-order counterpart to that doc's restaurant-wide
Reputation stat, not a replacement for it — a wrong serve now costs
both). Built via two parallel background agents against a shared,
precise contract (one owning `rules.js`/`engine-state.js`'s pure logic,
one owning `cooking-game.js`'s two new call sites, a new sanity bar, and
the bubble tweaks) — `npm run test:unit` went from 262 to 271 (9 new
tests). Verified end-to-end via Playwright: took an order, re-visited
the table 3 times (order survived each time, sanity bar visibly
shrinking, bubble re-appearing), a 4th annoyance triggered the walkout
(order gone, Reputation -25%, player Sanity drained, HUD status
"Customer upset") — no console errors.

**v3.19 the order bubble drops its text, icon grows again** — the user
asked to "remove the names from the customer order bubble, make the
food icon bigger so its easier to see." `drawOrderBubble` no longer
renders the dish name as text at all — just the icon, `iconSize` grown
40px → 56px, with the bubble itself resized to fit only the (bigger)
icon instead of the old text-width-dependent sizing. Every other
mechanic the bubble is tied to (when it shows, how long it lasts, the
v3.18 customer-sanity "repeat the order" re-trigger) is unchanged — this
is purely how it renders. Built via two parallel background agents
against a shared spec (one implementing the `cooking-game.js` change and
self-verifying it, one updating this changelog and
`cooking-game-customer.md`'s stale "re-shows the dish name" wording in
parallel) — `npm run test:unit` stayed at 271/271 (a pure canvas-
rendering change, no pure-logic surface touched).

**v3.20 fridge/cabinet menus were missing icons** — the user reported
"the fridge menu doesnt include any food icons." `renderPanel`
(cooking-game.js's DOM-based fridge/cabinet/cookware item picker) built
each list button as plain text, never reusing `drawIngredientIcon` —
the same procedural icon set already shown on the tray/order bubble.
Fixed by drawing each item's icon (where one exists —
`INGREDIENT_ICON_DRAWERS`, all 19 Fridge/Cabinet ingredients) onto a
small offscreen `<canvas>` and prepending it to the button; `drawDishIcon`/
`drawIngredientIcon` are plain module-level functions taking a 2D
context as a parameter, so they work identically on a tiny inline
`<canvas>` as they do on the main game canvas, no new icon assets
needed. Cookware Closet items (Pan, Baking Tray, Rice Cooker) have no
icon drawer yet and fall back to text-only, unchanged from before —
matching the user's own wording ("food icons"), not a request to also
design cookware icons. Verified live via Playwright: opened the Fridge
panel, confirmed all 10 ingredients show their correct icon next to the
name. `npm run test:unit` stayed at 271/271 (no pure-logic surface
touched).

**v3.21 the fridge/cabinet icons were too small, and a confusing combo
icon got fixed** — two follow-ups. First, the user reported the new
icons "too small, its too hard to see": the panel's icon canvas grew
24px → 44px (icon drawn at 40px, up from 22px). Second, and unrelated to
sizing — the user flagged confusion over "this triangle food icon" on a
live screenshot of Olive & Oliver's order bubble: `drawCoupleOrderIcon`
(Olive & Oliver's Order = Matcha + Cake, `COUPLE_DISH`) was a bespoke
composite of two identical hand-drawn matcha rectangles plus a pink/
green two-tone triangle that matched no other icon anywhere else in the
game — genuinely illegible at the order bubble's small size. Rewritten
to reuse the *actual* `drawMatchaIcon`/`drawCakeIcon` drawers (via
`drawIconAt`, the same composition helper `drawDishIcon`/
`drawIngredientIcon` already use) side by side on a small plate, instead
of a novel redrawn shape — the couple's order icon is now visibly "a
matcha glass + a cake," built from the exact same icons the player
already recognizes from the Fridge/Cabinet panels. Verified live via
Playwright (seeded a shift-11 save so Tier 2's capacity-3 room lets
Olive & Oliver spawn without first having to fully serve Mel, since
Tier 1's capacity of exactly 1 blocks a second simultaneous
order/pending-customer entirely): the order bubble now shows a clearly
distinct green glass and pink triangle, no console errors.
`npm run test:unit` stayed at 271/271.

**v3.22 Mel's Usual had the same bespoke-icon problem** — after seeing
v3.21's couple-icon fix, the user asked about a different screenshot's
"pink triangle food picture": Mel's own order bubble. Same root cause,
different dish — `drawMelsUsualIcon` (Mel's Usual = Lemonade, Star Cake,
Egg, `MEL_DISH`) was also a bespoke hand-drawn composite, and its "Star
Cake" triangle used a plain white star accent — precisely the choice
`drawStarCakeIcon`'s own doc comment already flags as rejected there
("indistinguishable from plain Cake's icon" at small size), reintroduced
here by not reusing that real drawer. Fixed the same way as
`drawCoupleOrderIcon`: rewritten to compose the actual
`drawLemonadeIcon`/`drawStarCakeIcon`/`drawEggIcon` drawers side by side
via `drawIconAt`, three items now instead of two. Verified live via
Playwright: Mel's order bubble now shows a clearly distinct gold
lemonade glass, pink Star Cake triangle (with its real gold star), and
egg. `npm run test:unit` stayed at 271/271. Every dish icon in
`DISH_ICON_DRAWERS` that combines more than one raw ingredient now
follows this same "compose the real icons" pattern — no bespoke
multi-item composites left.

**v3.23 the cake icon itself was redesigned, and every order-bubble icon
standardized to 24x24** — despite v3.22's fix (the real, gold-starred
`drawStarCakeIcon`, correctly reused), the user reported *still* not
understanding "the pink triangle with sta[r]" on a fresh screenshot. The
real problem wasn't code reuse — it was the shape itself: a bare
triangle simply doesn't read as "cake" to a player at a glance (more
commonly a party hat or a warning sign). `drawCakeIcon` was redesigned
from a solid triangle wedge to a two-tier stacked-rectangle cake
silhouette (base + a lighter frosting layer with a drip line) —
`drawStarCakeIcon` now just calls `drawCakeIcon` and adds a star topper,
so the two stay visually related while the topper is what tells them
apart.

Separately, the user asked to standardize every food icon shown in the
order bubble to 24x24 (down from 56px). Applying that literally to a
composite dish's *single combo icon* (Mel's Usual, Olive & Oliver's —
already squeezing 2-3 items into one slot) made it illegible — worse
than before. Fixed by changing what "one food icon" means for a
composite order: `drawOrderBubble` now checks whether the order's dish
is `MEL_DISH`/`COUPLE_DISH` and, if so, draws one full 24x24 icon *per
ingredient* (`MEL_DISH.ingredients`/`COUPLE_DISH.ingredients`, via
`drawIngredientIcon` — reusing the same per-ingredient icons already
shown in the Fridge/Cabinet panels) side by side, with the bubble
widening to fit them, rather than shrinking a combo icon into one fixed
slot. A single (non-composite) dish still shows one 24x24
`drawDishIcon`. The bespoke `drawMelsUsualIcon`/`drawCoupleOrderIcon`
composite drawers are unchanged and still used elsewhere (the carrying
tray) — only the order bubble's rendering path changed. Verified live
via Playwright: Mel's bubble now shows three clearly distinct, correctly
un-cramped icons (lemonade, cake-with-star, egg) at the new size.
`npm run test:unit` stayed at 271/271.

**v3.24 two new interactions: discard a tray item by clicking it, and
click-outside-to-close on popup menus** — the user asked for "clicking
on the food icon on the tray should remove the food out of the tray"
and "when the food server clicks on an open space any popup menu show
close automatically."

For the tray: `drawPlayerCarrying`/`drawPlayerCarryingIngredients`
already computed exactly where each tray icon lands on screen (the held
dish, or each raw ingredient in a stacked layout) — that math is now
factored out into `heldDishIconHit`/`trayIngredientIconHits`, pure
functions returning each icon's center/half-size for a given player
pose, called by *both* the drawing functions and a new check at the top
of `onCanvasClick` (before normal station-click handling, since tray
icons sit on/around the player's own sprite and should win over
whatever station happens to be nearby). Clicking a raw ingredient's icon
splices just that one out of `inventory`; clicking the held-dish icon
clears `heldDish` — either way a toast confirms what was removed
("Removed Cheese," "Set down Burger"). Sharing the exact same layout
function between drawing and hit-testing (rather than two independent
copies of the same math) means a click is always tested against exactly
what's rendered that frame, including the walking bob offset.

For popups: `#cooking-station-panel` and `#cooking-recipe-book` are both
a full-canvas backdrop `<div>` with a single centered card child.
`onCanvasClick`'s existing `if (activePanel || recipeBookOpen ...)
return;` guard already blocked normal canvas clicks while either was
open (unchanged) — what was missing was any way to close one *without*
finding its Close button. Fixed with one click listener per backdrop
root checking `e.target === root` (true only when the click landed on
the backdrop itself, not any child), closing the corresponding panel —
the standard "click outside the modal to dismiss it" pattern, layered on
top of the existing Close buttons rather than replacing them.

Verified live via Playwright: gathered two ingredients, clicked the
first tray icon, confirmed only it (not the second) was removed and the
remaining icon re-centered; opened the Recipe Book and the Fridge panel
in turn and confirmed each closed on a backdrop click. `npm run
test:unit` stayed at 271/271 (both changes are DOM/canvas interaction
only, no pure-logic surface touched).

**v3.25 Coffee Machine/Counter moved to the left side** — the user asked
for both to sit on the left side of the Dining room; they were centered
at the bottom (x=480/376). `floor-plan.js`'s `buildStations` now places
them at x=90/194 — the same y (560), just shifted left, landing in the
bottom-left corner that was otherwise empty (the Toilet already anchors
the top-left; the Security guard and "Entrance / Exit" floor text sit
well to the right, x=560-785, so nothing conflicts). No other station
depends on Coffee Machine/Counter's exact position (checked). Verified
live via Playwright. `npm run test:unit` stayed at 271/271 (position-only
change, no logic touched).

## Summary

A playable top-down, click-controlled restaurant sim at `/kitchen-shift`,
set at a diner named **Startime Diner**: across an 8:30 AM–11:30 PM shift,
the player clicks tables to take orders, clicks the fridge/cabinet/cookware
closet to gather ingredients and cookware, and clicks the stove/oven to
cook — the player automatically walks to whatever's clicked and interacts
with it. Every shift ends with a closing sequence (clean the dirty tables,
wash the dishes at the Cleaning Closet, shut the restaurant down at the
front counter, then walk to the boss's office) where Duke hands over that
shift's paycheck — 4,000 Gard minus 500 for every mistake that shift
(missed/wrong-served orders), floored at 500. The game runs for 30 shifts — "the month," in three progressively harder 10-shift round tiers (`cooking-game-food-server-leveling.md`) — after
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

* A canvas-based top-down restaurant floor plan, 960x600, rendered in a
  soft pastel "coquette" style (v3): **click-only controls** — click empty
  floor to walk there, click a station (a table, the fridge, the stove,
  anywhere) and the player walks over and automatically interacts with it
  on arrival. Split (v3.1) into two rooms sharing that same canvas, never
  both visible at once: **Dining** (30 tables in a 6x5 grid, front
  counter, boss's office, coffee machine, restroom, a kitchen-door) and
  **Kitchen** (fridge, cabinet, cookware closet, stove, oven, cleaning
  closet, a dining-door) — see the kitchen rules doc for the
  room-switching rule.
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
  patience running out first, is a mistake — it costs Gard directly off
  that shift's paycheck and sours the restaurant's reputation for every
  customer seated afterward (see the food-server and customer rules
  docs).
* v3.28: a *correctly* served customer visibly eats at their table (v3.29:
  a bobbing dish icon beside their head), then walks to the Counter,
  pauses to "pay," and leaves toward the entrance — a cosmetic animation
  layered on top of the unchanged serve/paycheck rules above, not a
  replacement for them; the eating pause and paying pause are each
  independently randomized per customer, so several served close together
  don't all move in lockstep. Each completed payment adds a small,
  immediate Gard bonus (`COUNTER_PAYMENT_GARD`, 50) to that month's
  running total, on top of the shift-end paycheck (see the food-server
  rules doc's Counter payment animation section).
* v3.30: all six Kitchen-room stations (Fridge, Cabinet, Cookware Closet,
  Cleaning Closet, Stove, Oven) got dedicated canvas-drawn sprites,
  closing the same "least detailed stations" gap the Counter/Coffee
  Machine were in before v3.26 (see the kitchen rules doc's Kitchen
  station sprites section). Same fix also closed a bug where arriving at
  the Stove or Oven after your customer's patience had already timed out
  mid-gather silently did nothing — now shows a toast explaining the
  order's gone (kitchen rules doc's `activeOrderTableId` section).
* v3.31: the remaining four `DOOR_KINDS` stations (Restroom, Duke's
  Office, and both room doors) got dedicated sprites too, closing the
  same gap for the rest of the Dining room; the Restroom also moved from
  the top-left corner to the bottom-right (see the Restroom station bullet
  above). Also fixed: the Counter employee's sprite had a "counter-top
  ledge" strip drawn squarely across their face (a geometry bug in the
  v3.27 fix, not by design) — redesigned as a solid counter-front panel
  sized from the employee's own torso-bottom, so the face is always fully
  clear and the legs always fully hidden (kitchen rules doc's Door-kind
  station sprites section).
* v3.32: the Entrance/Exit floor marker got a real door sprite in place of
  plain text (see the On-canvas signage bullet above) — the last
  remaining "just text, no graphic" spot in the Dining room.
* v3.33: the player, every departing customer, and every station/table now
  visually avoid overlapping each other — see the Client-side Behavior
  section's "Nobody visually overlaps a station, table, or another
  character" bullet below, and the kitchen rules doc's Collision avoidance
  section for `resolveObstacleCollisions` and why it's a rendering-only
  concern, never fed back into the underlying walk/arrival logic.
* v3.34: customer arrival timing is jittered (±40%, multiplicative around
  the existing shift-ramp average) instead of landing on an exact,
  metronomic beat every time — see the customer rules doc's Shift ramp
  section for `jitteredArrivalIntervalSeconds`.
* v3.35: Mel and Olive & Oliver — previously the unconditional 1st and 2nd
  customer of *every* shift — now land at a random point in the shift
  instead (still guaranteed to appear exactly once each; only the timing
  is random). Table selection and regular-dish selection were already
  uniform-random before this and are unchanged; Karen's fixed shift-12
  trigger is also unchanged (see the customer rules doc's Karen/Mel/Olive
  & Oliver section for both changes).
* v3.36: every newly spawned customer (the random pool, Mel, Olive &
  Oliver, and Karen) now walks in from the Entrance/Exit door before
  taking their seat, instead of appearing at their table instantly —
  `arrivingCustomers`, the mirror image of `payingCustomers`' existing
  walk-to-the-Counter-and-leave animation. See the customer rules doc's
  "Customers walk in from the entrance" section.
* A shift clock, displayed as an in-game restaurant time of day (8:30
  AM–11:30 PM): new customers/orders stop spawning at zero, any orders
  still queued are auto-failed, and the shift moves into its closing
  sequence.
* A four-step closing sequence, in order: clean every dirty table, wash the
  dishes at the cleaning closet, walk to the front counter and shut the
  restaurant down, then walk to the boss's office to collect that shift's
  paycheck. Each closing action auto-completes over a short duration once
  the player arrives (no separate "hold" input needed under click controls).
* A paycheck screen after every shift: how many mistakes were made, this
  shift's resulting Gard payout, and the running month-to-date Gard total.
  Offers "Open Shop" and "Start Next Shift."
* 30 shifts = one month, in three progressively harder 10-shift round
  tiers (`cooking-game-food-server-leveling.md`: shorter shift clock, more
  tables open, higher base order capacity each tier). Difficulty also
  ramps continuously within that (more simultaneous tables from gear,
  faster customer arrival, shorter patience, more recipe variety unlocked
  in bands) mirroring the Fishing Game's depth-based ramp.
* Shift 30's paycheck screen becomes the "Final Paycheck of the Month": a
  month summary, an optional "Submit to leaderboard" name field, and "Start
  New Month" (shop upgrades persist; the month total resets to 0, and round
  tier resets back to Tier 1).
* A gear-style upgrade shop (persisted in `localStorage`, same shape as
  Fishing Game's): walking speed, carrying capacity, cook-timing forgiveness,
  simultaneous table capacity (up to the full 30), customer patience, and
  dish/table cleanup speed — all aimed at avoiding a mistake, since
  Gard-per-shift is otherwise governed entirely by mistake count, not by
  how well any single dish was served (see the food-server rules doc).
* Three recurring/scripted customers layered on the normal random-arrival
  pool: **Mel** (guaranteed once every shift — v3.35: at a randomized
  point, not forced first — her own usual order, extra patience, a
  thank-you line), **Olive & Oliver** (an engaged couple, likewise
  guaranteed once a shift at a randomized point rather than
  unconditionally second, sharing one table and one order), and **Karen**
  (a one-time disruptive customer on shift 12 only, short patience, and a
  ripple effect that upsets one other table if she's mishandled). See the
  customer rules doc for the full rundown of each.
* A stationary security guard figure near the entrance — cosmetic only, not
  an interactive station.
* A Sanity stat (drawn on-canvas, top-left of the floor plan — not
  external HUD chrome, v3 — starts full every shift) that drains over the
  shift — passively, and more on every mistake — and slows the player down
  the lower it gets; a Coffee Machine station restores it to full on
  arrival. A paired Reputation stat, drawn directly below it, tracks the
  restaurant's mood instead and shortens every later customer's patience
  after a mistake. See the food-server and customer rules docs for the
  full shape of each.
* A Recipe Book reference panel (every known dish's station/cookware/
  ingredients), reachable anytime.
* A Fullscreen toggle on the game container (native Fullscreen API).
* A small public leaderboard (Postgres-backed): top monthly Gard totals
  across all visitors, submitted voluntarily at month-end with a
  self-chosen display name.
* Mid-month resumability: current shift number, month-to-date Gard, and
  shop levels persist in `localStorage` across a page reload — a player who
  closes the tab mid-month resumes at the start of their current shift
  rather than losing the whole month (unlike the Fishing Game's much
  shorter, fully-ephemeral single round — see the food-server rules doc).
* A one-time intro sequence (v3.1): the very first "Start Shift" click
  ever on a device plays the player walking in from the entrance, then
  reveals a scripted dialogue line before the shift actually starts —
  never shown again after that first time (gated on `localStorage`, see
  Client-side Behavior).

**Out of scope (v1):**

* Nav/`/projects`/landing-page integration. The Fishing Game itself shipped
  reachable only at its own URL first, then got a `/projects` card and a
  landing "Selected work" card in separate follow-up passes (see that
  feature's Status note and this repo's commit history) — this feature
  followed the same order: `/kitchen-shift` was playable via direct URL
  only at v1, then (as anticipated here) picked up its own `/projects`
  card and landing "Selected work" card in later fast-follow passes — see
  `docs/features/projects.md`/`docs/features/landing-page.md` and
  `CLAUDE.md`'s Project status. Still not linked from the header nav
  itself, same gradual rollout the Fishing Game's own nav link had.
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
2. User clicks "Start Shift". The very first time ever on this device
   (`localStorage`'s `hasSeenIntro` still `false`), a one-time intro plays
   first: the player character walks in from the entrance, then a dialogue
   box reveals "Woah so this is my new job! i hope this will turn out well
   this is a perfect match because i like this resturant" with a "Let's get
   to work!" button — clicking it starts the shift for real and marks the
   intro seen forever. Every other time, the shift starts immediately. The
   Dining room renders (the default room every shift starts in): a 6x5 grid
   of 30 tables, the front counter, the (locked) boss's office door, the
   coffee machine, a restroom, a kitchen-door leading to the Kitchen, a
   stationary security guard near the entrance, and the player character. A
   HUD overlays the canvas: shift number (n/20), the in-game clock (starts
   at 8:30 AM), this shift's status (no customer upset yet vs. upset), the
   order queue, and an "Enter Kitchen" button. Mel — always the first
   customer of the shift — and, right after her, Olive & Oliver, seat
   themselves before the normal random arrival rotation begins.
3. Customers begin seating themselves at tables at intervals (faster in
   later shifts). Clicking an occupied table walks the player over and
   automatically takes its order into the queue, showing the requested dish
   and a patience timer — no separate confirm step.
4. Player clicks the kitchen-door (or the "Enter Kitchen" button) to switch
   to the Kitchen room, where the fridge, cabinet, cookware closet, stove,
   and oven live (a dining-door/"Back to Dining" button switches back).
   Clicking the fridge or cabinet; once they've walked over, a picker panel
   opens listing that station's items. Clicking an item adds it to the
   carrying inventory (capacity limited, upgradeable) — for a dish that
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
8. Player clicks each dirty table (in Dining); once they've walked over,
   cleaning starts automatically and finishes after a short duration
   (faster with Quick Clean gear) — walking away before it finishes
   cancels it, no partial credit. Player switches to the Kitchen room to
   wash the accumulated dishes the same way at the cleaning closet — room
   switching stays available throughout closing, so this cross-room step
   is always reachable. Once every table is clean and the dishes are
   washed, the player switches back to Dining, where the front counter
   becomes clickable; clicking it walks the player over and shuts the
   restaurant down automatically. Only then does the boss's office door
   unlock; clicking it walks the player there and collects the shift's
   paycheck.
9. A paycheck screen shows how many mistakes happened this shift, the
   shift's resulting Gard payout (4,000 minus 500 per mistake, floored at
   500), and the running month-to-date total. Buttons: "Open Shop" and
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
* **"Coquette" style** (v3, superseding v2's pixel-art treatment — the user
  tried the blocky pixel-art look, then asked for something different
  entirely): a soft pastel palette (blush pinks/creams), rounded shapes
  everywhere (`ctx.roundRect`-based `drawRoundRect`/`drawStation`, no sharp
  pixel corners), round heads, and small bow/star accent shapes (`drawBow`,
  `drawStar`) instead of blocky "pixel people." No `image-rendering`
  override on the canvas at all — a soft style wants smooth scaling, not
  jagged nearest-neighbor upscaling, so the old `.pixel-canvas` CSS class
  is gone. Real illustrated anime-style art needs hand-drawn/generated
  sprite assets this canvas-primitive renderer doesn't have (Open
  Questions) — this is the closest honest approximation buildable from
  flat shapes, not a claim of matching the user's reference images
  pixel-for-pixel. Every on-canvas label uses a single dark
  `LABEL_TEXT_COLOR` on a small opaque background chip (`drawLabelChip`),
  since the light pastel floor made the old cream/white label text nearly
  unreadable — the real cause behind "where is the coffee machine???."
* **Mel's detailed look** (v3, a dedicated `drawMel` renderer distinct from
  the generic person sprite used for every other customer): a dandelion
  behind her ear, a yellow hair clip, hair tied in a white ribbon, a
  flower-patterned yellow shirt, and a plain white skirt — sweet/kind/
  caring personality, favorite colors creamy light yellow and white,
  favorite flowers dandelions/tulips/roses, favorite hobby drawing and
  cycling, per the user's full character spec.
* **Restroom station** (`toilet` kind) — cosmetic only, no gameplay effect,
  same "just presence" role as the Security Guard. v3.31: moved from the
  top-left corner (its original anchor position, referenced elsewhere in
  this doc's older history) to the bottom-right, mirroring the Coffee
  Machine/Counter cluster at the bottom-left, and got a dedicated sprite
  (tank + bowl + a sparkle accent) — see the kitchen rules doc's Door-kind
  station sprites section.
* **On-canvas signage**: "Startime Diner" and "Entrance / Exit" render
  directly on the floor (not HUD chrome), and star-themed pillows decorate
  every table's chairs — matching the user's explicit "star themed" and
  "where is the entrance and the exit???" requests. v3.32: the "Entrance /
  Exit" marker went from plain floor text to an actual door graphic
  (`drawEntranceDoor`, called from `drawFloor`) — an open doorway with
  warm light spilling in, a door leaf propped against the frame, two star
  "lanterns," and a small welcome mat, with the "Entrance / Exit" caption
  now sitting below it rather than standing alone. Deliberately still not
  a real station (drawn straight into `drawFloor`'s world coordinates, not
  through `drawStation`/the `stations` array) — same "purely decorative,
  no separate mechanic" reasoning as before, now just with a real sprite
  instead of only text.
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
* **Anime-style faces (v3.3)**: every pixel-person — player, customers,
  Karen, Olive & Oliver, the security guard, Mel — gets a procedurally
  drawn face (`drawAnimeFace`, canvas primitives only, no image assets):
  big vertical-oval eyes with a sparkle highlight, thin eyebrows, blush,
  and a small smile.
* **Dish + ingredient icons and a carrying pose (v3.7, badge
  repositioned off the tray in v3.8, ingredients added in v3.9, food
  moved back onto a bigger tray in v3.10)**: every finished dish, and
  every raw ingredient (Fridge/Cabinet items) while it's still being
  carried, has a flat, canvas-drawn icon
  (`drawDishIcon`/`DISH_ICON_DRAWERS` and
  `drawIngredientIcon`/`INGREDIENT_ICON_DRAWERS`) rather than a plain
  text name — the text-chip carrying display is gone entirely now.
  Holding something replaces the player's usual straight-armed stance
  with a carrying pose (`drawPlayerHolding`, shared by
  `drawPlayerCarrying`/`drawPlayerCarryingIngredients`) — arms bent in
  around a tray, bobbing gently while walking — and the icon(s) sit
  directly on that tray (`TRAY_RX`/`TRAY_RY`, sized generously enough to
  stay legible there at the game's real on-screen scale — see the v3.10
  changelog note for why v3.8's original tray was too small for that):
  one big icon for a finished dish, or one icon per raw ingredient,
  stacking onto the tray (up to 3 in a row, wrapping to a second row
  beyond that) as each is picked up.
* **Security guard**: a stationary pixel-person near the entrance/counter,
  dark uniform color with a small badge-colored marker and a "Security"
  label — purely decorative (customer rules doc), always present, every shift.
* The order queue and patience timers use a monospace/tabular-figure
  treatment for the same reason as the Fishing Game's HUD numbers; so does
  the HUD's in-game clock.
* Station click/hover affordance: the nearest station under the cursor
  gets a highlight outline (hover), and the station currently targeted by
  an in-flight walk gets a brighter one (click-target) — the click-driven
  equivalent of the Fishing Game's "hook touches sprite" moment, since
  there's no natural collision here.
* The HUD's shift-status indicator (food-server rules doc) reads clearly
  at a glance as "still going well" vs. "a customer got upset" — e.g. a
  simple two-state icon/color, not a number: `shiftUpset` stays binary for
  this purpose even though `mistakeCount` behind the scenes (which now
  drives the shift paycheck) isn't.

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
├── css/app.css                    # no canvas-specific rules — v3's coquette look needs no image-rendering override
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
| One-time intro (v3.1)           | Only on the very first "Start Shift" ever (`hasSeenIntro` still `false`): player walks in from the entrance across the floor plan, then a dialogue box reveals the scripted line and a "Let's get to work!" button; every later start skips straight to Playing. |
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
| Fullscreen                       | Starting a shift ("Start Shift"/"Start Next Shift"/"Start New Month") requests Fullscreen automatically, so the game launches at full size without the player having to find the button first; the button still toggles it manually (label flips to "Exit Fullscreen" while active) and its own click is required if the browser blocked the automatic request. The Fullscreen target is `#cooking-game-container` — the Orders bar plus the canvas — so Orders stays visible in fullscreen too (v3.4). Canvas keeps its 960x600 aspect ratio either way, letterboxed via `object-fit: contain` in fullscreen since the inner `#cooking-canvas-wrapper`'s normal aspect-ratio sizing is overridden under `:fullscreen` to flex-fill whatever space is left under the Orders bar. |
| Room switch (v3.1)               | "Enter Kitchen"/"Back to Dining" button (and each room's door station) switches the active room instantly; available in every shift phase, including throughout closing. |
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
  is open. Before any of the above, the same click listener also checks
  (v3.24) whether the click landed on one of the player's own tray icons
  (the held dish, or a raw ingredient in the carried stack) — if so, that
  item is discarded instead of the click being treated as a station/floor
  target at all.
* **Nobody visually overlaps a station, table, or another character**
  (v3.33): `floor-plan.js`'s `resolveObstacleCollisions` nudges a moving
  entity's circle out of any station/table box or other character's circle
  it would otherwise overlap. Every station except tables is a rectangular
  obstacle at its own box size; tables (circular obstacles) use a
  deliberately *smaller* radius than their visual size, since Tier 3's
  table grid already intentionally packs rows tighter than the tables are
  tall (kitchen leveling doc) — full-size table collision would wall some
  tables in, unreachable. This is purely a *rendering* concern: the
  player's and each departing customer's own walk/arrival logic (`player.
  x/y`, `payingCustomers` entries' `x/y`) stay the plain, uncollided
  straight-line position they always were, and collision is applied only
  at the point each is actually drawn (`currentPlayerDrawPose`,
  `drawPayingCustomers`) — see the kitchen rules doc's Collision avoidance
  section for why a first attempt that fed collision back into the real
  position deadlocked two customers converging on the Counter.
* **Popup menus close on an outside click** (v3.24): the station panel
  and Recipe Book are each a full-canvas backdrop with a centered card;
  clicking the backdrop itself (not the card) closes the panel, the same
  standard "click outside to dismiss" pattern most modal UIs use,
  alongside — not instead of — their own explicit Close button.
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
  interactive, so it never needed to be a real station. Only drawn while
  `currentRoom === ROOM_DINING` (v3.1) — he stands watch at the Dining
  entrance, not a Kitchen fixture.
* **Room switching (v3.1)**: a `currentRoom` variable (`ROOM_DINING` by
  default, reset on every `startShift()`) gates both rendering and
  hit-testing — `render()`, the canvas `click`/`mousemove` handlers all run
  `floor-plan.js`'s `stationsInRoom(stations, currentRoom)` first, so the
  inactive room's stations are never drawn or clickable. `handleArrival()`
  checks for the `kitchen-door`/`dining-door` station kinds *before* any
  shift-phase branching, so walking through either door works identically
  in every phase; `switchRoom(room, entryPoint)` updates `currentRoom`,
  snaps the player to that room's entry point, clears the current move
  target/hover, and syncs the HUD's room-toggle button (see UI).
* **Fullscreen**: `toggleFullscreen()` calls a local `requestFullscreen()`
  helper (a no-op if already fullscreen) or `exitFullscreen()` on
  `#cooking-game-container`, looked up by id — deliberately *not*
  `canvas.parentElement`, which (since v3.4) is the narrower
  `#cooking-canvas-wrapper` one level in; fullscreening that alone would
  leave the Orders bar (`#cooking-game-container`'s other child, above
  the wrapper) behind. `startShift()` also calls `requestFullscreen()`
  first, so the very first "Start Shift"/"Start Next Shift"/"Start New
  Month" click launches the game full-size instead of requiring a
  separate click on the Fullscreen button — both call sites fire from a
  click handler, satisfying the Fullscreen API's user-gesture requirement,
  and the request is swallowed silently (`.catch(() => {})`) if a browser
  refuses it, leaving the manual button as the fallback. `app.css`
  overrides `#cooking-game-container`'s `max-w-[900px]` and
  `#cooking-canvas-wrapper`'s `aspect-[960/600]` under the native
  `:fullscreen` selector — those author classes would otherwise keep
  winning the cascade and cap the box at its normal small size even while
  "fullscreen" — so the container fills the display and the wrapper
  flex-fills whatever space is left under the Orders bar, with
  `object-fit: contain` on the canvas letterboxing its fixed 960x600
  buffer to fit that space's aspect ratio. A `fullscreenchange` listener
  flips the button's label between "Fullscreen" and "Exit Fullscreen" to
  match the actual state.
* **Orders bar (v3.4)**: `#cooking-order-queue` (repopulated by
  `renderOrderQueue()`, unchanged since earlier versions) now lives in a
  slim bar that's `#cooking-game-container`'s first child, above
  `#cooking-canvas-wrapper` — not an absolute overlay on top of the
  canvas, since the floor plan's top row of stations already occupies
  that space and an opaque overlay there would block clicks from
  reaching them. This keeps Orders visible inside the Fullscreen API
  target in every mode, per the user's "orders on the same window"
  request.
* **Progress persistence**: a single `localStorage` key
  (`cooking-game:v2` — bumped from `v1` since this redesign changes enough
  client-only state shape that a stale v1 save isn't worth attempting to
  migrate) holding `{monthToDateGard, currentShift, gear: {...levels},
  bestMonthTotal, hasSeenIntro}`. `hasSeenIntro` (v3.1) is read as `false`
  on any save written before this field existed, so a pre-existing player
  sees the one-time intro once on their next "Start Shift" rather than the
  load failing or the intro being silently skipped for a save that
  genuinely never saw it.
* **One-time intro** (v3.1): `playIntro()` walks the player in from a fixed
  spot near the floor's entrance/exit marker to `PLAYER_START` using the
  same `updatePlayer` movement code real gameplay uses (with `moveTarget`'s
  `station` left `null`, so arrival never triggers `handleArrival`), then
  reveals a dialogue box once the walk finishes. `startShift()` is a thin
  gate in front of the real shift-start logic (`beginShift()`): first time
  ever, it calls `playIntro(beginShift)`; every other time, straight to
  `beginShift()`. "Start Next Shift," "Start New Month," and "Reset
  progress" all funnel through the same gate, so the intro only ever plays
  when `hasSeenIntro` is genuinely still `false`.
* **Reduced motion**: same accepted gap as the Fishing Game — gameplay
  canvas can't fully honor the preference, but every non-gameplay transition
  (shop, paycheck, station-panel screens) does; the one-time intro's walk-in
  is skipped entirely under `prefers-reduced-motion` (the player starts
  already at `PLAYER_START`), though the dialogue itself still shows either
  way.
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
-- migrations/003_create_cooking_scores.sql, widened by
-- migrations/004_widen_cooking_scores_round_tiers.sql (v3.14: the month
-- grew from 20 to 30 shifts — see cooking-game-food-server-leveling.md)
CREATE TABLE cooking_scores (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    player_name      TEXT NOT NULL,
    total_earnings   INT NOT NULL,
    shifts_completed INT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cooking_scores_player_name_length CHECK (char_length(player_name) BETWEEN 1 AND 20),
    CONSTRAINT cooking_scores_earnings_range CHECK (total_earnings BETWEEN 0 AND 150000),
    CONSTRAINT cooking_scores_shifts_range CHECK (shifts_completed BETWEEN 1 AND 30)
);

CREATE INDEX idx_cooking_scores_earnings ON cooking_scores (total_earnings DESC);
```

| Table            | Column             | Type          | Constraints                | Notes |
| ------------------ | -------------------- | --------------- | ----------------------------- | ----- |
| `cooking_scores`   | `id`                  | `BIGINT`        | PK, identity                   | |
| `cooking_scores`   | `player_name`         | `TEXT`          | not null, 1–20 chars           | Self-chosen display name, rendered on the public leaderboard. |
| `cooking_scores`   | `total_earnings`      | `INT`           | not null, `0..150000`          | Gard, not dollars. A legitimate month totals `shifts_completed` shifts each paying 500–4,000 (food-server rules doc's Shift paycheck formula) — max 120,000 over 30 clean shifts — but the DB check stays a coarse sanity bound rather than re-deriving that exact formula server-side (Security Considerations). |
| `cooking_scores`   | `shifts_completed`    | `INT`           | not null, `1..30`              | Always 30 for a full month; column exists in case a future revision allows earlier submission. |
| `cooking_scores`   | `created_at`          | `TIMESTAMPTZ`   | not null, default `now()`      | |

Month-to-date Gard, shop levels, current shift number, and best month total
are **not** stored in Postgres — `localStorage` only, same reasoning as the
Fishing Game (no visitor identity to key server-side state on).
`cooking_scores` is the only server-side table this feature adds, and holds
only voluntarily-submitted, already-finished month results.

---

## Rules Documents

The gameplay rules that used to live in this section were split out
(v3.11, "so it's more organized") into three sibling docs, one per rule
domain, plus a fourth added later for the round-tier design specifically:

* [`cooking-game-food-server.md`](./cooking-game-food-server.md) — the
  player's job: taking orders, serving them (and what a mistake costs —
  the shift paycheck formula), sanity, gear, closing up.
* [`cooking-game-customer.md`](./cooking-game-customer.md) — customers:
  patience/arrival ramp, the restaurant reputation mechanic, per-customer
  sanity/annoyance, and the three recurring named characters (Karen, Mel,
  Olive & Oliver).
* [`cooking-game-kitchen.md`](./cooking-game-kitchen.md) — the kitchen as
  a cooking system: recipes, cookware, the cook-timing mini-game, and the
  Dining/Kitchen room split.
* [`cooking-game-food-server-leveling.md`](./cooking-game-food-server-leveling.md) —
  the round-tier system (progressive shift-clock/table-count/order-capacity
  per 10-shift band) and the table-rendering design (centered box-grid
  layout, per-tier circle sizing) it drove.

Validation beyond basic type/shape checking (leaderboard submission
bounds, etc.) is covered in Security Considerations below.

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
  exact per-shift 500–4,000 paycheck formula server-side either —
  accepted limitation for a stakes-free arcade leaderboard.
* **Abuse / spam**: `POST /kitchen-shift/score` rate-limited (e.g. per-IP).
* **Test cleanup discipline**: any e2e test that submits a real score must
  delete its own row after asserting against it — the Fishing Game's e2e
  suite shipped without this once and left junk rows on the real
  leaderboard (`docs/features/fishing-game.md`'s Security Considerations);
  this feature's e2e test must not repeat that.
* **CSRF**: `POST /kitchen-shift/score` must be covered by the app's CSRF
  protection, same as `POST /logout` — not actually in place yet (no CSRF
  mechanism exists anywhere in this codebase; this route's exposure is
  identical to, not worse than, `POST /fishing-game/score`'s
  already-accepted gap, see that doc's own Security Considerations and
  this doc's Definition of Done).
* **Secrets**: none introduced.
* **No inline `<script>` tags** — `cooking-game.js` is external, per CSP.

---

## Testing Plan

* [x] Recipe/dish lookup returns the correct ingredient list for every dish;
      a shift number only unlocks dishes in bands up to and including its
      own band.
* [x] Cook-timing success check: a sample inside the success zone finishes
      the dish, a sample outside it (both before and after the zone) ruins
      it; Sharp Knife level widens the zone monotonically.
* [x] Shift paycheck rule (`shiftPaycheck(mistakeCount)`): 0 mistakes →
      4,000 Gard; each mistake deducts 500, floored at 500.
* [x] `COUNTER_PAYMENT_GARD` (v3.28's per-customer counter payment) is a
      small, positive amount, strictly less than `SHIFT_PAYCHECK_MIN` —
      confirms it's additive on top of the shift-end paycheck, never able
      to dominate it (`rules.test.js`). The eat/walk/pay/leave animation
      and state-machine transitions themselves (`payingCustomers` in
      `cooking-game.js`) are not unit-tested — that file has no automated
      test file; verified manually instead via a live Playwright run:
      spawn → eat (bobbing dish icon, randomized duration) → walk → pay
      (randomized duration, Gard credited exactly once) → leave → removed,
      and two customers spawned together finish each phase at visibly
      different times rather than in lockstep.
* [x] v3.30's `handleCookArrival` fix: forcing an order, then clearing it
      out from under a stale `activeOrderTableId` (`failOrderAt`, same as
      a real patience timeout) while ingredients/cookware are already
      gathered, then arriving at the Oven — confirmed via a live
      Playwright run that this now shows the "order's gone" toast instead
      of the previous silent no-op (no automated test file for
      `cooking-game.js` — see the entry above).
* [x] `resolveObstacleCollisions` (`floor-plan.js`): leaves an untouched
      position alone (no obstacles, or none nearby); pushes a circle-vs-
      circle overlap out to exactly the combined radius; pushes out of a
      rectangular obstacle along the closest edge; pushes an entity
      centered *inside* a rectangular obstacle out along the shallower
      axis; walks a list of multiple obstacles, resolving only against the
      one actually overlapped (`floor-plan.test.js`, 8 cases). The
      integration this enables — the player deflecting around a station
      it'd otherwise walk through, two customers converging on the Counter
      staying visibly apart and *still both completing* (no deadlock) —
      isn't unit-tested (no automated test file for `cooking-game.js`);
      verified manually via a live Playwright run driving both scenarios
      directly (kitchen rules doc's Collision avoidance section).
* [x] `jitteredArrivalIntervalSeconds` (`rules.js`): a roll of 0 returns
      exactly the minimum jitter factor applied, a roll just under 1
      returns just under the maximum, a mid-range roll lands strictly
      between; scales down alongside a smaller base interval (jitter is
      multiplicative, not a fixed offset); an out-of-range or non-finite
      roll is clamped/defaulted rather than throwing or escaping the
      jitter bounds; a non-positive base interval returns 0, never
      negative (`rules.test.js`, 6 cases). `maybeSpawnCustomer`'s use of
      it (re-rolling `nextCustomerArrivalSeconds` only when the previous
      wait actually elapses, not every frame) isn't unit-tested — no
      automated test file for `cooking-game.js`; verified manually via a
      live Playwright run sampling several consecutive rolls within one
      shift and confirming they visibly vary rather than repeating the
      same exact interval (customer rules doc's Shift ramp section).
* [x] v3.35's randomized Mel/Olive & Oliver spawn-slot timing: no
      automated test file for `cooking-game.js`; verified manually via a
      live Playwright run resetting the spawn-tracking state and
      re-triggering `maybeSpawnCustomer` 200 times in one session, then
      confirming the resulting kind (Mel, the couple, or a regular dish)
      wasn't always the same value — observed roughly a 1-in-4 share each
      for Mel and the couple at shift 1 (2 unlocked regular dishes, so 4
      equally-weighted candidates total), matching the intended "one
      candidate, same weight as a single regular dish" design rather than
      Mel/the couple dominating or never appearing.
* [x] v3.36's `arrivingCustomers` walk-in: no automated test file for
      `cooking-game.js`; verified manually via a live Playwright run —
      spawning an arriving customer and sampling their position each
      frame confirmed they visibly progress from the Entrance/Exit door
      toward their table (not an instant teleport), `pendingCustomers`
      stays empty for that table until they arrive, and it's populated
      with the right dish the instant they do; a separate run confirmed a
      real, un-forced natural spawn (real timer, real walk, no debug
      hooks) still reaches the order queue correctly end to end.
* [x] Order queue: adding an order respects the current table-capacity cap
      (physical tables vs. Extra Table Service level, whichever is lower);
      a patience timer reaching zero auto-fails that order, marks the table
      dirty, and latches `shiftUpset` — without needing player input.
* [x] A wrong-dish serve latches `shiftUpset`, wastes the dish, and does not
      clear the order from the queue (the customer is still waiting).
* [x] `failOrderAt` fails the active order at a specific table on demand
      (Karen's ripple effect), exactly like a patience timeout, and is a
      no-op if that table has no active order or the shift has left
      `playing`.
* [x] Shift-phase state machine (`engine-state.js`): `playing` only
      transitions to `closing-clean` when the shift clock hits zero (and
      skips straight to `closing-dishes` if every table already happens to
      be clean — the idle-shift soft-lock regression from the v1 pass);
      `closing-clean` only transitions to `closing-dishes` once every table
      is clean; `closing-dishes` only transitions to `closing-shutdown` once
      the dirty-dish stack is fully washed; `closing-shutdown` only
      transitions to `paycheck` after the shutdown action fires — each gate
      is independently unit-tested, not just the happy path through all
      four.
* [x] `floor-plan.js`: `stationAtPoint` correctly hit-tests each station's
      box (including an exact-edge boundary case) and returns `null` for a
      point over no station; `approachPoint` returns a point exactly
      `standoffDistance` from the station center along the line back to the
      player's current position, and returns the player's own position
      unchanged if they're already within that distance.
* [x] Shift-to-shift ramp (customer arrival rate, patience duration, sweep
      speed) moves in the documented direction as shift number increases,
      unit-tested at representative shift numbers.
* [x] `inGameTimeLabel`: a full clock reads 8:30 AM, a zeroed clock reads
      11:30 PM, the halfway point reads the halfway time of day, a noon
      crossover reads "12:00 PM" (not "0:00 PM"), and out-of-range/
      non-finite input clamps rather than producing a nonsense time.
* [x] Every `RECIPE_BANDS` dish's cookware matches its station (Pan for
      Stove, Baking Tray for Oven, `null` for the station-less dish), and
      every ingredient (including `MEL_DISH`'s and `COUPLE_DISH`'s) resolves
      to a real `FRIDGE_INGREDIENTS`/`CABINET_INGREDIENTS` entry.
* [x] `MEL_DISH` and `COUPLE_DISH` are never present in `availableDishes`'s
      output at any shift number — only the two scripted spawns ever order
      them.
* [x] `isKarenShift` is true only at `KAREN_SHIFT_NUMBER`.
* [x] Sanity starts at `SANITY_MAX` every shift; `tick` drains it passively
      even when nothing goes wrong, and drains an extra
      `SANITY_DRAIN_PER_UPSET` on top for each upset event (a patience
      timeout during `tick`, a wrong-dish `serveDish`, or `failOrderAt`) —
      never below 0 no matter how much drains at once.
* [x] `walkSpeedMultiplierForSanity` is 1.0 at full sanity, decreases
      monotonically as sanity drops, and never reaches 0 (tired, never
      stuck) even at exactly 0 sanity.
* [x] `restoreSanity` sets sanity back to `SANITY_MAX` and is a no-op once
      the shift has left `playing`.
* [ ] `e2e`/manual: the Coffee Machine restores the HUD sanity bar to 100%
      on arrival, and the player visibly moves slower at low sanity than
      at full sanity.
* [x] Reputation (v3.11): every mistake path (wrong-dish serve,
      `failOrderAt`, a `tick()` patience/clock timeout) drains
      `REPUTATION_DRAIN_PER_MISTAKE`, never below 0, and never drains
      passively the way sanity does; `patienceMultiplierForReputation` is
      1.0 at full reputation, decreases monotonically, and floors at 0.6 —
      covered by `engine-state.test.js`/`rules.test.js`. Manually verified:
      forcing 3 mistakes dropped the on-canvas Reputation bar from 100% to
      25% and the resulting paycheck to 2,500 Gard (4,000 − 3×500), with
      the outcome line reading "3 mistakes — Duke saw the reviews".
* [ ] Month total accumulates correctly across shifts (sum of each shift's
      mistake-adjusted payout) and resets to 0 on "Start New Month" while
      shop gear levels persist. (Not directly unit-tested — `cooking-game.js`
      itself has no automated test file; this needs an `e2e/` pass.)
* [ ] `localStorage` progress (Gard, shift number, gear) persists across a
      page reload; corrupted or missing data falls back to defaults without
      an error. (Same gap as above — `defaultSave`/`loadSave`/
      `isValidSaveShape` have no direct unit test file of their own.)
* [x] `POST /kitchen-shift/score` rejects out-of-range earnings/shift-count
      and oversized/blank `player_name` with a clear validation error.
* [x] `player_name` containing HTML/script-like content renders as literal
      text on the leaderboard (auto-escaping regression test).
* [ ] Leaderboard fragment renders correctly empty, populated, and on a
      simulated fetch error. (Empty/populated cases are covered; the
      simulated-fetch-error case needs a direct check before this can be
      marked done.)
* [x] Rate limiting on `POST /kitchen-shift/score` rejects rapid repeated
      submissions from the same source.
* [ ] `e2e/`: a fresh browser/`localStorage`, clicking "Start Shift" the
      first time ever, shows the one-time intro (player walks in from the
      entrance, the exact scripted dialogue line, "Let's get to work!"
      starts the shift for real) and persists `hasSeenIntro: true`;
      starting a second shift with the same `localStorage` does not replay
      it.
* [ ] `e2e/`: nav → Kitchen Shift → play through a full shift with zero
      upsets (real clicks, plus the `skipToClosing`/`collectPaycheck` test
      hooks to fast-forward the closing sequence's real-time waits) →
      paycheck screen shows 4,000 Gard → shop purchase reflected next
      shift.
* [ ] `e2e/`: play a shift that includes one missed or wrong-served order
      (the `forceUpset` test hook, or a real wrong-dish click) → paycheck
      screen shows 3,500 Gard (4,000 − 500) instead of 4,000.
* [ ] `e2e/`: play all 30 shifts (test hooks to fast-forward each closing
      sequence) → Final Paycheck screen → submit score → leaderboard shows
      the new entry → test cleans up its own row.
* [ ] `e2e/`: click a station and confirm the player walks to it and the
      correct action fires on arrival (station panel opens for fridge/
      cabinet/cookware closet, order taken/served at a table); clicking
      empty floor just walks there with no side effect.
* [ ] `e2e/`: over many fresh shifts, Mel and Olive & Oliver each appear
      exactly once per shift (v3.35: at a randomized point, no longer
      guaranteed to be the literal first/second customer — this now
      *should* be probabilistic, the opposite of what an earlier version
      of this checklist item asked for).
* [ ] `e2e/`: the Recipe Book opens (before and during a shift), lists every
      dish including Mel's and Olive & Oliver's, and its Close button is
      always reachable regardless of viewport/canvas height (regression
      coverage for the clipped-Close-button bug below).
* [ ] `e2e/` (v3.24): clicking a raw ingredient's tray icon removes just
      that item from `inventory`, leaving any others; clicking a held
      dish's tray icon clears `heldDish` — both without walking anywhere
      or triggering the station underneath.
* [ ] `e2e/` (v3.24): clicking the backdrop of an open station panel or
      the Recipe Book (not the card itself) closes it, same as its own
      Close button; clicking the card or its buttons does not.
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
* Real hand-authored/generated sprite art (ingredients/dishes/stations,
  and especially real illustrated "coquette" anime-style character art),
  deliberately deferred in favor of the v3 canvas-primitive treatment
  (Visual Direction) — left open the same way the Fishing Game's own
  flat-circle-to-real-sprite upgrade was, rather than blocking on art
  production. **Partially addressed (v3.3)**: characters now have an
  anime-style *face* (big eyes, blush, a small smile — see the Status
  note's "v3.3 bigger characters + anime-style faces" entry), but it's
  still drawn procedurally with canvas primitives, not real illustrated
  art — this project has no image-generation tooling to produce actual
  sprite assets from, so real hand-authored/generated art for characters
  (and everything else) remains exactly as open as before. **Further
  addressed (v3.7, v3.9)**: dishes, and now raw ingredients too, have a
  procedurally-drawn icon (see the Status note's "v3.7 dish icons + a
  carrying animation" and "v3.9 raw ingredients get icons too" entries),
  the former reviewed with the user via a design mockup before landing —
  same canvas-primitives caveat as the faces above, still not real
  illustrated/generated art. Cookware (Pan/Baking Tray/Rice Cooker) has
  no icon and no carrying indicator at all yet — it was never shown as
  text either (unlike ingredients before v3.9), so this wasn't a
  regression to fix, but is a gap should the user want full parity.
* **Resolved (v3.1)**: the Kitchen/Dining room split (see Status and the
  kitchen rules doc) closes out the "fridge/cabinet/stove/oven in random
  places in the dining [room]" request. **Resolved (v3.2)**: the one-time
  scripted intro sequence (the player walking in with an opening line of
  dialogue), requested alongside it — see the Status note's "v3.2 intro
  sequence" entry.
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
  (kitchen rules doc) — the user asked for it "e.g." alongside Pan, not as a
  strict requirement; whether a future dish should use it, or whether it's
  purely flavor/future-proofing, is left open.
* Karen's shift was picked as 12 out of the "12 or 18" the user offered,
  to keep this a single well-defined trigger; whether 18 should also get a
  (the same or a different) scripted event, or Karen should move/duplicate
  there instead, is left open.

---

## Definition of Done

* [ ] User flow works end-to-end, including edge cases above (missed order,
      wrong-dish serve, mid-month resume, full 30-shift month, final
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
