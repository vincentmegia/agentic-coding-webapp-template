package db

import (
	"net/url"
	"strings"
	"testing"
)

func TestWithStatementTimeouts_MalformedURLErrorNeverIncludesInput(t *testing.T) {
	// A malformed DATABASE_URL is exactly the case (an unencoded special
	// character in the password) most likely to be hit with a real
	// credential in it. net/url's own parse error embeds the offending
	// input string verbatim, and that error string reaches
	// cmd/server's slog.Error on Open's way out — so this locks in that the
	// returned error never contains the input we were asked to parse.
	const secret = "postgres://user:p@ss\x7fword@localhost:5432/app"

	_, err := withStatementTimeouts(secret)
	if err == nil {
		t.Fatal("withStatementTimeouts(malformed URL) returned no error")
	}
	if got := err.Error(); strings.Contains(got, "p@ss") || strings.Contains(got, secret) {
		t.Errorf("error %q leaks the input URL/credential", got)
	}
}

func TestWithStatementTimeouts_ValidURLGetsTimeoutOptions(t *testing.T) {
	dsn, err := withStatementTimeouts("postgres://user:password@localhost:5432/app")
	if err != nil {
		t.Fatalf("withStatementTimeouts: %v", err)
	}

	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("parse resulting dsn %q: %v", dsn, err)
	}
	options := u.Query().Get("options")
	if !strings.Contains(options, "statement_timeout=5000") || !strings.Contains(options, "lock_timeout=2000") {
		t.Errorf("options %q missing expected statement_timeout/lock_timeout", options)
	}
}
