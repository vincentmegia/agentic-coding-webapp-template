package service

import (
	"errors"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/vincentmegia/vincentmegia/internal/lta"
	"github.com/vincentmegia/vincentmegia/internal/model"
)

// Bounds and fixed parameters from docs/features/bus-stop-finder.md's
// Business Rules and Data Model. The Singapore bounding box matches the
// bus_stops table's CHECK constraints.
const (
	busMinLat = 1.15
	busMaxLat = 1.48
	busMinLng = 103.6
	busMaxLng = 104.1

	busNearbyRadiusMeters = 500
	busNearbyLimit        = 5

	busSearchMinLen = 2
	busSearchMaxLen = 40
	busSearchLimit  = 10

	busTextMaxLen = 120
)

// sgt is Singapore time. A fixed zone rather than time.LoadLocation, so the
// binary doesn't depend on the host having tzdata (Singapore has no DST).
var sgt = time.FixedZone("SGT", 8*3600)

var (
	ErrBusInvalidLocation     = errors.New("location must be a valid latitude and longitude")
	ErrBusOutsideSingapore    = errors.New("Bus Stop Finder only covers Singapore")
	ErrBusSearchQueryInvalid  = errors.New("search must be 2 to 40 characters")
	ErrBusStopCodeInvalid     = errors.New("bus stop code must be 5 digits")
	ErrBusStopNotFound        = errors.New("bus stop not found")
	ErrBusArrivalsUnavailable = errors.New("live arrival times are unavailable right now")
	ErrBusSyncTooSmall        = errors.New("bus sync returned too few rows; keeping existing data")
	// ErrBusLTANotConfigured is returned by Sync when no LTA client is
	// configured (LTA_ACCOUNT_KEY unset).
	ErrBusLTANotConfigured = errors.New("LTA DataMall is not configured")
	// ErrBusPostalNotFound: OneMap has no exact match for the postal code,
	// or it geocodes outside Singapore's bounds.
	ErrBusPostalNotFound = errors.New("no address found for that postal code")
	// ErrBusPostalUnavailable: postal search isn't configured, or OneMap
	// failed (never carries the upstream error text).
	ErrBusPostalUnavailable = errors.New("postal code search is unavailable")
	// ErrBusServiceInvalid: a service number isn't 1–6 letters/digits.
	ErrBusServiceInvalid = errors.New("invalid bus service number")
	// ErrBusRouteNotFound: the service doesn't call at that stop (or the
	// stop/service is unknown).
	ErrBusRouteNotFound = errors.New("no route for that bus at this stop")
)

// ValidateBusLocation checks lat/lng are finite, rounds both to 3 decimals
// (~110 m — the doc's location-privacy rule, applied server-side too) and
// requires the rounded point to fall inside Singapore.
func ValidateBusLocation(lat, lng float64) (float64, float64, error) {
	if math.IsNaN(lat) || math.IsNaN(lng) || math.IsInf(lat, 0) || math.IsInf(lng, 0) {
		return 0, 0, ErrBusInvalidLocation
	}
	if lat < -90 || lat > 90 || lng < -180 || lng > 180 {
		return 0, 0, ErrBusInvalidLocation
	}
	rlat := math.Round(lat*1000) / 1000
	rlng := math.Round(lng*1000) / 1000
	if rlat < busMinLat || rlat > busMaxLat || rlng < busMinLng || rlng > busMaxLng {
		return 0, 0, ErrBusOutsideSingapore
	}
	return rlat, rlng, nil
}

// ValidateBusSearchQuery trims q and requires 2–40 characters.
func ValidateBusSearchQuery(q string) (string, error) {
	trimmed := strings.TrimSpace(q)
	n := utf8.RuneCountInString(trimmed)
	if n < busSearchMinLen || n > busSearchMaxLen {
		return "", ErrBusSearchQueryInvalid
	}
	return trimmed, nil
}

// ValidateBusStopCode requires exactly 5 ASCII digits.
func ValidateBusStopCode(code string) error {
	if len(code) != 5 || !isASCIIDigits(code) {
		return ErrBusStopCodeInvalid
	}
	return nil
}

// ValidateBusServiceNo accepts LTA-style service numbers: 1–6 ASCII
// letters or digits ("7", "12e", "225G", "170X", "NR1"), matching the
// bus_routes CHECK.
func ValidateBusServiceNo(no string) error {
	if len(no) < 1 || len(no) > 6 {
		return ErrBusServiceInvalid
	}
	for i := 0; i < len(no); i++ {
		c := no[i]
		if !(c >= '0' && c <= '9' || c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z') {
			return ErrBusServiceInvalid
		}
	}
	return nil
}

func isASCIIDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// arrivalLabel applies LTA's rounding advisement: under one minute
// (including a bus that's already due) is "Arr", otherwise whole minutes
// rounded down.
func arrivalLabel(est, now time.Time) (string, bool) {
	d := est.Sub(now)
	if d < time.Minute {
		return "Arr", true
	}
	return strconv.Itoa(int(d / time.Minute)), false
}

// naturalLess orders service numbers numerically by their leading digits,
// then by suffix: "2" < "7" < "12" < "225G" < "225W". Services with no
// leading digits sort after all numeric ones, alphabetically.
func naturalLess(a, b string) bool {
	an, as := splitServiceNo(a)
	bn, bs := splitServiceNo(b)
	switch {
	case an >= 0 && bn < 0:
		return true
	case an < 0 && bn >= 0:
		return false
	case an != bn:
		return an < bn
	case as != bs:
		return as < bs
	}
	return a < b
}

func splitServiceNo(s string) (int, string) {
	i := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	if i == 0 {
		return -1, s
	}
	n, err := strconv.Atoi(s[:i])
	if err != nil {
		return -1, s
	}
	return n, s[i:]
}

// parseHHMM returns minutes after midnight for an "HHMM" matching the
// bus_routes CHECK (^[0-2][0-9][0-5][0-9]$). LTA publishes "24xx"-style
// times for buses after midnight; those come back as ≥ 1440 (minutes past
// midnight of the next day, e.g. "2430" = 1470).
func parseHHMM(s string) (int, bool) {
	if len(s) != 4 || !isASCIIDigits(s) || s[0] > '2' || s[2] > '5' {
		return 0, false
	}
	h, _ := strconv.Atoi(s[:2])
	m, _ := strconv.Atoi(s[2:])
	return h*60 + m, true
}

// normalizeHHMM keeps a valid "HHMM" and turns anything else (LTA's "-",
// blanks, garbage) into "".
func normalizeHHMM(s string) string {
	s = strings.TrimSpace(s)
	if _, ok := parseHHMM(s); ok {
		return s
	}
	return ""
}

// serviceStatus picks LTA's advisement for a service with no arrival data.
// A last bus earlier than the first bus means the window wraps past
// midnight. Unknown hours are treated as "No Est. Available".
func serviceStatus(first, last string, now time.Time) model.ServiceStatus {
	f, okF := parseHHMM(first)
	l, okL := parseHHMM(last)
	if !okF || !okL {
		return model.StatusNoEstimate
	}
	local := now.In(sgt)
	m := local.Hour()*60 + local.Minute()
	var in bool
	switch {
	case l-f >= 24*60:
		// e.g. 0000–2400: runs all day.
		in = true
	default:
		fm, lm := f%(24*60), l%(24*60)
		if fm <= lm {
			in = m >= fm && m <= lm
		} else {
			// Wraps past midnight (0530–0030, or 0530–2430).
			in = m >= fm || m <= lm
		}
	}
	if in {
		return model.StatusNoEstimate
	}
	return model.StatusNotInOperation
}

// dayTypeFor picks WD/SAT/SUN by the Singapore calendar date.
func dayTypeFor(now time.Time) model.DayType {
	switch now.In(sgt).Weekday() {
	case time.Saturday:
		return model.DaySaturday
	case time.Sunday:
		return model.DaySunday
	default:
		return model.DayWeekday
	}
}

func inSingapore(lat, lng float64) bool {
	if math.IsNaN(lat) || math.IsNaN(lng) || math.IsInf(lat, 0) || math.IsInf(lng, 0) {
		return false
	}
	return lat >= busMinLat && lat <= busMaxLat && lng >= busMinLng && lng <= busMaxLng
}

// validStopRecord converts one LTA BusStops row, or reports it invalid
// (sync drops invalid rows rather than failing the whole sync).
func validStopRecord(r lta.BusStopRecord) (model.BusStop, bool) {
	code := strings.TrimSpace(r.BusStopCode)
	road := strings.TrimSpace(r.RoadName)
	desc := strings.TrimSpace(r.Description)
	if ValidateBusStopCode(code) != nil {
		return model.BusStop{}, false
	}
	if utf8.RuneCountInString(road) > busTextMaxLen || utf8.RuneCountInString(desc) > busTextMaxLen {
		return model.BusStop{}, false
	}
	if !utf8.ValidString(road) || !utf8.ValidString(desc) {
		return model.BusStop{}, false
	}
	if !inSingapore(r.Latitude, r.Longitude) {
		return model.BusStop{}, false
	}
	return model.BusStop{Code: code, RoadName: road, Description: desc, Latitude: r.Latitude, Longitude: r.Longitude}, true
}

// validRouteRecord converts one LTA BusRoutes row, or reports it invalid.
// Bad first/last times don't invalidate the row; they become "".
func validRouteRecord(r lta.BusRouteRecord) (model.BusRoute, bool) {
	svc := strings.TrimSpace(r.ServiceNo)
	code := strings.TrimSpace(r.BusStopCode)
	op := strings.TrimSpace(r.Operator)
	if len(svc) < 1 || len(svc) > 6 {
		return model.BusRoute{}, false
	}
	for i := 0; i < len(svc); i++ {
		c := svc[i]
		if !(c >= '0' && c <= '9' || c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z') {
			return model.BusRoute{}, false
		}
	}
	if ValidateBusStopCode(code) != nil || (r.Direction != 1 && r.Direction != 2) || r.StopSequence < 0 {
		return model.BusRoute{}, false
	}
	if utf8.RuneCountInString(op) > 20 {
		return model.BusRoute{}, false
	}
	dist := r.Distance.Float()
	if math.IsNaN(dist) || math.IsInf(dist, 0) || dist < 0 {
		dist = 0
	}
	return model.BusRoute{
		ServiceNo:    svc,
		Operator:     op,
		Direction:    r.Direction,
		StopSequence: r.StopSequence,
		BusStopCode:  code,
		DistanceKm:   dist,
		WDFirstBus:   normalizeHHMM(r.WDFirstBus),
		WDLastBus:    normalizeHHMM(r.WDLastBus),
		SATFirstBus:  normalizeHHMM(r.SATFirstBus),
		SATLastBus:   normalizeHHMM(r.SATLastBus),
		SUNFirstBus:  normalizeHHMM(r.SUNFirstBus),
		SUNLastBus:   normalizeHHMM(r.SUNLastBus),
	}, true
}
