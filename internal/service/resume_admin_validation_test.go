package service

import (
	"testing"

	"github.com/vincentmegia/vincentmegia/internal/model"
)

func TestValidateFontStyle(t *testing.T) {
	if got, err := ValidateFontStyle(""); err != nil || got != "organic" {
		t.Errorf("ValidateFontStyle(\"\") = (%q, %v), want (\"organic\", nil)", got, err)
	}
	if got, err := ValidateFontStyle("  classic-serif  "); err != nil || got != "classic-serif" {
		t.Errorf("ValidateFontStyle(padded valid key) = (%q, %v), want (\"classic-serif\", nil)", got, err)
	}
	if _, err := ValidateFontStyle("comic-sans"); err != ErrInvalidFontStyle {
		t.Errorf("ValidateFontStyle(unknown key) error = %v, want ErrInvalidFontStyle", err)
	}
}

func TestValidateBannerInput(t *testing.T) {
	if _, err := ValidateBannerInput("", "tenure", "location", nil, ""); err != ErrBannerRoleTitleRequired {
		t.Errorf("missing role title: error = %v, want ErrBannerRoleTitleRequired", err)
	}
	if _, err := ValidateBannerInput("title", "", "location", nil, ""); err != ErrBannerTenureLabelRequired {
		t.Errorf("missing tenure label: error = %v, want ErrBannerTenureLabelRequired", err)
	}
	if _, err := ValidateBannerInput("title", "tenure", "", nil, ""); err != ErrBannerLocationLabelRequired {
		t.Errorf("missing location label: error = %v, want ErrBannerLocationLabelRequired", err)
	}
	if _, err := ValidateBannerInput("title", "tenure", "location", nil, "not-a-preset"); err != ErrInvalidFontStyle {
		t.Errorf("invalid font style: error = %v, want ErrInvalidFontStyle", err)
	}

	p, err := ValidateBannerInput("  Principal Engineer  ", "18+ years", "Remote", []model.ContactLink{
		{Label: " Email ", Href: " mailto:x@y.com ", Icon: " mail "},
	}, "classic-serif")
	if err != nil {
		t.Fatalf("valid input: unexpected error %v", err)
	}
	if p.RoleTitle != "Principal Engineer" || p.TenureLabel != "18+ years" || p.LocationLabel != "Remote" {
		t.Errorf("valid input: fields not trimmed correctly: %+v", p)
	}
	if p.BannerFontStyle != "classic-serif" {
		t.Errorf("BannerFontStyle = %q, want \"classic-serif\"", p.BannerFontStyle)
	}
	if len(p.ContactLinks) != 1 || p.ContactLinks[0].Label != "Email" || p.ContactLinks[0].Href != "mailto:x@y.com" || p.ContactLinks[0].Icon != "mail" {
		t.Errorf("contact link not trimmed correctly: %+v", p.ContactLinks)
	}
}

func TestValidateExpertiseInput(t *testing.T) {
	if _, _, err := ValidateExpertiseInput([]model.SkillGroup{{Name: "", Skills: []string{"Go"}}}, ""); err != ErrSkillGroupNameRequired {
		t.Errorf("missing group name: error = %v, want ErrSkillGroupNameRequired", err)
	}
	if _, _, err := ValidateExpertiseInput([]model.SkillGroup{{Name: "Backend", Skills: []string{"  "}}}, ""); err != ErrSkillGroupSkillsRequired {
		t.Errorf("all-blank skills: error = %v, want ErrSkillGroupSkillsRequired", err)
	}

	groups, style, err := ValidateExpertiseInput([]model.SkillGroup{
		{Name: " Backend ", Skills: []string{" Go ", "", "Postgres"}},
	}, "modern-sans")
	if err != nil {
		t.Fatalf("valid input: unexpected error %v", err)
	}
	if style != "modern-sans" {
		t.Errorf("style = %q, want modern-sans", style)
	}
	if len(groups) != 1 || groups[0].Name != "Backend" || len(groups[0].Skills) != 2 {
		t.Errorf("groups not trimmed/filtered correctly: %+v", groups)
	}
}

func TestValidateEducationInput(t *testing.T) {
	if _, _, err := ValidateEducationInput([]model.Education{{Degree: "", School: "MIT"}}, ""); err != ErrEducationDegreeRequired {
		t.Errorf("missing degree: error = %v, want ErrEducationDegreeRequired", err)
	}
	if _, _, err := ValidateEducationInput([]model.Education{{Degree: "BS", School: ""}}, ""); err != ErrEducationSchoolRequired {
		t.Errorf("missing school: error = %v, want ErrEducationSchoolRequired", err)
	}
	entries, _, err := ValidateEducationInput([]model.Education{{Degree: " BS CS ", School: " MIT ", StartYear: 2005, EndYear: 2009}}, "")
	if err != nil {
		t.Fatalf("valid input: unexpected error %v", err)
	}
	if entries[0].Degree != "BS CS" || entries[0].School != "MIT" {
		t.Errorf("entry not trimmed correctly: %+v", entries[0])
	}
}

func TestValidateFeaturedProjectsInput(t *testing.T) {
	if _, _, err := ValidateFeaturedProjectsInput([]model.FeaturedProject{{Name: "", Description: "x"}}, ""); err != ErrFeaturedProjectNameRequired {
		t.Errorf("missing name: error = %v, want ErrFeaturedProjectNameRequired", err)
	}
	if _, _, err := ValidateFeaturedProjectsInput([]model.FeaturedProject{{Name: "x", Description: ""}}, ""); err != ErrFeaturedProjectDescriptionRequired {
		t.Errorf("missing description: error = %v, want ErrFeaturedProjectDescriptionRequired", err)
	}

	projects, _, err := ValidateFeaturedProjectsInput([]model.FeaturedProject{
		{Name: "Fishing Game", Description: "A canvas game", Links: []model.ProjectLink{{Label: "", Href: ""}, {Label: "Play", Href: "/fishing-game"}}},
	}, "")
	if err != nil {
		t.Fatalf("valid input: unexpected error %v", err)
	}
	if len(projects[0].Links) != 1 || projects[0].Links[0].Label != "Play" {
		t.Errorf("blank link not dropped: %+v", projects[0].Links)
	}
}

func TestValidateSummaryInput(t *testing.T) {
	paragraphs, stats, style, err := ValidateSummaryInput(
		[]string{" First paragraph ", "  ", "Second"},
		[]model.Stat{{Num: " 18+ ", Label: " years "}, {Num: "", Label: ""}},
		"editorial",
	)
	if err != nil {
		t.Fatalf("unexpected error %v", err)
	}
	if style != "editorial" {
		t.Errorf("style = %q, want editorial", style)
	}
	if len(paragraphs) != 2 || paragraphs[0] != "First paragraph" || paragraphs[1] != "Second" {
		t.Errorf("paragraphs not trimmed/filtered correctly: %+v", paragraphs)
	}
	if len(stats) != 1 || stats[0].Num != "18+" || stats[0].Label != "years" {
		t.Errorf("stats not trimmed/filtered correctly: %+v", stats)
	}
}

func TestValidateRoleInput(t *testing.T) {
	if _, err := ValidateRoleInput("", "Acme", "", "2020-01-01", "", "", nil, nil, ""); err != ErrRoleTitleRequired {
		t.Errorf("missing title: error = %v, want ErrRoleTitleRequired", err)
	}
	if _, err := ValidateRoleInput("Engineer", "", "", "2020-01-01", "", "", nil, nil, ""); err != ErrRoleCompanyRequired {
		t.Errorf("missing company: error = %v, want ErrRoleCompanyRequired", err)
	}
	if _, err := ValidateRoleInput("Engineer", "Acme", "", "not-a-date", "", "", nil, nil, ""); err != ErrRoleStartDateInvalid {
		t.Errorf("bad start date: error = %v, want ErrRoleStartDateInvalid", err)
	}
	if _, err := ValidateRoleInput("Engineer", "Acme", "", "2020-01-01", "not-a-date", "", nil, nil, ""); err != ErrRoleEndDateInvalid {
		t.Errorf("bad end date: error = %v, want ErrRoleEndDateInvalid", err)
	}

	in, err := ValidateRoleInput(
		" Engineer ", " Acme ", " Remote ", "2020-01-01", "", " Blurb ",
		[]string{" Shipped X ", "  "},
		[]model.Subproject{{Heading: " Client A ", Blurb: " Did Y ", Bullets: []string{" B1 ", ""}}},
		"organic",
	)
	if err != nil {
		t.Fatalf("valid input: unexpected error %v", err)
	}
	if in.EndDate != nil {
		t.Errorf("blank end date should mean current (nil), got %v", in.EndDate)
	}
	if len(in.Bullets) != 1 || in.Bullets[0] != "Shipped X" {
		t.Errorf("bullets not trimmed/filtered correctly: %+v", in.Bullets)
	}
	if len(in.Subprojects) != 1 || in.Subprojects[0].Heading != "Client A" || len(in.Subprojects[0].Bullets) != 1 {
		t.Errorf("subprojects not trimmed/filtered correctly: %+v", in.Subprojects)
	}
}
