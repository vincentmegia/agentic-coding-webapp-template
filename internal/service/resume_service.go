// Package service contains business logic and application workflows,
// coordinating repositories. See docs/skills/go-backend/SKILL.md "Service".
package service

import (
	"context"
	"fmt"
	"html/template"
	"regexp"
	"strings"
	"time"

	"github.com/vincentmegia/vincentmegia/internal/model"
	"github.com/vincentmegia/vincentmegia/internal/repository"
)

// ResumeService aggregates the resume_profile/resume_roles data into the
// fully-prepared ResumeView the templates render from: dates formatted,
// icon keys resolved, bold markup converted. See
// docs/features/resume.md's Data Model.
type ResumeService struct {
	Repo *repository.ResumeRepository
}

// NewResumeService wraps a ResumeRepository.
func NewResumeService(repo *repository.ResumeRepository) *ResumeService {
	return &ResumeService{Repo: repo}
}

// ResumeView is the view-model web/templates/pages/resume.html and its
// components render from — never the raw model.Profile/model.Role types,
// per docs/skills/htmx-ui/SKILL.md "Component Boundaries".
type ResumeView struct {
	RoleTitle         string
	TenureLabel       string
	LocationLabel     string
	ContactLinks      []ContactLinkView
	SummaryParagraphs []template.HTML
	Stats             []model.Stat
	SkillGroups       []model.SkillGroup
	Education         []model.Education
	FeaturedProjects  []model.FeaturedProject
	Roles             []RoleView

	// The five FontClass fields below are CSS class names (e.g.
	// "resume-font-classic-serif"), already resolved from the stored
	// preset key through resolveFontClass — templates apply them directly
	// as a wrapper class, never seeing the raw key. See
	// docs/features/resume-content-authoring.md's Font Presets.
	BannerFontClass           string
	SidebarExpertiseFontClass string
	SidebarEducationFontClass string
	SidebarFeaturedFontClass  string
	SummaryFontClass          string
}

// ContactLinkView is one resolved contact link.
type ContactLinkView struct {
	Label string
	Href  string
	// Icon is trusted, already-resolved inline SVG (see resolveIcon) —
	// empty if the DB's icon key wasn't recognized, which renders the
	// contact item with no icon rather than failing the request.
	Icon template.HTML
}

// RoleView is one prepared experience-timeline entry.
type RoleView struct {
	ID       int64
	Title    string
	Company  string
	Location string
	// DateRange is the display label ("APR 2021 – PRESENT"), computed
	// from the real DATE columns — never stored as text.
	DateRange   string
	IsCurrent   bool
	Blurb       string
	Bullets     []string
	Subprojects []SubprojectView
	// FontClass is this role's resolved font-preset CSS class — nested
	// Subprojects render inside the same class, no separate resolution.
	FontClass string
}

// SubprojectView is one prepared nested client-engagement/sub-project entry.
type SubprojectView struct {
	Heading string
	// ClientTag is "" when the role has no client-engagement tag (a
	// role's own internal sub-project, not a consultancy client stint).
	ClientTag string
	Blurb     string
	Bullets   []string
}

// Get fetches and prepares the full resume view.
func (s *ResumeService) Get(ctx context.Context) (ResumeView, error) {
	profile, roles, err := s.fetch(ctx)
	if err != nil {
		return ResumeView{}, err
	}

	view := ResumeView{
		RoleTitle:                 profile.RoleTitle,
		TenureLabel:               profile.TenureLabel,
		LocationLabel:             profile.LocationLabel,
		Stats:                     profile.Stats,
		SkillGroups:               profile.SkillGroups,
		Education:                 profile.Education,
		FeaturedProjects:          profile.FeaturedProjects,
		BannerFontClass:           resolveFontClass(profile.BannerFontStyle),
		SidebarExpertiseFontClass: resolveFontClass(profile.SidebarExpertiseFontStyle),
		SidebarEducationFontClass: resolveFontClass(profile.SidebarEducationFontStyle),
		SidebarFeaturedFontClass:  resolveFontClass(profile.SidebarFeaturedProjectsFontStyle),
		SummaryFontClass:          resolveFontClass(profile.SummaryFontStyle),
	}

	for _, c := range profile.ContactLinks {
		view.ContactLinks = append(view.ContactLinks, ContactLinkView{
			Label: c.Label,
			Href:  c.Href,
			Icon:  resolveIcon(c.Icon),
		})
	}

	for _, p := range profile.SummaryParagraphs {
		view.SummaryParagraphs = append(view.SummaryParagraphs, boldMarkup(p))
	}

	for _, r := range roles {
		view.Roles = append(view.Roles, toRoleView(r))
	}

	return view, nil
}

// fetch runs the two fixed queries backing every resume read — Get (the
// HTML view) and GenerateDocx (resume_docx.go) both start from the exact
// same raw data, so this is the one place either shares rather than each
// issuing its own copy of the same two calls.
func (s *ResumeService) fetch(ctx context.Context) (model.Profile, []model.Role, error) {
	profile, err := s.Repo.GetProfile(ctx)
	if err != nil {
		return model.Profile{}, nil, fmt.Errorf("get resume profile: %w", err)
	}
	roles, err := s.Repo.ListRoles(ctx)
	if err != nil {
		return model.Profile{}, nil, fmt.Errorf("list resume roles: %w", err)
	}
	return profile, roles, nil
}

func toRoleView(r model.Role) RoleView {
	rv := RoleView{
		ID:        r.ID,
		Title:     r.Title,
		Company:   r.Company,
		Location:  r.Location,
		Blurb:     r.Blurb,
		Bullets:   r.Bullets,
		IsCurrent: r.EndDate == nil,
		DateRange: dateRange(r.StartDate, r.EndDate),
		FontClass: resolveFontClass(r.FontStyle),
	}
	for _, sp := range r.Subprojects {
		clientTag := ""
		if sp.ClientTag != nil {
			clientTag = *sp.ClientTag
		}
		rv.Subprojects = append(rv.Subprojects, SubprojectView{
			Heading:   sp.Heading,
			ClientTag: clientTag,
			Blurb:     sp.Blurb,
			Bullets:   sp.Bullets,
		})
	}
	return rv
}

// dateRange renders "APR 2021 – PRESENT" or "AUG 2009 – JAN 2010" from
// real DATE columns. end == nil means current/present — the only signal
// for "current" (docs/features/resume.md's Business Rules).
func dateRange(start time.Time, end *time.Time) string {
	startLabel := strings.ToUpper(start.Format("Jan 2006"))
	if end == nil {
		return startLabel + " – PRESENT"
	}
	return startLabel + " – " + strings.ToUpper(end.Format("Jan 2006"))
}

// boldPattern matches the one supported lightweight markup: **text**.
var boldPattern = regexp.MustCompile(`\*\*(.+?)\*\*`)

// boldSegment is one plain-text or bold-text run parsed out of a summary
// paragraph's "**bold**" mini-markup by parseBoldSegments.
type boldSegment struct {
	Text string
	Bold bool
}

// parseBoldSegments splits a raw summary paragraph on "**...**" into an
// ordered list of plain/bold text segments — the one shared implementation
// of this app's one supported markup rule, consumed by both boldMarkup
// (HTML output for /resume and its PDF export) and resume_docx.go's
// buildResumeDocx (Word runs for the .docx export), per
// docs/features/resume-export.md's Security Considerations: a second,
// independently-maintained regex parse of the same rule is exactly how the
// two outputs would quietly drift apart. Segment text is always the raw,
// unescaped substring — callers are responsible for whatever
// escaping/encoding their own output format requires.
func parseBoldSegments(raw string) []boldSegment {
	var segs []boldSegment
	last := 0
	for _, loc := range boldPattern.FindAllStringSubmatchIndex(raw, -1) {
		if loc[0] > last {
			segs = append(segs, boldSegment{Text: raw[last:loc[0]]})
		}
		segs = append(segs, boldSegment{Text: raw[loc[2]:loc[3]], Bold: true})
		last = loc[1]
	}
	if last < len(raw) {
		segs = append(segs, boldSegment{Text: raw[last:]})
	}
	return segs
}

// boldMarkup converts a raw summary paragraph into trusted template.HTML.
//
// Escaping order here is the actual security mechanism, not a style
// choice (docs/features/resume.md's Security Considerations): every raw
// text segment is HTML-escaped individually *before* concatenation; only
// the literal "<b>"/"</b>" Go string constants below are ever unescaped in
// the output. Reversing the order — escaping the whole assembled string
// afterward — would corrupt the tags themselves (html/template would
// re-escape "<b>" into "&lt;b&gt;").
func boldMarkup(raw string) template.HTML {
	var b strings.Builder
	for _, seg := range parseBoldSegments(raw) {
		escaped := template.HTMLEscapeString(seg.Text)
		if seg.Bold {
			b.WriteString("<b>")
			b.WriteString(escaped)
			b.WriteString("</b>")
		} else {
			b.WriteString(escaped)
		}
	}
	return template.HTML(b.String())
}

// contactIcons is a fixed allowlist mapping a contact_links[].icon DB key
// to trusted inline SVG. Every value here is a Go source constant, never
// DB-sourced markup — mirrors internal/handler/nav.go's icon() helper,
// duplicated rather than imported since service must not depend on
// handler (docs/skills/go-backend/SKILL.md's Handler/Service layering).
var contactIcons = map[string]template.HTML{
	"phone":   svgIcon(`<path d="M6.6 3.5h3l1.4 4.2-2 1.6a12 12 0 0 0 5.7 5.7l1.6-2 4.2 1.4v3c0 1-.9 1.8-1.9 1.7-8-.6-13.9-6.5-14.5-14.5-.1-1 .7-1.9 1.7-1.9z"/>`),
	"mail":    svgIcon(`<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M3.5 6.5 12 13l8.5-6.5"/>`),
	"globe":   svgIcon(`<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.4 3.6 5.4 3.6 8.5s-1.2 6.1-3.6 8.5c-2.4-2.4-3.6-5.4-3.6-8.5S9.6 5.9 12 3.5z"/>`),
	"branch":  svgIcon(`<circle cx="6" cy="5.5" r="2"/><circle cx="6" cy="18.5" r="2"/><circle cx="18" cy="9.5" r="2"/><path d="M6 7.5v9M6 12c0-2.5 2-4.5 6-4.5h4"/>`),
	"network": svgIcon(`<circle cx="6" cy="7" r="2.2"/><circle cx="18" cy="7" r="2.2"/><circle cx="12" cy="18" r="2.2"/><path d="M7.8 8.3 10.4 16M16.2 8.3 13.6 16M8.2 7h7.6"/>`),
	"bars":    svgIcon(`<path d="M5 19V13M11 19V6M17 19V10"/><path d="M3.5 19h17"/>`),
}

// svgIcon wraps trusted, hardcoded inline SVG path data — always a Go
// source constant passed at a call site above, never DB input — in a
// standalone <svg> element.
func svgIcon(inner string) template.HTML {
	return template.HTML(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ` +
			`stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ` +
			`class="h-4 w-4 shrink-0" aria-hidden="true">` + inner + `</svg>`,
	)
}

// resolveIcon maps a contact_links[].icon DB key to trusted inline SVG. An
// unrecognized key returns "" — the contact item renders with no icon
// rather than failing the request (docs/features/resume.md's Business
// Rules / Security Considerations).
func resolveIcon(key string) template.HTML {
	return contactIcons[key]
}

// resolveFontClass maps a font_style DB key (see fontPresets in
// resume_admin_validation.go) to the CSS wrapper class a card/role
// container applies (web/static/css/app.css defines one such class per
// preset, each setting --font-heading/--font-body for its subtree). An
// unrecognized/empty key falls back to the "organic" class rather than
// failing the render — the same "don't fail on a bad DB value" precedent
// resolveIcon establishes above, applied to font presets
// (docs/features/resume-content-authoring.md's Security Considerations).
// The key itself never reaches a template directly — only this resolved,
// fixed class name does.
func resolveFontClass(key string) string {
	if !isValidFontStyle(key) {
		key = defaultFontStyle
	}
	return "resume-font-" + key
}
