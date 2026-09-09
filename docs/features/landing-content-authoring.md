# Feature: Landing Page Content Authoring

## Status

`In Progress` — implemented (migration, repository/service/handler layers,
`/settings/content` templates, unit tests for the validation functions,
end-to-end coverage for the new routes) but not yet reachable in
production, since it sits behind the same `IsAuthenticated` stub as
`/settings/profile`/`/settings/security` (see Open Questions' resolved
auth-dependency question). Not yet verified against a real Postgres
instance running the new migration, or exercised through a browser.

## Summary

Lets the authenticated site owner edit the landing page's hero copy (the
"Software Engineer" eyebrow, headline, and subhead), the image carousel's
slides, and the "Selected work" cards directly from the site — through a
new auth-gated `/settings/content` page — instead of editing Go source and
redeploying to change any of it.

## Problem / Motivation

All three sections are currently either a Go `var` literal or inline
template text, edited only by changing code and shipping a deploy:

* The hero's eyebrow ("Software Engineer") is a hardcoded string in
  `web/templates/pages/landing.html`; its headline/subhead are the
  `ContentTitle`/`ContentMessage` strings set in `PagesHandler.Home`
  (`internal/handler/pages.go`).
* The carousel's slides are the `landingCarouselSlides` var (`pages.go`) —
  `docs/features/landing-carousel.md`'s Data Model already flags this as
  "static, hand-authored in Go — no DB, no admin editing yet."
* The "Selected work" cards are the `selectedWorkItems` var (`pages.go`).

For a single-owner personal site this has been fine while the content
itself was still being designed, but changing a headline, swapping a
carousel caption, or reordering a Selected work card is routine copy
editing that shouldn't require a code change, a commit, and a redeploy.
This feature moves that content into Postgres — the same move
`docs/features/resume.md` made for résumé content — and gives the owner a
form-based editor to change it live.

## Scope

**In scope:**

* Postgres-backed storage for all three sections: hero content (a
  singleton row — eyebrow, title, message), carousel slides (an ordered
  list, capped at 5 per `landing-carousel.md`), and Selected work cards
  (an ordered list).
* A new auth-gated `/settings/content` page, reachable from `settingsMenu`
  (`internal/handler/nav.go`) alongside Profile/Security, under the same
  `IsAuthenticated` contract `docs/features/home.md` already defines.
* Forms to edit the hero fields, and to add/edit/delete/reorder carousel
  slides and Selected work cards.
* `PagesHandler.Home` reads all three from Postgres instead of the
  hardcoded vars/template text.
* A migration that seeds today's hand-authored copy verbatim, so shipping
  this changes nothing visually until the owner actually edits something.
* Validation matching each field's existing constraints (carousel capped
  at 5 slides, alt text required, etc. — see Business Rules).

**Out of scope:**

* **Image upload/storage.** A slide continues to reference an image by
  path/URL (an already-existing static asset under `web/static/images/` or
  an external URL) — no upload widget, no image processing, no new asset
  pipeline. This project has no image asset/generation tooling today
  (CLAUDE.md), and adding one is a much bigger feature than content
  authoring.
* **Real authentication.** `internal/handler/auth_stub.go`'s
  `IsAuthenticated` always returns `false` today — the actual
  session/login feature is separate and not yet built. This feature's
  routes are written against that contract but are unreachable (redirect
  to `/login`) until real auth ships, exactly like `/settings/profile` and
  `/settings/security` today. See Open Questions.
* **`/projects`' own `projectItems`.** Stays hand-authored Go data for
  now, kept manually in sync with Selected work the way it is today (see
  `SelectedWorkItem`'s doc comment in `pages.go`). See Open Questions for
  whether these should eventually share one table.
* **Rich text / Markdown / WYSIWYG.** Plain text fields only, same
  convention `resume.md` uses.
* **Revision history / undo.** One current row (hero) or ordered list
  (carousel, Selected work) per section — no audit log, no drafts.
* Header/nav copy, footer content, and the About/Blogs placeholder pages —
  untouched by this feature.

---

## User Flow

```text
1. Owner logs in (once real auth exists) and opens Settings → Content, a
   new entry alongside Profile/Security.
2. /settings/content renders three sections in order: Hero, Carousel,
   Selected work.
3. Hero: a form with Eyebrow/Title/Message fields and a Save button.
   Submitting saves the singleton row and re-renders the form with a
   success indicator; the change is immediately live on the next load of
   `/`.
4. Carousel: a list of existing slides (thumbnail, alt text, caption,
   link) each with Edit / Delete / Move up / Move down controls, plus an
   "Add slide" form that disables itself once 5 slides already exist.
5. Selected work: the same list/edit/delete/reorder pattern, for cards
   (kicker, title, description, live URL).
6. Deleting a slide or card asks for confirmation first.
7. Any change is reflected on the next load of `/` — no redeploy needed.
```

---

## UI

```text
web/templates/pages/
└── settings-content.html          # /settings/content page shell, three sections

web/templates/components/
├── content-hero-form.html         # Hero section: eyebrow/title/message form
├── content-carousel-editor.html   # Carousel: slide list + add-slide form
└── content-work-editor.html       # Selected work: card list + add-card form
```

States this feature's UI must handle:

| State    | Behavior |
| -------- | -------- |
| Default  | Hero form pre-filled with current values; carousel/Selected work show their current ordered list. |
| Loading  | Local HTMX indicator on the form/row being submitted; rest of the page stays interactive. |
| Empty    | Carousel/Selected work with zero items shows just the "Add" form, no empty-state placeholder needed since they can't render fewer than 0 rows. |
| Error    | Inline validation message next to the offending field (e.g. missing alt text, 6th slide rejected); nothing is saved. |
| Success  | Inline confirmation after a save; no full-page reload. |

---

## HTMX Interactions

| Trigger                         | Method | Endpoint                                  | Target                    | Swap        | Indicator |
| -------------------------------- | ------ | ------------------------------------------ | -------------------------- | ----------- | --------- |
| Hero form submit                 | POST   | `/settings/content/hero`                   | `#hero-editor-form`        | `outerHTML` | local     |
| Add carousel slide               | POST   | `/settings/content/carousel`               | `#carousel-editor`         | `outerHTML` | local     |
| Edit carousel slide               | PUT    | `/settings/content/carousel/{id}`          | `#carousel-slide-{id}`     | `outerHTML` | local     |
| Delete carousel slide             | DELETE | `/settings/content/carousel/{id}`          | `#carousel-editor`         | `outerHTML` | local     |
| Move carousel slide up/down       | POST   | `/settings/content/carousel/{id}/move`     | `#carousel-editor`         | `outerHTML` | local     |
| Add Selected work card            | POST   | `/settings/content/selected-work`          | `#work-editor`             | `outerHTML` | local     |
| Edit Selected work card           | PUT    | `/settings/content/selected-work/{id}`     | `#work-item-{id}`          | `outerHTML` | local     |
| Delete Selected work card         | DELETE | `/settings/content/selected-work/{id}`     | `#work-editor`             | `outerHTML` | local     |
| Move Selected work card up/down   | POST   | `/settings/content/selected-work/{id}/move`| `#work-editor`             | `outerHTML` | local     |

Confirmation required for destructive actions:

* Delete carousel slide.
* Delete Selected work card.

---

## Routes / Handlers

| Method | Path                                          | Handler                          | Auth required | Notes |
| ------ | ---------------------------------------------- | ---------------------------------- | ------------- | ----- |
| GET    | `/settings/content`                            | `ContentHandler.Index`             | yes           | Renders all three sections. |
| POST   | `/settings/content/hero`                       | `ContentHandler.SaveHero`          | yes           | Upserts the singleton row. |
| POST   | `/settings/content/carousel`                   | `ContentHandler.CreateSlide`       | yes           | Rejects a 6th slide. |
| PUT    | `/settings/content/carousel/{id}`              | `ContentHandler.UpdateSlide`       | yes           | |
| DELETE | `/settings/content/carousel/{id}`              | `ContentHandler.DeleteSlide`       | yes           | Confirmed client-side first. |
| POST   | `/settings/content/carousel/{id}/move`         | `ContentHandler.MoveSlide`         | yes           | Body indicates up/down. |
| POST   | `/settings/content/selected-work`              | `ContentHandler.CreateWorkItem`    | yes           | |
| PUT    | `/settings/content/selected-work/{id}`         | `ContentHandler.UpdateWorkItem`    | yes           | |
| DELETE | `/settings/content/selected-work/{id}`         | `ContentHandler.DeleteWorkItem`    | yes           | Confirmed client-side first. |
| POST   | `/settings/content/selected-work/{id}/move`    | `ContentHandler.MoveWorkItem`      | yes           | Body indicates up/down. |

---

## Data Model

```sql
-- migrations/005_create_landing_content.sql
-- Schema and a seed of today's hand-authored copy live in one migration,
-- same reasoning as 001_create_and_seed_resume.sql: single-owner site, no
-- per-environment variance, so a second file only adds migration surface.

-- +goose Up
CREATE TABLE landing_hero (
    id         BIGINT PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- singleton row
    eyebrow    TEXT NOT NULL,
    title      TEXT NOT NULL,
    message    TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE landing_carousel_slides (
    id         BIGSERIAL PRIMARY KEY,
    image_path TEXT NOT NULL,
    alt        TEXT NOT NULL,
    caption    TEXT NOT NULL DEFAULT '',
    link_url   TEXT NOT NULL DEFAULT '',
    external   BOOLEAN NOT NULL DEFAULT false,
    sort_order INT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE landing_selected_work_items (
    id          BIGSERIAL PRIMARY KEY,
    kicker      TEXT NOT NULL,
    title       TEXT NOT NULL,
    description TEXT NOT NULL,
    live_url    TEXT NOT NULL DEFAULT '',
    external    BOOLEAN NOT NULL DEFAULT false,
    sort_order  INT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed: today's hand-authored content, verbatim, so the migration is a
-- no-op visually (Software Engineer / "Hi, I'm Vincent Megia." copy from
-- landing.html + pages.go's Home, and the 5 landingCarouselSlides /
-- 3 selectedWorkItems entries from pages.go).

-- +goose Down
DROP TABLE landing_selected_work_items;
DROP TABLE landing_carousel_slides;
DROP TABLE landing_hero;
```

| Table                          | Column        | Type          | Constraints             | Notes |
| -------------------------------- | ------------- | ------------- | -------------------------- | ----- |
| `landing_hero`                   | `eyebrow`     | `TEXT`        | `NOT NULL`                 | e.g. "Software Engineer" |
| `landing_hero`                   | `title`       | `TEXT`        | `NOT NULL`                 | Replaces `ContentTitle` |
| `landing_hero`                   | `message`     | `TEXT`        | `NOT NULL`                 | Replaces `ContentMessage` |
| `landing_carousel_slides`        | `image_path`  | `TEXT`        | `NOT NULL`                 | Existing static asset path or external URL |
| `landing_carousel_slides`        | `alt`         | `TEXT`        | `NOT NULL`                 | Required, per `landing-carousel.md` |
| `landing_carousel_slides`        | `sort_order`  | `INT`         | `NOT NULL`                 | Enforced ≤5 rows in application code, not a DB constraint |
| `landing_selected_work_items`    | `live_url`    | `TEXT`        | `NOT NULL`                 | Internal route or external URL, paired with `external` |
| `landing_selected_work_items`    | `sort_order`  | `INT`         | `NOT NULL`                 | |

---

## Business Rules / Validation

* Carousel is capped at 5 slides (`landing-carousel.md`'s existing cap) —
  `CreateSlide` rejects a 6th with a clear inline error rather than
  silently dropping it.
* Every carousel slide requires `image_path` and `alt`; `caption` and
  `link_url` stay optional, `external` only meaningful alongside a
  `link_url` — same shape as today's `CarouselSlide` struct.
* Every Selected work card requires `kicker`, `title`, `description`, and
  `live_url`.
* Hero's `eyebrow`/`title`/`message` are all required; no arbitrary length
  cap beyond `TEXT`, matching `resume.md`'s precedent of not imposing one.
* Reordering is up/down-by-one via the move endpoints, not free-form
  drag-and-drop — keeps the interaction and the `sort_order` update
  simple for a list capped at 5 (carousel) or a handful of cards
  (Selected work).

---

## Security Considerations

* **Authz**: every `/settings/content/*` route requires
  `IsAuthenticated`, the same contract `/settings/profile` and
  `/settings/security` already use — single-owner site, no per-field
  permission model needed.
* **Destructive actions**: slide/card deletion requires confirmation
  (`docs/skills/htmx-ui/SKILL.md`'s confirmation pattern).
* **Input handling**: unlike `nav.go`'s hardcoded `template.HTML` icons,
  every field here is now database-sourced and must render through
  `html/template`'s normal auto-escaping — never `template.HTML`. No new
  raw-HTML injection surface is introduced.
* **Secrets**: none — no new config/secrets beyond the existing
  `DATABASE_URL`.

---

## Testing Plan

* [ ] Unauthenticated request to any `/settings/content*` route redirects
      to `/login`, same as Profile/Security today.
* [ ] Saving the hero form updates the singleton row, and `/` reflects the
      new eyebrow/title/message on its next load.
* [ ] Adding slides up to 5 succeeds; a 6th attempt is rejected with a
      clear inline error and nothing is persisted.
* [ ] Deleting a slide/card without confirming leaves it in place;
      confirming removes it and `/` stops rendering it.
* [ ] Reordering (move up/down) changes the rendered order on `/`.
* [ ] The seed migration leaves `/` visually unchanged immediately after
      this ships — no accidental copy drift versus today's hand-authored
      vars.
* [ ] Every field (caption, description, etc.) renders escaped — a value
      containing `<script>` or similar is not executed.

---

## Open Questions

All three resolved for this implementation:

* **Auth dependency**: resolved as **wait** — no interim auth mechanism
  was built. `/settings/content` is implemented and gated by the same
  `IsAuthenticated` stub as `/settings/profile`/`/settings/security`
  (`requireOwnerAuth`), so it is unreachable in production until the real
  authentication feature lands, exactly like those two routes today.
* **Selected work vs. `/projects`**: resolved as **landing-page-only for
  v1** — `landing_selected_work_items` backs only the landing page's
  teaser; `/projects`' `projectItems` stays separately hand-authored Go
  data, unchanged by this feature.
* **Image picking**: resolved as a **free-typed text field** — the
  carousel/Selected-work editors take a plain `image_path`/`live_url`
  text input, no dropdown of existing static assets. Revisit if typo'd
  paths turn out to be a real problem in practice.

---

## Definition of Done

* [x] User flow implemented end-to-end in code, including the 5-slide cap
      and delete confirmations above — not yet click-tested in a browser
      (see Status).
* [x] All states in the UI table are implemented (loading/empty/error/success).
* [x] Destructive actions (slide/card delete) require confirmation
      (`hx-confirm`).
* [x] Migration written and includes a working `Down`; seeds today's copy
      verbatim — not yet applied against a real Postgres instance (see
      Status).
* [x] Handler/service/repository boundaries followed (`go-backend`).
* [ ] Accessibility checked (keyboard, focus, contrast, semantic HTML,
      especially the reorder controls) — pending a real browser pass.
* [x] Unit tests cover `ValidateHeroInput`/`ValidateCarouselSlideInput`/
      `ValidateWorkItemInput`; `cmd/server/e2e_test.go` covers the auth
      redirect and the seeded content round-tripping onto `/` — not yet
      run against a live database (DB-gated, skipped without
      `DATABASE_URL`).
* [x] Open Questions above are resolved.
