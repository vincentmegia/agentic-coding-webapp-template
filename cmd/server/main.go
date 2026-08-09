// Command server runs the vincentmegia.com HTTP server.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/vincentmegia/vincentmegia/internal/config"
	"github.com/vincentmegia/vincentmegia/internal/handler"
	"github.com/vincentmegia/vincentmegia/internal/middleware"
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

	mux, err := newMux()
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

// newMux registers all routes on a fresh ServeMux using Go 1.22+
// method+pattern routing. See docs/skills/go-backend/SKILL.md "Routing".
//
// Templates are parsed once at startup (fail fast if a template is
// missing/malformed, per go-backend's Configuration guidance) rather than
// per-request.
func newMux() (*http.ServeMux, error) {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", handler.Healthz)

	tmpl, err := handler.LoadTemplates("web/templates")
	if err != nil {
		return nil, fmt.Errorf("load templates: %w", err)
	}
	pages := handler.NewPagesHandler(handler.NewRenderer(tmpl), Version)

	// See docs/features/home.md's Routes/Handlers table. This feature
	// owns the shell and these routes; the real page content behind each
	// is a separate, not-yet-built feature (placeholders for now).
	mux.HandleFunc("GET /{$}", pages.Home)
	mux.HandleFunc("GET /resume", pages.Resume)
	mux.HandleFunc("GET /projects", pages.Projects)
	mux.HandleFunc("GET /blogs", pages.Blogs)
	mux.HandleFunc("GET /settings/profile", pages.Profile)
	mux.HandleFunc("GET /settings/security", pages.Security)
	// TEMPORARY: real logout (session invalidation) is a separate,
	// not-yet-built auth feature; see handler.PagesHandler.Logout.
	mux.HandleFunc("POST /logout", pages.Logout)

	fileServer := http.FileServer(http.Dir("web/static"))
	mux.Handle("GET /static/", http.StripPrefix("/static/", fileServer))

	return mux, nil
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
