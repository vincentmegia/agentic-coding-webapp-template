package handler

import "html/template"

// NavItem is one entry in a nav-menu dropdown (components/nav-menu.html)
// or the mobile nav panel (components/mobile-nav-panel.html).
//
// Icon is trusted, hardcoded inline SVG markup built by icon() below —
// never user- or database-sourced, so rendering it unescaped via
// template.HTML is safe. See docs/features/home.md's Data Model note: this
// content is hardcoded/static for now, but anything database-driven in the
// future must go through html/template's normal auto-escaping instead.
type NavItem struct {
	Label string
	Href  string
	Icon  template.HTML
	// Method is "" (GET, the default — rendered as a plain hx-get anchor)
	// or "POST" (Logout — rendered as a form, per
	// docs/features/home.md's HTTP semantics: destructive/session-ending
	// actions must never be a GET).
	Method string
}

// NavMenu is the view-model for components/nav-menu.html: one dropdown —
// a trigger (icon + label) and its list of items. Used twice (Home,
// Settings) per docs/features/home.md.
type NavMenu struct {
	ID          string
	Label       string
	TriggerIcon template.HTML
	// Align controls which edge the dropdown list opens from: "left"
	// (default, used by Home) or "right" (used by Settings, since it sits
	// at the header's right edge).
	Align string
	Items []NavItem
}

// icon renders a small stroke-based inline SVG icon. sizeClass and inner
// are always Go source constants defined in this file, never user or
// database input, so building template.HTML by string concatenation here
// is safe (see the NavItem.Icon doc comment above).
func icon(sizeClass, inner string) template.HTML {
	return template.HTML(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ` +
			`stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ` +
			`class="` + sizeClass + ` shrink-0" aria-hidden="true">` + inner + `</svg>`,
	)
}

// homeMenu and settingsMenu are the Home/Settings dropdown view-models
// from docs/features/home.md's User Flow and HTMX Interactions. They're
// static/hardcoded (not database-driven), so they're built once as package
// vars rather than reconstructed on every request.
var homeMenu = NavMenu{
	ID:          "home-menu",
	Label:       "Home",
	Align:       "left",
	TriggerIcon: icon("h-4 w-4", `<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h5v-6h4v6h5V9.5"/>`),
	Items: []NavItem{
		{
			Label: "Resume",
			Href:  "/resume",
			Icon:  icon("h-4 w-4", `<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/>`),
		},
		{
			Label: "Projects",
			Href:  "/projects",
			Icon:  icon("h-4 w-4", `<path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>`),
		},
		{
			Label: "Blogs",
			Href:  "/blogs",
			Icon:  icon("h-4 w-4", `<path d="M4 20h4L18.5 9.5a2.121 2.121 0 0 0-3-3L5 17v3z"/>`),
		},
		{
			Label: "Fishing Game",
			Href:  "/fishing-game",
			Icon:  icon("h-4 w-4", `<path d="M21 12c-2-3-6-5-10-5S3 9 3 12s4 5 8 5 8-2 10-5z"/><path d="M21 12l3-4v8z"/><path d="M7 10.5v.01"/>`),
		},
	},
}

// settingsMenu is only rendered when PageData.IsAuthenticated is true (see
// components/header.html and components/mobile-nav-panel.html) — the
// {{if}} guard in those templates means this data is simply never written
// to the response for anonymous visitors, satisfying
// docs/features/home.md's "absent, not CSS-hidden" security requirement.
var settingsMenu = NavMenu{
	ID:    "settings-menu",
	Label: "Settings",
	Align: "right",
	TriggerIcon: icon("h-4 w-4", `<circle cx="12" cy="12" r="3"/>`+
		`<path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"/>`),
	Items: []NavItem{
		{
			Label: "Profile",
			Href:  "/settings/profile",
			Icon:  icon("h-4 w-4", `<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>`),
		},
		{
			Label: "Security",
			Href:  "/settings/security",
			Icon:  icon("h-4 w-4", `<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>`),
		},
		{
			Label:  "Logout",
			Href:   "/logout",
			Method: "POST",
			Icon:   icon("h-4 w-4", `<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>`),
		},
	},
}
