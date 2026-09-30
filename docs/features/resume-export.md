# Feature: Resume Export (PDF / Word)

## Status

`Implemented` — PDF and Word downloads work end to end locally, covered by
unit, DB-backed end-to-end, and Playwright (Chromium + WebKit) tests. Not
yet verified on the deployed site; see Definition of Done.

## Summary

Extends `/resume`'s original "Print / Save as PDF" button into three export
options: a server-generated **PDF** styled after the live page's design, a
server-generated **Word (.docx)** with a plain, professional look, and the
existing browser **Print** (`window.print()`), kept as-is since it costs
nothing extra.

Both files are built in-process by pure Go code from the same resume data
`/resume` renders — no headless browser, no external binary, no second
service. Every visitor gets the same file regardless of their browser,
because no browser takes part in producing it.

## Problem / Motivation

The original print button only triggered the browser's native print dialog
— there was no way to get an actual PDF or Word file without manually
choosing "Save as PDF" from that dialog, and no Word option existed at all.
Recruiters and ATS systems commonly expect a downloadable `.docx`, and a
directly-downloadable PDF is both a better UX and lets the output be styled
more deliberately than `@media print` CSS alone allows.

## Decision: pure-Go PDF generation (replaces chromedp)

The first implementation rendered the PDF by driving headless Chrome
(`chromedp`) against a print-only `/resume/print` page. It shipped broken:
**every** visitor got `internal server error` from
`/resume/download.pdf` on the deployed site, whatever their browser. Render
runs this app on its native Go runtime, which has no Chrome binary, so
`chromedp` failed with `exec: "google-chrome": executable file not found`.
This doc had already listed "move Render to a Dockerfile with Chromium" as
a prerequisite, but that step was never done, and nothing caught its
absence:

* Every test — handler unit tests, the DB-gated end-to-end test, the
  routing tests — injected a fake PDF generator, so the real renderer never
  ran under test.
* Tests ran on a developer Mac that *has* Chrome, so even a real-renderer
  test would have passed locally.
* The Playwright suite had no download tests, and still asserted the old
  button's "Print / Save as PDF" text (stale after the menu change).
* The renderer's startup warm-up discarded its error, so the server booted
  healthy and failed only on first click.

Options considered: keep `chromedp` and add a Dockerfile + Chromium;
generate the PDF client-side (`html2pdf`/`jsPDF` — rasterized, poor text
extractability for ATS, and browser-dependent); an external rendering
service (Gotenberg/DocRaptor — another dependency to run or pay for); or
build the PDF in pure Go. **Chosen: pure Go**, via
`codeberg.org/go-pdf/fpdf` (the maintained successor of `go-pdf/fpdf`/
`jung-kurt/gofpdf`). It mirrors the Word export's existing pattern
(`resume_docx.go`), adds no runtime dependency beyond the Go binary itself,
deploys on Render unchanged, and — most importantly — the real generator
runs in an ordinary `go test` anywhere, so the class of bug above can't
recur silently.

Tradeoff accepted: the PDF's design is re-expressed in Go layout code
rather than rendered from the live page's HTML/CSS, so a visual change to
`/resume` isn't automatically reflected in the PDF. See Business Rules.

## Scope

**In scope:**

* `GET /resume/download.pdf` — builds an A4 PDF from the resume data with
  `fpdf` (`internal/service/resume_pdf.go`) and returns it as
  `application/pdf`.
* `GET /resume/download.docx` — builds a `.docx` from the same data via
  `github.com/fumiama/go-docx` (`internal/service/resume_docx.go`), styled
  plainly (headings, bold company/role lines, bullet lists) — no attempt to
  match the site's branding.
* Replacing the single print button with three controls: Download PDF,
  Download Word, Print.

**Out of scope:**

* Editing/authoring export content — both formats always reflect whatever
  `/resume` currently renders from Postgres.
* Any format beyond PDF and Word.
* Async/background generation or caching — each request generates fresh
  and synchronously (a PDF takes tens of milliseconds).

---

## User Flow

```text
1. User navigates to /resume.
2. The export row above the banner shows: Download PDF, Download Word, Print.
3a. Download PDF  → browser downloads vincent-megia-resume.pdf, styled after
    the live page (terracotta banner, Caprasimo headings, cards, timeline).
3b. Download Word → browser downloads vincent-megia-resume.docx, a plain,
    professional document built from the same data.
3c. Print         → unchanged: window.print() opens the OS print dialog
    using the existing @media print stylesheet.
```

---

## UI

```text
web/templates/pages/
└── resume.html          # export row (two <a href> links + Print button)
                          # above the banner, still {{define "resume-content"}}

web/static/js/
└── resume-print.js      # window.print() handler for the Print button only;
                          # the download links need no JS
```

States this feature's UI must handle:

| State    | Behavior |
| -------- | -------- |
| Default  | Export row shows all three options. |
| Loading  | Not implemented. Generation is fast enough (tens of ms) that no visible loading state is needed in practice. |
| Error    | **Not yet implemented as designed.** A failure (realistically only an unreachable database — the same condition that breaks `/resume` itself) navigates to the plain-text `internal server error` response rather than showing an inline error near the export row. |

---

## HTMX Interactions

None — both downloads are plain `<a href>` links, not HTMX requests, since
the response is a binary file (`Content-Disposition: attachment`), not an
HTML fragment. Print is a non-HTMX `window.print()` click handler.

Confirmation required for destructive actions: none.

---

## Routes / Handlers

| Method | Path                    | Handler                            | Auth required | Notes |
| ------ | ----------------------- | ---------------------------------- | ------------- | ----- |
| GET    | `/resume/download.pdf`  | `ResumeExportHandler.DownloadPDF`  | no            | `ResumeService.GeneratePDF`, returns `application/pdf`. |
| GET    | `/resume/download.docx` | `ResumeExportHandler.DownloadWord` | no            | `ResumeService.GenerateDocx`, returns the `.docx` media type. |

Both share `ResumeService.fetch` with `ResumeService.Get` — the same two
repository queries, no new data-access path. Each generator is split into a
thin DB-reading method and a pure `build*` function over
`model.Profile`/`[]model.Role`, so the builders are unit-tested with
fixture data and no database.

---

## Data Model

None. Both exports derive entirely from the existing `resume_profile` /
`resume_roles` tables.

---

## Business Rules / Validation

* Both exports reflect exactly what `/resume` currently shows — no
  export-only content, no cached copies.
* **PDF design**: follows the live page's components card for card —
  banner, summary + stats, experience timeline (gutter line, per-role dot,
  "Current" badge, nested sub-project boxes with client chips), Core
  Expertise chips, Education, Featured Projects — using the light-mode
  Organic tokens from `app.css` and the site's own Caprasimo/Figtree fonts
  (static OFL TTFs embedded from `internal/service/pdffonts/`, since `fpdf`
  can't read the `.woff2` files served to browsers).
* **PDF reading order** is banner → summary → experience → Core Expertise →
  Education → Featured Projects: conventional résumé order, rather than a
  linearization of the on-screen two-column layout.
* **PDF pagination**: a card that fits on a page is never split across a
  page break (mirroring the print stylesheet's `break-inside: avoid`); a
  card taller than a whole page is split between its children, each page's
  piece getting its own background.
* **Not carried into the PDF**: per-card font presets
  (`resume-content-authoring.md`) — the PDF always uses the default Organic
  pairing, since supporting every preset would mean embedding eight more
  font files; contact-link icons; and the Featured Projects card's "See all
  projects" link (relative site navigation, meaningless in a file).
* **Keeping the PDF in sync**: because its layout is Go code, a visual
  change to the resume templates needs a matching change in
  `resume_pdf.go` if the PDF should follow.
* The Word document intentionally does **not** carry site branding —
  default Word-native styling only.
* A role with `end_date IS NULL` renders "Current"/"PRESENT" in both
  exports, same rule as the live page (`resume.md`'s Business Rules).
* `**bold**` mini-markup renders as real bold text in both exports (Figtree
  Bold runs in the PDF, bold runs in Word), via the one shared
  `parseBoldSegments` parser also behind the HTML `boldMarkup`.

---

## Security Considerations

* **Authz**: unauthenticated, matching `/resume` itself.
* **No user input**: both routes take no query params or body.
* **Rate limiting**: both routes are limited per IP (5/min, separate
  budgets) via `scoreSubmitLimiter` + `middleware.ClientKey`, matching every
  other unauthenticated route that does real per-request work.
* **Only safe link schemes become clickable**: resume content is editable
  via `/settings/resume`, so the PDF only creates link annotations for
  `http(s)://`, `mailto:` and `tel:` hrefs (`pdfLinkable`); anything else
  (e.g. `javascript:`) renders as plain text with no link.
* **No SSRF or subprocess surface**: generation is in-process Go; there's
  no browser, no URL fetch, no child process.
* **`Content-Disposition` filenames are hardcoded literals**, never built
  from resume data, so a stray CR/LF in content can't inject headers.
* **`.docx` text-escaping is verified by test**: raw `&`/`<` in content
  (e.g. "R&D") comes out XML-escaped, not as a corrupted document.
* **Fonts**: Caprasimo and Figtree are SIL OFL 1.1; license texts ship in
  `internal/service/pdffonts/`.
* **Secrets**: none introduced.

---

## Testing Plan

No test uses a fake generator — the real PDF/Word builders run in every
layer below.

* [x] `buildResumePDF` output parses as a PDF, and every section's content
      is extractable as text with an independent reader
      (`github.com/ledongthuc/pdf`) — including Current/PRESENT, bold runs
      without literal `**`, and raw `&`/`<` (`resume_pdf_test.go`).
* [x] A multi-page resume, including one role taller than a whole page,
      keeps every role and bullet across pages.
* [x] Only `http(s)`/`mailto`/`tel` hrefs become link annotations; a
      `javascript:` href never reaches the file.
* [x] An empty resume still produces a valid one-page PDF.
* [x] `buildResumeDocx` produces a valid zip with the expected content and
      XML-escaped special characters (`resume_docx_test.go`).
* [x] A generation failure returns a clean 500 with no attachment headers
      and no leaked error detail (`resume_export_test.go`).
* [x] Requests beyond the rate limit get 429 before reaching generation;
      another source is unaffected; PDF and Word budgets are independent.
* [x] Against a real seeded database, both routes return 200 with the right
      headers, and the downloaded PDF's text contains the seeded resume
      (`cmd/server/e2e_test.go`).
* [x] Clicking Download PDF / Download Word in a real browser saves a real
      PDF / `.docx` with the right filename, in both Chromium and WebKit
      (`e2e/resume.spec.js`).
* [x] Manual visual check of the generated PDF against the live page
      (rendered locally with macOS PDFKit, including a multi-page split).
* [ ] Smoke check against the deployed site after release:
      `curl -sI https://<site>/resume/download.pdf` returns 200 and
      `application/pdf`.
* [ ] Export row keyboard/accessibility check.

---

## Open Questions

* Exact Word-library choice (`github.com/fumiama/go-docx`) is a
  pseudo-versioned module with no tagged release — it has held up for
  nested bullets and bold runs so far; fall back to
  `github.com/lukasjarosch/go-docx` if it doesn't.

---

## Definition of Done

* [x] User flow works end to end for all three export options (locally).
* [ ] All states in the UI table are implemented — the inline error state
      is still outstanding.
* [x] Exports reuse the same `ResumeService` data access as `/resume`.
* [x] Both export routes are per-IP rate-limited.
* [ ] Verified on the deployed site, not just locally.
* [x] Handler/service boundaries followed (`go-backend`).
* [ ] Accessibility checked on the export row (keyboard, focus, contrast).
* [x] Tests cover the behavior in the Testing Plan above.
* [x] `go vet`/`go test` pass.
