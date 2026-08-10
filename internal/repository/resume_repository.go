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

// ResumeRepository reads the resume_profile/resume_roles tables. See
// docs/features/resume.md's Data Model — two fixed queries, not an N+1
// pattern, since there's no per-row follow-up query.
type ResumeRepository struct {
	DB *sql.DB
}

// NewResumeRepository wraps an already-open database handle.
func NewResumeRepository(db *sql.DB) *ResumeRepository {
	return &ResumeRepository{DB: db}
}

// GetProfile fetches the resume_profile singleton row (id = 1).
func (repo *ResumeRepository) GetProfile(ctx context.Context) (model.Profile, error) {
	const query = `
		SELECT role_title, tenure_label, location_label,
		       contact_links, summary_paragraphs, stats, skill_groups, education, featured_projects
		FROM resume_profile
		WHERE id = 1`

	var (
		p                                                                                model.Profile
		contactLinksRaw, summaryRaw, statsRaw, skillGroupsRaw, educationRaw, projectsRaw []byte
	)

	row := repo.DB.QueryRowContext(ctx, query)
	if err := row.Scan(
		&p.RoleTitle, &p.TenureLabel, &p.LocationLabel,
		&contactLinksRaw, &summaryRaw, &statsRaw, &skillGroupsRaw, &educationRaw, &projectsRaw,
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

// ListRoles fetches every resume_roles row, in display order.
func (repo *ResumeRepository) ListRoles(ctx context.Context) ([]model.Role, error) {
	const query = `
		SELECT id, title, company, location, start_date, end_date, blurb, bullets, subprojects, sort_order
		FROM resume_roles
		ORDER BY sort_order`

	rows, err := repo.DB.QueryContext(ctx, query)
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
			&bulletsRaw, &subprojectsRaw, &r.SortOrder,
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
