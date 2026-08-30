package model

// HeroContent is the landing_hero singleton row (id = 1). See
// docs/features/landing-content-authoring.md's Data Model.
type HeroContent struct {
	Eyebrow string
	Title   string
	Message string
}

// CarouselSlide is one landing_carousel_slides row. This shape (excluding
// ID/SortOrder, which the editor alone needs) is a fixed contract shared
// with web/static/js/carousel.js — see
// docs/features/landing-carousel.md's "Implementation Contract
// (DOM / Data)". Do not rename or restructure ImagePath/Alt/Caption/
// LinkURL/External without updating that doc.
type CarouselSlide struct {
	ID        int64
	ImagePath string // e.g. "/static/images/carousel/1.jpg"
	Alt       string // required
	Caption   string // optional, "" if none
	LinkURL   string // optional, "" if none
	External  bool   // true if LinkURL is off-site; drives target/rel
	SortOrder int
}

// SelectedWorkItem is one landing_selected_work_items row — a card in the
// landing page's "Selected work" section. LiveURL/External are optional
// and mirror internal/handler/template.go's Project fields (same names,
// same internal-route/off-site-URL meaning).
type SelectedWorkItem struct {
	ID          int64
	Kicker      string // small uppercase label, e.g. "Game"
	Title       string
	Description string
	LiveURL     string // optional, "" if none
	External    bool   // true if LiveURL is off-site; false means an internal route
	SortOrder   int
}
