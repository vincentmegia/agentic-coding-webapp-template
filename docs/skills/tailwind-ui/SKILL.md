# Tailwind UI Skill

## Purpose

Build a consistent, responsive, accessible, and polished UI using Tailwind CSS.

The visual direction is a modern, personal home dashboard.

Feature-specific UI requirements belong in:

```text
docs/features/
```

---

## Core Principles

Prioritize:

1. Clarity
2. Consistency
3. Accessibility
4. Responsive behavior
5. Visual hierarchy
6. Maintainability

Avoid designing every page independently.

Use a consistent design language.

---

## Design System

Define reusable visual conventions for:

* Colors
* Typography
* Spacing
* Border radius
* Shadows
* Buttons
* Forms
* Cards
* Status indicators

Prefer design tokens over arbitrary values.

Use Tailwind's configured theme where possible.

Avoid repeatedly inventing values such as:

```text
mt-[17px]
px-[13px]
rounded-[11px]
```

unless there is a genuine design requirement.

### Defining tokens

Define tokens with Tailwind v4's CSS-first `@theme` directive, in one file, rather
than scattering raw hex/px values across templates:

```css
/* web/static/css/app.css */
@import "tailwindcss";

@theme {
    --color-brand: oklch(0.55 0.15 250);
    --color-surface: oklch(0.98 0 0);
    --color-danger: oklch(0.58 0.22 27);

    --radius-card: 0.75rem;
}
```

Use semantic names (`brand`, `surface`, `danger`) rather than referencing raw
Tailwind palette colors (`blue-600`) directly in templates. A semantic token can be
redefined once in `app.css`; a raw palette color used across dozens of templates
requires a find-and-replace to change.

Ensure Tailwind's content scanning covers the Go template tree — with the v4
Vite/PostCSS plugin this is automatic for files it can see, but explicitly confirm
`web/templates/**/*.html` is reachable from the build so classes used only in
templates aren't purged from the production build.

---

## Layout

Prefer:

* CSS Grid
* Flexbox
* Responsive utilities
* Container layouts

Avoid fixed widths that break on smaller screens.

Use responsive breakpoints intentionally.

Example:

```html
<div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
```

---

## Responsive Design

Design mobile behavior intentionally.

Do not simply make desktop smaller.

Consider:

* Navigation
* Cards
* Tables
* Forms
* Buttons
* Modals
* Spacing
* Touch targets

The application must remain usable on mobile.

---

## Global Header

The application uses a sticky global header.

Structure:

```text
Home                                      Settings
 └── Devices                              ├── Profile
                                          ├── Account
                                          ├── Security
                                          └── Logout
```

The header should:

* Remain visible while scrolling
* Have appropriate `z-index`
* Work on mobile
* Maintain accessible contrast
* Avoid excessive height

Use Tailwind utilities rather than custom CSS when practical.

Example:

```html
<header class="sticky top-0 z-50">
```

---

## Visual Style

The dashboard should feel:

* Modern
* Calm
* Personal
* Clean
* Slightly cozy
* Premium without being excessive

Avoid:

* Excessive gradients
* Neon colors
* Excessive glassmorphism
* Huge shadows
* Excessive rounded containers
* Dense enterprise dashboards

---

## Typography

Use a clear hierarchy:

```text
Page title
Section title
Card title
Body
Secondary information
Metadata
```

Avoid making every element bold.

Maintain readable line heights and adequate contrast.

---

## Spacing

Use a consistent spacing scale.

Prefer:

```text
p-4
p-6
gap-4
gap-6
space-y-4
```

rather than arbitrary spacing.

Whitespace is part of the design.

Do not fill every available pixel.

---

## Cards

Cards should communicate grouping.

A typical card may use:

```html
<div class="rounded-xl border p-5">
```

Cards should have:

* Clear title
* Consistent padding
* Appropriate spacing
* Clear interactive states

Avoid nesting cards excessively.

---

## Buttons

Buttons should communicate hierarchy.

Typical levels:

```text
Primary
Secondary
Danger
Ghost
```

Use the same styling conventions throughout the application.

Destructive actions such as shutdown should have an unmistakable visual treatment.

---

## Status Indicators

Do not rely solely on color.

For example, avoid:

```text
●
```

with no text.

Prefer:

```text
● Online
● Offline
● Unknown
```

Use icons or text in addition to color where appropriate.

---

## Forms

Forms should have:

* Visible labels
* Consistent spacing
* Clear focus states
* Validation feedback
* Accessible controls

Never remove focus indicators without providing an equivalent accessible state.

---

## Accessibility

Maintain:

* Keyboard navigation
* Focus visibility
* Sufficient contrast
* Semantic structure
* Appropriate labels
* Accessible touch targets

Do not communicate important information through color alone.

Respect reduced-motion preferences.

---

## States

Interactive components should account for:

```text
Default
Hover
Focus
Active
Disabled
Loading
Success
Error
Empty
```

Do not design only the happy path.

---

## Dark Mode

If dark mode is implemented, design it as a first-class theme.

Use Tailwind's class-based `dark:` variant (`@variant dark (&:where(.dark, .dark *))`
in `app.css`) rather than relying solely on `prefers-color-scheme`, so the user's
explicit choice can override the OS setting. Store the preference (e.g. a cookie
read server-side, or a small inline script setting the class before first paint to
avoid a flash of the wrong theme) and default to `prefers-color-scheme` when no
preference has been set.

Do not simply invert colors.

Ensure:

* Contrast
* Borders
* Shadows
* Status colors
* Form controls
* Navigation

remain usable.

---

## Avoid Custom CSS

Prefer Tailwind utilities.

Use custom CSS only when:

* Tailwind cannot reasonably express the behavior
* A reusable design primitive requires it
* A third-party integration requires it

Do not create large CSS files that duplicate Tailwind functionality.

---

## UI Quality Check

Before completing UI work, inspect:

* Alignment
* Spacing
* Typography
* Responsive behavior
* Focus states
* Hover states
* Loading states
* Error states
* Empty states
* Mobile layout

The UI should look intentional rather than merely functional.

---

## Definition of Done

UI work is complete when:

* Layout is responsive.
* Components follow the design system.
* Colors reference semantic tokens, not raw palette values, in template markup.
* Accessibility is considered.
* Interactive states are implemented.
* Mobile behavior is intentional.
* No unnecessary custom CSS exists.
* Visual hierarchy is clear.

