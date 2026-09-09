package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/vincentmegia/vincentmegia/internal/middleware"
	"github.com/vincentmegia/vincentmegia/internal/model"
	"github.com/vincentmegia/vincentmegia/internal/service"
)

// maxAPIBodyBytes caps a request body so a large or endless payload can't
// exhaust memory (docs/features/landing-content-api.md's Security
// Considerations). Generous next to the largest legitimate request (a
// reorder list, or a slide with a long caption) and still tiny.
const maxAPIBodyBytes = 64 << 10 // 64 KiB

// LandingAPIHandler serves the internal JSON API HQ calls to edit landing
// content — see docs/features/landing-content-api.md.
//
// Every method here is a thin translation layer: parse and bound the
// request, hand off to LandingContentService (the same service the site's
// own /settings/content editor uses), and map the returned model or typed
// error onto a status code. No validation or business rule lives here —
// that would create a second, divergent rule set, which is precisely what
// routing HQ through this API is meant to prevent.
type LandingAPIHandler struct {
	Service *service.LandingContentService
}

// NewLandingAPIHandler constructs a LandingAPIHandler.
func NewLandingAPIHandler(landingContentService *service.LandingContentService) *LandingAPIHandler {
	return &LandingAPIHandler{Service: landingContentService}
}

// apiError is the single error envelope every non-2xx response uses.
// Code is stable and machine-readable so HQ can branch on it; Message is
// human-readable and safe to show an approver. Internal error detail never
// reaches either field — it is logged instead.
type apiError struct {
	Code    string `json:"error"`
	Message string `json:"message"`
}

// heroPayload is the request and response shape for /hero.
type heroPayload struct {
	Eyebrow string `json:"eyebrow"`
	Title   string `json:"title"`
	Message string `json:"message"`
}

// slidePayload is the request body for creating/updating a carousel slide.
// It deliberately has no id or sort_order field: ids come from the URL, and
// sort_order is server-managed (docs/features/landing-content-api.md's
// Decision 2). Because the decoder rejects unknown fields, a client that
// sends sort_order gets a clear 400 rather than silently having it ignored.
type slidePayload struct {
	ImagePath string `json:"image_path"`
	Alt       string `json:"alt"`
	Caption   string `json:"caption"`
	LinkURL   string `json:"link_url"`
	External  bool   `json:"external"`
}

// slideResponse is one slide as returned to a caller.
type slideResponse struct {
	ID        int64  `json:"id"`
	ImagePath string `json:"image_path"`
	Alt       string `json:"alt"`
	Caption   string `json:"caption"`
	LinkURL   string `json:"link_url"`
	External  bool   `json:"external"`
	SortOrder int    `json:"sort_order"`
}

// workPayload is the request body for creating/updating a Selected work
// card. See slidePayload for why id/sort_order are absent.
type workPayload struct {
	Kicker      string `json:"kicker"`
	Title       string `json:"title"`
	Description string `json:"description"`
	LiveURL     string `json:"live_url"`
	External    bool   `json:"external"`
}

// workResponse is one Selected work card as returned to a caller.
type workResponse struct {
	ID          int64  `json:"id"`
	Kicker      string `json:"kicker"`
	Title       string `json:"title"`
	Description string `json:"description"`
	LiveURL     string `json:"live_url"`
	External    bool   `json:"external"`
	SortOrder   int    `json:"sort_order"`
}

// reorderPayload is the request body for both reorder endpoints.
type reorderPayload struct {
	IDs []int64 `json:"ids"`
}

func toSlideResponse(s model.CarouselSlide) slideResponse {
	return slideResponse{
		ID: s.ID, ImagePath: s.ImagePath, Alt: s.Alt, Caption: s.Caption,
		LinkURL: s.LinkURL, External: s.External, SortOrder: s.SortOrder,
	}
}

func toWorkResponse(it model.SelectedWorkItem) workResponse {
	return workResponse{
		ID: it.ID, Kicker: it.Kicker, Title: it.Title, Description: it.Description,
		LiveURL: it.LiveURL, External: it.External, SortOrder: it.SortOrder,
	}
}

// GetHero handles GET /hero.
func (h *LandingAPIHandler) GetHero(w http.ResponseWriter, r *http.Request) {
	hero, err := h.Service.GetHero(r.Context())
	if err != nil {
		h.writeServiceError(w, r, "get hero", err)
		return
	}
	writeJSON(w, http.StatusOK, heroPayload{Eyebrow: hero.Eyebrow, Title: hero.Title, Message: hero.Message})
}

// PutHero handles PUT /hero, replacing all three fields.
func (h *LandingAPIHandler) PutHero(w http.ResponseWriter, r *http.Request) {
	var body heroPayload
	if !decodeJSON(w, r, &body) {
		return
	}
	hero, err := h.Service.ReplaceHero(r.Context(), body.Eyebrow, body.Title, body.Message)
	if err != nil {
		h.writeServiceError(w, r, "replace hero", err)
		return
	}
	writeJSON(w, http.StatusOK, heroPayload{Eyebrow: hero.Eyebrow, Title: hero.Title, Message: hero.Message})
}

// ListSlides handles GET /carousel.
func (h *LandingAPIHandler) ListSlides(w http.ResponseWriter, r *http.Request) {
	slides, err := h.Service.ListSlides(r.Context())
	if err != nil {
		h.writeServiceError(w, r, "list slides", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"slides": slideResponses(slides)})
}

// GetSlide handles GET /carousel/{id}.
func (h *LandingAPIHandler) GetSlide(w http.ResponseWriter, r *http.Request) {
	id, ok := apiPathID(w, r)
	if !ok {
		return
	}
	slide, err := h.Service.GetSlide(r.Context(), id)
	if err != nil {
		h.writeServiceError(w, r, "get slide", err)
		return
	}
	writeJSON(w, http.StatusOK, toSlideResponse(slide))
}

// CreateSlide handles POST /carousel.
func (h *LandingAPIHandler) CreateSlide(w http.ResponseWriter, r *http.Request) {
	var body slidePayload
	if !decodeJSON(w, r, &body) {
		return
	}
	slide, err := h.Service.CreateSlide(r.Context(), body.ImagePath, body.Alt, body.Caption, body.LinkURL, body.External)
	if err != nil {
		h.writeServiceError(w, r, "create slide", err)
		return
	}
	w.Header().Set("Location", fmt.Sprintf("%s/%d", strings.TrimSuffix(r.URL.Path, "/"), slide.ID))
	writeJSON(w, http.StatusCreated, toSlideResponse(slide))
}

// UpdateSlide handles PUT /carousel/{id}.
func (h *LandingAPIHandler) UpdateSlide(w http.ResponseWriter, r *http.Request) {
	id, ok := apiPathID(w, r)
	if !ok {
		return
	}
	var body slidePayload
	if !decodeJSON(w, r, &body) {
		return
	}
	slide, err := h.Service.UpdateSlide(r.Context(), id, body.ImagePath, body.Alt, body.Caption, body.LinkURL, body.External)
	if err != nil {
		h.writeServiceError(w, r, "update slide", err)
		return
	}
	writeJSON(w, http.StatusOK, toSlideResponse(slide))
}

// DeleteSlide handles DELETE /carousel/{id}.
func (h *LandingAPIHandler) DeleteSlide(w http.ResponseWriter, r *http.Request) {
	id, ok := apiPathID(w, r)
	if !ok {
		return
	}
	if err := h.Service.DeleteSlide(r.Context(), id); err != nil {
		h.writeServiceError(w, r, "delete slide", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ReorderSlides handles PUT /carousel/order.
func (h *LandingAPIHandler) ReorderSlides(w http.ResponseWriter, r *http.Request) {
	var body reorderPayload
	if !decodeJSON(w, r, &body) {
		return
	}
	slides, err := h.Service.ReorderSlides(r.Context(), body.IDs)
	if err != nil {
		h.writeServiceError(w, r, "reorder slides", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"slides": slideResponses(slides)})
}

// ListWorkItems handles GET /selected-work.
func (h *LandingAPIHandler) ListWorkItems(w http.ResponseWriter, r *http.Request) {
	items, err := h.Service.ListWorkItems(r.Context())
	if err != nil {
		h.writeServiceError(w, r, "list work items", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": workResponses(items)})
}

// GetWorkItem handles GET /selected-work/{id}.
func (h *LandingAPIHandler) GetWorkItem(w http.ResponseWriter, r *http.Request) {
	id, ok := apiPathID(w, r)
	if !ok {
		return
	}
	item, err := h.Service.GetWorkItem(r.Context(), id)
	if err != nil {
		h.writeServiceError(w, r, "get work item", err)
		return
	}
	writeJSON(w, http.StatusOK, toWorkResponse(item))
}

// CreateWorkItem handles POST /selected-work.
func (h *LandingAPIHandler) CreateWorkItem(w http.ResponseWriter, r *http.Request) {
	var body workPayload
	if !decodeJSON(w, r, &body) {
		return
	}
	item, err := h.Service.CreateWorkItem(r.Context(), body.Kicker, body.Title, body.Description, body.LiveURL, body.External)
	if err != nil {
		h.writeServiceError(w, r, "create work item", err)
		return
	}
	w.Header().Set("Location", fmt.Sprintf("%s/%d", strings.TrimSuffix(r.URL.Path, "/"), item.ID))
	writeJSON(w, http.StatusCreated, toWorkResponse(item))
}

// UpdateWorkItem handles PUT /selected-work/{id}.
func (h *LandingAPIHandler) UpdateWorkItem(w http.ResponseWriter, r *http.Request) {
	id, ok := apiPathID(w, r)
	if !ok {
		return
	}
	var body workPayload
	if !decodeJSON(w, r, &body) {
		return
	}
	item, err := h.Service.UpdateWorkItem(r.Context(), id, body.Kicker, body.Title, body.Description, body.LiveURL, body.External)
	if err != nil {
		h.writeServiceError(w, r, "update work item", err)
		return
	}
	writeJSON(w, http.StatusOK, toWorkResponse(item))
}

// DeleteWorkItem handles DELETE /selected-work/{id}.
func (h *LandingAPIHandler) DeleteWorkItem(w http.ResponseWriter, r *http.Request) {
	id, ok := apiPathID(w, r)
	if !ok {
		return
	}
	if err := h.Service.DeleteWorkItem(r.Context(), id); err != nil {
		h.writeServiceError(w, r, "delete work item", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ReorderWorkItems handles PUT /selected-work/order.
func (h *LandingAPIHandler) ReorderWorkItems(w http.ResponseWriter, r *http.Request) {
	var body reorderPayload
	if !decodeJSON(w, r, &body) {
		return
	}
	items, err := h.Service.ReorderWorkItems(r.Context(), body.IDs)
	if err != nil {
		h.writeServiceError(w, r, "reorder work items", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": workResponses(items)})
}

// slideResponses maps a slide slice, returning an empty (not nil) slice so
// an empty table encodes as [] rather than null.
func slideResponses(slides []model.CarouselSlide) []slideResponse {
	out := make([]slideResponse, 0, len(slides))
	for _, s := range slides {
		out = append(out, toSlideResponse(s))
	}
	return out
}

// workResponses maps a card slice. See slideResponses.
func workResponses(items []model.SelectedWorkItem) []workResponse {
	out := make([]workResponse, 0, len(items))
	for _, it := range items {
		out = append(out, toWorkResponse(it))
	}
	return out
}

// writeServiceError maps a service-layer error onto a status code, per
// docs/features/landing-content-api.md's Error Handling table.
//
// Only curated sentinels reach the client. Anything else is logged with
// the request ID and answered with a generic 500 — never the raw error,
// per docs/skills/go-backend/SKILL.md's Errors section.
func (h *LandingAPIHandler) writeServiceError(w http.ResponseWriter, r *http.Request, operation string, err error) {
	switch {
	case service.IsNotFoundError(err):
		writeAPIError(w, http.StatusNotFound, "not_found", err.Error())
	case errors.Is(err, service.ErrCarouselFull):
		writeAPIError(w, http.StatusConflict, "carousel_full", err.Error())
	case service.IsValidationError(err):
		writeAPIError(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
	default:
		slog.Error("landing api "+operation,
			"error", err,
			"request_id", middleware.RequestIDFromContext(r.Context()),
		)
		writeAPIError(w, http.StatusInternalServerError, "internal_error",
			"Something went wrong handling that request.")
	}
}

// apiPathID parses the {id} path segment, answering 400 on a malformed
// value. Distinct from parsePathID (the HTML editor's version), which
// writes a plain-text error body — an API client needs the JSON envelope.
func apiPathID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "bad_request", "Invalid id in path.")
		return 0, false
	}
	return id, true
}

// decodeJSON reads and strictly decodes a JSON request body into dst,
// writing the appropriate 400 and returning false on failure.
//
// Strict on three counts, each catching a real client mistake early:
// unknown fields are rejected (a typo'd or removed field name fails loudly
// instead of being silently dropped — this is what makes a client sending
// sort_order get a clear error), the body is size-bounded, and trailing
// content after the JSON value is rejected (which catches a doubled or
// concatenated payload).
func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	if contentType := r.Header.Get("Content-Type"); contentType != "" {
		if mediaType, _, _ := strings.Cut(contentType, ";"); !strings.EqualFold(strings.TrimSpace(mediaType), "application/json") {
			writeAPIError(w, http.StatusBadRequest, "bad_request", "Content-Type must be application/json.")
			return false
		}
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxAPIBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()

	if err := dec.Decode(dst); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeAPIError(w, http.StatusBadRequest, "bad_request", "Request body is too large.")
			return false
		}
		writeAPIError(w, http.StatusBadRequest, "bad_request", "Request body is not valid JSON for this endpoint.")
		return false
	}
	if dec.More() {
		writeAPIError(w, http.StatusBadRequest, "bad_request", "Request body must contain exactly one JSON object.")
		return false
	}
	return true
}

// writeJSON encodes v as the response body with the given status.
//
// Encodes into a buffer first (via json.Marshal) so an encoding failure
// produces a clean 500 rather than a half-written body followed by a
// superfluous WriteHeader — the same reason Renderer.execute buffers its
// template output.
func writeJSON(w http.ResponseWriter, status int, v any) {
	body, err := json.Marshal(v)
	if err != nil {
		slog.Error("marshal api response", "error", err)
		writeAPIError(w, http.StatusInternalServerError, "internal_error",
			"Something went wrong handling that request.")
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	w.Write(body)
}

// writeAPIError writes the standard error envelope. It never calls
// writeJSON, to avoid an encoding failure here recursing back into itself.
func writeAPIError(w http.ResponseWriter, status int, code, message string) {
	body, err := json.Marshal(apiError{Code: code, Message: message})
	if err != nil {
		// apiError is two plain strings, so this is unreachable in
		// practice; fall back to a hand-written body rather than risk
		// sending nothing at all.
		body = []byte(`{"error":"internal_error","message":"Something went wrong handling that request."}`)
		status = http.StatusInternalServerError
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	w.Write(body)
}

// APINotFound answers any unmatched route under the API prefix with the
// JSON envelope instead of ServeMux's default plain-text "404 page not
// found", so a client hitting a typo'd path still gets a parseable body.
func APINotFound(w http.ResponseWriter, r *http.Request) {
	writeAPIError(w, http.StatusNotFound, "not_found", "No such endpoint.")
}
