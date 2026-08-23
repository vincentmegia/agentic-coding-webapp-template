# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Active development. The site shell (header/nav/footer, mobile nav, dark
mode) and the Resume feature (Postgres-backed `/resume` page) are
implemented and covered by tests — see `docs/features/home.md` and
`docs/features/resume.md`. The header nav is a flat Home/Projects/About
link row plus a Résumé button (not a dropdown) — see `internal/handler/
nav.go`'s `primaryNavItems` doc comment; Settings is still a dropdown,
auth-gated. Blogs is reachable only at its URL (`/blogs`), not linked from
anywhere; Fishing Game is no longer linked from the header but is linked
from the `/projects` grid (see below), the landing page's "Selected work"
section, and its own URL (`/fishing-game`). The
landing page (`/`) renders an image carousel below its hero (hand-authored
placeholder illustrations — see `docs/features/landing-carousel.md`;
automated test coverage for it is still pending), then a "Selected work"
card grid — currently just the Fishing Game, clickable straight into the
game (`docs/features/landing-page.md`). A
Fishing Game mini-game (canvas-based, Postgres-backed public leaderboard,
gear upgrades via `localStorage`-persisted fishing tokens) is implemented
and covered by tests at `/fishing-game` — see `docs/features/fishing-game.md`.
A second mini-game, Kitchen Shift (a top-down, click-controlled restaurant-
shift sim at `/kitchen-shift` — click a table/fridge/cabinet/stove/etc. and
the player walks over and uses it automatically; take orders, gather
ingredients and cookware, cook, manage a draining Sanity bar via the Coffee
Machine, then close up and collect that shift's Gard paycheck from Duke
across a 30-shift, 30-table month, with recurring characters Mel, Olive &
Oliver, and a one-off Karen on shift 12), is implemented and covered by
tests the same way — Postgres-backed public leaderboard, `localStorage`-
persisted Gard/shop progress — see `docs/features/cooking-game.md` (plus
its `cooking-game-food-server.md`/`cooking-game-customer.md`/
`cooking-game-kitchen.md` rule-domain sibling docs, and
`cooking-game-food-server-leveling.md` for the round-tier system below).
The paycheck starts
at 4,000 Gard and loses 500 per mistake (a missed or wrong-served order),
floored at 500 — replacing an earlier flat 4,000-or-2,000 split — and
every mistake also drains a shift-long Reputation stat (drawn as a second
on-canvas bar under Sanity) that shortens every later customer's patience
that shift. The month is
split into three progressively harder 10-shift "round tiers" (1–10/
11–20/21–30): Tier 1 opens just 6 of the 30 tables with a 5-minute
shift clock and a 1-order capacity, Tier 2 opens 18 tables with a
3-minute clock and 3-order capacity, and Tier 3 opens all 30 tables with
a 2-minute clock and 5-order capacity — driven live off the current
shift number, so a fresh "Start New Month" always begins back at Tier 1
rather than a persisted lifetime stat carrying progress across months.
Its
visual style is "coquette" (soft pastel palette, rounded shapes, bow/star
accents) rather than v2's pixel-art look, the floor plan is split into a
Dining room and a separate Kitchen room (fridge/cabinet/cookware-closet/
stove/oven/cleaning-closet) connected by a door and an "Enter Kitchen"
button, and a one-time walk-in intro with scripted dialogue plays before a
player's very first shift. Every finished dish and raw ingredient has a
flat, canvas-drawn icon (no image assets/generation tooling exist in this
project, so these are procedural, not real sprite art) rather than a plain
text name; holding one puts the player in a carrying pose — arms bent
around a tray, food icon(s) stacking directly onto it as ingredients are
gathered — instead of the old floating text label. A correctly served
customer now visibly eats at their table (a bobbing dish icon beside their
head), then walks to the Counter, pauses to "pay," and leaves, crediting a
small immediate Gard bonus (50, `COUNTER_PAYMENT_GARD`) on top of — not
instead of — the unchanged end-of-shift paycheck; the eating and paying
pauses are each randomized per customer so several served together don't
move in lockstep. All six Kitchen-room stations (Fridge, Cabinet, Cookware
Closet, Cleaning Closet, Stove, Oven) now have dedicated canvas-drawn
sprites instead of a plain flat-colored box; fixed alongside that was a bug
where arriving at the Stove/Oven after a customer's patience had already
timed out mid-gather silently did nothing (now shows a toast). The
Restroom, Duke's Office, and both room doors now have dedicated sprites
too, and the Restroom moved from the Dining room's top-left corner to its
bottom-right; also fixed was a bug where the Counter employee's own sprite
had a stray line drawn across their face — redesigned as a solid
counter-front panel sized from the employee's own torso-bottom so the
face is always fully clear. The floor's "Entrance / Exit" marker is now an
actual door sprite (open doorway, star lanterns, a welcome mat) instead of
plain text. The player and every departing customer now visually avoid
overlapping stations, tables, and each other (`floor-plan.js`'s
`resolveObstacleCollisions`) — applied only to what's actually drawn, not
to the underlying walk/arrival logic, since an earlier version that fed
it into the real position could deadlock two customers converging on the
Counter. Customer arrival timing is now jittered (±40% around the
existing shift-ramp average, `jitteredArrivalIntervalSeconds`) instead of
landing on an exact, identical beat every time; which tables/dishes get
picked was already random and unchanged. Mel and Olive & Oliver no longer
land in the unconditional 1st/2nd customer slot of every shift either —
they're still guaranteed to appear exactly once per shift, but now at a
random point rather than always first, drawn from one flat candidate list
that weights them the same as a single regular dish; their own signature
order stays fixed, and Karen's fixed shift-12 trigger is unchanged. Every
newly spawned customer now visibly walks in from the Entrance/Exit door
before taking their seat, instead of appearing at their table instantly —
the mirror image of a paid customer's existing walk-to-the-Counter-and-
leave animation.
`/projects` now leads with two real cards
— Fishing Game and Kitchen Shift, both linking straight into their games
via "Play now" — but Kitchen Shift still isn't linked from the header nav
or the landing page's "Selected work" section yet, same as the Fishing
Game's own gradual nav rollout.
The site's visual design system is "Organic" (warm cream ground,
terracotta/sage accents, Caprasimo + Figtree), pulled in from a
claude.ai/design project and adapted into Tailwind tokens — see
`docs/skills/tailwind-ui/SKILL.md`'s Visual Style. The landing hero, header,
and nav are pulled from that same claude.ai/design workspace's "Personal
website and portfolio" project; a from-scratch restyle of page-specific
components (resume, fishing game, carousel) to the new tokens is still
open. The `/projects` page now renders a card grid too (same "Personal
website and portfolio" pull — see `docs/features/projects.md`), currently
two real cards linking into the Fishing Game and Kitchen Shift — the
design mockup's four fictional placeholder projects were removed rather
than left sitting next to them. Blogs and About are still placeholders.
Update this file as decisions are made or change.

## What this is

A personal website for Vincent Megia, replacing the current resume site at vincentmegia.onrender.com. The new site keeps the resume content but expands into a fuller personal site, and links out to the original projects (including the current resume site itself) rather than reimplementing them.

## Planned content

- **Bio / About** — personal background, more than a resume covers
- **Resume** — the content currently on vincentmegia.onrender.com
- **Projects** — work in progress and past projects, linking out to their live/original locations where applicable
- **Personal interests** — a section outside of the professional/resume content

## Tech stack

- **Backend**: Go
- **Frontend interactivity**: HTMX (server-rendered HTML, no separate JS frontend framework)
- **Styling**: Tailwind CSS
- **Database**: PostgreSQL

## Skills and feature docs

Detailed, opinionated engineering conventions live in `docs/skills/` — read the
relevant one(s) before writing code in that area:

- `docs/skills/go-backend/SKILL.md` — Go backend structure, HTTP, security, testing
- `docs/skills/postgres/SKILL.md` — schema, migrations, queries, connection handling
- `docs/skills/htmx-ui/SKILL.md` — HTMX interactions, layout/template architecture
- `docs/skills/tailwind-ui/SKILL.md` — Tailwind design system and visual conventions

Every non-trivial feature should have a doc in `docs/features/`, based on
`docs/features/template.md`, describing its scope, UX, routes, data model, and
definition of done. Create one before implementing a new feature.

## Architecture plan

Server-rendered Go application: Go handlers render HTML via `html/template`,
HTMX handles partial page updates/interactivity without a client-side
framework, Tailwind provides styling, Postgres stores structured content
(e.g. resume entries — see `docs/features/resume.md`'s Data Model) so it can
be edited without redeploying static content.

Decided and in place:

- **Package layout**: `cmd/server` (entrypoint), `internal/{handler,service,
  repository,model,config,db}`, `web/{templates,static}`, `migrations/` — see
  `docs/skills/go-backend/SKILL.md`'s Project Structure.
- **Routing**: standard library `net/http.ServeMux` (Go 1.22+ method+pattern
  routing), registered in `cmd/server/main.go`'s `newMux`.
- **Templating**: `html/template`, one shared `base.html` shell + per-route
  content templates, each owning its own `<main id="main-content">` wrapper
  (required by `hx-swap="outerHTML"` — see `docs/features/home.md`'s HTMX
  Interactions). A route with real content beyond the shared placeholder sets
  `PageData.ContentTemplate`; see `docs/features/resume.md`'s Template
  Rendering section for why that dispatch happens in Go code, not the
  template itself.
- **Configuration**: layered defaults → optional `config.yaml` → optional
  `.env` → real environment variables, the last always winning. See
  `docs/skills/go-backend/SKILL.md`'s Configuration section,
  `config.example.yaml`, `.env.example`.
- **Migrations**: `goose`, embedded via `migrations/embed.go` and run
  automatically at server startup — see `docs/features/resume.md`'s Open
  Questions for why that's flagged as worth revisiting once Hosting is
  decided.
- **Build/dev tooling**: `Makefile` (`make help` lists targets) wraps Go and
  npm (Tailwind CLI) commands consistently — see
  `docs/skills/go-backend/SKILL.md`'s Code Quality section.
- **Testing**: `go test ./...` (includes a DB-gated end-to-end test in
  `cmd/server/e2e_test.go`, skipped without `DATABASE_URL`) plus a Playwright
  frontend suite in `e2e/` (`make test-e2e`), run against both Chromium and
  WebKit — the latter matters concretely, since it's already caught a real
  Safari-only bug (`docs/features/home.md`'s Business Rules).

## Open decisions

- **Hosting**: target is Vercel, but the stack is Go + Postgres. Vercel's Go support is serverless-function based, which has implications for persistent Postgres connections (pooling) and any long-lived server process — verify this fits before committing, or pick an alternative host (e.g. Render, Fly.io) that fits a standard Go server model more naturally.
- **Database hosting**: needs a Postgres provider if not self-hosted (e.g. Neon, Supabase, Vercel Postgres).
- **Migration plan**: how/when vincentmegia.onrender.com gets replaced by the new site (DNS cutover, redirect, etc.) is not yet defined.
