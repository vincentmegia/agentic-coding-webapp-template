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
