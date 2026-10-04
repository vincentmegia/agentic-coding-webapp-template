# Kitchen Shift — Food Server Rules

> Split out of `docs/features/cooking-game.md` (v3.11, "so it's more
> organized") along with `cooking-game-customer.md` and
> `cooking-game-kitchen.md` — together these three replace what used to
> be one "Business Rules / Validation" section. This doc covers the
> player's job as the food server: taking orders, serving them (correctly
> or not) and what that costs, sanity, gear, closing up, and getting
> paid. Everything else about the feature (Status, Summary, Scope, User
> Flow, Visual Direction, UI, Client-side Behavior, Routes/Data Model,
> Security, Testing Plan, Open Questions, Definition of Done) stays in
> the main doc.

## Shift paycheck (v3.11 — final, not illustrative)

A shift's Gard payout starts at `SHIFT_PAYCHECK_FULL` (4,000) and loses
`SHIFT_PAYCHECK_PENALTY_PER_MISTAKE` (500) for every mistake that
shift — a missed order (patience expired) or a wrong-dish serve — floored
at `SHIFT_PAYCHECK_MIN` (500) so a shift always pays *something*,
matching this game's "never a hard game-over" design. `rules.js`'s
`shiftPaycheck(mistakeCount)` computes it directly from
`shiftState.mistakeCount`, a running count kept alongside the older
`shiftUpset` boolean (which still just latches `true`/`false` and drives
the paycheck screen's ok/upset UI state).

This replaces the original flat "4,000 unless anything went wrong, then
2,000" split, which was a single binary outcome per shift — one upset
customer cost exactly as much as five, a deliberately simpler economy
than the Fishing Game's points-and-multipliers scoring. The user asked
for wrong-dish serves to "deduct negative points" directly, which
reverses that on purpose: every mistake now visibly costs Gard. See the
customer doc's Restaurant reputation rule for the other half of this
change — mistakes don't just cost money, they make every later customer
that shift harder to keep happy too.

## Counter payment animation (v3.28, eating step added v3.29)

Every *correctly* served customer (matched dish, `serveDish` in
`engine-state.js`) triggers a short cosmetic sequence, independent of the
table itself — the table is already freed the instant they're served, same
as before this existed. `cooking-game.js`'s `spawnPayingCustomer` pushes an
entry onto `payingCustomers`; each frame, `updatePayingCustomers` walks it
through four phases at `PAYING_CUSTOMER_WALK_SPEED` (130px/s): `eating` (a
randomized pause at the table, see below), `walking` from the table to the
Counter station, `paying` (a randomized pause once they arrive), then
`leaving` toward the same entrance/exit spot the one-time walk-in intro
uses. The figure drawn matches whoever was actually seated there (Mel,
Karen, Olive & Oliver as a pair, or a generic customer) via an `appearance`
tag captured at spawn time, reusing the same `drawMel`/`drawPixelPerson`
calls `drawTableContents` already used to draw them at the table.

While `eating`, `drawEatingAnimation` bobs the served dish's own icon
(`drawDishIcon` — the same icon shown in the order bubble and on the
player's tray, per this project's no-image-assets convention) beside the
customer's head at roughly mouth height, once per simulated "bite"
(~0.6s/cycle) — a small, mostly-stationary bob reads better on a ~50px-tall
figure than a long plate-to-mouth travel would.

v3.29: both the `eating` duration (`CUSTOMER_EATING_SECONDS_MIN`/`_MAX`,
2.5–5.5s) and the `paying` duration
(`PAYING_CUSTOMER_TRANSACTION_SECONDS_MIN`/`_MAX`, 0.8–1.8s) are randomized
per customer via a shared `randomBetween(min, max)` helper — the eating
duration is picked once at spawn time, the paying duration lazily on
arrival at the Counter (picking it at spawn would go stale sitting through
a variable-length `eating` phase first). This is purely a timing/feel
choice — several customers served close together visibly eat, pay, and
leave at different moments instead of in lockstep — and has no effect on
`COUNTER_PAYMENT_GARD` or `shiftPaycheck()`, both still exact and
unrandomized.

The moment the `paying` phase completes, `rules.js`'s
`COUNTER_PAYMENT_GARD` (50) is added to `save.monthToDateGard` and
persisted immediately — **additive on top of, not a replacement for**, the
unchanged end-of-shift `shiftPaycheck()` lump sum above. This is
deliberately small relative to that 500–4,000 range: it gives a per-customer
sense of progress toward shop upgrades (`GEAR_DEFS`, costs starting around
200–400 Gard) without shifting where a shift's earnings actually come from,
and without touching the `cooking_scores` leaderboard's `total_earnings`
bound (still 150,000 — see the main doc's Data Model — which already
carried ~25% headroom above the pure lump-sum max before this existed).

## Wrong-dish serves and missed orders

Cost the wasted dish/ingredients and time, latch `shiftUpset` (Shift
paycheck rule above), increment `mistakeCount`, and drain both Sanity
(rule below) and Reputation (customer doc) — but never end the shift or
the month early. This game is lower-stakes than the Fishing Game by
design (a workplace shift, not a survival descent): the tension is
finishing the shift clean and keeping the bill low, not avoiding a
game-over state.

## In-game clock

The shift's real-time countdown — v3.14: `shiftClockSecondsForShift(shiftNumber)`,
which varies by round tier (300s/180s/120s across the month's three
10-shift bands; see `cooking-game-food-server-leveling.md`), not the flat
90s every shift used before that shipped — is displayed as a restaurant
time of day, 8:30 AM at shift start to 11:30 PM when the clock hits zero
(`rules.js`'s `inGameTimeLabel`, a linear map from remaining clock
seconds onto that range, given that same tier-specific total as an
explicit second argument) — a cosmetic display choice layered on the same
underlying countdown every other shift-timing function already uses, not
a second independent clock.

## Closing sequence order is enforced

Matching the explicit clean → wash dishes → shut down → get paid order
from the feature request, not a cosmetic sequence the player could skip
or reorder: the cleaning closet isn't clickable until every table is
clean, the front counter isn't clickable until the cleaning closet's
dirty-dish stack (one dish per serve — successful, wrong, or missed
doesn't matter, a dish or pan still got used — accumulated that shift) is
fully washed, and the boss's office door isn't clickable until shutdown
is complete.

## Gear upgrades

(illustrative costs/magnitudes, same "tune during build" status as the
kitchen doc's recipe table), 5 levels each unless noted, cost curve
`round(baseCost × costGrowth ^ currentLevel)`. Every upgrade here targets
avoiding a mistake or getting through closing faster — there's no "earn
more Gard per dish" upgrade, since a shift's payout is governed entirely
by mistake count (Shift paycheck rule above), not by how well any single
dish was served:

| Gear                 | Effect per level                                    |
| ---------------------- | ------------------------------------------------------ |
| Running Shoes            | +15% walking speed                                        |
| Bigger Tray              | +1 carried ingredient slot                                 |
| Sharp Knife               | Widens the cook-timing success zone                        |
| Extra Table Service        | +3 simultaneous active tables per level (8 levels, base 1/3/5 by round tier → capped at however many tables that tier has open, physical max 30) |
| Regular's Patience          | +patience-timer duration per customer                      |
| Quick Clean                | Reduces per-table cleaning and dish-washing time            |

**Shipped (v3.14, "round tiers")**: separate from this Gard-purchased
gear, the *base* simultaneous-order capacity Extra Table Service adds on
top of, and how many of the dining room's 30 tables are open at all, are
gated together by which of the month's three round tiers the current
shift falls in — a fresh month starts with just one table open and one
order at a time (Tier 1, shifts 1–10), building up to the full 30-table,
5-capacity baseline by Tier 3 (shifts 21–30), then resetting back to
Tier 1 on the next "Start New Month." See
`cooking-game-food-server-leveling.md` for the full design.

## Sanity and the Coffee Machine

A shift-long stat (`SANITY_MAX` = 100, starts full every shift, drawn as
an on-canvas bar in the floor plan's top-left corner, not external HUD
chrome — v3) that drains passively over the shift
(`SANITY_DRAIN_PER_SECOND`) and takes an extra one-time hit
(`SANITY_DRAIN_PER_UPSET` = 15) on every mistake — latched independently
each time it happens, not just once per shift the way `shiftUpset`
itself is (same per-mistake shape `mistakeCount` and Reputation follow —
customer doc). Low sanity slows the player down:
`walkSpeedMultiplierForSanity` scales walking speed linearly from 1.0x at
full sanity down to a 0.6x floor at zero — tired, never stuck, matching
this game's existing "no game-over state" design. A Coffee Machine
station (near the front counter) restores it. Before v4 that was
instant on arrival; v4 replaced it with the Coffee Pour minigame below.
Before v4, Sanity had no effect on pay. v4's hallucinations (below) add
a pay cut for time spent at 0.

## Coffee Pour (v4)

Ported from Library Shift (`rules.js` section 12). Arriving at the Coffee
Machine opens an on-canvas pour:
* Hold the mouse/touch, Space or Enter to pour. The cup fills to the brim
  in `COFFEE_POUR_SECONDS_TO_BRIM` (2.2 s).
* Release inside the gold band, which is drawn at a random height each
  time (`coffeePourTargetBand`).

Grades (`gradeCoffeePour`, applied by `engine-state.js`'s `brewCoffee`):

| Grade | When | Sanity | Extra |
|---|---|---|---|
| Perfect | released inside the band | to full | +10g tip (bonus Gard) |
| Good | within 0.1 of the band | +70 | |
| Sloppy | anywhere else | +40 | |
| Spilled | held until the brim | −50 | the player wears steaming coffee stains for 6 s |

The player can't walk while the overlay is open; it closes 1.2 s after
the result.

## Hallucinations (v4)

Ported from Library Shift v2.16 (`rules.js` section 13).
`hallucinationIntensity` is 0 at 25+ Sanity, rising to 1 at 0.

Below 25:
* The player's face turns worried: a frown, eye bags, a sweat drop.
* The diner starts playing tricks: shadow figures, whispers, a pulsing
  purple vignette, and flickers.
* Ghost customers sit at empty tables, shown translucent with a "???"
  chip. Walk up to one and nobody's there: −5 Sanity, not a mistake.
  Real customers never get seated at a ghost's table.
* Shaky hands, scaling with intensity:
  * The cook gauge's success zone shrinks to as little as half its width.
  * Its sweep speeds up to 1.6×.
  * The player can drop what they're carrying: the held dish, or one
    random ingredient.

Above 60% intensity the room shakes; the HUD doesn't. At full intensity
(0 Sanity) there are also jump scares, plus a pay cut of −2% per 10 s
spent at 0, capped at −30% (`hallucinationPayMultiplier`). All of it stops
the moment Sanity climbs back to 25.

## Gard counter (v4)

Ported from Library Shift v2.15. A HUD pill beside the Sanity/Reputation
bars shows:
* This shift's Gard so far: Counter payments + bonus Gard (Karen's tip,
  perfect pours) − complaint letters.
* The month-to-date total.

A floating "+N g" (or red "−N g") pops each time the shift's figure
changes. The base paycheck isn't shown until Duke's office, since
mistakes decide it.

## Shift payout (v4)

`engine-state.js`'s `shiftPayout`, Library Shift's formula:

```
gross  = max(0, shiftPaycheck(mistakes) + bonusGard − complaints × 25)
payout = round(gross × hallucinationPayMultiplier × reputationPayMultiplier)
```

The paycheck outcome line itemizes each part: bonus, complaint letters,
and the two pay cuts. Counter payments are still credited the moment
each customer pays, as before.

## Mid-month resume

Month-to-date Gard, current shift number, and shop levels persist across
a reload; an in-progress shift's floor-plan state (order queue,
inventory, acquired cookware, table/dish cleanliness, the `shiftUpset`
flag, `mistakeCount`, current sanity and reputation, and whether
Mel/Karen/Olive & Oliver have already appeared or been resolved this
shift) does not — returning mid-shift restarts that shift from its
beginning, same forfeiture principle as the Fishing Game's
abandoned-round rule, just scoped to one shift instead of the whole run
since a month is a much longer investment to fully discard.

## Leaderboard

Top N (e.g. 20) by `total_earnings`, descending; submission is optional
and only offered on the Final Paycheck screen (shift 20), never
automatic, never mid-month.
