// Print button click handler for /resume's export row (docs/features/
// resume-export.md). The row's other two entries (Download PDF/Word) are
// plain <a href> links straight to internal/handler/resume_export.go's
// routes and need no JS at all — only Print, which has no URL of its own
// to link to, needs a click handler. Loaded only from resume.html itself,
// not globally on every page — see that page's own
// <script src="/static/js/resume-print.js" defer> tag.
//
// External file, no inline handler, per this codebase's CSP-compatible
// convention (see theme-toggle.js, header-scroll.js): printing has no
// server round trip, so this is plain JS rather than an HTMX request.
document.getElementById('resume-print-button')?.addEventListener('click', () => {
	window.print();
});
