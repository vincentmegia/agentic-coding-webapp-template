package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vincentmegia/vincentmegia/internal/lta"
	"github.com/vincentmegia/vincentmegia/internal/model"
	"github.com/vincentmegia/vincentmegia/internal/onemap"
)

// ---- fakes ----

type fakeBusRepo struct {
	mu          sync.Mutex
	stops       map[string]model.BusStop
	hours       map[string][]model.ServiceHours // code → rows (returned in insertion order)
	descs       map[string]string
	termini     map[string]string // serviceNo → route terminus description
	routeRows   map[string][]model.RouteRow
	stopCount   int
	routeCount  int
	nearestArgs []any
	searchArgs  []any
	hoursDay    model.DayType
	calls       []string
	replaced    struct {
		stops  []model.BusStop
		routes []model.BusRoute
	}
	replaceErr error
}

func newFakeBusRepo() *fakeBusRepo {
	return &fakeBusRepo{stops: map[string]model.BusStop{}, hours: map[string][]model.ServiceHours{}, descs: map[string]string{}}
}

func (f *fakeBusRepo) record(c string) { f.mu.Lock(); f.calls = append(f.calls, c); f.mu.Unlock() }

func (f *fakeBusRepo) NearestStops(_ context.Context, lat, lng float64, r, l int) ([]model.NearbyStop, error) {
	f.record("NearestStops")
	f.nearestArgs = []any{lat, lng, r, l}
	return []model.NearbyStop{{BusStop: model.BusStop{Code: "01012"}, DistanceMeters: 90}}, nil
}
func (f *fakeBusRepo) GetStop(_ context.Context, code string) (model.BusStop, bool, error) {
	f.record("GetStop")
	s, ok := f.stops[code]
	return s, ok, nil
}
func (f *fakeBusRepo) SearchStops(_ context.Context, q string, l int) ([]model.BusStop, error) {
	f.record("SearchStops")
	f.searchArgs = []any{q, l}
	return nil, nil
}
func (f *fakeBusRepo) ServiceHoursAtStop(_ context.Context, code string, d model.DayType) ([]model.ServiceHours, error) {
	f.mu.Lock()
	f.hoursDay = d
	f.mu.Unlock()
	return f.hours[code], nil
}
func (f *fakeBusRepo) RouteThroughStop(_ context.Context, code, serviceNo string) ([]model.RouteRow, error) {
	f.record("RouteThroughStop")
	return f.routeRows[serviceNo], nil
}

func (f *fakeBusRepo) RouteTermini(_ context.Context, _ string, services []string) (map[string]string, error) {
	out := map[string]string{}
	for _, s := range services {
		if d, ok := f.termini[s]; ok {
			out[s] = d
		}
	}
	return out, nil
}

func (f *fakeBusRepo) StopDescriptions(_ context.Context, codes []string) (map[string]string, error) {
	out := map[string]string{}
	for _, c := range codes {
		if d, ok := f.descs[c]; ok {
			out[c] = d
		}
	}
	return out, nil
}
func (f *fakeBusRepo) CountStops(context.Context) (int, error)  { return f.stopCount, nil }
func (f *fakeBusRepo) CountRoutes(context.Context) (int, error) { return f.routeCount, nil }
func (f *fakeBusRepo) ReplaceStops(_ context.Context, s []model.BusStop) error {
	f.record("ReplaceStops")
	if f.replaceErr != nil {
		return f.replaceErr
	}
	f.replaced.stops = s
	return nil
}
func (f *fakeBusRepo) ReplaceRoutes(_ context.Context, r []model.BusRoute) error {
	f.record("ReplaceRoutes")
	f.replaced.routes = r
	return nil
}

type fakeLTA struct {
	arrivalCalls int32
	arrival      func(code string) (lta.BusArrivalResponse, error)
	stopsCalls   int32
	stopsSkips   []int
	stopsPage    func(skip int) []lta.BusStopRecord
	routesPage   func(skip int) []lta.BusRouteRecord
	routesErr    error
}

func (f *fakeLTA) BusArrival(_ context.Context, code string) (lta.BusArrivalResponse, error) {
	atomic.AddInt32(&f.arrivalCalls, 1)
	return f.arrival(code)
}
func (f *fakeLTA) BusStops(_ context.Context, skip int) ([]lta.BusStopRecord, error) {
	atomic.AddInt32(&f.stopsCalls, 1)
	f.stopsSkips = append(f.stopsSkips, skip)
	return f.stopsPage(skip), nil
}
func (f *fakeLTA) BusRoutes(_ context.Context, skip int) ([]lta.BusRouteRecord, error) {
	if f.routesErr != nil {
		return nil, f.routesErr
	}
	return f.routesPage(skip), nil
}

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) Now() time.Time          { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) Advance(d time.Duration) { c.mu.Lock(); c.t = c.t.Add(d); c.mu.Unlock() }

func ts(t time.Time) string { return t.Format(time.RFC3339) }

func newTestService(repo *fakeBusRepo, client ltaClient, clk *clock) *BusService {
	return NewBusService(repo, client, BusServiceOptions{Now: clk.Now})
}

// ---- Nearby / Search ----

func TestBusNearbyRoundsAndFixesRadius(t *testing.T) {
	repo := newFakeBusRepo()
	s := NewBusService(repo, nil, BusServiceOptions{})
	if _, err := s.Nearby(context.Background(), 1.29685, 103.85349); err != nil {
		t.Fatal(err)
	}
	want := []any{1.297, 103.853, 500, 5}
	if fmt.Sprint(repo.nearestArgs) != fmt.Sprint(want) {
		t.Errorf("args = %v want %v", repo.nearestArgs, want)
	}
}

func TestBusNearbyInvalidSkipsRepo(t *testing.T) {
	repo := newFakeBusRepo()
	s := NewBusService(repo, nil, BusServiceOptions{})
	if _, err := s.Nearby(context.Background(), 51.5, 0); !errors.Is(err, ErrBusOutsideSingapore) {
		t.Errorf("err = %v", err)
	}
	if len(repo.calls) != 0 {
		t.Errorf("repo called: %v", repo.calls)
	}
}

func TestBusSearch(t *testing.T) {
	repo := newFakeBusRepo()
	s := NewBusService(repo, nil, BusServiceOptions{})
	if _, err := s.Search(context.Background(), "  victoria "); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(repo.searchArgs) != "[victoria 10]" {
		t.Errorf("args = %v", repo.searchArgs)
	}
	if _, err := s.Search(context.Background(), "v"); !errors.Is(err, ErrBusSearchQueryInvalid) {
		t.Errorf("err = %v", err)
	}
}

// ---- Arrivals: validation ----

func TestBusArrivalsInvalidCodeNoCalls(t *testing.T) {
	repo := newFakeBusRepo()
	f := &fakeLTA{arrival: func(string) (lta.BusArrivalResponse, error) { return lta.BusArrivalResponse{}, nil }}
	s := newTestService(repo, f, &clock{t: at(12, 0)})
	if _, err := s.Arrivals(context.Background(), "1012x"); !errors.Is(err, ErrBusStopCodeInvalid) {
		t.Errorf("err = %v", err)
	}
	if len(repo.calls) != 0 || f.arrivalCalls != 0 {
		t.Errorf("calls made: repo=%v lta=%d", repo.calls, f.arrivalCalls)
	}
}

func TestBusArrivalsUnknownStopNoLTACall(t *testing.T) {
	repo := newFakeBusRepo()
	f := &fakeLTA{arrival: func(string) (lta.BusArrivalResponse, error) { return lta.BusArrivalResponse{}, nil }}
	s := newTestService(repo, f, &clock{t: at(12, 0)})
	if _, err := s.Arrivals(context.Background(), "99999"); !errors.Is(err, ErrBusStopNotFound) {
		t.Errorf("err = %v", err)
	}
	if f.arrivalCalls != 0 {
		t.Errorf("LTA called %d times for unknown stop", f.arrivalCalls)
	}
}

func TestBusArrivalsNoClient(t *testing.T) {
	repo := newFakeBusRepo()
	repo.stops["01012"] = model.BusStop{Code: "01012"}
	s := NewBusService(repo, nil, BusServiceOptions{})
	if _, err := s.Arrivals(context.Background(), "01012"); !errors.Is(err, ErrBusArrivalsUnavailable) {
		t.Errorf("err = %v", err)
	}
	var nilClient *lta.Client
	s2 := NewBusService(repo, nilClient, BusServiceOptions{})
	if _, err := s2.Arrivals(context.Background(), "01012"); !errors.Is(err, ErrBusArrivalsUnavailable) {
		t.Errorf("typed nil: err = %v", err)
	}
	if _, err := s2.Sync(context.Background()); !errors.Is(err, ErrBusLTANotConfigured) {
		t.Errorf("sync err = %v", err)
	}
}

// ---- Arrivals: content ----

func TestBusArrivalsBuildsBoard(t *testing.T) {
	now := at(12, 0) // Monday noon SGT
	clk := &clock{t: now}
	repo := newFakeBusRepo()
	repo.stops["01012"] = model.BusStop{Code: "01012", Description: "Hotel Grand Pacific"}
	repo.descs["17009"] = "Clementi Int"
	// Plain text order, as the repository returns it.
	repo.hours["01012"] = []model.ServiceHours{
		{ServiceNo: "12", FirstBus: "0600", LastBus: "2300"},
		{ServiceNo: "225G", FirstBus: "0530", LastBus: "0030"},
		{ServiceNo: "61", FirstBus: "0000", LastBus: "2359"}, // in hours, no data
		{ServiceNo: "7", FirstBus: "1300", LastBus: "1400"},  // live data outside hours
		{ServiceNo: "960", FirstBus: "0500", LastBus: "0501"},
	}
	f := &fakeLTA{arrival: func(string) (lta.BusArrivalResponse, error) {
		return lta.BusArrivalResponse{Services: []lta.ServiceArrival{
			{ServiceNo: "7", Operator: "SBST",
				NextBus:  lta.NextBus{EstimatedArrival: ts(now.Add(30 * time.Second)), Monitored: 1, Load: "SEA", Feature: "WAB", Type: "DD", DestinationCode: "17009"},
				NextBus2: lta.NextBus{EstimatedArrival: ts(now.Add(8*time.Minute + 50*time.Second)), Monitored: 1, Load: "SDA", Type: "DD"},
				NextBus3: lta.NextBus{EstimatedArrival: ts(now.Add(17 * time.Minute)), Monitored: 0, Load: "LSD", Type: "DD"}},
			{ServiceNo: "12", Operator: "GAS",
				NextBus:  lta.NextBus{EstimatedArrival: ts(now.Add(3 * time.Minute)), Monitored: 1, Load: "XXX", Type: "SD"},
				NextBus2: lta.NextBus{EstimatedArrival: ""},
				NextBus3: lta.NextBus{EstimatedArrival: "garbage"}},
			{ServiceNo: "2", Operator: "SBST", NextBus: lta.NextBus{EstimatedArrival: ts(now.Add(-20 * time.Second)), Type: "BD"}},
		}}, nil
	}}
	s := newTestService(repo, f, clk)
	got, err := s.Arrivals(context.Background(), "01012")
	if err != nil {
		t.Fatal(err)
	}
	if repo.hoursDay != model.DayWeekday {
		t.Errorf("day = %s", repo.hoursDay)
	}
	var order []string
	byNo := map[string]model.ServiceArrivals{}
	for _, sa := range got.Services {
		order = append(order, sa.ServiceNo)
		byNo[sa.ServiceNo] = sa
	}
	if fmt.Sprint(order) != "[2 7 12 61 225G 960]" {
		t.Errorf("order = %v", order)
	}

	s7 := byNo["7"]
	if s7.Status != model.StatusLive || len(s7.NextBuses) != 3 || s7.Destination != "Clementi Int" || s7.FirstBus != "1300" {
		t.Errorf("7 = %+v", s7)
	}
	if b := s7.NextBuses[0]; b.Label != "Arr" || !b.IsArriving || !b.Monitored || b.Load != model.LoadSeats || !b.WheelchairAccess || b.Type != "DD" {
		t.Errorf("7[0] = %+v", b)
	}
	if b := s7.NextBuses[1]; b.Label != "8" || b.Load != model.LoadStanding {
		t.Errorf("7[1] = %+v", b)
	}
	if b := s7.NextBuses[2]; b.Label != "17" || b.Monitored || b.Load != model.LoadLimited {
		t.Errorf("7[2] = %+v", b)
	}
	if s12 := byNo["12"]; len(s12.NextBuses) != 1 || s12.NextBuses[0].Load != "" || s12.Operator != "GAS" {
		t.Errorf("12 = %+v", s12)
	}
	if b := byNo["2"].NextBuses[0]; b.Label != "Arr" || b.Type != "BD" {
		t.Errorf("2 = %+v", b)
	}
	if byNo["61"].Status != model.StatusNoEstimate {
		t.Errorf("61 = %+v", byNo["61"])
	}
	if byNo["960"].Status != model.StatusNotInOperation || byNo["960"].FirstBus != "0500" {
		t.Errorf("960 = %+v", byNo["960"])
	}
	if byNo["225G"].Status != model.StatusNoEstimate {
		t.Errorf("225G = %+v", byNo["225G"])
	}
	if got.Stale || !got.FetchedAt.Equal(now) || got.Stop.Description != "Hotel Grand Pacific" {
		t.Errorf("meta = %+v", got)
	}
}

func TestBusArrivalsSaturdayHours(t *testing.T) {
	clk := &clock{t: time.Date(2026, 10, 2, 17, 0, 0, 0, time.UTC)} // Sat 01:00 SGT
	repo := newFakeBusRepo()
	repo.stops["01012"] = model.BusStop{Code: "01012"}
	f := &fakeLTA{arrival: func(string) (lta.BusArrivalResponse, error) { return lta.BusArrivalResponse{}, nil }}
	if _, err := newTestService(repo, f, clk).Arrivals(context.Background(), "01012"); err != nil {
		t.Fatal(err)
	}
	if repo.hoursDay != model.DaySaturday {
		t.Errorf("day = %s", repo.hoursDay)
	}
}

// ---- Arrivals: cache, singleflight, stale, budget ----

func liveFake(now func() time.Time) *fakeLTA {
	return &fakeLTA{arrival: func(string) (lta.BusArrivalResponse, error) {
		return lta.BusArrivalResponse{Services: []lta.ServiceArrival{{ServiceNo: "7",
			NextBus: lta.NextBus{EstimatedArrival: ts(time.Date(2026, 10, 5, 12, 5, 0, 0, sgt)), Monitored: 1}}}}, nil
	}}
}

func TestBusArrivalsCacheTTL(t *testing.T) {
	clk := &clock{t: at(12, 0)}
	repo := newFakeBusRepo()
	repo.stops["01012"] = model.BusStop{Code: "01012"}
	f := liveFake(clk.Now)
	s := newTestService(repo, f, clk)

	first, _ := s.Arrivals(context.Background(), "01012")
	clk.Advance(19 * time.Second)
	second, _ := s.Arrivals(context.Background(), "01012")
	if f.arrivalCalls != 1 {
		t.Fatalf("calls within TTL = %d, want 1", f.arrivalCalls)
	}
	if first.Services[0].NextBuses[0].Label != "5" || second.Services[0].NextBuses[0].Label != "4" {
		t.Errorf("labels not recomputed on cache hit: %s → %s", first.Services[0].NextBuses[0].Label, second.Services[0].NextBuses[0].Label)
	}
	clk.Advance(2 * time.Second) // 21 s after fetch
	s.Arrivals(context.Background(), "01012")
	if f.arrivalCalls != 2 {
		t.Errorf("calls after TTL = %d, want 2", f.arrivalCalls)
	}
}

func TestBusArrivalsSingleflight(t *testing.T) {
	clk := &clock{t: at(12, 0)}
	repo := newFakeBusRepo()
	repo.stops["01012"] = model.BusStop{Code: "01012"}
	release := make(chan struct{})
	started := make(chan struct{}, 1)
	f := &fakeLTA{arrival: func(string) (lta.BusArrivalResponse, error) {
		select {
		case started <- struct{}{}:
		default:
		}
		<-release
		return lta.BusArrivalResponse{}, nil
	}}
	s := newTestService(repo, f, clk)

	const n = 20
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := s.Arrivals(context.Background(), "01012")
			errs <- err
		}()
	}
	<-started
	time.Sleep(50 * time.Millisecond) // let the rest pile onto the flight
	close(release)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Errorf("err = %v", err)
		}
	}
	if f.arrivalCalls != 1 {
		t.Errorf("LTA calls = %d, want 1", f.arrivalCalls)
	}
}

func TestBusArrivalsStaleThenUnavailable(t *testing.T) {
	clk := &clock{t: at(12, 0)}
	t0 := clk.Now()
	repo := newFakeBusRepo()
	repo.stops["01012"] = model.BusStop{Code: "01012"}
	fail := false
	f := &fakeLTA{arrival: func(string) (lta.BusArrivalResponse, error) {
		if fail {
			return lta.BusArrivalResponse{}, errors.New("upstream 500")
		}
		return lta.BusArrivalResponse{}, nil
	}}
	s := newTestService(repo, f, clk)
	if _, err := s.Arrivals(context.Background(), "01012"); err != nil {
		t.Fatal(err)
	}
	fail = true
	clk.Advance(30 * time.Second)
	got, err := s.Arrivals(context.Background(), "01012")
	if err != nil || !got.Stale || !got.FetchedAt.Equal(t0) {
		t.Fatalf("stale: %+v %v", got, err)
	}
	clk.Advance(90 * time.Second) // exactly 2 min old: still allowed
	if got, err := s.Arrivals(context.Background(), "01012"); err != nil || !got.Stale {
		t.Fatalf("2m: %+v %v", got, err)
	}
	clk.Advance(time.Second)
	if _, err := s.Arrivals(context.Background(), "01012"); !errors.Is(err, ErrBusArrivalsUnavailable) {
		t.Errorf("after stale window err = %v", err)
	}
}

func TestBusArrivalsFailureWithoutCache(t *testing.T) {
	clk := &clock{t: at(12, 0)}
	repo := newFakeBusRepo()
	repo.stops["01012"] = model.BusStop{Code: "01012"}
	f := &fakeLTA{arrival: func(string) (lta.BusArrivalResponse, error) {
		return lta.BusArrivalResponse{}, errors.New("AccountKey=secret leaked?")
	}}
	_, err := newTestService(repo, f, clk).Arrivals(context.Background(), "01012")
	if !errors.Is(err, ErrBusArrivalsUnavailable) || err.Error() != ErrBusArrivalsUnavailable.Error() {
		t.Errorf("err = %v (must be the bare sentinel, no upstream text)", err)
	}
}

func TestBusArrivalsOutboundBudget(t *testing.T) {
	clk := &clock{t: at(12, 0)}
	repo := newFakeBusRepo()
	for _, c := range []string{"00001", "00002", "00003"} {
		repo.stops[c] = model.BusStop{Code: c}
	}
	f := &fakeLTA{arrival: func(string) (lta.BusArrivalResponse, error) { return lta.BusArrivalResponse{}, nil }}
	s := NewBusService(repo, f, BusServiceOptions{Now: clk.Now, OutboundRate: 1, OutboundBurst: 2})
	for _, c := range []string{"00001", "00002"} {
		if _, err := s.Arrivals(context.Background(), c); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.Arrivals(context.Background(), "00003"); !errors.Is(err, ErrBusArrivalsUnavailable) {
		t.Errorf("over budget err = %v", err)
	}
	if f.arrivalCalls != 2 {
		t.Errorf("LTA calls = %d, want 2", f.arrivalCalls)
	}
	clk.Advance(time.Second) // one token refilled
	if _, err := s.Arrivals(context.Background(), "00003"); err != nil {
		t.Errorf("after refill err = %v", err)
	}
}

func TestBusServiceDefaults(t *testing.T) {
	s := NewBusService(newFakeBusRepo(), nil, BusServiceOptions{})
	if s.opts.CacheTTL != 20*time.Second || s.opts.StaleWindow != 2*time.Minute || s.opts.OutboundRate != 5 || s.opts.OutboundBurst != 10 || s.opts.Now == nil {
		t.Errorf("defaults = %+v", s.opts)
	}
}

// ---- Sync ----

func stopRecs(n, offset int) []lta.BusStopRecord {
	out := make([]lta.BusStopRecord, n)
	for i := range out {
		out[i] = lta.BusStopRecord{BusStopCode: fmt.Sprintf("%05d", offset+i), RoadName: "Rd", Description: "Stop", Latitude: 1.3, Longitude: 103.8}
	}
	return out
}

func routeRecs(n, offset int) []lta.BusRouteRecord {
	out := make([]lta.BusRouteRecord, n)
	for i := range out {
		out[i] = lta.BusRouteRecord{ServiceNo: "7", Operator: "SBST", Direction: 1, StopSequence: offset + i, BusStopCode: "01012", WDFirstBus: "0530", WDLastBus: "-"}
	}
	return out
}

func TestBusSyncPaginates(t *testing.T) {
	repo := newFakeBusRepo()
	f := &fakeLTA{
		stopsPage: func(skip int) []lta.BusStopRecord {
			if skip >= 1000 {
				return stopRecs(3, skip)
			}
			return stopRecs(500, skip)
		},
		routesPage: func(skip int) []lta.BusRouteRecord { return routeRecs(10, skip) },
	}
	s := newTestService(repo, f, &clock{t: at(3, 0)})
	res, err := s.Sync(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(f.stopsSkips) != "[0 500 1000]" {
		t.Errorf("skips = %v", f.stopsSkips)
	}
	if res.Stops != 1003 || res.Routes != 10 || len(repo.replaced.stops) != 1003 {
		t.Errorf("res = %+v", res)
	}
	if fmt.Sprint(repo.calls) != "[ReplaceStops ReplaceRoutes]" {
		t.Errorf("order = %v", repo.calls)
	}
	if repo.replaced.routes[0].WDLastBus != "" {
		t.Errorf("'-' should become empty: %+v", repo.replaced.routes[0])
	}
}

func TestBusSyncPageCap(t *testing.T) {
	repo := newFakeBusRepo()
	f := &fakeLTA{stopsPage: func(skip int) []lta.BusStopRecord { return stopRecs(500, 0) },
		routesPage: func(int) []lta.BusRouteRecord { return routeRecs(1, 0) }}
	_, err := newTestService(repo, f, &clock{t: at(3, 0)}).Sync(context.Background())
	if err == nil {
		t.Fatal("expected page-cap error")
	}
	if f.stopsCalls != 200 {
		t.Errorf("calls = %d, want 200", f.stopsCalls)
	}
	if len(repo.calls) != 0 {
		t.Errorf("replaced despite error: %v", repo.calls)
	}
}

func TestBusSyncDropsInvalidRowsAndDuplicates(t *testing.T) {
	repo := newFakeBusRepo()
	f := &fakeLTA{
		stopsPage: func(int) []lta.BusStopRecord {
			return []lta.BusStopRecord{
				{BusStopCode: "01012", RoadName: "Victoria St", Description: "Hotel Grand Pacific", Latitude: 1.29685, Longitude: 103.853},
				{BusStopCode: "01012", RoadName: "dup", Latitude: 1.3, Longitude: 103.8},
				{BusStopCode: "bad", Latitude: 1.3, Longitude: 103.8},
				{BusStopCode: "01013", Latitude: 40.7, Longitude: -74},
			}
		},
		routesPage: func(int) []lta.BusRouteRecord {
			return []lta.BusRouteRecord{
				{ServiceNo: "7", Direction: 1, StopSequence: 1, BusStopCode: "01012", WDFirstBus: "2560"},
				{ServiceNo: "7", Direction: 1, StopSequence: 1, BusStopCode: "01012"},
				{ServiceNo: "7", Direction: 9, StopSequence: 2, BusStopCode: "01012"},
			}
		},
	}
	res, err := newTestService(repo, f, &clock{t: at(3, 0)}).Sync(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if res.Stops != 1 || res.DroppedStops != 3 || res.Routes != 1 || res.DroppedRoutes != 2 {
		t.Errorf("res = %+v", res)
	}
	if repo.replaced.stops[0].RoadName != "Victoria St" || repo.replaced.routes[0].WDFirstBus != "" {
		t.Errorf("replaced = %+v", repo.replaced)
	}
}

func TestBusSyncFiftyPercentGuard(t *testing.T) {
	cases := []struct {
		name               string
		curStops, curRoute int
		newStops           int
		wantErr            bool
	}{
		{"empty table accepts any", 0, 0, 3, false},
		{"zero rows refused", 0, 0, 0, true},
		{"exactly half ok", 100, 0, 50, false},
		{"under half refused", 100, 0, 49, true},
		{"routes under half refused", 0, 100, 10, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			repo := newFakeBusRepo()
			repo.stopCount, repo.routeCount = c.curStops, c.curRoute
			f := &fakeLTA{stopsPage: func(int) []lta.BusStopRecord { return stopRecs(c.newStops, 0) },
				routesPage: func(int) []lta.BusRouteRecord { return routeRecs(10, 0) }}
			_, err := newTestService(repo, f, &clock{t: at(3, 0)}).Sync(context.Background())
			if c.wantErr {
				if !errors.Is(err, ErrBusSyncTooSmall) {
					t.Errorf("err = %v", err)
				}
				if len(repo.calls) != 0 {
					t.Errorf("replaced anyway: %v", repo.calls)
				}
			} else if err != nil {
				t.Errorf("err = %v", err)
			}
		})
	}
}

func TestBusSyncRoutesFetchFailureReplacesNothing(t *testing.T) {
	repo := newFakeBusRepo()
	f := &fakeLTA{stopsPage: func(int) []lta.BusStopRecord { return stopRecs(5, 0) }, routesErr: errors.New("boom")}
	if _, err := newTestService(repo, f, &clock{t: at(3, 0)}).Sync(context.Background()); err == nil {
		t.Fatal("expected error")
	}
	if len(repo.calls) != 0 {
		t.Errorf("replaced: %v", repo.calls)
	}
}

// ---- Scheduler ----

func TestNextDailyRun(t *testing.T) {
	cases := []struct{ now, want time.Time }{
		{time.Date(2026, 10, 5, 2, 0, 0, 0, sgt), time.Date(2026, 10, 5, 3, 0, 0, 0, sgt)},
		{time.Date(2026, 10, 5, 3, 0, 0, 0, sgt), time.Date(2026, 10, 6, 3, 0, 0, 0, sgt)},
		{time.Date(2026, 10, 5, 4, 0, 0, 0, sgt), time.Date(2026, 10, 6, 3, 0, 0, 0, sgt)},
		{time.Date(2026, 10, 4, 20, 0, 0, 0, time.UTC), time.Date(2026, 10, 6, 3, 0, 0, 0, sgt)}, // 04:00 SGT Mon
	}
	for _, c := range cases {
		if got := nextDailyRun(c.now); !got.Equal(c.want) {
			t.Errorf("%v: got %v want %v", c.now, got, c.want)
		}
	}
}

func TestRunSchedulerNilClientReturns(t *testing.T) {
	done := make(chan struct{})
	go func() {
		NewBusService(newFakeBusRepo(), nil, BusServiceOptions{}).RunScheduler(context.Background())
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("RunScheduler with nil client did not return")
	}
}

func TestRunSchedulerSyncsOnEmptyStart(t *testing.T) {
	repo := newFakeBusRepo()
	f := &fakeLTA{stopsPage: func(int) []lta.BusStopRecord { return stopRecs(3, 0) },
		routesPage: func(int) []lta.BusRouteRecord { return routeRecs(3, 0) }}
	s := NewBusService(repo, f, BusServiceOptions{})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { s.RunScheduler(ctx); close(done) }()
	deadline := time.After(2 * time.Second)
	for {
		repo.mu.Lock()
		n := len(repo.calls)
		repo.mu.Unlock()
		if n >= 2 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("startup sync did not run")
		case <-time.After(10 * time.Millisecond):
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("scheduler did not stop on cancel")
	}
}

func TestRunSchedulerSkipsStartupSyncWhenPopulated(t *testing.T) {
	repo := newFakeBusRepo()
	repo.stopCount = 10
	f := &fakeLTA{stopsPage: func(int) []lta.BusStopRecord { return stopRecs(10, 0) },
		routesPage: func(int) []lta.BusRouteRecord { return routeRecs(3, 0) }}
	s := NewBusService(repo, f, BusServiceOptions{})
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	s.RunScheduler(ctx)
	if f.stopsCalls != 0 {
		t.Errorf("synced at start despite populated table")
	}
}

// TestBusArrivalsDuplicateServiceKeepsSoonestThree: LTA can list one
// ServiceNo twice; the merged row is sorted and capped at three buses.
func TestBusArrivalsDuplicateServiceKeepsSoonestThree(t *testing.T) {
	now := at(12, 0)
	repo := newFakeBusRepo()
	repo.stops["01012"] = model.BusStop{Code: "01012"}
	nb := func(m int) lta.NextBus {
		return lta.NextBus{EstimatedArrival: ts(now.Add(time.Duration(m) * time.Minute)), Monitored: 1, Load: "SEA", Type: "SD"}
	}
	f := &fakeLTA{arrival: func(string) (lta.BusArrivalResponse, error) {
		return lta.BusArrivalResponse{Services: []lta.ServiceArrival{
			{ServiceNo: "225G", NextBus: nb(9), NextBus2: nb(20), NextBus3: nb(31)},
			{ServiceNo: "225G", NextBus: nb(4), NextBus2: nb(15)},
		}}, nil
	}}
	got, err := newTestService(repo, f, &clock{t: now}).Arrivals(context.Background(), "01012")
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Services) != 1 {
		t.Fatalf("services = %d, want 1 merged row", len(got.Services))
	}
	var labels []string
	for _, b := range got.Services[0].NextBuses {
		labels = append(labels, b.Label)
	}
	if strings.Join(labels, ",") != "4,9,15" {
		t.Errorf("labels = %v, want [4 9 15]", labels)
	}
}

// TestBusArrivalsDestinationFallsBackToRouteTerminus: LTA's DestinationCode
// can be a terminal code that isn't in BusStops (real case: 960 → "02099");
// the row then names the route's last stop instead.
func TestBusArrivalsDestinationFallsBackToRouteTerminus(t *testing.T) {
	now := at(12, 0)
	repo := newFakeBusRepo()
	repo.stops["01019"] = model.BusStop{Code: "01019"}
	repo.descs["10499"] = "Kampong Bahru Ter"
	repo.termini = map[string]string{"960": "Promenade Stn/Pan Pacific", "14e": "Orchard Stn/Lucky Plaza"}
	// 14e has route hours but no live buses, so no DestinationCode at all.
	repo.hours["01019"] = []model.ServiceHours{{ServiceNo: "14e", FirstBus: "0000", LastBus: "2359"}}
	nb := func(dest string) lta.NextBus {
		return lta.NextBus{EstimatedArrival: ts(now.Add(5 * time.Minute)), Monitored: 1, Load: "SEA", Type: "DD", DestinationCode: dest}
	}
	f := &fakeLTA{arrival: func(string) (lta.BusArrivalResponse, error) {
		return lta.BusArrivalResponse{Services: []lta.ServiceArrival{
			{ServiceNo: "12", NextBus: nb("10499")},
			{ServiceNo: "960", NextBus: nb("02099")},
			{ServiceNo: "2", NextBus: nb("99999")}, // unknown code, no terminus either
		}}, nil
	}}
	got, err := newTestService(repo, f, &clock{t: now}).Arrivals(context.Background(), "01019")
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"12": "Kampong Bahru Ter", "960": "Promenade Stn/Pan Pacific", "2": "", "14e": "Orchard Stn/Lucky Plaza"}
	if len(got.Services) != len(want) {
		t.Fatalf("services = %d, want %d", len(got.Services), len(want))
	}
	for _, sa := range got.Services {
		if sa.Destination != want[sa.ServiceNo] {
			t.Errorf("service %s destination = %q, want %q", sa.ServiceNo, sa.Destination, want[sa.ServiceNo])
		}
	}
}

// ---- Postal-code search ----

type fakeGeocoder struct {
	calls  int32
	places map[string]onemap.Place
	err    error
}

func (g *fakeGeocoder) Geocode(_ context.Context, postal string) (onemap.Place, bool, error) {
	atomic.AddInt32(&g.calls, 1)
	if g.err != nil {
		return onemap.Place{}, false, g.err
	}
	p, ok := g.places[postal]
	return p, ok, nil
}

func TestIsBusPostalCode(t *testing.T) {
	for in, want := range map[string]bool{"520106": true, " 520106 ": true, "01012": false, "5201060": false, "52010a": false, "Victoria": false} {
		if got := IsBusPostalCode(in); got != want {
			t.Errorf("IsBusPostalCode(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestBusSearchPostal(t *testing.T) {
	clk := &clock{t: at(12, 0)}
	repo := newFakeBusRepo()
	geo := &fakeGeocoder{places: map[string]onemap.Place{
		"520106": {Postal: "520106", Label: "106 Simei Street 1", Latitude: 1.341885, Longitude: 103.950833},
		"999001": {Postal: "999001", Label: "Somewhere in Johor", Latitude: 1.5, Longitude: 103.75}, // outside SG bounds
	}}
	s := NewBusService(repo, nil, BusServiceOptions{Now: clk.Now, Geocoder: geo})

	got, err := s.SearchPostal(context.Background(), " 520106 ")
	if err != nil {
		t.Fatal(err)
	}
	if got.Label != "106 Simei Street 1" || got.Postal != "520106" || len(got.Stops) != 1 || got.Latitude != 1.341885 || got.Longitude != 103.950833 {
		t.Errorf("result = %+v", got)
	}
	// Nearby ran on the geocoded point, rounded to 3 dp, fixed 500 m / 5.
	if fmt.Sprint(repo.nearestArgs) != fmt.Sprint([]any{1.342, 103.951, 500, 5}) {
		t.Errorf("nearest args = %v", repo.nearestArgs)
	}

	// Cached for a day: a repeat within 24 h doesn't call OneMap again.
	clk.t = clk.t.Add(23 * time.Hour)
	if _, err := s.SearchPostal(context.Background(), "520106"); err != nil {
		t.Fatal(err)
	}
	if geo.calls != 1 {
		t.Errorf("geocode calls = %d, want 1 (cached)", geo.calls)
	}
	clk.t = clk.t.Add(2 * time.Hour)
	s.SearchPostal(context.Background(), "520106")
	if geo.calls != 2 {
		t.Errorf("geocode calls after 25 h = %d, want 2", geo.calls)
	}

	if _, err := s.SearchPostal(context.Background(), "123456"); !errors.Is(err, ErrBusPostalNotFound) {
		t.Errorf("unknown postal err = %v, want ErrBusPostalNotFound", err)
	}
	// Misses are cached too (for an hour).
	before := geo.calls
	s.SearchPostal(context.Background(), "123456")
	if geo.calls != before {
		t.Errorf("miss not cached: calls %d → %d", before, geo.calls)
	}
	if _, err := s.SearchPostal(context.Background(), "999001"); !errors.Is(err, ErrBusPostalNotFound) {
		t.Errorf("outside-SG postal err = %v, want ErrBusPostalNotFound", err)
	}
	if _, err := s.SearchPostal(context.Background(), "01012"); !errors.Is(err, ErrBusSearchQueryInvalid) {
		t.Errorf("5-digit err = %v, want ErrBusSearchQueryInvalid", err)
	}
}

func TestBusSearchPostalUnavailable(t *testing.T) {
	repo := newFakeBusRepo()
	if _, err := NewBusService(repo, nil, BusServiceOptions{}).SearchPostal(context.Background(), "520106"); !errors.Is(err, ErrBusPostalUnavailable) {
		t.Errorf("no geocoder err = %v", err)
	}
	geo := &fakeGeocoder{err: errors.New("onemap: HTTP 503 secret-detail")}
	_, err := NewBusService(repo, nil, BusServiceOptions{Geocoder: geo}).SearchPostal(context.Background(), "520106")
	if !errors.Is(err, ErrBusPostalUnavailable) || strings.Contains(err.Error(), "secret-detail") {
		t.Errorf("geocoder failure err = %v, want bare ErrBusPostalUnavailable", err)
	}
	// Failures aren't cached: the next try asks OneMap again.
	NewBusService(repo, nil, BusServiceOptions{Geocoder: geo}).SearchPostal(context.Background(), "520106")
}

// ---- Route ----

func rr(dir, seq int, code, name string, km float64) model.RouteRow {
	return model.RouteRow{Direction: dir, StopSequence: seq, Stop: model.RouteStop{Code: code, Name: name, HasPosition: name != "", Latitude: 1.34, Longitude: 103.95, KmFromBoarding: km}}
}

func TestBusRoute(t *testing.T) {
	repo := newFakeBusRepo()
	repo.routeRows = map[string][]model.RouteRow{
		"20": {
			rr(1, 33, "96179", "Modena Condo", 9.8), rr(1, 34, "96161", "Opp Simei Stn", 10.1), rr(1, 35, "96151", "Blk 106", 10.4),
			rr(1, 36, "96141", "Blk 120", 10.7), rr(1, 37, "46239", "", 11.43), rr(1, 44, "75009", "Tampines Int", 14.9),
		},
		// Both directions call at 96151; direction 2 ends there, so direction 1 wins.
		"38": {
			rr(1, 1, "96151", "Blk 106", 0), rr(1, 2, "96141", "Blk 120", 0.3), rr(1, 3, "75009", "Tampines Int", 3.6),
			rr(2, 1, "75009", "Tampines Int", 0), rr(2, 2, "96151", "Blk 106", 3.4),
		},
	}
	s := NewBusService(repo, nil, BusServiceOptions{})

	got, err := s.Route(context.Background(), "96151", "20")
	if err != nil {
		t.Fatal(err)
	}
	names := func(st []model.RouteStop) string {
		var out []string
		for _, x := range st {
			out = append(out, fmt.Sprintf("%s %.1f", x.Name, x.KmFromBoarding))
		}
		return strings.Join(out, ", ")
	}
	if got.Boarding.Code != "96151" || got.Direction != 1 {
		t.Errorf("boarding = %+v dir %d", got.Boarding, got.Direction)
	}
	if a := names(got.Approach); a != "Modena Condo -0.6, Opp Simei Stn -0.3" {
		t.Errorf("approach = %s", a)
	}
	// Distances relative to the boarding stop, rounded to 0.1 km; a stop
	// missing from bus_stops is listed by code, without a position.
	if o := names(got.Onward); o != "Blk 120 0.3, Stop 46239 1.0, Tampines Int 4.5" {
		t.Errorf("onward = %s", o)
	}
	if got.Onward[1].HasPosition {
		t.Error("unknown stop should have no position")
	}

	got38, err := s.Route(context.Background(), "96151", "38")
	if err != nil || got38.Direction != 1 || len(got38.Onward) != 2 {
		t.Errorf("38 = %+v, %v; want direction 1 with 2 onward stops", got38, err)
	}

	for _, tc := range []struct {
		code, svc string
		want      error
	}{
		{"9615", "20", ErrBusStopCodeInvalid},
		{"96151", "20;--", ErrBusServiceInvalid},
		{"96151", "1234567", ErrBusServiceInvalid},
		{"96151", "", ErrBusServiceInvalid},
		{"96151", "999", ErrBusRouteNotFound},
	} {
		if _, err := s.Route(context.Background(), tc.code, tc.svc); !errors.Is(err, tc.want) {
			t.Errorf("Route(%q, %q) err = %v, want %v", tc.code, tc.svc, err, tc.want)
		}
	}
}

func TestBusArrivalsBusPositions(t *testing.T) {
	now := at(12, 0)
	repo := newFakeBusRepo()
	repo.stops["96151"] = model.BusStop{Code: "96151"}
	f := &fakeLTA{arrival: func(string) (lta.BusArrivalResponse, error) {
		return lta.BusArrivalResponse{Services: []lta.ServiceArrival{{ServiceNo: "20",
			NextBus:  lta.NextBus{EstimatedArrival: ts(now.Add(5 * time.Minute)), Monitored: 1, Latitude: "1.3425", Longitude: "103.9530"},
			NextBus2: lta.NextBus{EstimatedArrival: ts(now.Add(15 * time.Minute)), Monitored: 0, Latitude: "0", Longitude: "0"},
			NextBus3: lta.NextBus{EstimatedArrival: ts(now.Add(25 * time.Minute)), Monitored: 1, Latitude: "3.139", Longitude: "101.687"}, // outside SG
		}}}, nil
	}}
	got, err := newTestService(repo, f, &clock{t: now}).Arrivals(context.Background(), "96151")
	if err != nil {
		t.Fatal(err)
	}
	b := got.Services[0].NextBuses
	if !b[0].HasPosition || b[0].Latitude != 1.3425 || b[0].Longitude != 103.953 {
		t.Errorf("live bus position = %+v", b[0])
	}
	if b[1].HasPosition || b[2].HasPosition {
		t.Errorf("timetable / out-of-bounds buses should have no position: %+v %+v", b[1], b[2])
	}
}

func TestValidateBusServiceNo(t *testing.T) {
	for in, ok := range map[string]bool{"7": true, "12e": true, "225G": true, "170X": true, "NR1": true, "": false, "1234567": false, "20 ": false, "2/3": false, "é": false} {
		if err := ValidateBusServiceNo(in); (err == nil) != ok {
			t.Errorf("ValidateBusServiceNo(%q) = %v, want ok=%v", in, err, ok)
		}
	}
}
