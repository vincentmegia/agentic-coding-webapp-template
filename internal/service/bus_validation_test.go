package service

import (
	"errors"
	"math"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/vincentmegia/vincentmegia/internal/lta"
	"github.com/vincentmegia/vincentmegia/internal/model"
)

func TestValidateBusLocation(t *testing.T) {
	cases := []struct {
		name             string
		lat, lng         float64
		wantLat, wantLng float64
		wantErr          error
	}{
		{"rounds to 3dp", 1.29685, 103.85349, 1.297, 103.853, nil},
		{"min corner", 1.15, 103.6, 1.15, 103.6, nil},
		{"max corner", 1.48, 104.1, 1.48, 104.1, nil},
		{"rounds into range", 1.1496, 103.5996, 1.15, 103.6, nil},
		{"NaN", math.NaN(), 103.8, 0, 0, ErrBusInvalidLocation},
		{"Inf", 1.3, math.Inf(1), 0, 0, ErrBusInvalidLocation},
		{"not a coordinate", 100, 103.8, 0, 0, ErrBusInvalidLocation},
		{"London", 51.5, -0.12, 0, 0, ErrBusOutsideSingapore},
		{"just south", 1.149, 103.8, 0, 0, ErrBusOutsideSingapore},
		{"just east", 1.3, 104.101, 0, 0, ErrBusOutsideSingapore},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			lat, lng, err := ValidateBusLocation(c.lat, c.lng)
			if !errors.Is(err, c.wantErr) {
				t.Fatalf("err = %v, want %v", err, c.wantErr)
			}
			if err == nil && (lat != c.wantLat || lng != c.wantLng) {
				t.Errorf("got %v,%v want %v,%v", lat, lng, c.wantLat, c.wantLng)
			}
		})
	}
}

func TestValidateBusSearchQuery(t *testing.T) {
	if q, err := ValidateBusSearchQuery("  Victoria  "); err != nil || q != "Victoria" {
		t.Errorf("trim: %q %v", q, err)
	}
	if _, err := ValidateBusSearchQuery("01"); err != nil {
		t.Errorf("2 chars should pass: %v", err)
	}
	for _, q := range []string{"", " ", "a", "  b  ", strings.Repeat("x", 41)} {
		if _, err := ValidateBusSearchQuery(q); !errors.Is(err, ErrBusSearchQueryInvalid) {
			t.Errorf("%q: err = %v", q, err)
		}
	}
	if _, err := ValidateBusSearchQuery(strings.Repeat("é", 40)); err != nil {
		t.Errorf("40 runes should pass: %v", err)
	}
}

func TestValidateBusStopCode(t *testing.T) {
	if err := ValidateBusStopCode("01012"); err != nil {
		t.Errorf("valid: %v", err)
	}
	for _, c := range []string{"", "1012", "010123", "0101a", "０１０１２", "01 12", "../01"} {
		if !errors.Is(ValidateBusStopCode(c), ErrBusStopCodeInvalid) {
			t.Errorf("%q should be invalid", c)
		}
	}
}

func TestArrivalLabel(t *testing.T) {
	now := time.Date(2026, 10, 3, 18, 0, 0, 0, sgt)
	cases := []struct {
		d        time.Duration
		want     string
		arriving bool
	}{
		{-30 * time.Second, "Arr", true},
		{0, "Arr", true},
		{59 * time.Second, "Arr", true},
		{60 * time.Second, "1", false},
		{119 * time.Second, "1", false},
		{3*time.Minute + 49*time.Second, "3", false},
		{2*time.Minute + 7*time.Second, "2", false},
	}
	for _, c := range cases {
		got, arr := arrivalLabel(now.Add(c.d), now)
		if got != c.want || arr != c.arriving {
			t.Errorf("%v: got %q,%v want %q,%v", c.d, got, arr, c.want, c.arriving)
		}
	}
}

func TestNaturalLess(t *testing.T) {
	in := []string{"225W", "12", "NR1", "7", "225G", "2", "10e", "961M"}
	sort.Slice(in, func(i, j int) bool { return naturalLess(in[i], in[j]) })
	want := "2,7,10e,12,225G,225W,961M,NR1"
	if got := strings.Join(in, ","); got != want {
		t.Errorf("got %s want %s", got, want)
	}
}

func TestNormalizeHHMM(t *testing.T) {
	cases := map[string]string{"0530": "0530", "2359": "2359", "2400": "2400", "2430": "2430", "-": "", "": "", "2560": "", "3000": "", "12:30": "", "530": "", "abcd": ""}
	for in, want := range cases {
		if got := normalizeHHMM(in); got != want {
			t.Errorf("%q → %q, want %q", in, got, want)
		}
	}
}

func at(h, m int) time.Time { return time.Date(2026, 10, 5, h, m, 0, 0, sgt) } // a Monday

func TestServiceStatus(t *testing.T) {
	cases := []struct {
		name        string
		first, last string
		now         time.Time
		want        model.ServiceStatus
	}{
		{"within", "0530", "2330", at(12, 0), model.StatusNoEstimate},
		{"at first", "0530", "2330", at(5, 30), model.StatusNoEstimate},
		{"at last", "0530", "2330", at(23, 30), model.StatusNoEstimate},
		{"before first", "0530", "2330", at(5, 29), model.StatusNotInOperation},
		{"after last", "0530", "2330", at(23, 31), model.StatusNotInOperation},
		{"wrap: after midnight", "0530", "0030", at(0, 15), model.StatusNoEstimate},
		{"wrap: evening", "0530", "0030", at(22, 0), model.StatusNoEstimate},
		{"wrap: dead of night", "0530", "0030", at(3, 0), model.StatusNotInOperation},
		{"24xx: 0530-2430 at 00:15", "0530", "2430", at(0, 15), model.StatusNoEstimate},
		{"24xx: 0530-2430 at 01:00", "0530", "2430", at(1, 0), model.StatusNotInOperation},
		{"all day 0000-2400", "0000", "2400", at(3, 0), model.StatusNoEstimate},
		{"all day 0000-2359", "0000", "2359", at(23, 59), model.StatusNoEstimate},
		{"unknown hours", "", "", at(3, 0), model.StatusNoEstimate},
		{"half unknown", "0530", "", at(3, 0), model.StatusNoEstimate},
		{"UTC input converted", "0530", "2330", time.Date(2026, 10, 5, 20, 0, 0, 0, time.UTC), model.StatusNotInOperation}, // 04:00 SGT
	}
	for _, c := range cases {
		if got := serviceStatus(c.first, c.last, c.now); got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}

func TestDayTypeFor(t *testing.T) {
	cases := []struct {
		t    time.Time
		want model.DayType
	}{
		{time.Date(2026, 10, 5, 12, 0, 0, 0, sgt), model.DayWeekday},
		{time.Date(2026, 10, 3, 12, 0, 0, 0, sgt), model.DaySaturday},
		{time.Date(2026, 10, 4, 12, 0, 0, 0, sgt), model.DaySunday},
		// Friday 17:00 UTC is Saturday 01:00 in Singapore.
		{time.Date(2026, 10, 2, 17, 0, 0, 0, time.UTC), model.DaySaturday},
	}
	for _, c := range cases {
		if got := dayTypeFor(c.t); got != c.want {
			t.Errorf("%v: got %s want %s", c.t, got, c.want)
		}
	}
}

func TestValidStopRecord(t *testing.T) {
	good := lta.BusStopRecord{BusStopCode: "01012", RoadName: " Victoria St ", Description: "Hotel Grand Pacific", Latitude: 1.29685, Longitude: 103.853}
	st, ok := validStopRecord(good)
	if !ok || st.RoadName != "Victoria St" {
		t.Fatalf("good rejected: %+v %v", st, ok)
	}
	bad := []lta.BusStopRecord{
		{BusStopCode: "1012", Latitude: 1.3, Longitude: 103.8},
		{BusStopCode: "01012", Latitude: 0, Longitude: 0},
		{BusStopCode: "01012", Latitude: 1.3, Longitude: 105},
		{BusStopCode: "01012", Description: strings.Repeat("x", 121), Latitude: 1.3, Longitude: 103.8},
		{BusStopCode: "01012", RoadName: "\xff\xfe", Latitude: 1.3, Longitude: 103.8},
	}
	for i, r := range bad {
		if _, ok := validStopRecord(r); ok {
			t.Errorf("bad[%d] accepted", i)
		}
	}
}

func TestValidRouteRecord(t *testing.T) {
	r := lta.BusRouteRecord{ServiceNo: "225G", Operator: "SBST", Direction: 1, StopSequence: 4, BusStopCode: "01012",
		Distance: "3.2", WDFirstBus: "0530", WDLastBus: "2430", SATFirstBus: "-", SATLastBus: "2560", SUNFirstBus: "", SUNLastBus: "0030"}
	rt, ok := validRouteRecord(r)
	if !ok {
		t.Fatal("valid route rejected")
	}
	if rt.WDLastBus != "2430" || rt.SATFirstBus != "" || rt.SATLastBus != "" || rt.SUNLastBus != "0030" || rt.DistanceKm != 3.2 {
		t.Errorf("normalised = %+v", rt)
	}
	bad := []lta.BusRouteRecord{
		{ServiceNo: "", Direction: 1, BusStopCode: "01012"},
		{ServiceNo: "1234567", Direction: 1, BusStopCode: "01012"},
		{ServiceNo: "7;DROP", Direction: 1, BusStopCode: "01012"},
		{ServiceNo: "7", Direction: 3, BusStopCode: "01012"},
		{ServiceNo: "7", Direction: 1, BusStopCode: "x"},
		{ServiceNo: "7", Direction: 1, BusStopCode: "01012", StopSequence: -1},
	}
	for i, b := range bad {
		if _, ok := validRouteRecord(b); ok {
			t.Errorf("bad[%d] accepted", i)
		}
	}
}
