// Package db constructs the application's single Postgres connection pool.
// Uses database/sql with the pgx driver, not pgx's native pool API, per
// docs/skills/postgres/SKILL.md "Query Layer".
package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

// Open connects to Postgres and verifies connectivity before returning,
// per docs/skills/go-backend/SKILL.md "Fail fast when required
// configuration is missing" — an unreachable database should fail server
// startup, not surface as the first request's error.
//
// statement_timeout/lock_timeout are set per docs/skills/postgres/SKILL.md
// "Timeouts" via the connection string's libpq "options" parameter, so
// every connection in the pool carries them without a per-query round trip.
func Open(ctx context.Context, databaseURL string, maxOpenConns int) (*sql.DB, error) {
	dsn, err := withStatementTimeouts(databaseURL)
	if err != nil {
		return nil, err
	}

	conn, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}

	conn.SetMaxOpenConns(maxOpenConns)
	conn.SetMaxIdleConns(maxOpenConns / 2)
	conn.SetConnMaxLifetime(time.Hour)
	conn.SetConnMaxIdleTime(30 * time.Minute)

	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := conn.PingContext(pingCtx); err != nil {
		conn.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}

	return conn, nil
}

// withStatementTimeouts appends libpq's "options" parameter to set
// statement_timeout (5s) and lock_timeout (2s) for every connection pgx
// opens, per docs/skills/postgres/SKILL.md "Timeouts": a database-level
// guardrail independent of whether application code remembers to cancel
// its context.
func withStatementTimeouts(databaseURL string) (string, error) {
	u, err := url.Parse(databaseURL)
	if err != nil {
		// Deliberately not %w-wrapping err: a net/url parse error embeds
		// the full offending input — including the DATABASE_URL password —
		// verbatim in its Error() string, and that string reaches
		// cmd/server's slog.Error("server exited with error", ...) on the
		// way out of Open. A malformed URL is exactly the case (an
		// unencoded special character in the password) most likely to
		// trigger this path, so the one detail worth logging here is that
		// parsing failed at all, never the string that failed to parse.
		return "", errors.New("parse database url: malformed URL")
	}
	q := u.Query()
	q.Set("options", "-c statement_timeout=5000 -c lock_timeout=2000")
	u.RawQuery = q.Encode()
	return u.String(), nil
}
