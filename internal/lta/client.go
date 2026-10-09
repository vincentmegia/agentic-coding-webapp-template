// Package lta is a minimal client for the three LTA DataMall endpoints the
// Bus Stop Finder uses (docs/features/bus-stop-finder.md): v3 BusArrival,
// BusStops and BusRoutes.
//
// The AccountKey is held only in this struct and sent only as a request
// header. It never appears in an error message or a log line produced
// here (see that doc's Security Considerations). Every URL is built from
// the configured base URL plus fixed paths and url.Values; no caller
// input is forwarded beyond an already-validated stop code or a $skip
// integer.
package lta

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

// maxBodyBytes caps every response body, per the doc's "Outbound HTTP"
// rule: a misbehaving or hostile upstream can't make us buffer more than
// this.
const maxBodyBytes = 8 << 20

// defaultTimeout is used when NewClient is given a nil *http.Client.
const defaultTimeout = 10 * time.Second

var (
	// ErrInvalidStopCode is returned before any request is made when the
	// stop code isn't exactly 5 ASCII digits.
	ErrInvalidStopCode = errors.New("lta: stop code must be 5 digits")
	// ErrBodyTooLarge means the response exceeded maxBodyBytes.
	ErrBodyTooLarge = errors.New("lta: response body too large")
)

// StatusError is returned for a non-200 response. It deliberately carries
// only the endpoint path and status, never headers or the request URL's
// query, so it is safe to log.
type StatusError struct {
	Endpoint   string
	StatusCode int
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("lta: %s returned status %d", e.Endpoint, e.StatusCode)
}

// Client calls LTA DataMall.
type Client struct {
	baseURL    string
	accountKey string
	httpClient *http.Client
}

// NewClient builds a Client. baseURL is e.g.
// "https://datamall2.mytransport.sg" (no trailing path); config validation
// of its scheme lives in internal/config. A nil httpClient gets a default
// one with a 10 s timeout.
func NewClient(baseURL, accountKey string, httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: defaultTimeout}
	}
	// Never follow redirects: net/http strips Authorization/Cookie on a
	// cross-host redirect but forwards custom headers like AccountKey, so
	// a 30x could carry the key to another host or to plain http. A
	// redirect response is returned as-is and fails the 200 check instead.
	// Copy rather than mutate a caller-supplied client.
	noRedirect := *httpClient
	noRedirect.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	httpClient = &noRedirect
	return &Client{
		baseURL:    strings.TrimRight(baseURL, "/"),
		accountKey: accountKey,
		httpClient: httpClient,
	}
}

// BusArrival fetches GET {base}/ltaodataservice/v3/BusArrival?BusStopCode=.
func (c *Client) BusArrival(ctx context.Context, stopCode string) (BusArrivalResponse, error) {
	var resp BusArrivalResponse
	if !isStopCode(stopCode) {
		return resp, ErrInvalidStopCode
	}
	q := url.Values{}
	q.Set("BusStopCode", stopCode)
	if err := c.getJSON(ctx, "/ltaodataservice/v3/BusArrival", q, &resp); err != nil {
		return BusArrivalResponse{}, err
	}
	return resp, nil
}

// BusStops fetches one page (up to 500 rows) of GET
// {base}/ltaodataservice/BusStops?$skip=.
func (c *Client) BusStops(ctx context.Context, skip int) ([]BusStopRecord, error) {
	var page struct {
		Value []BusStopRecord `json:"value"`
	}
	if err := c.getJSON(ctx, "/ltaodataservice/BusStops", skipQuery(skip), &page); err != nil {
		return nil, err
	}
	return page.Value, nil
}

// BusRoutes fetches one page (up to 500 rows) of GET
// {base}/ltaodataservice/BusRoutes?$skip=.
func (c *Client) BusRoutes(ctx context.Context, skip int) ([]BusRouteRecord, error) {
	var page struct {
		Value []BusRouteRecord `json:"value"`
	}
	if err := c.getJSON(ctx, "/ltaodataservice/BusRoutes", skipQuery(skip), &page); err != nil {
		return nil, err
	}
	return page.Value, nil
}

func skipQuery(skip int) url.Values {
	q := url.Values{}
	if skip > 0 {
		q.Set("$skip", strconv.Itoa(skip))
	}
	return q
}

func (c *Client) getJSON(ctx context.Context, path string, q url.Values, out any) error {
	u := c.baseURL + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return fmt.Errorf("lta: build request for %s: %w", path, err)
	}
	req.Header.Set("AccountKey", c.accountKey)
	req.Header.Set("accept", "application/json")

	res, err := c.httpClient.Do(req)
	if err != nil {
		// *url.Error includes the URL (base + path + query: stop code or
		// $skip only), never headers, so the key can't leak through it.
		return fmt.Errorf("lta: request %s: %w", path, err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(res.Body, 64<<10))
		return &StatusError{Endpoint: path, StatusCode: res.StatusCode}
	}

	body, err := io.ReadAll(io.LimitReader(res.Body, maxBodyBytes+1))
	if err != nil {
		return fmt.Errorf("lta: read %s: %w", path, err)
	}
	if len(body) > maxBodyBytes {
		return ErrBodyTooLarge
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("lta: decode %s: %w", path, err)
	}
	return nil
}

func isStopCode(s string) bool {
	if len(s) != 5 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}
