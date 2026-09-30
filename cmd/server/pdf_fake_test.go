package main

import "context"

// fakePDFGenerator satisfies handler.PDFGenerator without launching a real
// headless Chrome process, for tests that need a fully-wired mux
// (e2e_test.go, landing_api_routes_test.go) but aren't exercising PDF
// export itself — see docs/features/resume-export.md's Testing Plan and
// internal/handler/resume_export.go's PDFGenerator doc comment.
type fakePDFGenerator struct{}

func (fakePDFGenerator) RenderResumePDF(ctx context.Context) ([]byte, error) {
	return []byte("%PDF-1.7 fake resume pdf for tests"), nil
}
