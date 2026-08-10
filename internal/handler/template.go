package handler

import (
	"bytes"
	"html/template"
	"log/slog"
	"net/http"
	"path/filepath"

	"github.com/vincentmegia/vincentmegia/internal/service"
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

	// Theme is the validated theme cookie value ("light", "dark", or ""
	// when unset/invalid — see themeFromRequest), read server-side so
	// base.html can render the correct dark/light class in the initial
	// HTML with no flash. Empty means no explicit choice has been made
	// yet; base.html renders no class and CSS falls back to
	// prefers-color-scheme. See docs/features/dark-mode.md.
	Theme string

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

	// ContentTemplate names the content template Renderer.Render should
	// execute. Empty means "content" — the shared placeholder — so every
	// existing PagesHandler route needs no changes. A route with its own
	// real content (e.g. ResumeHandler) sets this to its own template
	// name (e.g. "resume-content") so it doesn't collide with the shared
	// placeholder definition. See docs/features/resume.md's Template
	// Rendering section.
	ContentTemplate string

	// RenderedContent holds the content fragment's already-executed HTML,
	// set by Renderer.Render's full-page path before it executes "base".
	// This exists because html/template's {{template}} action requires a
	// fixed string name — it cannot dispatch on a dynamic field like
	// ContentTemplate from within base.html itself. So the dispatch
	// happens in Go code instead: Render executes ContentTemplate (or its
	// "content" default) into a buffer first, stores the result here, and
	// base.html just outputs {{.RenderedContent}} directly. Callers never
	// set this themselves — Render overwrites it unconditionally on the
	// full-page path.
	RenderedContent template.HTML

	// Resume is nil for every route except ResumeHandler.Index, which is
	// the only page that needs it. A dedicated field (rather than a
	// generic any) keeps resume.html's templates type-checked at parse
	// time against a well-defined view-model, per htmx-ui's Component
	// Boundaries.
	Resume *service.ResumeView

	// CarouselSlides backs the landing-page image carousel
	// (components/carousel.html), set only by PagesHandler.Home. Up to 5
	// entries, hand-authored in Go — no DB, no admin editing yet, per
	// docs/features/landing-carousel.md's Data Model. Nil/empty for every
	// other route.
	CarouselSlides []CarouselSlide
}

// CarouselSlide is one slide of the landing-page carousel. This shape is a
// fixed contract shared with web/static/js/carousel.js (see
// docs/features/landing-carousel.md's "Implementation Contract (DOM /
// Data)"), written independently against the same spec — do not rename or
// restructure these fields without updating that doc.
type CarouselSlide struct {
	ImagePath string // e.g. "/static/images/carousel/1.jpg"
	Alt       string // required
	Caption   string // optional, "" if none
	LinkURL   string // optional, "" if none
	External  bool   // true if LinkURL is off-site; drives target/rel
}

// LoadTemplates parses the shared shell (layouts/base.html), its
// components, and every page's content template into one *template.Template,
// so "base" (full page) and each content template (HTMX fragment) can all be
// executed from the same parsed set without duplicating rendering logic.
// See docs/skills/htmx-ui/SKILL.md "Layout Architecture" and "Fragment vs
// Full-Page Rendering".
//
// base.html no longer declares "content" itself (see Renderer.Render /
// PageData.RenderedContent for why) — pages/placeholder.html is the sole
// definition of "content". resume.html defines a differently-named
// "resume-content" instead (see docs/features/resume.md's Template
// Rendering section), so it doesn't collide with "content" — every route
// not setting PageData.ContentTemplate is unaffected by resume.html's
// presence in this list.
//
// This list is explicit, not a directory glob: a new page/component file
// must be added here, or it fails fast at startup as a template
// parse/lookup error rather than silently missing at render time.
//
// carousel.html/landing.html (docs/features/landing-carousel.md) are the
// first templates needing a custom function: text/template has no
// arithmetic built in, and carousel.html needs each slide's 1-based
// position (data-index, "{n} of {total}") from a zero-based {{range}}
// index. "add" is registered via templateFuncs below rather than adding an
// Index field to the CarouselSlide contract struct, which stays exactly
// the shape docs/features/landing-carousel.md's Implementation Contract
// specifies.
func LoadTemplates(templatesDir string) (*template.Template, error) {
	files := []string{
		filepath.Join(templatesDir, "layouts", "base.html"),
		filepath.Join(templatesDir, "components", "header.html"),
		filepath.Join(templatesDir, "components", "nav-menu.html"),
		filepath.Join(templatesDir, "components", "mobile-nav-panel.html"),
		// Parsed after header.html/mobile-nav-panel.html so its real
		// {{define "theme-toggle"}} overrides their empty {{block}}
		// defaults, same "parsed last wins" pattern as placeholder.html
		// below for "content".
		filepath.Join(templatesDir, "components", "nav-theme-toggle.html"),
		filepath.Join(templatesDir, "components", "footer.html"),
		filepath.Join(templatesDir, "pages", "placeholder.html"),
		filepath.Join(templatesDir, "components", "resume-banner.html"),
		filepath.Join(templatesDir, "components", "resume-sidebar.html"),
		filepath.Join(templatesDir, "components", "resume-summary.html"),
		filepath.Join(templatesDir, "components", "resume-timeline.html"),
		filepath.Join(templatesDir, "components", "resume-role.html"),
		filepath.Join(templatesDir, "pages", "resume.html"),
		filepath.Join(templatesDir, "components", "carousel.html"),
		filepath.Join(templatesDir, "pages", "landing.html"),
	}
	return template.New(filepath.Base(files[0])).Funcs(templateFuncs).ParseFiles(files...)
}

// templateFuncs are helper functions available to every parsed template.
// "add" is the only one so far — see LoadTemplates' doc comment.
var templateFuncs = template.FuncMap{
	"add": func(a, b int) int { return a + b },
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

// Render writes data through data.ContentTemplate (HTMX fragment, default
// "content" — see PageData) or "base" (full page, with the content
// fragment pre-rendered into PageData.RenderedContent first — see its doc
// comment for why), depending on the HX-Request header. Every execution
// happens into a buffer first, so a template failure produces a clean
// error response instead of a partially written page followed by a
// superfluous WriteHeader call.
func (ren *Renderer) Render(w http.ResponseWriter, r *http.Request, data PageData) {
	contentName := data.ContentTemplate
	if contentName == "" {
		contentName = "content"
	}

	if r.Header.Get("HX-Request") == "true" {
		ren.execute(w, contentName, data)
		return
	}

	contentHTML, err := ren.renderToString(contentName, data)
	if err != nil {
		ren.renderError(w, contentName, err)
		return
	}
	data.RenderedContent = template.HTML(contentHTML)

	ren.execute(w, "base", data)
}

// renderToString executes a named template into a string, for the
// pre-render step Render's full-page path needs (see
// PageData.RenderedContent).
func (ren *Renderer) renderToString(name string, data PageData) (string, error) {
	var buf bytes.Buffer
	if err := ren.tmpl.ExecuteTemplate(&buf, name, data); err != nil {
		return "", err
	}
	return buf.String(), nil
}

// execute writes a named template's output directly to the response.
func (ren *Renderer) execute(w http.ResponseWriter, name string, data PageData) {
	var buf bytes.Buffer
	if err := ren.tmpl.ExecuteTemplate(&buf, name, data); err != nil {
		ren.renderError(w, name, err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write(buf.Bytes())
}

// renderError logs the real error and returns a generic response — never
// expose the raw error to the client, per
// docs/skills/go-backend/SKILL.md "Errors" and
// docs/skills/htmx-ui/SKILL.md "Error States".
func (ren *Renderer) renderError(w http.ResponseWriter, name string, err error) {
	slog.Error("render template", "error", err, "template", name)
	http.Error(w, "internal server error", http.StatusInternalServerError)
}
