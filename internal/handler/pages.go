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
		HomeMenu:            homeMenu,
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
func (h *PagesHandler) Home(w http.ResponseWriter, r *http.Request) {
	h.Renderer.Render(w, r, h.page(r, "", true, "Welcome", "Landing page content coming soon."))
}

// Projects renders GET /projects. Real content is a separate feature.
func (h *PagesHandler) Projects(w http.ResponseWriter, r *http.Request) {
	h.Renderer.Render(w, r, h.page(r, "Projects", false, "Projects", "Projects content coming soon."))
}

// Blogs renders GET /blogs. Real content is a separate feature.
func (h *PagesHandler) Blogs(w http.ResponseWriter, r *http.Request) {
	h.Renderer.Render(w, r, h.page(r, "Blogs", false, "Blogs", "Blog posts coming soon."))
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
