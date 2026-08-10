# Go Backend Skill

## Purpose

Build reliable, idiomatic, maintainable Go backend services.

This skill defines general backend engineering practices.

Feature-specific behavior belongs in:

```text
docs/features/
```

---

## Core Principles

Prioritize:

1. Simplicity
2. Correctness
3. Explicit behavior
4. Small, focused components
5. Testability
6. Observability
7. Security
8. Maintainability

Prefer the standard library unless a dependency provides significant value.

Do not introduce abstractions without a concrete reason.

---

## Project Structure

Prefer a simple structure:

```text
cmd/
└── server/
    └── main.go

internal/
├── handler/
├── service/
├── repository/
├── model/
└── config/

web/
├── templates/
└── static/
```

Keep package responsibilities clear.

### Handler

Responsible for:

* HTTP request parsing
* Authentication/authorization checks
* Input validation
* Calling services
* HTTP response rendering

### Service

Responsible for:

* Business logic
* Application workflows
* Validation that depends on business rules
* Coordinating repositories and external services

### Configuration
* Reading structured, non-secret defaults from an optional `.yaml` file
* Parsing and overlaying configuration from environment variables (secrets
  and per-deployment overrides — always take precedence over the file)
* Validating configuration, failing fast on missing/invalid required values

See the "Configuration" section below for the full file/env layering
convention.

### Repository

Responsible for:

* Database access
* Persistence queries
* Mapping database records

Do not put business logic in repositories.

---

## Routing

Prefer the standard library `net/http.ServeMux`. Since Go 1.22 it supports method
matching and wildcard path segments, which covers most routing needs without a
third-party dependency:

```go
mux := http.NewServeMux()
mux.HandleFunc("GET /devices/{id}", h.Get)
mux.HandleFunc("POST /devices/{id}/wake", h.Wake)
```

Only introduce a router dependency (e.g. `chi`) when a concrete requirement
exceeds what `ServeMux` provides (complex middleware composition, sub-routers).
Do not add one preemptively.

---

## HTTP Server Configuration

`http.Server` has no timeouts by default — an unconfigured server is vulnerable to
slow-client resource exhaustion (Slowloris-style). Always set explicit timeouts:

```go
srv := &http.Server{
    Addr:              addr,
    Handler:           mux,
    ReadHeaderTimeout: 5 * time.Second,
    ReadTimeout:       10 * time.Second,
    WriteTimeout:      10 * time.Second,
    IdleTimeout:       120 * time.Second,
}
```

Adjust `WriteTimeout` upward for endpoints that legitimately stream long responses.

---

## Middleware

Compose cross-cutting concerns as middleware rather than repeating them in every
handler. At minimum:

* **Recover** — catch panics so one handler failure doesn't crash the process.
* **Request ID** — generate/propagate an ID for correlating logs across a request.
* **Logging** — log method, path, status, duration for every request.
* **Timeout** — bound handler execution via `http.TimeoutHandler` or context deadline.

```go
func Recover(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        defer func() {
            if err := recover(); err != nil {
                slog.Error("panic recovered", "error", err)
                http.Error(w, "internal server error", http.StatusInternalServerError)
            }
        }()
        next.ServeHTTP(w, r)
    })
}
```

Order middleware deliberately (recover outermost, then request ID, then logging).

---

## Security Headers

Set response security headers on every response, not per-handler:

```text
Content-Security-Policy
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Strict-Transport-Security: max-age=63072000; includeSubDomains
```

This matters more than usual here because HTMX swaps server-rendered HTML directly
into the DOM — a strict CSP is a meaningful defense-in-depth layer against XSS,
alongside the escaping already required in `htmx-ui`.

---

## Health Checks

Expose a lightweight, unauthenticated health endpoint:

```text
GET /healthz  → 200 once the process can serve traffic (and, ideally, can reach the database)
```

Hosting platforms (Render, Fly.io) use this for process supervision and zero-downtime
deploys. Keep it fast and dependency-light — it should not itself become a source of
cascading failure.

---

## HTTP

Use standard HTTP semantics.

```text
GET     → read
POST    → create/action
PUT     → replace
PATCH   → partial update
DELETE  → delete
```

Use appropriate HTTP status codes.

Examples:

```text
200 OK
201 Created
204 No Content
400 Bad Request
401 Unauthorized
403 Forbidden
404 Not Found
409 Conflict
422 Unprocessable Entity
500 Internal Server Error
```

Do not return `200 OK` for every outcome.

---

## Handlers

Keep handlers small.

Prefer:

```go
func (h *DeviceHandler) Wake(w http.ResponseWriter, r *http.Request) {
    deviceID, err := parseDeviceID(r)
    if err != nil {
        http.Error(w, "invalid device", http.StatusBadRequest)
        return
    }

    if err := h.service.Wake(r.Context(), deviceID); err != nil {
        h.renderError(w, err)
        return
    }

    h.renderDevice(w, deviceID)
}
```

Avoid putting business logic directly inside HTTP handlers.

---

## Context

Always propagate request context through application layers.

Prefer:

```go
service.Wake(ctx, deviceID)
```

rather than creating new background contexts unnecessarily.

Use context for:

* Cancellation
* Deadlines
* Request-scoped values where appropriate

Do not use context as a general-purpose parameter bag.

---

## Errors

Handle errors explicitly.

Prefer wrapping errors with useful context:

```go
return fmt.Errorf("wake device %d: %w", deviceID, err)
```

Use sentinel or typed errors when callers need to distinguish error conditions.

For example:

```go
var ErrDeviceNotFound = errors.New("device not found")
```

Do not expose internal errors directly to users.

Map internal errors to appropriate HTTP responses.

---

## Validation

Validate input at system boundaries.

Examples:

* HTTP requests
* Database input
* External API responses
* Configuration

Do not rely exclusively on frontend validation.

Frontend validation improves UX.

Backend validation provides correctness and security.

---

## Concurrency

Use goroutines only when they provide a clear benefit.

Always consider:

* Cancellation
* Error propagation
* Resource lifetime
* Data races
* Goroutine leaks

Prefer structured concurrency patterns.

Do not create background goroutines from request handlers without understanding their lifecycle.

---

## External Commands

Device-management features may require OS commands.

Never pass arbitrary user input directly to command execution.

Bad:

```go
exec.Command("shutdown", userInput)
```

Prefer controlled arguments derived from validated configuration:

```go
exec.CommandContext(
    ctx,
    "shutdown",
    "/s",
    "/t",
    "0",
)
```

Command execution must be:

* Explicit
* Auditable
* Validated
* Timeout-aware
* Error-checked

Never expose arbitrary command execution through an HTTP API.

---

## Configuration

Use a layered approach: a YAML file for structured, non-secret settings, a
`.env` file for local-dev secrets, and real environment variables for
everything in production. This is standard practice for Go services (the
same layering popular libraries like Viper implement) without pulling in a
large configuration framework — a small YAML library, a small dotenv
library, and `internal/config`'s own merge logic covers it.

Precedence, lowest to highest:

1. Defaults hard-coded in `internal/config`.
2. Values from the YAML file, if present.
3. Values from `.env`, if present.
4. Real environment variables (however they're set — shell export,
   `docker run -e`, a hosting platform's own config) — always win, even
   over a value `.env` also sets.

```yaml
# config.yaml — structural, non-secret settings only
port: "8080"
log_level: INFO
db:
  max_open_conns: 10
```

```dotenv
# .env — secrets and anything else you'd rather not export by hand locally
DATABASE_URL=postgres://user:password@localhost:5432/app
```

Both files are entirely optional and independently gitignored: a missing
file is not an error, since real environment variables alone must remain
sufficient to run the app (e.g. in a container with no file mounted).
`.env` does not get loaded into the real process environment (no
`os.Setenv`) — it's read into a plain map that only gets consulted when a
key isn't already set in the real environment, so a real env var can never
be silently shadowed by a stray `.env` file. Each file's own path is itself
configurable via an environment variable (`CONFIG_FILE`, defaulting to
`config.yaml`; `ENV_FILE`, defaulting to `.env`) — `ENV_FILE` must be a raw
environment variable, since resolving it *from* `.env` would be circular.

Check in a `config.example.yaml` and an `.env.example` documenting the
available keys in each; the real `config.yaml`/`.env` a deployment actually
uses are both gitignored.

**Never put secrets in the YAML file** — it may be committed to version
control or baked into a container image. `config.yaml` has no key for a
secret at all (not even absent-by-convention — the loader shouldn't
recognize a `database_url` YAML key in the first place, so one can't
accidentally end up there); `.env` is the file that's allowed to hold them,
precisely because it's understood project-wide as the one that's never
committed.

What belongs in the YAML file (non-secret, structural):

```text
port
log_level
db.max_open_conns
```

What belongs in `.env` or a real environment variable (secrets,
per-deployment endpoints):

```text
DATABASE_URL
```

Do not hard-code:

* Passwords
* API keys
* Tokens
* Private keys
* Production endpoints

Fail fast when required configuration is missing or invalid — whether that
requirement is unmet by the YAML file, `.env`, the real environment, or all
three.

Use small, well-maintained libraries rather than hand-rolling parsers — the
standard library has no YAML or dotenv support, so this is a case where a
dependency provides concrete value: `gopkg.in/yaml.v3` for the YAML file,
`github.com/joho/godotenv` for `.env` — specifically its `Read` function,
which parses into a plain map, not `Load`, which would mutate the real
process environment via `os.Setenv` and undermine the "real env always
wins, `.env` is never silently shadowed" guarantee above.

---

## Logging

Use structured logging where practical.

Log useful operational information:

```text
timestamp
level
operation
request_id
device_id
result
error
duration
```

Do not log:

* Passwords
* Tokens
* API keys
* Session secrets
* Sensitive personal data

Use appropriate log levels:

```text
DEBUG
INFO
WARN
ERROR
```

---

## Testing

Test behavior, not implementation details.

Prioritize:

* Services
* Validation
* Critical handlers
* Device operations
* Error handling

Use table-driven tests where they improve clarity.

Example:

```go
func TestValidateDevice(t *testing.T) {
    tests := []struct {
        name    string
        input   Device
        wantErr bool
    }{
        // ...
    }

    // ...
}
```

Use dependency injection where it makes external operations testable.

Do not introduce a dependency-injection framework.

---

## Database Access

Database access belongs in repositories.

Use parameterized queries.

Never construct SQL using string concatenation with user input.

Prefer:

```go
db.QueryContext(
    ctx,
    `SELECT id, name FROM devices WHERE id = $1`,
    id,
)
```

---

## Graceful Shutdown

The HTTP server should support graceful shutdown.

On shutdown:

1. Stop accepting new requests.
2. Allow active requests to complete.
3. Close resources.
4. Exit cleanly.

Database connections and other long-lived resources must be closed appropriately.

---

## Code Quality

Before completing backend changes, run:

```bash
make check
```

which wraps the underlying commands (see the `Makefile` at the repo root —
`make help` lists every target, including `run`/`dev` for local development
and `css`/`css-watch` for the Tailwind build):

```bash
gofmt -w .
go test ./...
go vet ./...
```

If the project has additional linting configured, run it.

Keep functions and packages focused.

Avoid premature abstractions.

---

## Definition of Done

Backend work is complete when:

* Behavior is correct.
* Errors are handled.
* Input is validated.
* Security concerns are addressed, including response security headers.
* `http.Server` has explicit timeouts configured.
* A panic in one handler cannot take down the process.
* Tests cover important behavior.
* Context cancellation is respected where relevant.
* Logs provide sufficient operational visibility.
* Code is formatted.
* `go test ./...` passes.
* `go vet ./...` passes.

