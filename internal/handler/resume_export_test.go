package handler

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/vincentmegia/vincentmegia/internal/repository"
	"github.com/vincentmegia/vincentmegia/internal/service"
)

// newTestResumeExportHandler builds a handler over a real ResumeService
// whose database is never reachable. There's deliberately no fake PDF
// generator: the previous chromedp implementation was only ever tested
// through one, which is how a server that couldn't render PDFs at all
// shipped with green tests (docs/features/resume-export.md's Decision).
// The generators themselves are tested for real in internal/service
// (resume_pdf_test.go, resume_docx_test.go), and the full success path —
// headers and a genuine PDF body from seeded data — in
// cmd/server/e2e_test.go.
func newTestResumeExportHandler(t *testing.T) *ResumeExportHandler {
	t.Helper()
	// database/sql opens lazily, so this is enough to construct a real
	// ResumeService/ResumeRepository pair whose queries fail — same
	// technique as cmd/server/landing_api_routes_test.go's lazyDB.
	conn, err := sql.Open("pgx", "postgres://unused:unused@127.0.0.1:1/unused")
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	t.Cleanup(func() { conn.Close() })

	resumeService := service.NewResumeService(repository.NewResumeRepository(conn, conn))
	return NewResumeExportHandler(resumeService)
}

// TestResumeExportHandler_DownloadPDF_Failure verifies a generation
// failure (here: the database is unreachable) returns a clean 500 with no
// attachment headers and never the raw underlying error.
func TestResumeExportHandler_DownloadPDF_Failure(t *testing.T) {
	h := newTestResumeExportHandler(t)

	req := httptest.NewRequest(http.MethodGet, "/resume/download.pdf", nil)
	req.RemoteAddr = "203.0.113.2:1111"
	rec := httptest.NewRecorder()
	h.DownloadPDF(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if cd := rec.Header().Get("Content-Disposition"); cd != "" {
		t.Errorf("Content-Disposition = %q on a failed export, want none", cd)
	}
	if strings.Contains(rec.Body.String(), "127.0.0.1") || strings.Contains(rec.Body.String(), "resume") {
		t.Errorf("response body leaked the underlying error: %q", rec.Body.String())
	}
}

// TestResumeExportHandler_DownloadPDF_RateLimited mirrors
// TestFishingGameHandler_SubmitScore_RateLimited's pattern
// (docs/features/resume-export.md's Security Considerations: "rate
// limiting — required, matching existing precedent"). Requests under the
// limit reach the (unreachable) database and 500; what's verified is that
// the one beyond the limit is rejected before generation, and that
// another source isn't.
func TestResumeExportHandler_DownloadPDF_RateLimited(t *testing.T) {
	h := newTestResumeExportHandler(t)
	remoteAddr := "203.0.113.13:12345"

	var lastCode int
	for i := 0; i < resumeDownloadLimit+1; i++ {
		req := httptest.NewRequest(http.MethodGet, "/resume/download.pdf", nil)
		req.RemoteAddr = remoteAddr
		rec := httptest.NewRecorder()
		h.DownloadPDF(rec, req)
		lastCode = rec.Code
	}

	if lastCode != http.StatusTooManyRequests {
		t.Errorf("status of the request beyond the limit = %d, want %d", lastCode, http.StatusTooManyRequests)
	}

	req := httptest.NewRequest(http.MethodGet, "/resume/download.pdf", nil)
	req.RemoteAddr = "198.51.100.20:54321"
	rec := httptest.NewRecorder()
	h.DownloadPDF(rec, req)
	if rec.Code == http.StatusTooManyRequests {
		t.Error("a different source was rate-limited by another IP's requests")
	}
}

// TestResumeExportHandler_DownloadWord_RateLimited exercises DownloadWord's
// own, independent limiter (docs/features/resume-export.md's Security
// Considerations: "pdfLimiter/docxLimiter are separate instances"). The
// underlying ResumeService has no real database to succeed against, so
// every request that reaches it 500s — what this test verifies is that
// requests beyond the limit are rejected by the limiter before reaching
// the service at all, i.e. status flips to 429, not that generation
// itself succeeds (see resume_docx_test.go for that, DB-free).
func TestResumeExportHandler_DownloadWord_RateLimited(t *testing.T) {
	h := newTestResumeExportHandler(t)
	remoteAddr := "203.0.113.14:12345"

	var lastCode int
	for i := 0; i < resumeDownloadLimit+1; i++ {
		req := httptest.NewRequest(http.MethodGet, "/resume/download.docx", nil)
		req.RemoteAddr = remoteAddr
		rec := httptest.NewRecorder()
		h.DownloadWord(rec, req)
		lastCode = rec.Code
	}

	if lastCode != http.StatusTooManyRequests {
		t.Errorf("status of the request beyond the limit = %d, want %d", lastCode, http.StatusTooManyRequests)
	}
}
