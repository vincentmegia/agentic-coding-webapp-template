package lta

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const testKey = "secret-account-key-123"

func TestClientBusArrivalSendsHeadersAndBuildsURL(t *testing.T) {
	var gotPath, gotQuery, gotKey, gotAccept string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotQuery = r.URL.Path, r.URL.RawQuery
		gotKey, gotAccept = r.Header.Get("AccountKey"), r.Header.Get("accept")
		w.Write([]byte(`{"BusStopCode":"01012","Services":[{"ServiceNo":"7","Operator":"SBST",
			"NextBus":{"EstimatedArrival":"2026-10-03T18:00:00+08:00","Monitored":1,"Latitude":"1.3","Longitude":"103.8","VisitNumber":"1","Load":"SEA","Feature":"WAB","Type":"DD","DestinationCode":"17009"},
			"NextBus2":{"EstimatedArrival":"","Monitored":0,"Latitude":"","Longitude":"","VisitNumber":"","Load":"","Feature":"","Type":""},
			"NextBus3":{"EstimatedArrival":"","Monitored":"0"}}]}`))
	}))
	defer srv.Close()

	c := NewClient(srv.URL+"/", testKey, nil)
	resp, err := c.BusArrival(context.Background(), "01012")
	if err != nil {
		t.Fatalf("BusArrival: %v", err)
	}
	if gotPath != "/ltaodataservice/v3/BusArrival" || gotQuery != "BusStopCode=01012" {
		t.Errorf("url = %s?%s", gotPath, gotQuery)
	}
	if gotKey != testKey || gotAccept != "application/json" {
		t.Errorf("headers key=%q accept=%q", gotKey, gotAccept)
	}
	if len(resp.Services) != 1 || resp.Services[0].NextBus.Monitored != 1 || resp.Services[0].NextBus.Feature != "WAB" {
		t.Errorf("decoded = %+v", resp)
	}
	if resp.Services[0].NextBus2.EstimatedArrival != "" {
		t.Errorf("NextBus2 should be empty")
	}
}

func TestClientBusArrivalRejectsInvalidCodeWithoutRequest(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
	}))
	defer srv.Close()
	c := NewClient(srv.URL, testKey, nil)
	for _, code := range []string{"", "1234", "123456", "12a45", "01012&ServiceNo=7", "../x1"} {
		if _, err := c.BusArrival(context.Background(), code); !errors.Is(err, ErrInvalidStopCode) {
			t.Errorf("code %q: err = %v", code, err)
		}
	}
	if calls != 0 {
		t.Errorf("made %d requests for invalid codes", calls)
	}
}

func TestClientPagingQuery(t *testing.T) {
	var queries []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		queries = append(queries, r.URL.Path+"?"+r.URL.RawQuery)
		if strings.HasSuffix(r.URL.Path, "BusStops") {
			w.Write([]byte(`{"value":[{"BusStopCode":"01012","RoadName":"Victoria St","Description":"Hotel Grand Pacific","Latitude":1.29685,"Longitude":103.853}]}`))
			return
		}
		w.Write([]byte(`{"value":[{"ServiceNo":"7","Operator":"SBST","Direction":1,"StopSequence":3,"BusStopCode":"01012","Distance":2.1,"WD_FirstBus":"0530","WD_LastBus":"2359","SAT_FirstBus":"-","SAT_LastBus":"-","SUN_FirstBus":"0600","SUN_LastBus":"0030"}]}`))
	}))
	defer srv.Close()
	c := NewClient(srv.URL, testKey, nil)

	stops, err := c.BusStops(context.Background(), 0)
	if err != nil || len(stops) != 1 || stops[0].Latitude != 1.29685 {
		t.Fatalf("BusStops = %+v, %v", stops, err)
	}
	routes, err := c.BusRoutes(context.Background(), 500)
	if err != nil || len(routes) != 1 || routes[0].Distance.Float() != 2.1 || routes[0].SATFirstBus != "-" {
		t.Fatalf("BusRoutes = %+v, %v", routes, err)
	}
	want := []string{"/ltaodataservice/BusStops?", "/ltaodataservice/BusRoutes?%24skip=500"}
	for i, w := range want {
		if queries[i] != w {
			t.Errorf("query %d = %q, want %q", i, queries[i], w)
		}
	}
}

func TestClientNon200ErrorOmitsKey(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "echo "+r.Header.Get("AccountKey"), http.StatusUnauthorized)
	}))
	defer srv.Close()
	c := NewClient(srv.URL, testKey, nil)
	_, err := c.BusArrival(context.Background(), "01012")
	var se *StatusError
	if !errors.As(err, &se) || se.StatusCode != http.StatusUnauthorized {
		t.Fatalf("err = %v", err)
	}
	if strings.Contains(err.Error(), testKey) {
		t.Errorf("error leaks key: %v", err)
	}
}

func TestClientOversizeBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"value":["`))
		chunk := strings.Repeat("a", 1<<20)
		for i := 0; i < 9; i++ {
			w.Write([]byte(chunk))
		}
		w.Write([]byte(`"]}`))
	}))
	defer srv.Close()
	c := NewClient(srv.URL, testKey, nil)
	if _, err := c.BusStops(context.Background(), 0); !errors.Is(err, ErrBodyTooLarge) {
		t.Fatalf("err = %v, want ErrBodyTooLarge", err)
	}
}

func TestClientTimeoutAndContext(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-time.After(2 * time.Second):
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()

	c := NewClient(srv.URL, testKey, &http.Client{Timeout: 50 * time.Millisecond})
	if _, err := c.BusStops(context.Background(), 0); err == nil {
		t.Error("expected timeout error")
	}

	c2 := NewClient(srv.URL, testKey, nil)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := c2.BusRoutes(ctx, 0); !errors.Is(err, context.Canceled) {
		t.Errorf("err = %v, want context.Canceled", err)
	}
}

func TestClientDefaultTimeout(t *testing.T) {
	c := NewClient("https://example.invalid", testKey, nil)
	if c.httpClient.Timeout != 10*time.Second {
		t.Errorf("timeout = %v", c.httpClient.Timeout)
	}
}

// TestClientDoesNotFollowRedirects: a 30x must never carry the AccountKey
// to another host (net/http forwards custom headers on redirect).
func TestClientDoesNotFollowRedirects(t *testing.T) {
	var leaked atomic.Bool
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("AccountKey") != "" {
			leaked.Store(true)
		}
		w.Write([]byte(`{"Services":[]}`))
	}))
	defer other.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+r.URL.Path, http.StatusFound)
	}))
	defer srv.Close()

	for _, hc := range []*http.Client{nil, {}} {
		_, err := NewClient(srv.URL, testKey, hc).BusArrival(context.Background(), "01012")
		var se *StatusError
		if !errors.As(err, &se) || se.StatusCode != http.StatusFound {
			t.Fatalf("err = %v, want StatusError 302", err)
		}
	}
	if leaked.Load() {
		t.Fatal("AccountKey was sent to the redirect target")
	}
}
