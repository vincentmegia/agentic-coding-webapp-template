package onemap

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

const simei = `{"found":1,"totalNumPages":1,"pageNum":1,"results":[{"SEARCHVAL":"106 SIMEI STREET 1 SINGAPORE 520106","BLK_NO":"106","ROAD_NAME":"SIMEI STREET 1","BUILDING":"NIL","ADDRESS":"106 SIMEI STREET 1 SINGAPORE 520106","POSTAL":"520106","X":"41078.1","Y":"36004.6","LATITUDE":"1.341885217334366","LONGITUDE":"103.9508334811959"}]}`

func TestGeocodeBuildsRequestAndParses(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/common/elastic/search" {
			t.Errorf("path = %s", r.URL.Path)
		}
		q := r.URL.Query()
		if q.Get("searchVal") != "520106" || q.Get("returnGeom") != "Y" || q.Get("getAddrDetails") != "Y" || q.Get("pageNum") != "1" {
			t.Errorf("query = %s", r.URL.RawQuery)
		}
		w.Write([]byte(simei))
	}))
	defer srv.Close()

	p, found, err := NewClient(srv.URL, nil).Geocode(context.Background(), "520106")
	if err != nil || !found {
		t.Fatalf("Geocode = %v, %v, %v", p, found, err)
	}
	if p.Label != "106 Simei Street 1" || p.Latitude < 1.3418 || p.Latitude > 1.3419 || p.Longitude < 103.9508 || p.Longitude > 103.9509 {
		t.Errorf("place = %+v", p)
	}
}

func TestGeocodePrefersBuildingName(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"found":1,"results":[{"BLK_NO":"10","ROAD_NAME":"BAYFRONT AVENUE","BUILDING":"MARINA BAY SANDS","POSTAL":"018956","LATITUDE":"1.2836","LONGITUDE":"103.8607"}]}`))
	}))
	defer srv.Close()
	p, found, err := NewClient(srv.URL, nil).Geocode(context.Background(), "018956")
	if err != nil || !found || p.Label != "Marina Bay Sands" {
		t.Fatalf("Geocode = %+v, %v, %v", p, found, err)
	}
}

func TestGeocodeNotFoundAndInexactMatch(t *testing.T) {
	for name, body := range map[string]string{
		"no results":   `{"found":0,"totalNumPages":0,"pageNum":1,"results":[]}`,
		"other postal": `{"found":1,"results":[{"BLK_NO":"1","ROAD_NAME":"X","BUILDING":"NIL","POSTAL":"520107","LATITUDE":"1.34","LONGITUDE":"103.95"}]}`,
		"bad latitude": `{"found":1,"results":[{"BLK_NO":"1","ROAD_NAME":"X","BUILDING":"NIL","POSTAL":"520106","LATITUDE":"","LONGITUDE":"103.95"}]}`,
	} {
		t.Run(name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(body)) }))
			defer srv.Close()
			_, found, err := NewClient(srv.URL, nil).Geocode(context.Background(), "520106")
			if err != nil || found {
				t.Errorf("found=%v err=%v, want not found and no error", found, err)
			}
		})
	}
}

func TestGeocodeRejectsNonPostalWithoutRequest(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
	defer srv.Close()
	c := NewClient(srv.URL, nil)
	for _, in := range []string{"", "52010", "5201066", "52O106", "520106&x=1", " 520106"} {
		if _, _, err := c.Geocode(context.Background(), in); err == nil {
			t.Errorf("Geocode(%q) accepted", in)
		}
	}
	if calls.Load() != 0 {
		t.Errorf("%d requests sent for invalid input", calls.Load())
	}
}

func TestGeocodeErrors(t *testing.T) {
	t.Run("non-200", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusServiceUnavailable) }))
		defer srv.Close()
		_, _, err := NewClient(srv.URL, nil).Geocode(context.Background(), "520106")
		var se *StatusError
		if !errors.As(err, &se) || se.StatusCode != http.StatusServiceUnavailable {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("redirect not followed", func(t *testing.T) {
		var followed atomic.Bool
		other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { followed.Store(true) }))
		defer other.Close()
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, other.URL, http.StatusFound)
		}))
		defer srv.Close()
		_, _, err := NewClient(srv.URL, nil).Geocode(context.Background(), "520106")
		var se *StatusError
		if !errors.As(err, &se) || followed.Load() {
			t.Fatalf("err = %v, followed = %v", err, followed.Load())
		}
	})
	t.Run("oversize", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte(strings.Repeat(" ", maxBodyBytes+10)))
		}))
		defer srv.Close()
		if _, _, err := NewClient(srv.URL, nil).Geocode(context.Background(), "520106"); !errors.Is(err, ErrBodyTooLarge) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("timeout", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { time.Sleep(300 * time.Millisecond) }))
		defer srv.Close()
		c := NewClient(srv.URL, &http.Client{Timeout: 50 * time.Millisecond})
		if _, _, err := c.Geocode(context.Background(), "520106"); err == nil {
			t.Fatal("want timeout error")
		}
	})
}

func TestGeocodeRetriesOn429(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) <= 2 {
			if calls.Load() == 1 {
				w.Header().Set("Retry-After", "2")
			}
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		w.Write([]byte(simei))
	}))
	defer srv.Close()
	c := NewClient(srv.URL, nil)
	var waits []time.Duration
	c.sleep = func(_ context.Context, d time.Duration) error { waits = append(waits, d); return nil }

	p, found, err := c.Geocode(context.Background(), "520106")
	if err != nil || !found || p.Label != "106 Simei Street 1" {
		t.Fatalf("Geocode = %+v, %v, %v", p, found, err)
	}
	if calls.Load() != 3 {
		t.Errorf("calls = %d, want 3", calls.Load())
	}
	// First wait honours Retry-After: 2; the second has none, so 2 s backoff.
	if len(waits) != 2 || waits[0] != 2*time.Second || waits[1] != 2*time.Second {
		t.Errorf("waits = %v, want [2s 2s]", waits)
	}
}

func TestGeocodeGivesUpAfterMaxAttempts(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Retry-After", "120") // capped at maxRetryWait
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()
	c := NewClient(srv.URL, nil)
	var waits []time.Duration
	c.sleep = func(_ context.Context, d time.Duration) error { waits = append(waits, d); return nil }

	_, _, err := c.Geocode(context.Background(), "520106")
	var se *StatusError
	if !errors.As(err, &se) || se.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("err = %v, want StatusError 429", err)
	}
	if calls.Load() != maxAttempts {
		t.Errorf("calls = %d, want %d", calls.Load(), maxAttempts)
	}
	for _, w := range waits {
		if w != maxRetryWait {
			t.Errorf("wait %v, want capped at %v", w, maxRetryWait)
		}
	}
}

func TestGeocodeRetryStopsWhenContextEnds(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, _, err := NewClient(srv.URL, nil).Geocode(ctx, "520106"); err == nil {
		t.Fatal("want error")
	}
	if time.Since(start) > 500*time.Millisecond {
		t.Errorf("retry wait ignored context: took %v", time.Since(start))
	}
}
