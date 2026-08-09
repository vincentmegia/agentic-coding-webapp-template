# PostgreSQL Skill

## Purpose

Design and operate reliable PostgreSQL persistence for the application.

Feature-specific data requirements belong in:

```text
docs/features/
```

---

## Core Principles

Prioritize:

1. Data integrity
2. Correctness
3. Simplicity
4. Query performance
5. Maintainability
6. Safe migrations
7. Security

Prefer PostgreSQL constraints over relying exclusively on application logic.

---

## Schema Design

Use clear, explicit schemas.

Prefer:

```sql
CREATE TABLE devices (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    hostname TEXT,
    ip_address INET,
    mac_address MACADDR,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Use appropriate PostgreSQL types.

Prefer:

```text
TIMESTAMPTZ
INET
MACADDR
BOOLEAN
INTEGER / BIGINT
NUMERIC
JSONB
```

when appropriate.

Do not store structured data as arbitrary strings when PostgreSQL has a suitable type.

---

## Primary Keys

Use stable primary keys.

For most internal entities:

```sql
id BIGSERIAL PRIMARY KEY
```

or an appropriate UUID strategy when distributed identity requires it.

Do not expose database implementation details unnecessarily through APIs.

---

## Constraints

Use database constraints for invariants.

Examples:

```sql
NOT NULL
UNIQUE
CHECK
FOREIGN KEY
```

Example:

```sql
CONSTRAINT devices_name_unique UNIQUE (name)
```

The database should protect data integrity even if application code contains a bug.

---

## Foreign Keys

Use foreign keys when relationships require referential integrity.

Choose deletion behavior deliberately.

Examples:

```sql
ON DELETE CASCADE
ON DELETE RESTRICT
ON DELETE SET NULL
```

Do not automatically use `CASCADE`.

Consider the business impact of deleting related data.

---

## Indexes

Create indexes based on actual query patterns.

Good candidates include:

* Foreign keys frequently used for lookup
* Frequently filtered columns
* Frequently sorted columns
* Unique business identifiers

Do not create indexes on every column.

Indexes have:

* Storage cost
* Write cost
* Maintenance cost

Use `EXPLAIN` / `EXPLAIN ANALYZE` when investigating query performance.

---

## Queries

Always use parameterized queries.

Good:

```sql
SELECT id, name
FROM devices
WHERE id = $1;
```

Bad:

```go
query := "SELECT * FROM devices WHERE id = " + id
```

Avoid:

```sql
SELECT *
```

when only specific columns are required.

Select only the data needed by the application.

---

## Query Layer

Use `database/sql` with the [`pgx`](https://github.com/jackc/pgx) driver as the
default. Do not introduce a full ORM (e.g. GORM) — it hides the SQL that
repositories are responsible for and encourages N+1 query patterns.

If hand-written scanning (`rows.Scan(...)`) becomes repetitive and error-prone,
introduce [`sqlc`](https://sqlc.dev) to generate typed Go from SQL — it keeps SQL
as the source of truth while removing boilerplate, rather than adding a query
abstraction layer.

Watch for N+1 queries: fetching a list, then issuing one additional query per row
in a loop. Prefer a single query with a `JOIN` or `= ANY($1)` batch lookup.

---

## Naming Conventions

Use `snake_case` for tables and columns. Use plural table names
(`devices`, not `device`) and singular column names.

```text
devices                        table
devices.id                     primary key
devices.status                 column
devices_name_unique            unique constraint  (<table>_<col>_<kind>)
idx_devices_status              index              (idx_<table>_<col>)
devices_owner_id_fkey           foreign key        (<table>_<col>_fkey)
```

Consistent naming makes constraint/index names predictable in migrations and error
messages, rather than invented ad hoc per migration.

---

## Transactions

Use transactions when multiple operations must succeed or fail together.

Example:

```text
BEGIN
  update device
  insert audit record
COMMIT
```

If any operation fails:

```text
ROLLBACK
```

Keep transactions short.

Do not perform slow external network calls inside database transactions unless there is a compelling reason.

---

## Migrations

Every schema change should be represented by a migration.

Use [`goose`](https://github.com/pressly/goose) to manage migrations: plain
`.sql` files with `-- +goose Up` / `-- +goose Down` sections, a single CLI, and no
ORM dependency — consistent with this project's "prefer the standard library"
principle in `go-backend`.

Example:

```text
migrations/
├── 001_create_devices.sql
├── 002_add_device_status.sql
├── 003_create_audit_log.sql
└── ...
```

```sql
-- +goose Up
ALTER TABLE devices ADD COLUMN status TEXT NOT NULL DEFAULT 'unknown';

-- +goose Down
ALTER TABLE devices DROP COLUMN status;
```

Every migration must include a working `Down` — untested rollback paths are not a
real rollback path.

Migrations should be:

* Ordered
* Repeatable in deployment
* Reviewed
* Tested

Do not modify an already-applied migration to change production history.

Create a new migration instead.

---

## Safe Schema Changes

Prefer backward-compatible changes where possible.

For example, when adding a required field to a large existing table:

1. Add the nullable column.
2. Deploy application support.
3. Backfill data.
4. Add constraints.
5. Remove compatibility code later.

Avoid large blocking migrations during production traffic.

---

## Timestamps

Prefer:

```sql
TIMESTAMPTZ
```

for timestamps.

Store timestamps consistently in UTC.

Convert to local timezone at the presentation layer.

---

## Soft Deletes

Do not automatically use soft deletes.

Use them only when there is a real requirement for:

* Auditability
* Recovery
* Historical records
* Regulatory requirements

If soft deletes are required, establish a consistent pattern.

---

## Audit History

Important device operations may require audit records.

For example:

```text
device_id
operation
requested_by
status
created_at
error
```

This is particularly important for actions such as:

```text
Wake
Shutdown
Restart
Delete
Configuration changes
```

Do not store sensitive credentials in audit logs.

---

## Connection Management

Use a PostgreSQL connection pool.

Configure:

* Maximum connections
* Minimum idle connections
* Connection lifetime
* Connection timeout

Do not create a new database connection for every request.

---

## Timeouts

Database operations should use request context and appropriate timeouts.

Avoid indefinitely waiting for a database operation.

In addition to application-level context timeouts, set database-level guardrails so
a runaway query or an unreleased lock can't stall the whole application:

```sql
SET statement_timeout = '5s';
SET lock_timeout = '2s';
```

Configure these per role or per connection pool rather than relying solely on the
application remembering to cancel its context.

---

## Backup & Recovery

Production data must have automated backups, regardless of provider (Neon,
Supabase, or self-hosted).

At minimum:

* Automated daily backups with a defined retention period.
* Point-in-time recovery (PITR) if the provider supports it — most managed
  Postgres providers do.
* Periodically test an actual restore. An untested backup is not a verified backup.

---

## Security

Use:

* Least-privilege database users
* TLS where required
* Secret management
* Parameterized queries

Do not use a superuser account for the application.

Never commit database credentials.

---

## Testing

Database behavior should be tested for important functionality.

Test:

* Constraints
* Transactions
* Queries
* Migrations
* Error conditions

Use isolated test databases where practical.

Do not rely exclusively on mocks for database-heavy functionality.

---

## Performance

When investigating performance:

1. Identify the actual slow query.
2. Measure it.
3. Inspect the query plan.
4. Check indexes.
5. Check cardinality.
6. Optimize.
7. Measure again.

Do not optimize database queries based solely on assumptions.

---

## Definition of Done

Database work is complete when:

* Schema is normalized appropriately.
* Naming follows the project's table/column/constraint conventions.
* Constraints protect important invariants.
* Queries are parameterized and free of N+1 patterns.
* Migrations are included via `goose`, with a working `Down`.
* Transactions are used where required.
* Appropriate indexes exist.
* Statement/lock timeouts are set for the connection role.
* Backups exist and restores have been verified at least once.
* Security requirements are met.
* Important database behavior is tested.
* Performance has been considered.

