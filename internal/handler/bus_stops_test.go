package handler

import (
	"context"
	"errors"
	"html"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/vincentmegia/vincentmegia/internal/model"
	"github.com/vincentmegia/vincentmegia/internal/service"
)

type fakeBusService struct {
	nearby      []model.NearbyStop
	nearbyErr   error
	search      []model.BusStop
	searchErr   error
	route       model.ServiceRoute
	routeErr    error
	postal      service.BusPostalResult
	postalErr   error
	arrivals    model.StopArrivals
	arrivalsErr error

	gotLat, gotLng float64
	gotQuery       string
	gotCode        string
	calls          int
}

func (f *fakeBusService) Nearby(_ context.Context, lat, lng float64) ([]model.NearbyStop, error) {
	f.calls++
	f.gotLat, f.gotLng = lat, lng
	return f.nearby, f.nearbyErr
}

func (f *fakeBusService) Search(_ context.Context, q string) ([]model.BusStop, error) {
	f.calls++
	f.gotQuery = q
	return f.search, f.searchErr
}

func (f *fakeBusService) SearchPostal(_ context.Context, q string) (service.BusPostalResult, error) {
	f.calls++
	f.gotQuery = q
	return f.postal, f.postalErr
}

func (f *fakeBusService) Route(_ context.Context, code, svc string) (model.ServiceRoute, error) {
	f.calls++
	f.gotCode, f.gotQuery = code, svc
	return f.route, f.routeErr
}

func (f *fakeBusService) Arrivals(_ context.Context, code string) (model.StopArrivals, error) {
	f.calls++
	f.gotCode = code
	return f.arrivals, f.arrivalsErr
}

var testNow = time.Date(2026, 10, 3, 18, 0, 0, 0, time.FixedZone("SGT", 8*3600))

func newTestBusHandler(t *testing.T, svc *fakeBusService, mapsKey string) *BusStopsHandler {
	t.Helper()
	tmpl, err := LoadTemplates("../../web/templates")
	if err != nil {
		t.Fatalf("LoadTemplates: %v", err)
	}
	h := NewBusStopsHandler(NewRenderer(tmpl), svc, "dev", mapsKey)
	h.now = func() time.Time { return testNow }
	return h
}

func grandPacific() model.BusStop {
	return model.BusStop{Code: "01012", RoadName: "Victoria St", Description: "Hotel Grand Pacific", Latitude: 1.29685, Longitude: 103.853}
}

func TestBusStopsIndex_NoMapsKey_KeepsSiteCSPAndSetsPermissionsPolicy(t *testing.T) {
	h := newTestBusHandler(t, &fakeBusService{}, "")
	rec := httptest.NewRecorder()
	rec.Header().Set("Content-Security-Policy", "default-src 'self'") // as set by middleware.SecurityHeaders
	h.Index(rec, httptest.NewRequest(http.MethodGet, "/bus-stops", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if got := rec.Header().Get("Content-Security-Policy"); got != "default-src 'self'" {
		t.Errorf("CSP overridden without a maps key: %q", got)
	}
	if got := rec.Header().Get("Permissions-Policy"); got != "geolocation=(self)" {
		t.Errorf("Permissions-Policy = %q", got)
	}
	body := rec.Body.String()
	for _, want := range []string{"Bus Stop Finder", `id="bus-explainer"`, "Use my location", "Search by postal code or stop code", `data-maps-key=""`, "/static/js/bus-stops.js"} {
		if !strings.Contains(body, want) {
			t.Errorf("page missing %q", want)
		}
	}
	for _, unwanted := range []string{"nonce=", `id="bus-map-panel"`, "maps.googleapis.com"} {
		if strings.Contains(body, unwanted) {
			t.Errorf("list-only page unexpectedly contains %q", unwanted)
		}
	}
}

func TestBusStopsIndex_WithMapsKey_NonceCSPMatchesScriptTags(t *testing.T) {
	h := newTestBusHandler(t, &fakeBusService{}, "test-maps-key")
	rec := httptest.NewRecorder()
	h.Index(rec, httptest.NewRequest(http.MethodGet, "/bus-stops", nil))

	csp := rec.Header().Get("Content-Security-Policy")
	m := regexp.MustCompile(`script-src 'nonce-([A-Za-z0-9+/=]+)' 'strict-dynamic'`).FindStringSubmatch(csp)
	if m == nil {
		t.Fatalf("CSP has no nonce script-src: %q", csp)
	}
	nonce := m[1]
	for _, want := range []string{"default-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "style-src 'self' 'nonce-" + nonce + "'", "worker-src blob:", "https://*.googleapis.com"} {
		if !strings.Contains(csp, want) {
			t.Errorf("CSP missing %q: %q", want, csp)
		}
	}

	body := rec.Body.String()
	scripts := regexp.MustCompile(`<script[^>]*>`).FindAllString(body, -1)
	if len(scripts) == 0 {
		t.Fatal("no script tags rendered")
	}
	for _, tag := range scripts {
		if !strings.Contains(tag, `nonce="`+nonce+`"`) {
			t.Errorf("script tag without the response nonce: %s", tag)
		}
	}
	if !strings.Contains(body, `<style nonce="`+nonce+`">`) {
		t.Error("missing nonce-bearing <style> element for the Maps API")
	}
	if !strings.Contains(body, `data-maps-key="test-maps-key"`) || !strings.Contains(body, `id="bus-map-panel"`) {
		t.Error("maps key/map panel not rendered")
	}

	// A second request gets a different nonce.
	rec2 := httptest.NewRecorder()
	h.Index(rec2, httptest.NewRequest(http.MethodGet, "/bus-stops", nil))
	if rec2.Header().Get("Content-Security-Policy") == csp {
		t.Error("nonce reused across requests")
	}
}

func TestBusStopsNearby_RendersCardsWithDataContract(t *testing.T) {
	svc := &fakeBusService{nearby: []model.NearbyStop{
		{BusStop: grandPacific(), DistanceMeters: 90},
		{BusStop: model.BusStop{Code: "01013", RoadName: "Victoria St", Description: `St. Joseph's <Ch>`, Latitude: 1.2977, Longitude: 103.8527}, DistanceMeters: 210},
	}}
	h := newTestBusHandler(t, svc, "")
	rec := httptest.NewRecorder()
	h.Nearby(rec, httptest.NewRequest(http.MethodGet, "/bus-stops/nearby?lat=1.297&lng=103.853", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if svc.gotLat != 1.297 || svc.gotLng != 103.853 {
		t.Errorf("service got %v,%v", svc.gotLat, svc.gotLng)
	}
	body := rec.Body.String()
	for _, want := range []string{
		`class="bus-stop-card`, `data-code="01012"`, `data-lat="1.296850"`, `data-lng="103.853000"`,
		`data-name="Hotel Grand Pacific"`, `data-distance="90"`, `data-rank="1"`, `aria-controls="bus-detail-01012"`, `id="bus-detail-01012"`, `id="bus-arrivals-01012"`, `id="bus-route-01012"`, `aria-label="Close Hotel Grand Pacific"`,
		`id="bus-arrivals-01012"`, "90 m · 2 min walk", "Nearby stops", `data-bus-state="results"`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("fragment missing %q", want)
		}
	}
	if strings.Contains(body, "<Ch>") {
		t.Error("LTA description rendered unescaped")
	}
	if strings.Contains(body, "<html") {
		t.Error("fragment wrapped in page shell")
	}
}

func TestBusStopsNearby_EmptyState(t *testing.T) {
	h := newTestBusHandler(t, &fakeBusService{}, "")
	rec := httptest.NewRecorder()
	h.Nearby(rec, httptest.NewRequest(http.MethodGet, "/bus-stops/nearby?lat=1.4&lng=103.9", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "No bus stops within 500 m") || !strings.Contains(rec.Body.String(), `data-bus-state="empty"`) {
		t.Fatalf("got %d %s", rec.Code, rec.Body.String())
	}
}

func TestBusStopsNearby_Errors(t *testing.T) {
	internal := errors.New("pq: connection refused to 10.0.0.5 password=hunter2")
	cases := []struct {
		name, query string
		err         error
		status      int
		state, copy string
		noCall      bool
	}{
		{"unparseable", "lat=abc&lng=103.8", nil, 400, "invalid-location", busMsgInvalidLocation, true},
		{"missing", "", nil, 400, "invalid-location", busMsgInvalidLocation, true},
		{"nan", "lat=NaN&lng=103.8", nil, 400, "invalid-location", busMsgInvalidLocation, true},
		{"invalid", "lat=1.3&lng=103.8", service.ErrBusInvalidLocation, 400, "invalid-location", busMsgInvalidLocation, false},
		{"outside", "lat=51.5&lng=-0.12", service.ErrBusOutsideSingapore, 400, "outside-sg", busMsgOutsideSG, false},
		{"internal", "lat=1.3&lng=103.8", internal, 500, "error", busMsgListError, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc := &fakeBusService{nearbyErr: tc.err}
			h := newTestBusHandler(t, svc, "")
			rec := httptest.NewRecorder()
			h.Nearby(rec, httptest.NewRequest(http.MethodGet, "/bus-stops/nearby?"+tc.query, nil))
			if rec.Code != tc.status {
				t.Errorf("status = %d, want %d", rec.Code, tc.status)
			}
			body := rec.Body.String()
			if !strings.Contains(body, `data-bus-state="`+tc.state+`"`) || !strings.Contains(body, htmlEscape(tc.copy)) {
				t.Errorf("body = %s", body)
			}
			if strings.Contains(body, "hunter2") || strings.Contains(body, "connection refused") {
				t.Error("internal error text leaked to the client")
			}
			if tc.noCall && svc.calls != 0 {
				t.Error("service called for unparseable input")
			}
		})
	}
}

func TestBusStopsSearch(t *testing.T) {
	svc := &fakeBusService{search: []model.BusStop{grandPacific()}}
	h := newTestBusHandler(t, svc, "")
	rec := httptest.NewRecorder()
	h.Search(rec, httptest.NewRequest(http.MethodGet, "/bus-stops/search?q=Victoria", nil))
	body := rec.Body.String()
	if rec.Code != 200 || svc.gotQuery != "Victoria" || !strings.Contains(body, "Search results") || !strings.Contains(body, `data-code="01012"`) {
		t.Fatalf("got %d %q %s", rec.Code, svc.gotQuery, body)
	}
	if strings.Contains(body, "min walk") || !strings.Contains(body, `data-distance=""`) {
		t.Error("search results should carry no distance")
	}

	svc = &fakeBusService{}
	h = newTestBusHandler(t, svc, "")
	rec = httptest.NewRecorder()
	h.Search(rec, httptest.NewRequest(http.MethodGet, "/bus-stops/search?q=zzz%3Cb%3E", nil))
	if !strings.Contains(rec.Body.String(), "No stops match “zzz&lt;b&gt;”") {
		t.Errorf("empty search state/escaping wrong: %s", rec.Body.String())
	}

	svc = &fakeBusService{searchErr: service.ErrBusSearchQueryInvalid}
	h = newTestBusHandler(t, svc, "")
	rec = httptest.NewRecorder()
	h.Search(rec, httptest.NewRequest(http.MethodGet, "/bus-stops/search?q=a", nil))
	if rec.Code != 400 || !strings.Contains(rec.Body.String(), `data-bus-state="invalid-query"`) {
		t.Errorf("invalid query: %d %s", rec.Code, rec.Body.String())
	}

	svc = &fakeBusService{searchErr: errors.New("db exploded: secret")}
	h = newTestBusHandler(t, svc, "")
	rec = httptest.NewRecorder()
	h.Search(rec, httptest.NewRequest(http.MethodGet, "/bus-stops/search?q=abc", nil))
	if rec.Code != 500 || strings.Contains(rec.Body.String(), "secret") {
		t.Errorf("internal search error: %d %s", rec.Code, rec.Body.String())
	}
}

func liveArrivals() model.StopArrivals {
	return model.StopArrivals{
		Stop:      grandPacific(),
		FetchedAt: testNow.Add(-12 * time.Second),
		Services: []model.ServiceArrivals{
			{ServiceNo: "7", Destination: "Clementi Int", NextBuses: []model.NextBus{
				{Label: "Arr", IsArriving: true, Monitored: true, Load: model.LoadSeats, Type: "DD", WheelchairAccess: true},
				{Label: "8", Monitored: true, Load: model.LoadStanding, Type: "DD"},
				{Label: "17", Monitored: false, Load: model.LoadLimited, Type: "DD"},
			}},
			{ServiceNo: "61", Destination: "Eunos Int", Status: model.StatusNoEstimate},
			{ServiceNo: "960", Destination: "Woodlands Int", Status: model.StatusNotInOperation, FirstBus: "0530", LastBus: "2330"},
		},
	}
}

func TestBusStopsArrivals_Live(t *testing.T) {
	svc := &fakeBusService{arrivals: liveArrivals()}
	h := newTestBusHandler(t, svc, "")
	req := httptest.NewRequest(http.MethodGet, "/bus-stops/01012/arrivals", nil)
	req.SetPathValue("code", "01012")
	rec := httptest.NewRecorder()
	h.Arrivals(rec, req)

	if rec.Code != 200 || svc.gotCode != "01012" {
		t.Fatalf("status %d code %q", rec.Code, svc.gotCode)
	}
	body := rec.Body.String()
	for _, want := range []string{
		`id="bus-arrivals-01012"`, `hx-get="/bus-stops/01012/arrivals"`, `hx-trigger="every 20s"`, `hx-swap="outerHTML"`,
		`data-state="live"`, "Updated 12 s ago", "Clementi Int", `aria-label="Double deck"`, "Wheelchair accessible",
		">Arr<", `aria-label="Seats available"`, `aria-label="Standing room"`, `aria-label="Limited standing, timetable estimate"`,
		"~17", "No Est. Available", "Not In Operation", "First bus 05:30",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("arrivals missing %q", want)
		}
	}
	if strings.Contains(body, "bus-stale") {
		t.Error("stale banner shown for fresh data")
	}
}

func TestBusStopsArrivals_Stale(t *testing.T) {
	a := liveArrivals()
	a.Stale = true
	a.FetchedAt = testNow.Add(-90 * time.Second)
	h := newTestBusHandler(t, &fakeBusService{arrivals: a}, "")
	req := httptest.NewRequest(http.MethodGet, "/bus-stops/01012/arrivals", nil)
	req.SetPathValue("code", "01012")
	rec := httptest.NewRecorder()
	h.Arrivals(rec, req)
	if !strings.Contains(rec.Body.String(), "Showing data from 1 min ago; live times unavailable.") {
		t.Errorf("stale copy missing: %s", rec.Body.String())
	}
}

func TestBusStopsArrivals_Errors(t *testing.T) {
	cases := []struct {
		name, code string
		err        error
		status     int
		state      string
		poll       bool
		copy       string
	}{
		{"invalid", "12ab", service.ErrBusStopCodeInvalid, 400, "invalid", false, busMsgInvalidCode},
		{"not-found", "99999", service.ErrBusStopNotFound, 404, "not-found", false, busMsgStopNotFound},
		{"unavailable", "01012", service.ErrBusArrivalsUnavailable, 200, "unavailable", true, busMsgArrivalsDown},
		{"not-configured", "01012", service.ErrBusLTANotConfigured, 200, "unavailable", true, busMsgArrivalsDown},
		{"internal", "01012", errors.New("lta: AccountKey=abc123 status 500"), 500, "unavailable", true, busMsgArrivalsDown},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newTestBusHandler(t, &fakeBusService{arrivalsErr: tc.err}, "")
			req := httptest.NewRequest(http.MethodGet, "/bus-stops/"+tc.code+"/arrivals", nil)
			req.SetPathValue("code", tc.code)
			rec := httptest.NewRecorder()
			h.Arrivals(rec, req)
			body := rec.Body.String()
			if rec.Code != tc.status {
				t.Errorf("status %d want %d", rec.Code, tc.status)
			}
			if !strings.Contains(body, `data-state="`+tc.state+`"`) || !strings.Contains(body, htmlEscape(tc.copy)) {
				t.Errorf("body %s", body)
			}
			if got := strings.Contains(body, `hx-trigger="every 20s"`); got != tc.poll {
				t.Errorf("polling = %v, want %v", got, tc.poll)
			}
			if strings.Contains(body, "AccountKey") || strings.Contains(body, "abc123") {
				t.Error("internal error text leaked")
			}
			if strings.Contains(body, "12ab") {
				t.Error("invalid code echoed into markup")
			}
		})
	}
}

func TestBusStops_RateLimits(t *testing.T) {
	cases := []struct {
		name  string
		limit int
		call  func(h *BusStopsHandler) *httptest.ResponseRecorder
	}{
		{"nearby", busNearbyLimit, func(h *BusStopsHandler) *httptest.ResponseRecorder {
			rec := httptest.NewRecorder()
			h.Nearby(rec, httptest.NewRequest(http.MethodGet, "/bus-stops/nearby?lat=1.3&lng=103.8", nil))
			return rec
		}},
		{"search", busSearchLimit, func(h *BusStopsHandler) *httptest.ResponseRecorder {
			rec := httptest.NewRecorder()
			h.Search(rec, httptest.NewRequest(http.MethodGet, "/bus-stops/search?q=abc", nil))
			return rec
		}},
		{"arrivals", busArrivalsLimit, func(h *BusStopsHandler) *httptest.ResponseRecorder {
			req := httptest.NewRequest(http.MethodGet, "/bus-stops/01012/arrivals", nil)
			req.SetPathValue("code", "01012")
			rec := httptest.NewRecorder()
			h.Arrivals(rec, req)
			return rec
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc := &fakeBusService{arrivals: liveArrivals()}
			h := newTestBusHandler(t, svc, "")
			for i := 0; i < tc.limit; i++ {
				if rec := tc.call(h); rec.Code == http.StatusTooManyRequests {
					t.Fatalf("limited early at request %d", i+1)
				}
			}
			rec := tc.call(h)
			if rec.Code != http.StatusTooManyRequests {
				t.Fatalf("request %d: status %d, want 429", tc.limit+1, rec.Code)
			}
			if !strings.Contains(rec.Body.String(), htmlEscape(busMsgRateLimited)) {
				t.Errorf("429 body: %s", rec.Body.String())
			}
			if svc.calls != tc.limit {
				t.Errorf("service called %d times, want %d", svc.calls, tc.limit)
			}
		})
	}
}

func TestBusStopsHelpers(t *testing.T) {
	if got := formatHHMM("0620"); got != "06:20" {
		t.Errorf("formatHHMM = %q", got)
	}
	for _, bad := range []string{"", "62", "06:2", "ab12"} {
		if got := formatHHMM(bad); got != "" {
			t.Errorf("formatHHMM(%q) = %q", bad, got)
		}
	}
	if walkMinutes(10) != 1 || walkMinutes(90) != 2 || walkMinutes(480) != 6 {
		t.Error("walkMinutes")
	}
	if safeCode("01012") != "01012" || safeCode("0101") != "invalid" || safeCode(`0101"`) != "invalid" {
		t.Error("safeCode")
	}
	if updatedAgo(2*time.Second) != "just now" || updatedAgo(12*time.Second) != "12 s ago" || updatedAgo(130*time.Second) != "2 min ago" {
		t.Error("updatedAgo")
	}
}

func htmlEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "'", "&#39;", "<", "&lt;", ">", "&gt;", `"`, "&#34;").Replace(s)
}

func TestFormatHHMM(t *testing.T) {
	for in, want := range map[string]string{"0530": "05:30", "2359": "23:59", "2400": "00:00", "2430": "00:30", "": "", "-": "", "12a4": ""} {
		if got := formatHHMM(in); got != want {
			t.Errorf("formatHHMM(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestBusStopsSearchPostal(t *testing.T) {
	stop := model.NearbyStop{BusStop: model.BusStop{Code: "96151", RoadName: "Simei St 1", Description: "Blk 106", Latitude: 1.3421, Longitude: 103.9505}, DistanceMeters: 44}
	svc := &fakeBusService{postal: service.BusPostalResult{Postal: "520106", Label: "106 Simei <Street> 1", Latitude: 1.341885, Longitude: 103.950833, Stops: []model.NearbyStop{stop}}}
	h := newTestBusHandler(t, svc, "")
	rec := httptest.NewRecorder()
	h.Search(rec, httptest.NewRequest(http.MethodGet, "/bus-stops/search?q=+520106+", nil))
	body := rec.Body.String()
	if rec.Code != 200 || svc.calls != 1 {
		t.Fatalf("got %d, calls %d: %s", rec.Code, svc.calls, body)
	}
	for _, want := range []string{`data-mode="postal"`, `data-place-lat="1.341885" data-place-lng="103.950833"`, `data-postal="520106"`, "Stops near 106 Simei &lt;Street&gt; 1", "within 500 m of 520106", `data-code="96151"`, `data-distance="44"`, "1 min walk"} {
		if !strings.Contains(body, want) {
			t.Errorf("postal results missing %q:\n%s", want, body)
		}
	}

	// A 5-digit query is a stop code, not a postal code: the normal search.
	svc = &fakeBusService{search: []model.BusStop{grandPacific()}}
	h = newTestBusHandler(t, svc, "")
	rec = httptest.NewRecorder()
	h.Search(rec, httptest.NewRequest(http.MethodGet, "/bus-stops/search?q=01012", nil))
	if !strings.Contains(rec.Body.String(), `data-mode="search"`) {
		t.Errorf("5-digit query should use stop search: %s", rec.Body.String())
	}

	cases := []struct {
		err   error
		code  int
		state string
	}{
		{service.ErrBusPostalNotFound, 404, "postal-not-found"},
		{service.ErrBusPostalUnavailable, 503, "postal-unavailable"},
		{errors.New("db exploded: secret"), 500, "error"},
	}
	for _, tc := range cases {
		svc = &fakeBusService{postalErr: tc.err}
		h = newTestBusHandler(t, svc, "")
		rec = httptest.NewRecorder()
		h.Search(rec, httptest.NewRequest(http.MethodGet, "/bus-stops/search?q=520106", nil))
		body := rec.Body.String()
		if rec.Code != tc.code || !strings.Contains(body, `data-bus-state="`+tc.state+`"`) || strings.Contains(body, "secret") {
			t.Errorf("err %v: got %d %s", tc.err, rec.Code, body)
		}
		if rec.Header().Get("Cache-Control") != "no-store" {
			t.Errorf("err %v: Cache-Control = %q", tc.err, rec.Header().Get("Cache-Control"))
		}
	}

	// Empty result near a real place.
	svc = &fakeBusService{postal: service.BusPostalResult{Postal: "456789", Label: "Far Away Road"}}
	h = newTestBusHandler(t, svc, "")
	rec = httptest.NewRecorder()
	h.Search(rec, httptest.NewRequest(http.MethodGet, "/bus-stops/search?q=456789", nil))
	if !strings.Contains(rec.Body.String(), "No bus stops within 500 m of Far Away Road") {
		t.Errorf("postal empty state wrong: %s", rec.Body.String())
	}
}

// TestBusStopsArrivals_DeckPerBus: LTA reports vehicle type per bus, and the
// three buses on one route can differ, so each time shows its own deck.
func TestBusStopsArrivals_DeckPerBus(t *testing.T) {
	arr := liveArrivals()
	arr.Services = []model.ServiceArrivals{{ServiceNo: "12", Destination: "Pasir Ris Int", NextBuses: []model.NextBus{
		{Label: "3", Monitored: true, Load: model.LoadSeats, Type: "DD"},
		{Label: "9", Monitored: true, Load: model.LoadSeats, Type: "SD"},
		{Label: "15", Monitored: true, Load: model.LoadSeats, Type: "BD"},
		{Label: "20", Monitored: true, Load: model.LoadSeats, Type: ""},
	}}}
	h := newTestBusHandler(t, &fakeBusService{arrivals: arr}, "")
	req := httptest.NewRequest(http.MethodGet, "/bus-stops/01012/arrivals", nil)
	req.SetPathValue("code", "01012")
	rec := httptest.NewRecorder()
	h.Arrivals(rec, req)
	body := rec.Body.String()

	re := regexp.MustCompile(`data-deck="([A-Z]+)"`)
	var decks []string
	for _, m := range re.FindAllStringSubmatch(body, -1) {
		decks = append(decks, m[1])
	}
	if strings.Join(decks, ",") != "DD,SD,BD" {
		t.Errorf("decks in order = %v, want [DD SD BD] (unknown type shows none)", decks)
	}
	for _, want := range []string{`aria-label="Double deck"`, `aria-label="Single deck"`, `aria-label="Bendy bus"`, ">Double<", ">Single<", ">Bendy<"} {
		if !strings.Contains(body, want) {
			t.Errorf("missing %q", want)
		}
	}
	if strings.Contains(body, "Single deck</span>") || strings.Contains(body, "Double deck</span>") {
		t.Error("the row-level deck text should be gone")
	}
}

func TestBusStopsRoute(t *testing.T) {
	st := func(code, name string, km float64, pos bool) model.RouteStop {
		return model.RouteStop{Code: code, Name: name, KmFromBoarding: km, HasPosition: pos, Latitude: 1.342, Longitude: 103.951}
	}
	svc := &fakeBusService{route: model.ServiceRoute{
		ServiceNo: "20", Direction: 1,
		Boarding: st("96151", "Blk 106", 0, true),
		Approach: []model.RouteStop{st("96179", "Modena Condo", -0.6, true), st("96161", "Opp Simei Stn", -0.3, true)},
		Onward:   []model.RouteStop{st("96141", "Blk 120 <x>", 0.3, true), st("46239", "Stop 46239", 1.0, false), st("75009", "Tampines Int", 4.5, true)},
	}}
	h := newTestBusHandler(t, svc, "")
	req := httptest.NewRequest(http.MethodGet, "/bus-stops/96151/route/20", nil)
	req.SetPathValue("code", "96151")
	req.SetPathValue("service", "20")
	rec := httptest.NewRecorder()
	h.Route(rec, req)
	body := rec.Body.String()
	if rec.Code != 200 || svc.gotCode != "96151" || svc.gotQuery != "20" {
		t.Fatalf("got %d (%q %q): %s", rec.Code, svc.gotCode, svc.gotQuery, body)
	}
	for _, want := range []string{
		"Bus 20 from Blk 106", "3 stops · 4.5 km to Tampines Int", "you board here", "terminus",
		"Blk 120 &lt;x&gt;", "+0.3 km", "+4.5 km", `data-code="96179"`, `data-name="Modena Condo"`,
		`data-code="46239" data-lat="" data-lng=""`, `data-lat="1.342000"`,
	} {
		// html/template writes "+" as "&#43;"; compare the text a browser shows.
		if !strings.Contains(body, want) && !strings.Contains(html.UnescapeString(body), want) {
			t.Errorf("route fragment missing %q", want)
		}
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "public, max-age=300" {
		t.Errorf("Cache-Control = %q", cc)
	}

	for _, tc := range []struct {
		err   error
		code  int
		state string
	}{
		{service.ErrBusServiceInvalid, 400, "route-invalid"},
		{service.ErrBusStopCodeInvalid, 400, "route-invalid"},
		{service.ErrBusRouteNotFound, 404, "route-not-found"},
		{errors.New("db exploded: secret"), 500, "error"},
	} {
		h := newTestBusHandler(t, &fakeBusService{routeErr: tc.err}, "")
		rec := httptest.NewRecorder()
		h.Route(rec, req)
		if rec.Code != tc.code || !strings.Contains(rec.Body.String(), `data-bus-state="`+tc.state+`"`) || strings.Contains(rec.Body.String(), "secret") {
			t.Errorf("err %v: got %d %s", tc.err, rec.Code, rec.Body.String())
		}
	}
}

func TestBusStopsArrivals_RouteButtonsAndBusPositions(t *testing.T) {
	arr := liveArrivals()
	arr.Services = []model.ServiceArrivals{{ServiceNo: "20", Destination: "Tampines Int", NextBuses: []model.NextBus{
		{Label: "5", Monitored: true, Load: model.LoadSeats, Type: "DD", HasPosition: true, Latitude: 1.3425, Longitude: 103.953},
		{Label: "15", Monitored: false, Load: model.LoadSeats, Type: "SD"},
	}}}
	h := newTestBusHandler(t, &fakeBusService{arrivals: arr}, "")
	req := httptest.NewRequest(http.MethodGet, "/bus-stops/96151/arrivals", nil)
	req.SetPathValue("code", "96151")
	rec := httptest.NewRecorder()
	h.Arrivals(rec, req)
	body := rec.Body.String()
	for _, want := range []string{`data-bus-action="route" data-service="20" aria-pressed="false"`, `data-lat="1.342500" data-lng="103.953000" data-label="5"`} {
		if !strings.Contains(body, want) {
			t.Errorf("arrivals missing %q", want)
		}
	}
	if strings.Count(body, "data-lat=") != 1 {
		t.Errorf("only the live bus should carry a position; got %d", strings.Count(body, "data-lat="))
	}
}

func TestBusStopsRoute_LastStop(t *testing.T) {
	svc := &fakeBusService{route: model.ServiceRoute{ServiceNo: "12", Boarding: model.RouteStop{Code: "01012", Name: "Hotel Grand Pacific"}}}
	h := newTestBusHandler(t, svc, "")
	req := httptest.NewRequest(http.MethodGet, "/bus-stops/01012/route/12", nil)
	req.SetPathValue("code", "01012")
	req.SetPathValue("service", "12")
	rec := httptest.NewRecorder()
	h.Route(rec, req)
	body := rec.Body.String()
	if !strings.Contains(body, "Hotel Grand Pacific is the last stop for bus 12 in this direction.") || strings.Contains(body, " km to ") {
		t.Errorf("terminus route fragment wrong: %s", body)
	}
}
