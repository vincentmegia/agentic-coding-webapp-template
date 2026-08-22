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
station (near the front counter) restores sanity to full the moment the
player arrives, no picker panel needed — same "auto-action on arrival"
pattern as the fridge/cabinet, just instant. Purely a pacing/QoL
mechanic: sanity has no effect on the shift paycheck itself, which stays
governed entirely by mistake count (Shift paycheck rule above) — a
player who never drinks coffee still gets paid the same for a clean
shift, just walks slower by the end of it.

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
