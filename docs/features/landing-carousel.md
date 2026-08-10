# Feature: Landing Page Image Carousel

## Status

`Proposed`

## Summary

A hand-curated image carousel (up to 5 slides) in its own section below the hero
on the landing page (`/`) — each slide is an image with an optional caption and an
optional link. Autoplays with a visible pause/play control, full keyboard and touch
support, and respects `prefers-reduced-motion`.

## Problem / Motivation

The landing page's hero and everything below it is still undesigned (see
`docs/features/landing-page.md`'s Open Questions) — right now `/` renders the bare
placeholder page. A carousel gives the landing page a second, visually rich section
beyond the hero: general-purpose enough to show photos, project highlights, or
whatever the site owner wants surfaced first, without needing the Projects/Blogs
features (or a database schema) built first. Content is hand-authored in Go for now
— see Open Questions for when that stops being enough.

## Scope

**In scope:**

* A carousel component rendered in its own section below the hero on `/`, with up
  to 5 slides.
* Each slide: one image (required, with required `alt` text), an optional caption,
  and an optional link (internal or external).
* Prev/next arrow controls and dot indicators, both keyboard- and pointer-operable.
* Autoplay with a visible pause/play toggle; pauses on hover, keyboard focus, and
  whenever the carousel is scrolled out of the viewport (also covers touch
  devices, which have no hover state); a manual pause (via the toggle) stays
  paused until the user resumes it.
* Touch swipe navigation on mobile.
* `prefers-reduced-motion`: autoplay never starts; the carousel renders static on
  the first slide with manual navigation only.
* Responsive layout: consistent image aspect ratio and `object-fit: cover` across
  breakpoints, spacing consistent with `tailwind-ui`'s scale.
* A decorative artistic background behind the carousel card itself (not the
  page/hero) — a soft abstract gradient-and-glow illustration, light/dark
  theme-aware, purely CSS `background-image` with no accessibility role of
  its own (see Visual Direction and Business Rules).

**Out of scope:**

* Postgres-backed / admin-editable slide content — slides are static image files
  and hand-authored Go data for now (see Open Questions).
* The hero itself and any other landing-page section — separate, still-undesigned
  scope owned by `docs/features/landing-page.md`.
* Video slides, more than 5 images, or a full-screen/lightbox view on click.
* Deep-linking to a specific slide (e.g. via URL fragment).

---

## User Flow

```text
1. User loads `/`. Below the hero, the carousel section renders showing slide 1,
   dot indicators (5, one per slide, first marked active), prev/next arrows, and a
   pause button (autoplay is already running).
2. After a fixed interval, the carousel auto-advances to the next slide, looping
   back to slide 1 after the last. Dot indicators update to match.
3. User hovers the carousel, or moves keyboard focus into it → autoplay pauses
   automatically; moving the pointer/focus away resumes it.
4. User clicks the pause button → autoplay stops and the button becomes a play
   button; this state persists (does not auto-resume on hover-out) until the user
   clicks play again.
5. User clicks an arrow, a dot indicator, or swipes on mobile → carousel navigates
   directly to the requested slide; if autoplay was running, the interval timer
   resets from that point.
6. User clicks a slide's link (if it has one) → navigates to that URL; external
   links open in a new tab.
7. A user with `prefers-reduced-motion` enabled loads `/` → the carousel never
   autoplays; no pause/play button is shown (nothing to toggle); slide 1 renders
   and the user navigates entirely via arrows, dots, or swipe.
```

---

## Visual Direction

Follows `tailwind-ui`'s Visual Style (modern, calm, personal, premium without
excess) and its Cards/Spacing guidance:

* **Container**: same `max-w-5xl` content width as the rest of the page (per
  `home.md`), with generous vertical spacing (`py-12`/`py-16`-scale) separating it
  from the hero above and whatever follows below — the carousel should read as its
  own breathing section, not squeezed against neighboring content.
* **Image frame**: a fixed aspect ratio (e.g. `aspect-[16/9]`) so the section
  doesn't jump in height between slides of different source dimensions;
  `object-cover` on the `<img>`; rounded corners consistent with the card radius
  token (`rounded-xl`/`rounded-card`), not full-bleed edge-to-edge.
* **Caption**: rendered as a subtle overlay gradient at the image's bottom edge
  (dark scrim behind light text) rather than a separate text block below the image
  — keeps the section compact and reads as one visual unit, not image + caption
  card stacked in a way that increases the section's total height per slide.
* **Arrows**: circular icon buttons, semi-transparent surface, absolutely
  positioned over the image but as DOM siblings of the slide's anchor — never
  nested inside it (see Business Rules) — inset from the left/right edges (not
  flush against the frame border), with enough padding around the icon glyph
  itself for a comfortable touch target.
* **Dot indicators**: centered below the image frame, adequate spacing between
  dots for touch targets, active dot visually distinct (size or fill, not color
  alone — see Accessibility).
* **Pause/play toggle**: small icon button, positioned with the dot indicators
  (e.g. trailing edge of that row) rather than competing with the prev/next arrows
  for visual weight.
* Short (150–200ms) opacity/transform transition between slides, never a hard cut;
  skipped entirely under `prefers-reduced-motion` (moot for autoplay itself, but
  also applies to manual/arrow/dot navigation).
* **Decorative backdrop**: the outer `#carousel` section (not just
  `#carousel-frame`) carries its own `background-image` — a soft abstract
  gradient-and-glow illustration (`web/static/images/landing-bg-light.svg` /
  `landing-bg-dark.svg`, swapped via the `dark:` variant per `tailwind-ui`'s
  Dark Mode section) sharing the carousel illustrations' palette, so it reads
  as one cohesive art direction rather than a mismatched addition. The section
  gets its own horizontal/vertical padding (beyond `#carousel-frame`'s own
  edges) specifically so this artwork is visible as a "mat" around the frame
  and the dots/toggle row, plus `rounded-card`/`border-line`/`shadow-sm` — the
  same card treatment used elsewhere in the shell (e.g. `resume-summary.html`)
  — so the whole section reads as one card, not a background image floating
  behind loose controls.
* **Page background (adjacent, not carousel-specific)**: `landing.html` also
  renders a decorative full-bleed backdrop behind the hero text and the
  carousel — `web/static/images/landing-page-bg-light.svg` /
  `landing-page-bg-dark.svg`. This palette (and the fact that it's a color
  gradient at all, distinct from the carousel illustrations' navy/accent-blue
  system) is a deliberate, explicit design request, not an oversight — kept
  soft/muted rather than saturated primary colors, per "professional and
  creative, softer colors, eye-catching, and a gradient."
  * **Technique**: dark mode's base is a true SVG `linearGradient` (5 color
    stops, diagonal sweep) — chosen specifically over the earlier approaches
    below, since a native gradient is smooth by construction, with zero risk
    of the blob/seam/mud failure modes that follow. Light mode's base is now
    a flat single-color fill instead (see its own entry below — the
    one-color constraint leaves no second hue for a gradient to sweep
    between). Both themes layer a handful of large, soft `radialGradient`
    glow circles on top at varied opacity for depth/movement, plus a light
    dusting of fine grain-texture dots for a tactile finish.
  * **Light mode**: exactly one color, by explicit request — a single warm
    cream (`#E7D8AE`) layered over a lighter cream base (`#FBF7EC`, not pure
    white) at five deliberately varied opacities (~0.10–0.45). No
    `linearGradient` at all here, unlike dark mode — the base is a flat fill,
    and every bit of depth/movement comes from that one accent's opacity
    layering, since a second gradient hue would violate the one-color
    constraint. Superseded revisions, not to be reintroduced: a two-color
    cream + creamy-yellow version; before that a 5-stop pastel wash
    (periwinkle → orchid → blush → peach → cream) that tinted the whole
    canvas evenly and read as flat/washed out; and before that a "mostly
    white with a bold violet/magenta/orange corner bloom" version — each
    superseded by a follow-up request narrowing the palette further, not by
    a technical problem with that revision.
  * **Dark mode**: deep indigo → violet → magenta-plum → warm amber → umber
    — richer/more saturated at each stop than a naive "darken the light
    palette" pass would produce; muted jewel tones transitioning directly
    into each other read as brown mud (shipped once, corrected) — matching
    `tailwind-ui`'s Dark Mode guidance to design it as its own first-class
    theme, not an inversion or a shared-gradient-recolor of light mode.
  * **Earlier revisions, not to be re-tried**: (1) a constellation/line-graph
    illustration read as a generic "tech network diagram," not art; (2) an
    orange/pink/blue *pool*-based version (overlapping `radialGradient`
    circles with gaps between them, no continuous base gradient) had a
    two-tier opacity falloff that produced a visible ring artifact where two
    circles' edges coincided, and an evenly-spaced layout that read as
    mechanical rather than abstract; (3) a version using `feGaussianBlur`
    with large `stroke-width` produced a visible hard-edged rectangular seam
    in Chromium (large blur combined with large stroke-width on an elongated
    bounding box hit a filter-region/tiling artifact) — this is why the
    shipped version avoids `feGaussianBlur` entirely; (4) tinting the whole
    light-mode canvas evenly with pastels (see above) read as flat/washed out.

  It's a full viewport-width layer, not confined to `#main-content`'s own
  `max-w-5xl` column — see "Full-bleed technique" below for why and how.
  This is really `docs/features/landing-page.md`'s territory (that doc owns
  "what renders inside `#main-content`" for `/`) — documented here because
  it shipped alongside the carousel work and touches the same `landing.html`
  file; `landing-page.md` cross-references this, but still owns the actual
  hero copy/headline/CTA decision, which remains open.
* **Full-bleed technique**: a plain `background-image` directly on
  `#main-content` confines the artwork to that element's own `max-w-5xl`
  column — visually barely bigger than the carousel card itself, not an
  actual page backdrop (this shipped once, looked wrong, and was corrected).
  Instead, the artwork is a `<div aria-hidden="true">`, absolutely positioned
  as `#main-content`'s first child and broken out to full viewport width via
  the standard `left-1/2 w-screen -translate-x-1/2` technique, `-z-10` so it
  paints behind the in-flow hero text/carousel without needing z-index on
  them. `#main-content` itself only gains `relative` (the positioning anchor)
  and `isolate` (so `-z-10` can't paint below unrelated shell elements like
  the footer) — every class the outerHTML-swap contract requires (`mx-auto`,
  `max-w-5xl`, `px-4`, `py-8`) is untouched, and it's still the sole element
  `landing-content` defines. `base.html`'s `<body>` carries
  `overflow-x-hidden` specifically because of this: `w-screen` can be a few
  pixels wider than the viewport on desktop browsers whose scrollbar isn't an
  overlay (100vw includes the scrollbar gutter), which would otherwise add a
  stray site-wide horizontal scroll range.

---

## UI

```text
web/templates/
├── pages/
│   └── landing.html          # defines "landing-content" (PagesHandler.Home sets
│                              # ContentTemplate to this) — the hero placeholder
│                              # text plus <section id="carousel"> below it; the
│                              # hero itself is still undesigned, see landing-page.md
└── components/
    └── carousel.html         # up to 5 slides; each takes {ImagePath, Alt, Caption?, LinkURL?}

web/static/
├── images/
│   ├── carousel/
│   │   └── 1.svg … 5.svg     # hand-authored illustrative SVGs (not photos) — see
│   │                          # Data Model; swap for real photography/screenshots later
│   ├── landing-bg-light.svg       # decorative backdrop behind the carousel card
│   ├── landing-bg-dark.svg        # (Visual Direction) — referenced only from carousel.html's CSS
│   ├── landing-page-bg-light.svg  # decorative backdrop behind the whole #main-content
│   └── landing-page-bg-dark.svg   # area (Visual Direction) — referenced only from landing.html's CSS
└── js/
    └── carousel.js           # autoplay timer, pause/resume, keyboard, swipe
```

The first slide's `<img>` loads eagerly (`loading="eager"`, optionally
`fetchpriority="high"`); slides 2–5 use `loading="lazy"` — the section sits
directly below the hero, likely near the initial viewport, so five eagerly
loaded full-size images would otherwise risk hurting the landing page's LCP.

States this feature's UI must handle:

| State                          | Behavior |
| -------------------------------- | -------- |
| Autoplay running                 | Advances on a timer; pause button shown; dot for the current slide is active. |
| Hover/focus/offscreen-paused      | Timer paused while pointer hovers, keyboard focus is inside the carousel, or the carousel has scrolled out of view; resumes when that condition clears, unless also user-paused. |
| User-paused                      | Timer stopped via the pause button; stays stopped (no auto-resume on hover-out or scrolling back into view) until the play button is clicked. |
| Manual navigation (arrow/dot/swipe) | Jumps directly to the requested slide; if autoplay was running, its interval resets. |
| Reduced motion                   | No autoplay, no pause/play button; manual navigation only; no slide transition animation. |
| Slide with a link                | The slide's anchor wraps only its image and caption — never the arrow/dot/pause controls, which are DOM siblings positioned over the carousel, not nested inside any slide's link. |
| Fewer than 5 slides configured   | With exactly 1 slide, arrows, dots, and the pause/play toggle are omitted entirely (nothing to navigate to or pause); with 2–4 slides, all controls render normally, just with fewer dots. |
| Image failed to load              | Broken slide shows a neutral placeholder background (not a broken-image icon) so one bad asset doesn't visually break the section. |
| Keyboard focus                    | Visible focus ring on arrows, the active dot, the pause/play toggle, and any slide link. |

---

## Implementation Contract (DOM / Data)

Fixed up front so the markup/template work and the `carousel.js` work can proceed
independently — `carousel.js` should be written and tested against this contract
(e.g. a standalone HTML fixture), not against the live Go template, and integration
is just wiring the two together at the end.

**Go-side data shape**, passed into `carousel.html` as `.CarouselSlides` (a
`[]CarouselSlide`, max 5 entries) from whichever handler owns `/`:

```go
type CarouselSlide struct {
    ImagePath string // e.g. "/static/images/carousel/1.svg" — any format <img> supports
    Alt       string // required
    Caption   string // optional, "" if none
    LinkURL   string // optional, "" if none
    External  bool   // true if LinkURL is off-site; drives target/rel
}
```

**DOM structure and hooks** (`carousel.html`'s output):

```text
<section id="carousel" role="region" aria-roledescription="carousel"
         aria-label="Featured images" data-autoplay-interval="6000">
  <div id="carousel-frame">                 <!-- positioning context for arrows -->
    <div id="carousel-track">
      <!-- one per slide, 1-indexed -->
      <div class="carousel-slide" data-index="1"
           role="group" aria-roledescription="slide" aria-label="1 of 5">
        <!-- if LinkURL set: <a href=...> wraps ONLY the <img> + caption -->
        <!-- if not: <img> + caption render directly, no <a> -->
      </div>
      ...
    </div>
    <button id="carousel-prev" aria-label="Previous slide">...</button>
    <button id="carousel-next" aria-label="Next slide">...</button>
    <!-- prev/next are siblings of .carousel-slide, never inside a slide's <a> -->
  </div>
  <div id="carousel-dots">
    <button class="carousel-dot" data-index="1" aria-label="Go to slide 1"
            aria-current="true" tabindex="0">...</button>
    <button class="carousel-dot" data-index="2" aria-label="Go to slide 2"
            tabindex="-1">...</button>
    ...
  </div>
  <button id="carousel-toggle" aria-label="Pause autoplay" data-state="playing">...</button>
</section>
```

**Conventions `carousel.js` relies on, and `carousel.html` must produce:**

* `data-autoplay-interval` (ms) on `#carousel` — JS reads this rather than a
  hardcoded constant, so the interval is tunable without touching JS.
* `.carousel-slide[data-index]`, `.carousel-dot[data-index]` — 1-indexed, matching
  `aria-label="{n} of {total}"`.
* Exactly one dot has `tabindex="0"`/`aria-current="true"` at any time (server
  renders slide 1's dot this way for the no-JS baseline; JS moves it thereafter).
* `#carousel-prev` / `#carousel-next` / `#carousel-dots` / `#carousel-toggle` are
  DOM siblings of `.carousel-slide`, never descendants of a slide's `<a>` — see
  Business Rules' nested-interactive-element rule.
* `#carousel-toggle`'s `aria-label` and `data-state` are the only things JS needs
  to swap between play/pause — it doesn't swap icon markup structure.
* If `.CarouselSlides` has exactly 1 entry, `carousel.html` omits
  `#carousel-prev`, `#carousel-next`, `#carousel-dots`, and `#carousel-toggle`
  entirely — `carousel.js` should no-op gracefully if it doesn't find them
  (defensive, but shouldn't be exercised given the server-side omission).
* Reduced-motion is a `carousel.js` runtime check (`matchMedia`), not a
  server-render distinction — `carousel.html` always renders the full control
  set (except the 1-slide case above); JS removes/no-ops the autoplay-related
  parts (skips starting the timer, hides `#carousel-toggle`) when the media
  query matches at init.
* **Transition mechanism (crossfade, not a sliding track)**: `#carousel-track`
  is `position: relative`; every `.carousel-slide` is absolutely positioned
  (`inset-0`) and stacked on top of each other. `carousel.html` renders slide 1
  with `opacity-100 z-10` and every other slide with `opacity-0 z-0
  pointer-events-none aria-hidden="true"` as its initial server-rendered state
  — this is also the correct no-JS degraded state (see Degradation below), not
  just a JS starting point. `carousel.js` moves those same classes/attributes
  (never restructures the DOM) when the active slide changes, with a
  150–200ms opacity transition (Tailwind `transition-opacity duration-150`),
  skipped under reduced motion per the Visual Direction.

---

## Client-side Behavior (non-HTMX)

The carousel has no server round-trip — content is static per-request, so this is
entirely presentation/interaction state, out of HTMX's model the same way
`header-scroll.js` and `theme-toggle.js` are (`htmx-ui`'s "avoid unnecessary
JavaScript" scoped exception).

`carousel.js`, following the WAI-ARIA APG carousel pattern:

* **Structure/ARIA**: root has `role="region"`, `aria-roledescription="carousel"`,
  and an `aria-label` (e.g. "Featured images"); each slide is
  `role="group"`/`aria-roledescription="slide"` with an
  `aria-label="{n} of {total}"`; dot indicators are buttons with
  `aria-label="Go to slide {n}"` and `aria-current="true"` on the active one.
* **Roving tabindex on dot indicators**: only the active dot is a `Tab` stop
  (`tabindex="0"`); the rest are `tabindex="-1"`. With focus on a dot,
  `ArrowLeft`/`ArrowRight` move both the roving tabindex and the DOM focus to
  the adjacent dot and navigate to that slide, per the WAI-ARIA APG
  tabs/carousel roving-tabindex convention. This keeps the carousel to a small,
  fixed number of `Tab` stops (prev arrow, active dot, next arrow, pause
  toggle) regardless of how many slides are configured.
* **Autoplay**: a single `setInterval`-driven timer, disabled entirely at
  initialization when `prefers-reduced-motion: reduce` matches (WCAG 2.2.2 —
  content that auto-updates must be pausable; here it's simplest to never start it
  for that audience rather than start-then-immediately-offer-pause).
* **Pause sources**: tracks three independent flags — `hoverPaused` (pointer
  hover or `:focus-within`), `userPaused` (explicit toggle click), and
  `offscreenPaused` (an `IntersectionObserver` on the carousel root, so
  autoplay doesn't run — or burn CPU/network — while the section is scrolled
  out of view; this also covers touch devices, which have no hover state to
  pause on otherwise). The timer runs only when all three are false; hover-out
  and scrolling back into view each clear their own flag but never `userPaused`.
* **Live region announcements**: per the APG pattern, the slide container's
  `aria-live` is `"off"` while autoplay is actively running (announcing every
  auto-advance would be disruptive to screen reader users) and set to `"polite"`
  once paused (by any source), so a manually triggered slide change is announced.
* **Keyboard**: when focus is inside the carousel, `ArrowLeft`/`ArrowRight` move to
  the previous/next slide (in addition to the roving-tabindex dot behavior above);
  prev/next arrows and the pause toggle are each a normal `Tab` stop.
* **Touch swipe**: `touchstart`/`touchend` delta past a threshold triggers
  prev/next, same as the arrow controls — does not hijack vertical scroll gestures.
* **Interval reset on manual navigation**: any manual navigation (arrow, dot,
  swipe) restarts the autoplay timer from that point rather than advancing again
  almost immediately.

Degradation: with `carousel.js` disabled, all 5 slides render (server-side markup
isn't hidden pending JS) but only the first is visually reachable without
JavaScript — acceptable given this mirrors the existing JS-dependent pieces of the
shell (mobile nav panel, theme toggle); a future improvement could stack slides as
a plain scrollable strip as a true no-JS fallback, but that's not required for this
feature to ship.

---

## Routes / Handlers

None. The carousel has no dedicated endpoint — it's static markup rendered as part
of whichever handler owns `/` (`PagesHandler.Home`, per `internal/handler/pages.go`;
`docs/features/home.md`'s Routes/Handlers table names this `HomeHandler.Index`, which
predates the actual implementation).

---

## Data Model

None. Slide images are static files (`web/static/images/carousel/`); alt text,
captions, and links are hand-authored in Go (`PagesHandler.Home`'s
`landingCarouselSlides`, `internal/handler/pages.go`) for now — see Open Questions
for when/if this needs to move to Postgres.

---

## Business Rules / Validation

* Maximum 5 slides — enforced by what's hand-placed in `landingCarouselSlides`
  (`internal/handler/pages.go`), not runtime validation (there's no user input
  path that could exceed it).
* With exactly 1 slide configured, no navigation controls (arrows, dots,
  pause/play) render — the section degrades to a single static image with no
  carousel affordances, rather than showing chrome with nothing to do.
* Every slide's `<img>` has non-empty, descriptive `alt` text — required at
  authoring time since there's no guaranteed caption to fall back on for meaning.
* A slide's anchor (if it has a link) wraps only its image and caption — arrow,
  dot, and pause/play controls must never be nested inside a slide's `<a>`, to
  avoid invalid nested-interactive-element markup and overlapping click targets.
  They're positioned visually over the slide via CSS but live as DOM siblings of
  the anchor, not children of it.
* A slide's link, if present, follows `home.md`'s external-link convention:
  external URLs get `target="_blank" rel="noopener noreferrer"`; internal links
  behave like normal same-site navigation (a full page load is acceptable here —
  this is not part of the SPA-style HTMX nav in `home.md`, since it's leaving the
  landing page content area, not swapping `#main-content`).
* A user-initiated pause (button click) never auto-resumes from a hover-out,
  blur, or scrolling back into view — only clicking play again resumes autoplay.
* Autoplay never starts when `prefers-reduced-motion: reduce` is set, checked once
  at initialization (this feature does not need to react to the preference
  changing mid-session).
* The first slide's image loads eagerly; slides 2–5 use `loading="lazy"` (see UI).
* The decorative backdrop (`landing-bg-*.svg`) is a plain CSS `background-image`,
  never an `<img>` — it carries no `alt` text and is invisible to assistive
  technology by construction, which is correct here: it's pure ornament with no
  informational content, unlike the carousel's actual slide images. The same
  applies to `landing-page-bg-*.svg` on `#main-content`.
* The page background sits behind the "Welcome" hero placeholder text, not just
  the carousel — its node/line density was deliberately kept low enough that
  `ContentTitle`/`ContentMessage` (`text-slate-900 dark:text-slate-100` /
  `text-slate-600 dark:text-slate-400`) stay legible without needing a scrim;
  revisit this if that copy is ever replaced with something requiring stronger
  contrast guarantees (see `landing-page.md`'s Open Questions).

---

## Security Considerations

* **No dynamic/untrusted input**: slide captions and links are hand-authored in
  Go code (`internal/handler/pages.go`), and images are static asset files —
  neither is sourced from user input or the database, so there's no escaping
  concern beyond what `html/template` already guarantees by default for any Go
  value passed into a template. This changes if slides become DB-driven (see
  Open Questions), at which point captions/links must go through the same
  auto-escaping as any other dynamic content, same as `home.md`'s note on the
  header identity fields.
* **External links**: `rel="noopener noreferrer"` on any slide link that opens in
  a new tab, consistent with `home.md`'s footer social links.
* **No inline `<script>` tags**: `carousel.js` is an external file, keeping the
  page compatible with the strict CSP already in place for the rest of the shell
  (`home.md`'s Security Considerations).

---

## Testing Plan

* [ ] All 5 slides render with correct images, alt text, captions, and links.
* [ ] Autoplay advances slides on a timer and loops from the last slide back to
      the first.
* [ ] Hovering or focusing inside the carousel pauses autoplay; leaving
      hover/focus resumes it, unless also user-paused.
* [ ] Scrolling the carousel out of the viewport pauses autoplay; scrolling it
      back into view resumes it, unless also user-paused.
* [ ] Clicking the pause button stops autoplay and stays stopped across a
      hover-out or scroll-out/back-in; clicking play resumes it.
* [ ] Arrow buttons, dot indicators, and touch swipe all navigate correctly and
      reset the autoplay interval.
* [ ] Keyboard-only: `Tab` reaches prev arrow, the active dot, next arrow, and
      pause/play toggle as a small fixed set of stops (not one stop per dot);
      `ArrowLeft`/`ArrowRight` move the roving-tabindex dot and navigate slides
      when focus is on a dot, and also navigate slides when focus is elsewhere in
      the carousel; focus rings are visible throughout.
* [ ] `prefers-reduced-motion`: autoplay never starts, no pause/play control is
      rendered, and no slide-transition animation plays on manual navigation.
* [ ] Screen reader: `aria-live` on the slide region is `"off"` while autoplay
      runs and `"polite"` once paused; dot indicators expose the active slide via
      `aria-current`.
* [ ] A slide with no link is not wrapped in an anchor; a slide with a link is
      fully keyboard-reachable, external links open in a new tab, and the arrow/
      dot/pause controls are never nested inside the slide's `<a>` (inspect the
      rendered DOM, not just visual position).
* [ ] Overlay caption text meets WCAG AA contrast (4.5:1) against its scrim on
      every slide currently in use, not just a spot check on one — matters more
      once real photography/screenshots replace the current illustrations,
      which are dark by design.
* [ ] Only the first slide's image loads eagerly; slides 2–5 use `loading="lazy"`
      (verify via network waterfall, not just markup inspection).
* [ ] A single configured slide renders with no arrows, dots, or pause/play
      control.
* [ ] Simulated image load failure on one slide shows a neutral placeholder
      instead of a broken-image icon, without breaking navigation to other slides.
* [ ] Layout (aspect ratio, spacing, arrow/dot positioning) holds correctly across
      mobile, tablet, and desktop breakpoints — including WebKit, per `home.md`'s
      precedent of Safari-specific nav bugs.
* [ ] The decorative backdrop swaps between `landing-bg-light.svg` and
      `landing-bg-dark.svg` correctly on theme toggle, with no flash of the wrong
      variant on initial load in either theme.
* [ ] Prev/next arrows, dots, and the pause/play toggle remain legible (contrast,
      focus rings) against the backdrop in both themes, not just against
      `#carousel-frame`'s own opaque background.
* [ ] The page background (`landing-page-bg-*.svg`) swaps correctly on theme
      toggle with no flash of the wrong variant, and the "Welcome" hero text
      stays clearly legible against it in both themes.

---

## Open Questions

* Should slide content (images, captions, links) move to Postgres once a
  Settings/Profile admin area exists (per `home.md`'s Scope), so the site owner
  can update the carousel without a redeploy? Out of scope for this doc's first
  version — revisit once that admin area is actually built.
* Does the carousel belong on `/` specifically, or could it become a reusable
  component other pages (e.g. Projects) also mount? Scoped to the landing page
  only for now.
* Exact autoplay interval (e.g. 5s vs 7s) and transition duration — left as an
  implementation detail to tune visually rather than a decision to pre-specify
  here.

---

## Definition of Done

* [ ] User flow works end-to-end, including reduced-motion and all pause/resume
      paths above.
* [ ] All states in the UI table are implemented.
* [ ] Fully keyboard operable, with correct ARIA roles/labels/live-region
      behavior per the WAI-ARIA carousel pattern.
* [ ] Touch swipe works on mobile; arrows/dots work on desktop.
* [ ] No inline `<script>` tags; CSP stays clean.
* [ ] External slide links use `rel="noopener noreferrer"`.
* [ ] Accessibility checked (focus visibility, contrast on overlay captions,
      reduced-motion respected, screen reader announcement behavior).
* [ ] Tests cover the behavior in the Testing Plan above.
* [ ] No open questions remain unresolved, or are explicitly deferred with a
      reason (e.g. Postgres migration deferred until the admin area exists).
