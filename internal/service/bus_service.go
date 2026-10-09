package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"

	"github.com/vincentmegia/vincentmegia/internal/lta"
	"github.com/vincentmegia/vincentmegia/internal/model"
	"github.com/vincentmegia/vincentmegia/internal/onemap"
)

// busRepository is the subset of *repository.BusRepository this service
// depends on (docs/features/bus-stop-finder.md's Go contracts), declared
// here so tests can use an in-memory fake.
type busRepository interface {
	NearestStops(ctx context.Context, lat, lng float64, radiusMeters, limit int) ([]model.NearbyStop, error)
	GetStop(ctx context.Context, code string) (model.BusStop, bool, error)
	SearchStops(ctx context.Context, query string, limit int) ([]model.BusStop, error)
	ServiceHoursAtStop(ctx context.Context, code string, day model.DayType) ([]model.ServiceHours, error)
	StopDescriptions(ctx context.Context, codes []string) (map[string]string, error)
	RouteTermini(ctx context.Context, code string, services []string) (map[string]string, error)
	RouteThroughStop(ctx context.Context, code, serviceNo string) ([]model.RouteRow, error)
	CountStops(ctx context.Context) (int, error)
	CountRoutes(ctx context.Context) (int, error)
	ReplaceStops(ctx context.Context, stops []model.BusStop) error
	ReplaceRoutes(ctx context.Context, routes []model.BusRoute) error
}

// ltaClient is the subset of *lta.Client this service depends on.
type ltaClient interface {
	BusArrival(ctx context.Context, stopCode string) (lta.BusArrivalResponse, error)
	BusStops(ctx context.Context, skip int) ([]lta.BusStopRecord, error)
	BusRoutes(ctx context.Context, skip int) ([]lta.BusRouteRecord, error)
}

const (
	ltaPageSize    = 500
	ltaMaxPages    = 200
	syncDailyHour  = 3 // 03:00 Singapore time
	defaultTTL     = 20 * time.Second
	defaultStale   = 2 * time.Minute
	defaultRate    = 5.0
	defaultBurst   = 10
	syncRunTimeout = 10 * time.Minute
)

// BusServiceOptions tunes BusService. Zero values take the doc's defaults.
type BusServiceOptions struct {
	Now           func() time.Time // default time.Now
	CacheTTL      time.Duration    // default 20s
	StaleWindow   time.Duration    // default 2m
	OutboundRate  float64          // LTA BusArrival calls/second, default 5
	OutboundBurst int              // default 10
	// Geocoder turns a postal code into a place (OneMap). nil disables
	// postal-code search: SearchPostal returns ErrBusPostalUnavailable.
	Geocoder geocoder
}

// geocoder is the subset of *onemap.Client the service uses.
type geocoder interface {
	Geocode(ctx context.Context, postal string) (onemap.Place, bool, error)
}

// BusPostalResult is a postal-code search: the place it resolved to and
// the nearest stops around it (same 500 m / 5 rule as Nearby).
type BusPostalResult struct {
	Postal string
	Label  string // e.g. "106 Simei Street 1"
	// Latitude/Longitude are the geocoded address, so the map can mark the
	// place that was searched (it isn't the visitor's own location).
	Latitude  float64
	Longitude float64
	Stops     []model.NearbyStop
}

// BusSyncResult summarises one Sync run.
type BusSyncResult struct {
	Stops         int
	Routes        int
	DroppedStops  int
	DroppedRoutes int
}

type arrivalEntry struct {
	resp      lta.BusArrivalResponse
	fetchedAt time.Time
}

// BusService holds the Bus Stop Finder's business rules: input validation,
// the arrivals cache, and the nightly sync. See
// docs/features/bus-stop-finder.md's Business Rules.
type BusService struct {
	repo   busRepository
	client ltaClient // nil = LTA not configured
	opts   BusServiceOptions

	mu     sync.Mutex
	cache  map[string]arrivalEntry
	group  singleflight.Group
	bucket *tokenBucket

	postalMu sync.Mutex
	postal   map[string]postalEntry // postal code → geocode, see SearchPostal
}

// NewBusService builds a BusService. client may be nil when
// LTA_ACCOUNT_KEY isn't configured: search/nearby still work against
// already-synced data, arrivals report unavailable, and the scheduler
// does nothing.
func NewBusService(repo busRepository, client ltaClient, opts BusServiceOptions) *BusService {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.CacheTTL <= 0 {
		opts.CacheTTL = defaultTTL
	}
	if opts.StaleWindow <= 0 {
		opts.StaleWindow = defaultStale
	}
	if opts.OutboundRate <= 0 {
		opts.OutboundRate = defaultRate
	}
	if opts.OutboundBurst <= 0 {
		opts.OutboundBurst = defaultBurst
	}
	s := &BusService{
		repo:   repo,
		opts:   opts,
		cache:  make(map[string]arrivalEntry),
		bucket: newTokenBucket(opts.OutboundRate, opts.OutboundBurst, opts.Now()),
	}
	// Avoid a typed-nil interface: a nil *lta.Client passed in must still
	// compare equal to nil here.
	if client != nil {
		if c, ok := client.(*lta.Client); !ok || c != nil {
			s.client = client
		}
	}
	return s
}

// Nearby returns the 5 nearest stops within 500 m of the (rounded) point.
func (s *BusService) Nearby(ctx context.Context, lat, lng float64) ([]model.NearbyStop, error) {
	rlat, rlng, err := ValidateBusLocation(lat, lng)
	if err != nil {
		return nil, err
	}
	stops, err := s.repo.NearestStops(ctx, rlat, rlng, busNearbyRadiusMeters, busNearbyLimit)
	if err != nil {
		return nil, fmt.Errorf("nearest bus stops: %w", err)
	}
	return stops, nil
}

// Search finds up to 10 stops by code prefix or name/road.
func (s *BusService) Search(ctx context.Context, q string) ([]model.BusStop, error) {
	trimmed, err := ValidateBusSearchQuery(q)
	if err != nil {
		return nil, err
	}
	stops, err := s.repo.SearchStops(ctx, trimmed, busSearchLimit)
	if err != nil {
		return nil, fmt.Errorf("search bus stops: %w", err)
	}
	return stops, nil
}

// Arrivals returns the display-ready arrival board for one stop. The code
// is validated and must exist in bus_stops before LTA is ever called.
func (s *BusService) Arrivals(ctx context.Context, code string) (model.StopArrivals, error) {
	if err := ValidateBusStopCode(code); err != nil {
		return model.StopArrivals{}, err
	}
	stop, found, err := s.repo.GetStop(ctx, code)
	if err != nil {
		return model.StopArrivals{}, fmt.Errorf("get bus stop: %w", err)
	}
	if !found {
		return model.StopArrivals{}, ErrBusStopNotFound
	}
	if s.client == nil {
		return model.StopArrivals{}, ErrBusArrivalsUnavailable
	}

	entry, stale, err := s.fetchArrivals(ctx, code)
	if err != nil {
		return model.StopArrivals{}, err
	}

	now := s.opts.Now()
	hours, err := s.repo.ServiceHoursAtStop(ctx, code, dayTypeFor(now))
	if err != nil {
		return model.StopArrivals{}, fmt.Errorf("service hours: %w", err)
	}

	return model.StopArrivals{
		Stop:      stop,
		Services:  s.buildServices(ctx, code, entry.resp, hours, now),
		FetchedAt: entry.fetchedAt,
		Stale:     stale,
	}, nil
}

// fetchArrivals serves from the 20 s cache, collapses concurrent misses
// into one LTA call, spends one outbound token per real call, and falls
// back to a ≤2 min old entry (stale) when LTA fails or the budget is
// exhausted.
func (s *BusService) fetchArrivals(ctx context.Context, code string) (arrivalEntry, bool, error) {
	if e, ok := s.cached(code); ok && s.opts.Now().Sub(e.fetchedAt) < s.opts.CacheTTL {
		return e, false, nil
	}

	v, err, _ := s.group.Do(code, func() (any, error) {
		// Another flight may have filled the cache since our check.
		if e, ok := s.cached(code); ok && s.opts.Now().Sub(e.fetchedAt) < s.opts.CacheTTL {
			return e, nil
		}
		if !s.bucket.allow(s.opts.Now()) {
			return nil, errOutboundBudget
		}
		// Detached from the first caller's cancellation so one aborted
		// request doesn't fail everyone sharing this flight; the client's
		// own timeout still bounds it.
		resp, err := s.client.BusArrival(context.WithoutCancel(ctx), code)
		if err != nil {
			return nil, err
		}
		e := arrivalEntry{resp: resp, fetchedAt: s.opts.Now()}
		s.mu.Lock()
		s.cache[code] = e
		s.mu.Unlock()
		return e, nil
	})
	if err == nil {
		return v.(arrivalEntry), false, nil
	}

	slog.Warn("bus arrivals fetch failed", "stop", code, "error", err)
	if e, ok := s.cached(code); ok && s.opts.Now().Sub(e.fetchedAt) <= s.opts.StaleWindow {
		return e, true, nil
	}
	return arrivalEntry{}, false, ErrBusArrivalsUnavailable
}

var errOutboundBudget = errors.New("LTA outbound budget exhausted")

func (s *BusService) cached(code string) (arrivalEntry, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.cache[code]
	return e, ok
}

// buildServices merges LTA's live services with every service bus_routes
// says calls here, labels times against now, and applies the status rules.
func (s *BusService) buildServices(ctx context.Context, code string, resp lta.BusArrivalResponse, hours []model.ServiceHours, now time.Time) []model.ServiceArrivals {
	byNo := make(map[string]*model.ServiceArrivals)
	hoursByNo := make(map[string]model.ServiceHours, len(hours))
	for _, h := range hours {
		hoursByNo[h.ServiceNo] = h
		if _, ok := byNo[h.ServiceNo]; !ok {
			byNo[h.ServiceNo] = &model.ServiceArrivals{ServiceNo: h.ServiceNo}
		}
	}

	destCodes := map[string]string{} // serviceNo → destination code
	for _, svc := range resp.Services {
		if svc.ServiceNo == "" {
			continue
		}
		sa, ok := byNo[svc.ServiceNo]
		if !ok {
			sa = &model.ServiceArrivals{ServiceNo: svc.ServiceNo}
			byNo[svc.ServiceNo] = sa
		}
		sa.Operator = svc.Operator
		for _, nb := range []lta.NextBus{svc.NextBus, svc.NextBus2, svc.NextBus3} {
			bus, ok := toNextBus(nb, now)
			if !ok {
				continue
			}
			if len(sa.NextBuses) == 0 && nb.DestinationCode != "" {
				destCodes[svc.ServiceNo] = nb.DestinationCode
			}
			sa.NextBuses = append(sa.NextBuses, bus)
		}
	}
	// LTA can list the same ServiceNo twice (a loop that visits the stop
	// in both directions); the merged row keeps only the soonest three.
	for _, sa := range byNo {
		sort.SliceStable(sa.NextBuses, func(i, j int) bool {
			return sa.NextBuses[i].EstimatedArrival.Before(sa.NextBuses[j].EstimatedArrival)
		})
		if len(sa.NextBuses) > 3 {
			sa.NextBuses = sa.NextBuses[:3]
		}
	}

	if len(destCodes) > 0 {
		codes := make([]string, 0, len(destCodes))
		seen := map[string]bool{}
		for _, c := range destCodes {
			if !seen[c] {
				seen[c] = true
				codes = append(codes, c)
			}
		}
		names, err := s.repo.StopDescriptions(ctx, codes)
		if err != nil {
			slog.Warn("bus destination names", "error", err)
		}
		for no, c := range destCodes {
			byNo[no].Destination = names[c]
		}
	}

	// Fallback for every row still unnamed: LTA's DestinationCode is
	// sometimes a terminal code that isn't a boarding stop (absent from
	// BusStops), and rows with no live buses carry no DestinationCode at
	// all. Both get the last stop of the service's route through this stop.
	var unresolved []string
	for no, sa := range byNo {
		if sa.Destination == "" {
			unresolved = append(unresolved, no)
		}
	}
	if len(unresolved) > 0 {
		sort.Strings(unresolved)
		termini, err := s.repo.RouteTermini(ctx, code, unresolved)
		if err != nil {
			slog.Warn("bus route termini", "error", err)
		}
		for _, no := range unresolved {
			byNo[no].Destination = termini[no]
		}
	}

	out := make([]model.ServiceArrivals, 0, len(byNo))
	for no, sa := range byNo {
		if h, ok := hoursByNo[no]; ok {
			sa.FirstBus, sa.LastBus = h.FirstBus, h.LastBus
		}
		if len(sa.NextBuses) == 0 {
			sa.Status = serviceStatus(sa.FirstBus, sa.LastBus, now)
		} else {
			sa.Status = model.StatusLive
		}
		out = append(out, *sa)
	}
	sort.Slice(out, func(i, j int) bool { return naturalLess(out[i].ServiceNo, out[j].ServiceNo) })
	return out
}

func toNextBus(nb lta.NextBus, now time.Time) (model.NextBus, bool) {
	if nb.EstimatedArrival == "" {
		return model.NextBus{}, false
	}
	est, err := time.Parse(time.RFC3339, nb.EstimatedArrival)
	if err != nil {
		return model.NextBus{}, false
	}
	label, arriving := arrivalLabel(est, now)
	load := model.BusLoad(nb.Load)
	switch load {
	case model.LoadSeats, model.LoadStanding, model.LoadLimited:
	default:
		load = ""
	}
	typ := nb.Type
	switch typ {
	case "SD", "DD", "BD":
	default:
		typ = ""
	}
	out := model.NextBus{
		EstimatedArrival: est,
		Label:            label,
		IsArriving:       arriving,
		Monitored:        nb.Monitored == 1,
		Load:             load,
		Type:             typ,
		WheelchairAccess: nb.Feature == "WAB",
	}
	// Only a monitored bus has a real fix; LTA sends "0" otherwise. Anything
	// unparseable or outside Singapore is dropped rather than drawn.
	if out.Monitored {
		lat, latErr := strconv.ParseFloat(strings.TrimSpace(string(nb.Latitude)), 64)
		lng, lngErr := strconv.ParseFloat(strings.TrimSpace(string(nb.Longitude)), 64)
		if latErr == nil && lngErr == nil && inSingapore(lat, lng) {
			out.Latitude, out.Longitude, out.HasPosition = lat, lng, true
		}
	}
	return out, true
}

// Sync pulls every page of BusStops and BusRoutes, validates every row,
// refuses suspiciously small results, then replaces each table.
func (s *BusService) Sync(ctx context.Context) (BusSyncResult, error) {
	var res BusSyncResult
	if s.client == nil {
		return res, ErrBusLTANotConfigured
	}

	stopRecs, err := fetchAllPages(ctx, s.client.BusStops)
	if err != nil {
		return res, fmt.Errorf("fetch bus stops: %w", err)
	}
	routeRecs, err := fetchAllPages(ctx, s.client.BusRoutes)
	if err != nil {
		return res, fmt.Errorf("fetch bus routes: %w", err)
	}

	stops := make([]model.BusStop, 0, len(stopRecs))
	seenStop := map[string]bool{}
	for _, r := range stopRecs {
		st, ok := validStopRecord(r)
		if !ok || seenStop[st.Code] {
			res.DroppedStops++
			continue
		}
		seenStop[st.Code] = true
		stops = append(stops, st)
	}

	routes := make([]model.BusRoute, 0, len(routeRecs))
	type routeKey struct {
		svc      string
		dir, seq int
	}
	seenRoute := map[routeKey]bool{}
	for _, r := range routeRecs {
		rt, ok := validRouteRecord(r)
		k := routeKey{rt.ServiceNo, rt.Direction, rt.StopSequence}
		if !ok || seenRoute[k] {
			res.DroppedRoutes++
			continue
		}
		seenRoute[k] = true
		routes = append(routes, rt)
	}

	curStops, err := s.repo.CountStops(ctx)
	if err != nil {
		return res, fmt.Errorf("count bus stops: %w", err)
	}
	curRoutes, err := s.repo.CountRoutes(ctx)
	if err != nil {
		return res, fmt.Errorf("count bus routes: %w", err)
	}
	if tooSmall(len(stops), curStops) || tooSmall(len(routes), curRoutes) {
		return res, fmt.Errorf("%w (stops %d vs %d, routes %d vs %d)", ErrBusSyncTooSmall, len(stops), curStops, len(routes), curRoutes)
	}

	if err := s.repo.ReplaceStops(ctx, stops); err != nil {
		return res, fmt.Errorf("replace bus stops: %w", err)
	}
	if err := s.repo.ReplaceRoutes(ctx, routes); err != nil {
		return res, fmt.Errorf("replace bus routes: %w", err)
	}
	res.Stops, res.Routes = len(stops), len(routes)
	return res, nil
}

// tooSmall implements the 50% guard: zero valid rows, or under half the
// current table, means something upstream is wrong.
func tooSmall(valid, current int) bool {
	return valid == 0 || valid*2 < current
}

func fetchAllPages[T any](ctx context.Context, fetch func(context.Context, int) ([]T, error)) ([]T, error) {
	var all []T
	for page := 0; page < ltaMaxPages; page++ {
		recs, err := fetch(ctx, page*ltaPageSize)
		if err != nil {
			return nil, err
		}
		all = append(all, recs...)
		if len(recs) < ltaPageSize {
			return all, nil
		}
	}
	return nil, fmt.Errorf("stopped after %d pages without reaching the end", ltaMaxPages)
}

// RunScheduler syncs at start when bus_stops is empty, then daily at 03:00
// Singapore time, until ctx is done. It does nothing when LTA isn't
// configured.
func (s *BusService) RunScheduler(ctx context.Context) {
	if s.client == nil {
		slog.Info("bus sync scheduler disabled: LTA_ACCOUNT_KEY is not set")
		return
	}
	n, err := s.repo.CountStops(ctx)
	if err != nil {
		slog.Error("bus sync: count stops", "error", err)
	}
	if err == nil && n == 0 {
		s.runSync(ctx)
	}
	for {
		next := nextDailyRun(s.opts.Now())
		timer := time.NewTimer(time.Until(next))
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
			s.runSync(ctx)
		}
	}
}

func (s *BusService) runSync(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, syncRunTimeout)
	defer cancel()
	start := time.Now()
	res, err := s.Sync(ctx)
	if err != nil {
		slog.Error("bus sync failed", "error", err)
		return
	}
	slog.Info("bus sync complete",
		"stops", res.Stops, "routes", res.Routes,
		"dropped_stops", res.DroppedStops, "dropped_routes", res.DroppedRoutes,
		"duration", time.Since(start))
}

// nextDailyRun is the next 03:00 SGT strictly after now.
func nextDailyRun(now time.Time) time.Time {
	local := now.In(sgt)
	next := time.Date(local.Year(), local.Month(), local.Day(), syncDailyHour, 0, 0, 0, sgt)
	if !next.After(local) {
		next = next.AddDate(0, 0, 1)
	}
	return next
}

// tokenBucket is a small process-wide limiter for outbound LTA calls.
type tokenBucket struct {
	mu     sync.Mutex
	rate   float64
	burst  float64
	tokens float64
	last   time.Time
}

func newTokenBucket(rate float64, burst int, now time.Time) *tokenBucket {
	return &tokenBucket{rate: rate, burst: float64(burst), tokens: float64(burst), last: now}
}

func (b *tokenBucket) allow(now time.Time) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if elapsed := now.Sub(b.last).Seconds(); elapsed > 0 {
		b.tokens += elapsed * b.rate
		if b.tokens > b.burst {
			b.tokens = b.burst
		}
		b.last = now
	}
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// Postal-code geocodes barely change, so they're cached for a day (misses
// for an hour, so a typo isn't re-sent on every retry). The cache is
// bounded: when it's full it's cleared rather than tracked per entry —
// there are ~140k postal codes, far more than this ever holds.
const (
	postalHitTTL   = 24 * time.Hour
	postalMissTTL  = time.Hour
	postalCacheMax = 10000
)

type postalEntry struct {
	place     onemap.Place
	found     bool
	fetchedAt time.Time
}

// IsBusPostalCode reports whether a search query is a Singapore postal code
// (exactly six digits after trimming), which the handler routes to
// SearchPostal instead of the stop-name search.
func IsBusPostalCode(q string) bool {
	return onemap.IsPostalCode(strings.TrimSpace(q))
}

// SearchPostal geocodes a 6-digit postal code with OneMap, then returns
// the nearest stops to it. OneMap failures map to ErrBusPostalUnavailable
// (logged, never shown); no match, or a point outside Singapore, maps to
// ErrBusPostalNotFound.
func (s *BusService) SearchPostal(ctx context.Context, q string) (BusPostalResult, error) {
	postal := strings.TrimSpace(q)
	if !onemap.IsPostalCode(postal) {
		return BusPostalResult{}, ErrBusSearchQueryInvalid
	}
	if s.opts.Geocoder == nil {
		return BusPostalResult{}, ErrBusPostalUnavailable
	}

	entry, ok := s.cachedPostal(postal)
	if !ok {
		place, found, err := s.opts.Geocoder.Geocode(ctx, postal)
		if err != nil {
			slog.Warn("bus postal geocode", "error", err)
			return BusPostalResult{}, ErrBusPostalUnavailable
		}
		entry = postalEntry{place: place, found: found, fetchedAt: s.opts.Now()}
		s.storePostal(postal, entry)
	}
	if !entry.found {
		return BusPostalResult{}, ErrBusPostalNotFound
	}

	stops, err := s.Nearby(ctx, entry.place.Latitude, entry.place.Longitude)
	if err != nil {
		if errors.Is(err, ErrBusOutsideSingapore) || errors.Is(err, ErrBusInvalidLocation) {
			return BusPostalResult{}, ErrBusPostalNotFound
		}
		return BusPostalResult{}, err
	}
	return BusPostalResult{Postal: postal, Label: entry.place.Label, Latitude: entry.place.Latitude, Longitude: entry.place.Longitude, Stops: stops}, nil
}

func (s *BusService) cachedPostal(postal string) (postalEntry, bool) {
	s.postalMu.Lock()
	defer s.postalMu.Unlock()
	e, ok := s.postal[postal]
	if !ok {
		return postalEntry{}, false
	}
	ttl := postalHitTTL
	if !e.found {
		ttl = postalMissTTL
	}
	if s.opts.Now().Sub(e.fetchedAt) >= ttl {
		return postalEntry{}, false
	}
	return e, true
}

func (s *BusService) storePostal(postal string, e postalEntry) {
	s.postalMu.Lock()
	defer s.postalMu.Unlock()
	if s.postal == nil || len(s.postal) >= postalCacheMax {
		s.postal = make(map[string]postalEntry)
	}
	s.postal[postal] = e
}

// routeMaxOnward caps how many onward stops one route view lists; the
// longest SBS/SMRT trunk routes run to ~90 stops.
const routeMaxOnward = 100

// Route returns where serviceNo goes from stop code: the two stops it comes
// from and every stop after it to the terminus, with distances from code.
// When the service calls at code in both directions (or a loop calls twice),
// the direction with the most stops still ahead is used — at a terminus
// that's the one departing from it, and otherwise it's the direction that
// isn't about to end. Distances come from bus_routes, relative to code.
func (s *BusService) Route(ctx context.Context, code, serviceNo string) (model.ServiceRoute, error) {
	if err := ValidateBusStopCode(code); err != nil {
		return model.ServiceRoute{}, err
	}
	if err := ValidateBusServiceNo(serviceNo); err != nil {
		return model.ServiceRoute{}, err
	}
	rows, err := s.repo.RouteThroughStop(ctx, code, serviceNo)
	if err != nil {
		return model.ServiceRoute{}, fmt.Errorf("get bus route: %w", err)
	}

	byDir := map[int][]model.RouteRow{}
	var dirs []int
	for _, r := range rows {
		if _, ok := byDir[r.Direction]; !ok {
			dirs = append(dirs, r.Direction)
		}
		byDir[r.Direction] = append(byDir[r.Direction], r)
	}
	sort.Ints(dirs)

	bestDir, bestAt, bestAhead := 0, -1, -1
	for _, d := range dirs {
		seq := byDir[d]
		for i, r := range seq {
			if r.Stop.Code == code {
				if ahead := len(seq) - 1 - i; ahead > bestAhead {
					bestDir, bestAt, bestAhead = d, i, ahead
				}
				break // first call at this stop in this direction
			}
		}
	}
	if bestAt < 0 {
		return model.ServiceRoute{}, ErrBusRouteNotFound
	}

	seq := byDir[bestDir]
	boardKm := seq[bestAt].Stop.KmFromBoarding
	rel := func(r model.RouteRow) model.RouteStop {
		st := r.Stop
		st.KmFromBoarding = math.Round((st.KmFromBoarding-boardKm)*10) / 10
		if st.Name == "" {
			st.Name = "Stop " + st.Code
		}
		return st
	}
	route := model.ServiceRoute{ServiceNo: serviceNo, Direction: bestDir, Boarding: rel(seq[bestAt])}
	for i := max(0, bestAt-2); i < bestAt; i++ {
		route.Approach = append(route.Approach, rel(seq[i]))
	}
	for i := bestAt + 1; i < len(seq) && len(route.Onward) < routeMaxOnward; i++ {
		route.Onward = append(route.Onward, rel(seq[i]))
	}
	return route, nil
}
