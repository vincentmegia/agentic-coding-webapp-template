# Kitchen Shift — Customer Rules

> Split out of `docs/features/cooking-game.md` (v3.11, "so it's more
> organized") along with `cooking-game-food-server.md` and
> `cooking-game-kitchen.md` — together these three replace what used to
> be one "Business Rules / Validation" section. This doc covers customers:
> how patience/arrival ramp up over the month, the three recurring named
> characters, and the restaurant-wide reputation mechanic that makes every
> customer touchier after a mistake. Everything else about the feature
> (Status, Summary, Scope, User Flow, Visual Direction, UI, Client-side
> Behavior, Routes/Data Model, Security, Testing Plan, Open Questions,
> Definition of Done) stays in the main doc.

## Startime Diner is card-only, no cash

Flavor about how the diner's *customers* pay for their meals, unrelated
to the player's own Gard paycheck from the boss (which is just how much
they're paid for the shift, not tied to any individual bill — see the
food-server doc's Shift paycheck rule). No gameplay mechanic hangs off
this; it may show up as ambient copy/UI (e.g. a card-reader prop at each
table) but never as a distinct interaction.

## Shift ramp

Customer arrival rate increases and patience timers shorten as shift
number increases, and simultaneous active tables/orders is capped by
both the physical table count (30) and the Extra Table Service gear
level (food-server doc's Gear upgrades), whichever is lower.

## Restaurant reputation (v3.11)

The user asked for a wrong-dish serve to make customers "irritated" and
raise "the ch[a]nce of leaving... with bad review." A single customer
only ever gets one order — there's no do-over to escalate irritation on
within one visit — so this is modeled at the *restaurant* level instead:
a shift-long `reputation` stat (`rules.js`'s `REPUTATION_MAX` = 100,
starts full every shift) that drains `REPUTATION_DRAIN_PER_MISTAKE` (25)
on every mistake — a missed order or a wrong-dish serve, see the
food-server doc's Wrong-dish serves rule — and nothing else; unlike
Sanity, reputation never drains passively.

`rules.js`'s `patienceMultiplierForReputation` (1.0 at full reputation,
linearly down to a 0.6 floor at zero — the same shape as
`walkSpeedMultiplierForSanity`) is applied once, at the moment *any*
order is taken, Karen and Mel included. So a mistake doesn't just cost
the mistaken table — it makes every customer seated *afterward*, for the
rest of that shift, more impatient than they'd otherwise have been,
functioning as an escalating chance of losing them before the player
even reaches their table. A bad review from one table sours the mood for
whoever walks in next. Reputation resets to full at the start of the
next shift, same as every other shift-scoped stat.

Displayed as an on-canvas bar (`drawReputationBar`, cooking-game.js)
directly below the Sanity bar it's visually paired with, same treatment
— and reflected in the paycheck screen's outcome line (food-server doc's
Shift paycheck rule).

## Per-customer sanity (v3.18)

Reputation (above) is restaurant-wide; this is the per-*order* counterpart
the user asked for next: "after a food server takes the order from the
customer and click the customer, customer sanity will decrease and
customer will tell the order again, if a food server serves wrong food,
customer sanity points will decrease again and customer will repeat
order again." Every order now carries its own `customerSanityRemaining`
(`engine-state.js`'s `Order` shape; `rules.js`'s `CUSTOMER_SANITY_MAX` =
100, starting full) — a *separate* stat from the time-based patience
countdown, tracking how many times this specific customer has had to
repeat themselves.

Two things "annoy" a customer, each draining
`CUSTOMER_SANITY_DRAIN_PER_ANNOYANCE` (25 — the same 4-hits-to-bottom-out
shape as reputation's own drain) via `engine-state.js`'s
`annoyCustomer(state, tableId)`:

* The food server re-visiting an already-ordered table before serving it
  (walking up without holding a dish) — a deliberate re-check that costs
  the customer's patience for being asked to repeat themselves.
* Serving the wrong dish — *additional* to that mistake's existing
  consequences (mistakeCount, player Sanity, Reputation, all unchanged —
  see above), not a replacement for them. A customer's own sanity hitting
  0 on a wrong serve is a second, separate consequence layered on top of
  the immediate one.

Either way, if sanity survives the hit, the order bubble re-shows their
dish (as its icon — v3.19 dropped the bubble's text name entirely,
icon-only now, see the main doc's changelog) via `cooking-game.js`'s
`annoyCustomerAt` — the customer "repeats" their order — and a second
small on-canvas bar
(`#c9a0dc`, lavender, stacked just above the existing patience bar)
reflects the new `customerSanityRemaining` fraction. If it bottoms out,
`annoyCustomer` delegates straight to the existing `failOrderAt` — the
customer walks out exactly like a patience timeout does (order removed,
table freed dirty, `shiftUpset` latched, `mistakeCount`/player
Sanity/Reputation all drained), including the same Karen-ripple/Mel/
couple cleanup a time-based walkout already gets.

## Karen, Mel, and Olive & Oliver

Three named customers layered on top of the normal random-arrival pool
(`availableDishes`), none of whom ever come from that pool themselves:

* **Mel** (`MEL_DISH`, `"Mel's Usual"` — Lemonade, Star Cake, and Egg,
  station `none`) is always the very first customer seated, every single
  shift — not a random chance. Sweet, kind, and caring; favorite color
  yellow, favorite flower a dandelion (both cosmetic, Visual Direction).
  She gets `MEL_PATIENCE_BONUS_SECONDS` (15s) on top of the normal
  patience for that shift (itself already scaled by reputation above),
  and serving her correctly shows `MEL_THANK_YOU_LINE`. If she's
  mishandled (missed or served wrong), that's a normal `shiftUpset`
  latch/mistake like anyone else — no extra penalty; she's understanding,
  not vindictive.
* **Olive & Oliver** (`COUPLE_DISH`, `"Olive & Oliver's Order"` — Matcha
  and Cake, station `none`) always arrive together right after Mel, every
  shift — the second guaranteed spawn, before the random pool resumes.
  An engaged couple sharing one table and one order, not two separate
  orders. Olive: brave, smart, neat, favorite color green
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
  (`KAREN_PATIENCE_SECONDS` = 12s, itself already scaled by reputation
  above) than a normal customer at that shift. If her order isn't served
  correctly in time (missed or wrong dish), that's a normal `shiftUpset`
  latch/mistake *plus* a ripple effect: one other currently-active order
  (picked at random, if any exist) is force-failed too
  (`engine-state.js`'s `failOrderAt`, itself a second full mistake —
  reputation/Gard both take the hit twice) — she's rude enough to sour
  the mood for someone else, literally. Served correctly, no ripple,
  business as usual.

## Security guard

A stationary figure near the entrance/counter — "there's security to
protect the place." Cosmetic only: not a `floor-plan.js` station, no
click target, no interaction, no effect on Karen or anyone else. Present
every shift, unconditionally.
