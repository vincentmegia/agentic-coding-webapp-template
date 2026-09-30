package handler

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/vincentmegia/vincentmegia/internal/repository"
	"github.com/vincentmegia/vincentmegia/internal/service"
)

// fakePDFGenerator is a controllable stand-in for *PDFRenderer — no real
// headless Chrome process, per PDFGenerator's own doc comment.
type fakePDFGenerator struct {
	data []byte
	err  error
}

func (f *fakePDFGenerator) RenderResumePDF(ctx context.Context) ([]byte, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.data, nil
}

func newTestResumeExportHandler(t *testing.T, pdf PDFGenerator) *ResumeExportHandler {
	t.Helper()
	// A DB that never actually connects — database/sql opens lazily, so
	// this is enough to construct a real ResumeService/ResumeRepository
	// pair for DownloadWord's rate-limiter test below, which only needs
	// the request to reach (and fail past) the repository, not succeed
	// against real data. Same technique as cmd/server/landing_api_routes_test.go's
	// lazyDB.
	conn, err := sql.Open("pgx", "postgres://unused:unused@127.0.0.1:1/unused")
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	t.Cleanup(func() { conn.Close() })

	resumeService := service.NewResumeService(repository.NewResumeRepository(conn, conn))
	return NewResumeExportHandler(resumeService, pdf)
}

// TestResumeExportHandler_DownloadPDF_Success verifies a successful PDF
// render streams back with the right content headers and a hardcoded,
// never-DB-derived filename (docs/features/resume-export.md's Security
// Considerations: "Content-Disposition filename is a hardcoded literal").
func TestResumeExportHandler_DownloadPDF_Success(t *testing.T) {
	h := newTestResumeExportHandler(t, &fakePDFGenerator{data: []byte("%PDF-1.7 fake")})

	req := httptest.NewRequest(http.MethodGet, "/resume/download.pdf", nil)
	req.RemoteAddr = "203.0.113.1:1111"
	rec := httptest.NewRecorder()
	h.DownloadPDF(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/pdf" {
		t.Errorf("Content-Type = %q, want application/pdf", ct)
	}
	if cd := rec.Header().Get("Content-Disposition"); cd != `attachment; filename="vincent-megia-resume.pdf"` {
		t.Errorf("Content-Disposition = %q, want the hardcoded resume filename", cd)
	}
	if !strings.HasPrefix(rec.Body.String(), "%PDF") {
		t.Errorf("body = %q, want it to start with %%PDF", rec.Body.String())
	}
}

// TestResumeExportHandler_DownloadPDF_RenderFailure verifies a chromedp
// render failure returns a clean 500, never the raw underlying error.
func TestResumeExportHandler_DownloadPDF_RenderFailure(t *testing.T) {
	h := newTestResumeExportHandler(t, &fakePDFGenerator{err: errors.New("chromedp: context deadline exceeded")})

	req := httptest.NewRequest(http.MethodGet, "/resume/download.pdf", nil)
	req.RemoteAddr = "203.0.113.2:1111"
	rec := httptest.NewRecorder()
	h.DownloadPDF(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "chromedp") {
		t.Errorf("response body leaked the underlying render error: %q", rec.Body.String())
	}
}

// TestResumeExportHandler_DownloadPDF_RateLimited mirrors
// TestFishingGameHandler_SubmitScore_RateLimited's pattern
// (docs/features/resume-export.md's Security Considerations: "rate
// limiting — required, matching existing precedent").
func TestResumeExportHandler_DownloadPDF_RateLimited(t *testing.T) {
	h := newTestResumeExportHandler(t, &fakePDFGenerator{data: []byte("%PDF-1.7 fake")})
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

	// A different source is unaffected by another IP's limit.
	req := httptest.NewRequest(http.MethodGet, "/resume/download.pdf", nil)
	req.RemoteAddr = "198.51.100.20:54321"
	rec := httptest.NewRecorder()
	h.DownloadPDF(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("a different source's status = %d, want 200 (unaffected by another IP's limit)", rec.Code)
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
	h := newTestResumeExportHandler(t, &fakePDFGenerator{})
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
