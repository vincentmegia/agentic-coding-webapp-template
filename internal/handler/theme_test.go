package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestThemeFromRequest locks in docs/features/dark-mode.md's Business
// Rules requirement that the theme cookie is validated server-side
// against an exact allow-list: a cookie is attacker-settable, so anything
// other than exactly "light" or "dark" must be treated as not set, never
// reflected into the rendered class as-is.
func TestThemeFromRequest(t *testing.T) {
	tests := []struct {
		name  string
		value string
		unset bool
		want  string
	}{
		{name: "no cookie at all", unset: true, want: ""},
		{name: "light", value: "light", want: "light"},
		{name: "dark", value: "dark", want: "dark"},
		{name: "empty value", value: "", want: ""},
		{name: "wrong case", value: "Light", want: ""},
		{name: "unexpected word", value: "blue", want: ""},
		{name: "whitespace padded", value: " dark", want: ""},
		{name: "suspicious but well-formed value", value: "javascript:alert(1)", want: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			if !tt.unset {
				req.AddCookie(&http.Cookie{Name: ThemeCookieName, Value: tt.value})
			}

			if got := themeFromRequest(req); got != tt.want {
				t.Errorf("themeFromRequest() = %q, want %q", got, tt.want)
			}
		})
	}
}
