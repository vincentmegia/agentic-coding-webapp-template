package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/vincentmegia/vincentmegia/internal/service"
)

// TestDecodeJSON covers the request-parsing contract the API depends on.
// These run without a database because decodeJSON is deliberately free of
// service/repository calls — it either produces a populated struct or has
// already written the 400.
func TestDecodeJSON(t *testing.T) {
	tests := []struct {
		name        string
		body        string
		contentType string
		wantOK      bool
		wantStatus  int
	}{
		{
			name:        "valid body decodes",
			body:        `{"image_path":"/a.svg","alt":"a","caption":"","link_url":"","external":false}`,
			contentType: "application/json",
			wantOK:      true,
		},
		{
			name:        "content type with charset is accepted",
			body:        `{"image_path":"/a.svg","alt":"a"}`,
			contentType: "application/json; charset=utf-8",
			wantOK:      true,
		},
		{
			name:        "absent content type is accepted",
			body:        `{"image_path":"/a.svg","alt":"a"}`,
			contentType: "",
			wantOK:      true,
		},
		{
			name:        "wrong content type is rejected",
			body:        `{"image_path":"/a.svg","alt":"a"}`,
			contentType: "text/plain",
			wantStatus:  http.StatusBadRequest,
		},
		{
			// The concrete guard for Decision 2: HQ's current UI sends
			// sort_order, and it must fail loudly rather than be dropped.
			name:        "unknown field is rejected",
			body:        `{"image_path":"/a.svg","alt":"a","sort_order":3}`,
			contentType: "application/json",
			wantStatus:  http.StatusBadRequest,
		},
		{
			name:        "malformed json is rejected",
			body:        `{"image_path":`,
			contentType: "application/json",
			wantStatus:  http.StatusBadRequest,
		},
		{
			name:        "empty body is rejected",
			body:        ``,
			contentType: "application/json",
			wantStatus:  http.StatusBadRequest,
		},
		{
			name:        "trailing content after the object is rejected",
			body:        `{"image_path":"/a.svg","alt":"a"}{"another":1}`,
			contentType: "application/json",
			wantStatus:  http.StatusBadRequest,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(tt.body))
			if tt.contentType != "" {
				req.Header.Set("Content-Type", tt.contentType)
			}
			rec := httptest.NewRecorder()

			var dst slidePayload
			ok := decodeJSON(rec, req, &dst)

			if ok != tt.wantOK {
				t.Fatalf("decodeJSON ok = %v, want %v (body: %s)", ok, tt.wantOK, rec.Body.String())
			}
			if !tt.wantOK {
				if rec.Code != tt.wantStatus {
					t.Errorf("status = %d, want %d", rec.Code, tt.wantStatus)
				}
				if !strings.Contains(rec.Body.String(), `"error":"bad_request"`) {
					t.Errorf("body = %q, want the bad_request envelope", rec.Body.String())
				}
			}
		})
	}
}

// TestDecodeJSONRejectsOversizedBody verifies the MaxBytesReader guard.
func TestDecodeJSONRejectsOversizedBody(t *testing.T) {
	huge := `{"image_path":"` + strings.Repeat("a", maxAPIBodyBytes+1) + `","alt":"a"}`
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(huge))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	var dst slidePayload
	if decodeJSON(rec, req, &dst) {
		t.Fatal("decodeJSON accepted an oversized body")
	}
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

// TestWriteServiceErrorStatusMapping is the table the design's Error
// Handling section specifies: each sentinel maps to exactly one status,
// and anything unrecognized becomes an opaque 500.
func TestWriteServiceErrorStatusMapping(t *testing.T) {
	tests := []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
		// wantMessage, when set, must appear in the body — proving a
		// curated sentinel reaches the caller verbatim.
		wantMessage string
	}{
		{
			name: "slide not found", err: service.ErrSlideNotFound,
			wantStatus: http.StatusNotFound, wantCode: "not_found",
			wantMessage: service.ErrSlideNotFound.Error(),
		},
		{
			name: "work item not found", err: service.ErrWorkItemNotFound,
			wantStatus: http.StatusNotFound, wantCode: "not_found",
		},
		{
			name: "carousel full", err: service.ErrCarouselFull,
			wantStatus: http.StatusConflict, wantCode: "carousel_full",
			wantMessage: service.ErrCarouselFull.Error(),
		},
		{
			name: "missing alt text", err: service.ErrSlideAltRequired,
			wantStatus: http.StatusUnprocessableEntity, wantCode: "validation_failed",
			wantMessage: service.ErrSlideAltRequired.Error(),
		},
		{
			name: "missing hero title", err: service.ErrHeroTitleRequired,
			wantStatus: http.StatusUnprocessableEntity, wantCode: "validation_failed",
		},
		{
			name: "invalid reorder list", err: service.ErrReorderInvalid,
			wantStatus: http.StatusUnprocessableEntity, wantCode: "validation_failed",
		},
	}

	h := &LandingAPIHandler{}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			rec := httptest.NewRecorder()
			h.writeServiceError(rec, req, "test", tt.err)

			if rec.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d", rec.Code, tt.wantStatus)
			}
			var envelope apiError
			if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
				t.Fatalf("response is not valid JSON: %v (%s)", err, rec.Body.String())
			}
			if envelope.Code != tt.wantCode {
				t.Errorf("error code = %q, want %q", envelope.Code, tt.wantCode)
			}
			if tt.wantMessage != "" && envelope.Message != tt.wantMessage {
				t.Errorf("message = %q, want %q", envelope.Message, tt.wantMessage)
			}
		})
	}
}

// TestWriteServiceErrorHidesInternalDetail is the counterpart to the table
// above: an unrecognized error must never reach the client, since it can
// carry a wrapped database error including SQL or connection details.
func TestWriteServiceErrorHidesInternalDetail(t *testing.T) {
	secret := "pq: password authentication failed for user \"admin\""
	h := &LandingAPIHandler{}
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()

	h.writeServiceError(rec, req, "test", errStub(secret))

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
	if strings.Contains(rec.Body.String(), secret) {
		t.Errorf("response leaked internal error detail: %s", rec.Body.String())
	}
	var envelope apiError
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("response is not valid JSON: %v", err)
	}
	if envelope.Code != "internal_error" {
		t.Errorf("error code = %q, want %q", envelope.Code, "internal_error")
	}
}

type errStub string

func (e errStub) Error() string { return string(e) }

// TestListResponsesEncodeAsArrays guards against an empty table encoding
// as null, which would break a client that iterates the field directly.
func TestListResponsesEncodeAsArrays(t *testing.T) {
	slides, err := json.Marshal(map[string]any{"slides": slideResponses(nil)})
	if err != nil {
		t.Fatal(err)
	}
	if got := string(slides); got != `{"slides":[]}` {
		t.Errorf("empty slide list encoded as %s, want {\"slides\":[]}", got)
	}

	items, err := json.Marshal(map[string]any{"items": workResponses(nil)})
	if err != nil {
		t.Fatal(err)
	}
	if got := string(items); got != `{"items":[]}` {
		t.Errorf("empty work list encoded as %s, want {\"items\":[]}", got)
	}
}

// TestAPIPathID covers the 400 path for a malformed {id} segment.
func TestAPIPathID(t *testing.T) {
	tests := []struct {
		raw    string
		want   int64
		wantOK bool
	}{
		{"1", 1, true},
		{"9007199254740993", 9007199254740993, true},
		{"abc", 0, false},
		{"", 0, false},
		{"1.5", 0, false},
		{"-1", -1, true}, // parses fine; the lookup simply won't match
	}

	for _, tt := range tests {
		t.Run(tt.raw, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			req.SetPathValue("id", tt.raw)
			rec := httptest.NewRecorder()

			got, ok := apiPathID(rec, req)
			if ok != tt.wantOK {
				t.Fatalf("apiPathID(%q) ok = %v, want %v", tt.raw, ok, tt.wantOK)
			}
			if ok && got != tt.want {
				t.Errorf("apiPathID(%q) = %d, want %d", tt.raw, got, tt.want)
			}
			if !ok && rec.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want 400", rec.Code)
			}
		})
	}
}
