// Print button click handler for /resume (docs/features/resume.md).
// Loaded only from resume.html itself, not globally on every page — see
// that page's own <script src="/static/js/resume-print.js" defer> tag.
//
// External file, no inline handler, per this codebase's CSP-compatible
// convention (see theme-toggle.js, header-scroll.js): printing has no
// server round trip, so this is plain JS rather than an HTMX request.
document.getElementById('resume-print-button')?.addEventListener('click', () => {
	window.print();
});
