package service

import (
	"html/template"
	"testing"
	"time"
)

// TestBoldMarkup verifies the escape-then-wrap ordering that
// docs/features/resume.md's Security Considerations calls out as the
// actual security mechanism, not just a style note: raw text must be
// escaped before "<b>"/"</b>" are inserted, never after.
func TestBoldMarkup(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want template.HTML
	}{
		{
			name: "no markup",
			in:   "plain text",
			want: "plain text",
		},
		{
			name: "single bold span",
			in:   "Principal Software Engineer with **18+ years** of experience.",
			want: "Principal Software Engineer with <b>18+ years</b> of experience.",
		},
		{
			name: "multiple bold spans",
			in:   "at **PayPal** and for **Barclays**, combining",
			want: "at <b>PayPal</b> and for <b>Barclays</b>, combining",
		},
		{
			name: "raw HTML in the DB value is escaped, not interpreted",
			in:   `<script>alert(1)</script> and **<b>nested</b>**`,
			want: `&lt;script&gt;alert(1)&lt;/script&gt; and <b>&lt;b&gt;nested&lt;/b&gt;</b>`,
		},
		{
			name: "literal ampersand outside markup is escaped",
			in:   "R&D across **AWS & Kubernetes**",
			want: "R&amp;D across <b>AWS &amp; Kubernetes</b>",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := boldMarkup(tt.in)
			if got != tt.want {
				t.Errorf("boldMarkup(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestResolveIcon(t *testing.T) {
	if got := resolveIcon("phone"); got == "" {
		t.Error("resolveIcon(\"phone\") = empty, want a known icon")
	}
	if got := resolveIcon("javascript:alert(1)"); got != "" {
		t.Errorf("resolveIcon of an unrecognized/malicious key = %q, want empty (no icon, not a failure)", got)
	}
	if got := resolveIcon(""); got != "" {
		t.Errorf("resolveIcon(\"\") = %q, want empty", got)
	}
}

func TestDateRange(t *testing.T) {
	start := time.Date(2021, time.April, 1, 0, 0, 0, 0, time.UTC)
	if got, want := dateRange(start, nil), "APR 2021 – PRESENT"; got != want {
		t.Errorf("dateRange(current) = %q, want %q", got, want)
	}

	end := time.Date(2021, time.February, 28, 0, 0, 0, 0, time.UTC)
	sofgenStart := time.Date(2010, time.January, 1, 0, 0, 0, 0, time.UTC)
	if got, want := dateRange(sofgenStart, &end), "JAN 2010 – FEB 2021"; got != want {
		t.Errorf("dateRange(past) = %q, want %q", got, want)
	}
}
