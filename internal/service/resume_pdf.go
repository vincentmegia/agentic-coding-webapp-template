package service

import (
	"bytes"
	"context"
	_ "embed"
	"fmt"
	"strconv"
	"strings"

	"codeberg.org/go-pdf/fpdf"

	"github.com/vincentmegia/vincentmegia/internal/model"
)

// GeneratePDF builds the resume PDF in-process, in pure Go, from the same
// resume_profile/resume_roles data /resume renders from — no headless
// browser, no external binary, no network hop, per
// docs/features/resume-export.md's Decision: the output is identical for
// every visitor's browser because no browser takes part in producing it,
// and it runs anywhere the Go binary itself runs (Render's native Go
// runtime included).
func (s *ResumeService) GeneratePDF(ctx context.Context) ([]byte, error) {
	profile, roles, err := s.fetch(ctx)
	if err != nil {
		return nil, err
	}
	return buildResumePDF(profile, roles)
}

// Fonts are the site's own Organic pairing (Caprasimo headings, Figtree
// body — docs/skills/tailwind-ui/SKILL.md's Visual Style) as static TTFs,
// embedded into the binary: fpdf can't read the .woff2 files
// web/static/fonts serves to browsers. Both are SIL OFL 1.1 — license
// texts ship alongside them in pdffonts/. Per-card font presets
// (docs/features/resume-content-authoring.md) are deliberately not
// carried into the PDF; see resume-export.md's Business Rules.
var (
	//go:embed pdffonts/Caprasimo-Regular.ttf
	fontCaprasimo []byte
	//go:embed pdffonts/Figtree-Regular.ttf
	fontFigtreeRegular []byte
	//go:embed pdffonts/Figtree-Medium.ttf
	fontFigtreeMedium []byte
	//go:embed pdffonts/Figtree-SemiBold.ttf
	fontFigtreeSemiBold []byte
	//go:embed pdffonts/Figtree-Bold.ttf
	fontFigtreeBold []byte
)

// One fpdf family per weight (rather than fpdf's own ""/"B" styles) since
// the design uses four Figtree weights, not two.
const (
	pdfHeading  = "caprasimo"
	pdfBody     = "figtree"
	pdfMedium   = "figtree-medium"
	pdfSemiBold = "figtree-semibold"
	pdfBold     = "figtree-bold"
)

type pdfColor struct{ r, g, b int }

// Light-mode Organic tokens from web/static/css/app.css's @theme — the
// same values its @media print block forces. The two *Tint colors are
// Tailwind's bg-accent/15 and bg-primary/10 pre-blended onto the surface
// they sit on, since fpdf has no alpha fill.
var (
	pdfInk          = pdfColor{0x20, 0x1e, 0x1d}
	pdfMuted        = pdfColor{0x82, 0x79, 0x6a}
	pdfLine         = pdfColor{0xdc, 0xd3, 0xc4}
	pdfPaper        = pdfColor{0xf5, 0xea, 0xd8}
	pdfSurface      = pdfColor{0xeb, 0xdd, 0xc5}
	pdfSurface2     = pdfColor{0xdc, 0xd3, 0xc4}
	pdfPrimary      = pdfColor{0xc6, 0x71, 0x39}
	pdfAccent       = pdfColor{0x7a, 0x8a, 0x5e}
	pdfAccentTint   = pdfColor{218, 209, 182}
	pdfPrimaryTint  = pdfColor{218, 201, 182}
	pdfBannerBg     = pdfColor{0x40, 0x23, 0x10}
	pdfBannerInk    = pdfColor{0xf9, 0xf4, 0xed}
	pdfBannerMuted  = pdfColor{0xff, 0xc6, 0xa5}
	pdfBannerAccent = pdfColor{0xf6, 0xa0, 0x6b}
)

// Page geometry (mm) matches app.css's print block: A4, 12mm/14mm margins.
const (
	pdfPageW   = 210.0
	pdfPageH   = 297.0
	pdfMarginX = 14.0
	pdfMarginY = 12.0
	// pdfScale shrinks the live page's CSS-pixel sizes slightly so the
	// document reads like a résumé rather than a screenshot of a web page
	// (text-sm lands at ~9.5pt).
	pdfScale = 0.9
)

// px converts a Tailwind CSS-pixel length into mm (96 CSS px per inch).
func px(n float64) float64 { return n * 25.4 / 96 * pdfScale }

// textStyle mirrors a Tailwind text-* size/line-height pair, in CSS px.
type textStyle struct {
	family string
	size   float64
	line   float64
	color  pdfColor
}

func (s textStyle) pt() float64    { return s.size * 0.75 * pdfScale }
func (s textStyle) lineH() float64 { return px(s.line) }

// apply sets s as fpdf's current font and text color.
func (s textStyle) apply(pdf *fpdf.Fpdf) {
	pdf.SetFont(s.family, "", s.pt())
	pdf.SetTextColor(s.color.r, s.color.g, s.color.b)
}

// baseline returns the text baseline for a line box starting at top,
// vertically centered the way CSS centers glyphs within line-height.
func (s textStyle) baseline(top float64) float64 {
	return top + s.lineH()/2 + s.pt()*0.3528*0.35
}

func setFill(pdf *fpdf.Fpdf, c pdfColor) { pdf.SetFillColor(c.r, c.g, c.b) }
func setDraw(pdf *fpdf.Fpdf, c pdfColor) { pdf.SetDrawColor(c.r, c.g, c.b) }

// pdfLinkable reports whether href may become a live link in the PDF.
// Resume content is owner-authored but editable via /settings/resume, so
// only the schemes the seeded content actually uses are ever made
// clickable — never e.g. a javascript: URI or a relative path that would
// resolve to nothing inside a downloaded file. Anything else still renders
// as plain text.
func pdfLinkable(href string) bool {
	h := strings.ToLower(strings.TrimSpace(href))
	for _, prefix := range []string{"https://", "http://", "mailto:", "tel:"} {
		if strings.HasPrefix(h, prefix) {
			return true
		}
	}
	return false
}

// pdfBlock is one measurable, drawable piece of the layout. Every block is
// measured before it's drawn so the pager can keep cards together across
// page breaks — fpdf's own auto page break knows nothing about cards.
type pdfBlock interface {
	height(pdf *fpdf.Fpdf, w float64) float64
	draw(pdf *fpdf.Fpdf, x, y, w float64)
}

// --- rich text ---------------------------------------------------------

// pdfRun is one span of text; family overrides the block's own family
// when set (used for **bold** runs from parseBoldSegments).
type pdfRun struct {
	text   string
	family string
}

type pdfWord struct {
	text   string
	family string
	x, w   float64
}

// richText is a word-wrapped paragraph of one or more runs.
type richText struct {
	runs       []pdfRun
	style      textStyle
	alignRight bool
}

func plainText(s string, style textStyle) *richText {
	return &richText{runs: []pdfRun{{text: s}}, style: style}
}

// markupText renders a summary paragraph's **bold** mini-markup through
// the same parseBoldSegments the HTML and Word exports use.
func markupText(raw string, style textStyle) *richText {
	var runs []pdfRun
	for _, seg := range parseBoldSegments(raw) {
		run := pdfRun{text: seg.Text}
		if seg.Bold {
			run.family = pdfBold
		}
		runs = append(runs, run)
	}
	return &richText{runs: runs, style: style}
}

// lines greedily word-wraps t into lines no wider than w. A space is kept
// between two words only where the source text had one, so a bold run
// butting against punctuation ("**PayPal**,") stays attached.
func (t *richText) lines(pdf *fpdf.Fpdf, w float64) [][]pdfWord {
	type token struct {
		text, family string
		spaceBefore  bool
	}
	var tokens []token
	pendingSpace := false
	for _, r := range t.runs {
		family := r.family
		if family == "" {
			family = t.style.family
		}
		for i, part := range strings.Split(r.text, " ") {
			if part == "" {
				pendingSpace = true
				continue
			}
			tokens = append(tokens, token{text: part, family: family, spaceBefore: pendingSpace || i > 0})
			pendingSpace = false
		}
	}

	var lines [][]pdfWord
	var line []pdfWord
	x := 0.0
	for _, tok := range tokens {
		pdf.SetFont(tok.family, "", t.style.pt())
		tw := pdf.GetStringWidth(tok.text)
		gap := 0.0
		if len(line) > 0 && tok.spaceBefore {
			gap = pdf.GetStringWidth(" ")
		}
		if len(line) > 0 && x+gap+tw > w {
			lines = append(lines, line)
			line, x, gap = nil, 0, 0
		}
		line = append(line, pdfWord{text: tok.text, family: tok.family, x: x + gap, w: tw})
		x += gap + tw
	}
	if len(line) > 0 {
		lines = append(lines, line)
	}
	return lines
}

func (t *richText) height(pdf *fpdf.Fpdf, w float64) float64 {
	return float64(len(t.lines(pdf, w))) * t.style.lineH()
}

func (t *richText) draw(pdf *fpdf.Fpdf, x, y, w float64) {
	for i, line := range t.lines(pdf, w) {
		offset := 0.0
		if t.alignRight {
			last := line[len(line)-1]
			offset = w - (last.x + last.w)
		}
		baseline := t.style.baseline(y + float64(i)*t.style.lineH())
		for _, word := range line {
			pdf.SetFont(word.family, "", t.style.pt())
			pdf.SetTextColor(t.style.color.r, t.style.color.g, t.style.color.b)
			pdf.Text(x+offset+word.x, baseline, word.text)
		}
	}
}

// width is the widest line of t when unconstrained.
func (t *richText) width(pdf *fpdf.Fpdf) float64 {
	widest := 0.0
	for _, line := range t.lines(pdf, 1e6) {
		last := line[len(line)-1]
		widest = max(widest, last.x+last.w)
	}
	return widest
}

// --- inline flows: skill chips, link rows -------------------------------

type pdfPill struct {
	bg         pdfColor
	padX, padY float64
}

type flowItem struct {
	text string
	href string
}

// inlineFlow lays items out left to right, wrapping like CSS
// flex-wrap with gap-x/gap-y — the contact row, project links, and the
// rounded-full skill chips.
type inlineFlow struct {
	items      []flowItem
	style      textStyle
	gapX, gapY float64
	pill       *pdfPill
}

type flowBox struct {
	item       flowItem
	x, y, w, h float64
}

func (f *inlineFlow) boxes(pdf *fpdf.Fpdf, w float64) ([]flowBox, float64) {
	f.style.apply(pdf)
	padX, padY := 0.0, 0.0
	if f.pill != nil {
		padX, padY = f.pill.padX, f.pill.padY
	}
	itemH := f.style.lineH() + 2*padY

	var boxes []flowBox
	x, y := 0.0, 0.0
	for _, it := range f.items {
		iw := pdf.GetStringWidth(it.text) + 2*padX
		if x > 0 && x+iw > w {
			x, y = 0, y+itemH+f.gapY
		}
		boxes = append(boxes, flowBox{item: it, x: x, y: y, w: iw, h: itemH})
		x += iw + f.gapX
	}
	if len(boxes) == 0 {
		return nil, 0
	}
	return boxes, y + itemH
}

func (f *inlineFlow) height(pdf *fpdf.Fpdf, w float64) float64 {
	_, h := f.boxes(pdf, w)
	return h
}

func (f *inlineFlow) draw(pdf *fpdf.Fpdf, x, y, w float64) {
	boxes, _ := f.boxes(pdf, w)
	padX, padY := 0.0, 0.0
	if f.pill != nil {
		padX, padY = f.pill.padX, f.pill.padY
	}
	for _, b := range boxes {
		bx, by := x+b.x, y+b.y
		if f.pill != nil {
			setFill(pdf, f.pill.bg)
			pdf.RoundedRect(bx, by, b.w, b.h, b.h/2, "1234", "F")
		}
		f.style.apply(pdf)
		pdf.Text(bx+padX, f.style.baseline(by+padY), b.item.text)
		if pdfLinkable(b.item.href) {
			pdf.LinkString(bx, by, b.w, b.h, b.item.href)
		}
	}
}

// --- bullets, rules, grids, stacks --------------------------------------

// bullet is one <li> with the sage dot marker from resume-role.html.
type bullet struct {
	text *richText
	dot  pdfColor
}

func (b *bullet) indent() float64 { return px(6 + 8) }

func (b *bullet) height(pdf *fpdf.Fpdf, w float64) float64 {
	return b.text.height(pdf, w-b.indent())
}

func (b *bullet) draw(pdf *fpdf.Fpdf, x, y, w float64) {
	setFill(pdf, b.dot)
	pdf.Circle(x+px(3), y+b.text.style.lineH()/2, px(3), "F")
	b.text.draw(pdf, x+b.indent(), y, w-b.indent())
}

// hRule is a border-t divider.
type hRule struct{ color pdfColor }

func (r *hRule) height(*fpdf.Fpdf, float64) float64 { return px(1) }

func (r *hRule) draw(pdf *fpdf.Fpdf, x, y, w float64) {
	setDraw(pdf, r.color)
	pdf.SetLineWidth(px(1))
	pdf.Line(x, y, x+w, y)
}

// grid is a fixed-column CSS grid (the summary's stat row).
type grid struct {
	cols       int
	gapX, gapY float64
	cells      []pdfBlock
}

func (g *grid) cellW(w float64) float64 {
	return (w - float64(g.cols-1)*g.gapX) / float64(g.cols)
}

func (g *grid) rowHeights(pdf *fpdf.Fpdf, w float64) []float64 {
	var rows []float64
	for i, c := range g.cells {
		if i%g.cols == 0 {
			rows = append(rows, 0)
		}
		rows[len(rows)-1] = max(rows[len(rows)-1], c.height(pdf, g.cellW(w)))
	}
	return rows
}

func (g *grid) height(pdf *fpdf.Fpdf, w float64) float64 {
	rows := g.rowHeights(pdf, w)
	h := 0.0
	for i, rh := range rows {
		if i > 0 {
			h += g.gapY
		}
		h += rh
	}
	return h
}

func (g *grid) draw(pdf *fpdf.Fpdf, x, y, w float64) {
	cw := g.cellW(w)
	rows := g.rowHeights(pdf, w)
	for i, c := range g.cells {
		row, col := i/g.cols, i%g.cols
		cy := y
		for r := 0; r < row; r++ {
			cy += rows[r] + g.gapY
		}
		c.draw(pdf, x+float64(col)*(cw+g.gapX), cy, cw)
	}
}

// stackItem is a block plus its margin-top, i.e. one child of a Tailwind
// space-y-*/mt-* vertical stack.
type stackItem struct {
	block pdfBlock
	mt    float64
}

type stack []stackItem

func (s stack) height(pdf *fpdf.Fpdf, w float64) float64 {
	h := 0.0
	for _, it := range s {
		h += it.mt + it.block.height(pdf, w)
	}
	return h
}

func (s stack) draw(pdf *fpdf.Fpdf, x, y, w float64) {
	for _, it := range s {
		y += it.mt
		it.block.draw(pdf, x, y, w)
		y += it.block.height(pdf, w)
	}
}

// roleHeader is resume-role.html's <header>: title + company on the left,
// date range + "Current" badge right-aligned beside them.
type roleHeader struct {
	title   *richText
	company *richText
	date    *richText
	current bool
}

var pdfBadgeStyle = textStyle{family: pdfSemiBold, size: 12, line: 16, color: pdfAccent}

func (h *roleHeader) badgeW(pdf *fpdf.Fpdf) float64 {
	pdfBadgeStyle.apply(pdf)
	return pdf.GetStringWidth("Current") + 2*px(10)
}

func (h *roleHeader) rightW(pdf *fpdf.Fpdf) float64 {
	w := h.date.width(pdf)
	if h.current {
		w += px(8) + h.badgeW(pdf)
	}
	return w
}

func (h *roleHeader) leftW(pdf *fpdf.Fpdf, w float64) float64 {
	return w - h.rightW(pdf) - px(16)
}

func (h *roleHeader) height(pdf *fpdf.Fpdf, w float64) float64 {
	lw := h.leftW(pdf, w)
	left := h.title.height(pdf, lw) + h.company.height(pdf, lw)
	return max(left, pdfBadgeStyle.lineH()+2*px(2))
}

func (h *roleHeader) draw(pdf *fpdf.Fpdf, x, y, w float64) {
	lw := h.leftW(pdf, w)
	h.title.draw(pdf, x, y, lw)
	h.company.draw(pdf, x, y+h.title.height(pdf, lw), lw)

	// Vertically center the right-hand group on the title's first line.
	rowH := pdfBadgeStyle.lineH() + 2*px(2)
	top := y + (h.title.style.lineH()-rowH)/2
	rx := x + w - h.rightW(pdf)
	h.date.draw(pdf, rx, top+px(2), h.date.width(pdf))
	if h.current {
		bx := rx + h.date.width(pdf) + px(8)
		bw := h.badgeW(pdf)
		setFill(pdf, pdfAccentTint)
		pdf.RoundedRect(bx, top, bw, rowH, rowH/2, "1234", "F")
		pdfBadgeStyle.apply(pdf)
		pdf.Text(bx+px(10), pdfBadgeStyle.baseline(top+px(2)), "Current")
	}
}

// --- cards and pagination ------------------------------------------------

// timelineMark is the experience timeline's gutter: a connector line plus
// a per-role dot (resume-timeline.html / resume-role.html). first/last
// trim the line to start and end at the timeline's own ends.
type timelineMark struct {
	current, first, last bool
}

var pdfGutterW = px(32)

// card is a rounded-card section: background, optional border, padding,
// and a vertical stack of children. A card that fits on a page is never
// split; one taller than a whole page is split between children, each
// page's piece getting its own background.
type card struct {
	items    stack
	bg       pdfColor
	border   bool
	pad      float64
	timeline *timelineMark
}

func (c *card) innerX(x float64) float64 {
	if c.timeline != nil {
		x += pdfGutterW
	}
	return x + c.pad
}

func (c *card) innerW(w float64) float64 {
	if c.timeline != nil {
		w -= pdfGutterW
	}
	return w - 2*c.pad
}

func (c *card) height(pdf *fpdf.Fpdf, w float64) float64 {
	return 2*c.pad + c.items.height(pdf, c.innerW(w))
}

func (c *card) draw(pdf *fpdf.Fpdf, x, y, w float64) {
	h := c.height(pdf, w)
	c.drawChrome(pdf, x, y, w, h, true, true)
	c.items.draw(pdf, c.innerX(x), y+c.pad, c.innerW(w))
}

// drawChrome paints the card's background/border (and timeline gutter)
// for one on-page piece of height h. isFirst/isLast say whether this piece
// holds the card's top/bottom, for the timeline line's end caps and dot.
func (c *card) drawChrome(pdf *fpdf.Fpdf, x, y, w, h float64, isFirst, isLast bool) {
	boxX, boxW := x, w
	if c.timeline != nil {
		boxX, boxW = x+pdfGutterW, w-pdfGutterW
		cx := x + px(10)
		lineTop, lineBottom := y, min(y+h+pdfCardGap, pdfBottom)
		if isFirst && c.timeline.first {
			lineTop = y + px(10)
		}
		if isLast && c.timeline.last {
			lineBottom = y + h - px(10)
		}
		setDraw(pdf, pdfLine)
		pdf.SetLineWidth(px(2))
		pdf.Line(cx, lineTop, cx, lineBottom)
		if isFirst {
			fill, ring := pdfSurface, pdfLine
			if c.timeline.current {
				fill, ring = pdfAccentTint, pdfAccent
			}
			setFill(pdf, fill)
			setDraw(pdf, ring)
			pdf.Circle(cx, y+px(24)+px(10), px(9), "FD")
		}
	}
	setFill(pdf, c.bg)
	style := "F"
	if c.border {
		setDraw(pdf, pdfLine)
		pdf.SetLineWidth(px(1))
		style = "FD"
	}
	pdf.RoundedRect(boxX, y, boxW, h, px(12), "1234", style)
}

var pdfCardGap = px(24)

// pdfPager places cards down the page, starting a new page whenever the
// next card won't fit.
type pdfPager struct {
	pdf *fpdf.Fpdf
	y   float64
}

const (
	pdfTop    = pdfMarginY
	pdfBottom = pdfPageH - pdfMarginY
)

func (p *pdfPager) newPage() {
	p.pdf.AddPage()
	p.y = pdfTop
}

func (p *pdfPager) place(c *card, gapBefore float64) {
	x, w := pdfMarginX, pdfPageW-2*pdfMarginX
	p.y += gapBefore
	h := c.height(p.pdf, w)
	switch {
	case p.y+h <= pdfBottom:
	case h <= pdfBottom-pdfTop:
		p.newPage()
	default:
		p.placeSplit(c, x, w)
		return
	}
	c.draw(p.pdf, x, p.y, w)
	p.y += h
}

// placeSplit draws a card taller than one page as several pieces, breaking
// only between its children.
func (p *pdfPager) placeSplit(c *card, x, w float64) {
	iw := c.innerW(w)
	// Not even the first child fits below whatever's already on this
	// page — start the whole card on a fresh one.
	if len(c.items) > 0 && p.y+2*c.pad+c.items[0].block.height(p.pdf, iw) > pdfBottom {
		p.newPage()
	}

	var pieces []stack
	var cur stack
	used, avail := 2*c.pad, pdfBottom-p.y
	for _, it := range c.items {
		ih := it.block.height(p.pdf, iw)
		mt := it.mt
		if len(cur) == 0 {
			mt = 0
		}
		if len(cur) > 0 && used+mt+ih > avail {
			pieces = append(pieces, cur)
			cur, mt, used, avail = nil, 0, 2*c.pad, pdfBottom-pdfTop
		}
		cur = append(cur, stackItem{block: it.block, mt: mt})
		used += mt + ih
	}
	pieces = append(pieces, cur)

	for i, pc := range pieces {
		if i > 0 {
			p.newPage()
		}
		h := 2*c.pad + pc.height(p.pdf, iw)
		c.drawChrome(p.pdf, x, p.y, w, h, i == 0, i == len(pieces)-1)
		pc.draw(p.pdf, c.innerX(x), p.y+c.pad, iw)
		p.y += h
	}
}

// --- document -----------------------------------------------------------

// Tailwind sizes used below, as (size, line-height) CSS px pairs.
var (
	pdfTextXS      = textStyle{family: pdfBody, size: 12, line: 16}
	pdfTextSM      = textStyle{family: pdfBody, size: 14, line: 20}
	pdfTextSMLoose = textStyle{family: pdfBody, size: 14, line: 22.75}
)

func withColor(s textStyle, c pdfColor) textStyle { s.color = c; return s }
func withFamily(s textStyle, f string) textStyle  { s.family = f; return s }

// buildResumePDF is the pure, DB-free half of GeneratePDF, mirroring
// buildResumeDocx's split so it's unit-testable against fixture data.
//
// Layout follows the live /resume page's components card for card, in
// conventional résumé reading order — banner, summary, experience, then
// the sidebar's cards — rather than the on-screen two-column split, which
// a paginated document can't reproduce faithfully.
func buildResumePDF(profile model.Profile, roles []model.Role) ([]byte, error) {
	pdf := fpdf.New("P", "mm", "A4", "")
	pdf.SetMargins(pdfMarginX, pdfMarginY, pdfMarginX)
	pdf.SetAutoPageBreak(false, 0)
	pdf.SetTitle("Vincent Megia — Résumé", true)
	pdf.SetAuthor("Vincent Megia", true)
	pdf.AddUTF8FontFromBytes(pdfHeading, "", fontCaprasimo)
	pdf.AddUTF8FontFromBytes(pdfBody, "", fontFigtreeRegular)
	pdf.AddUTF8FontFromBytes(pdfMedium, "", fontFigtreeMedium)
	pdf.AddUTF8FontFromBytes(pdfSemiBold, "", fontFigtreeSemiBold)
	pdf.AddUTF8FontFromBytes(pdfBold, "", fontFigtreeBold)
	pdf.SetHeaderFunc(func() {
		setFill(pdf, pdfPaper)
		pdf.Rect(0, 0, pdfPageW, pdfPageH, "F")
	})

	p := &pdfPager{pdf: pdf}
	p.newPage()

	p.place(pdfBanner(profile), 0)
	if len(profile.SummaryParagraphs) > 0 || len(profile.Stats) > 0 {
		p.place(pdfSummary(profile), pdfCardGap)
	}
	for i, r := range roles {
		p.place(pdfRole(r, i == 0, i == len(roles)-1), pdfCardGap)
	}
	if len(profile.SkillGroups) > 0 {
		p.place(pdfExpertise(profile.SkillGroups), pdfCardGap)
	}
	if len(profile.Education) > 0 {
		p.place(pdfEducation(profile.Education), pdfCardGap)
	}
	if len(profile.FeaturedProjects) > 0 {
		p.place(pdfFeatured(profile.FeaturedProjects), pdfCardGap)
	}

	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		return nil, fmt.Errorf("write resume pdf: %w", err)
	}
	return buf.Bytes(), nil
}

// pdfBanner mirrors resume-banner.html.
func pdfBanner(profile model.Profile) *card {
	items := stack{
		{block: plainText("Vincent Megia", textStyle{family: pdfHeading, size: 30, line: 36, color: pdfBannerInk})},
		{block: plainText(profile.RoleTitle, textStyle{family: pdfMedium, size: 18, line: 28, color: pdfBannerAccent}), mt: px(4)},
	}
	var meta []string
	for _, s := range []string{profile.TenureLabel, profile.LocationLabel} {
		if s != "" {
			meta = append(meta, s)
		}
	}
	if len(meta) > 0 {
		items = append(items, stackItem{block: plainText(strings.Join(meta, " · "), withColor(pdfTextSM, pdfBannerMuted)), mt: px(12)})
	}
	if len(profile.ContactLinks) > 0 {
		var links []flowItem
		for _, c := range profile.ContactLinks {
			links = append(links, flowItem{text: c.Label, href: c.Href})
		}
		items = append(items, stackItem{
			block: &inlineFlow{items: links, style: withColor(pdfTextSM, pdfBannerInk), gapX: px(24), gapY: px(12)},
			mt:    px(24),
		})
	}
	return &card{items: items, bg: pdfBannerBg, pad: px(40)}
}

// pdfSummary mirrors resume-summary.html.
func pdfSummary(profile model.Profile) *card {
	var items stack
	body := textStyle{family: pdfBody, size: 16, line: 26, color: pdfInk}
	for i, para := range profile.SummaryParagraphs {
		mt := px(16)
		if i == 0 {
			mt = 0
		}
		items = append(items, stackItem{block: markupText(para, body), mt: mt})
	}
	if len(profile.Stats) > 0 {
		g := &grid{cols: 4, gapX: px(16), gapY: px(16)}
		for _, s := range profile.Stats {
			g.cells = append(g.cells, stack{
				{block: plainText(s.Num, textStyle{family: pdfSemiBold, size: 24, line: 32, color: pdfPrimary})},
				{block: plainText(s.Label, withColor(pdfTextXS, pdfMuted)), mt: px(4)},
			})
		}
		mt := px(24)
		if len(items) == 0 {
			mt = 0
		}
		items = append(items, stackItem{block: &hRule{color: pdfLine}, mt: mt}, stackItem{block: g, mt: px(24)})
	}
	return &card{items: items, bg: pdfSurface, border: true, pad: px(32)}
}

// pdfRole mirrors resume-role.html, including its timeline gutter.
func pdfRole(r model.Role, first, last bool) *card {
	company := r.Company
	if r.Location != "" {
		company += " — " + r.Location
	}
	header := &roleHeader{
		title:   plainText(r.Title, textStyle{family: pdfHeading, size: 18, line: 28, color: pdfInk}),
		company: plainText(company, withColor(withFamily(pdfTextSM, pdfMedium), pdfPrimary)),
		date:    plainText(dateRange(r.StartDate, r.EndDate), withColor(withFamily(pdfTextXS, pdfMedium), pdfMuted)),
		current: r.EndDate == nil,
	}
	items := stack{{block: header}}
	if r.Blurb != "" {
		items = append(items, stackItem{block: plainText(r.Blurb, withColor(pdfTextSMLoose, pdfInk)), mt: px(16)})
	}
	for i, b := range r.Bullets {
		mt := px(8)
		if i == 0 {
			mt = px(16)
		}
		items = append(items, stackItem{block: &bullet{text: plainText(b, withColor(pdfTextSMLoose, pdfInk)), dot: pdfAccent}, mt: mt})
	}
	for i, sp := range r.Subprojects {
		if i == 0 {
			items = append(items, stackItem{block: &hRule{color: pdfLine}, mt: px(24)})
		}
		items = append(items, stackItem{block: pdfSubproject(sp), mt: px(16)})
	}
	return &card{
		items:    items,
		bg:       pdfSurface,
		border:   true,
		pad:      px(32),
		timeline: &timelineMark{current: r.EndDate == nil, first: first, last: last},
	}
}

// pdfSubproject mirrors resume-role.html's .resume-subproject box.
func pdfSubproject(sp model.Subproject) *card {
	heading := stack{{block: plainText(sp.Heading, textStyle{family: pdfHeading, size: 14, line: 20, color: pdfInk})}}
	if sp.ClientTag != nil && *sp.ClientTag != "" {
		heading = append(heading, stackItem{
			block: &inlineFlow{
				items: []flowItem{{text: *sp.ClientTag}},
				style: withColor(withFamily(pdfTextXS, pdfMedium), pdfPrimary),
				pill:  &pdfPill{bg: pdfPrimaryTint, padX: px(8), padY: px(2)},
			},
			mt: px(4),
		})
	}
	items := stack{{block: heading}}
	if sp.Blurb != "" {
		items = append(items, stackItem{block: plainText(sp.Blurb, withColor(pdfTextSMLoose, pdfInk)), mt: px(8)})
	}
	for i, b := range sp.Bullets {
		mt := px(6)
		if i == 0 {
			mt = px(8)
		}
		items = append(items, stackItem{block: &bullet{text: plainText(b, withColor(pdfTextSMLoose, pdfInk)), dot: pdfAccent}, mt: mt})
	}
	return &card{items: items, bg: pdfSurface2, pad: px(16)}
}

// pdfSidebarHeading is resume-sidebar.html's small uppercase card title.
func pdfSidebarHeading(text string) pdfBlock {
	return plainText(strings.ToUpper(text), textStyle{family: pdfHeading, size: 14, line: 20, color: pdfMuted})
}

// pdfExpertise mirrors resume-sidebar.html's Core Expertise card.
func pdfExpertise(groups []model.SkillGroup) *card {
	items := stack{{block: pdfSidebarHeading("Core Expertise")}}
	for _, g := range groups {
		var chips []flowItem
		for _, s := range g.Skills {
			chips = append(chips, flowItem{text: s})
		}
		items = append(items,
			stackItem{block: plainText(g.Name, withColor(withFamily(pdfTextSM, pdfMedium), pdfInk)), mt: px(16)},
			stackItem{block: &inlineFlow{
				items: chips,
				style: withColor(withFamily(pdfTextXS, pdfMedium), pdfInk),
				gapX:  px(8), gapY: px(8),
				pill: &pdfPill{bg: pdfSurface2, padX: px(12), padY: px(4)},
			}, mt: px(8)},
		)
	}
	return &card{items: items, bg: pdfSurface, border: true, pad: px(24)}
}

// pdfEducation mirrors resume-sidebar.html's Education card.
func pdfEducation(education []model.Education) *card {
	items := stack{{block: pdfSidebarHeading("Education")}}
	for _, e := range education {
		items = append(items,
			stackItem{block: plainText(e.Degree, withColor(withFamily(pdfTextSM, pdfMedium), pdfInk)), mt: px(16)},
			stackItem{block: plainText(e.School, withColor(pdfTextSM, pdfMuted))},
			stackItem{block: plainText(strconv.Itoa(e.StartYear)+" – "+strconv.Itoa(e.EndYear), withColor(pdfTextXS, pdfMuted)), mt: px(2)},
		)
	}
	return &card{items: items, bg: pdfSurface, border: true, pad: px(24)}
}

// pdfFeatured mirrors resume-sidebar.html's Featured Projects card, minus
// its "See all projects" link: that's site navigation to a relative
// /projects URL, meaningless inside a downloaded file.
func pdfFeatured(projects []model.FeaturedProject) *card {
	items := stack{{block: pdfSidebarHeading("Featured Projects")}}
	for _, fp := range projects {
		items = append(items,
			stackItem{block: plainText(fp.Name, withColor(withFamily(pdfTextSM, pdfMedium), pdfInk)), mt: px(16)},
			stackItem{block: plainText(fp.Description, withColor(pdfTextSM, pdfMuted)), mt: px(4)},
		)
		if len(fp.Links) > 0 {
			var links []flowItem
			for _, l := range fp.Links {
				links = append(links, flowItem{text: l.Label, href: l.Href})
			}
			items = append(items, stackItem{
				block: &inlineFlow{items: links, style: withColor(withFamily(pdfTextSM, pdfMedium), pdfPrimary), gapX: px(16), gapY: px(4)},
				mt:    px(8),
			})
		}
	}
	return &card{items: items, bg: pdfSurface, border: true, pad: px(24)}
}
