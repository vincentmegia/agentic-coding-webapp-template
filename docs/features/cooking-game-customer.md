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

**Arrival timing is jittered, not metronomic (v3.34)** — the user asked to
"enhance randomization of the customers... make it random so it makes the
game mechanics better." `rules.js`'s `customerArrivalIntervalSeconds`
(the ramp above) was always a single exact value, consumed as an
unvarying wait every time — a given shift sat customers on a perfectly
regular beat, identical on every replay. `jitteredArrivalIntervalSeconds`
widens that into a multiplicative `[0.6, 1.4]` range around it
(`ARRIVAL_INTERVAL_JITTER_MIN`/`_MAX`), so consecutive arrivals land in
bursts and lulls instead — sometimes two customers close together,
sometimes a longer gap — without changing the *average* pace a shift
ramps toward (the pre-existing doc comment already called the base value
an "average"; this makes that literally true). `cooking-game.js`'s
`maybeSpawnCustomer` re-rolls a fresh jittered wait
(`nextCustomerArrivalSeconds`) every time the previous one elapses —
whether or not a customer actually ends up spawning that cycle (a full
table/no-room rejection already restarted the whole wait before this
existed; that's preserved, just with a freshly jittered length now) —
never mid-countdown, so the wait an in-progress countdown is aiming for
never changes out from under it. Table selection among open tables and
dish selection among unlocked dishes were already uniformly random before
this and are unchanged. At the time this shipped, Mel/Olive & Oliver's
guaranteed first-two-customers-of-the-shift slot was still deliberately
untouched — but the user reported that gap immediately ("first customer
is still the same"), and v3.35 (below, Karen/Mel/Olive & Oliver section)
randomized *when* they appear too, right after this. Karen's fixed
shift-12 trigger remains unchanged by either version.

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
  station `none`). Sweet, kind, and caring; favorite color yellow,
  favorite flower a dandelion (both cosmetic, Visual Direction). She gets
  `MEL_PATIENCE_BONUS_SECONDS` (15s) on top of the normal patience for
  that shift (itself already scaled by reputation above), and serving her
  correctly shows `MEL_THANK_YOU_LINE`. If she's mishandled (missed or
  served wrong), that's a normal `shiftUpset` latch/mistake like anyone
  else — no extra penalty; she's understanding, not vindictive.
* **Olive & Oliver** (`COUPLE_DISH`, `"Olive & Oliver's Order"` — Matcha
  and Cake, station `none`). An engaged couple sharing one table and one
  order, not two separate orders. Olive: brave, smart, neat, favorite
  color green (`OLIVE_FAVORITE_COLOR`), favorite flower tulips. Oliver:
  intelligent, brave, favorite color blue (`OLIVER_FAVORITE_COLOR`),
  favorite flower rose — his usual order is the same as his fiancée's,
  which is why they share `COUPLE_DISH` rather than each getting their
  own. No special patience/ripple mechanic; purely a recurring-cast/
  rendering distinction (Visual Direction: rendered as two people at one
  table).

  **v3.35: appearance timing is randomized, not fixed slots.** Before
  this, Mel was unconditionally the literal first customer seated every
  single shift, and the couple unconditionally the second, before the
  random pool ever got a turn — the user reported this directly ("first
  customer is still the same") after v3.34's arrival-*timing* jitter
  didn't touch *who* arrived first. `maybeSpawnCustomer` now builds one
  flat candidate list per spawn attempt — Mel (if not yet spawned this
  shift) and the couple (ditto) each get exactly one entry, the same
  weight as any single currently-unlocked regular dish — and draws one
  random pick from it. They're still guaranteed to appear exactly once
  per shift (still a candidate on every later attempt until picked,
  same as before), only *when* within the shift is now random rather
  than forced into the first two slots — mirroring how v3.34 randomized
  the *timing between* arrivals without changing the average pace. Their
  own dish stays fixed to their signature order (`MEL_DISH`/
  `COUPLE_DISH`) — "usual" stays usual; only which slot they land in,
  and (unchanged, already random before this) which table and which
  *regular* dish gets picked, are randomized.
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
  **v4 rematch**: Karen now comes on shifts 12 **and** 18
  (`KAREN_SHIFT_NUMBERS`). `karenEncounter(shift)` returns that visit's
  line, patience and tip:

  | Visit | Line | Patience | Tip on a correct serve |
  |---|---|---|---|
  | Shift 12 | "HEY YOU THERE COME OVER HERE" | 12 s | 100g |
  | Shift 18 (rematch) | "YOU AGAIN?! I remember you. Do NOT mess this up this time." | 9 s | 250g |

  The tip goes to the shift's bonus Gard, paid at Duke's office, so it
  shows on the Gard counter. Her ripple effect on a miss is unchanged.
  She's drawn with the shared `karen` design and an angry red tint while
  seated (and while walking in for the rematch).

## Customers walk in from the entrance (v3.36)

Before this, a newly spawned customer (`maybeSpawnCustomer`, and Karen's
`spawnKarenIfDue`) appeared seated at their table the instant they were
picked — no travel of their own, in contrast to a *paid* customer's
walk-to-the-Counter-then-leave animation (food-server doc's Counter
payment animation section). `cooking-game.js`'s `arrivingCustomers` is
the mirror image of that existing `payingCustomers` system: a newly
picked customer now walks in from the same entrance/exit spot paying
customers walk *out* to (`INTRO_ENTRANCE_POSITION`, the Dining room's
door sprite), and only "materializes" as a real, interactable
`pendingCustomers` entry — the table starts drawing them seated
(`drawTableContents`), and `mel`/`couple`/`karen`'s "currently active"
tracking, patience, and (for Karen) her line all start — on arrival
(`updateArrivingCustomers`). `melSpawnedThisShift`/`coupleSpawnedThisShift`
still latch the moment they're *picked*, not on arrival — otherwise a
second spawn attempt could draw Mel again while her first pick is still
mid-walk. Counts toward the shift's capacity cap and reserves its table
the same way a `pendingCustomers` entry does, so a customer already
walking in can't be double-booked or push the shift over its concurrent-
order limit before they've technically "arrived." Drawn with the same
`resolveObstacleCollisions` visual-avoidance treatment `payingCustomers`
gets (kitchen rules doc's Collision avoidance section) — an arriving
customer won't visually walk through the player, a station, or another
character either, sharing the exact same `drawCustomerFigure` appearance
logic (mel/couple/karen/regular) so they look identical whichever
direction they're walking.

## Security guard

A stationary figure near the entrance/counter — "there's security to
protect the place." Cosmetic only: not a `floor-plan.js` station, no
click target, no interaction, no effect on Karen or anyone else. Present
every shift, unconditionally.

## Penalties at 0 Reputation (v4)

Ported from Library Shift's 0-Mood penalties (`rules.js` section 14;
`engine-state.js`'s `tick`). Before v4, 0 Reputation only meant shorter
patience. Now, while it sits at 0:

* **Storm-outs**: every `ZERO_REPUTATION_STORM_OUT_SECONDS` (20 s), the
  customer with the least patience left walks out. That is a full mistake,
  exactly like a timeout (`stormOuts` counts them). With nobody waiting,
  the timer holds, so the next order taken storms out right away.
* **Complaint letters**: one every `COMPLAINT_INTERVAL_SECONDS` (30 s),
  each docking `COMPLAINT_GARD` (25g). The Gard counter drops live.
* **Pay cut**: −2% per full 10 s spent at 0, capped at −30%
  (`reputationPayMultiplier`).

A toast announces each storm-out and letter. The paycheck line itemizes
them too.

## Mel's look (v4.1)

Redesigned at the user's request:
* A yellow sundress with a white sash and a white-daisy print.
* Long honey-brown hair tied with her white ribbon, plus her yellow hair
  clip.
* A dandelion tucked behind her ear.
* White tights and shoes.

It's drawn by `cooking-game.js`'s `drawMel`, on top of the shared
`dress` outfit in `shared/people.js`.
