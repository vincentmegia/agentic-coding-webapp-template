package handler

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/vincentmegia/vincentmegia/internal/middleware"
	"github.com/vincentmegia/vincentmegia/internal/service"
)

// resumeDownloadLimit/resumeDownloadLimitWindow bound both export routes:
// at most this many requests per source per window. Matches
// fishing_game.go's fishingScoreSubmitLimit pattern
// (docs/features/resume-export.md's Security Considerations: "these are
// unauthenticated GETs that each trigger real per-request work ... more
// expensive than any existing unauthenticated route in this app").
const (
	resumeDownloadLimit       = 5
	resumeDownloadLimitWindow = time.Minute
)

// ResumeExportHandler serves GET /resume/download.pdf and
// GET /resume/download.docx. See docs/features/resume-export.md.
type ResumeExportHandler struct {
	Service *service.ResumeService

	// pdfLimiter/docxLimiter are separate instances (not one shared
	// limiter) so hitting one export format doesn't consume the other's
	// budget.
	pdfLimiter  *scoreSubmitLimiter
	docxLimiter *scoreSubmitLimiter
}

// NewResumeExportHandler constructs a ResumeExportHandler.
func NewResumeExportHandler(resumeService *service.ResumeService) *ResumeExportHandler {
	return &ResumeExportHandler{
		Service:     resumeService,
		pdfLimiter:  newScoreSubmitLimiter(resumeDownloadLimit, resumeDownloadLimitWindow),
		docxLimiter: newScoreSubmitLimiter(resumeDownloadLimit, resumeDownloadLimitWindow),
	}
}

// DownloadPDF handles GET /resume/download.pdf.
func (h *ResumeExportHandler) DownloadPDF(w http.ResponseWriter, r *http.Request) {
	if !h.pdfLimiter.Allow(middleware.ClientKey(r)) {
		http.Error(w, "too many requests", http.StatusTooManyRequests)
		return
	}

	data, err := h.Service.GeneratePDF(r.Context())
	if err != nil {
		slog.Error("generate resume pdf", "error", err)
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return
	}

	// Filename is a hardcoded literal, never built from ResumeView data —
	// docs/features/resume-export.md's Security Considerations.
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", `attachment; filename="vincent-megia-resume.pdf"`)
	w.Write(data)
}

// DownloadWord handles GET /resume/download.docx.
func (h *ResumeExportHandler) DownloadWord(w http.ResponseWriter, r *http.Request) {
	if !h.docxLimiter.Allow(middleware.ClientKey(r)) {
		http.Error(w, "too many requests", http.StatusTooManyRequests)
		return
	}

	data, err := h.Service.GenerateDocx(r.Context())
	if err != nil {
		slog.Error("generate resume docx", "error", err)
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
	w.Header().Set("Content-Disposition", `attachment; filename="vincent-megia-resume.docx"`)
	w.Write(data)
}
