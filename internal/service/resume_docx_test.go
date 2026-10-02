package service

import (
	"archive/zip"
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/vincentmegia/vincentmegia/internal/model"
)

// TestBuildResumeDocx_ValidZipWithExpectedContent verifies buildResumeDocx
// produces a real, openable .docx (a zip archive with a word/document.xml
// part) reflecting the seeded content, and that XML-special characters in
// summary text ("&", "<") come out escaped rather than corrupting the
// document — docs/features/resume-export.md's Security Considerations:
// ".docx text-escaping must be verified, not assumed".
func TestBuildResumeDocx_ValidZipWithExpectedContent(t *testing.T) {
	profile := model.Profile{
		RoleTitle:     "Principal Software Engineer",
		TenureLabel:   "18+ years",
		LocationLabel: "Remote",
		SummaryParagraphs: []string{
			"Built systems at **PayPal** and R&D across AWS & <Kubernetes>",
		},
		SkillGroups: []model.SkillGroup{
			{Name: "Languages", Skills: []string{"Go", "TypeScript"}},
		},
		Education: []model.Education{
			{Degree: "B.S. Computer Science", School: "Example University", StartYear: 2005, EndYear: 2009},
		},
	}
	roles := []model.Role{
		{
			Title:     "Staff Engineer",
			Company:   "Singtel",
			Bullets:   []string{"Led a team"},
			StartDate: time.Date(2021, 4, 1, 0, 0, 0, 0, time.UTC),
		},
	}

	out, err := buildResumeDocx(profile, roles)
	if err != nil {
		t.Fatalf("buildResumeDocx: %v", err)
	}

	zr, err := zip.NewReader(bytes.NewReader(out), int64(len(out)))
	if err != nil {
		t.Fatalf("generated docx is not a valid zip: %v", err)
	}

	var doc []byte
	for _, f := range zr.File {
		if f.Name != "word/document.xml" {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("open word/document.xml: %v", err)
		}
		var buf bytes.Buffer
		if _, err := buf.ReadFrom(rc); err != nil {
			t.Fatalf("read word/document.xml: %v", err)
		}
		rc.Close()
		doc = buf.Bytes()
	}
	if doc == nil {
		t.Fatal("generated docx missing word/document.xml")
	}
	xmlStr := string(doc)

	for _, want := range []string{"Vincent Megia", "PayPal", "Singtel", "Led a team", "Go, TypeScript"} {
		if !strings.Contains(xmlStr, want) {
			t.Errorf("document.xml missing %q\n--- xml ---\n%s", want, xmlStr)
		}
	}
	if !strings.Contains(xmlStr, "AWS &amp; &lt;Kubernetes&gt;") {
		t.Errorf("document.xml did not XML-escape raw '&'/'<' in summary text\n--- xml ---\n%s", xmlStr)
	}
}

// TestBuildResumeDocx_IncludesContactLinks verifies the banner's
// contact_links (phone, email, personal site, ...) make it into the
// .docx as visible text — w:t, not go-docx AddLink's default w:instrText,
// which Word doesn't display — with each href recorded as a hyperlink
// relationship.
func TestBuildResumeDocx_IncludesContactLinks(t *testing.T) {
	profile := model.Profile{
		RoleTitle: "Principal Software Engineer",
		ContactLinks: []model.ContactLink{
			{Label: "vincent.megia@gmail.com", Href: "mailto:vincent.megia@gmail.com", Icon: "mail"},
			{Label: "vincentmegia.onrender.com", Href: "https://vincentmegia.onrender.com", Icon: "globe"},
		},
	}

	out, err := buildResumeDocx(profile, nil)
	if err != nil {
		t.Fatalf("buildResumeDocx: %v", err)
	}
	zr, err := zip.NewReader(bytes.NewReader(out), int64(len(out)))
	if err != nil {
		t.Fatalf("generated docx is not a valid zip: %v", err)
	}
	parts := map[string]string{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("open %s: %v", f.Name, err)
		}
		var buf bytes.Buffer
		if _, err := buf.ReadFrom(rc); err != nil {
			t.Fatalf("read %s: %v", f.Name, err)
		}
		rc.Close()
		parts[f.Name] = buf.String()
	}

	doc, rels := parts["word/document.xml"], parts["word/_rels/document.xml.rels"]
	for _, c := range profile.ContactLinks {
		if !strings.Contains(doc, "<w:t>"+c.Label+"</w:t>") {
			t.Errorf("document.xml missing visible text for %q\n--- xml ---\n%s", c.Label, doc)
		}
		if !strings.Contains(rels, c.Href) {
			t.Errorf("document.xml.rels missing hyperlink target %q\n--- rels ---\n%s", c.Href, rels)
		}
	}
	if strings.Contains(doc, "<w:instrText>") {
		t.Errorf("document.xml has a w:instrText run; contact labels would be invisible in Word\n--- xml ---\n%s", doc)
	}
}
