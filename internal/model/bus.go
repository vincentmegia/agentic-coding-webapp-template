package model

import "time"

// BusStop is one bus_stops row: LTA DataMall's BusStops dataset, synced
// nightly. See docs/features/bus-stop-finder.md's Data Model.
type BusStop struct {
	Code        string // exactly 5 digits, e.g. "01012"
	RoadName    string // e.g. "Victoria St"
	Description string // landmark name, e.g. "Hotel Grand Pacific"
	Latitude    float64
	Longitude   float64
}

// NearbyStop is a BusStop plus its straight-line distance from the
// searcher, as returned by the nearest-stop query.
type NearbyStop struct {
	BusStop
	DistanceMeters int
}

// BusRoute is one bus_routes row: one service's visit to one stop, from
// LTA DataMall's BusRoutes dataset. First/last bus times are "HHMM" in
// Singapore time, or "" when LTA publishes none for that day type.
type BusRoute struct {
	ServiceNo    string // e.g. "7", "225G"
	Operator     string // SBST | SMRT | TTS | GAS
	Direction    int    // 1 or 2
	StopSequence int
	BusStopCode  string
	DistanceKm   float64
	WDFirstBus   string
	WDLastBus    string
	SATFirstBus  string
	SATLastBus   string
	SUNFirstBus  string
	SUNLastBus   string
}

// DayType selects which first/last-bus columns apply: LTA publishes
// separate times for weekdays, Saturdays, and Sundays (public holidays
// count as Sundays in LTA's own convention, but this feature has no
// holiday calendar, so it only ever picks by weekday — see the doc's
// Open Questions).
type DayType string

const (
	DayWeekday  DayType = "WD"
	DaySaturday DayType = "SAT"
	DaySunday   DayType = "SUN"
)

// ServiceHours is one service's first/last bus at one stop for one day
// type, already picked for "today" by the caller. Empty strings mean LTA
// publishes no times (the service doesn't run that day type).
type ServiceHours struct {
	ServiceNo string
	FirstBus  string // "HHMM" or ""
	LastBus   string // "HHMM" or ""
}

// BusLoad is LTA's crowding code for one oncoming bus.
type BusLoad string

const (
	LoadSeats    BusLoad = "SEA" // seats available
	LoadStanding BusLoad = "SDA" // standing available
	LoadLimited  BusLoad = "LSD" // limited standing
)

// NextBus is one of the (up to) three oncoming buses LTA reports for a
// service at a stop. Display-ready: Label is already rounded per LTA's
// advisement ("Arr" under one minute, else whole minutes rounded down).
type NextBus struct {
	EstimatedArrival time.Time
	Label            string  // "Arr" or e.g. "8" (minutes)
	IsArriving       bool    // Label == "Arr"
	Monitored        bool    // false = timetable estimate, shown italic with "~"
	Load             BusLoad // SEA | SDA | LSD
	Type             string  // "SD" | "DD" | "BD"
	WheelchairAccess bool    // LTA Feature == "WAB"
	// Latitude/Longitude are the bus's current position as LTA estimates it.
	// HasPosition is false when LTA has no live fix (it sends "0" for
	// timetable-only buses) or the point falls outside Singapore.
	Latitude    float64
	Longitude   float64
	HasPosition bool
}

// RouteStop is one stop on a service's route, for the "where this bus goes"
// view. KmFromBoarding is the distance from the stop the visitor is at
// (negative for stops the bus passes before reaching it). HasPosition is
// false for a stop LTA lists on the route but not in BusStops (e.g. Larkin
// Ter in Johor Bahru); it's listed by code only and left off the map.
type RouteStop struct {
	Code           string
	Name           string
	Road           string
	Latitude       float64
	Longitude      float64
	HasPosition    bool
	KmFromBoarding float64
}

// RouteRow is one bus_routes row joined to its stop, as the repository
// returns it for building a ServiceRoute.
type RouteRow struct {
	Direction    int
	StopSequence int
	Stop         RouteStop // KmFromBoarding holds the route's own cumulative km here
}

// ServiceRoute is where one service goes from one stop: the stops it comes
// from (Approach, up to 2, nearest last) and every stop after (Onward,
// ending at the terminus).
type ServiceRoute struct {
	ServiceNo string
	Direction int
	Boarding  RouteStop
	Approach  []RouteStop
	Onward    []RouteStop
}

// ServiceStatus is the advisement shown when LTA returns no arrival data
// for a service (docs/features/bus-stop-finder.md's Business Rules).
type ServiceStatus string

const (
	StatusLive           ServiceStatus = ""                  // has NextBuses
	StatusNoEstimate     ServiceStatus = "No Est. Available" // within operating hours, no data
	StatusNotInOperation ServiceStatus = "Not In Operation"  // outside operating hours, no data
)

// ServiceArrivals is one row of the expanded stop card.
type ServiceArrivals struct {
	ServiceNo   string
	Operator    string
	Destination string    // destination stop's Description, "" if unknown
	NextBuses   []NextBus // 0–3 entries; empty means Status is set
	Status      ServiceStatus
	FirstBus    string // today's "HHMM" at this stop, "" if unknown
	LastBus     string
}

// StopArrivals is everything the arrivals fragment renders for one stop.
type StopArrivals struct {
	Stop      BusStop
	Services  []ServiceArrivals // natural sort by ServiceNo
	FetchedAt time.Time         // when LTA data was fetched (may be up to the stale window old)
	Stale     bool              // true when serving cached data because LTA failed
}
