package handler

import (
	"context"
	"fmt"
	"time"

	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/chromedp"
)

// pdfMaxConcurrent/pdfRenderTimeout bound headless Chrome's resource use —
// docs/features/resume-export.md's Security Considerations: "concurrency
// cap" and "chromedp process lifecycle". Values are a conservative default
// for a personal site's expected traffic, not tuned against real load.
const (
	pdfMaxConcurrent = 2
	pdfRenderTimeout = 15 * time.Second
)

// PDFRenderer owns one long-lived headless Chrome browser process, shared
// across every PDF export request for this server's lifetime — a fresh
// *tab* is opened and closed per request, never a fresh *browser* process,
// per docs/features/resume-export.md's "chromedp process lifecycle": a
// browser launched fresh per request is slow (multi-second cold start)
// and turns every request into a fresh chance for a missed cancel() to
// leak a process.
//
// It renders only baseURL+"/resume/print" — this app's own page, loaded
// over loopback HTTP — never a user-supplied or externally-resolvable
// URL, so it introduces no SSRF surface regardless of caller input (there
// is none: RenderResumePDF takes no arguments beyond a context).
type PDFRenderer struct {
	browserCtx context.Context
	cancel     context.CancelFunc
	sem        chan struct{}
	baseURL    string
}

// NewPDFRenderer starts the shared browser process. baseURL must be a
// loopback address (e.g. "http://127.0.0.1:8081") constructed from this
// server's own listen port at startup — never derived from a request, per
// the doc note above.
func NewPDFRenderer(baseURL string) *PDFRenderer {
	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		// Running Chromium in a minimal container generally requires
		// disabling its own sandbox (containers typically lack the
		// namespace/seccomp setup that sandbox needs) — a real reduction
		// in Chrome's defense-in-depth, accepted here specifically
		// because this renderer only ever navigates to this app's own
		// trusted, html/template-escaped page (see the type doc comment),
		// never attacker-supplied HTML or an arbitrary URL.
		chromedp.NoSandbox,
		chromedp.Flag("disable-gpu", true),
	)
	allocCtx, allocCancel := chromedp.NewExecAllocator(context.Background(), opts...)
	browserCtx, browserCancel := chromedp.NewContext(allocCtx)

	// Warm the browser process immediately at startup so the first real
	// request isn't the one paying Chrome's cold-start cost.
	_ = chromedp.Run(browserCtx)

	return &PDFRenderer{
		browserCtx: browserCtx,
		cancel: func() {
			browserCancel()
			allocCancel()
		},
		sem:     make(chan struct{}, pdfMaxConcurrent),
		baseURL: baseURL,
	}
}

// Close shuts down the shared browser process. Call once at server
// shutdown.
func (p *PDFRenderer) Close() {
	p.cancel()
}

// RenderResumePDF renders /resume/print to PDF bytes. Bounded by both the
// concurrency semaphore (a burst of requests queues rather than each
// spawning unbounded Chrome work) and a per-render timeout (so one slow or
// hung render can't hold a browser tab, or the semaphore slot, forever).
func (p *PDFRenderer) RenderResumePDF(ctx context.Context) ([]byte, error) {
	select {
	case p.sem <- struct{}{}:
		defer func() { <-p.sem }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	tabCtx, cancelTab := chromedp.NewContext(p.browserCtx)
	defer cancelTab()
	tabCtx, cancelTimeout := context.WithTimeout(tabCtx, pdfRenderTimeout)
	defer cancelTimeout()

	var pdfBytes []byte
	err := chromedp.Run(tabCtx,
		chromedp.Navigate(p.baseURL+"/resume/print"),
		chromedp.ActionFunc(func(ctx context.Context) error {
			data, _, err := page.PrintToPDF().
				WithPrintBackground(true).
				WithPreferCSSPageSize(true).
				Do(ctx)
			if err != nil {
				return err
			}
			pdfBytes = data
			return nil
		}),
	)
	if err != nil {
		return nil, fmt.Errorf("render resume pdf: %w", err)
	}
	return pdfBytes, nil
}
