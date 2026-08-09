# Feature: Site Layout (Header, Footer, Dynamic Content)

## Status

`Proposed`

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
* Header navigation: **Home** menu (next to identity) and right-aligned
  **Settings** menu. "Home" and "Settings" are dropdown triggers only — neither
  navigates anywhere by itself.
* **Home** submenu: Resume, Projects, Blogs.
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
2. User clicks/focuses "Home" → dropdown opens showing: Resume, Projects, Blogs (each with an icon).
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
│   └── base.html            # header + {{block "content"}} + footer; reads theme cookie server-side (see dark-mode.md)
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

Every `GET` row uses `hx-push-url="true"`. Without it the address bar would never
change on nav clicks, which would break refresh, the back/forward buttons, and
sharing/bookmarking a direct link to e.g. `/projects` — all of it would silently
land back on `/`. The pushed URL is also the source of truth for which nav item
is marked active and for the navigation-reset path check in Client-side Behavior
(read `location.pathname` after the push, not the pre-swap request path).

| Trigger                     | Method | Endpoint             | Target           | Swap        | `hx-push-url` | Indicator      |
| ---------------------------- | ------ | ---------------------- | ----------------- | ----------- | -------------- | --------------- |
| Identity (avatar + name)      | GET    | `/`                    | `#main-content`   | `outerHTML` | `true`         | `#nav-loading`  |
| Home ▾ → Resume               | GET    | `/resume`              | `#main-content`   | `outerHTML` | `true`         | `#nav-loading`  |
| Home ▾ → Projects             | GET    | `/projects`            | `#main-content`   | `outerHTML` | `true`         | `#nav-loading`  |
| Home ▾ → Blogs                | GET    | `/blogs`               | `#main-content`   | `outerHTML` | `true`         | `#nav-loading`  |
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
  trigger on close).
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

* [ ] Header renders on every page with both menus present (Settings only when authenticated).
* [ ] Home ▾ shows Resume, Projects, Blogs with correct icons and links.
* [ ] Settings ▾ shows Profile, Security, Logout with correct icons and links.
* [ ] Active nav item reflects the current route.
* [ ] Dropdowns are operable via keyboard only.
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
