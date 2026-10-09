package repository

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/joho/godotenv"

	"github.com/vincentmegia/vincentmegia/internal/model"
)

// newTestBusRepository returns a BusRepository backed by a throwaway
// schema on the DATABASE_URL database, with migration 008's Up section
// applied inside it. The real bus_stops/bus_routes tables (if any) are
// never touched: every connection in the test pool has search_path set to
// the throwaway schema, which is dropped CASCADE on cleanup.
//
// Skipped when DATABASE_URL isn't set (directly or via the repo-root
// .env), same opt-in gating as cmd/server/e2e_test.go.
func newTestBusRepository(t *testing.T) *BusRepository {
	t.Helper()

	_ = godotenv.Load("../../.env") // optional; real env vars win
	baseURL := os.Getenv("DATABASE_URL")
	if baseURL == "" {
		t.Skip("DATABASE_URL not set (skipping DB-backed bus repository test — see .env.example)")
	}

	ctx := context.Background()

	admin, err := sql.Open("pgx", baseURL)
	if err != nil {
		t.Fatalf("open admin connection: %v", err)
	}
	t.Cleanup(func() { admin.Close() })
	if err := admin.PingContext(ctx); err != nil {
		t.Skipf("database unreachable (%v); skipping", err)
	}

	suffix := make([]byte, 6)
	if _, err := rand.Read(suffix); err != nil {
		t.Fatalf("random schema suffix: %v", err)
	}
	schema := "bus_test_" + hex.EncodeToString(suffix)
	if _, err := admin.ExecContext(ctx, `CREATE SCHEMA `+schema); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	t.Cleanup(func() {
		if _, err := admin.ExecContext(context.Background(), `DROP SCHEMA `+schema+` CASCADE`); err != nil {
			t.Errorf("drop schema %s: %v", schema, err)
		}
	})

	u, err := url.Parse(baseURL)
	if err != nil {
		t.Fatal("parse DATABASE_URL failed") // never echo the URL: it holds the password
	}
	q := u.Query()
	q.Set("search_path", schema)
	u.RawQuery = q.Encode()

	conn, err := sql.Open("pgx", u.String())
	if err != nil {
		t.Fatalf("open schema-scoped connection: %v", err)
	}
	conn.SetMaxOpenConns(4)
	t.Cleanup(func() { conn.Close() })

	if _, err := conn.ExecContext(ctx, migrationUp(t, "../../migrations/009_create_bus_stops.sql")); err != nil {
		t.Fatalf("apply migration 008 Up: %v", err)
	}

	return NewBusRepository(conn, conn)
}

// migrationUp returns the SQL between a goose file's "-- +goose Up" and
// "-- +goose Down" markers.
func migrationUp(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	s := string(b)
	up := strings.Index(s, "-- +goose Up")
	down := strings.Index(s, "-- +goose Down")
	if up < 0 || down < up {
		t.Fatalf("%s: missing goose Up/Down markers", path)
	}
	return s[up+len("-- +goose Up") : down]
}

// Fixture stops around Hotel Grand Pacific (01012, LTA's own sample
// coordinates). One degree of latitude is ~111,195 m for the haversine
// radius used here, so the offsets below give the commented distances.
var fixtureStops = []model.BusStop{
	{Code: "01012", RoadName: "Victoria St", Description: "Hotel Grand Pacific", Latitude: 1.29685, Longitude: 103.853}, // 0 m
	{Code: "01013", RoadName: "Victoria St", Description: "St. Joseph's Ch", Latitude: 1.29865, Longitude: 103.853},     // ~200 m
	{Code: "01019", RoadName: "Victoria St", Description: "Bras Basah Cplx", Latitude: 1.30045, Longitude: 103.853},     // ~400 m
	{Code: "01029", RoadName: "Victoria St", Description: "Just Outside", Latitude: 1.30135, Longitude: 103.853},        // ~500.4 m — excluded
	{Code: "01039", RoadName: "Bras Basah Rd", Description: "100% Plaza", Latitude: 1.29685, Longitude: 103.857},        // ~445 m
	{Code: "02049", RoadName: "Beach Rd", Description: "Opp Under_Score Bldg", Latitude: 1.31000, Longitude: 103.870},   // far
	{Code: "83139", RoadName: "Upp Changi Rd", Description: "Victoria Sch", Latitude: 1.33000, Longitude: 103.950},      // far
}

func seedStops(t *testing.T, repo *BusRepository) {
	t.Helper()
	if err := repo.ReplaceStops(context.Background(), fixtureStops); err != nil {
		t.Fatalf("ReplaceStops: %v", err)
	}
}

func stopCodes[T any](items []T, code func(T) string) []string {
	out := make([]string, len(items))
	for i, it := range items {
		out[i] = code(it)
	}
	return out
}

func nearbyCode(s model.NearbyStop) string { return s.Code }
func stopCode(s model.BusStop) string      { return s.Code }

func TestBusRepositoryNearestStops(t *testing.T) {
	repo := newTestBusRepository(t)
	seedStops(t, repo)
	ctx := context.Background()

	got, err := repo.NearestStops(ctx, 1.29685, 103.853, 500, 10)
	if err != nil {
		t.Fatalf("NearestStops: %v", err)
	}
	want := []string{"01012", "01013", "01019", "01039"}
	if fmt.Sprint(stopCodes(got, nearbyCode)) != fmt.Sprint(want) {
		t.Fatalf("NearestStops codes = %v, want %v (nearest first, 01029 just outside 500 m)", stopCodes(got, nearbyCode), want)
	}

	wantDist := []int{0, 200, 400, 445}
	for i, s := range got {
		if d := s.DistanceMeters - wantDist[i]; d < -2 || d > 2 {
			t.Errorf("%s DistanceMeters = %d, want ~%d", s.Code, s.DistanceMeters, wantDist[i])
		}
	}
	if got[0].Description != "Hotel Grand Pacific" || got[0].RoadName != "Victoria St" {
		t.Errorf("first stop fields = %+v", got[0].BusStop)
	}

	limited, err := repo.NearestStops(ctx, 1.29685, 103.853, 500, 2)
	if err != nil {
		t.Fatalf("NearestStops limit 2: %v", err)
	}
	if fmt.Sprint(stopCodes(limited, nearbyCode)) != fmt.Sprint([]string{"01012", "01013"}) {
		t.Errorf("limit 2 codes = %v", stopCodes(limited, nearbyCode))
	}

	none, err := repo.NearestStops(ctx, 1.40, 103.80, 500, 5)
	if err != nil {
		t.Fatalf("NearestStops empty area: %v", err)
	}
	if len(none) != 0 {
		t.Errorf("empty area returned %v", stopCodes(none, nearbyCode))
	}
}

func TestBusRepositoryGetStop(t *testing.T) {
	repo := newTestBusRepository(t)
	seedStops(t, repo)
	ctx := context.Background()

	s, found, err := repo.GetStop(ctx, "01012")
	if err != nil || !found {
		t.Fatalf("GetStop(01012) = found %v, err %v", found, err)
	}
	if s.Code != "01012" || s.Description != "Hotel Grand Pacific" || s.Latitude != 1.29685 || s.Longitude != 103.853 {
		t.Errorf("GetStop(01012) = %+v", s)
	}

	_, found, err = repo.GetStop(ctx, "99999")
	if err != nil || found {
		t.Errorf("GetStop(99999) = found %v, err %v; want not found, nil error", found, err)
	}
}

func TestBusRepositorySearchStops(t *testing.T) {
	repo := newTestBusRepository(t)
	seedStops(t, repo)
	ctx := context.Background()

	cases := []struct {
		name  string
		query string
		limit int
		want  []string
	}{
		{"code prefix", "0101", 10, []string{"01012", "01013", "01019"}},
		{"full code", "83139", 10, []string{"83139"}},
		{"code prefix limit", "01", 2, []string{"01012", "01013"}},
		{"name case-insensitive", "grand pacific", 10, []string{"01012"}},
		// "Victoria Sch" starts with the query, so it sorts before stops
		// that only match on road name.
		{"road or description, starts-with first", "victoria", 10, []string{"83139", "01019", "01012", "01029", "01013"}},
		{"percent is literal", "%", 10, []string{"01039"}},
		{"underscore is literal", "_", 10, []string{"02049"}},
		{"backslash is literal", `\`, 10, nil},
		{"no match", "nowhere", 10, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := repo.SearchStops(ctx, tc.query, tc.limit)
			if err != nil {
				t.Fatalf("SearchStops(%q): %v", tc.query, err)
			}
			if fmt.Sprint(stopCodes(got, stopCode)) != fmt.Sprint(tc.want) {
				t.Errorf("SearchStops(%q) = %v, want %v", tc.query, stopCodes(got, stopCode), tc.want)
			}
		})
	}
}

func TestBusRepositoryServiceHoursAtStop(t *testing.T) {
	repo := newTestBusRepository(t)
	ctx := context.Background()

	routes := []model.BusRoute{
		{ServiceNo: "7", Operator: "SBST", Direction: 1, StopSequence: 3, BusStopCode: "01012", DistanceKm: 1.2,
			WDFirstBus: "0530", WDLastBus: "2350", SATFirstBus: "0600", SATLastBus: "2330"},
		// Same service, other direction, later in the ordering: DISTINCT ON
		// keeps direction 1's row when it has times for the day type, and
		// falls back to this row when it doesn't (Sunday below).
		{ServiceNo: "7", Operator: "SBST", Direction: 2, StopSequence: 1, BusStopCode: "01012", DistanceKm: 0,
			WDFirstBus: "0700", WDLastBus: "2200", SATFirstBus: "0700", SATLastBus: "2200", SUNFirstBus: "0700", SUNLastBus: "2200"},
		{ServiceNo: "12", Operator: "GAS", Direction: 1, StopSequence: 10, BusStopCode: "01012", DistanceKm: 5.5,
			WDFirstBus: "0600", WDLastBus: "0030", SATFirstBus: "0600", SATLastBus: "0030", SUNFirstBus: "0630", SUNLastBus: "0030"},
		{ServiceNo: "225G", Operator: "SBST", Direction: 1, StopSequence: 2, BusStopCode: "01013", DistanceKm: 0.4,
			WDFirstBus: "0545", WDLastBus: "2400"},
	}
	if err := repo.ReplaceRoutes(ctx, routes); err != nil {
		t.Fatalf("ReplaceRoutes: %v", err)
	}

	cases := []struct {
		day  model.DayType
		want []model.ServiceHours
	}{
		{model.DayWeekday, []model.ServiceHours{{ServiceNo: "12", FirstBus: "0600", LastBus: "0030"}, {ServiceNo: "7", FirstBus: "0530", LastBus: "2350"}}},
		{model.DaySaturday, []model.ServiceHours{{ServiceNo: "12", FirstBus: "0600", LastBus: "0030"}, {ServiceNo: "7", FirstBus: "0600", LastBus: "2330"}}},
		// Service 7 direction 1 has no Sunday times, so direction 2's are used.
		{model.DaySunday, []model.ServiceHours{{ServiceNo: "12", FirstBus: "0630", LastBus: "0030"}, {ServiceNo: "7", FirstBus: "0700", LastBus: "2200"}}},
	}
	for _, tc := range cases {
		got, err := repo.ServiceHoursAtStop(ctx, "01012", tc.day)
		if err != nil {
			t.Fatalf("ServiceHoursAtStop(%s): %v", tc.day, err)
		}
		if fmt.Sprint(got) != fmt.Sprint(tc.want) {
			t.Errorf("ServiceHoursAtStop(01012, %s) = %v, want %v", tc.day, got, tc.want)
		}
	}

	// No visit has times for the day type: NULL → "".
	sat, err := repo.ServiceHoursAtStop(ctx, "01013", model.DaySaturday)
	if err != nil || fmt.Sprint(sat) != fmt.Sprint([]model.ServiceHours{{ServiceNo: "225G"}}) {
		t.Errorf("ServiceHoursAtStop(01013, SAT) = %v, %v; want [{225G  }]", sat, err)
	}

	empty, err := repo.ServiceHoursAtStop(ctx, "99999", model.DayWeekday)
	if err != nil || len(empty) != 0 {
		t.Errorf("ServiceHoursAtStop(unknown stop) = %v, %v", empty, err)
	}

	if _, err := repo.ServiceHoursAtStop(ctx, "01012", model.DayType("HOL")); err == nil {
		t.Error("ServiceHoursAtStop with unknown day type: want error, got nil")
	}
}

func TestBusRepositoryStopDescriptionsAndCounts(t *testing.T) {
	repo := newTestBusRepository(t)
	ctx := context.Background()

	if n, err := repo.CountStops(ctx); err != nil || n != 0 {
		t.Fatalf("CountStops on empty table = %d, %v", n, err)
	}
	seedStops(t, repo)

	if n, err := repo.CountStops(ctx); err != nil || n != len(fixtureStops) {
		t.Errorf("CountStops = %d, %v; want %d", n, err, len(fixtureStops))
	}

	got, err := repo.StopDescriptions(ctx, []string{"01012", "83139", "99999"})
	if err != nil {
		t.Fatalf("StopDescriptions: %v", err)
	}
	want := map[string]string{"01012": "Hotel Grand Pacific", "83139": "Victoria Sch"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("StopDescriptions = %v, want %v", got, want)
	}

	emptyMap, err := repo.StopDescriptions(ctx, nil)
	if err != nil || len(emptyMap) != 0 {
		t.Errorf("StopDescriptions(nil) = %v, %v", emptyMap, err)
	}

	if n, err := repo.CountRoutes(ctx); err != nil || n != 0 {
		t.Errorf("CountRoutes on empty table = %d, %v", n, err)
	}
}

func TestBusRepositoryReplaceStopsIsAtomic(t *testing.T) {
	repo := newTestBusRepository(t)
	seedStops(t, repo)
	ctx := context.Background()

	// Full replacement: old rows gone, new rows present.
	replacement := []model.BusStop{
		{Code: "11111", RoadName: "New Rd", Description: "New Stop", Latitude: 1.30, Longitude: 103.80},
	}
	if err := repo.ReplaceStops(ctx, replacement); err != nil {
		t.Fatalf("ReplaceStops: %v", err)
	}
	if n, _ := repo.CountStops(ctx); n != 1 {
		t.Fatalf("CountStops after replace = %d, want 1", n)
	}
	if _, found, _ := repo.GetStop(ctx, "01012"); found {
		t.Error("old stop 01012 still present after ReplaceStops")
	}

	// A row violating a CHECK fails the whole transaction: the previous
	// table contents survive untouched.
	bad := []model.BusStop{
		{Code: "22222", RoadName: "Ok Rd", Description: "Ok", Latitude: 1.30, Longitude: 103.80},
		{Code: "ABCDE", RoadName: "Bad Rd", Description: "Bad code", Latitude: 1.30, Longitude: 103.80},
	}
	if err := repo.ReplaceStops(ctx, bad); err == nil {
		t.Fatal("ReplaceStops with invalid code: want error, got nil")
	}
	if n, _ := repo.CountStops(ctx); n != 1 {
		t.Errorf("CountStops after failed replace = %d, want 1 (rolled back)", n)
	}
	if _, found, _ := repo.GetStop(ctx, "11111"); !found {
		t.Error("stop 11111 lost after failed ReplaceStops")
	}
	if _, found, _ := repo.GetStop(ctx, "22222"); found {
		t.Error("stop 22222 from the failed batch was committed")
	}
}

func TestBusRepositoryReplaceRoutesChunksAndRollsBack(t *testing.T) {
	repo := newTestBusRepository(t)
	ctx := context.Background()

	// 2500 rows spans three INSERT chunks of insertChunkRows.
	routes := make([]model.BusRoute, 2500)
	for i := range routes {
		routes[i] = model.BusRoute{ServiceNo: "S1", Operator: "SBST", Direction: 1, StopSequence: i + 1,
			BusStopCode: "01012", DistanceKm: float64(i) / 10, WDFirstBus: "0530", WDLastBus: "2350"}
	}
	if err := repo.ReplaceRoutes(ctx, routes); err != nil {
		t.Fatalf("ReplaceRoutes 2500 rows: %v", err)
	}
	if n, err := repo.CountRoutes(ctx); err != nil || n != 2500 {
		t.Fatalf("CountRoutes = %d, %v; want 2500", n, err)
	}

	// An invalid HHMM ("2460") fails the batch; the 2500 rows survive.
	bad := []model.BusRoute{
		{ServiceNo: "9", Operator: "SBST", Direction: 1, StopSequence: 1, BusStopCode: "01012", WDFirstBus: "2460"},
	}
	if err := repo.ReplaceRoutes(ctx, bad); err == nil {
		t.Fatal("ReplaceRoutes with invalid time: want error, got nil")
	}
	if n, _ := repo.CountRoutes(ctx); n != 2500 {
		t.Errorf("CountRoutes after failed replace = %d, want 2500 (rolled back)", n)
	}

	// Replacing with a smaller set removes the rest.
	if err := repo.ReplaceRoutes(ctx, routes[:3]); err != nil {
		t.Fatalf("ReplaceRoutes 3 rows: %v", err)
	}
	if n, _ := repo.CountRoutes(ctx); n != 3 {
		t.Errorf("CountRoutes after shrinking replace = %d, want 3", n)
	}
}

func TestBusRepositoryRouteTermini(t *testing.T) {
	repo := newTestBusRepository(t)
	ctx := context.Background()

	if err := repo.ReplaceStops(ctx, []model.BusStop{
		{Code: "01019", RoadName: "Victoria St", Description: "Bras Basah Cplx", Latitude: 1.297, Longitude: 103.853},
		{Code: "02089", RoadName: "Raffles Blvd", Description: "Promenade Stn/Pan Pacific", Latitude: 1.293, Longitude: 103.860},
		{Code: "46009", RoadName: "Woodlands Sq", Description: "Woodlands Int", Latitude: 1.437, Longitude: 103.786},
	}); err != nil {
		t.Fatal(err)
	}
	if err := repo.ReplaceRoutes(ctx, []model.BusRoute{
		// 960 serves 01019 in direction 1 only; that direction ends at 02089.
		{ServiceNo: "960", Operator: "SMRT", Direction: 1, StopSequence: 46, BusStopCode: "01019"},
		{ServiceNo: "960", Operator: "SMRT", Direction: 1, StopSequence: 48, BusStopCode: "02089"},
		{ServiceNo: "960", Operator: "SMRT", Direction: 2, StopSequence: 48, BusStopCode: "46009"},
		// 7 serves 01019 in both directions: ambiguous, left out.
		{ServiceNo: "7", Operator: "SBST", Direction: 1, StopSequence: 10, BusStopCode: "01019"},
		{ServiceNo: "7", Operator: "SBST", Direction: 1, StopSequence: 20, BusStopCode: "02089"},
		{ServiceNo: "7", Operator: "SBST", Direction: 2, StopSequence: 5, BusStopCode: "01019"},
		{ServiceNo: "7", Operator: "SBST", Direction: 2, StopSequence: 30, BusStopCode: "46009"},
	}); err != nil {
		t.Fatal(err)
	}

	got, err := repo.RouteTermini(ctx, "01019", []string{"960", "7", "999"})
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(got) != fmt.Sprint(map[string]string{"960": "Promenade Stn/Pan Pacific"}) {
		t.Errorf("RouteTermini = %v, want only 960 → Promenade Stn/Pan Pacific", got)
	}
	if empty, err := repo.RouteTermini(ctx, "01019", nil); err != nil || len(empty) != 0 {
		t.Errorf("RouteTermini(no services) = %v, %v", empty, err)
	}
}

func TestBusRepositoryRouteThroughStop(t *testing.T) {
	repo := newTestBusRepository(t)
	ctx := context.Background()
	if err := repo.ReplaceStops(ctx, []model.BusStop{
		{Code: "96161", RoadName: "Simei St 3", Description: "Opp Simei Stn", Latitude: 1.34212, Longitude: 103.95354},
		{Code: "96151", RoadName: "Simei St 1", Description: "Blk 106", Latitude: 1.34233, Longitude: 103.95121},
		{Code: "75009", RoadName: "Tampines Ctrl 1", Description: "Tampines Int", Latitude: 1.35408, Longitude: 103.94339},
	}); err != nil {
		t.Fatal(err)
	}
	if err := repo.ReplaceRoutes(ctx, []model.BusRoute{
		{ServiceNo: "20", Operator: "SBST", Direction: 1, StopSequence: 34, BusStopCode: "96161", DistanceKm: 10.1},
		{ServiceNo: "20", Operator: "SBST", Direction: 1, StopSequence: 35, BusStopCode: "96151", DistanceKm: 10.4},
		{ServiceNo: "20", Operator: "SBST", Direction: 1, StopSequence: 36, BusStopCode: "46239", DistanceKm: 12.0}, // not in bus_stops
		{ServiceNo: "20", Operator: "SBST", Direction: 1, StopSequence: 44, BusStopCode: "75009", DistanceKm: 14.9},
		// direction 2 doesn't call at 96151: excluded
		{ServiceNo: "20", Operator: "SBST", Direction: 2, StopSequence: 1, BusStopCode: "75009", DistanceKm: 0},
		// another service at the same stop: excluded
		{ServiceNo: "38", Operator: "SBST", Direction: 1, StopSequence: 1, BusStopCode: "96151", DistanceKm: 0},
	}); err != nil {
		t.Fatal(err)
	}

	got, err := repo.RouteThroughStop(ctx, "96151", "20")
	if err != nil {
		t.Fatal(err)
	}
	var seq []string
	for _, r := range got {
		seq = append(seq, fmt.Sprintf("%d:%d:%s:%s:%v:%.1f", r.Direction, r.StopSequence, r.Stop.Code, r.Stop.Name, r.Stop.HasPosition, r.Stop.KmFromBoarding))
	}
	want := []string{"1:34:96161:Opp Simei Stn:true:10.1", "1:35:96151:Blk 106:true:10.4", "1:36:46239::false:12.0", "1:44:75009:Tampines Int:true:14.9"}
	if strings.Join(seq, " | ") != strings.Join(want, " | ") {
		t.Errorf("rows =\n%v\nwant\n%v", seq, want)
	}
	if none, err := repo.RouteThroughStop(ctx, "96151", "999"); err != nil || len(none) != 0 {
		t.Errorf("unknown service = %v, %v", none, err)
	}
}
