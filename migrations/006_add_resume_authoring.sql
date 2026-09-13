-- Widens resume_profile/resume_roles with a font_style column per
-- authorable card, so /settings/resume can let the owner pick an
-- independent font-pairing preset per section. See
-- docs/features/resume-content-authoring.md's Data Model.
--
-- No new tables, no JSONB shape change — DEFAULT 'organic' means every
-- existing row is valid the instant this runs, no backfill step needed
-- (docs/skills/postgres/SKILL.md "Safe Schema Changes"). The CHECK
-- constraint enumerating the four preset keys is a deliberate departure
-- from resume_profile's existing "no CHECK on JSONB inner shape" stance
-- (001_create_and_seed_resume.sql): this set is small, fixed, and known
-- up front, unlike the open-ended icon-key allowlist.

-- +goose Up
ALTER TABLE resume_profile
    ADD COLUMN banner_font_style TEXT NOT NULL DEFAULT 'organic'
        CHECK (banner_font_style IN ('organic', 'classic-serif', 'modern-sans', 'editorial')),
    ADD COLUMN sidebar_expertise_font_style TEXT NOT NULL DEFAULT 'organic'
        CHECK (sidebar_expertise_font_style IN ('organic', 'classic-serif', 'modern-sans', 'editorial')),
    ADD COLUMN sidebar_education_font_style TEXT NOT NULL DEFAULT 'organic'
        CHECK (sidebar_education_font_style IN ('organic', 'classic-serif', 'modern-sans', 'editorial')),
    ADD COLUMN sidebar_featured_projects_font_style TEXT NOT NULL DEFAULT 'organic'
        CHECK (sidebar_featured_projects_font_style IN ('organic', 'classic-serif', 'modern-sans', 'editorial')),
    ADD COLUMN summary_font_style TEXT NOT NULL DEFAULT 'organic'
        CHECK (summary_font_style IN ('organic', 'classic-serif', 'modern-sans', 'editorial'));

ALTER TABLE resume_roles
    ADD COLUMN font_style TEXT NOT NULL DEFAULT 'organic'
        CHECK (font_style IN ('organic', 'classic-serif', 'modern-sans', 'editorial'));

-- +goose Down
ALTER TABLE resume_roles DROP COLUMN font_style;

ALTER TABLE resume_profile
    DROP COLUMN banner_font_style,
    DROP COLUMN sidebar_expertise_font_style,
    DROP COLUMN sidebar_education_font_style,
    DROP COLUMN sidebar_featured_projects_font_style,
    DROP COLUMN summary_font_style;
