package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

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

	// A fixed test token rather than cfg.LandingAPIToken: this test must
	// exercise the API regardless of whether the developer running it has
	// LANDING_API_TOKEN set locally, and using a known value lets the
	// subtests below assert both the authenticated and rejected paths.
	// It never leaves this process — httptest binds to loopback.
	mux, err := newMux(conn, conn, testLandingAPIToken, fakePDFGenerator{})
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
		// "Software Engineer"/"Selected work"/carousel alt text only
		// appear here if the landing_hero/landing_carousel_slides/
		// landing_selected_work_items seed migration genuinely round-
		// tripped through LandingContentService -> PagesHandler.Home ->
		// templates (docs/features/landing-content-authoring.md), not a
		// hardcoded Go fixture.
		for _, want := range []string{
			"<!doctype html>", "Vincent Megia", `id="primary-nav"`,
			"Software Engineer", "Selected work", "Illustration of a keyboard",
		} {
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

	t.Run("fishing game routes round-trip through the real fishing_scores table", func(t *testing.T) {
		resp, body := get(t, client, srv.URL+"/fishing-game")
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET /fishing-game: status = %d, want 200", resp.StatusCode)
		}
		if !strings.Contains(body, "Fishing Game") {
			t.Errorf("GET /fishing-game missing its title/content: %s", body)
		}

		resp, body = get(t, client, srv.URL+"/fishing-game/leaderboard")
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET /fishing-game/leaderboard: status = %d, want 200", resp.StatusCode)
		}
		if !strings.Contains(body, `id="fishing-leaderboard"`) {
			t.Errorf("leaderboard fragment missing its #fishing-leaderboard id: %s", body)
		}

		// Unique per test run so this doesn't collide with (or get
		// mistaken for) a real visitor's name in the shared dev database,
		// and so the cleanup below can target exactly this row. Kept
		// within the 20-char player_name bound (docs/features/
		// fishing-game.md's Data Model).
		playerName := fmt.Sprintf("e2e-%d", time.Now().UnixNano()%1_000_000)
		t.Cleanup(func() {
			if _, err := conn.Exec(`DELETE FROM fishing_scores WHERE player_name = $1`, playerName); err != nil {
				t.Errorf("cleanup: delete test fishing_scores row: %v", err)
			}
		})

		form := url.Values{"player_name": {playerName}, "score": {"1234"}, "depth_reached_miles": {"567"}}
		resp, err := client.PostForm(srv.URL+"/fishing-game/score", form)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		body = string(b)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("POST /fishing-game/score: status = %d, want 200, body: %s", resp.StatusCode, body)
		}
		// A real row actually round-tripped through
		// FishingRepository.Insert -> Postgres -> FishingRepository.TopScores,
		// not a fixture — this only appears if the INSERT and the
		// re-rendered leaderboard fragment both genuinely hit the DB.
		if !strings.Contains(body, playerName) || !strings.Contains(body, "1234 pts") {
			t.Errorf("POST /fishing-game/score response missing the newly inserted entry: %s", body)
		}

		t.Run("rejects an out-of-range submission with 400, not a raw DB error", func(t *testing.T) {
			badForm := url.Values{"player_name": {"e2e-invalid"}, "score": {"99999999"}, "depth_reached_miles": {"50"}}
			resp, err := client.PostForm(srv.URL+"/fishing-game/score", badForm)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			b, err := io.ReadAll(resp.Body)
			if err != nil {
				t.Fatal(err)
			}
			body := string(b)
			if resp.StatusCode != http.StatusBadRequest {
				t.Errorf("status = %d, want 400, body: %s", resp.StatusCode, body)
			}
			if strings.Contains(body, "constraint") || strings.Contains(body, "SQLSTATE") {
				t.Errorf("error body looks like a raw DB error: %s", body)
			}
		})
	})

	t.Run("kitchen shift routes round-trip through the real cooking_scores table", func(t *testing.T) {
		resp, body := get(t, client, srv.URL+"/kitchen-shift")
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET /kitchen-shift: status = %d, want 200", resp.StatusCode)
		}
		if !strings.Contains(body, "Kitchen Shift") {
			t.Errorf("GET /kitchen-shift missing its title/content: %s", body)
		}

		resp, body = get(t, client, srv.URL+"/kitchen-shift/leaderboard")
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET /kitchen-shift/leaderboard: status = %d, want 200", resp.StatusCode)
		}
		if !strings.Contains(body, `id="cooking-leaderboard"`) {
			t.Errorf("leaderboard fragment missing its #cooking-leaderboard id: %s", body)
		}

		// Unique per test run, same reasoning as the fishing game
		// subtest's playerName above.
		playerName := fmt.Sprintf("e2e-%d", time.Now().UnixNano()%1_000_000)
		t.Cleanup(func() {
			if _, err := conn.Exec(`DELETE FROM cooking_scores WHERE player_name = $1`, playerName); err != nil {
				t.Errorf("cleanup: delete test cooking_scores row: %v", err)
			}
		})

		form := url.Values{"player_name": {playerName}, "total_earnings": {"78000"}, "shifts_completed": {"20"}}
		resp, err := client.PostForm(srv.URL+"/kitchen-shift/score", form)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		body = string(b)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("POST /kitchen-shift/score: status = %d, want 200, body: %s", resp.StatusCode, body)
		}
		// A real row actually round-tripped through
		// CookingRepository.Insert -> Postgres -> CookingRepository.TopScores.
		if !strings.Contains(body, playerName) || !strings.Contains(body, "78000 Gard") {
			t.Errorf("POST /kitchen-shift/score response missing the newly inserted entry: %s", body)
		}

		t.Run("rejects an out-of-range submission with 400, not a raw DB error", func(t *testing.T) {
			badForm := url.Values{"player_name": {"e2e-invalid"}, "total_earnings": {"99999999"}, "shifts_completed": {"20"}}
			resp, err := client.PostForm(srv.URL+"/kitchen-shift/score", badForm)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			b, err := io.ReadAll(resp.Body)
			if err != nil {
				t.Fatal(err)
			}
			body := string(b)
			if resp.StatusCode != http.StatusBadRequest {
				t.Errorf("status = %d, want 400, body: %s", resp.StatusCode, body)
			}
			if strings.Contains(body, "constraint") || strings.Contains(body, "SQLSTATE") {
				t.Errorf("error body looks like a raw DB error: %s", body)
			}
		})
	})

	t.Run("library shift routes round-trip through the real library_scores table", func(t *testing.T) {
		resp, body := get(t, client, srv.URL+"/library-game")
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET /library-game: status = %d, want 200", resp.StatusCode)
		}
		if !strings.Contains(body, "Library Shift") {
			t.Errorf("GET /library-game missing its title/content: %s", body)
		}

		resp, body = get(t, client, srv.URL+"/library-game/leaderboard")
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET /library-game/leaderboard: status = %d, want 200", resp.StatusCode)
		}
		if !strings.Contains(body, `id="library-leaderboard"`) {
			t.Errorf("leaderboard fragment missing its #library-leaderboard id: %s", body)
		}

		// Unique per test run, same reasoning as the fishing/cooking
		// subtests' playerName above.
		playerName := fmt.Sprintf("e2e-%d", time.Now().UnixNano()%1_000_000)
		t.Cleanup(func() {
			if _, err := conn.Exec(`DELETE FROM library_scores WHERE player_name = $1`, playerName); err != nil {
				t.Errorf("cleanup: delete test library_scores row: %v", err)
			}
		})

		form := url.Values{"player_name": {playerName}, "total_earnings": {"78000"}, "shifts_completed": {"30"}}
		resp, err := client.PostForm(srv.URL+"/library-game/score", form)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		body = string(b)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("POST /library-game/score: status = %d, want 200, body: %s", resp.StatusCode, body)
		}
		// A real row actually round-tripped through
		// LibraryRepository.Insert -> Postgres -> LibraryRepository.TopScores.
		if !strings.Contains(body, playerName) || !strings.Contains(body, "78000 Gard") {
			t.Errorf("POST /library-game/score response missing the newly inserted entry: %s", body)
		}

		t.Run("rejects an out-of-range submission with 400, not a raw DB error", func(t *testing.T) {
			badForm := url.Values{"player_name": {"e2e-invalid"}, "total_earnings": {"99999999"}, "shifts_completed": {"30"}}
			resp, err := client.PostForm(srv.URL+"/library-game/score", badForm)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			b, err := io.ReadAll(resp.Body)
			if err != nil {
				t.Fatal(err)
			}
			body := string(b)
			if resp.StatusCode != http.StatusBadRequest {
				t.Errorf("status = %d, want 400, body: %s", resp.StatusCode, body)
			}
			if strings.Contains(body, "constraint") || strings.Contains(body, "SQLSTATE") {
				t.Errorf("error body looks like a raw DB error: %s", body)
			}
		})
	})

	t.Run("placeholder routes are unaffected by the resume feature", func(t *testing.T) {
		for path, want := range map[string]string{
			"/blogs": "Blog posts coming soon.",
			"/about": "About content coming soon.",
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

	// /projects has real content now (docs/features/projects.md) — no
	// longer part of the placeholder-routes check above.
	t.Run("projects page renders real content, not the shared placeholder", func(t *testing.T) {
		resp, body := get(t, client, srv.URL+"/projects")
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want 200", resp.StatusCode)
		}
		for _, want := range []string{`id="projects-grid"`, "Fishing Game", "Play now"} {
			if !strings.Contains(body, want) {
				t.Errorf("/projects missing %q", want)
			}
		}
		if strings.Contains(body, "Projects content coming soon.") {
			t.Error("/projects still rendering the shared placeholder")
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

	t.Run("content authoring routes require auth", func(t *testing.T) {
		// Same contract as /settings/profile above — see
		// docs/features/landing-content-authoring.md's Security
		// Considerations.
		resp, err := client.Get(srv.URL + "/settings/content")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.Request.URL.Path == "/settings/content" {
			t.Error("unauthenticated request to /settings/content did not redirect")
		}
	})

	t.Run("resume authoring routes require auth", func(t *testing.T) {
		// Same contract as /settings/profile above — see
		// docs/features/resume-content-authoring.md's Security
		// Considerations.
		resp, err := client.Get(srv.URL + "/settings/resume")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.Request.URL.Path == "/settings/resume" {
			t.Error("unauthenticated request to /settings/resume did not redirect")
		}
	})

	t.Run("unknown route 404s", func(t *testing.T) {
		resp, _ := get(t, client, srv.URL+"/this-route-does-not-exist")
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("status = %d, want 404", resp.StatusCode)
		}
	})

	t.Run("landing API rejects an unauthenticated request", func(t *testing.T) {
		resp, body := get(t, client, srv.URL+landingAPIPrefix+"/hero")
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", resp.StatusCode)
		}
		// The envelope matters as much as the status: HQ branches on the
		// code, and a redirect-to-login (the HTML editor's behavior)
		// would arrive here as a 200 with HTML instead.
		if !strings.Contains(body, `"error":"unauthorized"`) {
			t.Errorf("body = %q, want the JSON unauthorized envelope", body)
		}
	})

	t.Run("landing API rejects a wrong token", func(t *testing.T) {
		resp, _ := apiDo(t, client, http.MethodGet, srv.URL+landingAPIPrefix+"/hero",
			"Bearer "+strings.Repeat("z", len(testLandingAPIToken)), nil)
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("status = %d, want 401", resp.StatusCode)
		}
	})

	t.Run("landing API hero round-trips to the rendered page", func(t *testing.T) {
		// The behavior HQ actually depends on: a write through the API is
		// visible on the next render of /. Restores the original copy
		// afterward so this test is re-runnable and leaves the seeded
		// content intact for the other subtests.
		before, body := apiDo(t, client, http.MethodGet, srv.URL+landingAPIPrefix+"/hero", apiAuth(), nil)
		if before.StatusCode != http.StatusOK {
			t.Fatalf("GET hero status = %d, want 200, body: %s", before.StatusCode, body)
		}
		var original map[string]string
		if err := json.Unmarshal([]byte(body), &original); err != nil {
			t.Fatalf("decode hero: %v (body %s)", err, body)
		}
		t.Cleanup(func() {
			restore, _ := json.Marshal(original)
			apiDo(t, client, http.MethodPut, srv.URL+landingAPIPrefix+"/hero", apiAuth(), restore)
		})

		const sentinel = "E2E sentinel eyebrow"
		updated, _ := json.Marshal(map[string]string{
			"eyebrow": sentinel,
			"title":   original["title"],
			"message": original["message"],
		})
		resp, putBody := apiDo(t, client, http.MethodPut, srv.URL+landingAPIPrefix+"/hero", apiAuth(), updated)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("PUT hero status = %d, want 200, body: %s", resp.StatusCode, putBody)
		}

		_, page := get(t, client, srv.URL+"/")
		if !strings.Contains(page, sentinel) {
			t.Error("landing page does not reflect the hero written through the API")
		}
	})

	t.Run("landing API rejects an invalid hero", func(t *testing.T) {
		payload := []byte(`{"eyebrow":"   ","title":"t","message":"m"}`)
		resp, body := apiDo(t, client, http.MethodPut, srv.URL+landingAPIPrefix+"/hero", apiAuth(), payload)
		if resp.StatusCode != http.StatusUnprocessableEntity {
			t.Fatalf("status = %d, want 422, body: %s", resp.StatusCode, body)
		}
		if !strings.Contains(body, `"error":"validation_failed"`) {
			t.Errorf("body = %q, want the validation_failed envelope", body)
		}
	})

	t.Run("landing API rejects an unknown field", func(t *testing.T) {
		// Guards Decision 2 concretely: a client that sends sort_order
		// (as HQ's UI does today) gets a clear 400 rather than having it
		// silently dropped. See docs/features/landing-content-api.md.
		payload := []byte(`{"image_path":"/x.svg","alt":"a","caption":"","link_url":"","external":false,"sort_order":9}`)
		resp, body := apiDo(t, client, http.MethodPost, srv.URL+landingAPIPrefix+"/carousel", apiAuth(), payload)
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400, body: %s", resp.StatusCode, body)
		}
	})

	t.Run("landing API 404s an unknown slide", func(t *testing.T) {
		resp, body := apiDo(t, client, http.MethodGet, srv.URL+landingAPIPrefix+"/carousel/99999999", apiAuth(), nil)
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("status = %d, want 404, body: %s", resp.StatusCode, body)
		}
	})

	t.Run("landing API reorder rejects a partial id list", func(t *testing.T) {
		resp, body := apiDo(t, client, http.MethodPut, srv.URL+landingAPIPrefix+"/carousel/order",
			apiAuth(), []byte(`{"ids":[1]}`))
		if resp.StatusCode != http.StatusUnprocessableEntity {
			t.Fatalf("status = %d, want 422, body: %s", resp.StatusCode, body)
		}
	})

	t.Run("landing API route precedence keeps /order and /{id} distinct", func(t *testing.T) {
		// "/carousel/order" must reach ReorderSlides, not UpdateSlide with
		// a malformed id — otherwise reordering would 400 forever. A 422
		// here (the empty-list mismatch) proves it routed to the reorder
		// handler; a 400 would mean it fell through to /{id}.
		resp, body := apiDo(t, client, http.MethodPut, srv.URL+landingAPIPrefix+"/carousel/order",
			apiAuth(), []byte(`{"ids":[]}`))
		if resp.StatusCode != http.StatusUnprocessableEntity {
			t.Fatalf("status = %d, want 422 (reorder handler reached), body: %s", resp.StatusCode, body)
		}
	})
}

// testLandingAPIToken is the bearer token the end-to-end server is built
// with. Length satisfies config's landingAPITokenMinLen so it stays
// representative of a real deployment.
const testLandingAPIToken = "e2e-test-token-0123456789abcdef0123456789abcdef"

func apiAuth() string { return "Bearer " + testLandingAPIToken }

// apiDo issues a JSON API request with an explicit Authorization header,
// returning the response and its body. body may be nil for GET/DELETE.
func apiDo(t *testing.T, client *http.Client, method, url, authorization string, body []byte) (*http.Response, string) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, url, reader)
	if err != nil {
		t.Fatal(err)
	}
	if authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
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
