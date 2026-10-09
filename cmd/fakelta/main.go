// Command fakelta is a dev-only stand-in for LTA DataMall, for local runs
// and the Playwright suite of the Bus Stop Finder
// (docs/features/bus-stop-finder.md). Point the server at it with
// LTA_BASE_URL=http://127.0.0.1:8099 and any non-empty LTA_ACCOUNT_KEY.
//
// It serves the three endpoints the app uses with fixture data around
// Victoria St/Bugis. Arrivals are computed relative to the current time so
// the UI always looks live, and are deterministic per stop/service:
//
//   - 01012 service 7: first bus always ~30 s away ("Arr"), then 8 and 17
//     minutes; loads SEA/SDA/LSD; the third is a timetable estimate.
//   - 01012 service 225G: only NextBus (NextBus2/3 empty, as LTA sends late
//     at night).
//   - 01012 service 61: routed with hours 0000–2359 but absent from
//     arrivals → "No Est. Available".
//   - 01012 service 960: routed with hours 0500–0501 and absent from
//     arrivals → "Not In Operation" (except during that one minute).
//
// FAKELTA_FAIL_ARRIVALS=1 makes BusArrival return 500, for testing the
// stale/unavailable states. GET /healthz needs no AccountKey.
//
// It also fakes OneMap's postal-code search (GET /api/common/elastic/search,
// no key, like the real one), for ONEMAP_BASE_URL=http://127.0.0.1:8099:
//
//   - 188592 → Bras Basah Complex, next to the Victoria St fixture stops.
//   - 456789 → a real-looking address in Singapore with no fixture stop
//     within 500 m (the postal empty state).
//   - 999999 → no result ("Postal code not found").
//   - 111111 → 500 ("Postal code search is unavailable").
package main

import (
	"embed"
	"encoding/json"
	"hash/fnv"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"
)

//go:embed fixtures/stops.json
var fixtures embed.FS

const pageSize = 500

var sgt = time.FixedZone("SGT", 8*3600)

type stopRec struct {
	BusStopCode string  `json:"BusStopCode"`
	RoadName    string  `json:"RoadName"`
	Description string  `json:"Description"`
	Latitude    float64 `json:"Latitude"`
	Longitude   float64 `json:"Longitude"`
}

type routeRec struct {
	ServiceNo    string  `json:"ServiceNo"`
	Operator     string  `json:"Operator"`
	Direction    int     `json:"Direction"`
	StopSequence int     `json:"StopSequence"`
	BusStopCode  string  `json:"BusStopCode"`
	Distance     float64 `json:"Distance"`
	WDFirstBus   string  `json:"WD_FirstBus"`
	WDLastBus    string  `json:"WD_LastBus"`
	SATFirstBus  string  `json:"SAT_FirstBus"`
	SATLastBus   string  `json:"SAT_LastBus"`
	SUNFirstBus  string  `json:"SUN_FirstBus"`
	SUNLastBus   string  `json:"SUN_LastBus"`
}

type nextBus struct {
	OriginCode       string `json:"OriginCode"`
	DestinationCode  string `json:"DestinationCode"`
	EstimatedArrival string `json:"EstimatedArrival"`
	Monitored        int    `json:"Monitored"`
	Latitude         string `json:"Latitude"`
	Longitude        string `json:"Longitude"`
	VisitNumber      string `json:"VisitNumber"`
	Load             string `json:"Load"`
	Feature          string `json:"Feature"`
	Type             string `json:"Type"`
}

type serviceArrival struct {
	ServiceNo string  `json:"ServiceNo"`
	Operator  string  `json:"Operator"`
	NextBus   nextBus `json:"NextBus"`
	NextBus2  nextBus `json:"NextBus2"`
	NextBus3  nextBus `json:"NextBus3"`
}

// service describes one bus service in the fixture world.
type service struct {
	no, operator, origin, dest, busType string
	first, last                         string // same for WD/SAT/SUN
	noArrivals                          bool   // routed but never in BusArrival
}

var services = map[string]service{
	"2":    {no: "2", operator: "GAS", origin: "84009", dest: "77009", busType: "DD", first: "0530", last: "2330"},
	"7":    {no: "7", operator: "SBST", origin: "84009", dest: "17009", busType: "DD", first: "0530", last: "2400"},
	"12":   {no: "12", operator: "GAS", origin: "77009", dest: "77009", busType: "SD", first: "0600", last: "2315"},
	"14":   {no: "14", operator: "SBST", origin: "84009", dest: "17009", busType: "DD", first: "0545", last: "2330"},
	"32":   {no: "32", operator: "SBST", origin: "52009", dest: "52009", busType: "DD", first: "0600", last: "2330"},
	"36":   {no: "36", operator: "SBST", origin: "84009", dest: "84009", busType: "DD", first: "0600", last: "2400"},
	"51":   {no: "51", operator: "SBST", origin: "17009", dest: "17009", busType: "DD", first: "0530", last: "2330"},
	"61":   {no: "61", operator: "SBST", origin: "84009", dest: "84009", busType: "DD", first: "0000", last: "2359", noArrivals: true},
	"124":  {no: "124", operator: "SMRT", origin: "52009", dest: "52009", busType: "DD", first: "0600", last: "2300"},
	"130":  {no: "130", operator: "SBST", origin: "52009", dest: "52009", busType: "DD", first: "0600", last: "2330"},
	"133":  {no: "133", operator: "SBST", origin: "52009", dest: "52009", busType: "SD", first: "0600", last: "2330"},
	"175":  {no: "175", operator: "TTS", origin: "17009", dest: "17009", busType: "BD", first: "0600", last: "2300"},
	"197":  {no: "197", operator: "SBST", origin: "17009", dest: "17009", busType: "DD", first: "0600", last: "2330"},
	"225G": {no: "225G", operator: "SBST", origin: "84009", dest: "84009", busType: "SD", first: "0530", last: "0030"},
	"225W": {no: "225W", operator: "SBST", origin: "84009", dest: "84009", busType: "SD", first: "0530", last: "0030"},
	"960":  {no: "960", operator: "SMRT", origin: "77009", dest: "77009", busType: "DD", first: "0500", last: "0501", noArrivals: true},
	"980":  {no: "980", operator: "SMRT", origin: "77009", dest: "77009", busType: "DD", first: "0600", last: "2330"},
}

// stopServices lists the services calling at each stop, in route order.
var stopServices = map[string][]string{
	"01012": {"7", "12", "32", "175", "225G", "61", "960"},
	"01013": {"2", "51", "133", "225W"},
	"01019": {"130", "197", "7"},
	"01112": {"980", "124", "2"},
	"01113": {"980", "124"},
	"02049": {"14", "36"},
	"04167": {"14", "36", "133"},
	"01211": {"2", "51"},
	"09048": {"7", "14"},
	"17009": {"7", "14", "51", "175", "197"},
	"52009": {"32", "124", "130", "133"},
	"77009": {"2", "12", "960", "980"},
	"84009": {"2", "7", "14", "36", "61", "225G", "225W"},
}

var stopOrder = []string{"84009", "77009", "52009", "01211", "01112", "01113", "02049", "01012", "01013", "01019", "04167", "09048", "17009"}

func main() {
	addr := os.Getenv("FAKELTA_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8099"
	}

	var stops []stopRec
	raw, err := fixtures.ReadFile("fixtures/stops.json")
	if err != nil {
		log.Fatalf("read fixtures: %v", err)
	}
	if err := json.Unmarshal(raw, &stops); err != nil {
		log.Fatalf("parse fixtures: %v", err)
	}
	for _, st := range stops {
		stopCoords[st.BusStopCode] = [2]float64{st.Latitude, st.Longitude}
	}
	routes := buildRoutes()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	})
	mux.Handle("GET /ltaodataservice/BusStops", requireKey(func(w http.ResponseWriter, r *http.Request) {
		writePage(w, r, "BusStops", stops)
	}))
	mux.Handle("GET /ltaodataservice/BusRoutes", requireKey(func(w http.ResponseWriter, r *http.Request) {
		writePage(w, r, "BusRoutes", routes)
	}))
	mux.Handle("GET /ltaodataservice/v3/BusArrival", requireKey(func(w http.ResponseWriter, r *http.Request) {
		if os.Getenv("FAKELTA_FAIL_ARRIVALS") == "1" {
			http.Error(w, "fault injected", http.StatusInternalServerError)
			return
		}
		code := r.URL.Query().Get("BusStopCode")
		writeJSON(w, map[string]any{
			"odata.metadata": "https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival",
			"BusStopCode":    code,
			"Services":       arrivalsFor(code, time.Now()),
		})
	}))

	mux.HandleFunc("GET /api/common/elastic/search", oneMapSearch)

	log.Printf("fakelta listening on http://%s", addr)
	log.Fatal(http.ListenAndServe(addr, logPaths(mux)))
}

// oneMapPlaces are the postal codes the fake OneMap knows, in OneMap's own
// upper-case response shape.
var oneMapPlaces = map[string]map[string]string{
	"188592": {"BLK_NO": "231", "ROAD_NAME": "BAIN STREET", "BUILDING": "BRAS BASAH COMPLEX", "LATITUDE": "1.29700", "LONGITUDE": "103.85300"},
	"456789": {"BLK_NO": "1", "ROAD_NAME": "FAKE FAR ROAD", "BUILDING": "NIL", "LATITUDE": "1.35000", "LONGITUDE": "103.95000"},
}

func oneMapSearch(w http.ResponseWriter, r *http.Request) {
	postal := r.URL.Query().Get("searchVal")
	if postal == "111111" {
		http.Error(w, "fault injected", http.StatusInternalServerError)
		return
	}
	results := []map[string]string{}
	if p, ok := oneMapPlaces[postal]; ok {
		res := map[string]string{"POSTAL": postal, "SEARCHVAL": p["BLK_NO"] + " " + p["ROAD_NAME"] + " SINGAPORE " + postal}
		for k, v := range p {
			res[k] = v
		}
		results = append(results, res)
	}
	writeJSON(w, map[string]any{"found": len(results), "totalNumPages": len(results), "pageNum": 1, "results": results})
}

// logPaths logs method and path only — never headers.
func logPaths(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Printf("%s %s", r.Method, r.URL.Path)
		next.ServeHTTP(w, r)
	})
}

func requireKey(h http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("AccountKey") == "" {
			http.Error(w, "missing AccountKey", http.StatusUnauthorized)
			return
		}
		h(w, r)
	})
}

func writePage[T any](w http.ResponseWriter, r *http.Request, name string, all []T) {
	skip, _ := strconv.Atoi(r.URL.Query().Get("$skip"))
	if skip < 0 {
		skip = 0
	}
	page := []T{}
	if skip < len(all) {
		end := min(skip+pageSize, len(all))
		page = all[skip:end]
	}
	writeJSON(w, map[string]any{
		"odata.metadata": "https://datamall2.mytransport.sg/ltaodataservice/$metadata#" + name,
		"value":          page,
	})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func buildRoutes() []routeRec {
	seq := map[string]int{}
	var out []routeRec
	for _, code := range stopOrder {
		for _, no := range stopServices[code] {
			s := services[no]
			seq[no]++
			out = append(out, routeRec{
				ServiceNo: s.no, Operator: s.operator, Direction: 1,
				StopSequence: seq[no], BusStopCode: code, Distance: float64(seq[no]) * 1.7,
				WDFirstBus: s.first, WDLastBus: s.last,
				SATFirstBus: s.first, SATLastBus: s.last,
				SUNFirstBus: s.first, SUNLastBus: s.last,
			})
		}
	}
	return out
}

func hashOf(parts ...string) uint32 {
	h := fnv.New32a()
	for _, p := range parts {
		h.Write([]byte(p))
		h.Write([]byte{0})
	}
	return h.Sum32()
}

var loads = []string{"SEA", "SDA", "LSD"}

// stopCoords is filled from the fixtures at startup so arrivals can place
// live buses on the map near the stop they're heading to.
var stopCoords = map[string][2]float64{}

func arrivalsFor(code string, now time.Time) []serviceArrival {
	out := []serviceArrival{}
	for _, no := range stopServices[code] {
		s := services[no]
		if s.noArrivals {
			continue
		}
		h := hashOf(code, no)

		var offsets []time.Duration
		var busLoads []string
		monitored := []int{1, 1, 0}
		switch {
		case code == "01012" && no == "7":
			offsets = []time.Duration{30 * time.Second, 8*time.Minute + 40*time.Second, 17 * time.Minute}
			busLoads = []string{"SEA", "SDA", "LSD"}
		case code == "01012" && no == "225G":
			offsets = []time.Duration{6*time.Minute + 20*time.Second}
			busLoads = []string{"SEA"}
		default:
			// A repeating headway, phase-shifted per stop/service, so times
			// tick down and roll over naturally between refreshes.
			headway := time.Duration(7+h%9) * time.Minute
			period := int64(headway / time.Second)
			phase := int64(h) % period
			next := time.Duration(period-(now.Unix()+phase)%period) * time.Second
			offsets = []time.Duration{next, next + headway, next + 2*headway}
			for i := range offsets {
				busLoads = append(busLoads, loads[(int(h)+i)%3])
			}
		}

		feature := "WAB"
		if h%5 == 0 {
			feature = ""
		}
		var buses [3]nextBus
		for i, off := range offsets {
			buses[i] = nextBus{
				OriginCode:       s.origin,
				DestinationCode:  s.dest,
				EstimatedArrival: now.Add(off).In(sgt).Format(time.RFC3339),
				Monitored:        monitored[i],
				Latitude:         busLat(code, monitored[i], off),
				Longitude:        busLng(code, monitored[i], off),
				VisitNumber:      "1",
				Load:             busLoads[i],
				Feature:          feature,
				Type:             s.busType,
			}
		}
		out = append(out, serviceArrival{ServiceNo: s.no, Operator: s.operator, NextBus: buses[0], NextBus2: buses[1], NextBus3: buses[2]})
	}
	return out
}

// busLat/busLng place a live (monitored) bus south-west of the stop, further
// away the longer it has to go (~45 m per minute), like a bus approaching
// along the road. Timetable-only buses get "0", as LTA sends.
func busLat(code string, monitored int, until time.Duration) string {
	c, ok := stopCoords[code]
	if !ok || monitored != 1 {
		return "0"
	}
	return strconv.FormatFloat(c[0]-0.0004*until.Minutes(), 'f', 6, 64)
}

func busLng(code string, monitored int, until time.Duration) string {
	c, ok := stopCoords[code]
	if !ok || monitored != 1 {
		return "0"
	}
	return strconv.FormatFloat(c[1]-0.0002*until.Minutes(), 'f', 6, 64)
}
