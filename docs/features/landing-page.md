# Feature: Landing Page

## Status

`Proposed` — partial. This doc currently only specifies the landing page's use of
`docs/features/home.md`'s `TransparentOverHero` flag (the header-over-hero
scroll behavior). The hero's actual content — copy, imagery, CTA, and any
sections below it — has not been designed yet; see Open Questions.

## Summary

The `/` route's own page: a hero the header starts transparent/blurred over,
solidifying once scrolled past, plus whatever content follows the hero. This doc
owns everything specific to this one page — the shared shell (header structure,
nav, footer) is `docs/features/home.md`; the dark-mode toggle mounted in that
shell is `docs/features/dark-mode.md`.

## Problem / Motivation

A generic solid header from the top of every page, including the landing page,
reads as a standard admin dashboard rather than a personal site people should
find beautiful. A hero the header floats over — then solidifies once you scroll
past it — is one of the highest-leverage visual moves for that first impression,
which is why it's worth the added implementation complexity documented below.

## Scope

**In scope (for now):**

* This page sets `TransparentOverHero: true` when rendering `base.html`.
* A hero section providing a sentinel element at its bottom edge, for
  `header-scroll.js`'s `IntersectionObserver` to watch.
* `header-scroll.js`'s full behavior: `IntersectionObserver`-based toggle,
  reset on HTMX navigation and browser back/forward, initial-load/reload
  flash-avoidance, and the mobile-always-solid override (enforced by `home.md`,
  consumed here).

**Out of scope (undesigned, needs a dedicated pass):**

* Hero copy, headline, imagery, and any call-to-action.
* Page sections below the hero (if any) — what the rest of `/` contains.
* Anything about what actually renders inside `#main-content` on this route.

---

## User Flow

```text
1. User loads `/`. Header renders transparent/blurred over the hero: identity
   and nav (from home.md) are legible against the hero via backdrop-blur.
2. User scrolls past the hero → header transitions to solid with a subtle
   shadow/border; identity and nav stay in the same position throughout.
3. User navigates away (any nav link, per home.md) → header is forced solid on
   the destination page immediately, with no leftover transparent state.
4. User navigates back to `/` (identity link, back button, or a fresh load) →
   the transparent-over-hero start state re-applies, unless the user had
   already scrolled past the hero (e.g. via back/forward with restored scroll
   position), in which case it renders solid immediately with no flash.
5. On mobile, the header is always solid — this page's hero is still visually
   present, but the header never goes transparent on a narrow viewport.
```

---

## Visual Direction

* **Header background states**:
  * *Transparent* (above the scroll threshold, desktop only): no background
    fill, `backdrop-blur` over the hero so text/nav stay legible against
    whatever hero imagery is behind them.
  * *Solid* (once scrolled past the hero, or on mobile at any scroll position):
    solid background, subtle bottom border or shadow — consistent with
    `tailwind-ui`'s "avoid huge shadows" guidance.
  * The transition between the two is a short opacity/background-color fade,
    not an abrupt cut, and respects `prefers-reduced-motion`.
* **Scroll threshold**: not a fixed pixel value — the hero's actual height,
  measured via an `IntersectionObserver` on a sentinel element at the hero's
  bottom edge, so it stays correct if the hero's size changes across
  breakpoints or content edits.
* Hero's own visual design (imagery, typography treatment, layout) — TBD, see
  Open Questions.

---

## UI

```text
web/templates/pages/
└── home.html                # sets TransparentOverHero: true; hero markup TBD

web/static/js/
└── header-scroll.js          # shared with home.md's shell (loaded on every page); full spec below
```

States this feature's UI must handle:

| State                          | Behavior |
| -------------------------------- | -------- |
| Transparent (top, desktop)         | Header has no background fill, blurred over the hero. |
| Solid (scrolled, desktop)          | Header has transitioned to solid after passing the scroll threshold. |
| Solid (mobile, any scroll position) | Header never goes transparent on mobile — enforced by `home.md`. |
| Reload while already scrolled       | Header renders solid immediately on load — no flash of the transparent state. |

---

## HTMX Interactions

None owned by this feature directly — navigating *to* or *away from* `/` uses
the nav interactions defined in `docs/features/home.md`'s HTMX Interactions
table. This doc only defines how the header reacts to those swaps.

---

## Client-side Behavior (non-HTMX)

`header-scroll.js` (loaded globally per `home.md`, but its logic exists because
of this page):

* **Scroll-based toggle**: on this page (desktop only — mobile is always solid
  per `home.md`), uses an `IntersectionObserver` watching a sentinel element at
  the bottom of the hero to toggle a class (e.g. `.header--solid`) — not a
  hardcoded scroll-position threshold, so it stays correct if the hero's height
  changes.
* **Navigation-based reset**: listens for `htmx:afterSwap` on `#main-content`
  (globally, on `document`) and, since every nav link in `home.md` uses
  `hx-push-url="true"`, reads `location.pathname` (already updated by the time
  `afterSwap` fires) to decide:
  * Path is **not** `/` → force `.header--solid` immediately and disconnect the
    observer (the destination page has no hero to be transparent over).
  * Path **is** `/` → remove the forced solid state and reconnect the observer
    so the transparent-over-hero start state applies again.
* **Back/forward navigation**: htmx's docs don't specify whether history
  restoration fires `htmx:afterSwap`, so this is handled independently with a
  `window.addEventListener('popstate', ...)` calling the same path-check
  function — `popstate` always fires on browser back/forward regardless of
  whether htmx serves the restore from its cache or a new request, so this
  doesn't depend on htmx's internals at all.
* **Initial-load check**: on a genuine fresh load (including a manual reload),
  runs the same path check immediately — and on `/` specifically, also checks
  whether the sentinel element is already out of view (covers a browser
  restoring scroll position on reload) rather than assuming the page starts at
  the top, so reloading `/` already scrolled past the hero doesn't flash
  transparent before correcting to solid.

This keeps `home.md`'s "only swap `#main-content`" model intact for every nav
link, including navigating back to `/`, instead of falling back to full page
loads to get a correct header state.

Respect `prefers-reduced-motion`: skip the fade transition, just toggle the class.

---

## Routes / Handlers

`GET /` itself is owned by `docs/features/home.md`'s Routes/Handlers table
(`HomeHandler.Index`) — this doc doesn't add a new route, only specifies what
that handler's page sets (`TransparentOverHero: true`) and what it renders once
the hero is designed.

---

## Data Model

None yet — depends entirely on what the hero/sections end up needing once
designed (see Open Questions). If content becomes editable rather than
hand-written in the template, that's a schema decision to make at that point,
following `docs/skills/postgres`.

---

## Business Rules / Validation

* `TransparentOverHero` is `true` for this page and this page only, for now —
  every other page passes `false`/omits it, per `home.md`.
* Header transparent/solid state is authoritative per the *current* page, not
  whatever state it was in before the last HTMX navigation — enforced by the
  `afterSwap`/`popstate`-based reset above.
* On mobile, the header is always solid regardless of scroll — enforced by
  `home.md`, consumed here without exception.

---

## Security Considerations

None specific to the header-interaction behavior in this doc beyond what
`home.md` already covers for the shell. Once hero/section content is designed,
revisit this doc for anything content-specific (e.g. if any part becomes
database-driven and needs escaping consideration).

---

## Testing Plan

* [ ] Header starts transparent over the hero and transitions to solid after
      the scroll threshold, with the transition skipped under
      `prefers-reduced-motion`.
* [ ] Scroll-triggered transition still fires correctly at different hero
      heights/breakpoints (verifies the `IntersectionObserver` approach, not a
      hardcoded threshold).
* [ ] Reloading `/` while already scrolled past the hero renders the header
      solid immediately — no flash of the transparent state.
* [ ] A direct load of a non-landing URL (bookmark, shared link, back/forward)
      renders the correct (solid) header state without needing an HTMX swap to
      occur first.
* [ ] Navigating away from `/` via any nav link correctly forces the header
      solid on the destination page — no leftover transparent state.
* [ ] Navigating back to `/` (identity link, back/forward) correctly re-arms
      the transparent-over-hero start state, unless already scrolled past the
      hero, in which case it's solid with no flash.
* [ ] Browser back/forward correctly resets header state via the `popstate`
      listener, independent of whether htmx serves the restore from cache.
* [ ] Mobile: header remains solid at every scroll position on this page.

---

## Open Questions

* What does the hero actually contain — headline, subhead, imagery, a CTA? This
  needs its own dedicated design pass; nothing here should be treated as
  decided until that happens.
* What sections, if any, follow the hero on this page?
* Does any of this content need to be database-driven/editable (revisit Data
  Model), or is it static in the template for now?

---

## Definition of Done

* [ ] Header-interaction behavior above works end-to-end (this is shippable
      independently of the hero's final visual design, as long as a hero and
      sentinel element exist).
* [ ] All states in the UI table are implemented.
* [ ] Tests cover the behavior in the Testing Plan above.
* [ ] Hero/section content is designed and its own review pass completed before
      this feature is considered fully done — the header-interaction contract
      alone does not constitute a finished landing page.
