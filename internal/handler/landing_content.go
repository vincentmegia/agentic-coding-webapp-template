package handler

import (
	"log/slog"
	"net/http"
	"strconv"

	"github.com/vincentmegia/vincentmegia/internal/service"
)

// LandingContentHandler serves /settings/content and its section
// endpoints. See docs/features/landing-content-authoring.md.
type LandingContentHandler struct {
	Renderer *Renderer
	Service  *service.LandingContentService
	// Version is injected the same way as PagesHandler.Version/
	// ResumeHandler.Version (see their doc comments).
	Version string
}

// NewLandingContentHandler constructs a LandingContentHandler.
func NewLandingContentHandler(renderer *Renderer, landingContentService *service.LandingContentService, version string) *LandingContentHandler {
	return &LandingContentHandler{Renderer: renderer, Service: landingContentService, Version: version}
}

// Index handles GET /settings/content. Requires an authenticated
// site-owner session — same requireOwnerAuth contract as PagesHandler's
// Profile/Security (docs/features/home.md's Security Considerations).
func (h *LandingContentHandler) Index(w http.ResponseWriter, r *http.Request) {
	if !requireOwnerAuth(w, r) {
		return
	}

	view, err := h.Service.Get(r.Context())
	if err != nil {
		// Never expose the raw error to the client, per
		// docs/skills/go-backend/SKILL.md "Errors".
		slog.Error("get landing content editor view", "error", err)
		data := shellPageData(r, h.Version, "Content", false)
		data.ContentTitle = "Content"
		data.ContentMessage = "Couldn't load this page. Please try again shortly."
		h.Renderer.Render(w, r, data)
		return
	}

	data := shellPageData(r, h.Version, "Content", false)
	data.ContentTemplate = "settings-content"
	data.ContentHero = view.Hero
	data.ContentCarousel = view.Carousel
	data.ContentWork = view.Work
	h.Renderer.Render(w, r, data)
}

// SaveHero handles POST /settings/content/hero, returning the refreshed
// content-hero-form fragment (outerHTML target).
func (h *LandingContentHandler) SaveHero(w http.ResponseWriter, r *http.Request) {
	if !requireOwnerAuth(w, r) {
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "Couldn't read that submission.", http.StatusBadRequest)
		return
	}

	view, err := h.Service.SaveHeroForm(r.Context(), r.FormValue("eyebrow"), r.FormValue("title"), r.FormValue("message"))
	if err != nil {
		slog.Error("save hero", "error", err)
		h.Renderer.RenderFragment(w, "content-hero-form", service.HeroFormView{
			Eyebrow: r.FormValue("eyebrow"), Title: r.FormValue("title"), Message: r.FormValue("message"),
			Error: "Couldn't save that just now. Please try again shortly.",
		})
		return
	}
	h.Renderer.RenderFragment(w, "content-hero-form", view)
}

// CreateSlide handles POST /settings/content/carousel, returning the
// refreshed content-carousel-editor fragment (outerHTML target).
func (h *LandingContentHandler) CreateSlide(w http.ResponseWriter, r *http.Request) {
	if !requireOwnerAuth(w, r) {
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "Couldn't read that submission.", http.StatusBadRequest)
		return
	}

	view, err := h.Service.CreateSlideForm(r.Context(), r.FormValue("image_path"), r.FormValue("alt"), r.FormValue("caption"), r.FormValue("link_url"), r.FormValue("external") == "on")
	if err != nil {
		slog.Error("create carousel slide", "error", err)
		h.writeCarouselError(w)
		return
	}
	h.Renderer.RenderFragment(w, "content-carousel-editor", view)
}

// UpdateSlide handles PUT /settings/content/carousel/{id}, returning the
// refreshed content-carousel-editor fragment.
func (h *LandingContentHandler) UpdateSlide(w http.ResponseWriter, r *http.Request) {
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

	view, err := h.Service.UpdateSlideForm(r.Context(), id, r.FormValue("image_path"), r.FormValue("alt"), r.FormValue("caption"), r.FormValue("link_url"), r.FormValue("external") == "on")
	if err != nil {
		slog.Error("update carousel slide", "error", err, "id", id)
		h.writeCarouselError(w)
		return
	}
	h.Renderer.RenderFragment(w, "content-carousel-editor", view)
}

// DeleteSlide handles DELETE /settings/content/carousel/{id}, returning
// the refreshed content-carousel-editor fragment.
func (h *LandingContentHandler) DeleteSlide(w http.ResponseWriter, r *http.Request) {
	if !requireOwnerAuth(w, r) {
		return
	}
	id, ok := parsePathID(w, r)
	if !ok {
		return
	}

	view, err := h.Service.DeleteSlideForm(r.Context(), id)
	if err != nil {
		slog.Error("delete carousel slide", "error", err, "id", id)
		h.writeCarouselError(w)
		return
	}
	h.Renderer.RenderFragment(w, "content-carousel-editor", view)
}

// MoveSlide handles POST /settings/content/carousel/{id}/move, returning
// the refreshed content-carousel-editor fragment.
func (h *LandingContentHandler) MoveSlide(w http.ResponseWriter, r *http.Request) {
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

	view, err := h.Service.MoveSlideForm(r.Context(), id, r.FormValue("direction"))
	if err != nil {
		slog.Error("move carousel slide", "error", err, "id", id)
		h.writeCarouselError(w)
		return
	}
	h.Renderer.RenderFragment(w, "content-carousel-editor", view)
}

// CreateWorkItem handles POST /settings/content/selected-work, returning
// the refreshed content-work-editor fragment.
func (h *LandingContentHandler) CreateWorkItem(w http.ResponseWriter, r *http.Request) {
	if !requireOwnerAuth(w, r) {
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "Couldn't read that submission.", http.StatusBadRequest)
		return
	}

	view, err := h.Service.CreateWorkItemForm(r.Context(), r.FormValue("kicker"), r.FormValue("title"), r.FormValue("description"), r.FormValue("live_url"), r.FormValue("external") == "on")
	if err != nil {
		slog.Error("create selected work item", "error", err)
		h.writeWorkError(w)
		return
	}
	h.Renderer.RenderFragment(w, "content-work-editor", view)
}

// UpdateWorkItem handles PUT /settings/content/selected-work/{id},
// returning the refreshed content-work-editor fragment.
func (h *LandingContentHandler) UpdateWorkItem(w http.ResponseWriter, r *http.Request) {
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

	view, err := h.Service.UpdateWorkItemForm(r.Context(), id, r.FormValue("kicker"), r.FormValue("title"), r.FormValue("description"), r.FormValue("live_url"), r.FormValue("external") == "on")
	if err != nil {
		slog.Error("update selected work item", "error", err, "id", id)
		h.writeWorkError(w)
		return
	}
	h.Renderer.RenderFragment(w, "content-work-editor", view)
}

// DeleteWorkItem handles DELETE /settings/content/selected-work/{id},
// returning the refreshed content-work-editor fragment.
func (h *LandingContentHandler) DeleteWorkItem(w http.ResponseWriter, r *http.Request) {
	if !requireOwnerAuth(w, r) {
		return
	}
	id, ok := parsePathID(w, r)
	if !ok {
		return
	}

	view, err := h.Service.DeleteWorkItemForm(r.Context(), id)
	if err != nil {
		slog.Error("delete selected work item", "error", err, "id", id)
		h.writeWorkError(w)
		return
	}
	h.Renderer.RenderFragment(w, "content-work-editor", view)
}

// MoveWorkItem handles POST /settings/content/selected-work/{id}/move,
// returning the refreshed content-work-editor fragment.
func (h *LandingContentHandler) MoveWorkItem(w http.ResponseWriter, r *http.Request) {
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

	view, err := h.Service.MoveWorkItemForm(r.Context(), id, r.FormValue("direction"))
	if err != nil {
		slog.Error("move selected work item", "error", err, "id", id)
		h.writeWorkError(w)
		return
	}
	h.Renderer.RenderFragment(w, "content-work-editor", view)
}

// parsePathID reads the "id" path value shared by every /{id}[/move]
// route above, writing a 400 and returning ok=false on a malformed value.
func parsePathID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		http.Error(w, "Invalid ID.", http.StatusBadRequest)
		return 0, false
	}
	return id, true
}

// writeCarouselError renders the content-carousel-editor fragment with a
// generic error and no items, for the rare case a DB failure happens
// after the primary write (or on the write itself) — never exposes the
// raw error to the client, per docs/skills/go-backend/SKILL.md "Errors".
func (h *LandingContentHandler) writeCarouselError(w http.ResponseWriter) {
	h.Renderer.RenderFragment(w, "content-carousel-editor", service.CarouselEditorView{
		Error: "Couldn't save that just now. Please try again shortly.",
	})
}

// writeWorkError is writeCarouselError's Selected-work counterpart.
func (h *LandingContentHandler) writeWorkError(w http.ResponseWriter) {
	h.Renderer.RenderFragment(w, "content-work-editor", service.WorkEditorView{
		Error: "Couldn't save that just now. Please try again shortly.",
	})
}
