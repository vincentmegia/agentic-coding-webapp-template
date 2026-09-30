package service

import (
	"bytes"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"
	"unicode"

	"github.com/ledongthuc/pdf"

	"github.com/vincentmegia/vincentmegia/internal/model"
)

// These tests run the real PDF generator end to end — no fake stands in
// for it anywhere. That's the gap the removed chromedp implementation fell
// through (docs/features/resume-export.md's Decision): every test used a
// fake renderer, so nothing ever checked that this server could actually
// produce a PDF. Text is read back out with an independent PDF parser, the
// same way an ATS would read the file, rather than by grepping raw bytes.

func pdfFixtureProfile() model.Profile {
	return model.Profile{
		RoleTitle:     "Principal Software Engineer",
		TenureLabel:   "18+ years",
		LocationLabel: "Singapore",
		ContactLinks: []model.ContactLink{
			{Label: "github.com/vincentmegia", Href: "https://github.com/vincentmegia"},
			{Label: "vincent@example.com", Href: "mailto:vincent@example.com"},
		},
		SummaryParagraphs: []string{
			"Built systems at **PayPal** and R&D across AWS & <Kubernetes>",
		},
		Stats: []model.Stat{{Num: "18+", Label: "Years shipping"}},
		SkillGroups: []model.SkillGroup{
			{Name: "Languages", Skills: []string{"Go", "TypeScript"}},
		},
		Education: []model.Education{
			{Degree: "B.S. Computer Science", School: "Example University", StartYear: 2005, EndYear: 2009},
		},
		FeaturedProjects: []model.FeaturedProject{
			{Name: "Puzzle Solver", Description: "DFS visualizer", Links: []model.ProjectLink{{Label: "Live demo", Href: "https://puzzle-solver.example.com"}}},
		},
	}
}

func pdfFixtureRoles() []model.Role {
	end := time.Date(2021, 3, 1, 0, 0, 0, 0, time.UTC)
	client := "Barclays Wealth"
	return []model.Role{
		{
			Title:     "Staff Engineer",
			Company:   "Singtel",
			Location:  "Singapore",
			Blurb:     "Platform lead.",
			Bullets:   []string{"Led a team"},
			StartDate: time.Date(2021, 4, 1, 0, 0, 0, 0, time.UTC),
		},
		{
			Title:     "Senior Software Engineer",
			Company:   "Sofgen",
			StartDate: time.Date(2009, 8, 1, 0, 0, 0, 0, time.UTC),
			EndDate:   &end,
			Subprojects: []model.Subproject{
				{Heading: "Wealth platform", ClientTag: &client, Bullets: []string{"Shipped trade capture"}},
			},
		},
	}
}

// pdfText returns the whole document's extracted text, normalized by
// pdfNormalize.
func pdfText(t *testing.T, doc []byte) (string, int) {
	t.Helper()
	r, err := pdf.NewReader(bytes.NewReader(doc), int64(len(doc)))
	if err != nil {
		t.Fatalf("generated PDF does not parse: %v", err)
	}
	plain, err := r.GetPlainText()
	if err != nil {
		t.Fatalf("extract PDF text: %v", err)
	}
	raw, err := io.ReadAll(plain)
	if err != nil {
		t.Fatalf("read PDF text: %v", err)
	}
	return pdfNormalize(string(raw)), r.NumPage()
}

// pdfNormalize strips whitespace, en/em dashes, and control characters.
// Whitespace, because PDF text extraction doesn't reliably reproduce the
// spaces between separately-drawn words. Dashes, because
// github.com/ledongthuc/pdf decodes them to their code point's low byte
// (U+2014 comes back as control char 0x14) — a limitation of this
// test-only reader, not of the PDF: its ToUnicode maps are correct, and
// macOS PDFKit (Preview) extracts "APR 2021 – PRESENT" exactly.
func pdfNormalize(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) || unicode.IsControl(r) || r == '–' || r == '—' {
			return -1
		}
		return r
	}, s)
}

func assertPDFContains(t *testing.T, text string, wants ...string) {
	t.Helper()
	for _, want := range wants {
		if !strings.Contains(text, pdfNormalize(want)) {
			t.Errorf("PDF text missing %q\n--- text ---\n%s", want, text)
		}
	}
}

// TestBuildResumePDF_ContentIsExtractable verifies every section of the
// resume reaches the PDF as real, extractable text — including the
// Current/PRESENT rule, bold-markup runs without literal asterisks, and
// raw "&"/"<" surviving as the characters themselves.
func TestBuildResumePDF_ContentIsExtractable(t *testing.T) {
	out, err := buildResumePDF(pdfFixtureProfile(), pdfFixtureRoles())
	if err != nil {
		t.Fatalf("buildResumePDF: %v", err)
	}
	if !bytes.HasPrefix(out, []byte("%PDF-")) {
		t.Fatalf("output does not start with %%PDF- magic bytes: %q", out[:min(len(out), 16)])
	}

	text, _ := pdfText(t, out)
	assertPDFContains(t, text,
		"Vincent Megia", "Principal Software Engineer", "18+ years", "Singapore",
		"github.com/vincentmegia",
		"Built systems at PayPal and R&D across AWS & <Kubernetes>",
		"18+", "Years shipping",
		"Staff Engineer", "Singtel — Singapore", "APR 2021 – PRESENT", "Current", "Platform lead.", "Led a team",
		"Senior Software Engineer", "AUG 2009 – MAR 2021", "Wealth platform", "Barclays Wealth", "Shipped trade capture",
		"CORE EXPERTISE", "Languages", "Go", "TypeScript",
		"EDUCATION", "B.S. Computer Science", "Example University", "2005 – 2009",
		"FEATURED PROJECTS", "Puzzle Solver", "Live demo",
	)
	if strings.Contains(text, "**") {
		t.Errorf("bold markup leaked into the PDF as literal asterisks:\n%s", text)
	}
	if n := strings.Count(text, "Current"); n != 1 {
		t.Errorf("found %d \"Current\" badges, want 1 (only the role with no end date)", n)
	}
}

// TestBuildResumePDF_PaginatesWithoutLosingContent verifies a resume
// longer than one page — and a single role taller than a whole page, which
// has to be split — still carries every role and bullet, across several
// pages. fpdf's auto page break is off (the pager places cards itself),
// so a pagination bug would draw content off the bottom of a page rather
// than fail loudly; this is the test that catches it.
func TestBuildResumePDF_PaginatesWithoutLosingContent(t *testing.T) {
	var roles []model.Role
	for i := range 12 {
		r := model.Role{
			Title:     fmt.Sprintf("Role %02d", i),
			Company:   "Company",
			StartDate: time.Date(2000+i, 1, 1, 0, 0, 0, 0, time.UTC),
		}
		n := 4
		if i == 5 {
			n = 60 // taller than one page on its own
		}
		for j := range n {
			r.Bullets = append(r.Bullets, fmt.Sprintf("Bullet %02d-%02d delivered a measurable outcome for the business", i, j))
		}
		roles = append(roles, r)
	}

	out, err := buildResumePDF(pdfFixtureProfile(), roles)
	if err != nil {
		t.Fatalf("buildResumePDF: %v", err)
	}
	text, pages := pdfText(t, out)
	if pages < 3 {
		t.Errorf("pages = %d, want at least 3 for this much content", pages)
	}
	for _, r := range roles {
		assertPDFContains(t, text, r.Title)
		for _, b := range r.Bullets {
			assertPDFContains(t, text, b)
		}
	}
}

// TestBuildResumePDF_OnlySafeLinksAreClickable verifies an unexpected
// scheme in owner-editable content never becomes a live link annotation,
// while the real ones do.
func TestBuildResumePDF_OnlySafeLinksAreClickable(t *testing.T) {
	profile := pdfFixtureProfile()
	profile.ContactLinks = append(profile.ContactLinks, model.ContactLink{Label: "evil", Href: "javascript:alert(1)"})

	out, err := buildResumePDF(profile, nil)
	if err != nil {
		t.Fatalf("buildResumePDF: %v", err)
	}
	if bytes.Contains(out, []byte("javascript:")) {
		t.Error("javascript: href was embedded in the PDF")
	}
	for _, want := range []string{"https://github.com/vincentmegia", "mailto:vincent@example.com", "https://puzzle-solver.example.com"} {
		if !bytes.Contains(out, []byte(want)) {
			t.Errorf("PDF missing link annotation for %q", want)
		}
	}
}

// TestBuildResumePDF_EmptyResume verifies a resume with no optional
// sections still produces a valid one-page document (just the banner)
// rather than erroring.
func TestBuildResumePDF_EmptyResume(t *testing.T) {
	out, err := buildResumePDF(model.Profile{}, nil)
	if err != nil {
		t.Fatalf("buildResumePDF: %v", err)
	}
	text, pages := pdfText(t, out)
	if pages != 1 {
		t.Errorf("pages = %d, want 1", pages)
	}
	assertPDFContains(t, text, "Vincent Megia")
}

func TestPDFLinkable(t *testing.T) {
	for href, want := range map[string]bool{
		"https://github.com/x": true,
		"http://example.com":   true,
		"mailto:a@b.c":         true,
		"tel:+6512345678":      true,
		" HTTPS://EXAMPLE.COM": true,
		"javascript:alert(1)":  false,
		"/projects":            false,
		"":                     false,
		"file:///etc/passwd":   false,
	} {
		if got := pdfLinkable(href); got != want {
			t.Errorf("pdfLinkable(%q) = %v, want %v", href, got, want)
		}
	}
}
