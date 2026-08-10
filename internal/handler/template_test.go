package handler

import (
	"html/template"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/vincentmegia/vincentmegia/internal/model"
	"github.com/vincentmegia/vincentmegia/internal/service"
)

// mainContentPattern matches the #main-content container's opening tag,
// wherever it appears — base.html (full-page path) or a content template
// itself (fragment path, see assertMainContentContainer).
var mainContentPattern = regexp.MustCompile(`<main id="main-content" class="([^"]*)">`)

// assertMainContentContainer verifies a rendered response contains
// exactly one #main-content element carrying the shared container classes
// (mx-auto/max-w-5xl/px-4/py-8, per docs/features/home.md's "Container
// width" rule). Regression coverage for a real, previously-shipped bug:
// hx-swap="outerHTML" replaces the *entire* #main-content element with
// the server's fragment response, so a content template that renders only
// its inner content — relying on base.html to supply the wrapper, as this
// codebase used to do — loses #main-content's classes entirely on every
// HTMX nav swap (though not on a direct full-page load, which is why this
// went unnoticed until the resume page's richer layout made it obvious).
// Both the full-page and the HTMX-fragment paths must pass this, and
// exactly one match, never zero or two.
func assertMainContentContainer(t *testing.T, out string) {
	t.Helper()
	matches := mainContentPattern.FindAllStringSubmatch(out, -1)
	if len(matches) != 1 {
		t.Fatalf("expected exactly one #main-content element, found %d\n--- output ---\n%s", len(matches), out)
	}
	classes := matches[0][1]
	for _, want := range []string{"mx-auto", "max-w-5xl", "px-4", "py-8"} {
		if !strings.Contains(classes, want) {
			t.Errorf("#main-content classes %q missing %q", classes, want)
		}
	}
}

// TestLoadTemplatesParses verifies the full parsed set — including the
// resume.html/resume-*.html files LoadTemplates' explicit file list must
// name exactly (docs/features/resume.md's Template Rendering) — has no
// syntax errors and no missing {{define}} names.
func TestLoadTemplatesParses(t *testing.T) {
	if _, err := LoadTemplates("../../web/templates"); err != nil {
		t.Fatalf("LoadTemplates: %v", err)
	}
}

func fixtureResumeView() *service.ResumeView {
	return &service.ResumeView{
		RoleTitle:     "Principal / Staff Software Engineer",
		TenureLabel:   "18+ years",
		LocationLabel: "Singapore",
		ContactLinks: []service.ContactLinkView{
			{Label: "vincent.megia@gmail.com", Href: "mailto:vincent.megia@gmail.com", Icon: "<svg></svg>"},
			{Label: "unknown-icon", Href: "https://example.com", Icon: ""},
		},
		SummaryParagraphs: []template.HTML{"Principal Software Engineer with <b>18+ years</b> of experience."},
		Stats:             []model.Stat{{Num: "1M+", Label: "Prepaid Subscribers Supported"}},
		SkillGroups:       []model.SkillGroup{{Name: "Software Engineering", Skills: []string{"Go", "TypeScript"}}},
		Education:         []model.Education{{Degree: "B.S. Computer Science", School: "De La Salle University", StartYear: 1998, EndYear: 2002}},
		FeaturedProjects:  nil, // exercises the "always show See all projects, even with zero" rule
		Roles: []service.RoleView{
			{
				ID: 1, Title: "Principal Software Engineer", Company: "Singtel", Location: "Singapore",
				DateRange: "APR 2021 – PRESENT", IsCurrent: true,
				Blurb:   "Technical owner for 7 critical production systems.",
				Bullets: []string{"Own architecture and delivery across 7 systems."},
				Subprojects: []service.SubprojectView{
					{Heading: "Heya — Hybrid Mobile Platform", Blurb: "Backend architecture.", Bullets: nil},
				},
			},
			{
				ID: 2, Title: "Senior Software Engineer", Company: "Sofgen", Location: "Singapore",
				DateRange: "JAN 2010 – FEB 2021", IsCurrent: false,
				Subprojects: []service.SubprojectView{
					{Heading: "Barclays Wealth", ClientTag: "Client · Barclays Wealth · Jan 2010 – Dec 2016", Blurb: "Trading systems.", Bullets: []string{"Built WCF services."}},
				},
			},
		},
	}
}

// TestRenderFullPage exercises Renderer.Render's full-page path end to
// end with a resume-shaped PageData, verifying the RenderedContent
// pre-render step (docs/features/resume.md's Template Rendering) actually
// produces the resume markup inside "base" — this is the exact mechanism
// the html/template {{template}} dynamic-name limitation required.
func TestRenderFullPage(t *testing.T) {
	tmpl, err := LoadTemplates("../../web/templates")
	if err != nil {
		t.Fatalf("LoadTemplates: %v", err)
	}
	ren := NewRenderer(tmpl)

	data := PageData{
		Title:           "Resume",
		HomeMenu:        homeMenu,
		SettingsMenu:    settingsMenu,
		ContentTemplate: "resume-content",
		Resume:          fixtureResumeView(),
	}

	rec := httptest.NewRecorder()
	ren.Render(rec, httptest.NewRequest(http.MethodGet, "/resume", nil), data)

	if rec.Code != 0 && rec.Code != http.StatusOK {
		t.Fatalf("unexpected status %d, body: %s", rec.Code, rec.Body.String())
	}
	out := rec.Body.String()

	for _, want := range []string{
		`id="resume-role-1"`,
		`id="resume-role-2"`,
		"Current",
		"Barclays Wealth",
		"Client · Barclays Wealth",
		`<b>18+ years</b>`,
		"/static/js/resume-print.js",
		`id="resume-print-button"`,
		"See all projects",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("full-page render missing %q\n--- output ---\n%s", want, out)
		}
	}

	// The bold-markup fixture already contains a real "<b>" tag as raw
	// input (simulating what boldMarkup's own escaping would have
	// produced) — this test isn't re-testing boldMarkup's escaping order
	// itself (see resume_service_test.go for that); it's confirming the
	// template renders a template.HTML value unescaped as expected.

	assertMainContentContainer(t, out)
}

// TestRenderHTMXFragment exercises Renderer.Render's fragment path,
// confirming it resolves PageData.ContentTemplate directly (bypassing
// base.html/header/footer) rather than the old hardcoded "content".
func TestRenderHTMXFragment(t *testing.T) {
	tmpl, err := LoadTemplates("../../web/templates")
	if err != nil {
		t.Fatalf("LoadTemplates: %v", err)
	}
	ren := NewRenderer(tmpl)

	data := PageData{
		ContentTemplate: "resume-content",
		Resume:          fixtureResumeView(),
	}

	req := httptest.NewRequest(http.MethodGet, "/resume", nil)
	req.Header.Set("HX-Request", "true")

	rec := httptest.NewRecorder()
	ren.Render(rec, req, data)

	out := rec.Body.String()
	if strings.Contains(out, "<!doctype html>") {
		t.Error("HTMX fragment response should not include the full document shell")
	}
	if !strings.Contains(out, `id="resume-role-1"`) {
		t.Errorf("HTMX fragment missing resume content\n--- output ---\n%s", out)
	}

	// The fragment path is exactly where the outerHTML-swap bug bit —
	// base.html (and its #main-content wrapper) is never executed here,
	// so this is the response an HTMX nav swap actually receives.
	assertMainContentContainer(t, out)
}

// TestRenderPlaceholderRoutesUnaffected confirms every other route (empty
// ContentTemplate) still renders the shared placeholder correctly — the
// resume.html/PageData.RenderedContent change must not have broken them.
func TestRenderPlaceholderRoutesUnaffected(t *testing.T) {
	tmpl, err := LoadTemplates("../../web/templates")
	if err != nil {
		t.Fatalf("LoadTemplates: %v", err)
	}
	ren := NewRenderer(tmpl)

	data := PageData{
		Title:          "Projects",
		HomeMenu:       homeMenu,
		SettingsMenu:   settingsMenu,
		ContentTitle:   "Projects",
		ContentMessage: "Projects content coming soon.",
	}

	rec := httptest.NewRecorder()
	ren.Render(rec, httptest.NewRequest(http.MethodGet, "/projects", nil), data)

	out := rec.Body.String()
	if !strings.Contains(out, "Projects content coming soon.") {
		t.Errorf("placeholder route regressed\n--- output ---\n%s", out)
	}
	if strings.Contains(out, `id="resume-print-button"`) {
		t.Error("a non-resume route rendered resume content — ContentTemplate default leaked")
	}

	assertMainContentContainer(t, out)

	// The fragment path (an HTMX nav swap onto a placeholder-backed route,
	// e.g. Home ▾ → Projects) is exactly where the outerHTML-swap bug bit
	// for every non-resume route too, not just /resume.
	fragReq := httptest.NewRequest(http.MethodGet, "/projects", nil)
	fragReq.Header.Set("HX-Request", "true")
	fragRec := httptest.NewRecorder()
	ren.Render(fragRec, fragReq, data)
	fragOut := fragRec.Body.String()
	if !strings.Contains(fragOut, "Projects content coming soon.") {
		t.Errorf("placeholder HTMX fragment regressed\n--- output ---\n%s", fragOut)
	}
	assertMainContentContainer(t, fragOut)
}
