# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Planning stage — no code has been written yet. This file is a brief to align on scope and architecture before implementation starts. Update it as decisions are made or change.

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

Server-rendered Go application: Go handlers render HTML (likely via `html/template` or a templating library), HTMX handles partial page updates/interactivity without a client-side framework, Tailwind provides styling, Postgres stores structured content (e.g. projects, resume entries) so it can be edited without redeploying static content.

Exact package layout, routing approach, and templating choice are not yet decided — establish these when implementation starts and document them here.

## Open decisions

- **Hosting**: target is Vercel, but the stack is Go + Postgres. Vercel's Go support is serverless-function based, which has implications for persistent Postgres connections (pooling) and any long-lived server process — verify this fits before committing, or pick an alternative host (e.g. Render, Fly.io) that fits a standard Go server model more naturally.
- **Database hosting**: needs a Postgres provider if not self-hosted (e.g. Neon, Supabase, Vercel Postgres).
- **Migration plan**: how/when vincentmegia.onrender.com gets replaced by the new site (DNS cutover, redirect, etc.) is not yet defined.
