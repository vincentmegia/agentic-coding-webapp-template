// Package onemap is a minimal client for OneMap, the Singapore Land
// Authority's map service, used only to turn a 6-digit postal code into a
// location for the Bus Stop Finder's postal-code search
// (docs/features/bus-stop-finder.md). The search endpoint needs no API
// key.
package onemap

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// defaultTimeout bounds one geocode request: it's on the visitor's request
// path, so it fails fast and the page offers stop-code search instead.
const defaultTimeout = 5 * time.Second

// maxBodyBytes caps a response; one postal code returns a few hundred
// bytes, so anything near this is not a real answer.
const maxBodyBytes = 1 << 20

// Place is one geocoded postal code.
type Place struct {
	Postal    string
	Label     string // display name: building name, else "106 Simei Street 1"
	Latitude  float64
	Longitude float64
}

// StatusError is a non-200 response from OneMap.
type StatusError struct{ StatusCode int }

func (e *StatusError) Error() string { return fmt.Sprintf("onemap: HTTP %d", e.StatusCode) }

// ErrBodyTooLarge is returned when a response exceeds maxBodyBytes.
var ErrBodyTooLarge = errors.New("onemap: response body too large")

// maxAttempts bounds retries on HTTP 429. Anonymous OneMap use is limited
// to roughly 1 request/second with a burst of 2 (measured), so a short
// wait and retry absorbs a few visitors searching at the same moment.
const maxAttempts = 3

// maxRetryWait caps a Retry-After header, so one slow answer can't hold a
// visitor's request for long.
const maxRetryWait = 3 * time.Second

// Client geocodes postal codes. Safe for concurrent use.
type Client struct {
	baseURL    string
	httpClient *http.Client
	// sleep waits between 429 retries; replaced in tests.
	sleep func(ctx context.Context, d time.Duration) error
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// NewClient builds a client for baseURL (an origin such as
// https://www.onemap.gov.sg; internal/config validates its scheme). A nil
// httpClient gets one with a 5 s timeout. Redirects are never followed,
// matching internal/lta.
func NewClient(baseURL string, httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: defaultTimeout}
	}
	noRedirect := *httpClient
	noRedirect.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &Client{baseURL: strings.TrimRight(baseURL, "/"), httpClient: &noRedirect, sleep: sleepCtx}
}

type searchResponse struct {
	Found   int `json:"found"`
	Results []struct {
		BlkNo     string `json:"BLK_NO"`
		RoadName  string `json:"ROAD_NAME"`
		Building  string `json:"BUILDING"`
		Postal    string `json:"POSTAL"`
		Latitude  string `json:"LATITUDE"`
		Longitude string `json:"LONGITUDE"`
	} `json:"results"`
}

// Geocode looks up a 6-digit postal code. found is false (with a nil
// error) when OneMap has no exact match for that postal code. The postal
// code is validated before any request, so only six digits ever reach
// OneMap.
func (c *Client) Geocode(ctx context.Context, postal string) (Place, bool, error) {
	if !IsPostalCode(postal) {
		return Place{}, false, fmt.Errorf("onemap: invalid postal code")
	}
	q := url.Values{}
	q.Set("searchVal", postal)
	q.Set("returnGeom", "Y")
	q.Set("getAddrDetails", "Y")
	q.Set("pageNum", "1")
	body, err := c.fetch(ctx, c.baseURL+"/api/common/elastic/search?"+q.Encode())
	if err != nil {
		return Place{}, false, err
	}
	var sr searchResponse
	if err := json.Unmarshal(body, &sr); err != nil {
		return Place{}, false, fmt.Errorf("onemap: decode: %w", err)
	}

	// The search is fuzzy; only an exact postal match counts.
	for _, r := range sr.Results {
		if r.Postal != postal {
			continue
		}
		lat, latErr := strconv.ParseFloat(r.Latitude, 64)
		lng, lngErr := strconv.ParseFloat(r.Longitude, 64)
		if latErr != nil || lngErr != nil {
			continue
		}
		return Place{Postal: postal, Label: label(r.Building, r.BlkNo, r.RoadName), Latitude: lat, Longitude: lng}, true, nil
	}
	return Place{}, false, nil
}

// fetch GETs u, retrying on HTTP 429 up to maxAttempts times: waiting for
// Retry-After (capped at maxRetryWait) when OneMap sends one, else 1 s then
// 2 s. Any other non-200 fails immediately.
func (c *Client) fetch(ctx context.Context, u string) ([]byte, error) {
	for attempt := 1; ; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		if err != nil {
			return nil, fmt.Errorf("onemap: build request: %w", err)
		}
		req.Header.Set("accept", "application/json")

		res, err := c.httpClient.Do(req)
		if err != nil {
			return nil, fmt.Errorf("onemap: request: %w", err)
		}
		if res.StatusCode == http.StatusTooManyRequests && attempt < maxAttempts {
			wait := retryAfter(res.Header.Get("Retry-After"), time.Duration(attempt)*time.Second)
			io.Copy(io.Discard, io.LimitReader(res.Body, 64<<10))
			res.Body.Close()
			if err := c.sleep(ctx, wait); err != nil {
				return nil, fmt.Errorf("onemap: waiting to retry: %w", err)
			}
			continue
		}
		if res.StatusCode != http.StatusOK {
			io.Copy(io.Discard, io.LimitReader(res.Body, 64<<10))
			res.Body.Close()
			return nil, &StatusError{StatusCode: res.StatusCode}
		}
		body, err := io.ReadAll(io.LimitReader(res.Body, maxBodyBytes+1))
		res.Body.Close()
		if err != nil {
			return nil, fmt.Errorf("onemap: read: %w", err)
		}
		if len(body) > maxBodyBytes {
			return nil, ErrBodyTooLarge
		}
		return body, nil
	}
}

// retryAfter parses a Retry-After header given in seconds, capped at
// maxRetryWait; fallback when absent or unparseable.
func retryAfter(h string, fallback time.Duration) time.Duration {
	if secs, err := strconv.Atoi(strings.TrimSpace(h)); err == nil && secs >= 0 {
		if d := time.Duration(secs) * time.Second; d < maxRetryWait {
			return d
		}
		return maxRetryWait
	}
	return fallback
}

// IsPostalCode reports whether s is exactly six ASCII digits.
func IsPostalCode(s string) bool {
	if len(s) != 6 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// label picks a readable name: the building if OneMap has one (it uses
// "NIL" for none), else block number plus road, in title case — OneMap
// returns everything upper-case. Capped at 80 characters.
func label(building, blk, road string) string {
	name := strings.TrimSpace(building)
	if name == "" || strings.EqualFold(name, "NIL") {
		name = strings.TrimSpace(strings.TrimSpace(blk) + " " + strings.TrimSpace(road))
	}
	name = titleCase(name)
	if r := []rune(name); len(r) > 80 {
		name = string(r[:80])
	}
	return name
}

func titleCase(s string) string {
	words := strings.Fields(strings.ToLower(s))
	for i, w := range words {
		r := []rune(w)
		r[0] = []rune(strings.ToUpper(string(r[0])))[0]
		words[i] = string(r)
	}
	return strings.Join(words, " ")
}
