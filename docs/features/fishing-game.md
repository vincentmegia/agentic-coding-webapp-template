# Feature: Fishing Game

## Status

`Proposed`

## Summary

A playable arcade mini-game at `/fishing-game`, reachable from a new "Fishing
Game" entry in the Home dropdown: the player steers a diver descending
through the ocean, catching increasingly valuable fish the deeper they go
without taking a hit from a hazard. Rounds earn fishing tokens, spent between
rounds on gear upgrades that make deeper, higher-scoring runs survivable. A
small public leaderboard shows the best runs across all visitors.

## Problem / Motivation

CLAUDE.md names "Personal interests" as planned content — a section outside
the professional/resume material. The site currently has no content there,
and no interactive, just-for-fun feature at all; everything shipped so far
(Resume, the landing carousel) is informational. A small game gives the site
a personal, playful moment and, as a side effect, gives Postgres a second
real consumer beyond Resume (the leaderboard) distinct from that feature's
read-mostly structured-content use case.

## Scope

**In scope:**

* A canvas-based descent game: auto-scrolling downward through the ocean,
  player steers left/right to catch fish and dodge hazards.
* Depth-gated fish variety: which fish (and their point values) can spawn is
  driven by current depth.
* A no-hit streak multiplier layered on top of depth: the longer the player
  goes without taking a hit, the more the spawn pool and catch value both
  bias toward higher-value fish; a hit resets the multiplier (but not
  depth), so "deeper without getting hit" is the literal scoring mechanic,
  not just a byproduct of depth alone.
* A lives/hit system: a hazard collision costs one life; the round ends when
  lives reach zero, or in a success state if the player reaches the 1000-mile
  depth cap.
* Per-round scoring (fish points + a depth bonus) converted to fishing tokens
  at round end.
* A gear upgrade shop between rounds: tokens buy leveled-up equipment (more
  lives, faster steering, wider catch radius, better spawn odds for rare
  fish) that persists across rounds.
* Player progress (tokens, gear levels, personal best) persisted in the
  browser (`localStorage`) — no visitor accounts exist on this site (see Open
  Questions in `docs/features/home.md`'s Settings scope; Settings is
  site-owner-only), so there's no identity to hang server-side per-player
  state off of.
* A small public leaderboard (Postgres-backed): top scores across all
  visitors, submitted voluntarily after a round with a self-chosen display
  name, visible to everyone.
* Nav integration: "Fishing Game" added as a fourth item in the existing Home
  dropdown, alongside Resume/Projects/Blogs (`docs/features/home.md`).
* Hand-authored SVG illustrations for the diver, fish varieties, and hazards,
  matching the placeholder-illustration approach already used for the landing
  carousel (`docs/features/landing-carousel.md`).

**Out of scope:**

* Server-authoritative gameplay / real anti-cheat. The game simulation runs
  entirely client-side; the leaderboard trusts submitted scores subject only
  to coarse sanity bounds (see Security Considerations). This is a casual
  arcade toy with no stakes, not a competitive product — full server-side
  replay validation is not worth building for it.
* Visitor accounts, cross-device sync, or any server-side persistence of an
  individual player's tokens/gear/history. `localStorage` only; clearing
  browser data resets progress. Revisit if that turns out to bother players
  enough to matter.
* Multiplayer or real-time interaction between players.
* Sound design (music/SFX) — a mute-by-default, visual-only game is enough
  for v1; can be added later without changing this doc's scope.
* Mobile-native app packaging — this is a browser game like the rest of the site.

---

## User Flow

```text
1. User opens Home ▾ → Fishing Game (or navigates directly to /fishing-game).
   Page loads: a start screen shows current tokens, best depth/score (read
   from localStorage), the gear shop, and a "Start Dive" button, plus the
   public leaderboard fragment loaded alongside it.
2. User clicks "Start Dive". The canvas game begins: the diver auto-descends;
   arrow keys / WASD (or on-screen touch controls on mobile) steer left/right.
   A HUD overlays the canvas: current depth (miles), score, lives remaining,
   tokens balance, and the current streak multiplier.
3. Fish drift across the screen; touching one with the diver is the catch —
   no separate cast/hook input — and adds its point value (times the current
   streak multiplier) to the score. Which fish varieties can appear is gated
   by current depth and, on top of that, by the no-hit streak multiplier
   (see Business Rules): the longer the player has gone without a hit, the
   higher-value fish start appearing and are worth more.
4. Hazards also drift across the screen; colliding with one costs a life,
   resets the streak multiplier back to its base, and grants a brief
   invulnerability window before another hit can register. Losing all lives
   ends the round immediately ("You were caught!"). Descent speed gradually
   ramps up both with depth and with how long the round has run, so later
   parts of a long, deep dive are harder to navigate than the opening seconds.
5. Reaching 1000 miles depth ends the round in a success state ("You reached
   the abyss!") instead, awarding a completion bonus.
6. Round-over screen shows: fish caught, final score, depth reached, tokens
   earned this round (added to the running balance), and a "Submit to
   leaderboard" name field (optional) plus "Dive Again" and "Open Shop"
   buttons.
7. In the shop (reachable from the start screen or round-over screen), the
   player spends their token balance leveling up gear: each upgrade shows its
   current level, effect, and next-level token cost; buying deducts tokens
   and immediately applies for the next round.
8. User can return to Home ▾ or any other nav item at any time; an
   in-progress round is abandoned (no partial-round token award) if the user
   navigates away mid-dive.
```

---

## Visual Direction

Follows `tailwind-ui`'s Visual Style principles; specifics for this feature:

* The canvas game scene (ocean, diver, fish, hazards) uses its own fixed
  dark-ocean palette regardless of the site's light/dark mode toggle — a
  bright, light-mode ocean would undercut the setting, and every other site
  using this pattern (e.g. games with a night sky, a stage) commits to one
  scene palette rather than skinning the play area itself. The HUD, start
  screen, shop, and leaderboard chrome *around* the canvas still fully follow
  the site's dark mode like every other page (`tailwind-ui`'s Dark Mode).
* Fish and hazard sprites are hand-authored SVGs (not photos), in the same
  illustrative style as the landing carousel's placeholder art
  (`docs/features/landing-carousel.md`) — simple, flat, readable at small
  size, one silhouette-recognizable shape per creature so players can tell
  fish from hazards at a glance without reading anything.
* Higher-value fish read as visually "richer" (e.g. warmer/brighter accent
  color, slightly larger) so a player can eyeball that a catch was worth more
  without checking the score number.
* HUD numbers use a monospace or tabular-figure treatment so depth/score
  don't jitter in width as digits change every frame.

---

## UI

```text
web/templates/
├── pages/
│   └── fishing-game.html        # canvas + HUD + start/round-over/shop overlays
└── components/
    ├── fishing-shop.html        # gear upgrade list (level, effect, cost, buy button)
    └── fishing-leaderboard.html # top-N scores fragment (also the HTMX partial)

web/static/
├── images/fishing/
│   ├── diver.svg
│   ├── fish-*.svg                # one per variety, see Business Rules
│   └── hazard-*.svg              # one per hazard type
└── js/
    └── fishing-game.js           # canvas game loop, input, localStorage progress
```

States this feature's UI must handle:

| State                     | Behavior |
| -------------------------- | -------- |
| Start screen                | Shows tokens/best score from `localStorage`, shop entry point, leaderboard, "Start Dive". |
| Playing                     | Canvas game loop running; HUD updates every frame. |
| Hit / life lost              | Brief visual/knockback feedback with a flicker for the invulnerability window; HUD lives count decrements and streak multiplier resets. |
| Round over — caught          | "You were caught!" summary screen; lives reached zero. |
| Round over — reached bottom  | "You reached the abyss!" summary screen; depth cap hit. |
| Shop                         | Upgrade list with affordable vs. too-expensive items visually distinguished; buying is disabled (not just visually, but functionally) once the balance can't cover the next level. |
| Leaderboard loading          | A local loading indicator while the fragment fetches. |
| Leaderboard empty            | "No scores yet — be the first!" rather than a blank list. |
| Leaderboard error             | A generic "couldn't load the leaderboard" message; the rest of the page (game, shop) still works. |
| `localStorage` unavailable   | (private browsing / disabled storage) Game still fully playable for the session; tokens/gear reset to defaults each visit and a small notice explains progress won't be saved — never a hard error that blocks play. |
| Reduced motion                | See Client-side Behavior — the canvas gameplay itself can't honor `prefers-reduced-motion` (motion is the game), but all *surrounding* UI transitions (shop, screens) do. |

---

## HTMX Interactions

The game loop itself (canvas rendering, input, collisions, scoring, gear
effects, `localStorage` reads/writes) is not represented as HTTP requests —
see Client-side Behavior below for why, consistent with `htmx-ui`'s "avoid
unnecessary JavaScript" principle allowing a scoped exception where an
interaction genuinely can't be modeled as request/response (the same
reasoning `docs/features/home.md` uses for `header-scroll.js`). HTMX is used
for the two things that *are* naturally request/response: page navigation and
the leaderboard.

| Trigger                          | Method | Endpoint                  | Target                  | Swap        | `hx-push-url` | Indicator            |
| ---------------------------------- | ------ | --------------------------- | -------------------------- | ----------- | -------------- | ---------------------- |
| Home ▾ → Fishing Game               | GET    | `/fishing-game`             | `#main-content`            | `outerHTML` | `true`         | `#nav-loading`          |
| Page load (leaderboard fragment)     | GET    | `/fishing-game/leaderboard` | `#fishing-leaderboard`     | `innerHTML` | n/a            | `#leaderboard-loading`  |
| "Submit to leaderboard" (round over) | POST   | `/fishing-game/score`       | `#fishing-leaderboard`     | `outerHTML` | n/a            | `#leaderboard-loading`  |

`POST /fishing-game/score` returns the same leaderboard fragment
(`fishing-leaderboard.html`), re-rendered with the new entry included if it
placed — so a successful submission's own row becomes visible immediately
without a second round-trip.

Confirmation required for destructive actions:

* "Reset progress" (shop screen, clears local tokens/gear/best-score) uses a
  native `confirm()` prompt before clearing `localStorage` — it only affects
  this browser's local game state, never the shared leaderboard, so it's a
  lighter-weight confirmation than a server-side destructive action, but
  still irreversible from the player's point of view and shouldn't be a
  single accidental click.

---

## Client-side Behavior (non-HTMX)

`fishing-game.js` (one external file, no inline `<script>` tags, consistent
with `docs/features/home.md`'s CSP rule) owns everything HTMX cannot model:

* **Game loop**: `requestAnimationFrame`-driven canvas rendering — diver
  position, auto-scroll/depth increase (ramping with depth and elapsed
  time), fish/hazard spawning and movement, collision detection (including
  the post-hit invulnerability window and streak-multiplier tracking), HUD
  updates. Pauses automatically when the tab loses focus
  (`visibilitychange`) so a backgrounded tab doesn't burn a life pool the
  player never saw coming.
* **Input**: arrow keys / WASD on desktop; on-screen touch buttons (or
  drag-to-steer) on mobile/touch viewports, since a canvas game has no
  natural HTMX or keyboard-only equivalent for touch devices.
* **Progress persistence**: reads/writes a single `localStorage` key (e.g.
  `fishing-game:v1`) holding `{tokens, gear: {...levels}, bestScore,
  bestDepth}`. Versioned key name so a future save-format change can migrate
  or safely discard old saves rather than crash on unexpected shape.
* **Reduced motion**: the gameplay canvas itself can't honor
  `prefers-reduced-motion` — continuous motion is the mechanic — but every
  *non-gameplay* transition this feature owns (shop panel open/close,
  round-over screen appearing) does, per `htmx-ui`'s timing guidance. This is
  called out explicitly as the one place this site's UI doesn't fully honor
  that preference, rather than silently ignoring it.
* **Cleanup**: the loop is torn down (canceled `requestAnimationFrame`,
  listeners removed) when the user navigates away via an HTMX nav click, not
  just on a full page unload — otherwise a backgrounded game loop from a
  previous visit to `/fishing-game` would keep running after an HTMX swap
  replaces `#main-content`.

---

## Routes / Handlers

| Method | Path                        | Handler                          | Auth required | Notes |
| ------ | ---------------------------- | ----------------------------------- | ------------- | ----- |
| GET    | `/fishing-game`               | `FishingGameHandler.Index`          | no            | Page shell; leaderboard fragment loads via its own request, not inline, so a slow leaderboard query never blocks first paint of the game itself. |
| GET    | `/fishing-game/leaderboard`   | `FishingGameHandler.Leaderboard`    | no            | Returns top-N scores fragment. |
| POST   | `/fishing-game/score`         | `FishingGameHandler.SubmitScore`    | no            | Validates and inserts a leaderboard entry; returns the refreshed fragment. Rate-limited (see Security Considerations). |

---

## Data Model

```sql
-- migrations/002_create_fishing_scores.sql
CREATE TABLE fishing_scores (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    player_name         TEXT NOT NULL,
    score               INT NOT NULL,
    depth_reached_miles INT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fishing_scores_player_name_length CHECK (char_length(player_name) BETWEEN 1 AND 20),
    CONSTRAINT fishing_scores_score_range CHECK (score BETWEEN 0 AND 999999),
    CONSTRAINT fishing_scores_depth_range CHECK (depth_reached_miles BETWEEN 0 AND 1000)
);

CREATE INDEX idx_fishing_scores_score ON fishing_scores (score DESC);
```

| Table            | Column                | Type          | Constraints                          | Notes |
| ------------------ | ------------------------ | --------------- | ---------------------------------------- | ----- |
| `fishing_scores`   | `id`                     | `BIGINT`        | PK, identity                              | |
| `fishing_scores`   | `player_name`            | `TEXT`          | not null, 1–20 chars                      | Self-chosen display name, not an account — rendered on the public leaderboard. |
| `fishing_scores`   | `score`                  | `INT`           | not null, `0..999999`                     | Coarse upper bound only; not real anti-cheat (see Security Considerations). |
| `fishing_scores`   | `depth_reached_miles`    | `INT`           | not null, `0..1000`                       | Enforces the game's own depth cap at the DB layer too. |
| `fishing_scores`   | `created_at`             | `TIMESTAMPTZ`   | not null, default `now()`                 | |

Player tokens, gear levels, and personal best are **not** stored in Postgres
— they live in the browser's `localStorage` (Client-side Behavior above),
since this site has no visitor identity to key server-side per-player state
on. `fishing_scores` is the only server-side table this feature adds, and it
holds only voluntarily-submitted, already-finished round results.

---

## Business Rules / Validation

* **Fish varieties, gated by depth** (illustrative point values — tune during
  build):

  | Depth range (mi)  | Fish            | Points |
  | -------------------- | ----------------- | -------- |
  | 0–100                 | Sardine            | 10       |
  | 0–100                 | Anchovy            | 15       |
  | 100–300                | Mackerel           | 30       |
  | 100–300                | Clownfish          | 40       |
  | 300–600                | Tuna               | 75       |
  | 300–600                | Swordfish          | 100      |
  | 600–900                | Anglerfish         | 200      |
  | 600–900                | Giant Squid        | 300      |
  | 900–1000               | Golden Koi (rare)  | 750      |

  A fish's variety pool is drawn only from the player's *current* depth's
  row(s) — reaching a deeper band doesn't retroactively make shallow fish
  stop spawning entirely, but the spawn-weight shifts increasingly toward the
  higher band the deeper the player is.
* **No-hit streak multiplier** (the actual "deeper without getting hit"
  mechanic — depth-gating above is necessary but not sufficient on its own):
  a streak counter tracks depth descended (miles) since the last hit — the
  same unit as the depth bonus and fish-gating, not raw on-screen path
  length, so weaving side-to-side doesn't build streak faster than
  descending in a straight line — and drives a multiplier, e.g. starting at
  1.0x and gaining +0.05x per 10 miles hit-free, capped around 2.5x. While the streak is elevated it (a) biases
  spawn weighting further toward the top of the currently-reachable pool —
  including letting the *next* depth band's lowest-tier fish start appearing
  a little early — and (b) directly multiplies the point value of each fish
  caught. Taking a hit resets the multiplier to 1.0x immediately (but never
  reduces depth itself — depth only ever goes up), so a hit is a real,
  visible cost without erasing overall run progress. This is what makes
  "descend far without getting hit" the actual scoring lever, not just a
  side effect of depth.
* **Hazards** increase in frequency and speed with depth — descending isn't
  free; it's the risk half of the risk/reward loop (illustrative, tune
  during build):

  | Depth range (mi)  | Hazard         | Behavior |
  | -------------------- | ---------------- | ---------- |
  | 0–200                 | Jellyfish         | Slow drift, small hitbox |
  | 200–500                | Rock / mine        | Stationary or slow, larger hitbox |
  | 500–800                | Eel                | Fast, erratic movement |
  | 800–1000               | Shark              | Fast, actively steers toward the diver's current position |

  Movement is free 2D positioning (continuous left/right *and* the diver's
  vertical position within its on-screen band), not a discrete-lane system —
  stated explicitly here since gear like Magnetic Lure's catch radius and
  Ballast Thrusters' steering speed only make sense against continuous
  positions, not lane slots.

* **Lives and hit recovery**: default 3 lives (Hull Plating gear level 0);
  each hazard collision costs exactly one life regardless of hazard type and
  resets the streak multiplier. A ~1.2s invulnerability window (with a
  visual flicker) follows every hit — including a hit absorbed by Emergency
  Ballast (see Gear upgrades below), which grants the same window even
  though no life was lost, so a hazard cluster can't cost a real life
  immediately after the shield burns simply because the i-frames never
  started. Zero lives ends the round immediately in the "caught" state.
* **Fish/hazard overlap**: a fish catch and a hazard hit are evaluated
  independently each frame — if a fish and a hazard sprite happen to overlap
  the diver in the same frame, both resolve (the fish is caught *and* the
  hit registers). No special-cased priority between them; this keeps
  collision handling simple and avoids an exploit where hovering into a
  hazard's exact position would otherwise block an otherwise-legitimate
  catch.
* **Depth cap**: 1000 miles is the hard maximum (per the feature request);
  reaching it ends the round in the "reached the abyss" success state with a
  completion bonus, rather than the player being able to continue
  indefinitely. This is an intentionally arcade/whimsical unit, not a claim
  about real ocean depths.
* **Descent speed ramps up gradually on two axes**: with current depth (e.g.
  a small speed increase every 100 miles) and with elapsed time in the round
  (a slow continuous ramp independent of depth) — so a run that's both deep
  and long-running is meaningfully harder to navigate than the opening
  seconds, reinforcing the "how far do you push it" tension rather than
  presenting a flat, unchanging difficulty for the whole dive. Both ramps
  approach a documented maximum speed asymptotically rather than increasing
  without bound, so an extremely long/deep run gets harder without ever
  becoming literally unplayable or glitching past what collision detection
  can handle at a given frame rate.
* **Catching a fish** is passive: the diver's hitbox touching a fish sprite
  is the catch, with no separate cast/hook input. Consistent with hazard
  collision using the same touch-based model, so the player only has one
  input concept (steer to touch what you want, avoid what you don't) rather
  than two different interaction styles for fish vs. hazards.
* **Scoring**: round score = sum of (caught-fish point value × streak
  multiplier at the moment of catch) + a depth bonus (e.g. +1 point per
  whole mile descended), so purely surviving deep without many catches still
  rewards something.
* **Tokens**: awarded at round end only (no partial credit for an abandoned
  round — see User Flow step 8), converted from the round's final score plus
  a milestone bonus for each 100-mile depth band reached that round.
* **Gear upgrades** (illustrative — tune costs/effects during build):

  | Gear             | Effect per level                          |
  | ------------------ | -------------------------------------------- |
  | Hull Plating        | +1 max life                                    |
  | Ballast Thrusters    | Faster lateral steering (easier hazard dodges) |
  | Magnetic Lure        | Wider catch radius around the diver            |
  | Sonar Range           | Fish/hazards become visible farther ahead      |
  | Golden Bait            | Shifts spawn weight further toward higher-value fish for the current depth |
  | Emergency Ballast       | Once per round, automatically absorbs a hit — no life lost, streak not reset — then must recharge (available again next round) |

  Emergency Ballast is deliberately not just another flat number: it's a
  once-per-round safety net rather than a permanent stat increase, giving
  the shop a second kind of decision (raw survivability/speed/reward vs. a
  one-shot mistake-forgiveness tool) instead of five parallel sliders.

  Each gear item has its own level track and token cost curve; levels only
  ever go up (no sell-back/refund) and apply starting the *next* round, not
  retroactively to a round in progress.
* **Leaderboard**: top N (e.g. 20) by score, descending; submission is
  optional and only offered on the round-over screen, never automatic.

---

## Security Considerations

* **Authz**: none required — this is a public, anonymous feature like the
  rest of the unauthenticated site.
* **Input handling**: `player_name` is user-supplied text rendered back to
  every visitor on the public leaderboard — it must go through
  `html/template`'s normal auto-escaping like any other dynamic,
  visitor-sourced content (unlike `NavItem.Icon` in `internal/handler/nav.go`,
  which is trusted because it's hardcoded, never user input). Trim
  whitespace and enforce the 1–20 char bound server-side (not just in the
  DB constraint, so a bad request gets a clear 4xx rather than a raw
  constraint-violation error).
* **Untrusted score submissions**: the game simulation is entirely
  client-side (Scope), so `POST /fishing-game/score` is trusting the
  client's reported `score`/`depth_reached_miles`. Mitigate with sanity
  bounds only — the same `0..999999` / `0..1000` ranges as the DB
  constraints, checked in the handler before insert — not full replay
  validation. This is an accepted limitation for a casual, stakes-free arcade
  leaderboard; explicitly not attempting to be cheat-proof.
* **Abuse / spam**: `POST /fishing-game/score` should be rate-limited (e.g.
  per-IP) to prevent a script from flooding the leaderboard with junk
  entries — the concern here is nuisance/pollution, not high-value fraud.
* **CSRF**: `POST /fishing-game/score` must be covered by the app's CSRF
  protection, same as `POST /logout`.
* **Secrets**: none introduced by this feature.
* **No inline `<script>` tags** — `fishing-game.js` is external, consistent
  with this site's strict CSP (`docs/features/home.md`'s Security
  Considerations).

---

## Testing Plan

* [ ] Fish spawn pool shifts toward higher-value varieties as depth
      increases (unit test on the spawn-weighting function, not the canvas
      rendering itself).
* [ ] Streak multiplier increases with hit-free distance, caps at its
      documented max, and resets to 1.0x immediately on a hit — verified as
      a unit test on the multiplier function, independent of canvas timing.
* [ ] A hazard collision decrements lives by exactly one, resets the streak
      multiplier, and starts the invulnerability window; a second hazard
      collision during that window is a no-op (no further life loss). Zero
      lives ends the round in the "caught" state.
* [ ] Reaching 1000 miles ends the round in the "reached the abyss" state,
      not the "caught" state, even at full lives.
* [ ] Descent speed increases with both depth and elapsed round time
      (unit test on the speed function at representative depth/time inputs).
* [ ] Emergency Ballast (once purchased) absorbs exactly one hit per round
      without costing a life or resetting the streak, then is unavailable
      again until the next round; it also starts the same invulnerability
      window as a real hit, so a hazard immediately following the absorbed
      one doesn't cost a life either.
* [ ] Descent speed approaches its documented maximum as depth/time increase
      but never exceeds it, at extreme (near-max-depth, long-duration) inputs.
* [ ] Round-end token calculation matches the documented formula for a few
      representative (score, depth) pairs.
* [ ] Gear level effects apply starting the next round, not mid-round.
* [ ] `localStorage` progress persists across a page reload; corrupted or
      missing `localStorage` data falls back to defaults without an error.
* [ ] `POST /fishing-game/score` rejects out-of-range score/depth and
      oversized/blank `player_name` with a clear validation error, not a raw
      DB constraint error.
* [ ] `player_name` containing HTML/script-like content renders as literal
      text on the leaderboard, never executes (auto-escaping regression test).
* [ ] Leaderboard fragment renders correctly empty, populated, and on a
      simulated fetch error.
* [ ] Rate limiting on `POST /fishing-game/score` rejects rapid repeated
      submissions from the same source.
* [ ] `e2e/`: nav → Fishing Game → play a round (deterministic/seeded test
      mode if needed to avoid flaky canvas timing) → round-over screen →
      submit score → leaderboard shows the new entry.
* [ ] `e2e/`: shop purchase deducts tokens and the effect is reflected next
      round (e.g. an extra life from a purchased Hull Plating level).
* [ ] No console errors (including no CSP violations) on `/fishing-game`.

---

## Open Questions

* Exact point values, token costs, and gear effect magnitudes above are
  illustrative — real balancing happens during implementation/playtesting,
  not locked in this doc.
* Whether the leaderboard needs any abuse moderation beyond rate limiting
  (e.g. a profanity filter on `player_name`) if it turns out to attract spam
  once live.
* The streak multiplier's spawn-weight bias and Golden Bait's spawn-weight
  bias both push toward higher-value fish and stack multiplicatively at max
  level — worth a playtesting pass to confirm low-tier fish don't become
  effectively extinct at depth for a fully-geared player, rather than
  assuming the combination is automatically fine.

---

## Definition of Done

* [ ] User flow works end-to-end, including edge cases above (hit-based
      round-over, depth-cap round-over, abandoned round, leaderboard submit).
* [ ] All states in the UI table are implemented.
* [ ] "Fishing Game" appears in the Home dropdown and mobile nav panel,
      following the existing `NavItem`/`NavMenu` pattern in
      `internal/handler/nav.go`.
* [ ] Migration written, reviewed, and includes a working `Down`.
* [ ] Handler/service/repository boundaries followed (`go-backend`) for the
      leaderboard routes.
* [ ] `player_name` is rendered through `html/template` auto-escaping, with a
      passing XSS-regression test.
* [ ] `POST /fishing-game/score` is rate-limited and CSRF-protected.
* [ ] No inline `<script>` tags; CSP-clean on load.
* [ ] `fishing-game.js` cleans up its `requestAnimationFrame` loop and
      listeners on HTMX nav-away, not just on full page unload.
* [ ] Accessibility checked for all non-canvas UI (keyboard, focus, contrast,
      semantic HTML); the one deliberate `prefers-reduced-motion` gap
      (gameplay canvas) is documented, not accidental.
* [ ] Tests cover the behavior in the Testing Plan above.
* [ ] No open questions remain unresolved (or remaining ones are explicitly
      accepted as implementation-time tuning, not design gaps).
