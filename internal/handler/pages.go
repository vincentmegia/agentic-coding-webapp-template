package handler

import (
	"net/http"
	"time"
)

// PagesHandler renders the shared shell (docs/features/home.md) for every
// route that doesn't yet have real content of its own. Resume/Projects/
// Blogs/Profile/Security content are each a separate, not-yet-built
// feature; this handler only wires up the shell, placeholder content, and
// the routing/auth contract those features will build on.
type PagesHandler struct {
	Renderer *Renderer
	// Version is injected from cmd/server/main.go's build-time Version
	// var (see docs/features/home.md's Business Rules: the footer version
	// is build metadata, not hand-maintained in a template).
	Version string
}

// NewPagesHandler constructs a PagesHandler.
func NewPagesHandler(renderer *Renderer, version string) *PagesHandler {
	return &PagesHandler{Renderer: renderer, Version: version}
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
func (h *PagesHandler) Home(w http.ResponseWriter, r *http.Request) {
	data := shellPageData(r, h.Version, "", true)
	data.NavActive = "/"
	data.ContentTemplate = "landing-content"
	data.ContentTitle = "Hi, I'm Vincent Megia."
	data.ContentMessage = "I build things with Go, Postgres, and HTMX — practical software with sound engineering behind it. Below is a running log of what I've shipped, plus a full résumé if you want the formal version."
	data.CarouselSlides = landingCarouselSlides
	data.SelectedWork = selectedWorkItems
	h.Renderer.Render(w, r, data)
}

// selectedWorkItems is the hand-authored card list for the landing page's
// "Selected work" section (docs/features/landing-page.md). Fishing Game is
// the only entry, same as /projects' own projectItems (docs/features/
// projects.md) — this teaser and the page its "See all projects" link
// leads to always show the same real work, never a different set (see
// SelectedWorkItem's doc comment for why the design mockup's three
// fictional sample entries were removed).
var selectedWorkItems = []SelectedWorkItem{
	{
		Kicker:      "Game",
		Title:       "Fishing Game",
		Description: "A canvas arcade mini-game — cast a line, dive for fish, and dodge hazards on the way down, with a public leaderboard for the best runs.",
		LiveURL:     "/fishing-game",
	},
}

// landingCarouselSlides is the hand-authored slide list for the landing-page
// carousel (docs/features/landing-carousel.md's Data Model: "static,
// hand-authored in Go — no DB, no admin editing yet"). Up to 5 entries;
// placeholder images/copy until real photography/links are chosen.
var landingCarouselSlides = []CarouselSlide{
	{
		ImagePath: "/static/images/carousel/1.svg",
		Alt:       "Illustration of a keyboard",
		Caption:   "Engineering, hands-on — placeholder caption",
	},
	{
		ImagePath: "/static/images/carousel/2.svg",
		Alt:       "Illustration of a client/server/database system architecture diagram",
		Caption:   "System design & architecture — placeholder caption",
		LinkURL:   "/projects",
	},
	{
		ImagePath: "/static/images/carousel/3.svg",
		Alt:       "Illustration of a desktop computer workstation",
		Caption:   "Where the work happens — placeholder caption",
	},
	{
		ImagePath: "/static/images/carousel/4.svg",
		Alt:       "Illustration of a server rack",
		Caption:   "Infrastructure & backend systems — placeholder caption",
		LinkURL:   "https://github.com/vincentmegia",
		External:  true,
	},
	{
		ImagePath: "/static/images/carousel/5.svg",
		Alt:       "Illustration of a code editor window",
		Caption:   "Code — placeholder caption",
	},
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
// projects.md). Fishing Game is the only entry — this site's own shipped
// mini-game (docs/features/fishing-game.md) — after the pulled-in design's
// four fictional sample entries (Fieldnotes/Tidewatch/Loom UI/Nightlight,
// from Projects.dc.html) were removed rather than left sitting next to the
// one genuine project; see Open Questions in projects.md for that call.
var projectItems = []Project{
	{
		Title:       "Fishing Game",
		Description: "A canvas arcade mini-game — cast a line, dive for fish, and dodge hazards on the way down, with a public leaderboard for the best runs.",
		Tags:        []string{"Go", "Canvas", "PostgreSQL"},
		TagTint:     "accent",
		LiveURL:     "/fishing-game",
		ImagePath:   "/static/images/fishing/screenshot.png",
	},
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
