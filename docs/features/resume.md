# Feature: Resume

## Status

`Shipped` — implemented, running against a real Postgres instance, and
covered by both a backend end-to-end test (`cmd/server/e2e_test.go`) and a
frontend Playwright suite (`e2e/`, Chromium + WebKit). One known gap: the
"Least-privilege DB role" item under Security Considerations was never
actually configured — see that section and the Open Questions below.

## Summary

The `/resume` page: a dark banner (name, title, tenure, contact links), a
sidebar (core expertise, education, curated featured projects), and a main
column (summary + stat row, then an experience timeline with nested
sub-project/client entries), backed by Postgres so content can be edited
without a redeploy, with a print/PDF-friendly layout.

## Problem / Motivation

`/resume` currently renders only placeholder text (`PagesHandler.Resume` in
`internal/handler/pages.go`). Resume content is explicitly named in
CLAUDE.md's Planned Content and is the page most visitors of a personal site
built to replace a resume site will actually read. Without it, the site
can't replace `vincentmegia.onrender.com` as CLAUDE.md's stated goal requires.

## Scope

**In scope:**

* Banner: name, role title, tenure label, and a row of contact links (phone,
  email, location, personal site, GitHub, LinkedIn, LeetCode — each with an icon).
* Sidebar: Core Expertise (grouped skill pills), Education (degree/school/years),
  and a curated Featured Projects card ending in a "See all projects" link to
  `/projects`.
* Main column: a multi-paragraph professional summary (supporting a single
  lightweight `**bold**` markup) plus a stat row (number + label cards), then
  an experience timeline — one card per role (title, company, dates, a
  "Current" badge when still employed, blurb, bullet list) with nested
  sub-project/client-engagement entries (heading, optional client tag, blurb,
  own bullet list).
* Postgres schema and migration transcribing the actual resume content, plus
  the repository/service/handler layers to serve it.
* Extending the shared rendering pipeline (`Renderer`, `PageData`,
  `LoadTemplates`) so a route can render a distinct content template instead
  of every route sharing the single placeholder `"content"` definition — a
  prerequisite this feature introduces as its first consumer, not something
  `/resume` works around locally. See Template Rendering below.
* The first live Postgres connection for this project: pool wiring in
  `cmd/server/main.go`/`internal/config`, and the `migrations/` directory +
  `goose` setup.
* Updating `GET /healthz` to verify DB connectivity, per the existing
  `go-backend`/`Healthz` doc comment ("once the app has a database, this
  should also verify connectivity") — this feature is that trigger.
* An icon allowlist mapping DB-stored icon keys (e.g. `"phone"`, `"mail"`) to
  trusted inline SVG, mirroring `nav.go`'s `icon()` helper, with a defined
  fallback for an unrecognized key.
* A print stylesheet (adapted from the reviewed design artifact) and an
  explicit "Print / Save as PDF" button.
* `dark:` coverage for every new template/component this feature adds, per
  `dark-mode.md`'s "each new page owns its own dark classes" rule.
* New semantic color tokens in `web/static/css/app.css`'s `@theme` block,
  refining the current placeholder tokens with the reviewed design's palette.

**Out of scope:**

* An admin/CMS UI to edit resume content — no such UI exists anywhere in the
  app yet. Content is written via the seed migration or direct SQL for now;
  see Open Questions.
* The full `/projects` page and its data model — this feature only links out
  to it and owns its own small "featured projects" list.
* `/blogs` and anything else outside `/resume`.

---

## User Flow

```text
1. User navigates to /resume (via the Home ▾ menu, direct URL, or reload).
2. Page renders: banner at top, sidebar (expertise / education / featured
   projects) and main column (summary + stats, then experience timeline)
   below, inside the shared shell from home.md.
3. User reads the experience timeline top to bottom — most recent role
   first, each with its bullets and any nested sub-project/client entries.
4. User clicks a contact link, a featured-project link, or "See all
   projects" — each opens/navigates as a normal link (external links in a
   new tab; "See all projects" navigates within the site via the existing
   nav swap model).
5. User clicks "Print / Save as PDF" → the browser's print dialog opens,
   rendering a clean, sidebar-flattened, page-break-aware version of the page.
```

---

## Visual Direction

The reviewed design artifact ("Vincent Megia — Principal Software Engineer")
is the original basis for this page's look: a dark navy banner, a warm gold
accent, and card-based sidebar/timeline sections. The token *names* and
structure below are still exactly what's implemented; their *values* were
later re-themed from this artifact's navy/gold to the "Organic" design
system's terracotta/sage (docs/skills/tailwind-ui/SKILL.md's Visual Style) —
the banner is now a dark terracotta (`accent-900`) rather than navy, per that
doc. `web/static/css/app.css`'s `@theme`
block currently holds only placeholder tokens (`--color-brand`,
`--color-surface`, `--color-danger`, with a comment saying "refine when the
real design lands") — this feature is that refinement:

* **Neutrals**: `--color-ink`, `--color-muted`, `--color-line`,
  `--color-paper`, `--color-surface` / `--color-surface-2` — a text/border/
  background scale replacing the single placeholder `--color-surface`.
* **Brand accents**: `--color-primary` (the artifact's navy, `#1F3A5F`) for
  links, company names, and stat numbers; `--color-accent` (the artifact's
  gold, `#B8863B`) for bullet markers, badges, and highlights. `--color-brand`
  is retired in favor of these two more specific tokens.
* **Banner tokens**: `--color-banner-bg`, `--color-banner-ink`,
  `--color-banner-muted`, `--color-banner-accent` — the banner is a fixed
  dark surface in both light and dark site themes (matching the artifact),
  not something that inverts with the site's `dark:` variant.
* **Dark mode**: values for the neutral/primary/accent tokens are defined
  through the site's existing class-based `dark:` variant (`dark-mode.md`),
  not the artifact's own `prefers-color-scheme`/`data-theme` mechanism — the
  artifact was a standalone prototype; this site already has its own
  cookie-driven theme mechanism that every page must use.
* **Radius**: reuse the existing `--radius-card` for every card surface
  (banner, sidebar cards, role cards) rather than introducing new values.
* **Reconciling with `tailwind-ui`'s general guidance**: the artifact's card
  shadow is kept but flattened to a subtle 1–2px treatment ("avoid huge
  shadows"); its rounded corners map onto the existing `--radius-card` rather
  than a larger custom radius ("avoid excessive rounded containers"). No
  gradients or glassmorphism from the artifact are carried over (it doesn't
  use them either, so nothing to trim there).
* Stat numbers and skill pills use the new semantic tokens, not raw Tailwind
  palette classes, per `tailwind-ui`'s token guidance.
* **Timeline connector**: the artifact's experience timeline has a vertical
  line running down the left gutter, threading through a small circular dot
  per role — the current role's dot is highlighted (`--color-accent` border
  + tinted fill) instead of the neutral `--color-line` border/`--color-surface`
  fill every other role's dot uses. This was missed in the first
  implementation pass (`resume-timeline.html`/`resume-role.html` shipped as a
  plain stacked list, no connector at all) — decorative only
  (`aria-hidden="true"`, conveys nothing `IsCurrent`'s existing text
  "Current" badge doesn't already convey), and hidden below the `sm`
  breakpoint along with the gutter's reserved space, matching the artifact's
  own `max-width:640px` mobile behavior — role cards go full-width on mobile
  with nothing to connect.

---

## UI

```text
web/templates/pages/
└── resume.html                  # {{define "resume-content"}} (see Template
                                  # Rendering); replaces the placeholder
                                  # currently rendered by PagesHandler.Resume

web/templates/components/
├── resume-banner.html           # name/title/tenure + contact-link row
├── resume-sidebar.html          # core expertise, education, and featured
│                                 # projects cards, combined into one file —
│                                 # none are independently reusable or an
│                                 # HTMX swap target, so splitting them
│                                 # further would be needless fragmentation
│                                 # per htmx-ui's "avoid excessively small
│                                 # components" guidance
├── resume-summary.html          # summary paragraphs + stat row
├── resume-timeline.html         # wraps the ordered list of resume-role
└── resume-role.html             # one role: head, blurb, bullets, nested
                                  # sub-project entries; root id
                                  # `#resume-role-{id}` (resource-prefixed,
                                  # not bare `#role-{id}`, since "role" is
                                  # generic enough to collide with an
                                  # unrelated future feature) per htmx-ui's
                                  # ID-naming convention

web/static/css/app.css           # new @theme tokens (see Visual Direction)
                                  # + a print stylesheet block adapted from
                                  # the artifact's @media print rules

web/static/js/
└── resume-print.js              # click handler on the print button calling
                                  # window.print(); external file, not an
                                  # inline handler, per home.md's "no inline
                                  # <script>"/CSP precedent
```

States this feature's UI must handle:

| State    | Behavior |
| -------- | -------- |
| Default  | Banner, sidebar, summary/stats, and timeline all render from the seeded Postgres content. |
| Loading  | Nav swap into `/resume` uses the shell's existing `#nav-loading` indicator — no new indicator needed. |
| Empty    | A sidebar/timeline section with zero items (e.g. no featured projects seeded) renders nothing — no empty card shell. |
| Error    | A DB fetch failure renders the shell's generic "couldn't load this page" content-error state — never a stack trace or raw error string. |
| Print    | Sidebar chrome flattens to a simpler layout; role cards and sub-projects avoid splitting across a page break; matches the artifact's `@media print` block. |

---

## Template Rendering

`internal/handler/template.go`'s `Renderer.Render` currently executes a
template hardcoded by name — `"base"` for a full page, `"content"` for an
HTMX fragment — and every route today shares the *same* `{{define
"content"}}` (`pages/placeholder.html`), differentiated only by
`PageData.ContentTitle`/`ContentMessage`. `LoadTemplates` parses an explicit
file list, not a directory glob, and relies on "whichever file is parsed
last wins" for that shared `"content"` definition.

`resume.html` cannot simply add its own `{{define "content"}}` — that would
silently take over the `"content"` template for every other route
(`/projects`, `/blogs`, `/settings/*`), which are still on the placeholder,
not just `/resume`. This feature extends the rendering pipeline to support a
distinct per-route content template, as its first real consumer:

* `PageData` gains a `ContentTemplate string` field (e.g. `"resume-content"`).
  Go's zero value for an unset field is `""`, not `"content"`, so the
  defaulting happens in `Renderer.Render`, not the struct: treat an empty
  `ContentTemplate` as `"content"` there. This means every existing
  `PagesHandler` call site needs no changes — only `ResumeHandler` sets the
  field.
* `Render` currently has two paths that both need the same fix, not just
  one: the full-page path executes `"base"` (whose content block must
  dispatch via `{{template .ContentTemplate .}}` instead of the hardcoded
  `{{block "content" .}}`), and the **HTMX-fragment path executes the content
  template directly** (`ExecuteTemplate(&buf, "content", data)`) — that
  hardcoded `"content"` must become the same resolved name (`data`'s
  `ContentTemplate`, defaulted as above), or an HTMX nav swap into `/resume`
  would keep rendering the placeholder even after the full-page path is fixed.
* `resume.html` defines `{{define "resume-content"}}` rather than
  `{{define "content"}}`, avoiding the collision.
* `LoadTemplates`'s explicit file list gains every new `resume-*.html` file
  (the page plus all `resume-*` components) — a manual step, since the list
  isn't a glob; forgetting one fails fast at startup as a template
  parse/lookup error, not a silent gap.

This is a prerequisite for the rest of this doc, not an implementation
detail to improvise later — the UI, Routes/Handlers, and Data Model sections
below all assume it exists.

**`resume-content` owns its own `<main id="main-content">` wrapper — this
shipped without one initially, and it was a real bug, not just a style
choice.** `hx-swap="outerHTML"` (`home.md`'s HTMX Interactions) replaces the
*entire* `#main-content` element with the server's response. `resume.html`
originally rendered only its inner `<div class="space-y-6">`, assuming
`base.html` would supply the wrapper — correct for a direct page load
(`base.html` does wrap `.RenderedContent`), but every HTMX nav swap onto
`/resume` destroyed `#main-content`'s own `mx-auto max-w-5xl px-4 py-8`
classes along with the old content, leaving the page full-bleed with no
container or padding. `resume-content` now renders
`<main id="main-content" class="mx-auto max-w-5xl px-4 py-8">` itself; see
`home.md`'s HTMX Interactions for the general rule every content template
must follow, not just this one.

---

## HTMX Interactions

None owned by this feature beyond the existing `/resume` nav row already
specified in `home.md`'s HTMX Interactions table (`GET /resume` →
`#main-content`, `outerHTML`, `hx-push-url="true"`).

The print button is a plain `<button>` with a `resume-print.js` click handler
calling `window.print()` — not an HTMX request, since printing has no server
round trip.

Confirmation required for destructive actions:

* None — this feature has no destructive actions.

---

## Routes / Handlers

| Method | Path      | Handler              | Auth required | Notes |
| ------ | --------- | --------------------- | ------------- | ----- |
| GET    | `/resume` | `ResumeHandler.Index` | no            | Replaces the placeholder currently in `PagesHandler.Resume`; branches on `HX-Request` per `htmx-ui`'s fragment/full-page pattern, same as every other nav destination. |

Landing this route means deleting `PagesHandler.Resume` and updating its
registration in `cmd/server/main.go`'s `newMux()` — currently
`mux.HandleFunc("GET /resume", pages.Resume)` — to construct and wire the new
`ResumeHandler` instead.

`GET /healthz` got the matching structural change: `handler.Healthz` was a
stateless package-level function with no dependencies; verifying DB
connectivity (Scope, Security Considerations) meant it needed the connection
pool, so it's now `HealthHandler`, a method on a small struct holding
`*sql.DB` (not `*pgxpool.Pool` — this project uses `database/sql` with the
pgx driver, per `postgres`'s Query Layer section, not pgx's native pool
API), registered in `newMux()` the same way as `ResumeHandler`.

---

## Data Model

This was the first feature requiring a live Postgres connection —
`internal/repository`, `internal/service`, and `internal/model` were empty
(`.gitkeep` only) before it, and there was no `migrations/` directory, no
`DATABASE_URL` config, and no `pgx` dependency. Implementing it also stood up:

* Connection pool wiring in `internal/db` (`database/sql` + the pgx driver,
  per `postgres`'s Query Layer section — not pgx's native pool API),
  configured from `internal/config` (`DATABASE_URL`, pool size, statement/
  lock timeouts) per `postgres`'s Connection Management and Timeouts
  sections. `DATABASE_URL` itself is environment-variable-or-`.env`-only —
  see `go-backend`'s Configuration section — never a `config.yaml` key.
* The `migrations/` directory (embedded into the binary via
  `migrations/embed.go`, run automatically at startup — see Open Questions)
  and `goose` invocation per `postgres`'s Migrations section.

The schema is deliberately kept to **two tables** rather than fully
normalizing every list (skills, bullets, sub-projects) into its own table:
this is a single-owner site with exactly one resume, each section is always
read and edited as a whole unit, and nothing below the role level needs
independent querying or filtering — normalizing further would add joins and
migration surface without a concrete benefit (`go-backend`'s "do not
introduce abstractions without a concrete reason").

```sql
-- migrations/001_create_and_seed_resume.sql
-- Schema and seed data live in one migration, not two: this is a
-- single-owner site with one canonical seed and no per-environment
-- variance, so a second file would only add migration surface.

-- +goose Up
CREATE TABLE resume_profile (
    id                 BIGINT PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- singleton row
    role_title         TEXT NOT NULL,
    tenure_label       TEXT NOT NULL,
    location_label     TEXT NOT NULL,
    contact_links      JSONB NOT NULL, -- [{label, href, icon}], ordered
    summary_paragraphs JSONB NOT NULL, -- ["text with **bold** spans", ...], ordered
    stats              JSONB NOT NULL, -- [{num, label}], ordered
    skill_groups       JSONB NOT NULL, -- [{name, skills: [string]}], ordered
    education          JSONB NOT NULL, -- [{degree, school, start_year, end_year}], ordered
    featured_projects  JSONB NOT NULL, -- [{name, description, links: [{label, href}]}], ordered
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE resume_roles (
    id           BIGSERIAL PRIMARY KEY,
    title        TEXT NOT NULL,
    company      TEXT NOT NULL,
    location     TEXT,
    start_date   DATE NOT NULL,
    end_date     DATE,                        -- NULL = current/present
    blurb        TEXT,
    bullets      JSONB NOT NULL DEFAULT '[]', -- [string], ordered
    subprojects  JSONB NOT NULL DEFAULT '[]', -- [{heading, client_tag, blurb, bullets: [string]}], ordered
    sort_order   INTEGER NOT NULL,            -- authoritative display order
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- +goose Down
DROP TABLE resume_roles;
DROP TABLE resume_profile;
```

The `Up` section above continues with `INSERT` statements for the
`resume_profile` singleton row and one `resume_roles` row per role (Singtel,
Sofgen with its Barclays/PayPal sub-projects, Tangspac, Optimum Solutions),
transcribed from the reviewed design artifact — this is how content gets
written for launch in the absence of an admin UI. `Down` dropping both
tables removes the seeded rows along with the schema, so no separate cleanup
step is needed.

| Table            | Column               | Type         | Constraints                | Notes |
| ---------------- | --------------------- | ------------ | --------------------------- | ----- |
| resume_profile    | id                    | BIGINT       | PK, `DEFAULT 1 CHECK (id=1)` | singleton |
| resume_profile    | role_title             | TEXT         | NOT NULL                    | |
| resume_profile    | tenure_label           | TEXT         | NOT NULL                    | e.g. "18+ years · Architecture & Technical Leadership" |
| resume_profile    | location_label         | TEXT         | NOT NULL                    | |
| resume_profile    | contact_links          | JSONB        | NOT NULL                    | ordered array of `{label, href, icon}` |
| resume_profile    | summary_paragraphs     | JSONB        | NOT NULL                    | ordered array of strings, may contain `**bold**` spans |
| resume_profile    | stats                  | JSONB        | NOT NULL                    | ordered array of `{num, label}` |
| resume_profile    | skill_groups           | JSONB        | NOT NULL                    | ordered array of `{name, skills: [string]}` |
| resume_profile    | education              | JSONB        | NOT NULL                    | ordered array of `{degree, school, start_year, end_year}` |
| resume_profile    | featured_projects      | JSONB        | NOT NULL                    | ordered array of `{name, description, links: [{label, href}]}` |
| resume_profile    | updated_at             | TIMESTAMPTZ  | NOT NULL DEFAULT NOW()      | |
| resume_roles      | id                    | BIGSERIAL    | PK                           | |
| resume_roles      | title                 | TEXT         | NOT NULL                    | |
| resume_roles      | company               | TEXT         | NOT NULL                    | |
| resume_roles      | location              | TEXT         | nullable                    | |
| resume_roles      | start_date             | DATE         | NOT NULL                    | |
| resume_roles      | end_date               | DATE         | nullable                    | `NULL` = current/present |
| resume_roles      | blurb                 | TEXT         | nullable                    | |
| resume_roles      | bullets               | JSONB        | NOT NULL DEFAULT '[]'       | ordered array of strings |
| resume_roles      | subprojects           | JSONB        | NOT NULL DEFAULT '[]'       | ordered array of `{heading, client_tag, blurb, bullets: [string]}` |
| resume_roles      | sort_order             | INTEGER      | NOT NULL                    | authoritative display order |
| resume_roles      | created_at             | TIMESTAMPTZ  | NOT NULL DEFAULT NOW()      | |
| resume_roles      | updated_at             | TIMESTAMPTZ  | NOT NULL DEFAULT NOW()      | |

No index beyond the primary keys: `resume_profile` is always fetched by its
single fixed id, and `resume_roles` is always fetched in full (`ORDER BY
sort_order`) — a handful of rows for one person's career, never filtered.

No `CHECK` constraints validate the *inner* shape of the JSONB columns
(beyond what's shown above) — only that each is present and non-null. Since
there's no admin UI, every write is hand-authored SQL, and a typo'd key or
wrong nesting is still valid JSON: it won't fail the migration, it'll decode
to zero-value Go structs and silently render a blank section. The service
must treat a JSON-decode error as a rendering failure (the Error state from
the UI table), never a partial or silently blank render — this turns a
malformed migration into an immediately visible failure instead of a
quietly broken page. See Testing Plan.

`contact_links[].icon` values are keys (e.g. `"phone"`, `"mail"`, `"globe"`,
`"branch"`, `"network"`, `"bars"`), not raw SVG or HTML. The service/handler
maps each key through a fixed Go allowlist to trusted inline SVG, mirroring
`nav.go`'s `icon()` helper (Go source constants only, never DB-sourced
markup rendered unescaped). An unrecognized key renders the contact item
with no icon rather than failing the request.

**Repository** (`internal/repository`): `ResumeRepository.GetProfile(ctx)`,
`ResumeRepository.ListRoles(ctx)` — two fixed queries, not an N+1 pattern.

**Service** (`internal/service`): `ResumeService.Get(ctx)` aggregates both
into a `ResumeView`, decodes the JSONB fields into typed Go structs
(`internal/model`), computes each role's display labels ("APR 2021",
"PRESENT" when `end_date IS NULL`) from the real `DATE` columns, resolves
`contact_links[].icon` keys through the allowlist above, and runs the
`**bold**` mini-markup converter on summary paragraphs (see Security
Considerations).

---

## Business Rules / Validation

* `resume_profile` always has exactly one row (`id = 1`, enforced by the
  `CHECK` constraint) — there is one owner, one resume.
* `resume_roles` display order is `sort_order`, not `start_date` — a role's
  nested client engagements aren't strictly chronological with the parent
  role's own start/end (e.g. a client stint nested inside a longer
  consultancy tenure), so the service must not re-sort by date.
* A role with `end_date IS NULL` renders the "Current" badge and "PRESENT" in
  its date range; this is the only signal for "current" — no separate
  boolean column.
* Summary paragraphs support exactly one lightweight markup: `**text**` →
  `<b>text</b>`. No other markup is interpreted.
* The Personal Projects sidebar card always ends with a "See all projects"
  link to `/projects`, regardless of how many featured projects exist.
* External links (personal site, GitHub, LinkedIn, LeetCode, project links)
  open in a new tab with `rel="noopener noreferrer"`, per the pattern already
  established in `home.md`.
* A role's location displays combined with its company (e.g.
  "Singtel — Singapore"), built from `resume_roles.company` and `.location`
  — not a separate visual field.
* Contact links carry over the phone number present in the reviewed design
  artifact, presumed to mirror content already on the current live resume
  site (`vincentmegia.onrender.com`) — that presumption should be confirmed
  before the seed migration ships, since publishing a personal phone number
  is a real exposure decision, not just a spec detail. If not already public,
  omit it or replace it with an email-only contact row.

---

## Security Considerations

* **Authz**: `/resume` stays unauthenticated, matching every content route
  except `/settings/*` — no new auth surface.
* **Stored content, not user input**: `resume_profile`/`resume_roles` are
  owner-authored (via the seed migration or direct SQL, not a public form),
  but must still be rendered through `html/template`'s normal auto-escaping
  like any other DB-sourced content — per `home.md`'s existing precedent,
  content isn't assumed safe just because it wasn't previously.
* **`**bold**` mini-markup**: the converter must escape the paragraph text
  first, then apply the bold transform on the already-escaped text — it must
  never interpret raw HTML from the `summary_paragraphs` JSONB values. This
  is the one place this feature intentionally renders non-plain-text from the
  DB, so it's called out explicitly rather than inheriting escaping "for free."
* **Icon keys**: `contact_links[].icon` is a lookup key resolved through a
  fixed Go allowlist to trusted inline SVG — never rendered as raw markup
  from the DB, even though the DB is owner-authored, per the same
  "don't assume safe" precedent above.
* **`**bold**` converter's escaping order is the actual security mechanism,
  not just a style note**: split the raw paragraph on `**...**`, HTML-escape
  each text segment individually, *then* concatenate with literal `<b>`/
  `</b>` around the bolded segments, and mark only that final assembled
  string as `template.HTML` (trusted) before handing it to the template. If
  the order were reversed — escaping the whole string *after* inserting the
  tags — `html/template` would re-escape the tags themselves and print
  literal `&lt;b&gt;`. Every character that reaches the output unescaped
  must be a Go string literal (`<b>`, `</b>`), never a byte taken directly
  from the DB.
* **Link hrefs must stay `template.URL`-free**: `contact_links[].href`,
  `featured_projects[].links[].href`, and project links render as plain
  `href="{{.Href}}"`. `html/template` automatically sanitizes the URL
  context (a `javascript:`-scheme value is neutralized) as long as the value
  isn't wrapped in `template.URL`, which asserts "already safe" and turns
  that protection off. Don't add such a wrapper here — there's no reason to,
  since these are plain HTTP(S)/`tel:`/`mailto:` links.
* **Print button**: `resume-print.js` is an external file, no inline
  handlers, consistent with `home.md`'s CSP precedent (compatible with a
  strict CSP with no `'unsafe-inline'` for scripts).
* **Destructive actions**: none — this feature has no destructive actions.
* **Secrets**: `DATABASE_URL` follows `go-backend`'s Configuration section —
  environment variable, never hardcoded, fails fast if missing, and is
  expected to require TLS (`sslmode=require`) once a hosted provider is
  chosen (CLAUDE.md's Database hosting decision is still open).
* **Least-privilege DB role — designed but not yet configured**: the app's
  runtime connection only ever needs `SELECT` on `resume_profile`/
  `resume_roles` — there's no write path from the running app (writes only
  happen via migrations/direct admin SQL, per Open Questions), so the
  runtime role should not hold `INSERT`/`UPDATE`/`DELETE`/DDL on these
  tables, per `postgres`'s "do not use a superuser account for the
  application." **This isn't actually true of the current dev setup**: local
  dev's `DATABASE_URL` connects as the `postgres` superuser, since goose
  needs DDL privileges to run migrations and there's only one connection
  string/role configured today, used for both migrating and serving. See
  Open Questions.
* **`/healthz`'s DB check must not leak details**: once it verifies DB
  connectivity (Scope), the response stays the existing plain `ok`/non-200
  pattern — never the underlying driver error, connection string, or host,
  which would otherwise hand an unauthenticated public endpoint real
  infrastructure detail.

---

## Testing Plan

End-to-end coverage against a real Postgres instance now exists —
`cmd/server/e2e_test.go` (backend: full config → DB → migrations → routing →
templates chain, driven over real HTTP, skipped rather than failing when
`DATABASE_URL`/`.env` isn't set) and `e2e/*.spec.js` (frontend: a real
browser via Playwright, driving the actually-running server — see
`e2e/playwright.config.js`, `make test-e2e`). Both are currently green. The
per-behavior list below still stands as the fuller checklist; items already
covered by those suites are noted inline.

* [x] `/resume` renders banner, sidebar (skills/education/featured projects +
      link to `/projects`), summary + stats, and the full experience timeline
      with nested sub-projects, matching the seeded content — `cmd/server/
      e2e_test.go` (real DB) and `e2e/resume.spec.js` (real browser).
* [x] A role with `end_date IS NULL` shows the "Current" badge and "PRESENT"
      — `cmd/server/e2e_test.go`, `internal/service/resume_service_test.go`'s
      `TestDateRange`.
* [x] `**bold**` spans in summary paragraphs render as `<b>`; a literal `<`
      or `&` in seeded content renders escaped, not interpreted as HTML —
      `TestBoldMarkup`, including a simulated raw-`<script>` case.
* [ ] Print button triggers the browser print dialog — verified (`e2e/
      resume.spec.js` spies on `window.print`) — **but** the print
      stylesheet's actual page-break-avoidance behavior is not automated
      (no headless print-preview check); only manually inspectable.
* [ ] DB fetch failure renders the generic content-error state, no stack
      trace or raw error string. Not covered by an automated test (would
      need a way to fail the DB mid-request in the e2e harness); the code
      path exists (`ResumeHandler.Index`'s error branch) but is unverified.
* [ ] A malformed-but-valid-JSON content field (e.g. a `stats` entry missing
      `num`) decodes safely into the Error state rather than a partial or
      blank render. Same gap as above — not automated.
* [x] An unrecognized/malformed `contact_links[].icon` key renders the
      contact item with no icon, rather than failing the request —
      `TestResolveIcon`.
* [ ] Dark mode: banner, sidebar cards, and timeline all have correct `dark:`
      colors — not just the shell's pre-existing chrome. The toggle
      mechanism and its persistence are tested (`e2e/resume.spec.js`); a
      full visual pass confirming every component's dark-mode colors is not.
* [ ] Migration's `Down` cleanly drops both tables (including seeded rows);
      re-running `Up` after `Down` recreates a working, fully-seeded schema.
      Not automated — `goose`'s `Up`/`Down` were exercised manually, not in
      a repeatable test.
* [x] Empty featured-projects list renders no empty card shell, only the
      "See all projects" link — `internal/handler/template_test.go`'s
      `TestRenderFullPage` fixture sets `FeaturedProjects: nil`.
* [x] `/resume` renders correctly via `ResumeHandler.Index` after
      `PagesHandler.Resume`'s placeholder registration is removed from
      `cmd/server/main.go`; every other placeholder-backed route
      (`/projects`, `/blogs`, `/settings/*`) is unaffected by the
      `ContentTemplate` change — `cmd/server/e2e_test.go`,
      `internal/handler/template_test.go`.
* [ ] `GET /healthz` reports unhealthy when the DB is unreachable, and its
      response body never contains the driver error, connection string, or
      DB host in that case. Only the *healthy* path is tested
      (`cmd/server/e2e_test.go`) — the unreachable-DB branch is unverified.
* [x] `**bold**` rendering is verified via the actual `template.HTML`
      output (not just visual inspection) — confirms escape-then-wrap
      ordering, not tag-then-escape — `TestBoldMarkup`.
* [ ] A `contact_links[].href` value with a `javascript:` scheme (simulated
      bad data) renders neutralized, not as a clickable `javascript:` link —
      confirms no `template.URL` wrapper was added around it. Not tested;
      relies on `html/template`'s built-in contextual auto-escaping, which
      is well-established behavior but unverified specifically for this
      field.

---

## Open Questions

* Admin/CMS UI for editing resume content without direct SQL access —
  deferred to a future feature; for now content changes require a new
  migration or a manual `UPDATE`.
* Whether `/projects` eventually becomes Postgres-backed itself, and if so
  whether `resume_profile.featured_projects` should be reconciled into a
  shared table with a "featured" flag instead of a resume-owned duplicate —
  not decided now since `/projects` has no data model yet.
* How the migration actually runs at deploy time (embedded auto-run inside
  `main.go` on boot, vs. a separate `goose up` deploy step) isn't decided
  here — it depends on CLAUDE.md's still-open Hosting decision. Auto-run-on-
  boot is meaningfully riskier on a serverless-style host (e.g. Vercel),
  where concurrent cold starts could race the same migration; a discrete
  deploy-time step is safer there. Revisit once hosting is chosen.
* Splitting the single `DATABASE_URL`/`postgres`-superuser connection into
  two roles (a migration role with DDL rights, a `SELECT`-only runtime role)
  is designed (Security Considerations) but not implemented — today's
  `runMigrations` and `newMux`'s repository both use the same `*sql.DB`,
  connected as `postgres`. Worth doing before any real deployment, alongside
  the migration-execution-mechanism question above, since both depend on
  what the eventual hosting/DB provider actually supports (e.g. whether it
  offers an easy way to provision a second, restricted role).

---

## Definition of Done

* [x] User flow works end-to-end, including edge cases above.
* [x] All states in the UI table are implemented (loading/empty/error/print).
* [x] `Renderer`/`PageData`/`LoadTemplates` support a per-route
      `ContentTemplate`, per Template Rendering, with every existing
      placeholder-backed route still working unchanged.
* [x] `PagesHandler.Resume` removed; `cmd/server/main.go` registers
      `ResumeHandler.Index` for `GET /resume`.
* [x] Migration written, reviewed, includes a working `Down`, and transcribes
      the actual resume content in its `Up`.
* [ ] A JSONB decode failure surfaces as the Error state, never a blank or
      partially-rendered page. Code path exists; not exercised by a test —
      see Testing Plan.
* [x] Icon keys resolve through the Go allowlist; an unrecognized key
      degrades to no icon, not a failed request.
* [ ] `GET /healthz` verifies DB connectivity without leaking driver/connection
      details in its response. Implemented; only the healthy path is
      test-verified — see Testing Plan.
* [ ] **Not done.** Runtime app DB role holds only `SELECT` on
      `resume_profile`/`resume_roles`; migrations run under a separate, more
      privileged role. Dev currently connects as the `postgres` superuser for
      both — see Security Considerations and Open Questions.
* [x] Handler/service/repository boundaries followed (`go-backend`).
* [x] Postgres connection pool, config, and `goose` setup established
      per `postgres`.
* [ ] Accessibility checked (keyboard, focus, contrast, semantic HTML) —
      keyboard operability and focus behavior were checked incidentally
      while fixing the dropdown/Escape bugs (`home.md`'s Business Rules), but
      no dedicated contrast/screen-reader pass has been done on this page.
* [x] Tests cover the behavior in the Testing Plan above, where marked `[x]`
      there — several gaps remain, tracked in that section rather than
      silently dropped.
* [x] `go vet`/`go test` pass.
* [ ] Open questions remain — the migration-execution-mechanism and
      least-privilege-DB-role items are real, tracked gaps, not resolved
      ones; this feature is shipped with them explicitly deferred, not
      because they don't matter.
