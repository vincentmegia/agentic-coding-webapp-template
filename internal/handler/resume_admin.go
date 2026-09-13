package handler

import (
	"log/slog"
	"net/http"

	"github.com/vincentmegia/vincentmegia/internal/service"
)

// ResumeAdminHandler serves /settings/resume and its per-card/per-role
// endpoints. See docs/features/resume-content-authoring.md.
type ResumeAdminHandler struct {
	Renderer *Renderer
	Service  *service.ResumeService
	// Version is injected the same way as every other page handler's
	// Version field (see PagesHandler.Version's doc comment).
	Version string
}

// NewResumeAdminHandler constructs a ResumeAdminHandler.
func NewResumeAdminHandler(renderer *Renderer, resumeService *service.ResumeService, version string) *ResumeAdminHandler {
	return &ResumeAdminHandler{Renderer: renderer, Service: resumeService, Version: version}
}

// Index handles GET /settings/resume. Requires an authenticated
// site-owner session — same requireOwnerAuth contract as
// LandingContentHandler.Index/PagesHandler's Profile/Security.
func (h *ResumeAdminHandler) Index(w http.ResponseWriter, r *http.Request) {
	if !requireOwnerAuth(w, r) {
		return
	}

	view, err := h.Service.GetAdminView(r.Context())
	if err != nil {
		slog.Error("get resume admin view", "error", err)
		data := shellPageData(r, h.Version, "Resume", false)
		data.ContentTitle = "Resume"
		data.ContentMessage = "Couldn't load this page. Please try again shortly."
		h.Renderer.Render(w, r, data)
		return
	}

	data := shellPageData(r, h.Version, "Resume", false)
	data.ContentTemplate = "settings-resume"
	data.ResumeAdmin = view
	h.Renderer.Render(w, r, data)
}

// SaveBanner handles POST /settings/resume/banner, returning the
// refreshed resume-admin-banner-form fragment (outerHTML target).
func (h *ResumeAdminHandler) SaveBanner(w http.ResponseWriter, r *http.Request) {
	if !requireOwnerAuth(w, r) {
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "Couldn't read that submission.", http.StatusBadRequest)
		return
	}

	view, err := h.Service.SaveBanner(
		r.Context(),
		r.FormValue("role_title"), r.FormValue("tenure_label"), r.FormValue("location_label"),
		service.DecodeContactLinks(r.FormValue("contact_links")),
		r.FormValue("font_style"),
	)
	if err != nil {
		slog.Error("save resume banner", "error", err)
		h.Renderer.RenderFragment(w, "resume-admin-banner-form", service.BannerFormView{
			Error: "Couldn't save that just now. Please try again shortly.",
		})
		return
	}
	h.Renderer.RenderFragment(w, "resume-admin-banner-form", view)
}

// SaveExpertise handles POST /settings/resume/sidebar/expertise.
func (h *ResumeAdminHandler) SaveExpertise(w http.ResponseWriter, r *http.Request) {
	if !requireOwnerAuth(w, r) {
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "Couldn't read that submission.", http.StatusBadRequest)
		return
	}

	view, err := h.Service.SaveExpertise(r.Context(), service.DecodeSkillGroups(r.FormValue("skill_groups")), r.FormValue("font_style"))
	if err != nil {
		slog.Error("save resume expertise", "error", err)
		h.Renderer.RenderFragment(w, "resume-admin-expertise-form", service.ExpertiseFormView{
			Error: "Couldn't save that just now. Please try again shortly.",
		})
		return
	}
	h.Renderer.RenderFragment(w, "resume-admin-expertise-form", view)
}

// SaveEducation handles POST /settings/resume/sidebar/education.
func (h *ResumeAdminHandler) SaveEducation(w http.ResponseWriter, r *http.Request) {
	if !requireOwnerAuth(w, r) {
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "Couldn't read that submission.", http.StatusBadRequest)
		return
	}

	view, err := h.Service.SaveEducation(r.Context(), service.DecodeEducation(r.FormValue("education")), r.FormValue("font_style"))
	if err != nil {
		slog.Error("save resume education", "error", err)
		h.Renderer.RenderFragment(w, "resume-admin-education-form", service.EducationFormView{
			Error: "Couldn't save that just now. Please try again shortly.",
		})
		return
	}
	h.Renderer.RenderFragment(w, "resume-admin-education-form", view)
}

// SaveFeaturedProjects handles POST /settings/resume/sidebar/featured-projects.
func (h *ResumeAdminHandler) SaveFeaturedProjects(w http.ResponseWriter, r *http.Request) {
	if !requireOwnerAuth(w, r) {
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "Couldn't read that submission.", http.StatusBadRequest)
		return
	}

	view, err := h.Service.SaveFeaturedProjects(r.Context(), service.DecodeFeaturedProjects(r.FormValue("featured_projects")), r.FormValue("font_style"))
	if err != nil {
		slog.Error("save resume featured projects", "error", err)
		h.Renderer.RenderFragment(w, "resume-admin-featured-form", service.FeaturedFormView{
			Error: "Couldn't save that just now. Please try again shortly.",
		})
		return
	}
	h.Renderer.RenderFragment(w, "resume-admin-featured-form", view)
}

// SaveSummary handles POST /settings/resume/summary.
func (h *ResumeAdminHandler) SaveSummary(w http.ResponseWriter, r *http.Request) {
	if !requireOwnerAuth(w, r) {
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "Couldn't read that submission.", http.StatusBadRequest)
		return
	}

	view, err := h.Service.SaveSummary(
		r.Context(),
		service.DecodeLines(r.FormValue("summary_paragraphs")),
		service.DecodeStats(r.FormValue("stats")),
		r.FormValue("font_style"),
	)
	if err != nil {
		slog.Error("save resume summary", "error", err)
		h.Renderer.RenderFragment(w, "resume-admin-summary-form", service.SummaryFormView{
			Error: "Couldn't save that just now. Please try again shortly.",
		})
		return
	}
	h.Renderer.RenderFragment(w, "resume-admin-summary-form", view)
}

// CreateRole handles POST /settings/resume/roles, returning the refreshed
// resume-admin-role-editor fragment.
func (h *ResumeAdminHandler) CreateRole(w http.ResponseWriter, r *http.Request) {
	if !requireOwnerAuth(w, r) {
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "Couldn't read that submission.", http.StatusBadRequest)
		return
	}

	view, err := h.Service.CreateRole(
		r.Context(),
		r.FormValue("title"), r.FormValue("company"), r.FormValue("location"),
		r.FormValue("start_date"), r.FormValue("end_date"), r.FormValue("blurb"),
		service.DecodeLines(r.FormValue("bullets")), service.DecodeSubprojects(r.FormValue("subprojects")),
		r.FormValue("font_style"),
	)
	if err != nil {
		slog.Error("create resume role", "error", err)
		h.writeRoleError(w)
		return
	}
	h.Renderer.RenderFragment(w, "resume-admin-role-editor", view)
}

// UpdateRole handles PUT /settings/resume/roles/{id}.
func (h *ResumeAdminHandler) UpdateRole(w http.ResponseWriter, r *http.Request) {
	if !requireOwnerAuth(w, r) {
		return
	}
	id, ok := parsePathID(w, r)
	if !ok {
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "Couldn't read that submission.", http.StatusBadRequest)
		return
	}

	view, err := h.Service.UpdateRole(
		r.Context(), id,
		r.FormValue("title"), r.FormValue("company"), r.FormValue("location"),
		r.FormValue("start_date"), r.FormValue("end_date"), r.FormValue("blurb"),
		service.DecodeLines(r.FormValue("bullets")), service.DecodeSubprojects(r.FormValue("subprojects")),
		r.FormValue("font_style"),
	)
	if err != nil {
		slog.Error("update resume role", "error", err, "id", id)
		h.writeRoleError(w)
		return
	}
	h.Renderer.RenderFragment(w, "resume-admin-role-editor", view)
}

// DeleteRole handles DELETE /settings/resume/roles/{id}.
func (h *ResumeAdminHandler) DeleteRole(w http.ResponseWriter, r *http.Request) {
	if !requireOwnerAuth(w, r) {
		return
	}
	id, ok := parsePathID(w, r)
	if !ok {
		return
	}

	view, err := h.Service.DeleteRole(r.Context(), id)
	if err != nil {
		slog.Error("delete resume role", "error", err, "id", id)
		h.writeRoleError(w)
		return
	}
	h.Renderer.RenderFragment(w, "resume-admin-role-editor", view)
}

// MoveRole handles POST /settings/resume/roles/{id}/move.
func (h *ResumeAdminHandler) MoveRole(w http.ResponseWriter, r *http.Request) {
	if !requireOwnerAuth(w, r) {
		return
	}
	id, ok := parsePathID(w, r)
	if !ok {
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "Couldn't read that submission.", http.StatusBadRequest)
		return
	}

	view, err := h.Service.MoveRole(r.Context(), id, r.FormValue("direction"))
	if err != nil {
		slog.Error("move resume role", "error", err, "id", id)
		h.writeRoleError(w)
		return
	}
	h.Renderer.RenderFragment(w, "resume-admin-role-editor", view)
}

// writeRoleError renders the resume-admin-role-editor fragment with a
// generic error and no roles, for the rare case a DB failure happens after
// the primary write — never exposes the raw error to the client, per
// docs/skills/go-backend/SKILL.md "Errors".
func (h *ResumeAdminHandler) writeRoleError(w http.ResponseWriter) {
	h.Renderer.RenderFragment(w, "resume-admin-role-editor", service.RoleListView{
		Error: "Couldn't save that just now. Please try again shortly.",
	})
}
