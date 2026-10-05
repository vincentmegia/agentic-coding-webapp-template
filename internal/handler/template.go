package handler

import (
	"bytes"
	"html/template"
	"log/slog"
	"net/http"
	"path/filepath"

	"github.com/vincentmegia/vincentmegia/internal/model"
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

	// PrimaryNav is the flat Home/Projects/About link row header.html and
	// mobile-nav-panel.html render (see nav.go's primaryNavItems doc
	// comment for why this replaced the earlier Home dropdown). Every
	// route gets the same value — set once in shellPageData, not per
	// handler.
	PrimaryNav []NavItem
	// NavActive is the Href of whichever PrimaryNav entry is the current
	// page (e.g. "/projects"), so header.html/mobile-nav-panel.html can
	// render aria-current="page" on the matching link via a plain string
	// equality check against each item's own .Href — no template-side
	// lowercasing/slug logic needed. Empty for routes with no matching
	// entry (e.g. /resume, /settings/*) — nothing gets marked current
	// rather than guessing.
	NavActive string

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

	// HeroEyebrow is the landing page's small uppercase line above the
	// headline (e.g. "Software Engineer"), set only by PagesHandler.Home.
	// Postgres-backed (landing_hero), editable via /settings/content — see
	// docs/features/landing-content-authoring.md.
	HeroEyebrow string

	// CarouselSlides backs the landing-page image carousel
	// (components/carousel.html), set only by PagesHandler.Home. Up to 5
	// entries, Postgres-backed (landing_carousel_slides) and editable via
	// /settings/content — see docs/features/landing-content-authoring.md.
	// Nil/empty for every other route.
	CarouselSlides []model.CarouselSlide

	// SelectedWork backs the landing page's "Selected work" section
	// (components/selected-work.html), set only by PagesHandler.Home.
	// Postgres-backed (landing_selected_work_items) and editable via
	// /settings/content, same as CarouselSlides — see
	// docs/features/landing-content-authoring.md. Nil/empty for every
	// other route.
	SelectedWork []model.SelectedWorkItem

	// Projects backs the /projects page (pages/projects.html), set only by
	// PagesHandler.Projects. Hand-authored Go data, kept separate from
	// SelectedWork for now (docs/features/landing-content-authoring.md's
	// Open Questions) — no DB, no admin editing yet. Nil/empty for every
	// other route.
	Projects []Project

	// ContentHero/ContentCarousel/ContentWork back
	// web/templates/pages/settings-content.html
	// (GET /settings/content) and its three editor components. Set only
	// by LandingContentHandler.Index. Zero-value for every other route.
	ContentHero     service.HeroFormView
	ContentCarousel service.CarouselEditorView
	ContentWork     service.WorkEditorView

	// ResumeAdmin backs web/templates/pages/settings-resume.html
	// (GET /settings/resume) and its six card-editor components. Set only
	// by ResumeAdminHandler.Index. Zero-value for every other route. See
	// docs/features/resume-content-authoring.md.
	ResumeAdmin service.ResumeAdminView
}

// Project is one card in the /projects grid. Card markup/styling (image
// area, tag pills, "Live demo"/"Play now" link) was pulled from a
// claude.ai/design "Personal website and portfolio" project's
// Projects.dc.html (see DesignSync), but that mockup's four fictional
// sample entries (Fieldnotes/Tidewatch/Loom UI/Nightlight) were removed
// once implemented — see Open Questions in docs/features/projects.md — so
// the Fishing Game (docs/features/fishing-game.md) is currently the only
// real entry. ImagePath/LiveURL are optional ("" if none) — the card
// renders a placeholder tile in place of a screenshot, and omits the link,
// exactly like the mockup's own unfilled image-slot and "#" hrefs. TagTint
// selects which token-tinted pill style the card's tag chips use ("primary"
// or "accent") — authored per card rather than template-computed.
//
// External mirrors CarouselSlide's own field below (same pattern, same
// name): LiveURL either points at an internal route (External: false, the
// default) — rendered as a same-tab "Play now" link using the same HTMX
// swap every other in-site nav link uses — or an off-site URL
// (External: true) — rendered as a new-tab "Live demo" link. See
// docs/features/projects.md's Visual Direction and Business Rules
// sections for the full contract.
type Project struct {
	Title       string
	Description string
	Tags        []string
	TagTint     string // "primary" or "accent"
	LiveURL     string // optional, "" if none
	External    bool   // true if LiveURL is off-site; false means an internal route
	ImagePath   string // optional, "" renders a placeholder tile
}

// model.SelectedWorkItem (Postgres-backed, docs/features/
// landing-content-authoring.md) is what components/selected-work.html
// renders from — its Kicker/Title/Description/LiveURL/External fields
// mirror Project's own fields above (same names, same internal-route/
// off-site-URL meaning for LiveURL/External).
//
// model.CarouselSlide (also Postgres-backed) is what components/
// carousel.html renders from. Its ImagePath/Alt/Caption/LinkURL/External
// shape is a fixed contract shared with web/static/js/carousel.js (see
// docs/features/landing-carousel.md's "Implementation Contract (DOM /
// Data)") — do not rename or restructure those fields without updating
// that doc.

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
		filepath.Join(templatesDir, "components", "selected-work.html"),
		filepath.Join(templatesDir, "pages", "landing.html"),
		filepath.Join(templatesDir, "pages", "projects.html"),
		filepath.Join(templatesDir, "components", "content-hero-form.html"),
		filepath.Join(templatesDir, "components", "content-carousel-editor.html"),
		filepath.Join(templatesDir, "components", "content-work-editor.html"),
		filepath.Join(templatesDir, "pages", "settings-content.html"),
		filepath.Join(templatesDir, "components", "resume-admin-font-select.html"),
		filepath.Join(templatesDir, "components", "resume-admin-banner-form.html"),
		filepath.Join(templatesDir, "components", "resume-admin-expertise-form.html"),
		filepath.Join(templatesDir, "components", "resume-admin-education-form.html"),
		filepath.Join(templatesDir, "components", "resume-admin-featured-form.html"),
		filepath.Join(templatesDir, "components", "resume-admin-summary-form.html"),
		filepath.Join(templatesDir, "components", "resume-admin-role-editor.html"),
		filepath.Join(templatesDir, "pages", "settings-resume.html"),
		filepath.Join(templatesDir, "components", "fishing-leaderboard.html"),
		filepath.Join(templatesDir, "components", "fishing-shop.html"),
		filepath.Join(templatesDir, "pages", "fishing-game.html"),
		filepath.Join(templatesDir, "components", "cooking-leaderboard.html"),
		filepath.Join(templatesDir, "components", "cooking-shop.html"),
		filepath.Join(templatesDir, "pages", "cooking-game.html"),
		// No leaderboard/shop component templates for this one — Puzzle
		// Solver has no server-side state at all (docs/features/
		// puzzle-solver.md's Data Model: "None"), so it's just the one
		// page file, unlike the two games above it.
		filepath.Join(templatesDir, "pages", "puzzle-solver.html"),
		filepath.Join(templatesDir, "components", "library-leaderboard.html"),
		filepath.Join(templatesDir, "pages", "library-game.html"),
		filepath.Join(templatesDir, "components", "bus-rush-leaderboard.html"),
		filepath.Join(templatesDir, "components", "bus-rush-shop.html"),
		filepath.Join(templatesDir, "pages", "bus-rush.html"),
	}
	return template.New(filepath.Base(files[0])).Funcs(templateFuncs).ParseFiles(files...)
}

// templateFuncs are helper functions available to every parsed template.
// "add" is LoadTemplates' original need (see its doc comment). "derefString"
// is settings-resume.html's resume-admin-role-editor component's: printing
// a *string with {{.}} directly would fall through to fmt's default %v
// pointer formatting (a hex address, not the pointed-to text) rather than
// dereferencing — text/template only auto-dereferences pointers to
// struct/array/slice/map, not to basic kinds like string. model.Subproject's
// ClientTag (nil means "no client-engagement tag") is the one field in this
// codebase with that shape, so this exists specifically for it rather than
// as a general utility.
var templateFuncs = template.FuncMap{
	"add": func(a, b int) int { return a + b },
	"derefString": func(s *string) string {
		if s == nil {
			return ""
		}
		return *s
	},
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

// RenderFragment executes a single named component template directly to
// the response, with no full-page/HX-Request branching — for component-level
// HTMX endpoints (e.g. FishingGameHandler.Leaderboard/SubmitScore) that
// always return just a fragment, never wrapped in "base", regardless of
// whether the request carries HX-Request. This differs from Render, which
// exists for page-level nav routes where a direct (non-HTMX) request must
// still get the full document shell. data is whatever the named template's
// dot context expects — not necessarily a PageData.
func (ren *Renderer) RenderFragment(w http.ResponseWriter, name string, data any) {
	ren.execute(w, name, data)
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

// execute writes a named template's output directly to the response. data
// is `any`, not PageData, so RenderFragment can share this with Render —
// html/template.ExecuteTemplate itself takes an arbitrary dot value.
func (ren *Renderer) execute(w http.ResponseWriter, name string, data any) {
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
