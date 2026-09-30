# Feature: Resume Export (PDF / Word)

## Status

`Proposed`

## Summary

Extends `/resume`'s existing "Print / Save as PDF" button into a small
download menu offering three ways to get the resume offline: a server-
generated **PDF** built for visual fidelity to the live page's design, a
server-generated **Word (.docx)** built for a plain, professional look, and
the existing browser **Print** (`window.print()`), kept as-is since it costs
nothing extra.

## Problem / Motivation

The current print button only triggers the browser's native print dialog —
there's no way to get an actual PDF or Word file without a user manually
choosing "Save as PDF" from that dialog, and no Word option exists at all.
Recruiters and ATS systems commonly expect a downloadable `.docx`, and a
directly-downloadable PDF (rather than one round-tripped through the OS
print dialog) is both a better UX and lets the output be styled more
deliberately than `@media print` CSS alone allows.

## Scope

**In scope:**

* `GET /resume/download.pdf` — server-renders a print-optimized version of
  the resume through headless Chrome (`chromedp`) and streams it back as
  `application/pdf`, reusing the same `ResumeView` data and design tokens as
  the live page for close visual fidelity.
* `GET /resume/download.docx` — builds a `.docx` programmatically from
  `ResumeView` via `github.com/fumiama/go-docx`, styled plainly (headings,
  bold company/role lines, bullet lists) for a simple, professional look —
  no attempt to visually match the site's branding.
* Replacing the single print button with a small menu: Download PDF,
  Download Word, Print.
* A dedicated print/PDF HTML template (extending the current `@media print`
  block) that `chromedp` renders — this may absorb or replace the existing
  print stylesheet rather than living alongside it, to avoid maintaining two
  divergent print layouts.
* Deployment change: the Render web service needs a Chromium binary
  available at runtime for `chromedp`, which means moving from Render's
  native Go buildpack to a Dockerfile-based build. See Open Questions.

**Out of scope:**

* Editing/authoring export content — both formats always reflect whatever
  `/resume` currently renders from Postgres; no separate export-specific
  content.
* Any format beyond PDF and Word (e.g. plain text, LinkedIn-import format).
* Async/background generation, job queues, or caching generated files —
  each request generates fresh, synchronously, same as any other page
  render. Revisit only if `chromedp` latency proves too slow in practice
  (see Testing Plan).

---

## User Flow

```text
1. User navigates to /resume.
2. User clicks the export control (replacing today's single print button),
   which reveals three options: Download PDF, Download Word, Print.
3a. Download PDF  → browser downloads resume.pdf, server-rendered via
    headless Chrome from the print template, matching the site's visual
    design (terracotta banner, Caprasimo headings, accent colors).
3b. Download Word → browser downloads resume.docx, a plain, professional
    document (no site branding/colors) built directly from the same resume
    data.
3c. Print         → unchanged: window.print() opens the OS print dialog
    using the existing @media print stylesheet.
```

---

## UI

```text
web/templates/pages/
├── resume.html                  # export menu replaces the current print
│                                 # button; still {{define "resume-content"}}
└── resume-print.html            # new: standalone print-quality HTML page
                                  # chromedp navigates to / renders, sharing
                                  # resume-banner/-sidebar/-summary/-timeline
                                  # component data but its own top-level
                                  # layout (no header/nav/footer chrome)

web/static/js/
└── resume-print.js              # extended: menu open/close + the existing
                                  # window.print() handler for the Print item
```

States this feature's UI must handle:

| State    | Behavior |
| -------- | -------- |
| Default  | Export menu shows all three options. |
| Loading  | PDF/Word downloads take a real server round trip (unlike Print) — button shows a brief inline spinner/disabled state while the request is in flight. |
| Error    | PDF/Word generation failure (e.g. `chromedp` timeout) returns a small inline error near the menu, not a broken download or raw error page. |

---

## HTMX Interactions

None — both downloads are plain `<a href="/resume/download.pdf">` /
`<a href="/resume/download.docx">` links (or `<button>`s navigating to those
URLs), not HTMX requests, since the response is a binary file download
(`Content-Disposition: attachment`), not an HTML fragment. Print stays a
non-HTMX `window.print()` click handler as today.

Confirmation required for destructive actions:

* None — this feature has no destructive actions.

---

## Routes / Handlers

| Method | Path                    | Handler                     | Auth required | Notes |
| ------ | ------------------------ | ----------------------------- | ------------- | ----- |
| GET    | `/resume/download.pdf`  | `ResumeExportHandler.PDF`   | no            | Renders `resume-print.html` via `chromedp`, returns `application/pdf`. |
| GET    | `/resume/download.docx` | `ResumeExportHandler.Word`  | no            | Builds a `.docx` from `ResumeView`, returns `application/vnd.openxmlformats-officedocument.wordprocessingml.document`. |

Both reuse `ResumeService.Get` — no new data-access path.

How `chromedp` reaches `resume-print.html`'s rendered output is a deliberate
choice, not an implementation detail to improvise: render the template to
an HTML string in-process and hand it to `chromedp` directly (e.g. via
`page.setDocumentContent`), rather than having `chromedp` make an HTTP
round trip back to the server's own `/resume/print`. This avoids adding a
self-loopback network hop and a second publicly-routable page whose only
purpose is to be fetched by the server itself — even though that page would
expose nothing beyond what `/resume` already does, direct in-process
rendering is simpler and removes a moving part. If a loopback route turns
out to be necessary in practice (e.g. a `chromedp` API constraint), it must
bind to `127.0.0.1`, never a public hostname.

---

## Data Model

None. Both exports are derived entirely from the existing `resume_profile` /
`resume_roles` tables via the existing `ResumeService.Get`.

---

## Business Rules / Validation

* Both exports must reflect exactly what `/resume` currently shows — no
  export-only content, no stale/cached copies of the resume data.
* The Word document intentionally does **not** carry over site branding
  (colors, custom fonts) — "professional and simple" per the design goal
  means default Word-native styling (e.g. Calibri/Times-equivalent, black
  text, standard heading sizes), not a themed document.
* The PDF should closely match the live page's visual design (banner
  colors, accent tokens, Caprasimo headings) — it's the "pretty" artifact
  of the two.
* A role with `end_date IS NULL` still renders "Current"/"PRESENT" in both
  exports, same rule as the live page (`resume.md`'s Business Rules).
* `**bold**` mini-markup in summary paragraphs renders as actual bold text
  in both the PDF (already true via HTML `<b>`) and the Word doc (via a
  bold text run, not literal `**`).

---

## Security Considerations

* **Authz**: unauthenticated, matching `/resume` itself — no new auth
  surface.
* **No user input**: both routes take no query params or body; there's no
  injection surface into the `chromedp`-rendered page or the generated
  `.docx` beyond what `/resume` itself already trusts (owner-authored DB
  content, already escaped per `resume.md`'s Security Considerations).
* **Rate limiting — required, matching existing precedent**: these are
  unauthenticated `GET`s that each trigger real per-request work (a
  headless Chrome render, in the PDF case) — more expensive than any
  existing unauthenticated route in this app. Every other unauthenticated
  route doing non-trivial per-request work (`POST /fishing-game/score`,
  `/kitchen-shift/score`, `/library-game/score`) is already rate-limited
  per-IP via `scoreSubmitLimiter` + `middleware.ClientKey`
  (`internal/handler/fishing_game.go`); both export routes reuse that same
  pattern rather than shipping as the one unauthenticated route in the app
  with no limiter.
* **`chromedp` process lifecycle**: reuse a single long-lived
  `chromedp` allocator/browser across requests (one per-request *tab*, not
  one per-request *browser process*) — launching a fresh browser per
  request is slow (multi-second cold start) and turns every request into a
  fresh chance for a missed `cancel()` to leak a process. Each render still
  runs under its own bounded `context.WithTimeout` so a slow/hung render
  can't hold the shared browser hostage.
* **Concurrency cap**: a small semaphore bounding concurrent `chromedp`
  tabs (e.g. 1–2, generous for a personal site's expected traffic) so a
  burst of requests can't multiply Chrome's memory footprint past what
  Render's instance can hold.
* **`chromedp` isolation / no SSRF**: headless Chrome renders only the
  app's own `resume-print.html` template — never a user-supplied URL — so
  this doesn't introduce an SSRF vector regardless of how the template
  content reaches it (see the loopback-vs-direct-render note in Routes /
  Handlers).
* **`--no-sandbox` tradeoff, named explicitly**: running Chromium in a
  minimal Docker container will very likely require the `--no-sandbox`
  flag (containers typically lack the namespace/seccomp setup Chrome's own
  sandbox needs), which is a real reduction in Chrome's defense-in-depth.
  Accepted here specifically because `chromedp` only ever renders this
  app's own trusted, `html/template`-escaped output — never attacker-
  supplied HTML or a user-supplied URL — not as a general-purpose
  assumption.
* **Chromium provenance**: install Chromium in the Dockerfile from the base
  image's distro package repo (`apt-get install chromium`), not via
  `chromedp`'s optional auto-download of a browser binary from a URL at
  runtime — pinned the same deliberate way `go.sum` pins Go dependencies.
* **`Content-Disposition` filename is a hardcoded literal**: both handlers
  set a fixed filename (e.g. `"vincent-megia-resume.pdf"`), never one built
  from `ResumeView` data — even though that data is owner-authored,
  `resume.md`'s own precedent is "don't assume DB content is safe," and a
  stray CR/LF in a header value is a header-injection primitive however
  unlikely the content source.
* **`resume-print.html` reuses the existing trusted-escaping path**: it
  must call the same bold-markup converter and icon allowlist
  (`resume.md`'s Security Considerations) that `/resume` itself uses,
  rather than re-implementing rendering for the print template — a second,
  parallel HTML-assembly path for the same data is exactly how an escaping
  bug quietly gets introduced.
* **`.docx` text-escaping must be verified, not assumed**: `.docx` is XML
  under the hood; confirm `github.com/fumiama/go-docx` escapes `<`, `&`,
  `"` in text runs (e.g. seeded content containing "R&D" must not corrupt
  the generated file) — covered by a test mirroring `TestBoldMarkup`'s
  escaping check (see Testing Plan).
* **Secrets**: none introduced.

---

## Testing Plan

* [ ] `GET /resume/download.pdf` returns a valid PDF (`%PDF-` magic bytes,
      correct `Content-Type`/`Content-Disposition`) reflecting seeded resume
      content.
* [ ] `GET /resume/download.docx` returns a valid, openable `.docx`
      reflecting the same seeded content, including nested subprojects and
      the "Current" role badge equivalent.
* [ ] `**bold**` spans render as real bold runs in the Word doc, not literal
      asterisks.
* [ ] A `chromedp` render failure/timeout returns a clean error response
      (no partial file, no hung request) — bounded by a context timeout.
* [ ] Rapid repeated requests to `/resume/download.pdf` or `.docx` from one
      source are rate-limited (mirroring
      `TestFishingGameHandler_SubmitScore_RateLimited`'s pattern) — the
      limited request must not reach `chromedp`/the docx generator at all.
* [ ] A raw `&`/`<` in seeded resume content (e.g. "R&D") renders correctly
      escaped in the generated `.docx`, not as corrupted/invalid XML —
      mirroring `TestBoldMarkup`'s escaping check.
* [ ] `Content-Disposition`'s filename is verified to come from a hardcoded
      literal in the handler, never built from `ResumeView` data.
* [ ] Export menu (Download PDF / Download Word / Print) is keyboard-
      operable and matches the existing Print button's accessibility
      baseline.
* [ ] Manual visual check: the PDF closely matches the live `/resume` page's
      design; the Word doc opens cleanly in real Word/Google Docs with
      sane default styling.
* [ ] Load/latency check: measure real `chromedp` render time on Render's
      actual instance size before deciding if synchronous generation
      (Scope) stays acceptable.

---

## Open Questions

* **Render deployment**: no `Dockerfile`/`render.yaml` exists in this repo
  today — the service currently deploys via Render's native Go buildpack.
  Shipping `chromedp` requires a Chromium binary present at runtime, which
  means introducing a `Dockerfile` (e.g. based on a Go build stage plus an
  `apt-get install chromium` runtime stage) and switching the Render
  service's build method — a real infra change outside this repo's Go code,
  to be done deliberately and verified against Render's actual instance
  size/memory limits before this ships.
* **`chromedp`'s memory footprint on Render's current plan** — headless
  Chrome is heavier than anything this app runs today; needs a real check
  against whatever Render tier is in use, not just an assumption it fits.
* Exact Word-library choice (`github.com/fumiama/go-docx`) is a pseudo-
  versioned module with no tagged release — confirm it covers everything
  needed (nested bullet lists, bold runs, basic tables for the skills
  section) during implementation; fall back to
  `github.com/lukasjarosch/go-docx` (tagged releases, but template/
  placeholder-oriented rather than build-from-scratch) if it doesn't hold up.

---

## Definition of Done

* [ ] User flow works end-to-end for all three export options.
* [ ] All states in the UI table are implemented (default/loading/error).
* [ ] `ResumeExportHandler` reuses `ResumeService.Get` — no duplicated data
      access.
* [ ] `chromedp` calls are timeout-bounded, reuse a single long-lived
      browser instance, and don't leak processes.
* [ ] Both export routes are per-IP rate-limited and bounded by a
      concurrency cap on simultaneous `chromedp` tabs.
* [ ] Render deployment updated (Dockerfile + Chromium) and verified live,
      not just locally.
* [ ] Handler/service boundaries followed (`go-backend`).
* [ ] Accessibility checked on the new export menu (keyboard, focus,
      contrast).
* [ ] Tests cover the behavior in the Testing Plan above.
* [ ] `go vet`/`go test` pass.
* [ ] No open questions remain unresolved.
