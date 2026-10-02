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
//
// Spacing is set explicitly on every paragraph via docxPara: go-docx's
// default theme has no paragraph spacing at all and justifies Normal text,
// which runs sections together and stretches word gaps.
func buildResumeDocx(profile model.Profile, roles []model.Role) ([]byte, error) {
	w := docx.New().WithDefaultTheme()

	docxPara(w, 0, "center").AddText("Vincent Megia").Bold().Size("36")
	docxPara(w, 40, "center").AddText(profile.RoleTitle).Size("24")
	docxPara(w, 80, "center").
		AddText(profile.TenureLabel + "  |  " + profile.LocationLabel).Size("20")
	if len(profile.ContactLinks) > 0 {
		addDocxContactLinks(docxPara(w, 60, "center"), profile.ContactLinks)
	}

	if len(profile.SummaryParagraphs) > 0 {
		addDocxHeading(w, "Summary")
		for i, para := range profile.SummaryParagraphs {
			p := docxPara(w, docxGapAfterHeading(i, docxBodyGap), "left")
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
		for i, g := range profile.SkillGroups {
			p := docxPara(w, docxGapAfterHeading(i, docxBodyGap), "left")
			p.AddText(g.Name + ": ").Bold().Size("22")
			p.AddText(strings.Join(g.Skills, ", ")).Size("22")
		}
	}

	if len(roles) > 0 {
		addDocxHeading(w, "Experience")
		for i, r := range roles {
			addDocxRole(w, r, docxGapAfterHeading(i, docxRoleGap))
		}
	}

	if len(profile.Education) > 0 {
		addDocxHeading(w, "Education")
		for i, e := range profile.Education {
			docxPara(w, docxGapAfterHeading(i, docxBulletGap), "left").AddText(
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

// addDocxContactLinks writes the banner's contact row (phone, email,
// personal site, GitHub, ...) as clickable hyperlinks separated by "|" —
// the same contact_links the PDF banner and /resume render.
//
// go-docx's AddLink puts the label in a w:instrText (field-code) element,
// which Word doesn't display as ordinary text, so the hyperlink's run is
// rebuilt with a regular w:t child; the run is styled inline (blue,
// underlined) since the default theme has no "Hyperlink" character style.
func addDocxContactLinks(p *docx.Paragraph, links []model.ContactLink) {
	for i, c := range links {
		if i > 0 {
			p.AddText("  |  ").Size("20")
		}
		if c.Href == "" {
			p.AddText(c.Label).Size("20")
			continue
		}
		h := p.AddLink(c.Label, c.Href)
		h.Run.InstrText = ""
		h.Run.RunProperties = &docx.RunProperties{}
		h.Run.Children = []interface{}{&docx.Text{Text: c.Label}}
		h.Run.Color("0563C1").Underline("single").Size("20")
	}
}

// Paragraph spacing in twips (1/20 pt).
const (
	docxSectionGap = 360 // above a section heading
	docxHeadingGap = 120 // between a section heading and its first line
	docxRoleGap    = 240 // above each role after a section's first
	docxBodyGap    = 100 // between body paragraphs
	docxBulletGap  = 40  // between bullets
	docxLine       = 264 // 1.1x line height ("auto" rule: 240 = single)
	docxBulletInd  = 360 // bullet hanging indent (0.25")
)

// docxPara adds a paragraph with `before` twips of space above it and the
// given alignment, overriding the theme's justified, zero-spaced Normal
// style. go-docx's Spacing has no "after" attribute, so all vertical
// rhythm is expressed as space-before.
func docxPara(w *docx.Docx, before int, jc string) *docx.Paragraph {
	p := w.AddParagraph().Justification(jc)
	p.Properties.Spacing = &docx.Spacing{Before: before, Line: docxLine, LineRule: "auto"}
	return p
}

// addDocxBullet adds a "•" item on a hanging indent, so wrapped lines
// align with the text rather than running back under the bullet.
func addDocxBullet(w *docx.Docx, text, size string) {
	p := docxPara(w, docxBulletGap, "left")
	p.Properties.Ind = &docx.Ind{Left: docxBulletInd, Hanging: docxBulletInd}
	p.AddText("•\t" + text).Size(size)
}

func addDocxHeading(w *docx.Docx, text string) {
	docxPara(w, docxSectionGap, "left").AddText(text).Bold().Size("28")
}

// docxGapAfterHeading is the space above a section's i-th item: the
// tighter heading gap for the first (keeping it attached to its heading),
// `between` for the rest.
func docxGapAfterHeading(i, between int) int {
	if i == 0 {
		return docxHeadingGap
	}
	return between
}

// addDocxRole appends one experience-timeline entry, including any nested
// subprojects — same content and "Current"/dateRange rule as
// resume.md's Business Rules, just plain runs instead of an HTML card.
func addDocxRole(w *docx.Docx, r model.Role, before int) {
	docxPara(w, before, "left").AddText(r.Title + " — " + r.Company).Bold().Size("24")
	docxPara(w, 0, "left").AddText(dateRange(r.StartDate, r.EndDate)).Italic().Size("20")

	if r.Blurb != "" {
		docxPara(w, docxBulletGap*2, "left").AddText(r.Blurb).Size("22")
	}
	for _, b := range r.Bullets {
		addDocxBullet(w, b, "22")
	}
	for _, sp := range r.Subprojects {
		heading := sp.Heading
		if sp.ClientTag != nil && *sp.ClientTag != "" {
			heading += " (" + *sp.ClientTag + ")"
		}
		docxPara(w, docxBodyGap+docxBulletGap, "left").AddText(heading).Bold().Size("22")
		if sp.Blurb != "" {
			docxPara(w, docxBulletGap, "left").AddText(sp.Blurb).Size("20")
		}
		for _, b := range sp.Bullets {
			addDocxBullet(w, b, "20")
		}
	}
}
