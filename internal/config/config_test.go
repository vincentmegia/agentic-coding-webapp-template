package config

import (
	"os"
	"path/filepath"
	"testing"
)

// withEnv sets env vars for the test's duration and restores the previous
// state afterward, including unsetting anything that wasn't set before.
func withEnv(t *testing.T, kv map[string]string) {
	t.Helper()
	for k, v := range kv {
		prev, had := os.LookupEnv(k)
		os.Setenv(k, v)
		t.Cleanup(func() {
			if had {
				os.Setenv(k, prev)
			} else {
				os.Unsetenv(k)
			}
		})
	}
}

func writeConfigFile(t *testing.T, contents string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func writeEnvFile(t *testing.T, contents string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoad_MissingFileIsNotAnError(t *testing.T) {
	withEnv(t, map[string]string{
		"CONFIG_FILE":  filepath.Join(t.TempDir(), "does-not-exist.yaml"),
		"DATABASE_URL": "postgres://localhost/test",
	})

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() with no config file: %v", err)
	}
	if cfg.Port != "8080" {
		t.Errorf("Port = %q, want default 8080", cfg.Port)
	}
	if cfg.DBMaxOpenConns != 10 {
		t.Errorf("DBMaxOpenConns = %d, want default 10", cfg.DBMaxOpenConns)
	}
}

func TestLoad_FileOverridesDefaults(t *testing.T) {
	path := writeConfigFile(t, "port: \"9090\"\nlog_level: DEBUG\ndb:\n  max_open_conns: 25\n")
	withEnv(t, map[string]string{
		"CONFIG_FILE":  path,
		"DATABASE_URL": "postgres://localhost/test",
	})

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load(): %v", err)
	}
	if cfg.Port != "9090" {
		t.Errorf("Port = %q, want 9090 from file", cfg.Port)
	}
	if cfg.DBMaxOpenConns != 25 {
		t.Errorf("DBMaxOpenConns = %d, want 25 from file", cfg.DBMaxOpenConns)
	}
}

// TestLoad_EnvOverridesFile is the core layering guarantee from
// docs/skills/go-backend/SKILL.md's Configuration section: environment
// variables always win, even when the file also sets a value.
func TestLoad_EnvOverridesFile(t *testing.T) {
	path := writeConfigFile(t, "port: \"9090\"\n")
	withEnv(t, map[string]string{
		"CONFIG_FILE":  path,
		"PORT":         "7070",
		"DATABASE_URL": "postgres://localhost/test",
	})

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load(): %v", err)
	}
	if cfg.Port != "7070" {
		t.Errorf("Port = %q, want 7070 from env (overriding file's 9090)", cfg.Port)
	}
}

// TestLoad_DatabaseURLHasNoFileEquivalent confirms the "no YAML key at
// all for secrets" rule: even a config file with an unrecognized
// database_url key must fail loudly, not be silently ignored, per
// docs/skills/go-backend/SKILL.md's "Never put secrets in the YAML file".
func TestLoad_DatabaseURLHasNoFileEquivalent(t *testing.T) {
	path := writeConfigFile(t, "database_url: postgres://localhost/should-not-work\n")
	withEnv(t, map[string]string{
		"CONFIG_FILE":  path,
		"DATABASE_URL": "postgres://localhost/real",
	})

	_, err := Load()
	if err == nil {
		t.Fatal("Load() with an unrecognized database_url key in the config file = nil error, want a strict-decoding failure")
	}
}

func TestLoad_MissingDatabaseURL(t *testing.T) {
	withEnv(t, map[string]string{
		"CONFIG_FILE": filepath.Join(t.TempDir(), "does-not-exist.yaml"),
	})

	prev, had := os.LookupEnv("DATABASE_URL")
	os.Unsetenv("DATABASE_URL")
	t.Cleanup(func() {
		if had {
			os.Setenv("DATABASE_URL", prev)
		}
	})

	if _, err := Load(); err == nil {
		t.Fatal("Load() with no DATABASE_URL = nil error, want a required-config failure")
	}
}

func TestLoad_InvalidLogLevelInFile(t *testing.T) {
	path := writeConfigFile(t, "log_level: NOISY\n")
	withEnv(t, map[string]string{
		"CONFIG_FILE":  path,
		"DATABASE_URL": "postgres://localhost/test",
	})

	if _, err := Load(); err == nil {
		t.Fatal("Load() with an invalid log_level in the config file = nil error, want a parse failure")
	}
}

func TestLoad_EmptyFileIsValid(t *testing.T) {
	path := writeConfigFile(t, "# just a comment, no keys\n")
	withEnv(t, map[string]string{
		"CONFIG_FILE":  path,
		"DATABASE_URL": "postgres://localhost/test",
	})

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() with an empty/comments-only config file: %v", err)
	}
	if cfg.Port != "8080" {
		t.Errorf("Port = %q, want default 8080", cfg.Port)
	}
}

// TestLoad_DatabaseURLFromDotenv confirms .env is a real source for
// secrets — unlike config.yaml, which has no key for DatabaseURL at all
// (docs/skills/go-backend/SKILL.md "Configuration").
func TestLoad_DatabaseURLFromDotenv(t *testing.T) {
	path := writeEnvFile(t, "DATABASE_URL=postgres://localhost/from-dotenv\nPORT=6060\n")
	withEnv(t, map[string]string{
		"ENV_FILE":    path,
		"CONFIG_FILE": filepath.Join(t.TempDir(), "does-not-exist.yaml"),
	})

	prev, had := os.LookupEnv("DATABASE_URL")
	os.Unsetenv("DATABASE_URL")
	t.Cleanup(func() {
		if had {
			os.Setenv("DATABASE_URL", prev)
		}
	})

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load(): %v", err)
	}
	if cfg.DatabaseURL != "postgres://localhost/from-dotenv" {
		t.Errorf("DatabaseURL = %q, want the .env value", cfg.DatabaseURL)
	}
	if cfg.Port != "6060" {
		t.Errorf("Port = %q, want 6060 from .env", cfg.Port)
	}
}

// TestLoad_RealEnvOverridesDotenv is the other half of the precedence
// guarantee: a real environment variable wins over the same key in .env,
// matching godotenv.Load's non-overriding convention even though this
// package reads .env into a plain map rather than mutating os.Environ.
func TestLoad_RealEnvOverridesDotenv(t *testing.T) {
	path := writeEnvFile(t, "PORT=6060\n")
	withEnv(t, map[string]string{
		"ENV_FILE":     path,
		"CONFIG_FILE":  filepath.Join(t.TempDir(), "does-not-exist.yaml"),
		"PORT":         "5050",
		"DATABASE_URL": "postgres://localhost/test",
	})

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load(): %v", err)
	}
	if cfg.Port != "5050" {
		t.Errorf("Port = %q, want 5050 from the real env var (overriding .env's 6060)", cfg.Port)
	}
}

func TestLoad_MissingDotenvIsNotAnError(t *testing.T) {
	withEnv(t, map[string]string{
		"ENV_FILE":     filepath.Join(t.TempDir(), "does-not-exist.env"),
		"CONFIG_FILE":  filepath.Join(t.TempDir(), "does-not-exist.yaml"),
		"DATABASE_URL": "postgres://localhost/test",
	})

	if _, err := Load(); err != nil {
		t.Fatalf("Load() with no .env file: %v", err)
	}
}

func TestLoad_MalformedDotenvFailsFast(t *testing.T) {
	path := writeEnvFile(t, "this is not valid dotenv syntax \x00\n")
	withEnv(t, map[string]string{
		"ENV_FILE":     path,
		"CONFIG_FILE":  filepath.Join(t.TempDir(), "does-not-exist.yaml"),
		"DATABASE_URL": "postgres://localhost/test",
	})

	if _, err := Load(); err == nil {
		t.Fatal("Load() with a malformed .env file = nil error, want a parse failure")
	}
}
