package repository

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"strings"

	"github.com/vincentmegia/vincentmegia/internal/model"
)

// BusRepository reads and writes the bus_stops and bus_routes tables — the
// Bus Stop Finder's local copy of LTA DataMall's BusStops/BusRoutes
// datasets. See docs/features/bus-stop-finder.md's Data Model.
//
// DB and ReadDB are separate handles, same split as LibraryRepository/
// ResumeRepository (docs/features/resume.md's Security Considerations):
// the nightly sync's Replace* methods use DB, every visitor-facing query
// uses ReadDB.
type BusRepository struct {
	DB     *sql.DB
	ReadDB *sql.DB
}

// NewBusRepository wraps two already-open database handles — db for
// writes, readDB for reads.
func NewBusRepository(db, readDB *sql.DB) *BusRepository {
	return &BusRepository{DB: db, ReadDB: readDB}
}

// metersPerDegreeLat is the length of one degree of latitude, close enough
// everywhere for a bounding-box prefilter (which only has to be a superset
// of the true radius — the haversine filter does the exact cut).
const metersPerDegreeLat = 111320.0

// earthRadiusMeters is the mean Earth radius the haversine formula uses.
const earthRadiusMeters = 6371000

// NearestStops returns up to limit stops within radiusMeters of (lat, lng),
// nearest first (ties broken by code), with each stop's straight-line
// distance rounded to whole meters. Distances are haversine, computed in
// SQL; a lat/lng bounding box computed here first narrows the scan to
// idx_bus_stops_lat_lng's range. Read-only — uses ReadDB.
func (repo *BusRepository) NearestStops(ctx context.Context, lat, lng float64, radiusMeters, limit int) ([]model.NearbyStop, error) {
	// Pad the box slightly so floating-point edge cases never exclude a
	// stop the exact haversine check would keep.
	dLat := float64(radiusMeters) / metersPerDegreeLat * 1.01
	dLng := float64(radiusMeters) / (metersPerDegreeLat * math.Cos(lat*math.Pi/180)) * 1.01

	const query = `
		SELECT code, road_name, description, latitude, longitude, dist
		FROM (
			SELECT code, road_name, description, latitude, longitude,
				2 * $9::double precision * asin(sqrt(
					power(sin(radians(latitude - $1) / 2), 2) +
					cos(radians($1)) * cos(radians(latitude)) *
					power(sin(radians(longitude - $2) / 2), 2)
				)) AS dist
			FROM bus_stops
			WHERE latitude BETWEEN $3 AND $4
				AND longitude BETWEEN $5 AND $6
		) candidates
		WHERE dist <= $7
		ORDER BY dist, code
		LIMIT $8`

	rows, err := repo.ReadDB.QueryContext(ctx, query,
		lat, lng,
		lat-dLat, lat+dLat,
		lng-dLng, lng+dLng,
		float64(radiusMeters), limit, float64(earthRadiusMeters))
	if err != nil {
		return nil, fmt.Errorf("query nearest bus_stops: %w", err)
	}
	defer rows.Close()

	var stops []model.NearbyStop
	for rows.Next() {
		var s model.NearbyStop
		var dist float64
		if err := rows.Scan(&s.Code, &s.RoadName, &s.Description, &s.Latitude, &s.Longitude, &dist); err != nil {
			return nil, fmt.Errorf("scan nearest bus_stops row: %w", err)
		}
		s.DistanceMeters = int(math.Round(dist))
		stops = append(stops, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate nearest bus_stops: %w", err)
	}
	return stops, nil
}

// GetStop fetches one stop by its 5-digit code. found is false (with a nil
// error) when no such stop exists. Read-only — uses ReadDB.
func (repo *BusRepository) GetStop(ctx context.Context, code string) (model.BusStop, bool, error) {
	const query = `
		SELECT code, road_name, description, latitude, longitude
		FROM bus_stops
		WHERE code = $1`

	var s model.BusStop
	err := repo.ReadDB.QueryRowContext(ctx, query, code).
		Scan(&s.Code, &s.RoadName, &s.Description, &s.Latitude, &s.Longitude)
	if err == sql.ErrNoRows {
		return model.BusStop{}, false, nil
	}
	if err != nil {
		return model.BusStop{}, false, fmt.Errorf("query bus_stops by code: %w", err)
	}
	return s, true, nil
}

// SearchStops finds up to limit stops matching query. A query of 1–5 ASCII
// digits matches stop-code prefixes (ordered by code); anything else is a
// case-insensitive substring match on description or road name, with
// LIKE's own wildcards (%, _) and the escape character escaped so a query
// of "%" matches only a literal percent sign. Name matches order stops
// whose description starts with the query first. Callers
// (internal/service) trim and length-check query first. Read-only — uses
// ReadDB.
func (repo *BusRepository) SearchStops(ctx context.Context, query string, limit int) ([]model.BusStop, error) {
	var (
		rows *sql.Rows
		err  error
	)
	if isStopCodePrefix(query) {
		const sqlQuery = `
			SELECT code, road_name, description, latitude, longitude
			FROM bus_stops
			WHERE code LIKE $1 || '%'
			ORDER BY code
			LIMIT $2`
		rows, err = repo.ReadDB.QueryContext(ctx, sqlQuery, query, limit)
	} else {
		const sqlQuery = `
			SELECT code, road_name, description, latitude, longitude
			FROM bus_stops
			WHERE description ILIKE $1 ESCAPE '\' OR road_name ILIKE $1 ESCAPE '\'
			ORDER BY (description ILIKE $2 ESCAPE '\') DESC, description, code
			LIMIT $3`
		escaped := escapeLike(query)
		rows, err = repo.ReadDB.QueryContext(ctx, sqlQuery, "%"+escaped+"%", escaped+"%", limit)
	}
	if err != nil {
		return nil, fmt.Errorf("search bus_stops: %w", err)
	}
	defer rows.Close()

	var stops []model.BusStop
	for rows.Next() {
		var s model.BusStop
		if err := rows.Scan(&s.Code, &s.RoadName, &s.Description, &s.Latitude, &s.Longitude); err != nil {
			return nil, fmt.Errorf("scan bus_stops search row: %w", err)
		}
		stops = append(stops, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate bus_stops search: %w", err)
	}
	return stops, nil
}

// isStopCodePrefix reports whether q is 1–5 ASCII digits.
func isStopCodePrefix(q string) bool {
	if len(q) < 1 || len(q) > 5 {
		return false
	}
	for i := 0; i < len(q); i++ {
		if q[i] < '0' || q[i] > '9' {
			return false
		}
	}
	return true
}

// escapeLike escapes LIKE's wildcards and the escape character itself
// (backslash, matching the ESCAPE '\' clause in SearchStops).
func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

// serviceHoursQueries holds one fixed query per day type, so the column
// choice never comes from string-building with caller input. DISTINCT ON
// keeps one row per service: a service that visits the stop more than
// once (both directions, or a loop) reports its first visit by direction
// then stop sequence, preferring a visit that has times for the day
// type over one that doesn't. NULL times become "".
var serviceHoursQueries = map[model.DayType]string{
	model.DayWeekday:  serviceHoursQuery("wd_first", "wd_last"),
	model.DaySaturday: serviceHoursQuery("sat_first", "sat_last"),
	model.DaySunday:   serviceHoursQuery("sun_first", "sun_last"),
}

func serviceHoursQuery(firstCol, lastCol string) string {
	return `
		SELECT DISTINCT ON (service_no)
			service_no, COALESCE(` + firstCol + `, ''), COALESCE(` + lastCol + `, '')
		FROM bus_routes
		WHERE bus_stop_code = $1
		ORDER BY service_no, (` + firstCol + ` IS NULL), direction, stop_sequence`
}

// ServiceHoursAtStop returns one row per service that stops at code, with
// that service's first/last bus for the given day type. Read-only — uses
// ReadDB.
func (repo *BusRepository) ServiceHoursAtStop(ctx context.Context, code string, day model.DayType) ([]model.ServiceHours, error) {
	query, ok := serviceHoursQueries[day]
	if !ok {
		return nil, fmt.Errorf("service hours: unknown day type %q", day)
	}

	rows, err := repo.ReadDB.QueryContext(ctx, query, code)
	if err != nil {
		return nil, fmt.Errorf("query bus_routes service hours: %w", err)
	}
	defer rows.Close()

	var hours []model.ServiceHours
	for rows.Next() {
		var h model.ServiceHours
		if err := rows.Scan(&h.ServiceNo, &h.FirstBus, &h.LastBus); err != nil {
			return nil, fmt.Errorf("scan bus_routes service hours row: %w", err)
		}
		hours = append(hours, h)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate bus_routes service hours: %w", err)
	}
	return hours, nil
}

// StopDescriptions maps each known code in codes to its description, for
// turning a service's destination code into a name. Unknown codes are
// simply absent from the map. Read-only — uses ReadDB.
func (repo *BusRepository) StopDescriptions(ctx context.Context, codes []string) (map[string]string, error) {
	descriptions := make(map[string]string, len(codes))
	if len(codes) == 0 {
		return descriptions, nil
	}

	const query = `
		SELECT code, description
		FROM bus_stops
		WHERE code = ANY($1)`

	rows, err := repo.ReadDB.QueryContext(ctx, query, codes)
	if err != nil {
		return nil, fmt.Errorf("query bus_stops descriptions: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var code, description string
		if err := rows.Scan(&code, &description); err != nil {
			return nil, fmt.Errorf("scan bus_stops description row: %w", err)
		}
		descriptions[code] = description
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate bus_stops descriptions: %w", err)
	}
	return descriptions, nil
}

// RouteTermini maps each of services that serves stop code in exactly one
// direction to the description of that direction's last stop. It's the
// destination-name fallback for LTA arrival DestinationCodes that aren't
// boarding stops (e.g. 960's "02099", absent from LTA's own BusStops
// dataset): the route's real last stop ("Promenade Stn/Pan Pacific") is
// the useful name. A service serving the stop in both directions is
// ambiguous and left out. Read-only — uses ReadDB.
func (repo *BusRepository) RouteTermini(ctx context.Context, code string, services []string) (map[string]string, error) {
	termini := make(map[string]string, len(services))
	if len(services) == 0 {
		return termini, nil
	}

	const query = `
		WITH dirs AS (
			SELECT service_no, MIN(direction) AS direction
			FROM bus_routes
			WHERE bus_stop_code = $1 AND service_no = ANY($2)
			GROUP BY service_no
			HAVING COUNT(DISTINCT direction) = 1
		), ends AS (
			SELECT DISTINCT ON (r.service_no) r.service_no, r.bus_stop_code
			FROM bus_routes r
			JOIN dirs d ON d.service_no = r.service_no AND d.direction = r.direction
			ORDER BY r.service_no, r.stop_sequence DESC
		)
		SELECT e.service_no, s.description
		FROM ends e
		JOIN bus_stops s ON s.code = e.bus_stop_code`

	rows, err := repo.ReadDB.QueryContext(ctx, query, code, services)
	if err != nil {
		return nil, fmt.Errorf("query bus_routes termini: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var serviceNo, description string
		if err := rows.Scan(&serviceNo, &description); err != nil {
			return nil, fmt.Errorf("scan bus_routes terminus row: %w", err)
		}
		termini[serviceNo] = description
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate bus_routes termini: %w", err)
	}
	return termini, nil
}

// RouteThroughStop returns every stop of serviceNo, in order, for each
// direction in which that service calls at code — joined to bus_stops for
// names and coordinates. A route stop missing from bus_stops (LTA lists a
// few, e.g. Larkin Ter in Johor Bahru) comes back with HasPosition false and
// only its code. The service picks the direction and slices the rows; see
// BusService.Route. Read-only — uses ReadDB.
func (repo *BusRepository) RouteThroughStop(ctx context.Context, code, serviceNo string) ([]model.RouteRow, error) {
	const query = `
		SELECT r.direction, r.stop_sequence, r.bus_stop_code,
		       COALESCE(s.description, ''), COALESCE(s.road_name, ''),
		       COALESCE(s.latitude, 0), COALESCE(s.longitude, 0),
		       s.code IS NOT NULL, COALESCE(r.distance_km, 0)
		FROM bus_routes r
		LEFT JOIN bus_stops s ON s.code = r.bus_stop_code
		WHERE r.service_no = $1
		  AND r.direction IN (SELECT direction FROM bus_routes WHERE service_no = $1 AND bus_stop_code = $2)
		ORDER BY r.direction, r.stop_sequence`

	rows, err := repo.ReadDB.QueryContext(ctx, query, serviceNo, code)
	if err != nil {
		return nil, fmt.Errorf("query bus_routes route: %w", err)
	}
	defer rows.Close()

	var out []model.RouteRow
	for rows.Next() {
		var r model.RouteRow
		if err := rows.Scan(&r.Direction, &r.StopSequence, &r.Stop.Code, &r.Stop.Name, &r.Stop.Road,
			&r.Stop.Latitude, &r.Stop.Longitude, &r.Stop.HasPosition, &r.Stop.KmFromBoarding); err != nil {
			return nil, fmt.Errorf("scan bus_routes route row: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate bus_routes route: %w", err)
	}
	return out, nil
}

// CountStops returns the number of rows in bus_stops — the sync's "don't
// replace good data with a suspiciously small response" guard compares
// against it. Read-only — uses ReadDB.
func (repo *BusRepository) CountStops(ctx context.Context) (int, error) {
	var n int
	if err := repo.ReadDB.QueryRowContext(ctx, `SELECT count(*) FROM bus_stops`).Scan(&n); err != nil {
		return 0, fmt.Errorf("count bus_stops: %w", err)
	}
	return n, nil
}

// CountRoutes returns the number of rows in bus_routes. Read-only — uses
// ReadDB.
func (repo *BusRepository) CountRoutes(ctx context.Context) (int, error) {
	var n int
	if err := repo.ReadDB.QueryRowContext(ctx, `SELECT count(*) FROM bus_routes`).Scan(&n); err != nil {
		return 0, fmt.Errorf("count bus_routes: %w", err)
	}
	return n, nil
}

// insertChunkRows bounds each multi-row INSERT. Postgres allows at most
// 65535 bind parameters per statement; bus_routes uses 12 per row, so
// 1000 rows (12000 parameters) stays well under it.
const insertChunkRows = 1000

// ReplaceStops swaps the whole bus_stops table for stops in one
// transaction: either every row lands or (on any error, including a row
// violating a CHECK) the previous rows are left untouched. Callers
// (internal/service) validate rows and apply the "too small" guard first.
func (repo *BusRepository) ReplaceStops(ctx context.Context, stops []model.BusStop) error {
	return repo.replace(ctx, "bus_stops", len(stops),
		`INSERT INTO bus_stops (code, road_name, description, latitude, longitude) VALUES `, 5,
		func(i int) []any {
			s := stops[i]
			return []any{s.Code, s.RoadName, s.Description, s.Latitude, s.Longitude}
		})
}

// ReplaceRoutes swaps the whole bus_routes table for routes in one
// transaction, same all-or-nothing contract as ReplaceStops. Empty time
// strings are stored as NULL.
func (repo *BusRepository) ReplaceRoutes(ctx context.Context, routes []model.BusRoute) error {
	return repo.replace(ctx, "bus_routes", len(routes),
		`INSERT INTO bus_routes (service_no, operator, direction, stop_sequence, bus_stop_code, distance_km,
			wd_first, wd_last, sat_first, sat_last, sun_first, sun_last) VALUES `, 12,
		func(i int) []any {
			r := routes[i]
			return []any{r.ServiceNo, r.Operator, r.Direction, r.StopSequence, r.BusStopCode, r.DistanceKm,
				nullIfEmpty(r.WDFirstBus), nullIfEmpty(r.WDLastBus),
				nullIfEmpty(r.SATFirstBus), nullIfEmpty(r.SATLastBus),
				nullIfEmpty(r.SUNFirstBus), nullIfEmpty(r.SUNLastBus)}
		})
}

// replace deletes every row of table and re-inserts n rows in chunks of
// insertChunkRows, all inside one transaction. table and insertPrefix are
// fixed strings from this file, never caller input.
func (repo *BusRepository) replace(ctx context.Context, table string, n int, insertPrefix string, cols int, rowArgs func(i int) []any) error {
	tx, err := repo.DB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin replace %s: %w", table, err)
	}
	defer tx.Rollback() // no-op after Commit

	if _, err := tx.ExecContext(ctx, `DELETE FROM `+table); err != nil {
		return fmt.Errorf("clear %s: %w", table, err)
	}

	for start := 0; start < n; start += insertChunkRows {
		end := min(start+insertChunkRows, n)
		var sb strings.Builder
		sb.WriteString(insertPrefix)
		args := make([]any, 0, (end-start)*cols)
		for i := start; i < end; i++ {
			if i > start {
				sb.WriteString(", ")
			}
			sb.WriteByte('(')
			for c := 0; c < cols; c++ {
				if c > 0 {
					sb.WriteString(", ")
				}
				fmt.Fprintf(&sb, "$%d", len(args)+c+1)
			}
			sb.WriteByte(')')
			args = append(args, rowArgs(i)...)
		}
		if _, err := tx.ExecContext(ctx, sb.String(), args...); err != nil {
			return fmt.Errorf("insert %s rows %d-%d: %w", table, start, end-1, err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit replace %s: %w", table, err)
	}
	return nil
}

// nullIfEmpty maps "" to SQL NULL, for the optional HHMM columns.
func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
