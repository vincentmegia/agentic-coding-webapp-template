// Command server runs the vincentmegia.com HTTP server.
package main

import (
	"context"
	"errors"
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

	mux := newMux()

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
func newMux() *http.ServeMux {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", handler.Healthz)

	// TEMPORARY: replaced by the real layout/page feature in a later task.
	mux.HandleFunc("GET /{$}", handler.TemporaryRoot)

	fileServer := http.FileServer(http.Dir("web/static"))
	mux.Handle("GET /static/", http.StripPrefix("/static/", fileServer))

	return mux
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
