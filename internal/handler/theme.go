package handler

import "net/http"

// ThemeCookieName is the cookie docs/features/dark-mode.md persists the
// user's explicit theme choice in.
const ThemeCookieName = "theme"

// themeFromRequest reads the theme cookie and validates it against an exact
// allow-list (light|dark only), per docs/features/dark-mode.md's Business
// Rules: a cookie is attacker-settable, so anything else (missing, empty,
// malformed) is treated as "not set" — never interpolated into the response
// as-is — and the caller falls back to prefers-color-scheme.
func themeFromRequest(r *http.Request) string {
	c, err := r.Cookie(ThemeCookieName)
	if err != nil {
		return ""
	}
	switch c.Value {
	case "light", "dark":
		return c.Value
	default:
		return ""
	}
}
