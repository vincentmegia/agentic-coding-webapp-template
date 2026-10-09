package lta

import (
	"encoding/json"
	"strconv"
)

// BusArrivalResponse mirrors LTA's v3 BusArrival JSON. When buses are not
// in service LTA may return an empty Services array (or nothing at all).
type BusArrivalResponse struct {
	BusStopCode string           `json:"BusStopCode"`
	Services    []ServiceArrival `json:"Services"`
}

// ServiceArrival is one service at the queried stop.
type ServiceArrival struct {
	ServiceNo string  `json:"ServiceNo"`
	Operator  string  `json:"Operator"`
	NextBus   NextBus `json:"NextBus"`
	NextBus2  NextBus `json:"NextBus2"`
	NextBus3  NextBus `json:"NextBus3"`
}

// NextBus mirrors one oncoming bus. Every field is empty when LTA has no
// bus for that slot (e.g. NextBus2/NextBus3 late at night).
type NextBus struct {
	OriginCode       string     `json:"OriginCode"`
	DestinationCode  string     `json:"DestinationCode"`
	EstimatedArrival string     `json:"EstimatedArrival"` // RFC 3339 with +08:00, or ""
	Monitored        FlexInt    `json:"Monitored"`        // 1 = live location, 0 = schedule
	Latitude         FlexString `json:"Latitude"`
	Longitude        FlexString `json:"Longitude"`
	VisitNumber      FlexString `json:"VisitNumber"`
	Load             string     `json:"Load"`    // SEA | SDA | LSD
	Feature          string     `json:"Feature"` // "WAB" or ""
	Type             string     `json:"Type"`    // SD | DD | BD
}

// BusStopRecord mirrors one BusStops row.
type BusStopRecord struct {
	BusStopCode string  `json:"BusStopCode"`
	RoadName    string  `json:"RoadName"`
	Description string  `json:"Description"`
	Latitude    float64 `json:"Latitude"`
	Longitude   float64 `json:"Longitude"`
}

// BusRouteRecord mirrors one BusRoutes row. Times are "HHMM" or "-".
type BusRouteRecord struct {
	ServiceNo    string     `json:"ServiceNo"`
	Operator     string     `json:"Operator"`
	Direction    int        `json:"Direction"`
	StopSequence int        `json:"StopSequence"`
	BusStopCode  string     `json:"BusStopCode"`
	Distance     FlexString `json:"Distance"`
	WDFirstBus   string     `json:"WD_FirstBus"`
	WDLastBus    string     `json:"WD_LastBus"`
	SATFirstBus  string     `json:"SAT_FirstBus"`
	SATLastBus   string     `json:"SAT_LastBus"`
	SUNFirstBus  string     `json:"SUN_FirstBus"`
	SUNLastBus   string     `json:"SUN_LastBus"`
}

// FlexInt accepts a JSON number or a numeric string (LTA has published
// both shapes for Monitored over its versions); anything else is 0.
type FlexInt int

func (f *FlexInt) UnmarshalJSON(b []byte) error {
	var n json.Number
	if err := json.Unmarshal(b, &n); err == nil {
		if i, err := strconv.Atoi(n.String()); err == nil {
			*f = FlexInt(i)
			return nil
		}
	}
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		if i, err := strconv.Atoi(s); err == nil {
			*f = FlexInt(i)
			return nil
		}
	}
	*f = 0
	return nil
}

// FlexString accepts a JSON string or number and keeps its text form
// (Latitude/Longitude/VisitNumber/Distance vary between string and
// number across LTA's datasets).
type FlexString string

func (f *FlexString) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		*f = FlexString(s)
		return nil
	}
	var n json.Number
	if err := json.Unmarshal(b, &n); err == nil {
		*f = FlexString(n.String())
		return nil
	}
	*f = ""
	return nil
}

// Float parses the value, returning 0 when it isn't numeric.
func (f FlexString) Float() float64 {
	v, err := strconv.ParseFloat(string(f), 64)
	if err != nil {
		return 0
	}
	return v
}
