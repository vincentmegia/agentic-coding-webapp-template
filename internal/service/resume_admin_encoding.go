package service

import (
	"strconv"
	"strings"

	"github.com/vincentmegia/vincentmegia/internal/model"
)

// This file decodes the line-delimited textarea encoding
// /settings/resume's forms use for list-of-struct fields (contact links,
// skill groups, education, featured projects, stats, subprojects) — one
// item per line, fields within a line separated by "|" (or "," /";" for a
// field that is itself a list). This is a deliberate simplification versus
// a fully dynamic add/remove-row JS UI: docs/features/resume-content-authoring.md
// commits to "edited as a whole array replace within the card's form," not
// to a specific input widget, and this project has no add/remove-row JS
// infrastructure today (landing-content-authoring.md's carousel/Selected-work
// editors sidestep the question entirely by giving every row its own
// form/endpoint, which resume_roles' own CRUD does too — this encoding is
// only for the profile-level list fields that stay one form per card).
// Pipe/comma/semicolon are assumed not to appear inside a label/name/blurb
// for this single-owner site's real content; revisit if that assumption
// breaks in practice, same reasoning landing-content-authoring.md's Open
// Questions used for its own free-typed-field simplification.
//
// Templates render the inverse direction (struct slice -> textarea lines)
// directly via {{range}}, so no corresponding "format" functions exist
// here — only decode.

// splitLines splits raw into trimmed, non-empty lines.
func splitLines(raw string) []string {
	var lines []string
	for _, line := range strings.Split(raw, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

// splitField splits one line into exactly want parts on "|", trimming
// each. Missing trailing parts are "".
func splitField(line string, want int) []string {
	parts := strings.SplitN(line, "|", want)
	out := make([]string, want)
	for i := range out {
		if i < len(parts) {
			out[i] = strings.TrimSpace(parts[i])
		}
	}
	return out
}

// DecodeLines is ParseBullets/ParseSummaryParagraphs' shared
// implementation — a flat list, one entry per non-empty line.
func DecodeLines(raw string) []string {
	return splitLines(raw)
}

// DecodeContactLinks parses "Label | Href | Icon" lines (Icon optional).
func DecodeContactLinks(raw string) []model.ContactLink {
	var out []model.ContactLink
	for _, line := range splitLines(raw) {
		f := splitField(line, 3)
		out = append(out, model.ContactLink{Label: f[0], Href: f[1], Icon: f[2]})
	}
	return out
}

// DecodeSkillGroups parses "Group Name: skill1, skill2, skill3" lines.
func DecodeSkillGroups(raw string) []model.SkillGroup {
	var out []model.SkillGroup
	for _, line := range splitLines(raw) {
		name, skillsRaw, _ := strings.Cut(line, ":")
		var skills []string
		for _, sk := range strings.Split(skillsRaw, ",") {
			if sk = strings.TrimSpace(sk); sk != "" {
				skills = append(skills, sk)
			}
		}
		out = append(out, model.SkillGroup{Name: strings.TrimSpace(name), Skills: skills})
	}
	return out
}

// DecodeEducation parses "Degree | School | StartYear | EndYear" lines.
// A non-numeric year decodes to 0 rather than erroring — the validation
// layer only requires Degree/School, matching model.Education's existing
// int fields having no NOT NULL-style requirement beyond row presence.
func DecodeEducation(raw string) []model.Education {
	var out []model.Education
	for _, line := range splitLines(raw) {
		f := splitField(line, 4)
		startYear, _ := strconv.Atoi(f[2])
		endYear, _ := strconv.Atoi(f[3])
		out = append(out, model.Education{Degree: f[0], School: f[1], StartYear: startYear, EndYear: endYear})
	}
	return out
}

// DecodeFeaturedProjects parses "Name | Description | Label1=Href1; Label2=Href2"
// lines (the links segment is optional).
func DecodeFeaturedProjects(raw string) []model.FeaturedProject {
	var out []model.FeaturedProject
	for _, line := range splitLines(raw) {
		f := splitField(line, 3)
		var links []model.ProjectLink
		for _, pair := range strings.Split(f[2], ";") {
			if pair = strings.TrimSpace(pair); pair == "" {
				continue
			}
			label, href, _ := strings.Cut(pair, "=")
			links = append(links, model.ProjectLink{Label: strings.TrimSpace(label), Href: strings.TrimSpace(href)})
		}
		out = append(out, model.FeaturedProject{Name: f[0], Description: f[1], Links: links})
	}
	return out
}

// DecodeStats parses "Num | Label" lines.
func DecodeStats(raw string) []model.Stat {
	var out []model.Stat
	for _, line := range splitLines(raw) {
		f := splitField(line, 2)
		out = append(out, model.Stat{Num: f[0], Label: f[1]})
	}
	return out
}

// DecodeSubprojects parses "Heading | ClientTag | Blurb | bullet1; bullet2"
// lines (ClientTag and the bullets segment are both optional; a blank
// ClientTag decodes to nil, not an empty-string tag, matching
// model.Subproject.ClientTag's "nil means no client-engagement tag" contract).
func DecodeSubprojects(raw string) []model.Subproject {
	var out []model.Subproject
	for _, line := range splitLines(raw) {
		f := splitField(line, 4)
		sp := model.Subproject{Heading: f[0], Blurb: f[2]}
		if f[1] != "" {
			tag := f[1]
			sp.ClientTag = &tag
		}
		for _, b := range strings.Split(f[3], ";") {
			if b = strings.TrimSpace(b); b != "" {
				sp.Bullets = append(sp.Bullets, b)
			}
		}
		out = append(out, sp)
	}
	return out
}
