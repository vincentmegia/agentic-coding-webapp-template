# Kitchen Shift — Kitchen Rules

> Split out of `docs/features/cooking-game.md` (v3.11, "so it's more
> organized") along with `cooking-game-food-server.md` and
> `cooking-game-customer.md` — together these three replace what used to
> be one "Business Rules / Validation" section. This doc covers the
> kitchen as a cooking *system*: what dishes exist and what they need,
> the cookware/cook-timing mechanics, and the Dining/Kitchen room split.
> Everything else about the feature (Status, Summary, Scope, User Flow,
> Visual Direction, UI, Client-side Behavior, Routes/Data Model, Security,
> Testing Plan, Open Questions, Definition of Done) stays in the main doc.

## Recipes, gated by shift band

(illustrative — tune during build, same status the Fishing Game's
fish/hazard tables started at before their own playtesting pass). Dishes
carry no individual point value — see the food-server doc's Shift
paycheck rule for why:

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
Mel's and Olive & Oliver's dedicated orders (see the customer doc) — no
`RECIPE_BANDS` dish uses them, so they never show up in a normal random
customer's order.

## Cookware

Every Stove dish needs a Pan and every Oven dish needs a Baking Tray (a
Rice Cooker also lives in the Cookware Closet, present for flavor but not
required by any current dish). Unlike ingredients, cookware is a one-time
pickup per shift — acquired once from the Cookware Closet, it's available
for every dish that needs it for the rest of the shift, never consumed or
re-gathered, and a burned/ruined dish only loses its ingredients, not its
cookware.

## Cook-timing is a binary success zone

Not a graded quality tier: the sweeping gauge has one "success" window —
a second interaction while the sweep is inside it finishes the dish;
anywhere outside it burns/ruins the ingredients (0 value, must
re-gather). Sharp Knife gear (food-server doc's Gear upgrades) widens the
success window per level. Sweep speed scales up slightly with shift
number, the cooking-side equivalent of descent speed ramping with depth
in the Fishing Game.

## Kitchen station sprites (v3.30)

`cooking-game.js`'s `drawStation` used to render five of the six Kitchen-
room stations as a plain flat-colored box — fridge/cabinet/cookware-
closet/cleaning-closet got only the generic `DOOR_KINDS` door-knob dot
every door station shares (toilet, boss-office, the two room doors
included), and stove/oven got nothing at all beyond the box itself — the
same "least detailed stations" gap the Counter/Coffee Machine were in
before v3.26 (food-server doc's Counter payment animation section
references that same precedent). Six new canvas-drawn detail functions
fixed this, same conventions as every other sprite in this file (no image
assets/generation tooling in this project; local coordinate space already
centered/translated by `drawStation`):

* **Fridge** — a horizontal seam splitting a small freezer section from
  the larger body below, plus a vertical handle bar.
* **Cabinet** — a center seam and two shallow raised-panel insets, reading
  as a pair of wood cabinet doors.
* **Cookware Closet** — a shelf line holding a pot (body + two side
  handles + a lid knob) and a pan (circle + handle stick).
* **Cleaning Closet** — a mop (stick + a fan of strands) and a small
  bucket, kept off-center since `drawStation` still draws the dirty-dish
  count dead-center over this once `shiftState.dirtyDishCount > 0`.
* **Stove** — four burner rings in a 2x2 grid plus a control-knob row
  along the front edge.
* **Oven** — a three-knob control panel, a horizontal handle bar, then an
  inset door with a centered oval "glow" window, each given its own
  vertical band so they read as distinct parts rather than merging
  together at this box's small (70px) scale.

The four `DOOR_KINDS` stations' new detail drawers run *before* that
shared open-inset/knob logic, so the knob (and, while a panel is open, the
cream open-panel inset) still layers on top — same ordering
`drawCounterDetail` uses for the counter employee vs. the counter-front
panel (see below). Stove/oven aren't `DOOR_KINDS` (nothing to browse —
only the cook mini-game), so they get their own top-level branch in
`drawStation`, parallel to the Counter/Coffee Machine one.

## Door-kind station sprites, and a Counter face-occlusion fix (v3.31)

The same detail-drawer mechanism above (`DOOR_KIND_DETAIL_DRAWERS`, one
entry per `DOOR_KINDS` station) was extended to the remaining four
`DOOR_KINDS` stations that hadn't gotten one yet — Restroom (`toilet`),
Duke's Office (`boss-office`), and both room doors (`kitchen-door`/
`dining-door`, Dining-room fixtures rather than Kitchen-room ones, but
documented here alongside the rest since they share this exact mechanism):

* **Restroom** — a small WC silhouette (tank + bowl + seat-lid outline)
  plus a sparkle accent (`drawStar`, this game's existing "clean/sparkly"
  motif). Also moved from its original top-left corner anchor to the
  bottom-right of the Dining room (`floor-plan.js`'s `buildStations`,
  `x: 870, y: 540`), mirroring the Coffee Machine/Counter cluster at the
  bottom-left — the same `y: 540`/`labelBelowFits` reasoning the v3.27 fix
  used for that cluster.
* **Duke's Office** — a name plaque (two thin engraved-looking lines), a
  small star badge, and a briefcase below — a closed door with an
  identifying detail, same convention as every other `DOOR_KINDS` station,
  not an interior scene.
* **Both room doors** — share one drawer (`drawSwingDoorDetail`): a center
  seam plus a small round window in each leaf, the same physical doorway
  seen from either side.

Also fixed in the same pass: `drawCounterDetail` (v3.26/v3.27) drew a thin
9px "counter-top ledge" strip *after* the employee, meant to occlude only
their lower torso — but the strip's position was chosen by eye rather than
checked against `drawPixelPerson`'s actual geometry, and it landed
squarely across their face instead (`drawPersonHead`'s face circle is
centered at `y - 32*scale`, well inside the old ledge's y-range). The
user's exact words were "a dash line that prevents the face to be seen."
Redesigned from the geometry up: the employee's own torso-bottom
(`y - 4*scale`, the same `y`/`scale` values passed to `drawPixelPerson`,
not a separately eyeballed number) is now the *exact* top edge of a solid
counter-front panel, so the face is always fully clear above it and the
legs always fully hidden behind it — no band can ever cross the face
again, by construction rather than by eye.

## Stale `activeOrderTableId` after a patience timeout (v3.30 fix)

`handleCookArrival(stationKind)` (called on arriving at the Stove or
Oven) used to return silently — no toast, nothing on screen — when
`shiftState.orders` no longer contained an order for
`activeOrderTableId`. That closure variable is only ever reassigned when
the player interacts with a table directly (taking or re-visiting an
order); it has no way to learn that a `tick()`-driven patience timeout
(`failOrderAt`, food-server doc) removed that same order out from under
them while they were still off gathering ingredients/cookware elsewhere.
The result: walk all the way to the Stove or Oven holding a
now-pointless dish and click it, and *nothing visibly happens* — read by
a player as "the stove/oven doesn't work," not as "my customer already
left." Oven dishes (Fridge + Cabinet + Cookware Closet + Oven, this
game's longest gather chain) are the likeliest to still be mid-gather
when a timeout lands, which is why this surfaced as an oven-specific
complaint rather than the station-agnostic gap it actually is (the same
silent branch exists for the Stove). Fixed by showing
`"That order's gone — take a new one first"` in that branch, same
`showToast` every other `handleCookArrival` precondition already used.

## The Dining/Kitchen room split (v3.1)

Exactly one room is ever active; only its stations render, are clickable,
or count for hover tooltips (`floor-plan.js`'s `stationsInRoom`). Room
switching (via either door station or the HUD's room button) is
available in **every** shift phase, not just `playing` — a deliberate
rule, not an oversight, since the closing sequence needs stations from
both rooms in order (clean tables and shut down in Dining, wash dishes in
Kitchen — see the food-server doc's Closing sequence rule) and
restricting switching to `playing` would strand the player mid-closing
with no way to reach the next required station.
