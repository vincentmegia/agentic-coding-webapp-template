# Feature: Landing Content Internal API

## Status

`In Progress` — design approved and the site side is implemented; the
change is **not yet complete end to end**. Written in response to a
security decision made while working on `home-admin` ("HQ"), the separate
private admin dashboard that edits this site's landing-page content.

Implemented here: the prep refactor, all fourteen endpoints, bearer-token
auth with rate limiting, and tests (handler/auth/config tests run without a
database; the round-trip case is in the DB-gated
`cmd/server/e2e_test.go`).

**Hosting changed since this was written, and it changes what "done" means
here.** The database has since moved off Render entirely, onto Supabase
(session pooler), for cost reasons — the web service stays on Render, but
the two are no longer on the same infrastructure. The original plan below
assumed the opposite: that this site's own database connection would move
to *Render's* internal, private-network-only URL, making the database
unreachable from the public internet regardless of what HQ did. That
option never existed for a database hosted outside Render, so it is now
permanently off the table, not just delayed — see Problem/Motivation and
Decision 1 below for the corrected reasoning and Open Questions'
downgraded, but still real, security goal.

Still outstanding:

* Not yet verified against a real Postgres instance or a live HQ.
* `LANDING_API_TOKEN` not yet set on both sides.
* HQ's own side (dropping its direct `landing_*` queries, relocating its
  workflow tables) is in progress separately.

Until HQ actually stops using its own direct database credentials, this
API is additive rather than protective — that part of the original
reasoning still holds. What no longer holds is any expectation that
finishing this makes the database itself unreachable from the internet;
see Problem/Motivation.

## Summary

Exposes a small, token-authenticated JSON API on this site's existing web
service, covering exactly the three landing-content tables
(`landing_hero`, `landing_carousel_slides`,
`landing_selected_work_items`), so HQ can edit homepage content over HTTP
instead of connecting to this site's Postgres database directly. That in
turn gets HQ off holding direct database credentials entirely — the
database (now Supabase, not Render — see Status) is reachable from the
internet either way, so this API's value is reducing who and what can
reach it with full SQL access, not making it unreachable.

## Problem / Motivation

HQ currently reads and writes the three `landing_*` tables with its own SQL
(`internal/repository/landing.go` in that repo), using the database's
**external** Postgres connection string — protected only by password + TLS.
An IP-allowlist isn't usable here because HQ runs on Vincent's home network
behind a dynamic IP. So a database that HQ's docs had assumed was
LAN-isolated is in fact internet-reachable by design, and its only defense
is a password.

**This is where the original plan changed.** The idea behind this feature
was that moving HQ onto an HTTP API would let this site switch to Render's
*internal* database URL — reachable only from services inside the same
Render private network — removing the database from the public internet
entirely. That depended on the database being hosted on Render alongside
the web service. It has since moved to Supabase for cost reasons (see
Status), and Supabase has no equivalent "same private network as this
site's Render service" tier: every connection to it, from this site's own
backend or from HQ, is an external, internet-facing connection secured by
TLS and a password (Supabase's session pooler), the same shape of
connection HQ was already using. So finishing this feature does not make
the database unreachable from the internet — that outcome isn't available
on the current hosting, full stop, not something blocked on HQ's migration.

**Be precise about what this buys, revised.** This does not make anything
private — the database is internet-reachable regardless, and this site's
own web service still has a public `*.onrender.com` URL that these API
routes live on, so the write path is internet-reachable and a bearer token
is the only thing guarding it. What this feature actually buys is getting
HQ off holding a full-access database password at all, and replacing
arbitrary SQL with a substantially smaller and better-shaped attack
surface:

* No raw SQL and no Postgres wire protocol exposed — only six resource
  shapes with fixed, validated fields.
* Compromise of the token grants "edit three content tables," not
  "arbitrary SQL as the database owner" (which today includes `users`).
* The token is revocable and rotatable in Render's dashboard without a
  database credential rotation.
* Every mutation is logged with a request ID by existing middleware, so
  content changes become auditable; direct DB writes are not.
* Application-layer invariants (the 5-slide cap, required-field validation,
  `sort_order` integrity) become unbypassable — see Business Rules, where
  today's direct-DB access can already silently violate them.

A secondary benefit: this closes a real correctness gap, not just a security
one. The 5-slide carousel cap lives in Go
(`service.maxCarouselSlides`), not in a database constraint — so HQ writing
directly to Postgres can create a sixth slide today, which the site would
then render.

**A deferred option, not a commitment**: Supabase's Network Restrictions
(an IP allowlist, available on paid plans) combined with Render's static
outbound IPs (also a paid feature) could eventually narrow the database's
reachability to "this site's Render service plus Supabase's own access,"
which is the closest available equivalent to the original private-network
idea. This isn't in scope now — it costs money on both ends, which is the
same constraint that moved the database off Render in the first place —
but it's worth naming so a future reader doesn't have to rediscover that
the option exists.

## Scope

**In scope:**

* JSON endpoints for the three `landing_*` tables: hero (read/replace),
  carousel slides and Selected work items (list/get/create/update/delete/
  reorder).
* Bearer-token authentication for machine callers, separate from the
  session-based `IsAuthenticated` path used by human visitors.
* Reuse of the existing `LandingContentService` so HQ and this site's own
  `/settings/content` editor share one validation path (requires a small
  refactor — see Implementation Notes).
* New routes on the **existing** web service — no new Render deploy, no new
  binary, no separate process.

**Out of scope:**

* **Any generic or raw-SQL endpoint.** Only these three resources.
* **HQ's own tables** (`content_change_requests`,
  `content_change_request_comments`) and the shared `users` table — see
  Open Questions, which argues these should be resolved a different way
  rather than by adding endpoints here.
* **HQ's review workflow.** Submit → approve → apply stays entirely in HQ.
  This API's write endpoints are the "apply now" moment only; they have no
  concept of a pending or unapproved change.
* **Image upload.** Slides still reference an image by path/URL, same as
  `docs/features/landing-content-authoring.md`.
* **Multi-tenant auth, per-user tokens, OAuth, scopes.** There is exactly
  one trusted caller.
* **Public read access.** These endpoints are for HQ, not for the site's own
  page rendering, which continues to go through
  `LandingContentService.GetPublicView` in-process.

---

## User Flow

There is no human UI here. The flow is machine-to-machine:

```text
1. A human approver approves a pending change in HQ's existing review
   workflow.
2. HQ applies it: issues the corresponding API request to this site,
   with `Authorization: Bearer <token>`.
3. This site validates the token, validates the payload through the same
   service the site's own editor uses, and writes to Postgres over
   Supabase's session-pooler connection (TLS-protected, not
   network-isolated — see Problem/Motivation).
4. This site returns the resulting resource as JSON; HQ records the
   change as applied.
5. The next load of `/` renders the new content.
```

---

## Auth

**Mechanism**: a single shared secret sent as `Authorization: Bearer <token>`.

Rationale for a bearer token over the alternatives, given exactly one
trusted caller: mTLS would mean managing a CA and client certs for one
client; signed requests (HMAC over body + timestamp) add replay protection
that TLS already largely provides here; OAuth/JWT adds an issuer and
expiry machinery with no second party to justify it. A static bearer token
over TLS is the proportionate choice, provided the details below are
honored.

**Requirements**:

* Config key `LANDING_API_TOKEN`, sourced from a real environment variable
  or `.env` **only** — never `config.yaml`. This follows the existing
  `DATABASE_URL` precedent; `fileConfig`'s strict decoding
  (`dec.KnownFields(true)`) would reject the key anyway, which is the
  intended behavior.
* Compared with `crypto/subtle.ConstantTimeCompare`, never `==`, to avoid
  leaking the token through response timing.
* Minimum length validated at startup (suggest ≥ 32 chars, generated from
  a CSPRNG). Fail fast on a set-but-too-short token, consistent with how
  `config.Load` already treats a present-but-invalid value.
* **Optional, and the API is disabled when it's absent.** If
  `LANDING_API_TOKEN` is unset, the API routes are not registered at all
  and a warning is logged at startup. This keeps "environment variables
  alone must remain sufficient to run the app" true, keeps local dev and
  the existing DB-gated e2e test working untouched, and means a
  misconfigured deploy fails closed (404) rather than open.
* **Must not reuse `requireOwnerAuth`.** That helper 302-redirects to
  `/login`, which is correct for a browser and wrong for an API client — a
  redirect would be silently followed and produce a confusing non-JSON
  response. API auth failures return `401` with a JSON body and no
  redirect.
* Rate-limit failed auth attempts per source IP to blunt brute force. The
  existing `scoreSubmitLimiter` in `internal/handler/fishing_game.go` is
  the pattern to follow (in-memory, fixed window, single-process).
  "Source IP" is resolved via `internal/middleware.ClientKey`, not a raw
  `r.RemoteAddr` read — see that function's doc comment and
  `config.Config.TrustProxyHeaders`. On Render (where this API actually
  runs), `r.RemoteAddr` is the platform's own reverse proxy, not the
  caller, for every request — so without that resolution every anonymous
  caller shares one failure budget, and ten bad tokens from anyone 429s
  HQ's own legitimate calls for the rest of the window. This was caught
  and fixed before the API's first real deployment (its Render
  reconfiguration, `TRUST_PROXY_HEADERS=true` there specifically, was
  still outstanding at the time).
* Never log the token, in full or in part. Log auth failures with the
  request ID and source only.

**CSRF is not applicable** to these routes, and that's a genuine
improvement over the cookie-session model: a bearer token is not
automatically attached by browsers to cross-site requests, so the CSRF gap
documented in `PagesHandler.Logout` and the game score endpoints does not
extend here.

---

## Routes / Handlers

Base path `/api/internal/v1/landing`. "internal" names the intended
audience (one trusted service, not the public web) even though the route is
technically internet-reachable; `v1` leaves room to change shapes without
breaking a deployed HQ.

All routes require the bearer token. All requests and responses are
`application/json`.

| Method | Path                          | Handler                       | Success | Notes |
| ------ | ----------------------------- | ----------------------------- | ------- | ----- |
| GET    | `/hero`                       | `LandingAPIHandler.GetHero`     | 200 | Singleton; always exists (seeded by migration 005). |
| PUT    | `/hero`                       | `LandingAPIHandler.PutHero`     | 200 | Replaces all three fields. No POST/DELETE — the row is a `CHECK (id = 1)` singleton. |
| GET    | `/carousel`                   | `LandingAPIHandler.ListSlides`  | 200 | Ordered by `sort_order`. |
| GET    | `/carousel/{id}`              | `LandingAPIHandler.GetSlide`    | 200 | 404 if unknown. |
| POST   | `/carousel`                   | `LandingAPIHandler.CreateSlide` | 201 | `Location` header. 409 at the 5-slide cap. |
| PUT    | `/carousel/{id}`              | `LandingAPIHandler.UpdateSlide` | 200 | Content fields only — see Decision 2. |
| DELETE | `/carousel/{id}`              | `LandingAPIHandler.DeleteSlide` | 204 | 404 if unknown. |
| PUT    | `/carousel/order`             | `LandingAPIHandler.ReorderSlides` | 200 | Full ordered ID list — see Decision 2. |
| GET    | `/selected-work`              | `LandingAPIHandler.ListWorkItems` | 200 | Ordered by `sort_order`. |
| GET    | `/selected-work/{id}`         | `LandingAPIHandler.GetWorkItem` | 200 | |
| POST   | `/selected-work`              | `LandingAPIHandler.CreateWorkItem` | 201 | No cap. |
| PUT    | `/selected-work/{id}`         | `LandingAPIHandler.UpdateWorkItem` | 200 | |
| DELETE | `/selected-work/{id}`         | `LandingAPIHandler.DeleteWorkItem` | 204 | |
| PUT    | `/selected-work/order`        | `LandingAPIHandler.ReorderWorkItems` | 200 | |

Route-registration note: `/carousel/order` and `/carousel/{id}` both match
a two-segment pattern. Go 1.22+ `ServeMux` prefers the more specific literal
segment, so `/carousel/order` wins over `/carousel/{id}` — but this is
exactly the kind of precedence worth a test rather than a comment, since a
slide could otherwise become unreachable.

HQ can use `GET /hero` as its connectivity/token check; no separate ping
endpoint is proposed. The existing public `GET /healthz` stays unauthenticated
and unchanged.

---

## Request / Response Shapes

Field names are `snake_case`, matching the database columns, so HQ's
existing struct tags map over with minimal churn.

**Important**: `caption`, `link_url`, and `live_url` are `NOT NULL DEFAULT ''`
in the schema, not nullable. They are represented as `""` when absent, never
`null`. HQ should send `""` rather than omitting or nulling them.

### Hero

`GET /hero` → `200`

```json
{ "eyebrow": "Software Engineer", "title": "Hi, I'm Vincent Megia.", "message": "I build things with Go..." }
```

`PUT /hero` — body is the same shape; all three fields required and
non-empty after trimming. Returns `200` with the stored values (trimmed, so
HQ sees exactly what the site will render).

### Carousel slide

`GET /carousel` → `200`

```json
{ "slides": [ { "id": 1, "image_path": "/static/images/carousel/1.svg", "alt": "Illustration of a keyboard", "caption": "Engineering, hands-on", "link_url": "", "external": false, "sort_order": 1 } ] }
```

A list response is a wrapping object, not a bare top-level array — it leaves
room to add pagination or metadata later without a breaking change.

`POST /carousel` / `PUT /carousel/{id}` — body omits `id` and `sort_order`
(see Decision 2):

```json
{ "image_path": "/static/images/carousel/6.svg", "alt": "Alt text", "caption": "", "link_url": "/projects", "external": false }
```

`image_path` and `alt` are required; `caption` and `link_url` are optional.
Response is the single created/updated slide object.

### Selected work item

Same shape with the item's own fields:

```json
{ "id": 1, "kicker": "Game", "title": "Fishing Game", "description": "A canvas arcade mini-game...", "live_url": "/fishing-game", "external": false, "sort_order": 1 }
```

`kicker`, `title`, `description`, and `live_url` are all required.

### Reorder

`PUT /carousel/order` and `PUT /selected-work/order`:

```json
{ "ids": [3, 1, 2] }
```

Must contain **every** existing ID for that table exactly once — a partial
or duplicated list is rejected `422` rather than silently reordering a
subset. Applied in one transaction; `sort_order` is renumbered `1..n`.
Returns the reordered list.

---

## Error Handling

One envelope for every non-2xx response:

```json
{ "error": "validation_failed", "message": "alt text is required" }
```

`error` is a stable machine-readable code HQ can branch on; `message` is
human-readable and safe to show an approver. Internal error details are
logged server-side with the request ID and **never** included in `message`,
per `docs/skills/go-backend/SKILL.md`'s Errors section.

| Status | `error` code         | When |
| ------ | -------------------- | ---- |
| 400 | `bad_request`          | Malformed JSON, wrong content type, unparseable `{id}`. |
| 401 | `unauthorized`         | Missing, malformed, or incorrect bearer token. |
| 404 | `not_found`            | Unknown slide/item ID, or unknown route. |
| 409 | `carousel_full`        | `POST /carousel` when 5 slides already exist. |
| 422 | `validation_failed`    | Well-formed JSON that violates a field rule (missing required field, bad reorder list). |
| 429 | `rate_limited`         | Too many failed auth attempts from one source. |
| 500 | `internal_error`       | Anything unexpected; details logged, not returned. |

The 400/422 split follows the skill's status-code list: 400 means "I could
not parse this," 422 means "I parsed it and it is not acceptable." Worth
confirming HQ is comfortable distinguishing them, since it affects how HQ
surfaces failures to an approver.

`X-Request-ID` is already set on every response by existing middleware — HQ
should log it alongside each apply so a failure can be correlated to this
site's logs.

---

## Data Model

**No schema changes.** This API is a new transport in front of the tables
`migrations/005_create_landing_content.sql` already created; see
`docs/features/landing-content-authoring.md`'s Data Model for the schema.

One optional follow-up worth considering separately: `landing_hero` has an
`updated_at` column but `landing_carousel_slides` and
`landing_selected_work_items` have only `created_at`. If HQ wants to show
"last changed" per slide/card, that needs a small migration. Not required
for this feature.

---

## Business Rules / Validation

Every rule is enforced by the **same** `internal/service` code the site's
own `/settings/content` editor uses — the API must not re-implement or
relax any of them:

* Carousel is capped at 5 slides (`service.maxCarouselSlides`). `POST` at
  the cap returns `409`, not a silent no-op.
* Slides require `image_path` and `alt`; `caption`/`link_url` optional.
* Selected work items require `kicker`, `title`, `description`, `live_url`.
* Hero requires all three of `eyebrow`/`title`/`message`.
* All string fields are trimmed before storage; a whitespace-only value for
  a required field is a validation failure, not an empty-but-valid one.
* `sort_order` stays server-managed and contiguous — never accepted
  verbatim from a client. See Decision 2.

**Concurrency**: last write wins. Two writers now exist (HQ, and this
site's own `/settings/content` editor), so a simultaneous edit can silently
clobber. For a single-owner site with one human this is acceptable, and
adding optimistic concurrency (an `updated_at` precondition, `409` on
mismatch) is a reasonable later addition rather than v1 scope. Flagging it
so the choice is deliberate.

---

## Security Considerations

* **Authz**: single bearer token, one trusted caller; see Auth above for
  constant-time comparison, length validation, fail-closed behavior, and
  the rate-limiting requirement — including why "source IP" must be
  resolved via `internal/middleware.ClientKey`/`TrustProxyHeaders` rather
  than `r.RemoteAddr` directly on this app's Render deployment.
* **Transport**: Render terminates TLS on the public URL. The API must
  refuse to operate over plaintext in production — HSTS is already set by
  `middleware.SecurityHeaders`.
* **Input handling**: `json.Decoder` with `DisallowUnknownFields()` so a
  typo'd field name fails loudly instead of being silently dropped, plus a
  request body size limit (`http.MaxBytesReader`) so a large body can't
  exhaust memory. All persistence continues to use parameterized queries.
* **Output handling**: this API returns raw stored strings as JSON, which is
  correct — but note the site renders these same values through
  `html/template`'s auto-escaping. The API must not become a path that lets
  HQ store markup expecting it to render as HTML; it will be escaped, by
  design.
* **Secrets**: introduces exactly one new secret, `LANDING_API_TOKEN`. It
  must be set in Render's environment for this site's service and in HQ's
  own config, and must never appear in `config.yaml`, `config.example.yaml`,
  logs, or the repo.
* **Blast radius, stated plainly**: a leaked token lets an attacker rewrite
  homepage copy, carousel slides, and project cards — defacement, including
  pointing `link_url`/`live_url` at a malicious site. It does not grant
  database access, does not reach `users`, and does not permit arbitrary
  SQL. That is the entire point of the change, and it is a strictly smaller
  exposure than a shared database password — which is the actual comparison
  worth making now, not "internet-reachable vs. not." The database itself
  (Supabase, session pooler) is internet-reachable on its own merits
  regardless of this API or HQ's migration status; nothing in this feature
  changes that fact, only who else needs a full-access password to it. See
  Problem/Motivation.

---

## Implementation Notes

**Required prep refactor.** `LandingContentService`'s current methods
return HTML view-models and fold validation failures into a display string
(`CreateSlide` returns `(CarouselEditorView{Error: "..."}, nil)` on a bad
input — a `nil` error). A JSON API cannot distinguish `422` from `500`
through that signature. The fix is to add API-shaped methods on the same
service that return `(model.X, error)` with the existing sentinel errors
(`ErrSlideAltRequired`, `ErrCarouselFull`, …) surfaced directly, and
re-express the existing view-returning methods as thin wrappers that
convert those sentinels into `view.Error`. This keeps exactly one
validation path rather than growing a second one — which is the main reason
to route HQ through this service at all.

**New files** (mirroring existing layering):

* `internal/handler/landing_api.go` — `LandingAPIHandler`, JSON encoding/
  decoding, status-code mapping.
* `internal/handler/api_auth.go` — bearer-token middleware and its rate
  limiter.
* Routes registered in `cmd/server/main.go`'s `newMux`, conditional on
  `LANDING_API_TOKEN` being set.

**No new repository code** — `LandingContentRepository` already covers every
operation except the bulk reorder in Decision 2, which needs one new
transactional method alongside the existing `moveSortOrder`.

**Testing**: table-driven handler tests for status-code mapping and the
auth middleware (valid/missing/malformed/wrong token) run without a
database; the DB-gated `cmd/server/e2e_test.go` gets a round-trip case
proving an API write is visible on the next render of `/`, which is the
behavior HQ actually depends on.

---

## Open Questions

All three resolved with HQ. Kept here (rather than deleted) because each
records a real constraint a future reader would otherwise have to
rediscover.

### Decision 1 — HQ's remaining direct database access → **RESOLVED, reasoning updated for Supabase hosting**

**Answer: HQ ends up with zero direct access to this site's database.**
`content_change_requests` and `content_change_request_comments` move to a
separate Postgres that HQ runs on its own home network. Confirmed by
Vincent; HQ has corrected its own `CLAUDE.md`, which had previously
suggested keeping a narrower direct connection, and now flags that earlier
suggestion as wrong. **This conclusion is unchanged by the Supabase move —
only the reasoning underneath it is**, since the original reasoning
depended on a Render-specific mechanism that no longer applies.

`users` is confirmed a separate feature and does **not** block this one.
The auth-architecture choice (API endpoint vs. HQ's own user store vs. a
one-way sync) goes to Vincent separately.

**The reasoning, as it was originally written** (kept for the record, since
it shaped this decision and a future reader may wonder why the database
was ever assumed to be reachable only from Render): HQ could never use
Render's internal connection string, since that URL resolves only inside
Render's private network and HQ runs on Vincent's home LAN — so HQ
retaining *any* direct connection would force the database to stay on
Render's external URL, forfeiting the network-isolation benefit for
everyone, not just HQ.

**The reasoning, as it actually stands now that the database is on
Supabase**: there is no Render-internal-network option for *anyone* to
forfeit — this site's own backend and HQ both reach the database the same
way, over Supabase's session pooler, secured by TLS and a password. HQ
keeping direct database access is no longer "the one thing that cancels
out an otherwise-achieved network isolation." It is simply, on its own
terms, a second party holding a full-access Postgres password with
arbitrary SQL scope — including `users` — versus one party (this site)
holding it. That was already true before the hosting change; the hosting
change just removes the *additional* justification this doc used to lean
on. The conclusion doesn't move, but the API's contribution shifts from
"the deciding factor in reaching network isolation" to "the deciding
factor in reaching one-party-holds-the-password" — a real, smaller, still
worthwhile goal (see Problem/Motivation's "Be precise about what this buys,
revised").

That reframed the question as *where HQ's own tables should live*, which is
what the answer above settles. `content_change_requests` and
`content_change_request_comments` are HQ's own workflow state, never read
by this site, so relocating them removes HQ's need to reach either this
site's Render service or its Supabase database at all — without adding
workflow endpoints here, which would pull HQ's review workflow into this
repo (something Scope explicitly excludes).

On `users`: it stays a shared login table this site owns. Worth carrying
into that separate decision — this site's own `IsAuthenticated` is still a
permanent stub returning `false` (`internal/handler/auth_stub.go`), so the
shared `users` table is not yet load-bearing here, which makes "HQ keeps
its own user store" cheaper than it first appears.

**This decision still gates the security outcome, just a smaller one**:
shipping the content API while HQ still holds database credentials would
leave two parties with full SQL access to Supabase instead of one, and
deliver none of this feature's intended benefit. HQ's table relocation and
this API should land together, exactly as before — only the size of the
prize changed, not the sequencing.

### Decision 2 — `sort_order` on create/update → **RESOLVED**

**Answer: `sort_order` is not a writable field. Reordering goes through
`PUT .../order` with the full ordered ID list**, as designed above.

HQ's brief listed `sort_order` as writable. The existing code deliberately
does not treat it that way: `CreateCarouselSlide` assigns
`MAX(sort_order) + 1` server-side, `UpdateCarouselSlide` leaves it
untouched, and reordering is a separate transactional swap
(`repository.moveSortOrder`). Accepting a client-supplied `sort_order`
would let HQ produce duplicate or gapped orderings that the site's own
editor cannot, and that nothing in the schema prevents.

Checking HQ's actual UI settled it: its
`content-carousel-row.html`/`content-work-row.html` render a raw
`<input type="number" name="sort_order">` per row, so an approver types an
arbitrary integer with nothing preventing collisions — i.e. HQ is already
exhibiting the exact failure mode, and it is an accident rather than a
deliberate UI choice worth preserving. Since HQ's reorder UI needs rework
either way, the API takes the more robust primitive (atomic full-list
reorder, renumbered `1..n`) rather than the one that happens to match
today's markup. HQ's replacement UI — drag-and-drop, buttons, or otherwise
— is HQ's own follow-up and does not shape this contract.

Note this is an API-surface decision only: the site's own
`/settings/content` editor keeps its existing `POST /{id}/move` swap
endpoints, which are unaffected.

### Decision 3 — token rotation → **RESOLVED**

**Answer: ship v1 without a rotation mechanism.** Agreed with HQ.

Rotating means updating the env var in Render and in HQ, with a brief
window where one side is stale. Supporting two valid tokens simultaneously
(primary + secondary) would make rotation zero-downtime at the cost of some
config complexity — not worth it for a single-caller internal API. This is
a deliberate omission, revisitable if a second caller ever appears or a
leak forces a hurried rotation.

---

## Definition of Done

* [x] Open Questions resolved with HQ (Decisions 1–3).
* [x] Vincent has reviewed and approved this design.
* [x] Prep refactor landed: service exposes typed validation errors via the
      API-shaped methods, with the `*Form` methods wrapping them so the
      HTML editor path behaves identically.
* [x] All endpoints implemented with the documented status codes and error
      envelope.
* [x] Auth middleware: constant-time compare, startup length validation,
      fail-closed when unset, rate-limited failures, token never logged.
* [x] Route precedence between `/{id}` and `/order` covered by a test.
* [x] Handler/service/repository boundaries followed (`go-backend`).
* [x] Tests written per Implementation Notes — **but the DB-gated round
      trip has not actually been run**, since no reachable Postgres was
      available in the implementing session.
* [ ] Verified against a real database and a live HQ.
* [x] Hosting reality documented: the database is on Supabase (session
      pooler, TLS-enforced), not Render — the original "switch to Render's
      internal database URL" goal is recorded as permanently unavailable
      rather than left as a stale pending task. See Status and
      Problem/Motivation.
* [ ] `LANDING_API_TOKEN` set on both sides.
* [ ] HQ's direct database credentials removed once its own tables are
      relocated per Decision 1 — this, not network isolation, is now the
      actual security finish line for this feature.
