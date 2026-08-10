// Package config loads deployment-specific settings by layering an
// optional YAML file and an optional .env file under real process
// environment variables. See docs/skills/go-backend/SKILL.md
// "Configuration".
package config

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strconv"

	"github.com/joho/godotenv"
	"gopkg.in/yaml.v3"
)

// Config holds all runtime configuration for the server.
type Config struct {
	// Port is the TCP port the HTTP server listens on.
	Port string
	// LogLevel controls the minimum slog level emitted by the server.
	LogLevel slog.Level
	// DatabaseURL is the Postgres connection string (see
	// docs/skills/postgres/SKILL.md). Required — this app has no code path
	// that runs without a database as of the resume feature
	// (docs/features/resume.md). Sourced from a real environment variable
	// or .env — never from config.yaml; see fileConfig's doc comment.
	DatabaseURL string
	// DBMaxOpenConns bounds the connection pool per
	// docs/skills/postgres/SKILL.md "Connection Management".
	DBMaxOpenConns int
}

// fileConfig is the shape of the optional YAML config file
// (docs/skills/go-backend/SKILL.md "Configuration"). It deliberately has
// no field for DatabaseURL or any other secret — secrets belong in a real
// environment variable or .env (see env/loadDotenv below), never in
// config.yaml, which this project treats as structural/non-secret only.
// Load decodes this with strict field checking, so an unrecognized key (a
// typo, or an attempted secret like `database_url`) fails startup instead
// of being silently ignored.
type fileConfig struct {
	Port     string `yaml:"port"`
	LogLevel string `yaml:"log_level"`
	DB       struct {
		MaxOpenConns int `yaml:"max_open_conns"`
	} `yaml:"db"`
}

// env is a small read-only merge of the real process environment and an
// optional .env file, real env vars always winning. It deliberately does
// NOT call os.Setenv to inject .env values into the process environment
// (unlike godotenv.Load's default behavior) — reading .env into a plain
// map (godotenv.Read) instead keeps this package's environment reads pure
// and testable, without mutating global process state.
type env struct {
	dotenv map[string]string
}

// loadDotenv reads path (a .env file — see docs/skills/go-backend/SKILL.md
// "Configuration") without mutating the process environment. A missing
// file is not an error, for the same reason a missing config.yaml isn't:
// real environment variables alone must remain sufficient to run the app.
func loadDotenv(path string) (env, error) {
	if _, err := os.Stat(path); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return env{}, nil
		}
		return env{}, fmt.Errorf("stat env file %s: %w", path, err)
	}

	m, err := godotenv.Read(path)
	if err != nil {
		return env{}, fmt.Errorf("parse env file %s: %w", path, err)
	}
	return env{dotenv: m}, nil
}

// lookup returns key's value and whether it was set, checking the real
// process environment first and falling back to the parsed .env file —
// real environment variables always win, matching this project's stated
// precedence (docs/skills/go-backend/SKILL.md "Configuration").
func (e env) lookup(key string) (string, bool) {
	if v, ok := os.LookupEnv(key); ok {
		return v, true
	}
	if v, ok := e.dotenv[key]; ok {
		return v, true
	}
	return "", false
}

// get returns key's value, or fallback if it's unset or empty in both the
// real environment and .env.
func (e env) get(key, fallback string) string {
	if v, ok := e.lookup(key); ok && v != "" {
		return v
	}
	return fallback
}

// Load reads configuration by layering, lowest to highest precedence:
//
//  1. Hardcoded defaults.
//  2. config.yaml (optional — see loadFile). Structural/non-secret settings
//     only; it has no key for DatabaseURL or any other secret.
//  3. .env (optional — see loadDotenv). The local-dev-friendly place for
//     secrets that would otherwise need to be exported by hand.
//  4. Real environment variables (however they're set — shell export,
//     `docker run -e`, a hosting platform's own config) — always win, even
//     over a value .env also sets.
//
// It fails fast (returns an error) if a supplied value from any layer is
// present but invalid, or if a required value is missing once every layer
// has been applied.
func Load() (Config, error) {
	cfg := Config{
		Port:           "8080",
		LogLevel:       slog.LevelInfo,
		DBMaxOpenConns: 10,
	}

	// ENV_FILE itself must be a raw environment variable, not resolved
	// through env.lookup — its whole job is telling us where to find the
	// .env file in the first place.
	e, err := loadDotenv(getEnvRaw("ENV_FILE", ".env"))
	if err != nil {
		return Config{}, err
	}

	fc, err := loadFile(e.get("CONFIG_FILE", "config.yaml"))
	if err != nil {
		return Config{}, err
	}
	if fc != nil {
		if fc.Port != "" {
			cfg.Port = fc.Port
		}
		if fc.LogLevel != "" {
			level, err := parseLogLevel(fc.LogLevel)
			if err != nil {
				return Config{}, fmt.Errorf("parse log_level in config file: %w", err)
			}
			cfg.LogLevel = level
		}
		if fc.DB.MaxOpenConns != 0 {
			cfg.DBMaxOpenConns = fc.DB.MaxOpenConns
		}
	}

	if raw, ok := e.lookup("PORT"); ok && raw != "" {
		cfg.Port = raw
	}
	if raw, ok := e.lookup("LOG_LEVEL"); ok {
		level, err := parseLogLevel(raw)
		if err != nil {
			return Config{}, fmt.Errorf("parse LOG_LEVEL: %w", err)
		}
		cfg.LogLevel = level
	}
	if raw, ok := e.lookup("DB_MAX_OPEN_CONNS"); ok {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			return Config{}, fmt.Errorf("parse DB_MAX_OPEN_CONNS %q: must be a positive integer", raw)
		}
		cfg.DBMaxOpenConns = n
	}

	// DatabaseURL is real-env-or-.env-only — see fileConfig's doc
	// comment. There is no config.yaml path for it.
	cfg.DatabaseURL, _ = e.lookup("DATABASE_URL")

	if _, err := strconv.Atoi(cfg.Port); err != nil {
		return Config{}, fmt.Errorf("parse port %q: %w", cfg.Port, err)
	}
	if cfg.DatabaseURL == "" {
		return Config{}, fmt.Errorf("DATABASE_URL is required")
	}
	if cfg.DBMaxOpenConns <= 0 {
		return Config{}, fmt.Errorf("db.max_open_conns must be a positive integer, got %d", cfg.DBMaxOpenConns)
	}

	return cfg, nil
}

// loadFile reads and strictly decodes the YAML config file at path. A
// missing file is not an error — environment variables alone must remain
// sufficient to run the app (docs/skills/go-backend/SKILL.md
// "Configuration"), which is the only layer this project's own
// environment actually uses today (no config.yaml is checked in — see
// config.example.yaml). Strict field checking means an unrecognized key
// fails fast rather than being silently ignored.
func loadFile(path string) (*fileConfig, error) {
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("open config file %s: %w", path, err)
	}
	defer f.Close()

	var fc fileConfig
	dec := yaml.NewDecoder(f)
	dec.KnownFields(true)
	if err := dec.Decode(&fc); err != nil {
		if errors.Is(err, io.EOF) {
			// Empty file (or comments-only) — valid, no overrides.
			return &fc, nil
		}
		return nil, fmt.Errorf("parse config file %s: %w", path, err)
	}
	return &fc, nil
}

// getEnvRaw reads a real process environment variable directly — used
// only for ENV_FILE, which must be resolved before .env can be loaded and
// therefore can't itself come from .env.
func getEnvRaw(key, fallback string) string {
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
