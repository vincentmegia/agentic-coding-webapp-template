# Feature: Projects Page

## Status

`Shipped` — the page, route, template, and data model are implemented and
visually verified in both light and dark mode, including a fifth card: a
real, playable link into the Fishing Game (`docs/features/fishing-game.md`)
at `/fishing-game`, added via the `Project.External` field (see Data
Model). `e2e/projects.spec.js` covers all five cards, including the Fishing
Game's "Play now" link and its HTMX navigation into the real game — see
Testing Plan. The gap: the other four cards are still the pulled-in
design's own placeholder sample projects (Fieldnotes, Tidewatch, Loom UI,
Nightlight), not Vincent's real work, and none of them set `LiveURL` or
`ImagePath` yet — see Open Questions. `internal/handler/template_test.go`'s
Go-side placeholder-route test still doesn't exercise the real
`projects-content` template directly (see Testing Plan), mirroring
`docs/features/landing-carousel.md`'s same gap for its own hand-authored
placeholder content.

## Summary

The `/projects` page: a page heading and subhead, followed by a responsive
grid of project cards (screenshot/placeholder tile, title, description, tag
pills, an optional "Live demo" or "Play now" link depending on `External`).
Linked from the primary nav
(`internal/handler/nav.go`'s `primaryNavItems`) and from the Resume page's
"See all projects" sidebar link (`docs/features/resume.md`).

## Problem / Motivation

`/projects` previously rendered only the shared shell's generic placeholder
("Projects content coming soon."). Projects is one of CLAUDE.md's named
Planned Content sections, and `docs/features/resume.md`'s sidebar already
links out to it as "See all projects" — without real content that link led
to an empty placeholder. This feature gives the page an actual card grid,
even though the cards themselves are still sample data pending real project
write-ups.

## Scope

**In scope:**

* `GET /projects` rendering a page heading, subhead, and a grid of project
  cards.
* A `Project` data shape (title, description, tags, tag tint, optional live
  URL, an `External` flag distinguishing an internal route from an off-site
  link, and optional image) and a hardcoded list of five entries: one real
  (the Fishing Game) leading four placeholder samples.
* Responsive card grid: 1 column on mobile, 2 on `sm`, 3 on `lg`.
* Per-card: an image area (real screenshot if `ImagePath` is set, otherwise
  a "Screenshot coming soon" placeholder tile), title, description, tag
  pills (tinted `primary` or `accent` per card), and a conditional link that
  branches on `External` — an off-site "Live demo" link (`External: true`)
  or a same-tab "Play now" internal HTMX nav link (`External: false`) — see
  Business Rules.
* Wiring the route into the shared shell/nav (`NavActive`, `PrimaryNav`
  active-state highlighting).

**Out of scope:**

* Real project content — copy, screenshots, and live links for Vincent's
  actual projects still need to replace the four sample cards (see Open
  Questions).
* Postgres-backed / admin-editable project data — same as
  `docs/features/landing-carousel.md`'s Data Model stance, this is static,
  hand-authored Go data for now.
* Filtering, sorting, tagging/search, or pagination — a flat grid of
  whatever's in `projectItems`.
* A project detail page (per-project route) — each card links out directly
  via `LiveURL`, there's no `/projects/{slug}`.
* Resume's own "Featured Projects" sidebar card and its data — that's a
  separate, resume-owned list (`resume_profile.featured_projects`); this
  page's `Project` list is unrelated data, per Resume's Open Questions on
  whether those two should eventually be reconciled.

---

## User Flow

```text
1. User navigates to /projects (via the primary nav "Projects" link, the
   Resume sidebar's "See all projects" link, or a direct URL).
2. Page renders: a "Projects" heading and subhead, then a grid of five
   cards — the real Fishing Game entry first, followed by four hardcoded
   placeholder Project entries.
3. Each card shows a placeholder "Screenshot coming soon" tile (no card
   currently has ImagePath set, including the Fishing Game's), a title, a
   description, and its tag pills.
4. The Fishing Game card is the only one with LiveURL set, and it's
   internal (External: false), so it renders a "Play now" link rather than
   a "Live demo" link; the four placeholder cards have no LiveURL, so none
   of them render any link — a "Live demo" link activates automatically
   once a placeholder card sets LiveURL with External: true.
5. Clicking "Play now" navigates to /fishing-game via the same HTMX swap
   every other in-site nav link uses (hx-get/hx-target="#main-content"/
   hx-swap="outerHTML"/hx-push-url="true"), dropping the visitor straight
   into the real, playable game (docs/features/fishing-game.md) — not an
   external link or a new tab.
```

---

## Visual Direction

Pulled from the same claude.ai/design "Personal website and portfolio"
project (`Projects.dc.html`, project id
`47e69f22-c9ba-4490-a57e-80aa2b45cc38`) that supplied the site's flat
header/nav (`internal/handler/nav.go`'s `primaryNavItems` doc comment) and
the landing page's hero/"Selected work" section
(`docs/features/landing-page.md`'s Scope). The underlying color/radius/font
tokens are a *separate* design-system project, "Organic"
(`docs/skills/tailwind-ui/SKILL.md`'s Visual Style section) — "Organic" is
the token system every page draws from; "Personal website and portfolio" is
the page-layout mockup this specific grid was pulled from. Don't conflate
the two.

* **Card grid**: `#projects-grid`, 1 column on mobile, 2 on `sm`, 3 on
  `lg`, `gap-6` — the same responsive-grid pattern as the landing page's
  carousel/selected-work sections, per `tailwind-ui`'s Spacing guidance.
* **Card surface**: `.project-card`, `rounded-card bg-surface`, matching the
  card radius/surface tokens used everywhere else in the shell (resume
  cards, sidebar cards) rather than a one-off value.
* **Image area**: fixed `aspect-[16/10]` tile so cards don't jump height
  between projects with and without a screenshot; `object-cover` on a real
  `<img>` when `ImagePath` is set, otherwise a centered "Screenshot coming
  soon" placeholder in muted text against `bg-surface-2`.
* **Tag pills**: small rounded-full chips, alternating tint per card via
  `TagTint` — `primary` cards use `bg-primary/10 text-primary`, `accent`
  cards use `bg-accent/15 text-accent`. The mockup alternates tint by card
  rather than deriving it from tag content, so this is authored data, not a
  template-computed value (see `Project`'s doc comment in
  `internal/handler/template.go`).
* **Card link**: only rendered when `LiveURL` is set, and branches on
  `External`:

  | `External` | Label | Behavior |
  | --- | --- | --- |
  | `true` | "Live demo" | `target="_blank" rel="noopener noreferrer"`, inline external-link icon, `text-primary` — the original design's only case, still the default for the four placeholder cards (though none of them set `LiveURL`, so it's currently unexercised). |
  | `false` (default/zero value) | "Play now" | `hx-get="{{.LiveURL}}" hx-target="#main-content" hx-swap="outerHTML" hx-push-url="true" hx-indicator="#nav-loading" data-nav-link`, same tab, same swap mechanism `#primary-nav`'s links already use (`components/header.html`), `text-primary`, with a play-triangle icon instead of the external-link icon — the Fishing Game card's case, the only entry currently exercising this branch. |

---

## UI

```text
web/templates/pages/
└── projects.html              # {{define "projects-content"}} (see Template
                                # Rendering below); page heading/subhead +
                                # #projects-grid of .project-card <article>s
```

No separate component file — the grid and card markup live inline in
`projects.html` rather than a `components/project-card.html` partial, since
there's exactly one place it's used and no HTMX swap target that would need
to re-render a single card independently (`htmx-ui`'s "avoid excessively
small components" guidance, the same call `docs/features/resume.md` made
for `resume-sidebar.html`).

States this feature's UI must handle:

| State                          | Behavior |
| -------------------------------- | -------- |
| Default                          | Grid renders all entries in `projectItems`. |
| Card with no `ImagePath`          | Renders the "Screenshot coming soon" placeholder tile instead of an `<img>`. |
| Card with no `LiveURL`            | Omits the "Live demo"/"Play now" link entirely — no disabled/greyed-out link. |
| Loading                          | Nav swap into `/projects` uses the shell's existing `#nav-loading` indicator — no new indicator needed. |
| Empty (`projectItems` has zero entries) | Not currently exercised — `projectItems` always has 5 hardcoded entries; the template's `{{range}}` would simply render nothing, no empty-state message. |
| Error                            | A render failure falls through to the shell's generic "couldn't load this page" content-error state, same as every other route — nothing project-specific. |

---

## Template Rendering

Same mechanism `docs/features/resume.md`'s Template Rendering section
introduced: `PagesHandler.Projects` sets `PageData.ContentTemplate =
"projects-content"` rather than leaving it empty (which would default to
the shared placeholder `"content"`). `projects.html` defines
`{{define "projects-content"}}`, not `{{define "content"}}`, so it doesn't
collide with the shared placeholder still used by `/blogs` and
`/settings/*`. `projects.html` is added to `LoadTemplates`'s explicit file
list (`internal/handler/template.go`) — a manual step, since that list
isn't a directory glob.

`projects-content` owns its own `<main id="main-content" class="mx-auto
max-w-5xl px-4 py-8">` wrapper, the same load-bearing contract every content
template must satisfy because `hx-swap="outerHTML"` replaces the entire
`#main-content` element on an HTMX nav swap — see `resume.html`'s doc
comment and `docs/features/home.md`'s HTMX Interactions section for the
full explanation of why this isn't optional.

---

## HTMX Interactions

None owned by this feature beyond the existing `/projects` nav row already
specified in `docs/features/home.md`'s HTMX Interactions table (`GET
/projects` → `#main-content`, `outerHTML`, `hx-push-url="true"`) and
`docs/features/resume.md`'s "See all projects" sidebar link, which targets
the same route.

Confirmation required for destructive actions:

* None — this feature has no destructive actions.

---

## Routes / Handlers

| Method | Path         | Handler                | Auth required | Notes |
| ------ | ------------- | ------------------------ | ------------- | ----- |
| GET    | `/projects`   | `PagesHandler.Projects`  | no            | Registered in `cmd/server/main.go`'s `newMux`. Sets `ContentTemplate: "projects-content"`, `NavActive: "/projects"`, `Projects: projectItems`. |

---

## Data Model

None — no database table. `projectItems` (`internal/handler/pages.go`) is a
hardcoded `[]Project` package var, the same "static, hand-authored in Go, no
DB, no admin editing yet" pattern `docs/features/landing-carousel.md` uses
for its carousel slides. See Open Questions for whether this moves to
Postgres later, following the same path `docs/features/resume.md` took.

```go
// internal/handler/template.go
type Project struct {
	Title       string
	Description string
	Tags        []string
	TagTint     string // "primary" or "accent" — which token-tinted pill
	                    // style the tag chips use
	LiveURL     string // optional, "" if none — omits the link entirely
	                    // when empty
	External    bool   // true if LiveURL is off-site (rendered "Live demo",
	                    // new tab); false (default) means an internal route
	                    // (rendered "Play now", same-tab HTMX nav swap) —
	                    // mirrors CarouselSlide's own field, below
	ImagePath   string // optional, "" renders a placeholder tile instead of
	                    // a screenshot
}
```

The five current entries (`internal/handler/pages.go`'s `projectItems`):
Fishing Game leads the list — the one real entry, `LiveURL: "/fishing-game"`,
`External: false` (so it renders the "Play now" link), tags `Go`/`Canvas`/
`PostgreSQL`, `TagTint: "accent"` — followed by Fieldnotes, Tidewatch, Loom
UI, Nightlight, the pulled-in design mockup's own sample projects, matching
the same three names (minus Nightlight, Projects' fourth card) used as the
landing page's "Selected work" section placeholders (`SelectedWorkItem`,
`docs/features/landing-page.md`). None of the four placeholder entries set
`LiveURL` or `ImagePath`; the Fishing Game entry sets `LiveURL` but not
`ImagePath` either (see Open Questions).

---

## Business Rules / Validation

* `ImagePath` empty → the card renders a "Screenshot coming soon" placeholder
  tile instead of an `<img>`; no broken-image icon risk since there's never
  an `<img src="">`.
* `LiveURL` empty → the card's link is omitted entirely, not rendered
  disabled or greyed out.
* `LiveURL` set and `External: true` → the link reads "Live demo", opens in
  a new tab with `rel="noopener noreferrer"`, and shows an external-link
  icon, consistent with the external-link convention established in
  `docs/features/home.md` — the original design's only case; none of the
  four placeholder cards currently set `LiveURL`, so this branch is
  currently unexercised.
* `LiveURL` set and `External: false` (the default/zero value) → the link
  reads "Play now", stays in the same tab, and uses the same HTMX swap
  every `#primary-nav` link uses (`hx-get`/`hx-target="#main-content"`/
  `hx-swap="outerHTML"`/`hx-push-url="true"`/`data-nav-link`,
  `components/header.html`), with a play-triangle icon instead of the
  external-link icon — the Fishing Game card's case
  (`LiveURL: "/fishing-game"`), the only entry currently exercising this
  branch.
* `External` mirrors `CarouselSlide`'s own field (`internal/handler/
  template.go`) — same name, same true/off-site vs. false/internal-route
  meaning, so the two link-shaped fields on this site stay consistent with
  each other.
* `TagTint` is authored per card (`"primary"` or `"accent"`), not derived
  from tag content or alternated by template logic — matching the pulled-in
  design's own per-card alternation.
* `Tags` empty → the tag-pill row is omitted for that card (the template
  guards on `{{if .Tags}}`), rather than rendering an empty row.

---

## Security Considerations

* **No dynamic/untrusted input**: `projectItems` is hand-authored Go source,
  not user- or database-sourced, so there's no escaping concern beyond what
  `html/template` already provides by default for any Go value passed into
  a template — same posture as `docs/features/landing-carousel.md`'s
  Security Considerations for its slide data. This changes if project data
  ever moves to Postgres (see Open Questions), at which point it needs the
  same auto-escaping treatment as any other DB-sourced content.
* **External links**: `LiveURL` links use `rel="noopener noreferrer"` when
  opened in a new tab, per `docs/features/home.md`'s established pattern.
* **Authz**: `/projects` is unauthenticated, matching every other content
  route except `/settings/*` — no new auth surface introduced.

---

## Testing Plan

* [x] `GET /projects` renders all five cards with correct titles,
      descriptions, and tag pills — `e2e/projects.spec.js`'s `PROJECTS`
      fixture includes the Fishing Game alongside the four placeholders, and
      `cards.toHaveCount(PROJECTS.length)` asserts the real 5-card grid.
* [ ] A card with `ImagePath` set renders a real `<img>`; a card without it
      renders the "Screenshot coming soon" placeholder tile — covered for the
      no-`ImagePath` case (still true of all five cards today, Fishing Game
      included); the real-`<img>` branch remains untested since no card sets
      `ImagePath` yet.
* [x] A card with `LiveURL` set and `External: true` renders a "Live demo"
      link that opens in a new tab with `rel="noopener noreferrer"`; a card
      without `LiveURL` renders no such link — `e2e/projects.spec.js` asserts
      zero "Live demo" links exist (still true, since none of the five
      current entries set `External: true`) and separately asserts the
      Fishing Game card specifically has no "Live demo" link.
* [x] A card with `LiveURL` set and `External: false` (the Fishing Game)
      renders a "Play now" link that navigates to `/fishing-game` via the
      same HTMX swap `#primary-nav` uses, not a full page reload —
      `e2e/projects.spec.js` covers this directly: the link is visible on the
      Fishing Game card, clicking it lands on `/fishing-game` with the real
      game shell (`#fishing-canvas`, `#fishing-start-screen`) rendered, and
      `#main-content`'s wrapper classes survive that swap.
* [x] `#main-content`'s wrapper/classes survive an HTMX nav swap into
      `/projects` (not just a direct page load) — same regression class
      `docs/features/home.md`'s Testing Plan already covers for `/resume`
      and the placeholder routes; `e2e/projects.spec.js`'s "container
      survives an HTMX nav swap" block covers it here too (clicking
      "Projects" from the header). `TestRenderPlaceholderRoutesUnaffected`
      in `internal/handler/template_test.go` still only exercises the
      generic placeholder content, not `projects-content` — the Go-side gap
      remains, the Playwright-side one doesn't.
* [x] "Projects" is marked active (`aria-current="page"`) in the primary nav
      while on `/projects` — and, separately, that navigating on to
      `/fishing-game` via "Play now" correctly *clears* `aria-current` from
      all of Home/Projects/About (since none of them match that route),
      exercising `web/static/js/nav-menu.js`'s `updateActiveNavLinks()` for
      a destination outside the primary nav, not just between primary-nav
      pages.
* [ ] The Resume page's "See all projects" link navigates to `/projects` via
      HTMX, not a full reload — already covered by `e2e/resume.spec.js`.
* [ ] Grid layout (1/2/3 columns) holds correctly across mobile, tablet, and
      desktop breakpoints, including WebKit, per `docs/features/home.md`'s
      precedent of Safari-specific layout bugs — not automated, visual
      verification only so far.
* [ ] Dark mode: card surfaces, placeholder tile, tag pill tints, and the
      "Live demo"/"Play now" link colors and icons all render correctly —
      visually verified once already (including the Fishing Game card and
      its "Play now" link), no automated dark-mode-specific test yet.

---

## Open Questions

* Real project content — actual copy, screenshots (`ImagePath`), and live
  links (`LiveURL`) still need to replace the four sample cards
  (Fieldnotes/Tidewatch/Loom UI/Nightlight) before this page represents
  Vincent's real work rather than the design mockup's placeholder data.
* Should `projectItems` move to Postgres, following the same path
  `docs/features/resume.md` took for resume content, once there's a
  concrete reason (e.g. an admin/CMS UI, or wanting to edit project content
  without a redeploy)? Out of scope for now — revisit once that need is
  concrete, per `docs/features/landing-carousel.md`'s Open Questions taking
  the same stance for carousel slides.
* Whether `resume_profile.featured_projects` (Resume's own small "featured
  projects" list) should eventually be reconciled with this page's
  `Project` list into one shared, "featured"-flagged data source instead of
  two independently hand-authored lists — flagged but not decided in
  `docs/features/resume.md`'s Open Questions; still undecided here too.
* A real screenshot for the Fishing Game card's thumbnail —
  `web/static/images/fishing/` has only individual sprite assets today
  (fish, hazards, diver), nothing composed enough to use as-is, so the card
  falls back to the "Screenshot coming soon" placeholder tile like the
  other four.
* Now that one *real* project (the Fishing Game) exists on this page,
  should the four fictional placeholder cards (Fieldnotes/Tidewatch/Loom
  UI/Nightlight) stay until real replacements are written, or should some
  be trimmed/hidden so the page doesn't read as mostly fake work sitting
  next to the one genuine entry? Left to product judgment, not decided
  here.

---

## Definition of Done

* [x] User flow works end-to-end, including the no-`ImagePath`/no-`LiveURL`
      edge cases above.
* [x] All states in the UI table are implemented.
* [x] Handler/service/repository boundaries followed (`go-backend`) — no
      repository/service layer needed since there's no database involved.
* [x] Accessibility checked incidentally (semantic `<article>`/`<h3>`
      structure, focus-visible styling on the "Live demo"/"Play now" links)
      alongside visual verification; no dedicated contrast/screen-reader pass
      done yet.
* [ ] Tests cover the behavior in the Testing Plan above — several items
      remain unchecked; tracked there rather than silently dropped.
* [ ] No open questions remain unresolved — five remain, explicitly deferred
      (real content, Postgres migration, Resume-list reconciliation, a real
      Fishing Game screenshot, and whether to trim the placeholder cards)
      rather than blocking this page's initial ship.
