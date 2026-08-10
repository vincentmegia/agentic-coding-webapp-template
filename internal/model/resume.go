// Package model holds domain types decoded from the database. See
// docs/skills/go-backend/SKILL.md "Model".
package model

import "time"

// ContactLink is one entry in resume_profile.contact_links.
type ContactLink struct {
	Label string `json:"label"`
	Href  string `json:"href"`
	// Icon is a lookup key (e.g. "phone"), never raw markup — resolved
	// through a fixed Go allowlist in internal/service, per
	// docs/features/resume.md's Security Considerations.
	Icon string `json:"icon"`
}

// Stat is one entry in resume_profile.stats.
type Stat struct {
	Num   string `json:"num"`
	Label string `json:"label"`
}

// SkillGroup is one entry in resume_profile.skill_groups.
type SkillGroup struct {
	Name   string   `json:"name"`
	Skills []string `json:"skills"`
}

// Education is one entry in resume_profile.education.
type Education struct {
	Degree    string `json:"degree"`
	School    string `json:"school"`
	StartYear int    `json:"start_year"`
	EndYear   int    `json:"end_year"`
}

// ProjectLink is one entry in a FeaturedProject's links.
type ProjectLink struct {
	Label string `json:"label"`
	Href  string `json:"href"`
}

// FeaturedProject is one entry in resume_profile.featured_projects.
type FeaturedProject struct {
	Name        string        `json:"name"`
	Description string        `json:"description"`
	Links       []ProjectLink `json:"links"`
}

// Profile is the resume_profile singleton row (id = 1), with its JSONB
// columns already decoded. See docs/features/resume.md's Data Model.
type Profile struct {
	RoleTitle         string
	TenureLabel       string
	LocationLabel     string
	ContactLinks      []ContactLink
	SummaryParagraphs []string
	Stats             []Stat
	SkillGroups       []SkillGroup
	Education         []Education
	FeaturedProjects  []FeaturedProject
}

// Subproject is one entry in a Role's subprojects.
type Subproject struct {
	Heading string `json:"heading"`
	// ClientTag is nil for a role's own sub-projects (no client
	// engagement), set for a consultancy client engagement — see
	// migrations/001_create_and_seed_resume.sql for both cases.
	ClientTag *string  `json:"client_tag"`
	Blurb     string   `json:"blurb"`
	Bullets   []string `json:"bullets"`
}

// Role is one resume_roles row, with its JSONB columns already decoded.
type Role struct {
	ID       int64
	Title    string
	Company  string
	Location string
	// StartDate/EndDate are real DATE columns, not free text — display
	// labels ("APR 2021", "PRESENT") are computed in internal/service, not
	// stored. EndDate nil means current/present — the only signal for
	// "current" (docs/features/resume.md's Business Rules).
	StartDate   time.Time
	EndDate     *time.Time
	Blurb       string
	Bullets     []string
	Subprojects []Subproject
	// SortOrder is the authoritative display order, not StartDate — a
	// role's nested client engagements aren't strictly chronological with
	// the parent role's own start/end.
	SortOrder int
}
