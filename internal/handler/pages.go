package handler

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/vincentmegia/vincentmegia/internal/service"
)

// PagesHandler renders the shared shell (docs/features/home.md) for every
// route that doesn't yet have real content of its own. Resume/Projects/
// Blogs/Profile/Security content are each a separate, not-yet-built
// feature; this handler only wires up the shell, placeholder content, and
// the routing/auth contract those features will build on.
type PagesHandler struct {
	Renderer *Renderer
	// LandingContent backs Home's hero/carousel/Selected work content —
	// see docs/features/landing-content-authoring.md.
	LandingContent *service.LandingContentService
	// Version is injected from cmd/server/main.go's build-time Version
	// var (see docs/features/home.md's Business Rules: the footer version
	// is build metadata, not hand-maintained in a template).
	Version string
}

// NewPagesHandler constructs a PagesHandler.
func NewPagesHandler(renderer *Renderer, landingContent *service.LandingContentService, version string) *PagesHandler {
	return &PagesHandler{Renderer: renderer, LandingContent: landingContent, Version: version}
}

// page builds the PageData shared by every route: shell fields
// (auth/version/nav/copyright) plus this route's own content.
func (h *PagesHandler) page(r *http.Request, title string, transparentOverHero bool, contentTitle, contentMessage string) PageData {
	data := shellPageData(r, h.Version, title, transparentOverHero)
	data.ContentTitle = contentTitle
	data.ContentMessage = contentMessage
	return data
}

// shellPageData builds the PageData fields owned by the shared shell
// (docs/features/home.md) — auth, theme, footer version, nav — common to
// every route regardless of which handler serves it. Callers with their
// own real content (e.g. ResumeHandler) fill in the rest (ContentTemplate,
// Resume, ...) themselves rather than going through PagesHandler.page,
// which is specific to the generic placeholder content fields.
func shellPageData(r *http.Request, version, title string, transparentOverHero bool) PageData {
	return PageData{
		Title:               title,
		TransparentOverHero: transparentOverHero,
		IsAuthenticated:     IsAuthenticated(r),
		Theme:               themeFromRequest(r),
		VersionLabel:        versionLabel(version),
		CopyrightYear:       time.Now().Year(),
		PrimaryNav:          primaryNavItems,
		SettingsMenu:        settingsMenu,
	}
}

// versionLabel formats the footer's version string: "dev" as-is (a local
// build with no -ldflags override), otherwise "v"-prefixed.
func versionLabel(version string) string {
	if version == "" || version == "dev" {
		return "dev"
	}
	return "v" + version
}

// Home renders GET /. TransparentOverHero is true here per
// docs/features/home.md — the transparent-over-hero visual behavior itself
// belongs to docs/features/landing-page.md and is intentionally not
// implemented yet; this only passes the flag through correctly.
//
// Sets ContentTemplate to "landing-content" (web/templates/pages/landing.html)
// instead of going through h.page's shared placeholder — the landing page is
// the first route with real content below its still-placeholder hero: the
// image carousel from docs/features/landing-carousel.md. See
// docs/features/resume.md's Template Rendering section for why this dispatch
// happens via ContentTemplate rather than landing.html redefining "content"
// (which would silently take over every other placeholder-backed route).
//
// Hero copy/carousel slides/Selected work cards are Postgres-backed and
// editable via /settings/content (docs/features/landing-content-authoring.md)
// — a fetch failure here renders the shell's generic content-error state,
// same as ResumeHandler.Index, never a raw error or a blank hero.
func (h *PagesHandler) Home(w http.ResponseWriter, r *http.Request) {
	view, err := h.LandingContent.GetPublicView(r.Context())
	if err != nil {
		slog.Error("get landing public view", "error", err)
		data := shellPageData(r, h.Version, "", true)
		data.NavActive = "/"
		data.ContentTitle = "Vincent Megia"
		data.ContentMessage = "Couldn't load this page. Please try again shortly."
		h.Renderer.Render(w, r, data)
		return
	}

	data := shellPageData(r, h.Version, "", true)
	data.NavActive = "/"
	data.ContentTemplate = "landing-content"
	data.HeroEyebrow = view.Eyebrow
	data.ContentTitle = view.Title
	data.ContentMessage = view.Message
	data.CarouselSlides = view.CarouselSlides
	data.SelectedWork = view.SelectedWork
	h.Renderer.Render(w, r, data)
}

// Projects renders GET /projects. See docs/features/projects.md.
func (h *PagesHandler) Projects(w http.ResponseWriter, r *http.Request) {
	data := shellPageData(r, h.Version, "Projects", false)
	data.NavActive = "/projects"
	data.ContentTemplate = "projects-content"
	data.Projects = projectItems
	h.Renderer.Render(w, r, data)
}

// projectItems is the hand-authored card list for /projects (docs/features/
// projects.md). Fishing Game and Kitchen Shift are this site's own shipped
// mini-games (docs/features/fishing-game.md, docs/features/cooking-game.md)
// — the pulled-in design's four fictional sample entries (Fieldnotes/
// Tidewatch/Loom UI/Nightlight, from Projects.dc.html) were removed rather
// than left sitting next to genuine projects; see Open Questions in
// projects.md for that call. Puzzle Solver (docs/features/puzzle-solver.md)
// is the third real entry, added the same way once it shipped. Its
// screenshot (web/static/images/puzzle/screenshot.png) is a real Playwright
// capture too, same convention as the other two: Start/End placed, a
// hand-built maze (a fully enclosed dead-end pocket plus a couple of
// smaller obstacles) drawn, then solved — captured mid-result so the
// pocket's fully-explored "visited" cells, the maze walls, and the solved
// path threading out to End are all visible at once, clipped to the card's
// 16:10 aspect the same way the Fishing Game screenshot's own doc comment
// describes.
var projectItems = []Project{
	{
		Title:       "Fishing Game",
		Description: "A canvas arcade mini-game — cast a line, dive for fish, and dodge hazards on the way down, with a public leaderboard for the best runs.",
		Tags:        []string{"Go", "Canvas", "PostgreSQL"},
		TagTint:     "accent",
		LiveURL:     "/fishing-game",
		ImagePath:   "/static/images/fishing/screenshot.png",
	},
	{
		Title:       "Kitchen Shift",
		Description: "A top-down restaurant-shift sim — take orders, cook, and close up clean across a 30-shift month, with a public leaderboard for the best months.",
		Tags:        []string{"Go", "Canvas", "PostgreSQL"},
		TagTint:     "primary",
		LiveURL:     "/kitchen-shift",
		ImagePath:   "/static/images/cooking/screenshot.png",
	},
	{
		Title:       "Puzzle Solver",
		Description: "A 30×30 pathfinding visualizer — mark a start and end, draw walls, then watch a depth-first search explore the grid and trace the path it finds.",
		Tags:        []string{"Go", "Canvas", "JavaScript"},
		TagTint:     "accent",
		LiveURL:     "/puzzle-solver",
		ImagePath:   "/static/images/puzzle/screenshot.png",
	},
}

// PuzzleSolver renders GET /puzzle-solver. See docs/features/puzzle-solver.md.
// Unlike FishingGameHandler/CookingGameHandler, this feature has no
// service/repository layer at all — the DFS visualizer is entirely
// client-side, so it lives on PagesHandler like Projects/Blogs/About rather
// than getting its own handler struct (docs/features/puzzle-solver.md's
// Routes/Handlers table and Data Model: "None").
func (h *PagesHandler) PuzzleSolver(w http.ResponseWriter, r *http.Request) {
	data := shellPageData(r, h.Version, "Puzzle Solver", false)
	data.NavActive = "/puzzle-solver"
	data.ContentTemplate = "puzzle-solver-content"
	h.Renderer.Render(w, r, data)
}

// Blogs renders GET /blogs. Real content is a separate feature. Not linked
// from the primary nav (nav.go's primaryNavItems doc comment) — reachable
// directly at this URL only, so NavActive is left unset.
func (h *PagesHandler) Blogs(w http.ResponseWriter, r *http.Request) {
	h.Renderer.Render(w, r, h.page(r, "Blogs", false, "Blogs", "Blog posts coming soon."))
}

// About renders GET /about. Real content is a separate feature (CLAUDE.md's
// "Planned content": Bio/About) — linked from the primary nav per the
// pulled-in design's Home.dc.html, same not-yet-built-placeholder pattern
// as Projects/Blogs.
func (h *PagesHandler) About(w http.ResponseWriter, r *http.Request) {
	data := h.page(r, "About", false, "About", "About content coming soon.")
	data.NavActive = "/about"
	h.Renderer.Render(w, r, data)
}

// Profile renders GET /settings/profile. Per docs/features/home.md's
// Security Considerations, this route requires an authenticated
// site-owner session server-side regardless of what the nav renders
// (defense in depth); unauthenticated requests redirect to /login rather
// than rendering anything. /login doesn't exist yet (real auth is a
// separate feature) — a 404 there is expected until it does.
func (h *PagesHandler) Profile(w http.ResponseWriter, r *http.Request) {
	if !requireOwnerAuth(w, r) {
		return
	}
	h.Renderer.Render(w, r, h.page(r, "Profile", false, "Profile", "Profile settings coming soon."))
}

// Security renders GET /settings/security. See Profile's doc comment —
// same auth contract applies.
func (h *PagesHandler) Security(w http.ResponseWriter, r *http.Request) {
	if !requireOwnerAuth(w, r) {
		return
	}
	h.Renderer.Render(w, r, h.page(r, "Security", false, "Security", "Security settings coming soon."))
}

// Logout handles POST /logout.
//
// TEMPORARY: there is no real session to destroy yet — authentication is a
// separate, not-yet-built feature (docs/features/home.md's Scope). This
// just redirects to "/". The real implementation must still decide its
// exact response mechanism (an HX-Redirect header vs. a plain non-hx form
// POST causing a real browser navigation — left open by home.md's HTMX
// Interactions), and must be covered by CSRF protection once the app has a
// CSRF mechanism: none exists yet, since CSRF protection is normally tied
// to session infrastructure that is explicitly out of scope here. Do not
// consider this route CSRF-safe until the auth feature adds that.
func (h *PagesHandler) Logout(w http.ResponseWriter, r *http.Request) {
	http.Redirect(w, r, "/", http.StatusFound)
}

// requireOwnerAuth enforces docs/features/home.md's Security
// Considerations for /settings/*: unauthenticated requests redirect to
// /login rather than rendering anything or 404ing. It returns true when
// the caller may proceed.
func requireOwnerAuth(w http.ResponseWriter, r *http.Request) bool {
	if IsAuthenticated(r) {
		return true
	}
	http.Redirect(w, r, "/login", http.StatusFound)
	return false
}
