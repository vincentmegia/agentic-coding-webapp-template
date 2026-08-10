package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/vincentmegia/vincentmegia/internal/config"
	"github.com/vincentmegia/vincentmegia/internal/db"
)

// chdirRepoRoot changes the working directory to the repo root for the
// test's duration and restores it afterward. newMux (via
// handler.LoadTemplates("web/templates") and http.Dir("web/static")) and
// migrations both resolve relative to the repo root, matching how the real
// binary is always run (go run ./cmd/server, or make run, from the repo
// root) — but `go test` itself runs with the package directory
// (cmd/server/) as the working directory, so this test has to correct for
// that explicitly rather than silently failing to find web/templates.
func chdirRepoRoot(t *testing.T) {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	root := filepath.Join(filepath.Dir(thisFile), "..", "..")

	prev, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(root); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chdir(prev) })
}

// TestEndToEnd exercises the real, fully-wired application — config
// (including .env layering, exactly as production does), database
// connection, migrations, routing, templates, and every layer in between —
// against a real Postgres instance, driving it over actual HTTP exactly as
// a browser would. This is the backend half of the end-to-end coverage
// referenced in docs/features/resume.md and docs/features/home.md; the
// frontend half lives in e2e/ (Playwright, driving a running server
// through a real browser).
//
// Requires DATABASE_URL (or a .env file — see config.example.yaml/
// .env.example) pointing at a real, reachable Postgres instance. Skipped
// otherwise, rather than failing, since CI/sandboxes without a database
// shouldn't block on this — go test ./... still exercises every unit-level
// test in the repository regardless.
func TestEndToEnd(t *testing.T) {
	chdirRepoRoot(t)

	cfg, err := config.Load()
	if err != nil {
		t.Skipf("config.Load(): %v (skipping end-to-end test — see .env.example)", err)
	}

	ctx := context.Background()
	conn, err := db.Open(ctx, cfg.DatabaseURL, cfg.DBMaxOpenConns)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer conn.Close()

	if err := runMigrations(conn); err != nil {
		t.Fatalf("run migrations: %v", err)
	}

	mux, err := newMux(conn)
	if err != nil {
		t.Fatalf("newMux: %v", err)
	}

	srv := httptest.NewServer(mux)
	defer srv.Close()
	client := srv.Client()

	t.Run("healthz reports healthy against a real database", func(t *testing.T) {
		resp, body := get(t, client, srv.URL+"/healthz")
		if resp.StatusCode != http.StatusOK {
			t.Errorf("status = %d, want 200", resp.StatusCode)
		}
		if body != "ok" {
			t.Errorf("body = %q, want %q", body, "ok")
		}
	})

	t.Run("home page renders the shared shell", func(t *testing.T) {
		resp, body := get(t, client, srv.URL+"/")
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want 200", resp.StatusCode)
		}
		for _, want := range []string{"<!doctype html>", "Vincent Megia", `id="home-menu-trigger"`} {
			if !strings.Contains(body, want) {
				t.Errorf("home page missing %q", want)
			}
		}
	})

	t.Run("resume page renders real seeded content end to end", func(t *testing.T) {
		resp, body := get(t, client, srv.URL+"/resume")
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want 200, body: %s", resp.StatusCode, body)
		}
		// Content actually round-tripped through config -> db.Open ->
		// migrations -> ResumeRepository -> ResumeService -> ResumeHandler
		// -> templates, not a fixture — these strings only appear if the
		// seed migration's data was genuinely read back out of Postgres.
		for _, want := range []string{
			"Vincent Megia",
			"Principal / Staff Software Engineer",
			`id="resume-role-`,
			"Singtel",
			"Barclays Wealth",
			"Current", // Singtel role has no end_date
			`id="resume-print-button"`,
			"See all projects",
		} {
			if !strings.Contains(body, want) {
				t.Errorf("resume page missing %q", want)
			}
		}
		if strings.Contains(body, "internal server error") || strings.Contains(body, "couldn't load this page") {
			t.Errorf("resume page rendered the error state instead of real content:\n%s", body)
		}
	})

	t.Run("resume page HTMX fragment omits the document shell", func(t *testing.T) {
		req, err := http.NewRequest(http.MethodGet, srv.URL+"/resume", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("HX-Request", "true")

		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		body := string(b)

		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want 200", resp.StatusCode)
		}
		if strings.Contains(body, "<!doctype html>") || strings.Contains(body, "<nav") {
			t.Error("HTMX fragment response included the full page shell (header/nav) — should be content-only")
		}
		if !strings.Contains(body, `id="resume-role-`) {
			t.Error("HTMX fragment response missing resume content")
		}
	})

	t.Run("placeholder routes are unaffected by the resume feature", func(t *testing.T) {
		for path, want := range map[string]string{
			"/projects": "Projects content coming soon.",
			"/blogs":    "Blog posts coming soon.",
		} {
			resp, body := get(t, client, srv.URL+path)
			if resp.StatusCode != http.StatusOK {
				t.Errorf("%s: status = %d, want 200", path, resp.StatusCode)
			}
			if !strings.Contains(body, want) {
				t.Errorf("%s: body missing %q", path, want)
			}
		}
	})

	t.Run("settings routes require auth", func(t *testing.T) {
		resp, err := client.Get(srv.URL + "/settings/profile")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		// The default client follows redirects, so landing anywhere other
		// than /settings/profile itself (today that's /login, a 404 since
		// real auth doesn't exist yet — see PagesHandler's doc comments)
		// proves the redirect happened rather than the profile page
		// rendering directly to an unauthenticated request.
		if resp.Request.URL.Path == "/settings/profile" {
			t.Error("unauthenticated request to /settings/profile did not redirect")
		}
	})

	t.Run("unknown route 404s", func(t *testing.T) {
		resp, _ := get(t, client, srv.URL+"/this-route-does-not-exist")
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("status = %d, want 404", resp.StatusCode)
		}
	})
}

func get(t *testing.T, client *http.Client, url string) (*http.Response, string) {
	t.Helper()
	resp, err := client.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp, string(b)
}
