# Feature: Bus Stop Finder

## Status

Implemented and verified end to end against the local fake LTA
(`cmd/fakelta`): Go unit/DB tests, Playwright on Chromium + WebKit, and an
independent conformance review whose fixes are applied. Not yet live:
production needs `LTA_ACCOUNT_KEY` and a referrer-restricted
`GOOGLE_MAPS_API_KEY` provisioned (see Open Questions).

## Summary

`/bus-stops` finds the Singapore bus stops nearest the visitor (browser
geolocation), shows them on a Google Map and in a list, and shows live
arrival times for every bus at the selected stop, from LTA DataMall. It's a
public project page linked from `/projects`.

## Problem / Motivation

A portfolio project that exercises a real third-party API end to end:
geolocation permission handling, a server-side proxy that keeps an API key
secret, a nightly batch sync, a short-TTL cache, and live HTMX polling.

## Scope

**In scope:**

* Pre-permission explainer, then `navigator.geolocation` with granted /
  denied / unavailable / timeout states.
* The 5 nearest stops within 500 m (straight-line distance), nearest one
  selected and expanded automatically.
* Google Map with the visitor's position and a pin per stop. Pin and list
  card selection stay in sync.
* Expanded stop card: one row per service at the stop, next 3 buses
  (rounded per LTA), crowding, deck type, wheelchair access, timetable
  marker, LTA's "No Est. Available" / "Not In Operation" messages, today's
  first/last bus.
* Arrivals refresh every 20 s while a card is open.
* "Where this bus goes": a Route button on each arrival row lists the
  service's onward stops from this stop to its terminus, with distances,
  and (with a map) draws the route: a dashed line for the two stops it's
  coming from, a solid line onward, a dot per stop.
* Live buses: each oncoming bus LTA has a live fix for is a map marker,
  labelled with its service number; the open route's buses are filled.
* Search by stop code or stop/road name, for visitors who deny location.
* Search by 6-digit Singapore postal code: geocoded server-side with
  OneMap (Singapore Land Authority, no key), then the same 5-nearest /
  500 m results as a location search, nearest expanded.
* Nightly sync of LTA `BusStops` and `BusRoutes` into Postgres.
* Works without a Google Maps key (list only, no map) and without an LTA
  key (stops still searchable if already synced; arrivals show an
  unavailable message).

**Out of scope:**

* Re-searching when the map is dragged (v1 only recentres on the visitor).
* Full timetables. LTA publishes only the next 3 buses plus first/last bus.
* Public-holiday handling for first/last bus (no holiday calendar; weekday
  rules apply). See Open Questions.
* Walking distance/directions (billed Google API).
* Header nav link. Reachable from `/projects` only, same gradual rollout as
  the other projects.

### Decisions taken (from the planning review)

1. Lives inside this site (Go/HTMX/Postgres), at `/bus-stops`.
2. Show the 5 nearest within 500 m; auto-expand the nearest.
3. Map drag does not re-search; a Recentre button returns to the visitor.
4. Next 3 buses + today's first/last bus is the "all timings" view.

---

## User Flow

```text
1. Visitor opens /projects and clicks "Open" on the Bus Stop Finder card.
   This is a full page load, not an HTMX swap (see Security: the page has
   its own CSP, which only applies on a real navigation).
2. /bus-stops shows the explainer card: why location is needed, that it
   isn't stored, a "Use my location" button and a "Search by stop code"
   link. Nothing is requested from the browser or Google yet.
3a. Visitor clicks "Use my location" → browser prompt → granted:
    coordinates are rounded to 3 decimals in the browser and sent to
    GET /bus-stops/nearby. The list renders; the nearest stop is expanded;
    the Google Maps script loads now (only now) and draws pins.
3b. Denied / unavailable / timed out: the explainer is replaced by the
    "Location is off" panel (how to re-enable, Try again) plus the search
    box.
4. Visitor clicks another card or pin → that stop becomes selected and
   expanded, the previous one collapses (its polling stops).
5. While a card is expanded its arrivals refresh every 20 s. "Updated Ns
   ago" reflects FetchedAt.
6. Search: typing a code or name and submitting calls
   GET /bus-stops/search?q=…, rendering the same card list (no distances).
```

---

## UI

```text
web/templates/
├── pages/bus-stops.html                 "bus-stops-content" (page)
└── components/
    ├── bus-stop-list.html               "bus-stop-list" (fragment)
    └── bus-arrivals.html                "bus-arrivals" (fragment)
web/static/js/bus-stops.js               geolocation, map, selection
web/static/images/bus/screenshot.png     /projects card image
```

Visual design: the "Bus Stop Finder" claude.ai design canvas, "Layout v2 ·
map on top", in the site's Organic tokens. Tailwind classes only, no inline
styles. Top to bottom:

1. **Map, full width** (aspect 4:5 on phones, 16:9 small screens, 5:2
   desktop), with the search form (postal code / stop code / road, Search,
   locate button) floating on its top-left. Without a Maps key the search
   form is a bar in the map's place. Until the map loads, an illustrated
   placeholder says "The map appears once you share your location or
   search for a stop." The map loads after location is shared or after a
   search; scroll/drag act directly on a mouse/trackpad (`greedy`), and
   phones keep one-finger page scrolling (`cooperative`).
2. **One-line notices**: the explainer ("Find the stops around you" + Use my
   location / Search by postal code or stop code) or "Location is off"
   (+ Try again).
3. **Results grid**: heading across the top; the stop list on the left and
   the selected stop's detail panel (`#bus-detail-{code}`: arrivals + route)
   on the right (lg+). Below lg the detail comes first and the selected
   card hides from the list; the panel's close button collapses it.

| State | Behavior |
| ----- | -------- |
| Default (first visit) | Explainer card with "Use my location" + "Search by stop code" |
| Locating | Button disabled, "Finding you…" text, `aria-busy` on the list |
| Granted, results | Map (if key) + list of ≤5 cards, nearest expanded |
| Granted, none within 500 m | Empty state: "No bus stops within 500 m" + search box |
| Denied / unavailable / timeout | "Location is off" panel with steps + Try again + search box |
| Outside Singapore (400 from server) | "Bus Stop Finder only covers Singapore" + search box |
| Arrivals loading | Skeleton rows in the expanded card |
| Arrivals live | Service rows as specified below |
| Arrivals stale | Rows plus "Showing data from Ns ago; live times unavailable" |
| Arrivals unavailable | "Live arrival times are unavailable right now. Try again shortly." |
| No Maps key | List only; no map, no Google script loaded (the route list still works) |
| Route open | Route button pressed; "Bus N from <stop>" with "K stops · X km to <terminus>", boarding stop then each onward stop with "+X.X km"; map shows the route + stop dots |
| Route ends at this stop | "<stop> is the last stop for bus N in this direction." |
| Route not found / invalid (404 / 400) | Fixed-copy message in the route slot |
| Search, no results | "No stops match '…'" |
| Postal search, results | "Stops near <place>" heading, "N within 500 m of <postal>", nearest expanded |
| Postal search, unknown postal code (404) | "Postal code not found" message + search box |
| Postal search, no stop within 500 m | "No bus stops within 500 m of <place>" |
| Postal search, OneMap down (503) | "Postal code search is unavailable right now. Try a stop code or road name instead." |

Arrival row: service number badge, destination ("Destination not listed"
when LTA gives none), today's "First HH:MM · Last HH:MM" line when known
(24xx times shown as 00:xx), and "Wheelchair accessible" if the first
NextBus has WAB; then up to 3 times. A time shows "Arr" (emphasised) or
"N min"; timetable estimates (`Monitored=0`) are italic with a "~" prefix.
Under each time: a 3-segment crowding bar (1 segment seats, 2 standing, 3
limited) with an `aria-label` naming the level, so crowding is never
conveyed by colour alone; and that bus's own vehicle type, an icon plus
"Single" / "Double" / "Bendy" (icon `aria-label` "Single deck" / "Double
deck" / "Bendy bus"). Vehicle type is per bus because LTA reports it per
bus and it often differs within one route (e.g. Double / Single / Double);
an unknown type shows nothing. A service with no data shows its Status
text instead of times, plus "First bus HH:MM" when Not In Operation.

---

## HTMX Interactions

| Trigger | Method | Endpoint | Target | Swap | Indicator |
| ------- | ------ | -------- | ------ | ---- | --------- |
| Location acquired (JS calls `htmx.ajax`) | GET | `/bus-stops/nearby?lat=&lng=` | `#bus-stop-results` | `innerHTML` | the button's "Finding you…" state + `aria-busy` (`htmx.ajax` has no source element, so `hx-indicator` doesn't apply) |
| Search form submit (stop code, name, or 6-digit postal code) | GET | `/bus-stops/search?q=` | `#bus-stop-results` | `innerHTML` | `#bus-stop-loading` |
| Route button (JS calls `htmx.ajax`) | GET | `/bus-stops/{code}/route/{service}` | `#bus-route-{code}` (sibling of the arrivals slot, so the 20 s poll never wipes it) | `innerHTML` | — |
| Card expanded / every 20 s while expanded | GET | `/bus-stops/{code}/arrivals` | `#bus-arrivals-{code}` | `outerHTML` (fragment re-declares its own `hx-trigger="every 20s"`) | local skeleton |

Polling stops when a card collapses because the polling element is
removed, and polls are skipped while the tab is hidden (an
`htmx:beforeRequest` cancel, not a trigger filter). htmx 2 doesn't swap
4xx/5xx by default, so `bus-stops.js` enables swapping for 400/404/429/500
inside this page so the fixed-copy error fragments render. List-route
errors use a small `bus-stop-message` fragment carrying `data-bus-state`
so the JS can reveal the search box. No `hx-trigger` filter expressions (they need `eval`, which the
CSP forbids). No `hx-push-url` anywhere on this page: coordinates must
never reach the address bar or history.

---

## Routes / Handlers

| Method | Path | Handler | Auth | Notes |
| ------ | ---- | ------- | ---- | ----- |
| GET | `/bus-stops` | `BusStopsHandler.Index` | no | Full page; route-scoped CSP + Permissions-Policy |
| GET | `/bus-stops/nearby` | `BusStopsHandler.Nearby` | no | `lat`,`lng` query; fragment `bus-stop-list`; per-IP limited |
| GET | `/bus-stops/search` | `BusStopsHandler.Search` | no | `q` query; a 6-digit `q` is a postal code (OneMap geocode → nearest stops, `data-mode="postal"`); fragment `bus-stop-list`; per-IP limited |
| GET | `/bus-stops/{code}/arrivals` | `BusStopsHandler.Arrivals` | no | fragment `bus-arrivals`; per-IP limited |
| GET | `/bus-stops/{code}/route/{service}` | `BusStopsHandler.Route` | no | fragment `bus-route`; per-IP 60/min; `Cache-Control: public, max-age=300` (route data only changes with the nightly sync, no visitor data) |

Validation failures return a 400 with a small HTML message fragment
(never an upstream error text). Rate-limit hits return 429 with a short
message. Arrivals: invalid code → 400 (no polling), unknown stop → 404 (no
polling), LTA unavailable or not configured → 200 with the unavailable
copy (keeps polling), unexpected error → 500 (keeps polling). All three
fragment routes send `Cache-Control: no-store`.

---

## Data Model

`migrations/009_create_bus_stops.sql`

| Table | Column | Type | Constraints |
| ----- | ------ | ---- | ----------- |
| bus_stops | code | `CHAR(5)` | PK, `CHECK (code ~ '^[0-9]{5}$')` |
| | road_name | `TEXT` | NOT NULL, `CHECK (char_length(road_name) <= 120)` |
| | description | `TEXT` | NOT NULL, `CHECK (char_length(description) <= 120)` |
| | latitude | `DOUBLE PRECISION` | NOT NULL, `CHECK (latitude BETWEEN 1.15 AND 1.48)` |
| | longitude | `DOUBLE PRECISION` | NOT NULL, `CHECK (longitude BETWEEN 103.6 AND 104.1)` |
| | updated_at | `TIMESTAMPTZ` | NOT NULL DEFAULT now() |
| bus_routes | service_no | `TEXT` | `CHECK (service_no ~ '^[0-9A-Za-z]{1,6}$')` |
| | operator | `TEXT` | NOT NULL |
| | direction | `SMALLINT` | `CHECK (direction IN (1,2))` |
| | stop_sequence | `INTEGER` | NOT NULL |
| | bus_stop_code | `CHAR(5)` | NOT NULL, same digit CHECK; indexed; no FK (LTA routes can reference stops absent from BusStops) |
| | distance_km | `DOUBLE PRECISION` | NULL |
| | wd_first, wd_last, sat_first, sat_last, sun_first, sun_last | `CHAR(4)` | NULL, `CHECK (x ~ '^[0-2][0-9][0-5][0-9]$')` |
| | | | PK `(service_no, direction, stop_sequence)` |

Indexes: `bus_stops (latitude, longitude)` for the bounding-box prefilter;
`bus_routes (bus_stop_code)`.

### Go contracts (all agents code against these)

Shared types: `internal/model/bus.go`.

`internal/repository/bus_repository.go`, `NewBusRepository(db, readDB *sql.DB) *BusRepository`
(reads use `readDB`, writes use `db`):

```go
NearestStops(ctx, lat, lng float64, radiusMeters, limit int) ([]model.NearbyStop, error) // nearest first; haversine in SQL with a lat/lng bounding-box prefilter
GetStop(ctx, code string) (model.BusStop, bool, error)                                // found=false, err=nil when absent
SearchStops(ctx, query string, limit int) ([]model.BusStop, error)                    // code prefix OR description/road ILIKE; LIKE wildcards in query escaped
ServiceHoursAtStop(ctx, code string, day model.DayType) ([]model.ServiceHours, error) // one row per service at the stop
StopDescriptions(ctx, codes []string) (map[string]string, error)                     // code → description, for destination names
RouteTermini(ctx, code string, services []string) (map[string]string, error)          // service → last stop's description, single-direction services only
RouteThroughStop(ctx, code, serviceNo string) ([]model.RouteRow, error)               // every stop of the service, per direction that calls at code
CountStops(ctx) (int, error)
CountRoutes(ctx) (int, error)
ReplaceStops(ctx, stops []model.BusStop) error   // one transaction: delete all + batched insert
ReplaceRoutes(ctx, routes []model.BusRoute) error // same
```

`internal/lta` (new package), `NewClient(baseURL, accountKey string, httpClient *http.Client) *Client`:

```go
BusArrival(ctx, stopCode string) (BusArrivalResponse, error) // GET {base}/ltaodataservice/v3/BusArrival?BusStopCode=
BusStops(ctx, skip int) ([]BusStopRecord, error)              // GET {base}/ltaodataservice/BusStops?$skip=
BusRoutes(ctx, skip int) ([]BusRouteRecord, error)            // GET {base}/ltaodataservice/BusRoutes?$skip=
```

`internal/service/bus_service.go`. The service declares its own
`busRepository` and `ltaClient` interfaces (the methods above) and its
constructor takes those interfaces, not concrete types:

```go
NewBusService(repo busRepository, client ltaClient, opts BusServiceOptions) *BusService // client may be nil = LTA not configured
(s) Nearby(ctx, lat, lng float64) ([]model.NearbyStop, error)
(s) Search(ctx, q string) ([]model.BusStop, error)
(s) SearchPostal(ctx, q string) (BusPostalResult, error) // 6 digits → OneMap → Nearby
(s) Route(ctx, code, serviceNo string) (model.ServiceRoute, error) // approach (≤2) + onward stops, km from code
IsBusPostalCode(q string) bool                         // handler routes 6-digit queries to SearchPostal
(s) Arrivals(ctx, code string) (model.StopArrivals, error)
(s) Sync(ctx) (BusSyncResult, error)
(s) RunScheduler(ctx)   // blocks until ctx done; no-op when client is nil
// sentinel errors:
ErrBusInvalidLocation, ErrBusOutsideSingapore, ErrBusSearchQueryInvalid,
ErrBusStopCodeInvalid, ErrBusStopNotFound, ErrBusArrivalsUnavailable, ErrBusSyncTooSmall,
ErrBusLTANotConfigured // Sync/Arrivals with no LTA client
ErrBusPostalNotFound, ErrBusPostalUnavailable, ErrBusServiceInvalid, ErrBusRouteNotFound
```

`internal/handler/bus_stops.go`, `NewBusStopsHandler(renderer *Renderer, svc busStopsService, version, mapsAPIKey string) *BusStopsHandler`.
The handler declares `busStopsService` (Nearby/Search/Arrivals).

`internal/onemap` (new package), `NewClient(baseURL string, httpClient *http.Client) *Client`:

```go
Geocode(ctx, postal string) (Place, bool, error) // GET {base}/api/common/elastic/search?searchVal=&returnGeom=Y&getAddrDetails=Y&pageNum=1; exact POSTAL match only
```

Config (wired in `cmd/server`): `LTA_ACCOUNT_KEY`, `LTA_BASE_URL`
(default `https://datamall2.mytransport.sg`), `GOOGLE_MAPS_API_KEY`,
`ONEMAP_BASE_URL` (default `https://www.onemap.gov.sg`).

---

## Business Rules / Validation

* **Location**: `lat`/`lng` parse as finite floats; rounded to 3 decimals
  server-side too (the browser already rounds). Must fall inside
  Singapore: lat 1.15–1.48, lng 103.6–104.1, else `ErrBusOutsideSingapore`.
  Radius 500 m and limit 5 are fixed server-side; no client parameter.
* **Search**: trimmed, 2–40 characters, else `ErrBusSearchQueryInvalid`.
  At most 10 results. A 1–5 digit query matches code prefixes; anything
  else matches description/road name, case-insensitive.
* **Route**: stop code validated as usual; service number 1–6 ASCII
  letters/digits (`ErrBusServiceInvalid`). If the service calls at the stop
  in more than one direction (or a loop calls twice), use the direction
  with the most stops still ahead, from its first call at the stop. Onward
  stops capped at 100; distances are `bus_routes.distance_km` relative to
  the boarding stop, rounded to 0.1 km. A route stop missing from
  `bus_stops` is listed as "Stop <code>" with no position (left off the
  map). No onward stops → "last stop" message. No direction calls at the
  stop → `ErrBusRouteNotFound`.
* **Live bus position**: only for a monitored bus (LTA sends "0" for
  timetable-only buses), parsed as floats and inside Singapore's bounds;
  anything else is dropped, never drawn.
* **Postal code**: a trimmed query of exactly 6 ASCII digits is a postal
  code (5 digits stays a stop code). OneMap's fuzzy search must return an
  exact `POSTAL` match; the place label is the building name, else block
  + road, title-cased. The point must be inside Singapore's bounds (else
  "not found"). Geocodes are cached in memory: hits 24 h, misses 1 h,
  failures not cached, at most 10,000 entries (cleared when full).
  Anonymous OneMap use is rate-limited to about 1 request/second with a
  burst of 2 (measured 3 Oct 2026); on HTTP 429 the client waits
  (`Retry-After` if sent, capped at 3 s, else 1 s then 2 s) and retries, at
  most 3 attempts in total, before reporting "unavailable".
* **Stop code**: exactly 5 ASCII digits, else `ErrBusStopCodeInvalid`
  (no LTA call). Must exist in `bus_stops`, else `ErrBusStopNotFound`
  (no LTA call).
* **Arrival time label**: `d = EstimatedArrival − now`. `d < 60s`
  (including negative) → "Arr". Otherwise `floor(d / 1 min)`. A NextBus
  with an empty EstimatedArrival is dropped.
* **Destination name**: the description of the first live bus's
  `DestinationCode` stop. When that code isn't a known stop (LTA uses
  terminal codes absent from its own BusStops, e.g. 960 → `02099`) or the
  row has no live buses, fall back to the last stop of the service's route
  through this stop (`RouteTermini`), when the service serves the stop in
  only one direction. Otherwise "Destination not listed".
* **Duplicate services**: LTA can list one ServiceNo twice (loops); the
  merged row is sorted by arrival and capped at the soonest 3.
* **Service hours row**: when a service visits a stop more than once, the
  first visit by direction/sequence is used, preferring one that has times
  for today's day type.
* **Services shown**: the union of services in `bus_routes` for this stop
  and services in the LTA response, natural-sorted ("2" < "7" < "12" <
  "225G" < "225W"). Loop services with G/W suffixes are separate rows.
* **Status** (LTA advisement): if a service has ≥1 NextBus, show times
  regardless of schedule. Else, if now (Asia/Singapore, `UTC+8` fixed
  zone) is within today's first–last bus → "No Est. Available"; otherwise
  → "Not In Operation". A last bus earlier than the first bus (e.g. first
  0530, last 0030) means the window wraps past midnight. Unknown hours →
  "No Est. Available".
* **Day type**: Mon–Fri → WD, Sat → SAT, Sun → SUN, by Singapore date.
* **Cache**: one entry per stop code, TTL 20 s. Concurrent misses for the
  same code share one LTA call (`singleflight`). On LTA failure, serve the
  cached entry if it's ≤ 2 min old with `Stale=true`; else
  `ErrBusArrivalsUnavailable`.
* **Outbound budget**: a process-wide token bucket caps LTA BusArrival
  calls (default 5/s, burst 10). Over budget behaves like an LTA failure
  (stale or unavailable).
* **Sync**: page through `$skip` in steps of 500 until a page returns
  fewer than 500 rows, with a hard cap of 200 pages. Drop invalid rows
  (bad code, coordinates outside Singapore, over-long text, bad HHMM →
  that time becomes empty). If the valid row count is 0, or less than 50%
  of the current table's count, refuse with `ErrBusSyncTooSmall` and keep
  the old data. Each table is replaced in one transaction.
* **Schedule**: on start, sync immediately if `bus_stops` is empty; then
  daily at 03:00 Singapore time. Disabled when `LTA_ACCOUNT_KEY` is unset.

---

## Security Considerations

* **Authz**: public, read-only. No login, nothing stored per visitor.
* **LTA key**: only in server config; sent only as the `AccountKey`
  header on server→LTA requests. Never logged, never rendered, never in
  error text returned to clients. The server builds every LTA URL itself
  from a validated 5-digit code; no client input is forwarded.
* **LTA base URL**: must be `https`, except `http://localhost` /
  `http://127.0.0.1` for the local fake. Config load fails otherwise.
* **Outbound HTTP**: 10 s timeout, response body capped at 8 MB
  (`io.LimitReader`), default TLS verification, and redirects are never
  followed (net/http forwards custom headers like `AccountKey` across
  hosts on redirect; a 30x is treated as an error instead).
* **Abuse**: per-IP fixed-window limits via `middleware.ClientKey`:
  nearby 30/min, search 30/min, arrivals 120/min. Plus the outbound token
  bucket and unknown-code rejection above, so random codes can't spend the
  LTA quota.
* **Untrusted LTA data**: rendered only through `html/template`
  auto-escaping (never `template.HTML`). JS reads stop data from `data-*`
  attributes and sets marker titles/labels with plain strings and
  `textContent`, never `innerHTML` or InfoWindow HTML strings. Sync
  validates every row before writing.
* **CSP**: the site-wide CSP stays strict. Only `GET /bus-stops`
  overrides it with a per-request nonce policy that allows the Google Maps
  JS API (per Google's Maps CSP guide), and only when a Maps key is
  configured. Google's policy requires `'strict-dynamic'` and
  `'unsafe-eval'`, so every script tag in `base.html` carries the nonce
  when one is set, and htmx's own eval features are switched off
  site-wide (`"allowEval":false` in the htmx-config meta) so
  `'unsafe-eval'` doesn't re-enable `hx-on`/filters here. The nonce is hex
  (no characters `html/template` escapes) and is read in JS from
  `script[nonce].nonce`, never copied into a data attribute. All other
  responses, including this feature's fragments, keep the site-wide CSP.
* **Permissions-Policy**: `geolocation=(self)` on `GET /bus-stops`.
* **Location privacy**: coordinates rounded to 3 decimals (~110 m) in the
  browser before sending; never put in the URL bar/history; the request
  logger records only `r.URL.Path`, never the query. Copy says "We don't
  store your location" (not "never shared": Google sees map tile requests
  once the map loads). The Google script loads only after location is
  granted. The page root has `hx-history="false"` so htmx never snapshots
  nearby results into localStorage when the visitor navigates away.
* **Screen readers**: the results region is `aria-live="polite"`, but each
  polling arrivals container is `aria-live="off"` so the board isn't
  re-announced every 20 s.
* **Google Maps key**: public by design. Must be HTTP-referrer-restricted
  to the site's domains and API-restricted to Maps JavaScript API, with a
  daily quota cap and a billing alert in Google Cloud Console (operator
  setup, documented here because the code can't enforce it).
* **OneMap**: called only from the server, with only the validated six
  digits; 5 s timeout, 1 MB body cap, no redirects, https-or-localhost
  base URL. The visitor's browser never contacts OneMap. Postal codes are
  a location, so they get the same treatment as coordinates: not in logs
  (path-only request log), `Cache-Control: no-store`, shared per-IP search
  limit. OneMap failures are logged and replaced by fixed copy.
* **Errors**: LTA/DB errors are logged with `slog` and replaced by fixed
  user-facing messages.

---

## Testing Plan

* [ ] Repository (DB-gated): nearest ordering and 500 m cutoff; search by
      code prefix and by name with `%`/`_` escaped; service hours per day
      type; Replace* transactional (failure leaves old rows).
* [ ] LTA client (httptest): AccountKey header sent; URL built from
      validated input only; non-200 and oversized bodies error; timeouts.
* [ ] Service (fakes): every validation sentinel; label rounding at
      59 s/60 s/negative; status logic incl. midnight wrap and unknown
      hours; natural sort; cache hit within 20 s; singleflight collapses
      concurrent misses; stale-on-error ≤ 2 min then unavailable; outbound
      budget; sync pagination, row validation, 50% guard, page cap.
* [ ] Handler (fakes): status codes and fragments for each error; 429
      after the per-IP limit; CSP/Permissions-Policy on Index only; nonce
      matches the script tag; no Maps script when key empty; LTA key never
      appears in any response.
* [ ] Playwright (Chromium + WebKit, against the real server + fake LTA,
      started by `make run-e2e` with the bus tables isolated in a
      `bus_e2e` schema):
      explainer first; granted geolocation → 5 cards, nearest expanded,
      arrival rows, "Arr", italic "~", crowding aria-labels, both status
      messages; selecting another card swaps expansion; denied → Location
      off panel + search works; outside Singapore message; no-Maps-key
      list mode; Maps stub test verifies one marker per card with
      textContent-safe titles; no console CSP violations; projects card
      opens the page with a full load.

---

## Known limitations (accepted)

* Map markers use the legacy `google.maps.Marker` (no map ID needed); it
  may log a deprecation warning. Migrate to `AdvancedMarkerElement` when a
  map ID is set up.
* The per-IP limiter maps are never pruned (pre-existing pattern shared
  with the games' score limiters).
* A handful of IPs cycling valid stop codes can use up the shared 5/s LTA
  budget; visitors then see stale or unavailable times rather than the
  key being throttled. Accepted by design.
* Without JavaScript the search form submits to the fragment route and
  shows an unstyled fragment.
* A timetable-estimate bus that is under a minute away shows "Arr"
  without the italic "~".
* The fake's "Not In Operation" fixture (service 960, 0500–0501) makes the
  Playwright status assertion fail if run during 05:00–05:01 SGT.

* Postal search runs on OneMap's anonymous allowance (~1 request/second).
  Caching and retries cover normal traffic, but more than about four
  people searching new postal codes in the same second will see
  "unavailable" for some. A OneMap account token (raises the limit;
  expires every 3 days, so it needs auto-renewal) is the fix if that ever
  matters.

## Open Questions

* Public holidays use Sunday first/last bus times in LTA's convention;
  without a holiday calendar the status may be wrong on public holidays.
* Google Maps key ownership/billing account, and the LTA key, need to be
  provisioned by the site owner before the page is useful in production.

---

## Definition of Done

* [ ] User flow works end-to-end, including the edge cases above.
* [ ] All states in the UI table are implemented.
* [ ] Migration written with a working `Down`.
* [ ] Handler/service/repository boundaries followed (`go-backend`).
* [ ] Accessibility checked (keyboard, focus, contrast, semantic HTML).
* [ ] Tests cover the Testing Plan above, all passing.
* [ ] `/projects` card added with a real screenshot.
