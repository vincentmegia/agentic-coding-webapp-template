package handler

import (
	"log/slog"
	"net/http"

	"github.com/vincentmegia/vincentmegia/internal/service"
)

// ResumeHandler renders GET /resume. See docs/features/resume.md.
type ResumeHandler struct {
	Renderer *Renderer
	Service  *service.ResumeService
	// Version is injected the same way as PagesHandler.Version (see its
	// doc comment) — the footer version is shared shell state, not
	// resume-specific, but this handler doesn't go through PagesHandler.
	Version string
}

// NewResumeHandler constructs a ResumeHandler.
func NewResumeHandler(renderer *Renderer, resumeService *service.ResumeService, version string) *ResumeHandler {
	return &ResumeHandler{Renderer: renderer, Service: resumeService, Version: version}
}

// Index handles GET /resume.
func (h *ResumeHandler) Index(w http.ResponseWriter, r *http.Request) {
	view, err := h.Service.Get(r.Context())
	if err != nil {
		// Never expose the raw error to the client, per
		// docs/skills/go-backend/SKILL.md "Errors" and
		// docs/features/resume.md's Error state — a DB fetch or JSONB
		// decode failure renders the shell's generic content-error state,
		// not a stack trace or raw error string.
		slog.Error("get resume view", "error", err)
		data := shellPageData(r, h.Version, "Resume", false)
		data.ContentTitle = "Resume"
		data.ContentMessage = "Couldn't load this page. Please try again shortly."
		h.Renderer.Render(w, r, data)
		return
	}

	data := shellPageData(r, h.Version, "Resume", false)
	data.ContentTemplate = "resume-content"
	data.Resume = &view
	h.Renderer.Render(w, r, data)
}
