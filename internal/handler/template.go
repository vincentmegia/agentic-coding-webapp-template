package handler

import (
	"bytes"
	"html/template"
	"log/slog"
	"net/http"
	"path/filepath"
)

// PageData is the single view-model every page renders from. It carries
// both shell-level fields owned by docs/features/home.md (nav, auth,
// footer) and the current page's own content fields. See
// docs/skills/htmx-ui/SKILL.md "Component Boundaries": components take a
// well-defined view-model, not raw data, as their dot context.
type PageData struct {
	// Title is used in <title>; empty means just the site name (used by
	// the landing page).
	Title string

	// TransparentOverHero is passed through to components/header.html so
	// it can render the correct starting class. Only docs/features/
	// landing-page.md's page sets this true; the transparent visual
	// treatment itself is that feature's responsibility, not this one's.
	TransparentOverHero bool

	// IsAuthenticated gates the Settings nav entirely (see
	// internal/handler/auth_stub.go) — a TEMPORARY stub until the real
	// auth feature lands.
	IsAuthenticated bool

	// VersionLabel is the build version footer.html displays, sourced
	// from build metadata (cmd/server/main.go's Version var, formatted by
	// PagesHandler.page), not hand-edited here. See
	// docs/features/home.md's Business Rules.
	VersionLabel string

	// CopyrightYear is the year footer.html's copyright line displays.
	CopyrightYear int

	HomeMenu     NavMenu
	SettingsMenu NavMenu

	// ContentTitle/ContentMessage back the single generic placeholder
	// page (web/templates/pages/placeholder.html) every Wave 1 route
	// renders — Resume/Projects/Blogs/Profile/Security each have their
	// own not-yet-built feature that will replace this with real content.
	ContentTitle   string
	ContentMessage string
}

// LoadTemplates parses the shared shell (layouts/base.html), its
// components, and the single generic placeholder content page into one
// *template.Template, so "base" (full page) and "content" (HTMX fragment)
// can both be executed from the same parsed set without duplicating
// rendering logic. See docs/skills/htmx-ui/SKILL.md "Layout Architecture"
// and "Fragment vs Full-Page Rendering".
//
// Parse order matters: layouts/base.html defines "content" first (as an
// empty {{block}}), and pages/placeholder.html is parsed last so its real
// {{define "content"}} is the one that wins in the shared namespace.
func LoadTemplates(templatesDir string) (*template.Template, error) {
	files := []string{
		filepath.Join(templatesDir, "layouts", "base.html"),
		filepath.Join(templatesDir, "components", "header.html"),
		filepath.Join(templatesDir, "components", "nav-menu.html"),
		filepath.Join(templatesDir, "components", "mobile-nav-panel.html"),
		filepath.Join(templatesDir, "components", "footer.html"),
		filepath.Join(templatesDir, "pages", "placeholder.html"),
	}
	return template.ParseFiles(files...)
}

// Renderer renders PageData through the shared template set, branching on
// the HX-Request header per docs/skills/htmx-ui/SKILL.md "Fragment vs
// Full-Page Rendering": a full page for direct navigation/reload, or just
// the content fragment for an HTMX nav swap. Every handler in
// internal/handler/pages.go shares this one code path instead of
// duplicating rendering logic per route.
type Renderer struct {
	tmpl *template.Template
}

// NewRenderer wraps an already-parsed template set (see LoadTemplates).
func NewRenderer(tmpl *template.Template) *Renderer {
	return &Renderer{tmpl: tmpl}
}

// Render writes data through "content" (HTMX fragment) or "base" (full
// page), depending on the HX-Request header. It executes into a buffer
// first, so a template execution failure produces a clean error response
// instead of a partially written page followed by a superfluous
// WriteHeader call.
func (ren *Renderer) Render(w http.ResponseWriter, r *http.Request, data PageData) {
	name := "base"
	if r.Header.Get("HX-Request") == "true" {
		name = "content"
	}

	var buf bytes.Buffer
	if err := ren.tmpl.ExecuteTemplate(&buf, name, data); err != nil {
		// Never expose the raw error to the client, per
		// docs/skills/go-backend/SKILL.md "Errors" and
		// docs/skills/htmx-ui/SKILL.md "Error States".
		slog.Error("render template", "error", err, "template", name)
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write(buf.Bytes())
}
