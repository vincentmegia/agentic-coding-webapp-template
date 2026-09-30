package service

import (
	"bytes"
	"context"
	"fmt"
	"strings"

	docx "github.com/fumiama/go-docx"

	"github.com/vincentmegia/vincentmegia/internal/model"
)

// GenerateDocx builds a plain, professional .docx of the resume straight
// from the same resume_profile/resume_roles data /resume renders from — no
// admin UI, no export-specific content, per docs/features/resume-export.md.
// Deliberately does not carry over the live page's terracotta/Caprasimo
// branding: default Word-native styling only. "Professional and simple" is
// this format's whole design goal, unlike the PDF export, which matches
// the site's actual visual design.
func (s *ResumeService) GenerateDocx(ctx context.Context) ([]byte, error) {
	profile, roles, err := s.fetch(ctx)
	if err != nil {
		return nil, err
	}
	return buildResumeDocx(profile, roles)
}

// buildResumeDocx is the pure, DB-free half of GenerateDocx — kept
// separate so it's unit-testable against fixture data with no database,
// same split Get's toRoleView/dateRange helpers already use.
//
// Font sizes below are in half-points (github.com/fumiama/go-docx's Size
// unit, matching OOXML's w:sz): "36"=18pt (name), "28"=14pt (section
// headings), "24"=12pt (role/sub-heading lines), "22"=11pt (body text,
// Word's own default), "20"=10pt (secondary/date lines).
func buildResumeDocx(profile model.Profile, roles []model.Role) ([]byte, error) {
	w := docx.New().WithDefaultTheme()

	w.AddParagraph().Justification("center").
		AddText("Vincent Megia").Bold().Size("36")
	w.AddParagraph().Justification("center").
		AddText(profile.RoleTitle).Size("24")
	w.AddParagraph().Justification("center").
		AddText(profile.TenureLabel + "  |  " + profile.LocationLabel).Size("20")

	if len(profile.SummaryParagraphs) > 0 {
		addDocxHeading(w, "Summary")
		for _, para := range profile.SummaryParagraphs {
			p := w.AddParagraph()
			for _, seg := range parseBoldSegments(para) {
				run := p.AddText(seg.Text).Size("22")
				if seg.Bold {
					run.Bold()
				}
			}
		}
	}

	if len(profile.SkillGroups) > 0 {
		addDocxHeading(w, "Core Expertise")
		for _, g := range profile.SkillGroups {
			p := w.AddParagraph()
			p.AddText(g.Name + ": ").Bold().Size("22")
			p.AddText(strings.Join(g.Skills, ", ")).Size("22")
		}
	}

	if len(roles) > 0 {
		addDocxHeading(w, "Experience")
		for _, r := range roles {
			addDocxRole(w, r)
		}
	}

	if len(profile.Education) > 0 {
		addDocxHeading(w, "Education")
		for _, e := range profile.Education {
			w.AddParagraph().AddText(
				fmt.Sprintf("%s, %s (%d–%d)", e.Degree, e.School, e.StartYear, e.EndYear),
			).Size("22")
		}
	}

	var buf bytes.Buffer
	if _, err := w.WriteTo(&buf); err != nil {
		return nil, fmt.Errorf("write resume docx: %w", err)
	}
	return buf.Bytes(), nil
}

func addDocxHeading(w *docx.Docx, text string) {
	w.AddParagraph().AddText(text).Bold().Size("28")
}

// addDocxRole appends one experience-timeline entry, including any nested
// subprojects — same content and "Current"/dateRange rule as
// resume.md's Business Rules, just plain runs instead of an HTML card.
func addDocxRole(w *docx.Docx, r model.Role) {
	w.AddParagraph().AddText(r.Title + " — " + r.Company).Bold().Size("24")
	w.AddParagraph().AddText(dateRange(r.StartDate, r.EndDate)).Size("20")

	if r.Blurb != "" {
		w.AddParagraph().AddText(r.Blurb).Size("22")
	}
	for _, b := range r.Bullets {
		w.AddParagraph().AddText("•  " + b).Size("22")
	}
	for _, sp := range r.Subprojects {
		heading := sp.Heading
		if sp.ClientTag != nil && *sp.ClientTag != "" {
			heading += " (" + *sp.ClientTag + ")"
		}
		w.AddParagraph().AddText(heading).Bold().Size("22")
		if sp.Blurb != "" {
			w.AddParagraph().AddText(sp.Blurb).Size("20")
		}
		for _, b := range sp.Bullets {
			w.AddParagraph().AddText("•  " + b).Size("20")
		}
	}
}
