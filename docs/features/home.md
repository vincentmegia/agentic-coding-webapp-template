# Feature: Site Layout (Header, Footer, Dynamic Content)

## Status

`Proposed` — the header nav was later redesigned (see the note under
Scope): the original "Home ▾" dropdown described throughout this doc's
User Flow/HTMX Interactions/UI sections below was replaced by a flat
Home/Projects/About link row plus a Résumé button, pulled from a
claude.ai/design "Personal website and portfolio" project (see
`internal/handler/nav.go`'s `primaryNavItems` doc comment for the full
rationale). Settings stays a dropdown, unchanged. Sections below still
describe the dropdown-based Home menu as originally specified; treat the
Scope note and the actual templates (`header.html`, `mobile-nav-panel.html`,
`nav.go`) as the source of truth where they disagree with this doc's prose.

## Summary

The shared page shell every route renders inside: a header with identity and
primary navigation, a dynamic content area, and a footer. This doc owns the
shell's structure and behavior contract — two things that plug into it live in
their own docs: the dark-mode toggle (`docs/features/dark-mode.md`) and the
transparent-over-hero header treatment a page can opt into
(`docs/features/landing-page.md`, currently the only page that uses it).

## Problem / Motivation

Without one shared shell, every page would duplicate header/nav/footer markup,
which `docs/skills/htmx-ui`'s Layout Architecture explicitly says to avoid (one
`base.html`, pages only define `content`). This feature establishes that shell so
every other page feature (Resume, Projects, Blogs, Settings) can build on it
instead of reinventing it.

## Scope

**In scope:**

* `base.html` layout: header, dynamic `content` block, footer.
* Header identity: avatar photo + name, anchoring the left edge of the header
  before the nav, linking to `/` — the only way back to the landing page from
  anywhere else in the header. No-op if already on `/`.
* Header navigation: originally a **Home** dropdown menu (next to identity)
  and a right-aligned **Settings** menu, both dropdown triggers only. **This
  changed**: Home is now a flat, always-visible link row — Home/Projects/About
  — plus a separate outline-pill **Résumé** button, per the redesign noted
  under Status. Settings is unchanged (still a dropdown trigger, still
  auth-gated). Blogs and Fishing Game are no longer linked from the header at
  all — they stay reachable at their existing URLs (`/blogs`,
  `/fishing-game`), just not from top-level nav. Fishing Game later gained a
  second entry point outside the header, though: `/projects` links to it
  directly (`docs/features/projects.md`'s `Project.External` field).
* ~~**Home** submenu: Resume, Projects, Blogs.~~ Superseded — see above.
* **Settings** submenu: Profile, Security, Logout. Rendered server-side only for
  an authenticated site-owner session — anonymous visitors receive no Settings
  markup at all (this is an admin-only area, not a public multi-user feature).
* An icon for every top-level menu and every submenu item.
* A `TransparentOverHero` flag the header exposes for any page to opt into,
  defaulting to solid; the *implementation* of the transparent state and its
  transition to solid belongs to whichever page opts in (currently only
  `docs/features/landing-page.md`) — this feature's responsibility is that the
  header correctly reflects whichever state the *current* page requests,
  including across HTMX navigation, browser back/forward, and reload.
* A reserved slot in the header (and mobile panel) for the dark-mode toggle —
  the toggle itself is `docs/features/dark-mode.md`.
* Footer: site version, tagline/copyright line, LinkedIn and GitHub links with icons.
* Mobile: a hamburger button that opens a slide-out panel containing both menus
  and the theme-toggle slot; header always renders solid on mobile regardless of
  what the current page requests via `TransparentOverHero`.
* Keyboard accessibility for the dropdown menus and the mobile panel.

**Out of scope:**

* Landing/home page content, and its specific implementation of
  `TransparentOverHero` (hero, scroll threshold, sentinel element) — separate
  feature doc, `docs/features/landing-page.md`.
* Dark mode's toggle behavior, cookie persistence, and validation — separate
  feature doc, `docs/features/dark-mode.md`.
* Resume, Projects, Blogs page content (separate feature docs).
* Profile, Security page content and Logout's auth implementation (separate feature docs) — this feature only wires up the nav entries and routes.
* Authentication/session implementation (the mechanism that determines "is this
  the authenticated site-owner session" — this feature only consumes that result).

---

## User Flow

```text
1. User loads any page. Header renders: identity (avatar + name, links to `/`)
   on the left, "Home ▾" next to it, and — only if authenticated as the site
   owner — "Settings ▾" on the right. Header is solid unless the current page
   opts into `TransparentOverHero` (see `docs/features/landing-page.md`).
2. ~~User clicks/focuses "Home" → dropdown opens showing: Resume, Projects, Blogs (each with an icon).~~ Superseded: "Home", "Projects", and "About" are now plain links navigated to directly, sitting next to a separate "Résumé" button — no dropdown, no icons.
3. User clicks/focuses "Settings" (only visible when authenticated) → dropdown
   opens showing: Profile, Security, Logout (each with an icon).
4. User selects a submenu item, or clicks the identity block to return to `/` →
   content area updates via an HTMX swap; header and footer are not replaced,
   but the header re-evaluates its transparent/solid state for the new page.
5. On a narrow viewport, "Home ▾"/"Settings ▾" are replaced by a single hamburger
   button; tapping it opens a slide-out panel with both menus and the theme
   toggle fully expanded. The header on mobile is always solid.
6. Footer is always visible at the bottom of the page: version + tagline on one
   side, LinkedIn and GitHub icons/links on the other.
```

---

## Visual Direction

Follows `tailwind-ui`'s Visual Style principles (modern, calm, personal, premium
without excess) — the decisions below are the specifics for this shell:

* **Identity**: circular avatar photo (e.g. 32–36px) + name as a text wordmark,
  left of the Home menu, wrapped in a link to `/`. If the avatar image fails to
  load, fall back to initials in a colored circle rather than a broken image icon.
* **Header background**: solid by default, with a subtle bottom border or shadow
  to separate it from content — consistent with `tailwind-ui`'s "avoid huge
  shadows" guidance. A page may opt into starting transparent via
  `TransparentOverHero`; see `docs/features/landing-page.md` for that
  implementation. On mobile, the header is always solid regardless of what the
  current page requests.
* **Dark mode**: a toggle lives in the header and mobile panel; see
  `docs/features/dark-mode.md` for the theming and persistence approach.
* **Container width**: header, footer, and page content share one max-width
  (e.g. `max-w-5xl`, matching the value already used as an example in `htmx-ui`)
  so nothing in the shell feels wider or narrower than the content it wraps.
* **Footer**: same horizontal rhythm/padding as the header, quieter visual weight
  (smaller text, muted color) — signals "you've reached the end," not a second nav bar.
* **Nav interactions**: dropdown open/close and hover states use short (100–150ms)
  transitions, consistent with `htmx-ui`'s CSS-for-swaps timing guidance, so nav
  polish and content-swap polish feel like one system rather than two.

---

## UI

```text
web/templates/
├── layouts/
│   └── base.html            # header + {{.RenderedContent}} + footer; reads theme cookie server-side (see dark-mode.md)
├── pages/
│   └── <page>.html          # each defines its own <main id="main-content" class="mx-auto max-w-5xl px-4 py-8"> wrapper — see below
└── components/
    ├── header.html          # identity + nav-menu twice (left/right) + theme-toggle slot + mobile-nav-trigger; accepts a "transparent-over-hero" flag
    ├── nav-identity.html    # avatar + name, with initials fallback, links to /
    ├── nav-menu.html        # one dropdown: label, icon, list of submenu items
    ├── mobile-nav-panel.html # hamburger trigger + slide-out panel (both menus + theme-toggle slot)
    └── footer.html          # version, tagline, social links

web/static/
├── images/
│   └── avatar.jpg           # header identity photo
└── js/
    └── header-scroll.js     # reset-on-navigation logic; full spec in docs/features/landing-page.md (the only current consumer of TransparentOverHero)
```

`header.html` takes a boolean (e.g. `TransparentOverHero`) from the page data so
only a page that opts in (currently only the landing page) server-renders a
transparent starting state — every other page renders solid directly on first
load. `header-scroll.js` is loaded on every page, since it must correctly reset
the header when navigating *away from* a transparent-eligible page just as much
as when navigating *to* one.

States this feature's UI must handle:

| State                        | Behavior |
| ----------------------------- | -------- |
| Default (solid)                | Both menus closed; current page's nav item visually marked active; solid background. |
| Transparent (page opt-in)       | Only on pages setting `TransparentOverHero`; see `docs/features/landing-page.md` for the transition detail. |
| Menu open                      | Dropdown visible on click/focus; closes on outside click, item selection, or `Escape`. |
| Mobile (collapsed)             | Hamburger button replaces the two menus; header always solid. |
| Mobile panel open               | Slide-out panel visible with both menus expanded and the theme toggle; traps focus; `Escape` or outside tap closes it. |
| Dark mode                      | See `docs/features/dark-mode.md`. |
| Settings hidden (anonymous)    | Settings menu markup is entirely absent — not present in the DOM, not just visually hidden. |
| Content loading                 | A local loading indicator shows while the content area swaps to a new page. |
| Content error                   | Content area shows a clear "couldn't load this page" message without breaking the header/footer. |
| Avatar failed to load           | Falls back to initials in a colored circle instead of a broken image icon. |

---

## HTMX Interactions

Selecting a nav item swaps only the content area — header and footer are not
re-rendered. See `htmx-ui` for fragment-vs-full-page rendering and ID conventions.

**`outerHTML` swap means every content template owns its own `#main-content`
wrapper — this was shipped wrong once already, worth stating explicitly.**
`hx-swap="outerHTML"` (table below) replaces the *entire* `#main-content`
element with the server's response, not just its children. Every page
template (`placeholder.html`'s `{{define "content"}}`, `resume.html`'s
`{{define "resume-content"}}`, and any future page) must therefore render
its own `<main id="main-content" class="mx-auto max-w-5xl px-4 py-8">...
</main>` wrapper — `base.html` does *not* supply one (it just outputs
`{{.RenderedContent}}`). Getting this backwards — relying on `base.html`
to wrap bare inner content, which is how this shipped originally — means a
direct page load (`base.html`'s own render) looks correct, but every HTMX
nav swap destroys `#main-content`'s container classes along with the old
content, leaving the new page full-bleed with no `max-w-5xl`/padding. This
went undetected on the plain placeholder page (a heading and one line of
text doesn't look obviously broken without a container) until the resume
page's richer layout made it unmistakable. Regression coverage:
`internal/handler/template_test.go`'s `assertMainContentContainer` (both
the full-page and fragment render paths) and `e2e/nav.spec.js`'s "container
survives an HTMX nav swap" tests, which specifically navigate via the
dropdown rather than a direct page load — a direct load alone can't catch
this class of bug, since it only ever exercises `base.html`'s own
(correct) wrapping.

Every `GET` row uses `hx-push-url="true"`. Without it the address bar would never
change on nav clicks, which would break refresh, the back/forward buttons, and
sharing/bookmarking a direct link to e.g. `/projects` — all of it would silently
land back on `/`. The pushed URL is also the source of truth for which nav item
is marked active and for the navigation-reset path check in Client-side Behavior
(read `location.pathname` after the push, not the pre-swap request path).

| Trigger                     | Method | Endpoint             | Target           | Swap        | `hx-push-url` | Indicator      |
| ---------------------------- | ------ | ---------------------- | ----------------- | ----------- | -------------- | --------------- |
| Identity (avatar + name)      | GET    | `/`                    | `#main-content`   | `outerHTML` | `true`         | `#nav-loading`  |
| Home (flat link)              | GET    | `/`                    | `#main-content`   | `outerHTML` | `true`         | `#nav-loading`  |
| Projects (flat link)          | GET    | `/projects`            | `#main-content`   | `outerHTML` | `true`         | `#nav-loading`  |
| About (flat link)             | GET    | `/about`               | `#main-content`   | `outerHTML` | `true`         | `#nav-loading`  |
| Résumé (button)               | GET    | `/resume`              | `#main-content`   | `outerHTML` | `true`         | `#nav-loading`  |
| Settings ▾ → Profile          | GET    | `/settings/profile`    | `#main-content`   | `outerHTML` | `true`         | `#nav-loading`  |
| Settings ▾ → Security         | GET    | `/settings/security`   | `#main-content`   | `outerHTML` | `true`         | `#nav-loading`  |
| Settings ▾ → Logout           | POST   | `/logout`              | n/a — see below   | n/a         | n/a            | —               |

The identity link is a no-op while already on `/` (no fetch, no swap) — it should
not behave differently from a normal same-page anchor click.

Logout's exact mechanism (an `HX-Redirect` response header vs. a plain non-hx form
POST causing a real browser navigation) is left to the auth feature doc, since
Logout's implementation is out of scope here; this feature only defines that the
trigger lives in the Settings submenu and must be a `POST`.

Confirmation required for destructive actions:

* Logout ends the active session but isn't destructive to data — logging back in
  fully recovers it — so no `hx-confirm` prompt is required.

---

## Client-side Behavior (non-HTMX)

Presentation concerns with no server round-trip are out of HTMX's model —
`htmx-ui`'s "avoid unnecessary JavaScript" principle allows small, scoped
exceptions here.

### `header-scroll.js` — shell-level contract

This script's full scroll/threshold implementation lives in
`docs/features/landing-page.md`, since today it only exists because of that
page's hero. What belongs to *this* doc is the contract every consumer must
satisfy: header/footer are never re-rendered by the content-only HTMX swaps
above, so whatever drives the transparent/solid state must independently:

* Reflect the *current* page's `TransparentOverHero` value after an HTMX nav
  click, a browser back/forward navigation, and a fresh page load/reload — not
  whatever state the header was left in before.
* Force solid immediately when the current page doesn't opt in — there's no
  "in between" state.
* The identity link's "no-op while already on `/`" behavior (see HTMX
  Interactions) is also this script's responsibility — a click handler that
  checks `location.pathname` before letting the request fire.

### Mobile panel (`mobile-nav-panel.html` + inline behavior)

* Hamburger button toggles `aria-expanded` and the panel's visibility.
* Panel traps focus while open; `Escape` or an outside tap closes it and returns
  focus to the hamburger button.
* Contains both menus (already expanded, no nested dropdown interaction needed)
  and the theme-toggle slot.
* Degradation: the mobile hamburger should still be a plain, keyboard-operable
  disclosure control if feasible without JS (e.g. a `<details>`-based fallback);
  otherwise this is the one piece of shell UI genuinely gated on JavaScript.

Respect `prefers-reduced-motion` for any transition this shell owns directly
(menu open/close, mobile panel).

---

## Routes / Handlers

This feature doesn't own page content routes — it owns the shell those routes
render into. Listed here only so the nav's targets are traceable; each is a
separate feature to actually implement.

| Method | Path                  | Handler                  | Auth required | Notes |
| ------ | ---------------------- | -------------------------- | ------------- | ----- |
| GET    | `/`                    | `HomeHandler.Index`        | no            | landing page; content is `landing-page.md`, but the route itself belongs to this shell |
| GET    | `/resume`              | `ResumeHandler.Index`      | no            | separate feature |
| GET    | `/projects`            | `ProjectsHandler.Index`    | no            | separate feature |
| GET    | `/blogs`               | `BlogsHandler.Index`       | no            | separate feature |
| GET    | `/settings/profile`    | `ProfileHandler.Index`     | yes           | separate feature; unauthenticated requests redirect to login (see Security Considerations) |
| GET    | `/settings/security`   | `SecurityHandler.Index`    | yes           | separate feature; unauthenticated requests redirect to login (see Security Considerations) |
| POST   | `/logout`              | `AuthHandler.Logout`       | yes           | separate feature |

---

## Data Model

None. The footer version is sourced from build metadata (see Business Rules), not
the database — this feature has no schema of its own. Identity (name, avatar) is
hardcoded/static in this feature, not database-driven, so there's no escaping
concern here yet — if a future Profile feature makes these editable, that value
must go through `html/template`'s auto-escaping like any other dynamic content;
it shouldn't be assumed safe just because it wasn't previously.

---

## Business Rules / Validation

* The footer version is injected at build time (e.g. via `-ldflags -X`, from a git
  tag/commit), not hand-maintained in a template.
* The nav item matching the current route is visually marked active, determined
  from `location.pathname` (not in-memory state), so it stays correct across
  refresh and browser back/forward.
* Dropdowns open on click and are keyboard-operable (`Enter`/`Space` to open,
  arrow keys to move between items, `Escape` to close, focus returns to the
  trigger on close). Selecting an item closes its own dropdown immediately,
  the same as any other close path — a click on a menu item is *inside* the
  menu, so it doesn't trigger the separate "close on outside click" handler;
  `nav-menu.js` closes on item click directly rather than relying on that.
* `Escape`-to-close is handled by a single `document`-level keydown listener,
  not listeners scoped to the trigger/list elements — WebKit/Safari (unlike
  Chromium/Firefox) does not move keyboard focus to a `<button>` on click, so
  a mouse-opened menu never puts focus on the trigger or inside the list
  there, and a scoped listener would silently never fire. This was caught by
  running `e2e/nav.spec.js` against Playwright's `webkit` project, not just
  `chromium` — worth doing for any nav/keyboard-interaction change on this
  shell, since this class of engine-specific behavior difference doesn't show
  up any other way.
* Every GET nav item's clickable area is the full row (`w-full` on the
  `<a>`), matching the Logout button's own `w-full` — not just the width of
  its icon/label content — so there's no dead zone between the visible
  highlighted row and the actual click target.
* `/static/*` responses always carry `Cache-Control: no-cache`, forcing
  revalidation on every load rather than trusting a browser's heuristic
  freshness guess for JS/CSS with no explicit cache header. Needed because a
  browser (Safari in particular) can keep serving an already-fixed script
  from cache for a while otherwise, which makes a real fix look like it
  didn't take effect.
* External links (LinkedIn, GitHub) open in a new tab with `rel="noopener noreferrer"`.
* Avatar image includes descriptive `alt` text (the site owner's name); on load
  failure, an initials fallback renders in its place rather than a broken image.
* The identity block (avatar + name) is the only header element that links to
  `/`; "Home" and "Settings" are dropdown triggers and never navigate directly.
  Clicking it while already on `/` is a no-op — no request, no swap.
* Settings menu markup is only included in the server-rendered HTML for an
  authenticated site-owner session — omitted entirely for anonymous visitors,
  not merely hidden with CSS, so the response body itself reveals nothing.
* On mobile, the header is always solid, regardless of what the current page
  requests via `TransparentOverHero`.
* Icons are inline SVG (e.g. sourced from the Heroicons outline set) rather than
  an icon font or an added JS dependency, consistent with `tailwind-ui`'s
  minimal-dependency stance.
* `TransparentOverHero` is a reusable, per-page opt-in flag — nothing about the
  mechanism restricts it to `/`; any future page can adopt it, following the
  pattern in `docs/features/landing-page.md`.

---

## Security Considerations

* **Authz**: Settings is an admin-only area for the site owner, not a public
  multi-user feature. Its routes require an authenticated session server-side
  regardless of what the nav renders (defense in depth), and its nav markup is
  omitted entirely — not CSS-hidden — for anonymous visitors, so casual browsing
  never surfaces that an admin area exists.
* **Unauthenticated access to `/settings/*`**: redirects to a login route rather
  than 404ing. The nav-hiding goal above is about not exposing the admin area to
  casual browsing, not achieving full obscurity against deliberate probing — a
  login-gated route being reachable is standard and low-risk (credentials are the
  actual protection), and it's the only way the site owner has to discover how to
  log in, since no "Login" link exists anywhere in this shell.
* **No inline `<script>` tags** anywhere in this shell — `header-scroll.js` and
  any other shell script are external files. Keeps the page compatible with a
  strict CSP with no `'unsafe-inline'` needed for scripts, per `go-backend`'s
  Security Headers.
* **htmx's own auto-injected `<style>` tag** for `.htmx-indicator`'s default
  opacity transition is disabled via `base.html`'s `<meta name="htmx-config"
  content='{"includeIndicatorStyles":false}'>` — that injection is a CSP
  violation under the same strict policy (no `style-src` is set, so
  `default-src 'self'` blocks it) and was firing on every page load. It's
  also redundant: `app.css` already defines `.htmx-indicator`'s visibility
  itself. The meta tag is htmx's own documented configuration mechanism, not
  an inline script or style, so it doesn't reopen the exception above.
* **Error messages**: the Content error state must follow `htmx-ui`'s "never
  expose internal errors" rule — a generic "couldn't load this page" message,
  never a stack trace or raw error string.
* **Destructive actions**: Logout must be a `POST`, never a `GET`, per HTTP
  semantics in `go-backend`/`htmx-ui`.
* **CSRF**: `POST /logout` must be covered by the app's CSRF protection.
* **External links**: `rel="noopener noreferrer"` on LinkedIn/GitHub links to
  prevent tabnabbing.

---

## Testing Plan

* [x] Every content template's `#main-content` wrapper (classes and all)
      survives an HTMX nav swap, not just a direct page load — verified for
      both `/resume` and a placeholder route (`e2e/nav.spec.js`,
      `internal/handler/template_test.go`).
* [x] Header renders on every page with the flat Home/Projects/About links,
      the Résumé button, and Settings (only when authenticated) present.
* [x] Flat nav links go to `/`, `/projects`, `/about`; Résumé button goes to `/resume`.
* [ ] Settings ▾ shows Profile, Security, Logout with correct icons and links.
* [x] Active nav item reflects the current route (`aria-current="page"`, driven by `PageData.NavActive`).
* [ ] The Settings dropdown is operable via keyboard only.
* [ ] Selecting a Settings dropdown item closes it (not just outside-click/Escape) — regression coverage in `e2e/nav.spec.js`.
* [ ] No console errors (including no CSP violations) on initial load of `/` or `/resume` — `e2e/nav.spec.js`.
* [ ] Nav selection swaps `#main-content` without reloading header/footer.
* [ ] Nav clicks update the URL bar (`hx-push-url`); refreshing on `/projects` (or
      any nav destination) loads that page directly, not the landing page.
* [ ] Footer shows the correct build version and working LinkedIn/GitHub links.
* [ ] Mobile viewport: hamburger opens the slide-out panel; both menus and the
      theme toggle are reachable inside it; panel traps focus and `Escape`/outside
      tap closes it, returning focus to the hamburger button.
* [ ] Mobile header is solid at every scroll position, on every page, including
      pages that opt into `TransparentOverHero`.
* [ ] Unauthenticated request to `/settings/profile` or `/settings/security`
      redirects to login rather than rendering the page or leaking its content.
* [ ] Anonymous response body (view source, not just visual inspection) contains
      no Settings menu markup; an authenticated site-owner session does.
* [ ] Content error state never renders a raw error string or stack trace.
* [ ] Avatar renders correctly; simulated load failure shows the initials fallback.
* [ ] Header, content, and footer share the same container max-width at each breakpoint.
* [ ] Identity block links to `/`, is reachable/operable via keyboard, and is a
      no-op when already on `/`.
* [ ] Clicking a nav item on a page with `TransparentOverHero` active correctly
      forces the header solid on the destination page — no leftover transparent
      state (full scroll/threshold coverage lives in `landing-page.md`'s testing plan).

---

## Definition of Done

* [ ] User flow works end-to-end, including edge cases above.
* [ ] All states in the UI table are implemented, including cross-referenced
      states owned by `dark-mode.md` and `landing-page.md`.
* [ ] Header identity (avatar + name) renders correctly with a working fallback.
* [ ] Destructive/session-ending actions (Logout) require `POST` and are wired securely.
* [ ] Handler/service/repository boundaries followed (`go-backend`) for any routes this feature touches directly.
* [ ] URL bar, refresh, and browser back/forward all behave correctly across every nav destination (`hx-push-url`).
* [ ] Mobile hamburger/slide-out panel is fully keyboard accessible and traps focus.
* [ ] Settings menu markup is verified absent (response body, not just visual) for anonymous visitors.
* [ ] No inline `<script>` tags exist anywhere in this shell.
* [ ] Accessibility checked (keyboard nav through dropdowns and mobile panel, focus management, semantic HTML, contrast, reduced-motion respected).
* [ ] Tests cover the behavior in the Testing Plan above.
