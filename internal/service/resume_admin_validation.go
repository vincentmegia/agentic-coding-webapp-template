package service

import (
	"errors"
	"strings"
	"time"

	"github.com/vincentmegia/vincentmegia/internal/model"
)

// FontPreset is one entry in the fixed, curated font-pairing allowlist
// docs/features/resume-content-authoring.md's Font Presets specifies. Key
// is what's stored in the database (and CHECK-constrained there — see
// migrations/006_add_resume_authoring.sql); Label is what the /settings/resume
// <select> options show a human.
type FontPreset struct {
	Key   string
	Label string
}

// fontPresets is the complete, ordered allowlist — never extended by user
// input. A stored/submitted key not in this list is invalid: resolveFontClass
// (resume_service.go) falls back to "organic" on read, and
// ValidateFontStyle rejects it on write.
var fontPresets = []FontPreset{
	{Key: "organic", Label: "Organic (default)"},
	{Key: "classic-serif", Label: "Classic Serif"},
	{Key: "modern-sans", Label: "Modern Sans"},
	{Key: "editorial", Label: "Editorial"},
}

// defaultFontStyle is the fallback for an empty/unrecognized stored value —
// today's site-wide look, unchanged.
const defaultFontStyle = "organic"

// isValidFontStyle reports whether key is one of the allowlisted preset keys.
func isValidFontStyle(key string) bool {
	for _, p := range fontPresets {
		if p.Key == key {
			return true
		}
	}
	return false
}

// ErrInvalidFontStyle is returned when a save submits a font_style value
// outside the fixed allowlist — defense in depth alongside the <select>
// inputs (which make this impossible from the UI) and the database's own
// CHECK constraint, per docs/features/resume-content-authoring.md's
// Business Rules.
var ErrInvalidFontStyle = errors.New("font style must be one of the available presets")

// ValidateFontStyle defaults an empty submission to "organic" and rejects
// anything else not in the allowlist.
func ValidateFontStyle(key string) (string, error) {
	key = strings.TrimSpace(key)
	if key == "" {
		return defaultFontStyle, nil
	}
	if !isValidFontStyle(key) {
		return "", ErrInvalidFontStyle
	}
	return key, nil
}

// FontStyleOption backs each card editor's font-style <select>.
type FontStyleOption struct {
	Key      string
	Label    string
	Selected bool
}

// fontStyleOptions builds the <select> options for a card currently set to
// selected.
func fontStyleOptions(selected string) []FontStyleOption {
	opts := make([]FontStyleOption, len(fontPresets))
	for i, p := range fontPresets {
		opts[i] = FontStyleOption{Key: p.Key, Label: p.Label, Selected: p.Key == selected}
	}
	return opts
}

// Resume admin validation sentinels — one per required field, per
// docs/features/resume-content-authoring.md's Business Rules ("every
// existing Business Rule in resume.md still holds"). Grouped with
// ErrInvalidFontStyle above in the validationErrors set below so the
// handler can distinguish a validation failure from an internal fault.
var (
	ErrBannerRoleTitleRequired     = errors.New("role title is required")
	ErrBannerTenureLabelRequired   = errors.New("tenure label is required")
	ErrBannerLocationLabelRequired = errors.New("location label is required")

	ErrSkillGroupNameRequired   = errors.New("skill group name is required")
	ErrSkillGroupSkillsRequired = errors.New("skill group must have at least one skill")

	ErrEducationDegreeRequired = errors.New("degree is required")
	ErrEducationSchoolRequired = errors.New("school is required")

	ErrFeaturedProjectNameRequired        = errors.New("project name is required")
	ErrFeaturedProjectDescriptionRequired = errors.New("project description is required")

	ErrRoleTitleRequired    = errors.New("role title is required")
	ErrRoleCompanyRequired  = errors.New("company is required")
	ErrRoleStartDateInvalid = errors.New("start date must be a valid date (YYYY-MM-DD)")
	ErrRoleEndDateInvalid   = errors.New("end date must be a valid date (YYYY-MM-DD) or left blank for a current role")

	ErrRoleNotFound = errors.New("role not found")
)

// resumeAdminValidationErrors are the sentinels IsResumeValidationError
// checks — safe to show a caller verbatim, unlike a wrapped database error.
var resumeAdminValidationErrors = []error{
	ErrInvalidFontStyle,
	ErrBannerRoleTitleRequired,
	ErrBannerTenureLabelRequired,
	ErrBannerLocationLabelRequired,
	ErrSkillGroupNameRequired,
	ErrSkillGroupSkillsRequired,
	ErrEducationDegreeRequired,
	ErrEducationSchoolRequired,
	ErrFeaturedProjectNameRequired,
	ErrFeaturedProjectDescriptionRequired,
	ErrRoleTitleRequired,
	ErrRoleCompanyRequired,
	ErrRoleStartDateInvalid,
	ErrRoleEndDateInvalid,
}

// IsResumeValidationError reports whether err is one of the curated,
// user-facing resume-admin validation sentinels above.
func IsResumeValidationError(err error) bool {
	for _, sentinel := range resumeAdminValidationErrors {
		if errors.Is(err, sentinel) {
			return true
		}
	}
	return false
}

// ValidateBannerInput trims and validates a banner-form submission.
// ContactLinks are trimmed but otherwise unvalidated field-by-field
// (label/href/icon are all optional per model.ContactLink's existing
// shape) — mirrors resume.md's original seed data, which never required
// every contact link to be fully populated.
func ValidateBannerInput(roleTitle, tenureLabel, locationLabel string, contactLinks []model.ContactLink, fontStyle string) (model.Profile, error) {
	p := model.Profile{
		RoleTitle:     strings.TrimSpace(roleTitle),
		TenureLabel:   strings.TrimSpace(tenureLabel),
		LocationLabel: strings.TrimSpace(locationLabel),
	}
	if p.RoleTitle == "" {
		return model.Profile{}, ErrBannerRoleTitleRequired
	}
	if p.TenureLabel == "" {
		return model.Profile{}, ErrBannerTenureLabelRequired
	}
	if p.LocationLabel == "" {
		return model.Profile{}, ErrBannerLocationLabelRequired
	}
	style, err := ValidateFontStyle(fontStyle)
	if err != nil {
		return model.Profile{}, err
	}
	p.BannerFontStyle = style

	for _, c := range contactLinks {
		p.ContactLinks = append(p.ContactLinks, model.ContactLink{
			Label: strings.TrimSpace(c.Label),
			Href:  strings.TrimSpace(c.Href),
			Icon:  strings.TrimSpace(c.Icon),
		})
	}
	return p, nil
}

// ValidateExpertiseInput trims and validates a Core Expertise submission.
// Each skill group needs a name and at least one non-empty skill.
func ValidateExpertiseInput(groups []model.SkillGroup, fontStyle string) ([]model.SkillGroup, string, error) {
	style, err := ValidateFontStyle(fontStyle)
	if err != nil {
		return nil, "", err
	}

	var out []model.SkillGroup
	for _, g := range groups {
		name := strings.TrimSpace(g.Name)
		if name == "" {
			return nil, "", ErrSkillGroupNameRequired
		}
		var skills []string
		for _, s := range g.Skills {
			if s = strings.TrimSpace(s); s != "" {
				skills = append(skills, s)
			}
		}
		if len(skills) == 0 {
			return nil, "", ErrSkillGroupSkillsRequired
		}
		out = append(out, model.SkillGroup{Name: name, Skills: skills})
	}
	return out, style, nil
}

// ValidateEducationInput trims and validates an Education submission. Each
// entry needs a degree and a school; years are stored as submitted (0 is a
// valid "not specified" value, matching model.Education's existing int
// fields with no NOT NULL-style requirement beyond presence of the row).
func ValidateEducationInput(entries []model.Education, fontStyle string) ([]model.Education, string, error) {
	style, err := ValidateFontStyle(fontStyle)
	if err != nil {
		return nil, "", err
	}

	var out []model.Education
	for _, e := range entries {
		degree := strings.TrimSpace(e.Degree)
		school := strings.TrimSpace(e.School)
		if degree == "" {
			return nil, "", ErrEducationDegreeRequired
		}
		if school == "" {
			return nil, "", ErrEducationSchoolRequired
		}
		out = append(out, model.Education{Degree: degree, School: school, StartYear: e.StartYear, EndYear: e.EndYear})
	}
	return out, style, nil
}

// ValidateFeaturedProjectsInput trims and validates a Featured Projects
// submission. Each entry needs a name and a description; links are
// trimmed but otherwise unvalidated, same reasoning as ValidateBannerInput's
// contact links.
func ValidateFeaturedProjectsInput(projects []model.FeaturedProject, fontStyle string) ([]model.FeaturedProject, string, error) {
	style, err := ValidateFontStyle(fontStyle)
	if err != nil {
		return nil, "", err
	}

	var out []model.FeaturedProject
	for _, proj := range projects {
		name := strings.TrimSpace(proj.Name)
		description := strings.TrimSpace(proj.Description)
		if name == "" {
			return nil, "", ErrFeaturedProjectNameRequired
		}
		if description == "" {
			return nil, "", ErrFeaturedProjectDescriptionRequired
		}
		var links []model.ProjectLink
		for _, l := range proj.Links {
			label, href := strings.TrimSpace(l.Label), strings.TrimSpace(l.Href)
			if label == "" && href == "" {
				continue
			}
			links = append(links, model.ProjectLink{Label: label, Href: href})
		}
		out = append(out, model.FeaturedProject{Name: name, Description: description, Links: links})
	}
	return out, style, nil
}

// ValidateSummaryInput trims and validates a Summary + Stats submission.
// Blank paragraphs/stat entries are dropped rather than rejected — an
// owner clearing a paragraph textarea row is removing it, not erroring.
func ValidateSummaryInput(paragraphs []string, stats []model.Stat, fontStyle string) ([]string, []model.Stat, string, error) {
	style, err := ValidateFontStyle(fontStyle)
	if err != nil {
		return nil, nil, "", err
	}

	var outParagraphs []string
	for _, p := range paragraphs {
		if p = strings.TrimSpace(p); p != "" {
			outParagraphs = append(outParagraphs, p)
		}
	}

	var outStats []model.Stat
	for _, s := range stats {
		num, label := strings.TrimSpace(s.Num), strings.TrimSpace(s.Label)
		if num == "" && label == "" {
			continue
		}
		outStats = append(outStats, model.Stat{Num: num, Label: label})
	}

	return outParagraphs, outStats, style, nil
}

// RoleInput is a trimmed, validated resume_roles submission.
type RoleInput struct {
	Title       string
	Company     string
	Location    string
	StartDate   time.Time
	EndDate     *time.Time
	Blurb       string
	Bullets     []string
	Subprojects []model.Subproject
	FontStyle   string
}

// ValidateRoleInput trims and validates a role add/edit submission.
// startDate/endDate arrive as "YYYY-MM-DD" strings (HTML <input
// type="date"> format); endDate == "" means current/present — the only
// signal for "current" (docs/features/resume.md's Business Rules), so a
// blank end-date field is valid, not an error, while a non-blank,
// unparsable one is.
func ValidateRoleInput(title, company, location, startDate, endDate, blurb string, bullets []string, subprojects []model.Subproject, fontStyle string) (RoleInput, error) {
	in := RoleInput{
		Title:    strings.TrimSpace(title),
		Company:  strings.TrimSpace(company),
		Location: strings.TrimSpace(location),
		Blurb:    strings.TrimSpace(blurb),
	}
	if in.Title == "" {
		return RoleInput{}, ErrRoleTitleRequired
	}
	if in.Company == "" {
		return RoleInput{}, ErrRoleCompanyRequired
	}

	start, err := time.Parse("2006-01-02", strings.TrimSpace(startDate))
	if err != nil {
		return RoleInput{}, ErrRoleStartDateInvalid
	}
	in.StartDate = start

	if endDate = strings.TrimSpace(endDate); endDate != "" {
		end, err := time.Parse("2006-01-02", endDate)
		if err != nil {
			return RoleInput{}, ErrRoleEndDateInvalid
		}
		in.EndDate = &end
	}

	style, err := ValidateFontStyle(fontStyle)
	if err != nil {
		return RoleInput{}, err
	}
	in.FontStyle = style

	for _, b := range bullets {
		if b = strings.TrimSpace(b); b != "" {
			in.Bullets = append(in.Bullets, b)
		}
	}
	for _, sp := range subprojects {
		heading := strings.TrimSpace(sp.Heading)
		if heading == "" {
			continue
		}
		out := model.Subproject{Heading: heading, Blurb: strings.TrimSpace(sp.Blurb)}
		if sp.ClientTag != nil {
			if tag := strings.TrimSpace(*sp.ClientTag); tag != "" {
				out.ClientTag = &tag
			}
		}
		for _, b := range sp.Bullets {
			if b = strings.TrimSpace(b); b != "" {
				out.Bullets = append(out.Bullets, b)
			}
		}
		in.Subprojects = append(in.Subprojects, out)
	}

	return in, nil
}
