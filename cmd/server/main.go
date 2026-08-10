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

	mux, err := newMux(conn)
	if err != nil {
		return err
	}

	handlerChain := middleware.Chain(mux,
		middleware.Recover,
		middleware.RequestID,
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
func newMux(conn *sql.DB) (*http.ServeMux, error) {
	mux := http.NewServeMux()

	health := handler.NewHealthHandler(conn)
	mux.HandleFunc("GET /healthz", health.Index)

	tmpl, err := handler.LoadTemplates("web/templates")
	if err != nil {
		return nil, fmt.Errorf("load templates: %w", err)
	}
	renderer := handler.NewRenderer(tmpl)
	pages := handler.NewPagesHandler(renderer, Version)

	resumeService := service.NewResumeService(repository.NewResumeRepository(conn))
	resume := handler.NewResumeHandler(renderer, resumeService, Version)

	fishingService := service.NewFishingService(repository.NewFishingRepository(conn))
	fishingGame := handler.NewFishingGameHandler(renderer, fishingService, Version)

	// See docs/features/home.md's Routes/Handlers table. This feature
	// owns the shell and these routes; the real page content behind each
	// is a separate, not-yet-built feature (placeholders for now).
	mux.HandleFunc("GET /{$}", pages.Home)
	mux.HandleFunc("GET /resume", resume.Index)
	// See docs/features/fishing-game.md's Routes/Handlers table.
	mux.HandleFunc("GET /fishing-game", fishingGame.Index)
	mux.HandleFunc("GET /fishing-game/leaderboard", fishingGame.Leaderboard)
	mux.HandleFunc("POST /fishing-game/score", fishingGame.SubmitScore)
	mux.HandleFunc("GET /projects", pages.Projects)
	mux.HandleFunc("GET /blogs", pages.Blogs)
	mux.HandleFunc("GET /settings/profile", pages.Profile)
	mux.HandleFunc("GET /settings/security", pages.Security)
	// TEMPORARY: real logout (session invalidation) is a separate,
	// not-yet-built auth feature; see handler.PagesHandler.Logout.
	mux.HandleFunc("POST /logout", pages.Logout)

	fileServer := http.FileServer(http.Dir("web/static"))
	mux.Handle("GET /static/", http.StripPrefix("/static/", noCacheStatic(fileServer)))

	return mux, nil
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
