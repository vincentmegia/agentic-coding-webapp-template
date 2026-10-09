package handler

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/vincentmegia/vincentmegia/internal/middleware"
	"github.com/vincentmegia/vincentmegia/internal/model"
	"github.com/vincentmegia/vincentmegia/internal/service"
)

// busStopsService is the subset of *service.BusService this handler
// depends on, declared here so tests can substitute a fake. See
// docs/features/bus-stop-finder.md's Go contracts.
type busStopsService interface {
	Nearby(ctx context.Context, lat, lng float64) ([]model.NearbyStop, error)
	Search(ctx context.Context, q string) ([]model.BusStop, error)
	SearchPostal(ctx context.Context, q string) (service.BusPostalResult, error)
	Route(ctx context.Context, code, serviceNo string) (model.ServiceRoute, error)
	Arrivals(ctx context.Context, code string) (model.StopArrivals, error)
}

// Per-IP fixed-window limits, per docs/features/bus-stop-finder.md's
// Security Considerations. Arrivals is the most generous because an open
// card polls every 20 s on its own.
const (
	busNearbyLimit   = 30
	busSearchLimit   = 30
	busArrivalsLimit = 120
	busRouteLimit    = 60
	busLimitWindow   = time.Minute
)

// BusStopsHandler serves /bus-stops and its three fragment routes. See
// docs/features/bus-stop-finder.md's Routes/Handlers.
type BusStopsHandler struct {
	Renderer *Renderer
	Service  busStopsService
	Version  string
	// MapsAPIKey is the public, referrer-restricted Google Maps JS key.
	// Empty means list-only mode: no map, no Google script, and no
	// route-scoped CSP override.
	MapsAPIKey string

	now             func() time.Time
	nearbyLimiter   *scoreSubmitLimiter
	searchLimiter   *scoreSubmitLimiter
	arrivalsLimiter *scoreSubmitLimiter
	routeLimiter    *scoreSubmitLimiter
}

// NewBusStopsHandler constructs a BusStopsHandler.
func NewBusStopsHandler(renderer *Renderer, svc busStopsService, version, mapsAPIKey string) *BusStopsHandler {
	return &BusStopsHandler{
		Renderer:        renderer,
		Service:         svc,
		Version:         version,
		MapsAPIKey:      mapsAPIKey,
		now:             time.Now,
		nearbyLimiter:   newScoreSubmitLimiter(busNearbyLimit, busLimitWindow),
		searchLimiter:   newScoreSubmitLimiter(busSearchLimit, busLimitWindow),
		arrivalsLimiter: newScoreSubmitLimiter(busArrivalsLimit, busLimitWindow),
		routeLimiter:    newScoreSubmitLimiter(busRouteLimit, busLimitWindow),
	}
}

// BusStopsPageData is the /bus-stops page's own view-model.
type BusStopsPageData struct {
	MapsAPIKey string
}

// Index handles GET /bus-stops: the full page. Always sets
// Permissions-Policy: geolocation=(self). When a Maps key is configured it
// also replaces the site-wide CSP with Google's nonce-based Maps policy for
// this one response (the SecurityHeaders middleware has already set the
// strict default, so Set here overrides it). Without a key the strict
// site CSP stays as-is, since no Google script will ever load.
func (h *BusStopsHandler) Index(w http.ResponseWriter, r *http.Request) {
	data := shellPageData(r, h.Version, "Bus Stop Finder", false)
	data.ContentTemplate = "bus-stops-content"
	data.BusStops = &BusStopsPageData{MapsAPIKey: h.MapsAPIKey}

	w.Header().Set("Permissions-Policy", "geolocation=(self)")
	if h.MapsAPIKey != "" {
		nonce, err := newCSPNonce()
		if err != nil {
			slog.Error("generate csp nonce", "error", err)
			http.Error(w, "internal server error", http.StatusInternalServerError)
			return
		}
		data.CSPNonce = nonce
		w.Header().Set("Content-Security-Policy", busStopsMapsCSP(nonce))
	}
	h.Renderer.Render(w, r, data)
}

// busStopsMapsCSP is Google's recommended strict (nonce-based) policy for
// the Maps JavaScript API (developers.google.com/maps/documentation/
// javascript/content-security-policy), merged with this site's own
// baseline: default-src/base-uri/object-src/frame-ancestors are kept from
// middleware.SecurityHeaders, and 'self' is added to font-src/style-src
// for the site's self-hosted fonts and output.css. 'strict-dynamic' means
// host allowlists are ignored for scripts, so every <script> on the page
// must carry the nonce (base.html adds it when PageData.CSPNonce is set).
func busStopsMapsCSP(nonce string) string {
	n := "'nonce-" + nonce + "'"
	return strings.Join([]string{
		"default-src 'self'",
		"base-uri 'self'",
		"object-src 'none'",
		"frame-ancestors 'none'",
		"script-src " + n + " 'strict-dynamic' https: 'unsafe-eval' blob:",
		"img-src 'self' https://*.googleapis.com https://*.gstatic.com *.google.com *.googleusercontent.com data:",
		"frame-src *.google.com",
		"connect-src 'self' https://*.googleapis.com *.google.com https://*.gstatic.com data: blob:",
		"font-src 'self' https://fonts.gstatic.com",
		"style-src 'self' " + n + " https://fonts.googleapis.com",
		"worker-src blob:",
	}, "; ")
}

func newCSPNonce() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	// Hex, not base64: html/template escapes base64's "+" as "&#43;" in
	// attributes, which browsers decode but which made exact-match checks
	// (and anyone grepping the HTML) see a different nonce than the header.
	return hex.EncodeToString(b), nil
}

// BusStopListView is the "bus-stop-list" fragment's view-model, shared by
// Nearby and Search.
type BusStopListView struct {
	Mode  string // "nearby" | "search" | "postal"
	Query string
	// Place is the geocoded postal code's name ("106 Simei Street 1"), set
	// only in "postal" mode, with its coordinates for the map's place marker.
	Place    string
	PlaceLat string
	PlaceLng string
	Stops    []BusStopCardView
}

// BusStopCardView is one card in the list.
type BusStopCardView struct {
	Rank           int
	Code           string
	Name           string
	Road           string
	Lat            string
	Lng            string
	HasDistance    bool
	DistanceMeters int
	WalkMinutes    int
	First          bool
}

// BusMessageView is the small message fragment returned for validation
// failures, rate limiting, and internal errors on the list routes. State
// lets bus-stops.js react (e.g. show the search box for "outside-sg").
type BusMessageView struct {
	State   string
	Title   string
	Message string
}

const (
	busMsgInvalidLocation = "We couldn't read your location. Try again, or search by stop code."
	busMsgOutsideSG       = "Bus Stop Finder only covers Singapore. You can still search for a stop by code or name."
	busMsgInvalidQuery    = "Enter 2 to 40 characters: a stop code, stop name or road."
	busMsgRateLimited     = "Too many requests. Wait a moment and try again."
	busMsgListError       = "Something went wrong finding stops. Try again shortly."
	busMsgArrivalsDown    = "Live arrival times are unavailable right now. Try again shortly."
	busMsgInvalidCode     = "That isn't a valid stop code."
	busMsgStopNotFound    = "We couldn't find that stop."
	busMsgRouteInvalid    = "That isn't a valid stop or bus number."
	busMsgRouteNotFound   = "This bus doesn't list a route through this stop."
	busMsgRouteError      = "Couldn't load this bus's route. Try again shortly."
	busMsgPostalNotFound  = "We couldn't find an address for that postal code. Check the number, or search by stop code or road."
	busMsgPostalDown      = "Postal code search is unavailable right now. Try a stop code or road name instead."
)

// Nearby handles GET /bus-stops/nearby?lat=&lng=.
func (h *BusStopsHandler) Nearby(w http.ResponseWriter, r *http.Request) {
	// Location-derived results: keep them out of browser/proxy caches.
	w.Header().Set("Cache-Control", "no-store")
	if !h.nearbyLimiter.Allow(middleware.ClientKey(r)) {
		h.renderMessage(w, http.StatusTooManyRequests, BusMessageView{State: "rate-limited", Message: busMsgRateLimited})
		return
	}

	lat, latErr := parseCoordinate(r.URL.Query().Get("lat"))
	lng, lngErr := parseCoordinate(r.URL.Query().Get("lng"))
	if latErr != nil || lngErr != nil {
		h.renderMessage(w, http.StatusBadRequest, BusMessageView{State: "invalid-location", Message: busMsgInvalidLocation})
		return
	}

	stops, err := h.Service.Nearby(r.Context(), lat, lng)
	if err != nil {
		switch {
		case errors.Is(err, service.ErrBusInvalidLocation):
			h.renderMessage(w, http.StatusBadRequest, BusMessageView{State: "invalid-location", Message: busMsgInvalidLocation})
		case errors.Is(err, service.ErrBusOutsideSingapore):
			h.renderMessage(w, http.StatusBadRequest, BusMessageView{State: "outside-sg", Title: "Outside Singapore", Message: busMsgOutsideSG})
		default:
			slog.Error("bus nearby", "error", err)
			h.renderMessage(w, http.StatusInternalServerError, BusMessageView{State: "error", Message: busMsgListError})
		}
		return
	}

	view := BusStopListView{Mode: "nearby"}
	for i, s := range stops {
		card := cardFromStop(i, s.BusStop)
		card.HasDistance = true
		card.DistanceMeters = s.DistanceMeters
		card.WalkMinutes = walkMinutes(s.DistanceMeters)
		view.Stops = append(view.Stops, card)
	}
	h.Renderer.RenderFragment(w, "bus-stop-list", view)
}

// Search handles GET /bus-stops/search?q=.
func (h *BusStopsHandler) Search(w http.ResponseWriter, r *http.Request) {
	// Location-derived results: keep them out of browser/proxy caches.
	w.Header().Set("Cache-Control", "no-store")
	if !h.searchLimiter.Allow(middleware.ClientKey(r)) {
		h.renderMessage(w, http.StatusTooManyRequests, BusMessageView{State: "rate-limited", Message: busMsgRateLimited})
		return
	}

	q := r.URL.Query().Get("q")
	if service.IsBusPostalCode(q) {
		h.searchPostal(w, r, q)
		return
	}
	stops, err := h.Service.Search(r.Context(), q)
	if err != nil {
		if errors.Is(err, service.ErrBusSearchQueryInvalid) {
			h.renderMessage(w, http.StatusBadRequest, BusMessageView{State: "invalid-query", Message: busMsgInvalidQuery})
			return
		}
		slog.Error("bus search", "error", err)
		h.renderMessage(w, http.StatusInternalServerError, BusMessageView{State: "error", Message: busMsgListError})
		return
	}

	view := BusStopListView{Mode: "search", Query: strings.TrimSpace(q)}
	for i, s := range stops {
		view.Stops = append(view.Stops, cardFromStop(i, s))
	}
	h.Renderer.RenderFragment(w, "bus-stop-list", view)
}

// searchPostal answers a 6-digit search: the stops nearest the postal
// code's address, rendered like Nearby (distances, nearest expanded by
// bus-stops.js) under a "Stops near <place>" heading.
func (h *BusStopsHandler) searchPostal(w http.ResponseWriter, r *http.Request, q string) {
	res, err := h.Service.SearchPostal(r.Context(), q)
	if err != nil {
		switch {
		case errors.Is(err, service.ErrBusPostalNotFound):
			h.renderMessage(w, http.StatusNotFound, BusMessageView{State: "postal-not-found", Title: "Postal code not found", Message: busMsgPostalNotFound})
		case errors.Is(err, service.ErrBusPostalUnavailable):
			h.renderMessage(w, http.StatusServiceUnavailable, BusMessageView{State: "postal-unavailable", Message: busMsgPostalDown})
		case errors.Is(err, service.ErrBusSearchQueryInvalid):
			h.renderMessage(w, http.StatusBadRequest, BusMessageView{State: "invalid-query", Message: busMsgInvalidQuery})
		default:
			slog.Error("bus postal search", "error", err)
			h.renderMessage(w, http.StatusInternalServerError, BusMessageView{State: "error", Message: busMsgListError})
		}
		return
	}

	view := BusStopListView{Mode: "postal", Query: res.Postal, Place: res.Label,
		PlaceLat: posString(true, res.Latitude), PlaceLng: posString(true, res.Longitude)}
	for i, s := range res.Stops {
		card := cardFromStop(i, s.BusStop)
		card.HasDistance = true
		card.DistanceMeters = s.DistanceMeters
		card.WalkMinutes = walkMinutes(s.DistanceMeters)
		view.Stops = append(view.Stops, card)
	}
	h.Renderer.RenderFragment(w, "bus-stop-list", view)
}

// BusRouteView is the "bus-route" fragment: where one service goes from the
// stop the visitor opened. Stops carry data-lat/lng for the map; a stop LTA
// lists without coordinates has empty ones and is left off the line.
type BusRouteView struct {
	Code      string // boarding stop code
	ServiceNo string
	Boarding  BusRouteStopView
	Approach  []BusRouteStopView
	Onward    []BusRouteStopView
	Terminus  string
	TotalKm   string // "4.5 km"
	Count     int    // onward stops
}

// BusRouteStopView is one stop line in the route list.
type BusRouteStopView struct {
	Code string
	Name string
	Km   string // "+0.3 km", "0 km", "-0.6 km"
	Lat  string
	Lng  string
	Last bool
}

// Route handles GET /bus-stops/{code}/route/{service}: the "where this bus
// goes" list for one service at one stop, swapped into the card's route
// slot by bus-stops.js (which also draws it on the map when there is one).
// Route data only changes with the nightly sync, so it may be cached
// briefly; it carries no visitor location.
func (h *BusStopsHandler) Route(w http.ResponseWriter, r *http.Request) {
	if !h.routeLimiter.Allow(middleware.ClientKey(r)) {
		h.renderMessage(w, http.StatusTooManyRequests, BusMessageView{State: "rate-limited", Message: busMsgRateLimited})
		return
	}
	code, svc := r.PathValue("code"), r.PathValue("service")
	route, err := h.Service.Route(r.Context(), code, svc)
	if err != nil {
		switch {
		case errors.Is(err, service.ErrBusStopCodeInvalid), errors.Is(err, service.ErrBusServiceInvalid):
			h.renderMessage(w, http.StatusBadRequest, BusMessageView{State: "route-invalid", Message: busMsgRouteInvalid})
		case errors.Is(err, service.ErrBusRouteNotFound):
			h.renderMessage(w, http.StatusNotFound, BusMessageView{State: "route-not-found", Message: busMsgRouteNotFound})
		default:
			slog.Error("bus route", "error", err)
			h.renderMessage(w, http.StatusInternalServerError, BusMessageView{State: "error", Message: busMsgRouteError})
		}
		return
	}

	w.Header().Set("Cache-Control", "public, max-age=300")
	view := BusRouteView{Code: route.Boarding.Code, ServiceNo: route.ServiceNo, Boarding: routeStopView(route.Boarding, false), Count: len(route.Onward)}
	for _, st := range route.Approach {
		view.Approach = append(view.Approach, routeStopView(st, false))
	}
	for i, st := range route.Onward {
		view.Onward = append(view.Onward, routeStopView(st, i == len(route.Onward)-1))
	}
	if n := len(route.Onward); n > 0 {
		last := route.Onward[n-1]
		view.Terminus = last.Name
		view.TotalKm = strconv.FormatFloat(last.KmFromBoarding, 'f', 1, 64) + " km"
	}
	h.Renderer.RenderFragment(w, "bus-route", view)
}

func routeStopView(st model.RouteStop, last bool) BusRouteStopView {
	v := BusRouteStopView{Code: st.Code, Name: st.Name, Last: last}
	switch km := st.KmFromBoarding; {
	case km > 0:
		v.Km = "+" + strconv.FormatFloat(km, 'f', 1, 64) + " km"
	case km < 0:
		v.Km = strconv.FormatFloat(km, 'f', 1, 64) + " km"
	default:
		v.Km = "0 km"
	}
	v.Lat = posString(st.HasPosition, st.Latitude)
	v.Lng = posString(st.HasPosition, st.Longitude)
	return v
}

// posString formats a coordinate for a data- attribute, "" when unknown.
func posString(ok bool, v float64) string {
	if !ok {
		return ""
	}
	return strconv.FormatFloat(v, 'f', 6, 64)
}

func cardFromStop(i int, s model.BusStop) BusStopCardView {
	return BusStopCardView{
		Rank:  i + 1,
		Code:  s.Code,
		Name:  s.Description,
		Road:  s.RoadName,
		Lat:   strconv.FormatFloat(s.Latitude, 'f', 6, 64),
		Lng:   strconv.FormatFloat(s.Longitude, 'f', 6, 64),
		First: i == 0,
	}
}

// walkMinutes estimates walking time at ~80 m/min, never below 1.
func walkMinutes(meters int) int {
	m := int(math.Ceil(float64(meters) / 80))
	if m < 1 {
		return 1
	}
	return m
}

// parseCoordinate parses a finite float. Range checks are the service's
// job (ErrBusOutsideSingapore); this only rejects unparseable input.
func parseCoordinate(raw string) (float64, error) {
	v, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil {
		return 0, err
	}
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, errors.New("not finite")
	}
	return v, nil
}

func (h *BusStopsHandler) renderMessage(w http.ResponseWriter, status int, view BusMessageView) {
	h.renderStatus(w, status, "bus-stop-message", view)
}

// renderStatus is RenderFragment with an explicit status code, buffered so
// a template failure still produces a clean 500 instead of a half-written
// fragment.
func (h *BusStopsHandler) renderStatus(w http.ResponseWriter, status int, name string, data any) {
	var buf bytes.Buffer
	if err := h.Renderer.tmpl.ExecuteTemplate(&buf, name, data); err != nil {
		h.Renderer.renderError(w, name, err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	w.Write(buf.Bytes())
}

// BusArrivalsView is the "bus-arrivals" fragment's view-model.
type BusArrivalsView struct {
	Code       string
	State      string // "live" | "unavailable" | "invalid" | "not-found" | "rate-limited"
	Poll       bool   // re-declare hx-trigger="every 20s" on this fragment
	Message    string
	Stale      bool
	UpdatedAgo string
	Services   []BusServiceRowView
}

// BusServiceRowView is one service row in the expanded card.
type BusServiceRowView struct {
	ServiceNo    string
	Destination  string
	Wheelchair   bool
	Buses        []BusTimeView
	Status       string
	FirstBus     string // "HH:MM" or ""
	ShowFirstBus bool
	// Hours is today's "First 05:30 · Last 00:30" line for this stop, ""
	// when LTA publishes no times (docs/features/bus-stop-finder.md's
	// Scope: "today's first/last bus").
	Hours string
}

// BusTimeView is one of the up-to-three times in a row.
type BusTimeView struct {
	Label     string // "Arr" or "8"
	Arriving  bool
	Scheduled bool
	Segments  int // 1 seats, 2 standing, 3 limited, 0 unknown
	LoadLabel string
	// Deck is this bus's vehicle type — LTA reports it per bus, and the
	// three buses on one route can differ. "SD" | "DD" | "BD" | "" (unknown).
	Deck string
	// Lat/Lng are this bus's live position ("" when LTA has no fix), read
	// by bus-stops.js to draw live-bus markers. Formatted, not raw floats,
	// so the attribute is stable text.
	Lat       string
	Lng       string
	DeckShort string // visible word: "Single" | "Double" | "Bendy"
	DeckLabel string // accessible name: "Single deck" | "Double deck" | "Bendy bus"
}

// Arrivals handles GET /bus-stops/{code}/arrivals.
func (h *BusStopsHandler) Arrivals(w http.ResponseWriter, r *http.Request) {
	// Location-derived results: keep them out of browser/proxy caches.
	w.Header().Set("Cache-Control", "no-store")
	code := r.PathValue("code")
	view := BusArrivalsView{Code: safeCode(code)}

	if !h.arrivalsLimiter.Allow(middleware.ClientKey(r)) {
		view.State, view.Poll, view.Message = "rate-limited", true, busMsgRateLimited
		h.renderArrivals(w, http.StatusTooManyRequests, view)
		return
	}

	arrivals, err := h.Service.Arrivals(r.Context(), code)
	if err != nil {
		switch {
		case errors.Is(err, service.ErrBusStopCodeInvalid):
			view.State, view.Message = "invalid", busMsgInvalidCode
			h.renderArrivals(w, http.StatusBadRequest, view)
		case errors.Is(err, service.ErrBusStopNotFound):
			view.State, view.Message = "not-found", busMsgStopNotFound
			h.renderArrivals(w, http.StatusNotFound, view)
		case errors.Is(err, service.ErrBusArrivalsUnavailable), errors.Is(err, service.ErrBusLTANotConfigured):
			view.State, view.Poll, view.Message = "unavailable", true, busMsgArrivalsDown
			h.renderArrivals(w, http.StatusOK, view)
		default:
			slog.Error("bus arrivals", "error", err)
			view.State, view.Poll, view.Message = "unavailable", true, busMsgArrivalsDown
			h.renderArrivals(w, http.StatusInternalServerError, view)
		}
		return
	}

	view.State, view.Poll = "live", true
	view.Stale = arrivals.Stale
	view.UpdatedAgo = updatedAgo(h.now().Sub(arrivals.FetchedAt))
	for _, svc := range arrivals.Services {
		view.Services = append(view.Services, serviceRow(svc))
	}
	h.renderArrivals(w, http.StatusOK, view)
}

// safeCode keeps the fragment's element id well-formed even for a bad
// code: only a 5-digit code is echoed into id/hx-get attributes.
func safeCode(code string) string {
	if len(code) != 5 {
		return "invalid"
	}
	for _, c := range code {
		if c < '0' || c > '9' {
			return "invalid"
		}
	}
	return code
}

func (h *BusStopsHandler) renderArrivals(w http.ResponseWriter, status int, view BusArrivalsView) {
	h.renderStatus(w, status, "bus-arrivals", view)
}

func serviceRow(svc model.ServiceArrivals) BusServiceRowView {
	row := BusServiceRowView{
		ServiceNo:   svc.ServiceNo,
		Destination: svc.Destination,
		Status:      string(svc.Status),
	}
	if len(svc.NextBuses) > 0 {
		row.Wheelchair = svc.NextBuses[0].WheelchairAccess
	}
	for _, b := range svc.NextBuses {
		segments, label := loadInfo(b.Load)
		if !b.Monitored {
			label += ", timetable estimate"
		}
		short, long := deckLabels(b.Type)
		row.Buses = append(row.Buses, BusTimeView{
			Label:     b.Label,
			Arriving:  b.IsArriving,
			Scheduled: !b.Monitored,
			Segments:  segments,
			LoadLabel: label,
			Deck:      b.Type,
			Lat:       posString(b.HasPosition, b.Latitude),
			Lng:       posString(b.HasPosition, b.Longitude),
			DeckShort: short,
			DeckLabel: long,
		})
	}
	if len(row.Buses) == 0 && row.Status == "" {
		row.Status = string(model.StatusNoEstimate)
	}
	if first, last := formatHHMM(svc.FirstBus), formatHHMM(svc.LastBus); first != "" && last != "" {
		row.Hours = "First " + first + " · Last " + last
	}
	if svc.Status == model.StatusNotInOperation && svc.FirstBus != "" {
		row.FirstBus = formatHHMM(svc.FirstBus)
		row.ShowFirstBus = row.FirstBus != ""
	}
	return row
}

// deckLabels maps LTA's vehicle Type to the short word shown under a time
// and the accessible name its icon carries. Unknown types show nothing.
func deckLabels(t string) (short, long string) {
	switch t {
	case "SD":
		return "Single", "Single deck"
	case "DD":
		return "Double", "Double deck"
	case "BD":
		return "Bendy", "Bendy bus"
	}
	return "", ""
}

func loadInfo(l model.BusLoad) (int, string) {
	switch l {
	case model.LoadSeats:
		return 1, "Seats available"
	case model.LoadStanding:
		return 2, "Standing room"
	case model.LoadLimited:
		return 3, "Limited standing"
	}
	return 0, "Crowding unknown"
}

// formatHHMM turns LTA's "0620" into "06:20"; anything malformed renders
// as "" rather than echoing raw data.
func formatHHMM(s string) string {
	if len(s) != 4 {
		return ""
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return ""
		}
	}
	// LTA writes times past midnight as 24xx ("2400", "2430"); show them
	// as a clock reads them.
	hh := int(s[0]-'0')*10 + int(s[1]-'0')
	return fmt.Sprintf("%02d:%s", hh%24, s[2:])
}

func updatedAgo(d time.Duration) string {
	if d < 5*time.Second {
		return "just now"
	}
	if d < time.Minute {
		return fmt.Sprintf("%d s ago", int(d.Seconds()))
	}
	return fmt.Sprintf("%d min ago", int(d.Minutes()))
}
