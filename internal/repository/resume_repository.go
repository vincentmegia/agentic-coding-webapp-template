// Package repository contains database access: persistence queries and
// mapping database records to internal/model types. See
// docs/skills/go-backend/SKILL.md "Repository". Business logic does not
// belong here.
package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/vincentmegia/vincentmegia/internal/model"
)

// ResumeRepository reads and writes the resume_profile/resume_roles
// tables. See docs/features/resume.md's Data Model — two fixed read
// queries, not an N+1 pattern, since there's no per-row follow-up query.
//
// DB and ReadDB are deliberately separate handles (docs/features/resume.md's
// Security Considerations): every write method below uses DB (the
// full-privilege/migration role); every pure-read method uses ReadDB (a
// least-privilege, SELECT-only role in production — falls back to the
// same pool as DB when no second role is configured, see
// cmd/server/main.go's run()). Picking the wrong one per method is the
// actual mechanism enforcing that split, so it's called out on each
// method below rather than left implicit.
type ResumeRepository struct {
	DB     *sql.DB
	ReadDB *sql.DB
}

// NewResumeRepository wraps two already-open database handles — db for
// writes/migrations, readDB for reads (see the type's doc comment).
func NewResumeRepository(db, readDB *sql.DB) *ResumeRepository {
	return &ResumeRepository{DB: db, ReadDB: readDB}
}

// GetProfile fetches the resume_profile singleton row (id = 1). Read-only
// — uses ReadDB.
func (repo *ResumeRepository) GetProfile(ctx context.Context) (model.Profile, error) {
	const query = `
		SELECT role_title, tenure_label, location_label,
		       contact_links, summary_paragraphs, stats, skill_groups, education, featured_projects,
		       banner_font_style, sidebar_expertise_font_style, sidebar_education_font_style,
		       sidebar_featured_projects_font_style, summary_font_style
		FROM resume_profile
		WHERE id = 1`

	var (
		p                                                                                model.Profile
		contactLinksRaw, summaryRaw, statsRaw, skillGroupsRaw, educationRaw, projectsRaw []byte
	)

	row := repo.ReadDB.QueryRowContext(ctx, query)
	if err := row.Scan(
		&p.RoleTitle, &p.TenureLabel, &p.LocationLabel,
		&contactLinksRaw, &summaryRaw, &statsRaw, &skillGroupsRaw, &educationRaw, &projectsRaw,
		&p.BannerFontStyle, &p.SidebarExpertiseFontStyle, &p.SidebarEducationFontStyle,
		&p.SidebarFeaturedProjectsFontStyle, &p.SummaryFontStyle,
	); err != nil {
		return model.Profile{}, fmt.Errorf("query resume_profile: %w", err)
	}

	// docs/features/resume.md's Data Model: no CHECK constraints enforce
	// the inner JSONB shape, so a decode error here is a real, expected
	// failure mode (a malformed migration/manual edit) — the caller must
	// treat it as a rendering failure, never a silently blank section.
	if err := json.Unmarshal(contactLinksRaw, &p.ContactLinks); err != nil {
		return model.Profile{}, fmt.Errorf("decode contact_links: %w", err)
	}
	if err := json.Unmarshal(summaryRaw, &p.SummaryParagraphs); err != nil {
		return model.Profile{}, fmt.Errorf("decode summary_paragraphs: %w", err)
	}
	if err := json.Unmarshal(statsRaw, &p.Stats); err != nil {
		return model.Profile{}, fmt.Errorf("decode stats: %w", err)
	}
	if err := json.Unmarshal(skillGroupsRaw, &p.SkillGroups); err != nil {
		return model.Profile{}, fmt.Errorf("decode skill_groups: %w", err)
	}
	if err := json.Unmarshal(educationRaw, &p.Education); err != nil {
		return model.Profile{}, fmt.Errorf("decode education: %w", err)
	}
	if err := json.Unmarshal(projectsRaw, &p.FeaturedProjects); err != nil {
		return model.Profile{}, fmt.Errorf("decode featured_projects: %w", err)
	}

	return p, nil
}

// ListRoles fetches every resume_roles row, in display order. Read-only —
// uses ReadDB.
func (repo *ResumeRepository) ListRoles(ctx context.Context) ([]model.Role, error) {
	const query = `
		SELECT id, title, company, location, start_date, end_date, blurb, bullets, subprojects, sort_order, font_style
		FROM resume_roles
		ORDER BY sort_order`

	rows, err := repo.ReadDB.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("query resume_roles: %w", err)
	}
	defer rows.Close()

	var roles []model.Role
	for rows.Next() {
		var (
			r                          model.Role
			location, blurb            sql.NullString
			endDate                    sql.NullTime
			bulletsRaw, subprojectsRaw []byte
		)
		if err := rows.Scan(
			&r.ID, &r.Title, &r.Company, &location, &r.StartDate, &endDate, &blurb,
			&bulletsRaw, &subprojectsRaw, &r.SortOrder, &r.FontStyle,
		); err != nil {
			return nil, fmt.Errorf("scan resume_roles row: %w", err)
		}
		r.Location = location.String
		r.Blurb = blurb.String
		if endDate.Valid {
			t := endDate.Time
			r.EndDate = &t
		}
		if err := json.Unmarshal(bulletsRaw, &r.Bullets); err != nil {
			return nil, fmt.Errorf("decode bullets for role %d: %w", r.ID, err)
		}
		if err := json.Unmarshal(subprojectsRaw, &r.Subprojects); err != nil {
			return nil, fmt.Errorf("decode subprojects for role %d: %w", r.ID, err)
		}
		roles = append(roles, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate resume_roles: %w", err)
	}

	return roles, nil
}

// ---------------------------------------------------------------------------
// Write side — docs/features/resume-content-authoring.md. Each Update*
// below is a targeted UPDATE touching only its own card's columns, so
// saving one card never clobbers another's data on the resume_profile
// singleton row.
// ---------------------------------------------------------------------------

// UpdateBanner updates resume_profile's banner fields (name/title/tenure/
// location/contact links) and its font style.
func (repo *ResumeRepository) UpdateBanner(ctx context.Context, roleTitle, tenureLabel, locationLabel string, contactLinks []model.ContactLink, fontStyle string) error {
	contactLinksRaw, err := json.Marshal(contactLinks)
	if err != nil {
		return fmt.Errorf("encode contact_links: %w", err)
	}
	const query = `
		UPDATE resume_profile
		SET role_title = $1, tenure_label = $2, location_label = $3, contact_links = $4,
		    banner_font_style = $5, updated_at = NOW()
		WHERE id = 1`
	if _, err := repo.DB.ExecContext(ctx, query, roleTitle, tenureLabel, locationLabel, contactLinksRaw, fontStyle); err != nil {
		return fmt.Errorf("update resume_profile banner: %w", err)
	}
	return nil
}

// UpdateExpertise updates resume_profile's Core Expertise skill groups and
// its font style.
func (repo *ResumeRepository) UpdateExpertise(ctx context.Context, skillGroups []model.SkillGroup, fontStyle string) error {
	skillGroupsRaw, err := json.Marshal(skillGroups)
	if err != nil {
		return fmt.Errorf("encode skill_groups: %w", err)
	}
	const query = `
		UPDATE resume_profile
		SET skill_groups = $1, sidebar_expertise_font_style = $2, updated_at = NOW()
		WHERE id = 1`
	if _, err := repo.DB.ExecContext(ctx, query, skillGroupsRaw, fontStyle); err != nil {
		return fmt.Errorf("update resume_profile expertise: %w", err)
	}
	return nil
}

// UpdateEducation updates resume_profile's Education entries and its font style.
func (repo *ResumeRepository) UpdateEducation(ctx context.Context, education []model.Education, fontStyle string) error {
	educationRaw, err := json.Marshal(education)
	if err != nil {
		return fmt.Errorf("encode education: %w", err)
	}
	const query = `
		UPDATE resume_profile
		SET education = $1, sidebar_education_font_style = $2, updated_at = NOW()
		WHERE id = 1`
	if _, err := repo.DB.ExecContext(ctx, query, educationRaw, fontStyle); err != nil {
		return fmt.Errorf("update resume_profile education: %w", err)
	}
	return nil
}

// UpdateFeaturedProjects updates resume_profile's Featured Projects list and
// its font style.
func (repo *ResumeRepository) UpdateFeaturedProjects(ctx context.Context, featuredProjects []model.FeaturedProject, fontStyle string) error {
	projectsRaw, err := json.Marshal(featuredProjects)
	if err != nil {
		return fmt.Errorf("encode featured_projects: %w", err)
	}
	const query = `
		UPDATE resume_profile
		SET featured_projects = $1, sidebar_featured_projects_font_style = $2, updated_at = NOW()
		WHERE id = 1`
	if _, err := repo.DB.ExecContext(ctx, query, projectsRaw, fontStyle); err != nil {
		return fmt.Errorf("update resume_profile featured projects: %w", err)
	}
	return nil
}

// UpdateSummary updates resume_profile's summary paragraphs, stats, and its font style.
func (repo *ResumeRepository) UpdateSummary(ctx context.Context, summaryParagraphs []string, stats []model.Stat, fontStyle string) error {
	summaryRaw, err := json.Marshal(summaryParagraphs)
	if err != nil {
		return fmt.Errorf("encode summary_paragraphs: %w", err)
	}
	statsRaw, err := json.Marshal(stats)
	if err != nil {
		return fmt.Errorf("encode stats: %w", err)
	}
	const query = `
		UPDATE resume_profile
		SET summary_paragraphs = $1, stats = $2, summary_font_style = $3, updated_at = NOW()
		WHERE id = 1`
	if _, err := repo.DB.ExecContext(ctx, query, summaryRaw, statsRaw, fontStyle); err != nil {
		return fmt.Errorf("update resume_profile summary: %w", err)
	}
	return nil
}

// CreateRole inserts a new role at the end of the display order and
// returns it, including the assigned ID and sort_order — mirrors
// LandingContentRepository.CreateCarouselSlide's shape.
func (repo *ResumeRepository) CreateRole(ctx context.Context, r model.Role) (model.Role, error) {
	bulletsRaw, err := json.Marshal(r.Bullets)
	if err != nil {
		return model.Role{}, fmt.Errorf("encode bullets: %w", err)
	}
	subprojectsRaw, err := json.Marshal(r.Subprojects)
	if err != nil {
		return model.Role{}, fmt.Errorf("encode subprojects: %w", err)
	}

	const query = `
		INSERT INTO resume_roles (title, company, location, start_date, end_date, blurb, bullets, subprojects, font_style, sort_order)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE((SELECT MAX(sort_order) FROM resume_roles), 0) + 1)
		RETURNING id, sort_order`

	var location, endDate any
	if r.Location != "" {
		location = r.Location
	}
	if r.EndDate != nil {
		endDate = *r.EndDate
	}

	out := r
	err = repo.DB.QueryRowContext(ctx, query,
		r.Title, r.Company, location, r.StartDate, endDate, r.Blurb, bulletsRaw, subprojectsRaw, r.FontStyle,
	).Scan(&out.ID, &out.SortOrder)
	if err != nil {
		return model.Role{}, fmt.Errorf("insert resume_roles: %w", err)
	}
	return out, nil
}

// UpdateRole updates a role's content fields (everything except
// sort_order, which changes only via MoveRole) by ID and returns the
// stored row. Returns a wrapped sql.ErrNoRows when the role doesn't exist.
func (repo *ResumeRepository) UpdateRole(ctx context.Context, r model.Role) (model.Role, error) {
	bulletsRaw, err := json.Marshal(r.Bullets)
	if err != nil {
		return model.Role{}, fmt.Errorf("encode bullets: %w", err)
	}
	subprojectsRaw, err := json.Marshal(r.Subprojects)
	if err != nil {
		return model.Role{}, fmt.Errorf("encode subprojects: %w", err)
	}

	const query = `
		UPDATE resume_roles
		SET title = $1, company = $2, location = $3, start_date = $4, end_date = $5,
		    blurb = $6, bullets = $7, subprojects = $8, font_style = $9, updated_at = NOW()
		WHERE id = $10
		RETURNING sort_order`

	var location, endDate any
	if r.Location != "" {
		location = r.Location
	}
	if r.EndDate != nil {
		endDate = *r.EndDate
	}

	out := r
	err = repo.DB.QueryRowContext(ctx, query,
		r.Title, r.Company, location, r.StartDate, endDate, r.Blurb, bulletsRaw, subprojectsRaw, r.FontStyle, r.ID,
	).Scan(&out.SortOrder)
	if err != nil {
		return model.Role{}, fmt.Errorf("update resume_roles id %d: %w", r.ID, err)
	}
	return out, nil
}

// DeleteRole removes a role by ID. Returns a wrapped sql.ErrNoRows when the
// role doesn't exist — same not-found convention as
// LandingContentRepository.DeleteCarouselSlide.
func (repo *ResumeRepository) DeleteRole(ctx context.Context, id int64) error {
	const query = `DELETE FROM resume_roles WHERE id = $1`

	res, err := repo.DB.ExecContext(ctx, query, id)
	if err != nil {
		return fmt.Errorf("delete resume_roles: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("delete resume_roles rows affected: %w", err)
	}
	if affected == 0 {
		return fmt.Errorf("delete resume_roles id %d: %w", id, sql.ErrNoRows)
	}
	return nil
}

// MoveRole swaps a role's sort_order with its immediate neighbor. See
// moveSortOrder's doc comment (landing_content_repository.go) for the
// shared swap logic, reused as-is here since ResumeRepository lives in the
// same package.
func (repo *ResumeRepository) MoveRole(ctx context.Context, id int64, direction string) error {
	return moveSortOrder(ctx, repo.DB, "resume_roles", id, direction)
}
