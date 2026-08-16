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
A second mini-game, Kitchen Shift (a top-down restaurant-shift sim at
`/kitchen-shift` — take orders, gather ingredients, cook, then close up and
collect a flat per-shift Gard paycheck from Duke across a 20-shift month),
is implemented and covered by tests the same way — Postgres-backed public
leaderboard, `localStorage`-persisted Gard/shop progress — see
`docs/features/cooking-game.md`. `/projects` now leads with two real cards
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
