// Package config loads deployment-specific settings from environment
// variables. See docs/skills/go-backend/SKILL.md "Configuration".
package config

import (
	"fmt"
	"log/slog"
	"os"
	"strconv"
)

// Config holds all runtime configuration for the server.
type Config struct {
	// Port is the TCP port the HTTP server listens on.
	Port string
	// LogLevel controls the minimum slog level emitted by the server.
	LogLevel slog.Level
}

// Load reads configuration from environment variables, applying sensible
// defaults for local development. It fails fast (returns an error) if a
// supplied value is present but invalid.
func Load() (Config, error) {
	cfg := Config{
		Port:     getEnv("PORT", "8080"),
		LogLevel: slog.LevelInfo,
	}

	if raw, ok := os.LookupEnv("LOG_LEVEL"); ok {
		level, err := parseLogLevel(raw)
		if err != nil {
			return Config{}, fmt.Errorf("parse LOG_LEVEL: %w", err)
		}
		cfg.LogLevel = level
	}

	if _, err := strconv.Atoi(cfg.Port); err != nil {
		return Config{}, fmt.Errorf("parse PORT %q: %w", cfg.Port, err)
	}

	return cfg, nil
}

func getEnv(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}

func parseLogLevel(raw string) (slog.Level, error) {
	switch raw {
	case "DEBUG":
		return slog.LevelDebug, nil
	case "INFO":
		return slog.LevelInfo, nil
	case "WARN":
		return slog.LevelWarn, nil
	case "ERROR":
		return slog.LevelError, nil
	default:
		return 0, fmt.Errorf("unrecognized log level %q", raw)
	}
}
