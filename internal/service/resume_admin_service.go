package service

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/vincentmegia/vincentmegia/internal/model"
)

// This file is ResumeService's write side — the six independently-saved
// card editors plus role CRUD/reorder backing /settings/resume. See
// docs/features/resume-content-authoring.md.
//
// Unlike LandingContentService, there is no separate API-shaped/Form-shaped
// split here: no second caller (HQ or otherwise) exists for resume content
// (docs/features/resume-content-authoring.md's Scope — "no HQ/home-admin
// involvement" is a hard constraint, not a default), so there is exactly
// one shape: validate, persist, and fold a validation failure into the
// returned view's Error field for the HTML editor to render inline.

// BannerFormView backs components/resume-admin-banner-form.html.
type BannerFormView struct {
	RoleTitle     string
	TenureLabel   string
	LocationLabel string
	ContactLinks  []model.ContactLink
	FontOptions   []FontStyleOption
	// Error is a curated, user-facing validation message. "" means no error.
	Error string
}

// ExpertiseFormView backs components/resume-admin-expertise-form.html.
type ExpertiseFormView struct {
	SkillGroups []model.SkillGroup
	FontOptions []FontStyleOption
	Error       string
}

// EducationFormView backs components/resume-admin-education-form.html.
type EducationFormView struct {
	Education   []model.Education
	FontOptions []FontStyleOption
	Error       string
}

// FeaturedFormView backs components/resume-admin-featured-form.html.
type FeaturedFormView struct {
	FeaturedProjects []model.FeaturedProject
	FontOptions      []FontStyleOption
	Error            string
}

// SummaryFormView backs components/resume-admin-summary-form.html.
type SummaryFormView struct {
	SummaryParagraphs []string
	Stats             []model.Stat
	FontOptions       []FontStyleOption
	Error             string
}

// RoleAdminView is one role as rendered in the /settings/resume editor —
// StartDate/EndDate are "YYYY-MM-DD" strings (HTML <input type="date">
// format), EndDate == "" meaning current/present, unlike RoleView's
// display-formatted DateRange.
type RoleAdminView struct {
	ID          int64
	Title       string
	Company     string
	Location    string
	StartDate   string
	EndDate     string
	Blurb       string
	Bullets     []string
	Subprojects []model.Subproject
	FontOptions []FontStyleOption
}

// RoleListView backs components/resume-admin-role-editor.html.
type RoleListView struct {
	Roles []RoleAdminView
	Error string
}

// ResumeAdminView backs web/templates/pages/settings-resume.html
// (GET /settings/resume).
type ResumeAdminView struct {
	Banner    BannerFormView
	Expertise ExpertiseFormView
	Education EducationFormView
	Featured  FeaturedFormView
	Summary   SummaryFormView
	Roles     RoleListView
}

// GetAdminView assembles the full /settings/resume view.
func (s *ResumeService) GetAdminView(ctx context.Context) (ResumeAdminView, error) {
	banner, err := s.bannerView(ctx)
	if err != nil {
		return ResumeAdminView{}, err
	}
	expertise, err := s.expertiseView(ctx)
	if err != nil {
		return ResumeAdminView{}, err
	}
	education, err := s.educationView(ctx)
	if err != nil {
		return ResumeAdminView{}, err
	}
	featured, err := s.featuredView(ctx)
	if err != nil {
		return ResumeAdminView{}, err
	}
	summary, err := s.summaryView(ctx)
	if err != nil {
		return ResumeAdminView{}, err
	}
	roles, err := s.roleListView(ctx)
	if err != nil {
		return ResumeAdminView{}, err
	}
	return ResumeAdminView{
		Banner: banner, Expertise: expertise, Education: education,
		Featured: featured, Summary: summary, Roles: roles,
	}, nil
}

func (s *ResumeService) bannerView(ctx context.Context) (BannerFormView, error) {
	p, err := s.Repo.GetProfile(ctx)
	if err != nil {
		return BannerFormView{}, fmt.Errorf("get resume profile: %w", err)
	}
	return BannerFormView{
		RoleTitle: p.RoleTitle, TenureLabel: p.TenureLabel, LocationLabel: p.LocationLabel,
		ContactLinks: p.ContactLinks, FontOptions: fontStyleOptions(p.BannerFontStyle),
	}, nil
}

// SaveBanner validates and persists a banner-form submission
// (POST /settings/resume/banner). A validation failure is reported inline
// on the returned view (Error set, err nil) — only a genuine failure
// (e.g. a DB error) returns a non-nil err, which the caller must not show
// to the client directly.
func (s *ResumeService) SaveBanner(ctx context.Context, roleTitle, tenureLabel, locationLabel string, contactLinks []model.ContactLink, fontStyle string) (BannerFormView, error) {
	p, err := ValidateBannerInput(roleTitle, tenureLabel, locationLabel, contactLinks, fontStyle)
	if err != nil {
		if IsResumeValidationError(err) {
			return BannerFormView{
				RoleTitle: roleTitle, TenureLabel: tenureLabel, LocationLabel: locationLabel,
				ContactLinks: contactLinks, FontOptions: fontStyleOptions(fontStyle), Error: err.Error(),
			}, nil
		}
		return BannerFormView{}, err
	}
	if err := s.Repo.UpdateBanner(ctx, p.RoleTitle, p.TenureLabel, p.LocationLabel, p.ContactLinks, p.BannerFontStyle); err != nil {
		return BannerFormView{}, fmt.Errorf("update banner: %w", err)
	}
	return s.bannerView(ctx)
}

func (s *ResumeService) expertiseView(ctx context.Context) (ExpertiseFormView, error) {
	p, err := s.Repo.GetProfile(ctx)
	if err != nil {
		return ExpertiseFormView{}, fmt.Errorf("get resume profile: %w", err)
	}
	return ExpertiseFormView{SkillGroups: p.SkillGroups, FontOptions: fontStyleOptions(p.SidebarExpertiseFontStyle)}, nil
}

// SaveExpertise validates and persists a Core Expertise submission
// (POST /settings/resume/sidebar/expertise).
func (s *ResumeService) SaveExpertise(ctx context.Context, groups []model.SkillGroup, fontStyle string) (ExpertiseFormView, error) {
	validated, style, err := ValidateExpertiseInput(groups, fontStyle)
	if err != nil {
		if IsResumeValidationError(err) {
			return ExpertiseFormView{SkillGroups: groups, FontOptions: fontStyleOptions(fontStyle), Error: err.Error()}, nil
		}
		return ExpertiseFormView{}, err
	}
	if err := s.Repo.UpdateExpertise(ctx, validated, style); err != nil {
		return ExpertiseFormView{}, fmt.Errorf("update expertise: %w", err)
	}
	return s.expertiseView(ctx)
}

func (s *ResumeService) educationView(ctx context.Context) (EducationFormView, error) {
	p, err := s.Repo.GetProfile(ctx)
	if err != nil {
		return EducationFormView{}, fmt.Errorf("get resume profile: %w", err)
	}
	return EducationFormView{Education: p.Education, FontOptions: fontStyleOptions(p.SidebarEducationFontStyle)}, nil
}

// SaveEducation validates and persists an Education submission
// (POST /settings/resume/sidebar/education).
func (s *ResumeService) SaveEducation(ctx context.Context, entries []model.Education, fontStyle string) (EducationFormView, error) {
	validated, style, err := ValidateEducationInput(entries, fontStyle)
	if err != nil {
		if IsResumeValidationError(err) {
			return EducationFormView{Education: entries, FontOptions: fontStyleOptions(fontStyle), Error: err.Error()}, nil
		}
		return EducationFormView{}, err
	}
	if err := s.Repo.UpdateEducation(ctx, validated, style); err != nil {
		return EducationFormView{}, fmt.Errorf("update education: %w", err)
	}
	return s.educationView(ctx)
}

func (s *ResumeService) featuredView(ctx context.Context) (FeaturedFormView, error) {
	p, err := s.Repo.GetProfile(ctx)
	if err != nil {
		return FeaturedFormView{}, fmt.Errorf("get resume profile: %w", err)
	}
	return FeaturedFormView{FeaturedProjects: p.FeaturedProjects, FontOptions: fontStyleOptions(p.SidebarFeaturedProjectsFontStyle)}, nil
}

// SaveFeaturedProjects validates and persists a Featured Projects
// submission (POST /settings/resume/sidebar/featured-projects).
func (s *ResumeService) SaveFeaturedProjects(ctx context.Context, projects []model.FeaturedProject, fontStyle string) (FeaturedFormView, error) {
	validated, style, err := ValidateFeaturedProjectsInput(projects, fontStyle)
	if err != nil {
		if IsResumeValidationError(err) {
			return FeaturedFormView{FeaturedProjects: projects, FontOptions: fontStyleOptions(fontStyle), Error: err.Error()}, nil
		}
		return FeaturedFormView{}, err
	}
	if err := s.Repo.UpdateFeaturedProjects(ctx, validated, style); err != nil {
		return FeaturedFormView{}, fmt.Errorf("update featured projects: %w", err)
	}
	return s.featuredView(ctx)
}

func (s *ResumeService) summaryView(ctx context.Context) (SummaryFormView, error) {
	p, err := s.Repo.GetProfile(ctx)
	if err != nil {
		return SummaryFormView{}, fmt.Errorf("get resume profile: %w", err)
	}
	return SummaryFormView{
		SummaryParagraphs: p.SummaryParagraphs, Stats: p.Stats,
		FontOptions: fontStyleOptions(p.SummaryFontStyle),
	}, nil
}

// SaveSummary validates and persists a Summary + Stats submission
// (POST /settings/resume/summary).
func (s *ResumeService) SaveSummary(ctx context.Context, paragraphs []string, stats []model.Stat, fontStyle string) (SummaryFormView, error) {
	validatedParagraphs, validatedStats, style, err := ValidateSummaryInput(paragraphs, stats, fontStyle)
	if err != nil {
		if IsResumeValidationError(err) {
			return SummaryFormView{SummaryParagraphs: paragraphs, Stats: stats, FontOptions: fontStyleOptions(fontStyle), Error: err.Error()}, nil
		}
		return SummaryFormView{}, err
	}
	if err := s.Repo.UpdateSummary(ctx, validatedParagraphs, validatedStats, style); err != nil {
		return SummaryFormView{}, fmt.Errorf("update summary: %w", err)
	}
	return s.summaryView(ctx)
}

// toRoleAdminView formats a model.Role's dates back into the
// "YYYY-MM-DD" shape the editor's <input type="date"> fields use — the
// inverse of ValidateRoleInput's time.Parse.
func toRoleAdminView(r model.Role) RoleAdminView {
	v := RoleAdminView{
		ID: r.ID, Title: r.Title, Company: r.Company, Location: r.Location,
		StartDate: r.StartDate.Format("2006-01-02"), Blurb: r.Blurb,
		Bullets: r.Bullets, Subprojects: r.Subprojects,
		FontOptions: fontStyleOptions(r.FontStyle),
	}
	if r.EndDate != nil {
		v.EndDate = r.EndDate.Format("2006-01-02")
	}
	return v
}

func (s *ResumeService) roleListView(ctx context.Context) (RoleListView, error) {
	roles, err := s.Repo.ListRoles(ctx)
	if err != nil {
		return RoleListView{}, fmt.Errorf("list resume roles: %w", err)
	}
	views := make([]RoleAdminView, len(roles))
	for i, r := range roles {
		views[i] = toRoleAdminView(r)
	}
	return RoleListView{Roles: views}, nil
}

func (s *ResumeService) roleListViewWithError(ctx context.Context, message string) (RoleListView, error) {
	view, err := s.roleListView(ctx)
	if err != nil {
		return RoleListView{}, err
	}
	view.Error = message
	return view, nil
}

// CreateRole validates and appends a new role
// (POST /settings/resume/roles).
func (s *ResumeService) CreateRole(ctx context.Context, title, company, location, startDate, endDate, blurb string, bullets []string, subprojects []model.Subproject, fontStyle string) (RoleListView, error) {
	in, err := ValidateRoleInput(title, company, location, startDate, endDate, blurb, bullets, subprojects, fontStyle)
	if err != nil {
		if IsResumeValidationError(err) {
			return s.roleListViewWithError(ctx, err.Error())
		}
		return RoleListView{}, err
	}
	_, err = s.Repo.CreateRole(ctx, model.Role{
		Title: in.Title, Company: in.Company, Location: in.Location,
		StartDate: in.StartDate, EndDate: in.EndDate, Blurb: in.Blurb,
		Bullets: in.Bullets, Subprojects: in.Subprojects, FontStyle: in.FontStyle,
	})
	if err != nil {
		return RoleListView{}, fmt.Errorf("create role: %w", err)
	}
	return s.roleListView(ctx)
}

// UpdateRole validates and updates a role's fields by ID
// (PUT /settings/resume/roles/{id}). sort_order is never written here —
// see MoveRole.
func (s *ResumeService) UpdateRole(ctx context.Context, id int64, title, company, location, startDate, endDate, blurb string, bullets []string, subprojects []model.Subproject, fontStyle string) (RoleListView, error) {
	in, err := ValidateRoleInput(title, company, location, startDate, endDate, blurb, bullets, subprojects, fontStyle)
	if err != nil {
		if IsResumeValidationError(err) {
			return s.roleListViewWithError(ctx, err.Error())
		}
		return RoleListView{}, err
	}
	_, err = s.Repo.UpdateRole(ctx, model.Role{
		ID: id, Title: in.Title, Company: in.Company, Location: in.Location,
		StartDate: in.StartDate, EndDate: in.EndDate, Blurb: in.Blurb,
		Bullets: in.Bullets, Subprojects: in.Subprojects, FontStyle: in.FontStyle,
	})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return s.roleListViewWithError(ctx, ErrRoleNotFound.Error())
		}
		return RoleListView{}, fmt.Errorf("update role: %w", err)
	}
	return s.roleListView(ctx)
}

// DeleteRole removes a role by ID (DELETE /settings/resume/roles/{id}). A
// role that's already gone is treated as success, not an error — same
// idempotent-delete reasoning as LandingContentService.DeleteSlideForm.
func (s *ResumeService) DeleteRole(ctx context.Context, id int64) (RoleListView, error) {
	if err := s.Repo.DeleteRole(ctx, id); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return RoleListView{}, fmt.Errorf("delete role: %w", err)
	}
	return s.roleListView(ctx)
}

// MoveRole swaps a role's display order with its neighbour
// (POST /settings/resume/roles/{id}/move). direction is "up" or "down";
// anything else is a no-op (see repository.moveSortOrder).
func (s *ResumeService) MoveRole(ctx context.Context, id int64, direction string) (RoleListView, error) {
	if err := s.Repo.MoveRole(ctx, id, direction); err != nil {
		return RoleListView{}, fmt.Errorf("move role: %w", err)
	}
	return s.roleListView(ctx)
}
