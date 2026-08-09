package handler

import "net/http"

// IsAuthenticated reports whether r belongs to an authenticated
// site-owner session.
//
// TEMPORARY STUB: real authentication (sessions, cookies, login flow) is a
// separate, not-yet-built feature — see docs/features/home.md's Scope
// ("Authentication/session implementation ... this feature only consumes
// that result"). This always returns false, so the Settings nav stays
// absent and /settings/* keeps redirecting to /login until that feature
// lands. Replace this function's body — not its call sites — when real
// auth is built.
func IsAuthenticated(r *http.Request) bool {
	return false
}
