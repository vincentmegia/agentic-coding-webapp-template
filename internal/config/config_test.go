package config

import (
	"os"
	"path/filepath"
	"strings"
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

// TestLoad_LandingAPITokenAbsentDisablesAPI documents the deliberate
// asymmetry with DATABASE_URL: an absent token is valid (the API routes
// simply aren't registered — see cmd/server/main.go's registerLandingAPI),
// whereas an absent DATABASE_URL is a startup error.
func TestLoad_LandingAPITokenAbsentDisablesAPI(t *testing.T) {
	withEnv(t, map[string]string{
		"ENV_FILE":     filepath.Join(t.TempDir(), "does-not-exist.env"),
		"CONFIG_FILE":  filepath.Join(t.TempDir(), "does-not-exist.yaml"),
		"DATABASE_URL": "postgres://localhost/test",
	})
	os.Unsetenv("LANDING_API_TOKEN")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() with no LANDING_API_TOKEN: %v", err)
	}
	if cfg.LandingAPIToken != "" {
		t.Errorf("LandingAPIToken = %q, want empty", cfg.LandingAPIToken)
	}
}

func TestLoad_LandingAPITokenTooShortFailsFast(t *testing.T) {
	withEnv(t, map[string]string{
		"ENV_FILE":          filepath.Join(t.TempDir(), "does-not-exist.env"),
		"CONFIG_FILE":       filepath.Join(t.TempDir(), "does-not-exist.yaml"),
		"DATABASE_URL":      "postgres://localhost/test",
		"LANDING_API_TOKEN": "too-short",
	})

	if _, err := Load(); err == nil {
		t.Error("Load() accepted a LANDING_API_TOKEN below the minimum length")
	}
}

func TestLoad_LandingAPITokenAtMinimumLengthIsAccepted(t *testing.T) {
	token := strings.Repeat("a", landingAPITokenMinLen)
	withEnv(t, map[string]string{
		"ENV_FILE":          filepath.Join(t.TempDir(), "does-not-exist.env"),
		"CONFIG_FILE":       filepath.Join(t.TempDir(), "does-not-exist.yaml"),
		"DATABASE_URL":      "postgres://localhost/test",
		"LANDING_API_TOKEN": token,
	})

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() at the minimum token length: %v", err)
	}
	if cfg.LandingAPIToken != token {
		t.Errorf("LandingAPIToken = %q, want the configured token", cfg.LandingAPIToken)
	}
}

// TestLoad_LandingAPITokenHasNoFileEquivalent guards the secrets rule: the
// token must never be settable from config.yaml, and the strict decoder
// must reject the key outright rather than ignore it.
func TestLoad_LandingAPITokenHasNoFileEquivalent(t *testing.T) {
	path := writeConfigFile(t, "landing_api_token: \"from-file\"\n")
	withEnv(t, map[string]string{
		"ENV_FILE":     filepath.Join(t.TempDir(), "does-not-exist.env"),
		"CONFIG_FILE":  path,
		"DATABASE_URL": "postgres://localhost/test",
	})

	if _, err := Load(); err == nil {
		t.Error("Load() accepted landing_api_token in config.yaml; it must be env-only")
	}
}

// TestLoad_TrustProxyHeadersDefaultsFalse guards the safe-by-default
// posture: a deployment that forgets to set this never accidentally
// starts trusting X-Forwarded-For.
func TestLoad_TrustProxyHeadersDefaultsFalse(t *testing.T) {
	withEnv(t, map[string]string{
		"ENV_FILE":     filepath.Join(t.TempDir(), "does-not-exist.env"),
		"CONFIG_FILE":  filepath.Join(t.TempDir(), "does-not-exist.yaml"),
		"DATABASE_URL": "postgres://localhost/test",
	})

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load(): %v", err)
	}
	if cfg.TrustProxyHeaders {
		t.Error("TrustProxyHeaders = true, want false by default")
	}
}

func TestLoad_TrustProxyHeadersFromFile(t *testing.T) {
	path := writeConfigFile(t, "trust_proxy_headers: true\n")
	withEnv(t, map[string]string{
		"CONFIG_FILE":  path,
		"DATABASE_URL": "postgres://localhost/test",
	})

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load(): %v", err)
	}
	if !cfg.TrustProxyHeaders {
		t.Error("TrustProxyHeaders = false, want true from file")
	}
}

// TestLoad_TrustProxyHeadersEnvOverridesFile mirrors
// TestLoad_EnvOverridesFile's layering guarantee for this field
// specifically.
func TestLoad_TrustProxyHeadersEnvOverridesFile(t *testing.T) {
	path := writeConfigFile(t, "trust_proxy_headers: true\n")
	withEnv(t, map[string]string{
		"CONFIG_FILE":         path,
		"TRUST_PROXY_HEADERS": "false",
		"DATABASE_URL":        "postgres://localhost/test",
	})

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load(): %v", err)
	}
	if cfg.TrustProxyHeaders {
		t.Error("TrustProxyHeaders = true, want false from env (overriding file's true)")
	}
}

func TestLoad_TrustProxyHeadersInvalidValueFailsFast(t *testing.T) {
	withEnv(t, map[string]string{
		"ENV_FILE":            filepath.Join(t.TempDir(), "does-not-exist.env"),
		"CONFIG_FILE":         filepath.Join(t.TempDir(), "does-not-exist.yaml"),
		"DATABASE_URL":        "postgres://localhost/test",
		"TRUST_PROXY_HEADERS": "yes-please",
	})

	if _, err := Load(); err == nil {
		t.Error("Load() accepted TRUST_PROXY_HEADERS=yes-please; want an error for a non-boolean value")
	}
}

// TestLoad_LTABaseURL covers docs/features/bus-stop-finder.md's rule that
// the LTA AccountKey only travels over TLS, except to the local fake.
func TestLoad_LTABaseURL(t *testing.T) {
	cases := []struct {
		name    string
		value   string // "" = unset
		want    string
		wantErr bool
	}{
		{name: "default", value: "", want: defaultLTABaseURL},
		{name: "https origin", value: "https://example.test", want: "https://example.test"},
		{name: "localhost fake", value: "http://localhost:8099", want: "http://localhost:8099"},
		{name: "loopback fake", value: "http://127.0.0.1:8099", want: "http://127.0.0.1:8099"},
		{name: "plain http elsewhere", value: "http://datamall2.mytransport.sg", wantErr: true},
		{name: "other scheme", value: "ftp://example.test", wantErr: true},
		{name: "path not allowed", value: "https://example.test/ltaodataservice", wantErr: true},
		{name: "credentials not allowed", value: "https://user:pw@example.test", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			kv := map[string]string{
				"ENV_FILE":     filepath.Join(t.TempDir(), "does-not-exist.env"),
				"CONFIG_FILE":  filepath.Join(t.TempDir(), "does-not-exist.yaml"),
				"DATABASE_URL": "postgres://localhost/test",
			}
			if tc.value != "" {
				kv["LTA_BASE_URL"] = tc.value
			}
			withEnv(t, kv)
			if tc.value == "" {
				os.Unsetenv("LTA_BASE_URL")
			}

			cfg, err := Load()
			if tc.wantErr {
				if err == nil {
					t.Fatalf("Load() accepted LTA_BASE_URL %q", tc.value)
				}
				return
			}
			if err != nil {
				t.Fatalf("Load(): %v", err)
			}
			if cfg.LTABaseURL != tc.want {
				t.Errorf("LTABaseURL = %q, want %q", cfg.LTABaseURL, tc.want)
			}
		})
	}
}

// TestLoad_BusStopKeysAreOptional: neither key is required to start — the
// page degrades to list-only / arrivals-unavailable instead.
func TestLoad_BusStopKeysAreOptional(t *testing.T) {
	withEnv(t, map[string]string{
		"ENV_FILE":     filepath.Join(t.TempDir(), "does-not-exist.env"),
		"CONFIG_FILE":  filepath.Join(t.TempDir(), "does-not-exist.yaml"),
		"DATABASE_URL": "postgres://localhost/test",
	})
	os.Unsetenv("LTA_ACCOUNT_KEY")
	os.Unsetenv("GOOGLE_MAPS_API_KEY")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() without bus stop keys: %v", err)
	}
	if cfg.LTAAccountKey != "" || cfg.GoogleMapsAPIKey != "" {
		t.Errorf("keys = %q/%q, want both empty", cfg.LTAAccountKey, cfg.GoogleMapsAPIKey)
	}
}

// TestLoad_LTAAccountKeyHasNoFileEquivalent guards the secrets rule.
func TestLoad_LTAAccountKeyHasNoFileEquivalent(t *testing.T) {
	path := writeConfigFile(t, "lta_account_key: \"from-file\"\n")
	withEnv(t, map[string]string{
		"ENV_FILE":     filepath.Join(t.TempDir(), "does-not-exist.env"),
		"CONFIG_FILE":  path,
		"DATABASE_URL": "postgres://localhost/test",
	})
	if _, err := Load(); err == nil {
		t.Error("Load() accepted lta_account_key from config.yaml")
	}
}

func TestLoad_OneMapBaseURL(t *testing.T) {
	base := map[string]string{
		"ENV_FILE":     filepath.Join(t.TempDir(), "does-not-exist.env"),
		"CONFIG_FILE":  filepath.Join(t.TempDir(), "does-not-exist.yaml"),
		"DATABASE_URL": "postgres://localhost/test",
	}
	withEnv(t, base)
	os.Unsetenv("ONEMAP_BASE_URL")
	cfg, err := Load()
	if err != nil || cfg.OneMapBaseURL != defaultOneMapBaseURL {
		t.Fatalf("default: %q, %v", cfg.OneMapBaseURL, err)
	}
	withEnv(t, map[string]string{"ONEMAP_BASE_URL": "http://127.0.0.1:8099"})
	if cfg, err := Load(); err != nil || cfg.OneMapBaseURL != "http://127.0.0.1:8099" {
		t.Fatalf("localhost fake: %q, %v", cfg.OneMapBaseURL, err)
	}
	withEnv(t, map[string]string{"ONEMAP_BASE_URL": "http://www.onemap.gov.sg"})
	if _, err := Load(); err == nil {
		t.Fatal("accepted plain-http ONEMAP_BASE_URL")
	}
}
