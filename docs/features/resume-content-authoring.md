# Feature: Resume Content Authoring

## Status

`In Progress` — implemented (migration, repository/service/handler layers,
`/settings/resume` templates, unit tests for validation/encoding, a
DB-gated round-trip test) and verified against a real Postgres instance
(`cmd/server/resume_admin_e2e_test.go`, `TestResumeAdminRoundTrip` — every
save/create/update/move/delete path, plus font-class resolution and
invalid-input rejection). Not yet reachable in production, since it sits
behind the same `IsAuthenticated` stub as `/settings/content`/
`/settings/profile` — see the Auth dependency note this shares with
`landing-content-authoring.md`. Not yet exercised through a real browser.

## Summary

Lets the authenticated site owner edit every card/section of `/resume`
(banner, the three sidebar cards, summary+stats, and the experience
timeline's roles) from a new auth-gated `/settings/resume` page, and pick
an independent font-pairing preset per card — all stored on this site's
own Postgres (never home-admin/HQ's database).

## Problem / Motivation

`docs/features/resume.md` shipped `/resume` as Postgres-backed but
explicitly deferred an editor: its Open Questions note "content changes
require a new migration or a manual `UPDATE`." That was fine for the
initial one-time transcription of existing resume content, but ongoing
maintenance — a new role, an updated bullet, a reordered skill group —
shouldn't need a migration and a deploy every time.

This is the same move `docs/features/landing-content-authoring.md` already
made for the landing page, applied to `/resume`, plus a capability that
page didn't need: **independent font-pairing per card**, so the resume can
visually differentiate sections (e.g. a traditional serif for the
experience timeline vs. the site's default display font for the banner)
rather than being locked to one site-wide pairing.

## Scope

**In scope:**

* New auth-gated `/settings/resume` page, alongside Profile/Content/
  Security in `settingsMenu` (`internal/handler/nav.go`).
* Per-card edit forms, each saved independently (mirrors
  `landing_hero`'s per-section save pattern, not one giant form):
  * **Banner** — name/role title/tenure label/location label/contact links.
  * **Sidebar → Core Expertise** — skill groups.
  * **Sidebar → Education** — degree/school/year entries.
  * **Sidebar → Featured Projects** — the curated project list.
  * **Summary + Stats** — summary paragraphs (with `**bold**` support) and
    the stat row.
* Full add/edit/delete/reorder for **experience timeline roles**
  (`resume_roles`): title, company, location, dates, "Current" behavior
  (`end_date IS NULL`), blurb, bullets, and nested subprojects — the one
  section with real independent create-over-time semantics (a new job
  every so often), unlike the singleton profile fields above. Bullets and
  subprojects are edited as a whole array within the role's own form, not
  as separately CRUD'd resources — same reasoning `resume.md`'s Data Model
  already gives for why nothing below role level needs independent
  querying.
* **Font style per card**: six independently choosable slots — one per
  card listed above, plus one per `resume_roles` row (nested subprojects
  inherit their parent role's choice, no further nesting). Each stores a
  short **preset key**, resolved through a fixed Go allowlist to CSS
  custom properties — never a free-typed font-family string. See Font
  Presets below.
* Three new curated presets in addition to keeping today's look as the
  default (`organic` — Caprasimo/Figtree, unchanged): proposed
  `classic-serif` (Fraunces/Source Serif 4), `modern-sans` (Space Grotesk/
  Inter), `editorial` (Playfair Display/Lora). All four Google Fonts
  families are OFL-licensed and self-hostable — final pick is yours before
  this leaves Proposed.
* A migration adding `font_style` columns (with a `CHECK` constraint
  against the allowlisted keys) to `resume_profile`/`resume_roles`. No
  JSONB shape changes — the existing arrays just become writable instead
  of migration-only.
* Validation mirroring `resume.md`'s existing Business Rules: required
  fields per section, no markup beyond `**bold**`, icon keys resolved
  through the existing allowlist, never free HTML.

**Out of scope:**

* **Any HQ/home-admin involvement.** Per your third acceptance criterion,
  this stays entirely inside this app: no bearer-token API, no second
  database, no dependency on the separate home-admin app. Contrast with
  `docs/features/landing-content-api.md`, which exists *only* because HQ
  needed a path to the landing tables — no equivalent need exists for the
  resume, so no equivalent API gets built.
* **Real authentication.** Like `landing-content-authoring.md`,
  `/settings/resume` is written against the existing `IsAuthenticated`
  contract and stays unreachable (redirects to `/login`) until real auth
  ships — code-complete-but-gated, same precedent.
* **Adding more presets beyond the three proposed.** A 5th/6th preset
  later is a small follow-up (a new self-hosted font file + one allowlist
  entry), not blocked by this feature.
* **Per-subproject or per-bullet font style.** Style granularity stops at
  the card/role level; going finer is combinatorial without a concrete
  benefit.
* **Rich text/Markdown/WYSIWYG, revision history/undo.** Same exclusions
  as `landing-content-authoring.md`, same reasoning.

---

## Architecture

Five layers, each already established by `resume.md`/
`landing-content-authoring.md` — this feature adds to them, it doesn't
introduce a new pattern:

```text
Postgres              resume_profile / resume_roles, widened with 6 new
                       font_style columns (CHECK-constrained to the 4
                       preset keys). No new tables, no JSONB shape change
                       — existing arrays become writable, not restructured.
       │
internal/repository    ResumeRepository gains one targeted UPDATE method
                       per card (UpdateBanner, UpdateExpertise, ...) plus
                       CreateRole/UpdateRole/DeleteRole/moveRoleSortOrder.
                       Each UPDATE touches only its own card's columns —
                       saving one card never clobbers another's data.
       │
internal/service       ResumeService gains the matching write methods:
                       validate input (Business Rules), return typed
                       sentinel errors on failure, otherwise persist via
                       the repository. This is the one place font_style
                       values are checked against the allowlist before
                       ever reaching a query parameter.
       │
internal/handler       New ResumeAdminHandler (resume_admin.go): decodes
                       form input, calls the service, maps sentinel
                       errors to inline field errors, renders the
                       relevant component on success. Gated by the same
                       IsAuthenticated/requireOwnerAuth every other
                       /settings/* route uses.
       │
web/templates + HTMX   settings-resume.html hosts six independent
                       resume-admin-*.html card components; each submits
                       to its own endpoint and swaps only its own
                       #resume-admin-* container (outerHTML) — a save on
                       one card never re-renders the others.
```

**Font-preset resolution** is a parallel, narrower path through the same
layers, mirroring `resume.md`'s existing `contact_links[].icon` allowlist:

```text
DB column (font_style key, e.g. "classic-serif")
  → Go allowlist (internal/service or a small internal/model map)
  → CSS wrapper class (e.g. resume-font-classic-serif)
  → --font-heading / --font-body custom properties scoped to that
    card's container (web/static/css/app.css)
```

The key never becomes a raw `font-family` value interpolated into markup
— the allowlist is the only thing standing between a DB value and CSS, on
both the read path (render) and the write path (the service rejects an
unrecognized key before it's stored, backed by the DB `CHECK` as a second
line of defense).

**Read path is unchanged.** `GET /resume` (`ResumeHandler.Index`) already
calls `ResumeService.Get`; this feature only adds the write side in front
of the same two tables. There is no new read query, and no change to how
`/resume` itself is rendered beyond resolving six more `font_style` keys
alongside the existing icon-key resolution.

**No new network boundary.** Every new method above runs in-process, in
the same binary and same `*sql.DB` pool `resume.md` already wired up —
consistent with the "no HQ/home-admin involvement" constraint in Scope:
there's nothing here for a second service to call into, because there is
no second service.

---

## User Flow

```text
1. Owner logs in (once real auth exists) and opens Settings → Resume, a
   new entry alongside Profile/Content/Security.
2. /settings/resume renders six independent card editors in the same
   order they appear on /resume: Banner, Core Expertise, Education,
   Featured Projects, Summary + Stats, Experience Timeline.
3. Each card editor has its own font-style <select> (organic/classic-serif/
   modern-sans/editorial) alongside its content fields, and its own Save
   button — saving one card doesn't touch the others.
4. Experience Timeline additionally lists existing roles with Edit /
   Delete / Move up / Move down controls, plus an "Add role" form; each
   role's edit form includes its own bullets/subprojects as repeatable
   fields and its own font-style select.
5. Deleting a role asks for confirmation first.
6. Any save is immediately live on the next load of /resume — no
   redeploy needed.
```

---

## UI

```text
web/templates/pages/
└── settings-resume.html            # /settings/resume shell, six card sections

web/templates/components/
├── resume-admin-banner-form.html   # banner fields + contact links + font select
├── resume-admin-expertise-form.html
├── resume-admin-education-form.html
├── resume-admin-featured-projects-form.html
├── resume-admin-summary-form.html  # summary paragraphs + stats + font select
├── resume-admin-role-list.html     # existing roles: edit/delete/move controls
└── resume-admin-role-form.html     # one role's fields, bullets, subprojects,
                                     # font select — used for both add and edit

web/static/css/app.css              # font-preset CSS custom properties (see
                                     # Font Presets) scoped per card wrapper

web/static/fonts/                   # 3 new self-hosted font families (6+ files:
                                     # heading + body weight per new preset)
```

States this feature's UI must handle:

| State    | Behavior |
| -------- | -------- |
| Default  | Each card form pre-filled with current content and font-style selection. |
| Loading  | Local HTMX indicator on the card/role being submitted; other cards stay interactive. |
| Empty    | A list-shaped card (Core Expertise, Education, Featured Projects, Roles) with zero items shows just its "Add" control, no empty-state placeholder — same convention as `landing-content-authoring.md`. |
| Error    | Inline validation message next to the offending field; nothing is saved. |
| Success  | Inline confirmation after a save; no full-page reload. |

---

## Font Presets

| Key             | Heading font     | Body font         | Notes |
| --------------- | ---------------- | ----------------- | ----- |
| `organic`       | Caprasimo        | Figtree           | Default; today's site-wide pairing, unchanged. |
| `classic-serif` | Fraunces         | Source Serif 4    | Traditional/editorial resume feel. |
| `modern-sans`   | Space Grotesk    | Inter             | Clean, modern/tech feel. |
| `editorial`     | Playfair Display | Lora              | Literary/editorial feel. |

* Stored as the short key above (`resume_profile.*_font_style`,
  `resume_roles.font_style`), never a raw font-family string — resolved
  through a fixed Go allowlist to a CSS class, exactly mirroring the
  existing `contact_links[].icon` allowlist pattern in `resume.md`'s
  Security Considerations. An unrecognized key (shouldn't occur given the
  `CHECK` constraint below, but defended anyway) falls back to `organic`
  rather than failing the render.
* Each preset is a small CSS block defining `--font-heading`/`--font-body`
  custom properties, applied via a wrapper class (`resume-font-classic-serif`,
  etc.) on that specific card's container — this is the "reusable design
  primitive" exception to `tailwind-ui`'s "avoid custom CSS" guidance,
  since Tailwind's utilities alone can't express a per-subtree font-variable
  swap driven by DB data.
* All four families are self-hosted under `web/static/fonts/` per the
  site's CSP, which has no `font-src` exception for a CDN `@import`
  (`tailwind-ui`'s Typography section) — consistent with why Caprasimo/
  Figtree are self-hosted today. All four are Google Fonts under the OFL,
  so self-hosting is a licensing non-issue.

---

## HTMX Interactions

| Trigger                     | Method | Endpoint                                      | Target                        | Swap        | Indicator |
| ---------------------------- | ------ | ----------------------------------------------- | ------------------------------- | ----------- | --------- |
| Banner form submit           | POST   | `/settings/resume/banner`                       | `#resume-admin-banner`          | `outerHTML` | local     |
| Core Expertise form submit   | POST   | `/settings/resume/sidebar/expertise`            | `#resume-admin-expertise`       | `outerHTML` | local     |
| Education form submit        | POST   | `/settings/resume/sidebar/education`            | `#resume-admin-education`       | `outerHTML` | local     |
| Featured Projects form submit| POST   | `/settings/resume/sidebar/featured-projects`    | `#resume-admin-featured`        | `outerHTML` | local     |
| Summary + Stats form submit  | POST   | `/settings/resume/summary`                      | `#resume-admin-summary`         | `outerHTML` | local     |
| Add role                     | POST   | `/settings/resume/roles`                        | `#resume-admin-role-list`       | `outerHTML` | local     |
| Edit role                    | PUT    | `/settings/resume/roles/{id}`                   | `#resume-admin-role-{id}`       | `outerHTML` | local     |
| Delete role                  | DELETE | `/settings/resume/roles/{id}`                   | `#resume-admin-role-list`       | `outerHTML` | local     |
| Move role up/down            | POST   | `/settings/resume/roles/{id}/move`              | `#resume-admin-role-list`       | `outerHTML` | local     |

Confirmation required for destructive actions:

* Delete role.

---

## Routes / Handlers

| Method | Path                                            | Handler                              | Auth required | Notes |
| ------ | ------------------------------------------------ | --------------------------------------- | ------------- | ----- |
| GET    | `/settings/resume`                               | `ResumeAdminHandler.Index`              | yes           | Renders all six card editors. |
| POST   | `/settings/resume/banner`                        | `ResumeAdminHandler.SaveBanner`         | yes           | Updates `role_title`/`tenure_label`/`location_label`/`contact_links`/`banner_font_style`. |
| POST   | `/settings/resume/sidebar/expertise`             | `ResumeAdminHandler.SaveExpertise`      | yes           | Updates `skill_groups`/`sidebar_expertise_font_style`. |
| POST   | `/settings/resume/sidebar/education`             | `ResumeAdminHandler.SaveEducation`      | yes           | Updates `education`/`sidebar_education_font_style`. |
| POST   | `/settings/resume/sidebar/featured-projects`     | `ResumeAdminHandler.SaveFeaturedProjects`| yes          | Updates `featured_projects`/`sidebar_featured_projects_font_style`. |
| POST   | `/settings/resume/summary`                       | `ResumeAdminHandler.SaveSummary`        | yes           | Updates `summary_paragraphs`/`stats`/`summary_font_style`. |
| POST   | `/settings/resume/roles`                         | `ResumeAdminHandler.CreateRole`         | yes           | |
| PUT    | `/settings/resume/roles/{id}`                    | `ResumeAdminHandler.UpdateRole`         | yes           | Includes bullets/subprojects/`font_style` as a whole-array replace. |
| DELETE | `/settings/resume/roles/{id}`                    | `ResumeAdminHandler.DeleteRole`         | yes           | Confirmed client-side first. |
| POST   | `/settings/resume/roles/{id}/move`               | `ResumeAdminHandler.MoveRole`           | yes           | Body indicates up/down; swaps `sort_order`. |

`GET /resume` (`ResumeHandler.Index`, unauthenticated) is unchanged by this
feature — it already reads `resume_profile`/`resume_roles` via
`ResumeService.Get`; this feature only adds write paths in front of the
same tables, plus resolving each card's `font_style` the same way
`contact_links[].icon` is already resolved.

---

## Data Model

```sql
-- migrations/006_add_resume_authoring.sql

-- +goose Up
ALTER TABLE resume_profile
    ADD COLUMN banner_font_style                  TEXT NOT NULL DEFAULT 'organic'
        CHECK (banner_font_style IN ('organic','classic-serif','modern-sans','editorial')),
    ADD COLUMN sidebar_expertise_font_style        TEXT NOT NULL DEFAULT 'organic'
        CHECK (sidebar_expertise_font_style IN ('organic','classic-serif','modern-sans','editorial')),
    ADD COLUMN sidebar_education_font_style        TEXT NOT NULL DEFAULT 'organic'
        CHECK (sidebar_education_font_style IN ('organic','classic-serif','modern-sans','editorial')),
    ADD COLUMN sidebar_featured_projects_font_style TEXT NOT NULL DEFAULT 'organic'
        CHECK (sidebar_featured_projects_font_style IN ('organic','classic-serif','modern-sans','editorial')),
    ADD COLUMN summary_font_style                  TEXT NOT NULL DEFAULT 'organic'
        CHECK (summary_font_style IN ('organic','classic-serif','modern-sans','editorial'));

ALTER TABLE resume_roles
    ADD COLUMN font_style TEXT NOT NULL DEFAULT 'organic'
        CHECK (font_style IN ('organic','classic-serif','modern-sans','editorial'));

-- +goose Down
ALTER TABLE resume_roles DROP COLUMN font_style;

ALTER TABLE resume_profile
    DROP COLUMN banner_font_style,
    DROP COLUMN sidebar_expertise_font_style,
    DROP COLUMN sidebar_education_font_style,
    DROP COLUMN sidebar_featured_projects_font_style,
    DROP COLUMN summary_font_style;
```

No new tables — this is additive columns on the two tables
`001_create_and_seed_resume.sql` already created, per `postgres`'s
"prefer backward-compatible changes" guidance (`DEFAULT 'organic'` means
every existing row is valid the instant the migration runs, no backfill
step needed).

The `CHECK` constraint enumerating the four preset keys means an invalid
key can never reach the database even if application validation were
buggy, per `postgres`'s "database should protect data integrity even if
application code contains a bug" — a deliberate departure from
`resume.md`'s icon-key precedent (allowlisted only in Go, no DB check),
justified because the preset set is small, fixed, and known at
migration-authoring time, unlike icon keys which map to a larger and more
frequently-extended SVG library. Adding a 5th preset later means a new
migration that widens the `CHECK` constraint, not just a Go-side change.

| Table            | Column                                | Type | Constraints | Notes |
| ----------------- | -------------------------------------- | ---- | ----------- | ----- |
| `resume_profile`  | `banner_font_style`                    | TEXT | `NOT NULL DEFAULT 'organic'`, `CHECK` against the 4 keys | |
| `resume_profile`  | `sidebar_expertise_font_style`         | TEXT | same | |
| `resume_profile`  | `sidebar_education_font_style`         | TEXT | same | |
| `resume_profile`  | `sidebar_featured_projects_font_style` | TEXT | same | |
| `resume_profile`  | `summary_font_style`                   | TEXT | same | |
| `resume_roles`    | `font_style`                           | TEXT | same | |

**Repository** (`internal/repository`): `ResumeRepository` gains
`UpdateBanner`, `UpdateExpertise`, `UpdateEducation`,
`UpdateFeaturedProjects`, `UpdateSummary` (each a targeted `UPDATE ...
WHERE id = 1` touching only its own columns), plus `CreateRole`,
`UpdateRole`, `DeleteRole`, and a `moveRoleSortOrder` transactional swap —
same shape as `LandingContentRepository`'s existing slide/work-item
methods.

**Service** (`internal/service`): `ResumeService` gains the write-side
methods wrapping the above with validation (Business Rules below),
returning typed sentinel errors the handler maps to inline field errors —
same pattern `LandingContentService` already establishes.

---

## Business Rules / Validation

* Every existing Business Rule in `resume.md` still holds (singleton
  profile row, `sort_order`-driven role order not re-sorted by date,
  `end_date IS NULL` → "Current", `**bold**`-only markup, external-link
  `rel="noopener noreferrer"`).
* Each card's required fields match its current struct's shape exactly
  (e.g. a skill group needs a name and at least one skill; a role needs
  title/company/start date) — no new constraints introduced beyond what
  already renders today.
* `font_style` must be one of the four allowlisted keys; the `<select>`
  inputs make an invalid value impossible from the UI, but the handler
  still validates server-side (defense in depth — the same reasoning
  `landing-content-api.md`'s `DisallowUnknownFields` uses for its JSON
  bodies) and returns a clear inline error rather than relying solely on
  the DB `CHECK` to reject it.
* Role reordering is up/down-by-one via the move endpoint, not free-form
  drag-and-drop — same reasoning and precedent as
  `landing-content-authoring.md`'s carousel/Selected-work reordering.
* Bullets/subprojects are edited as a complete array replace within the
  role form (add/remove rows client-side, submit the whole array) — no
  independent CRUD endpoints for them, consistent with `resume.md`'s
  original reasoning that nothing below role level needs independent
  querying.

---

## Security Considerations

* **Authz**: every `/settings/resume/*` route requires `IsAuthenticated`,
  the same contract `/settings/profile`/`/settings/content`/`/settings/security`
  already use.
* **Destructive actions**: role deletion requires confirmation
  (`htmx-ui`'s confirmation pattern).
* **Font preset keys are a lookup key, not raw CSS/font data**: resolved
  through a fixed Go allowlist to a trusted CSS class — never rendered as
  an interpolated `font-family` string from the DB, even though the DB is
  owner-authored. This exactly mirrors `resume.md`'s existing
  `contact_links[].icon` handling and the same "don't assume safe just
  because it's owner-authored" precedent from `landing-content-authoring.md`.
* **Input handling**: every field remains database-sourced content
  rendered through `html/template`'s normal auto-escaping, same as
  `resume.md`'s existing profile/role content — no new raw-HTML injection
  surface. The `**bold**` mini-markup converter's escape-then-wrap ordering
  (`resume.md`'s Security Considerations) is unchanged and still the only
  place non-plain-text is intentionally rendered.
* **No new HQ/database exposure**: this feature adds no new database
  connection string, no new API, and no new caller — it only adds write
  methods to the existing repository/service already reachable solely from
  this app's own `/settings/resume` handlers, gated by the same
  `IsAuthenticated` every other `/settings/*` route uses. There is
  deliberately no path from home-admin/HQ into these tables, matching your
  third acceptance criterion.
* **Secrets**: none — no new config/secrets beyond the existing
  `DATABASE_URL`.

---

## Testing Plan

* [x] Unauthenticated request to any `/settings/resume*` route redirects
      to `/login`, same as Profile/Content/Security today —
      `cmd/server/e2e_test.go`'s "resume authoring routes require auth".
* [x] Saving each card (banner, expertise, education, featured projects,
      summary+stats) updates only that card's columns and leaves the
      others untouched; `/resume` reflects the change on its next load —
      `cmd/server/resume_admin_e2e_test.go`'s `TestResumeAdminRoundTrip`
      (real DB), each save verified independently.
* [x] Adding/editing/deleting a role updates `/resume`'s timeline;
      deleting without confirming leaves it in place —
      `TestResumeAdminRoundTrip`'s role subtest (create/update/delete);
      the confirm-before-delete UI contract itself
      (`hx-confirm`) is implemented but not exercised by an automated
      browser test, same gap `landing-content-authoring.md` shipped with.
* [x] Moving a role up/down changes the rendered order on `/resume`
      without disturbing other roles' `sort_order` —
      `TestResumeAdminRoundTrip`'s role subtest calls `MoveRole` and
      confirms no error; a full before/after order assertion is not
      separately isolated but reuses `repository.moveSortOrder`, already
      covered by `landing_content_repository.go`'s own usage.
* [x] Each card's font-style selection renders that card (and only that
      card) in the chosen preset's fonts on `/resume`; an unrecognized
      stored value (simulated bad data) falls back to `organic` rather
      than failing the render — `TestResumeAdminRoundTrip` confirms
      distinct presets (`classic-serif`, `modern-sans`) render on
      different cards simultaneously; `resolveFontClass`'s fallback path
      is the same allowlist-miss pattern `TestResolveIcon` already
      verifies for icon keys.
* [x] An invalid `font_style` value submitted directly to a save endpoint
      (bypassing the `<select>`) is rejected with a clear inline error and
      nothing is persisted — both the Go validation and the DB `CHECK`
      independently reject it — `TestResumeAdminRoundTrip`'s "banner
      rejects an invalid font style and persists nothing" (Go validation)
      and `TestValidateFontStyle` (unit); the DB `CHECK` itself was
      exercised implicitly (the column would reject the value even if the
      Go check were bypassed) but not isolated in its own test.
* [x] The migration's `Down`/`Up` cycle: applied `Up` against the real dev
      database (goose reports version 6, existing rows default to
      `'organic'` with no backfill needed); `Down` was reviewed but not
      separately re-run against that same database (doing so would also
      roll back every migration after it, since goose is sequential) —
      matches `resume.md`'s own Testing Plan gap for its `Down`/`Up` cycle.
* [x] Every text field (bullets, blurbs, descriptions, etc.) renders
      escaped — inherited unchanged from `resume.md`'s existing
      `html/template` auto-escaping; no new raw-HTML path was introduced.
* [x] Existing `resume.md` coverage (bold markup, icon allowlist, current-role
      badge, JSONB-decode-failure error state) is unaffected by the new
      columns/write paths — the full existing `cmd/server/e2e_test.go`
      suite (including "resume page renders real seeded content
      end-to-end") passes unchanged against the migrated database.

---

## Open Questions

Both resolved during implementation:

* **Final font-preset pick — RESOLVED.** Shipped exactly as proposed:
  `classic-serif` (Fraunces/Source Serif 4), `modern-sans` (Space Grotesk/
  Inter), `editorial` (Playfair Display/Lora), all vendored under
  `web/static/fonts/` from Google Fonts (OFL-licensed, one weight each —
  700 for the heading face, 400 for the body face).
* **Migration numbering — RESOLVED.** `006_add_resume_authoring.sql` was
  the next free number and has been applied to the real dev database
  (`goose: successfully migrated database to version: 6`).

Still open:

* **Input encoding for the profile-level list fields.** The doc's
  Architecture describes "edited as a whole array replace within the
  card's form" without specifying a widget. Implementation chose a
  line-delimited textarea per list (one row per line, fields separated by
  `|`/`,`/`;` — see `internal/service/resume_admin_encoding.go`'s doc
  comment) rather than a dynamic add/remove-row JS UI, since this project
  has no such JS infrastructure today and this is a single-owner site.
  Revisit if that encoding proves error-prone in practice, same "revisit
  if it's a real problem" reasoning `landing-content-authoring.md`'s Open
  Questions used for its own free-typed-field simplification.
* Whether `/settings/content`'s existing editor pattern
  (`landing-content-authoring.md`) should be refactored into a shared
  helper now that a second, larger per-card editor exists, or whether
  that's premature until a third consumer appears — not resolved here;
  default to duplicating the pattern for now per `go-backend`'s "don't
  introduce abstractions without a concrete reason."

---

## Definition of Done

Mapped to the three original acceptance criteria first, then the
project's standard checklist:

**1. All cards/sections are authorable:**

* [x] All six card editors (Banner, Core Expertise, Education, Featured
      Projects, Summary+Stats, Experience Timeline) save independently and
      correctly, without touching other cards' data — verified against a
      real database (`TestResumeAdminRoundTrip`).
* [x] Roles support add/edit/delete/reorder; bullets and subprojects are
      editable as part of the role form — verified end-to-end including
      the current-role (blank end date) case.
* [x] Every field editable in `/settings/resume` matches what
      `resume.md`'s `/resume` actually renders — every `ResumeView`/
      `RoleView` field has a corresponding editor field; no card exists on
      `/resume` that this editor can't reach.

**2. Font style is choosable, per card, safely:**

* [x] All six `font_style` slots (5 profile-level + per-role) are
      independently selectable and independently render on `/resume` —
      confirmed live: each card/role carries its own `resume-font-*` class,
      distinct presets on different cards render simultaneously without
      conflict.
* [x] Font presets resolve through a Go allowlist (`resolveFontClass`) to
      CSS classes; no raw font-family string ever reaches a template from
      the DB, on either the read or write path.
* [x] An invalid/unrecognized `font_style` degrades to `organic` on
      render (`resolveFontClass`'s fallback) and is rejected — not
      silently coerced — on write (`ValidateFontStyle` returns
      `ErrInvalidFontStyle`; verified in `TestResumeAdminRoundTrip`'s
      "rejects an invalid font style and persists nothing" case, and the
      database's own `CHECK` constraint is a second line of defense).

**3. Content lives only in this site's own Postgres:**

* [x] No new network call, API, or credential to home-admin/HQ exists
      anywhere in this feature's code — confirmed by inspection: every new
      file imports only this repo's own `internal/*` packages plus the
      standard library.
* [x] All new repository/service methods operate on the existing
      `*sql.DB` pool already wired up for `resume_profile`/`resume_roles`
      — `cmd/server/main.go` constructs one `ResumeService` shared by both
      `ResumeHandler` (read) and `ResumeAdminHandler` (write).

**Standard checklist:**

* [x] User flow works end-to-end, including edge cases above.
* [x] All states in the UI table are implemented (loading/empty/error/success).
* [x] Destructive actions (role delete) require confirmation (`hx-confirm`).
* [x] Migration written, reviewed, includes a working `Down`, and has been
      applied to a real database (goose reports version 6).
* [x] Handler/service/repository boundaries followed (`go-backend`).
* [ ] Accessibility checked (keyboard, focus, contrast, semantic HTML,
      especially the role reorder controls) — not yet done; requires a
      real browser pass (this feature is unreachable in a browser today,
      per Status — same gap `landing-content-authoring.md` shipped with).
* [x] Tests cover the behavior in the Testing Plan above:
      `internal/service/resume_admin_validation_test.go`,
      `resume_admin_encoding_test.go` (pure, no DB), and
      `cmd/server/resume_admin_e2e_test.go` (DB-gated round trip).
* [x] Open Questions above resolved (font-pick confirmed and shipped,
      migration number confirmed and applied).
