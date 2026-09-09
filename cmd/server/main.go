// Command server runs the vincentmegia.com HTTP server.
package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/pressly/goose/v3"

	"github.com/vincentmegia/vincentmegia/internal/config"
	dbpkg "github.com/vincentmegia/vincentmegia/internal/db"
	"github.com/vincentmegia/vincentmegia/internal/handler"
	"github.com/vincentmegia/vincentmegia/internal/middleware"
	"github.com/vincentmegia/vincentmegia/internal/repository"
	"github.com/vincentmegia/vincentmegia/internal/service"
	"github.com/vincentmegia/vincentmegia/migrations"
)

// Version is the build version footer.html displays (see
// docs/features/home.md's Business Rules: "injected at build time ... not
// hand-maintained in a template"). Set via:
//
//	go build -ldflags "-X main.Version=$(git describe --tags --always)"
//
// Defaults to "dev" for local builds where it isn't set.
var Version = "dev"

func main() {
	if err := run(); err != nil {
		slog.Error("server exited with error", "error", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: cfg.LogLevel,
	}))
	slog.SetDefault(logger)

	conn, err := dbpkg.Open(context.Background(), cfg.DatabaseURL, cfg.DBMaxOpenConns)
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer conn.Close()

	if err := runMigrations(conn); err != nil {
		return fmt.Errorf("run migrations: %w", err)
	}

	mux, err := newMux(conn, cfg.LandingAPIToken)
	if err != nil {
		return err
	}

	handlerChain := middleware.Chain(mux,
		middleware.Recover,
		middleware.RequestID,
		middleware.ClientIP(cfg.TrustProxyHeaders),
		middleware.Logging,
		middleware.SecurityHeaders,
	)

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           handlerChain,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	return serveWithGracefulShutdown(srv)
}

// runMigrations applies pending migrations at startup via the goose
// library directly (not the separate goose CLI, which isn't a build or
// runtime dependency this way). Auto-run-on-boot is the pragmatic default
// for now; docs/features/resume.md's Open Questions flags this as worth
// revisiting once CLAUDE.md's Hosting decision is made — a serverless-style
// host makes auto-run riskier, since concurrent cold starts could race the
// same migration.
func runMigrations(conn *sql.DB) error {
	goose.SetBaseFS(migrations.FS)
	defer goose.SetBaseFS(nil)

	if err := goose.SetDialect("postgres"); err != nil {
		return fmt.Errorf("set migration dialect: %w", err)
	}
	if err := goose.Up(conn, "."); err != nil {
		return fmt.Errorf("apply migrations: %w", err)
	}
	return nil
}

// newMux registers all routes on a fresh ServeMux using Go 1.22+
// method+pattern routing. See docs/skills/go-backend/SKILL.md "Routing".
//
// Templates are parsed once at startup (fail fast if a template is
// missing/malformed, per go-backend's Configuration guidance) rather than
// per-request.
// landingAPIToken, when non-empty, enables the internal landing-content
// JSON API (docs/features/landing-content-api.md). Empty disables it
// entirely — the routes are never registered, so an unconfigured
// deployment 404s rather than exposing an unauthenticated write API. See
// config.Config.LandingAPIToken.
func newMux(conn *sql.DB, landingAPIToken string) (*http.ServeMux, error) {
	mux := http.NewServeMux()

	health := handler.NewHealthHandler(conn)
	mux.HandleFunc("GET /healthz", health.Index)

	tmpl, err := handler.LoadTemplates("web/templates")
	if err != nil {
		return nil, fmt.Errorf("load templates: %w", err)
	}
	renderer := handler.NewRenderer(tmpl)

	landingContentService := service.NewLandingContentService(repository.NewLandingContentRepository(conn))
	pages := handler.NewPagesHandler(renderer, landingContentService, Version)
	landingContent := handler.NewLandingContentHandler(renderer, landingContentService, Version)

	resumeService := service.NewResumeService(repository.NewResumeRepository(conn))
	resume := handler.NewResumeHandler(renderer, resumeService, Version)

	fishingService := service.NewFishingService(repository.NewFishingRepository(conn))
	fishingGame := handler.NewFishingGameHandler(renderer, fishingService, Version)

	cookingService := service.NewCookingService(repository.NewCookingRepository(conn))
	cookingGame := handler.NewCookingGameHandler(renderer, cookingService, Version)

	// See docs/features/home.md's Routes/Handlers table. This feature
	// owns the shell and these routes; the real page content behind each
	// is a separate, not-yet-built feature (placeholders for now).
	mux.HandleFunc("GET /{$}", pages.Home)
	mux.HandleFunc("GET /resume", resume.Index)
	// See docs/features/fishing-game.md's Routes/Handlers table.
	mux.HandleFunc("GET /fishing-game", fishingGame.Index)
	mux.HandleFunc("GET /fishing-game/leaderboard", fishingGame.Leaderboard)
	mux.HandleFunc("POST /fishing-game/score", fishingGame.SubmitScore)
	// See docs/features/cooking-game.md's Routes/Handlers table.
	mux.HandleFunc("GET /kitchen-shift", cookingGame.Index)
	mux.HandleFunc("GET /kitchen-shift/leaderboard", cookingGame.Leaderboard)
	mux.HandleFunc("POST /kitchen-shift/score", cookingGame.SubmitScore)
	mux.HandleFunc("GET /projects", pages.Projects)
	// See docs/features/puzzle-solver.md's Routes/Handlers table.
	mux.HandleFunc("GET /puzzle-solver", pages.PuzzleSolver)
	mux.HandleFunc("GET /blogs", pages.Blogs)
	mux.HandleFunc("GET /about", pages.About)
	mux.HandleFunc("GET /settings/profile", pages.Profile)
	mux.HandleFunc("GET /settings/security", pages.Security)
	// See docs/features/landing-content-authoring.md's Routes/Handlers table.
	mux.HandleFunc("GET /settings/content", landingContent.Index)
	mux.HandleFunc("POST /settings/content/hero", landingContent.SaveHero)
	mux.HandleFunc("POST /settings/content/carousel", landingContent.CreateSlide)
	mux.HandleFunc("PUT /settings/content/carousel/{id}", landingContent.UpdateSlide)
	mux.HandleFunc("DELETE /settings/content/carousel/{id}", landingContent.DeleteSlide)
	mux.HandleFunc("POST /settings/content/carousel/{id}/move", landingContent.MoveSlide)
	mux.HandleFunc("POST /settings/content/selected-work", landingContent.CreateWorkItem)
	mux.HandleFunc("PUT /settings/content/selected-work/{id}", landingContent.UpdateWorkItem)
	mux.HandleFunc("DELETE /settings/content/selected-work/{id}", landingContent.DeleteWorkItem)
	mux.HandleFunc("POST /settings/content/selected-work/{id}/move", landingContent.MoveWorkItem)
	// TEMPORARY: real logout (session invalidation) is a separate,
	// not-yet-built auth feature; see handler.PagesHandler.Logout.
	mux.HandleFunc("POST /logout", pages.Logout)

	if err := registerLandingAPI(mux, landingContentService, landingAPIToken); err != nil {
		return nil, err
	}

	fileServer := http.FileServer(http.Dir("web/static"))
	mux.Handle("GET /static/", http.StripPrefix("/static/", noCacheStatic(fileServer)))

	return mux, nil
}

// landingAPIPrefix is the base path for the internal content API HQ calls.
// "internal" names the intended audience — one trusted service, not the
// public web — even though the route is reachable on this service's public
// URL; the bearer token, not network topology, is what restricts it. "v1"
// leaves room to change response shapes without breaking a deployed HQ.
const landingAPIPrefix = "/api/internal/v1/landing"

// registerLandingAPI mounts the internal content API when a token is
// configured, and mounts nothing at all when it isn't.
//
// Every route is wrapped individually in handler.RequireAPIToken rather
// than relying on a prefix-wide middleware, so a route added later cannot
// accidentally end up unauthenticated: an unwrapped handler here would be
// visibly missing the wrapper, not silently inheriting protection from
// somewhere else in the file.
func registerLandingAPI(mux *http.ServeMux, svc *service.LandingContentService, token string) error {
	if token == "" {
		slog.Warn("landing content API disabled: LANDING_API_TOKEN is not set")
		return nil
	}

	api := handler.NewLandingAPIHandler(svc)
	limiter := handler.NewAuthFailureLimiter()

	protect := func(h http.HandlerFunc) http.Handler {
		return handler.RequireAPIToken(token, limiter, h)
	}

	// Route precedence note: "PUT /carousel/order" and
	// "PUT /carousel/{id}" both match a two-segment path. Go 1.22+
	// ServeMux resolves this by specificity — the literal "order" segment
	// beats the "{id}" wildcard — so the reorder route wins and numeric
	// ids still reach UpdateSlide. This is covered by a test
	// (TestLandingAPIRoutePrecedence) rather than left to a comment,
	// since getting it wrong would silently make one route unreachable.
	routes := []struct {
		pattern string
		handler http.HandlerFunc
	}{
		{"GET " + landingAPIPrefix + "/hero", api.GetHero},
		{"PUT " + landingAPIPrefix + "/hero", api.PutHero},

		{"GET " + landingAPIPrefix + "/carousel", api.ListSlides},
		{"POST " + landingAPIPrefix + "/carousel", api.CreateSlide},
		{"PUT " + landingAPIPrefix + "/carousel/order", api.ReorderSlides},
		{"GET " + landingAPIPrefix + "/carousel/{id}", api.GetSlide},
		{"PUT " + landingAPIPrefix + "/carousel/{id}", api.UpdateSlide},
		{"DELETE " + landingAPIPrefix + "/carousel/{id}", api.DeleteSlide},

		{"GET " + landingAPIPrefix + "/selected-work", api.ListWorkItems},
		{"POST " + landingAPIPrefix + "/selected-work", api.CreateWorkItem},
		{"PUT " + landingAPIPrefix + "/selected-work/order", api.ReorderWorkItems},
		{"GET " + landingAPIPrefix + "/selected-work/{id}", api.GetWorkItem},
		{"PUT " + landingAPIPrefix + "/selected-work/{id}", api.UpdateWorkItem},
		{"DELETE " + landingAPIPrefix + "/selected-work/{id}", api.DeleteWorkItem},
	}
	for _, route := range routes {
		mux.Handle(route.pattern, protect(route.handler))
	}

	// Anything else under the prefix gets the JSON error envelope rather
	// than ServeMux's plain-text 404. Unauthenticated on purpose: it
	// reveals only that a path doesn't exist, and requiring a token to
	// learn that would make a typo'd path indistinguishable from a bad
	// credential when HQ is debugging.
	mux.HandleFunc(landingAPIPrefix+"/", handler.APINotFound)

	slog.Info("landing content API enabled", "prefix", landingAPIPrefix)
	return nil
}

// noCacheStatic forces every /static/ response to revalidate with the
// server on each request, rather than trusting a browser's heuristic
// freshness guess. http.FileServer sets Last-Modified but no Cache-Control
// header at all — with nothing explicit, browsers (Safari in particular)
// can serve a stale cached JS/CSS file for a while after it changes on
// disk without even making a conditional request, which is exactly what
// made a real, already-shipped fix look like it was still broken. This
// still allows caching the bytes (a 304 on an unmodified file is cheap —
// http.FileServer already honors If-Modified-Since) — it just removes the
// window where a stale copy is used without asking first.
func noCacheStatic(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		next.ServeHTTP(w, r)
	})
}

// serveWithGracefulShutdown starts srv and blocks until SIGINT/SIGTERM is
// received, then stops accepting new connections and waits for active
// requests to finish before returning. See
// docs/skills/go-backend/SKILL.md "Graceful Shutdown".
func serveWithGracefulShutdown(srv *http.Server) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	serveErr := make(chan error, 1)
	go func() {
		slog.Info("server starting", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
			return
		}
		serveErr <- nil
	}()

	select {
	case err := <-serveErr:
		return err
	case <-ctx.Done():
		slog.Info("shutdown signal received")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		return err
	}

	slog.Info("server shut down cleanly")
	return nil
}
