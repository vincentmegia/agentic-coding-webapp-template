# Feature: Dark Mode

## Status

`Proposed`

## Summary

A site-wide dark-mode toggle, mounted in the header and the mobile nav panel
(both owned by `docs/features/home.md`, which reserves the slot this feature
fills). Preference persists across visits via a cookie read server-side, so the
correct theme is present in the very first HTML response — no flash of the wrong
theme after load.

## Problem / Motivation

Broken out of `docs/features/home.md` rather than left inline: it touches every
page's rendering (not just the header shell), and has enough independent detail —
cookie validation, CSP implications, theming approach — to review and ship on its
own instead of growing the layout doc further.

## Scope

**In scope:**

* Toggle button component, mounted in `header.html` and `mobile-nav-panel.html`
  (both defined in `home.md` — this feature fills the slot, not the mount point).
* Class-based `dark:` Tailwind variant, not `prefers-color-scheme` alone — the
  toggle's explicit choice must be able to override the OS setting.
* Cookie-based persistence (`theme=light|dark`), read server-side in `base.html`
  so the initial response already has the correct theme.
* Server-side validation of the cookie value against an exact allow-list.
* Falling back to `prefers-color-scheme` when no cookie has been set yet.
* `dark:` colors for the shell that already exists at the time this feature
  ships — `base.html`'s `<body>`, `header.html`, `nav-menu.html`'s dropdown
  panels, `mobile-nav-panel.html`, `footer.html`, and the `placeholder.html`
  page content — so toggling is visibly correct today, not just
  mechanically correct. Without this the toggle flips a cookie and an icon
  but the rest of the page (including dropdown/panel surfaces) looks
  unchanged, which reads as broken.

**Out of scope:**

* The header/mobile-panel structure and mount points themselves (`home.md`).
* Per-page dark-mode color decisions for pages built *after* this feature
  ships (resume, projects, blogs, etc.) — each new page/component is
  responsible for its own `dark:` classes as it's built, following the
  pattern established here for the shell.

---

## User Flow

```text
1. User clicks the theme toggle icon in the header (desktop) or inside the
   mobile nav panel.
2. Theme flips immediately (`dark` class toggled on `<html>`); a `theme` cookie
   is set.
3. On the next page load, reload, or HTMX navigation, the server has already
   read the cookie and rendered the correct theme in the initial HTML — no
   flash of the previous theme.
4. A first-time visitor with no `theme` cookie sees whatever their OS currently
   prefers (`prefers-color-scheme`), until they explicitly toggle.
```

---

## Visual Direction

* Follows `tailwind-ui`'s Dark Mode section: class-based `dark:` variant so an
  explicit user choice can override `prefers-color-scheme`, not just invert
  colors ad hoc per component.
* Toggle icon reflects current state (e.g. a sun/moon swap), not a generic
  on/off switch — the icon itself communicates which mode is active.
* The moon icon is solid/filled (`fill="currentColor"`), not a thin outline
  stroke — a filled crescent reads clearly at the toggle's small size, where
  an outline crescent tends to look faint and hard to spot. The sun icon
  stays as-is.
* Icon/color transition on toggle is short and respects `prefers-reduced-motion`.

---

## UI

```text
web/templates/components/
└── nav-theme-toggle.html    # icon button; reflects current theme state

web/static/js/
└── theme-toggle.js          # toggle + cookie persistence
```

States this feature's UI must handle:

| State                          | Behavior |
| -------------------------------- | -------- |
| Light (no cookie, OS light)        | Renders light; toggle shows "switch to dark" affordance. |
| Dark (no cookie, OS dark)          | Renders dark via `prefers-color-scheme`; toggle shows "switch to light." |
| Light (explicit, `theme=light`)     | Renders light regardless of OS preference. |
| Dark (explicit, `theme=dark`)       | Renders dark regardless of OS preference. |
| Toggle activated                   | Theme flips instantly, cookie is set, no page reload required. |

The existing shell (`body`, header, footer, placeholder page) must carry
matching `dark:` classes so these states are visibly, not just mechanically,
correct — see Scope.

---

## Client-side Behavior (non-HTMX)

The toggle is a pure presentation concern with no server round-trip on click, so
it's out of HTMX's model — `htmx-ui`'s "avoid unnecessary JavaScript" principle
allows this small, scoped exception.

`theme-toggle.js`:

* On click, flips the `dark` class on `<html>`, and sets a `theme=light|dark`
  cookie (`path=/`, `SameSite=Lax`, `Secure` in production, long-lived) so the
  preference persists.
* `base.html` reads that cookie server-side on every request and renders the
  `dark` class directly in the initial HTML when set — this is what avoids a
  flash of the wrong theme, not client-side JS run after paint.
* When no `theme` cookie is set yet (first visit), the page falls back to
  `prefers-color-scheme` via CSS; the toggle's first click is what creates the
  cookie and makes the choice explicit and persistent.

Degradation: with `theme-toggle.js` disabled, the theme falls back permanently to
`prefers-color-scheme` with no manual override — a reasonable degraded state, not
a broken one.

Respect `prefers-reduced-motion`: skip any icon/color transition, just toggle.

---

## Routes / Handlers

None. Toggling is pure client-side plus a cookie the server reads passively when
rendering `base.html` — no dedicated endpoint.

---

## Data Model

None. Preference lives entirely in a client cookie, not the database.

---

## Business Rules / Validation

* The server **must** validate the `theme` cookie value against an exact
  allow-list (`light` or `dark` only) before using it to render HTML — a cookie
  is attacker-settable, so anything else (empty, malformed, unexpected value) is
  treated as "not set" and falls back to `prefers-color-scheme`, never
  interpolated as-is into the rendered class.
* The cookie is set with `SameSite=Lax` and `Secure` in production.
* Class-based `dark:` variant is the mechanism — no per-component
  `prefers-color-scheme` media queries scattered through templates.

---

## Security Considerations

* **Cookie injection**: the `theme` cookie must be validated server-side against
  an exact allow-list before use — never interpolate an attacker-settable cookie
  value directly into rendered HTML (see Business Rules).
* **Cookie attributes**: `SameSite=Lax`, `Secure` in production.
* **No inline `<script>` tags**: `theme-toggle.js` is an external file, and the
  no-flash behavior comes from a server-side cookie read rather than a pre-paint
  inline script — keeps the page compatible with a strict CSP with no
  `'unsafe-inline'` needed for scripts, per `go-backend`'s Security Headers.

---

## Testing Plan

* [ ] Toggle switches theme instantly and sets the `theme` cookie.
* [ ] Theme persists via cookie across reload and HTMX navigation.
* [ ] First visit with no cookie defaults to `prefers-color-scheme`.
* [ ] No flash of the wrong theme on reload once a `theme` cookie exists.
* [ ] A malformed/unexpected `theme` cookie value (not exactly `light` or `dark`)
      is treated as not set and falls back to `prefers-color-scheme`, not
      reflected into the page.
* [ ] Toggle is present and operable in both the header (desktop) and the mobile
      nav panel, and reflects the same state in both places.
* [ ] Toggle icon correctly reflects current state (not a generic switch).
* [ ] Toggle transition respects `prefers-reduced-motion`.
* [ ] Toggling actually changes the visible appearance of the existing shell
      (body background, header, footer, placeholder page text) in a real
      browser — not just the `<html>` class and the toggle icon.

---

## Definition of Done

* [ ] User flow works end-to-end, including first-visit default and persistence.
* [ ] All states in the UI table are implemented.
* [ ] `theme` cookie value is validated server-side against an exact allow-list before use.
* [ ] Cookie set with `SameSite=Lax` and `Secure` in production.
* [ ] No inline `<script>` tags exist.
* [ ] No flash of the wrong theme on reload.
* [ ] Existing shell (`body`, header, footer, placeholder page) has `dark:`
      classes and visibly changes appearance when toggled.
* [ ] Accessibility checked (keyboard-operable toggle, focus visible, reduced-motion respected).
* [ ] Tests cover the behavior in the Testing Plan above.
