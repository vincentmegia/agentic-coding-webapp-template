package service

import (
	"context"
	"fmt"

	"github.com/vincentmegia/vincentmegia/internal/model"
	"github.com/vincentmegia/vincentmegia/internal/repository"
)

// LandingContentService aggregates the landing_hero/landing_carousel_slides/
// landing_selected_work_items tables for both the public landing page and
// the /settings/content editor. See
// docs/features/landing-content-authoring.md.
type LandingContentService struct {
	Repo *repository.LandingContentRepository
}

// NewLandingContentService wraps a LandingContentRepository.
func NewLandingContentService(repo *repository.LandingContentRepository) *LandingContentService {
	return &LandingContentService{Repo: repo}
}

// PublicLandingView is what PagesHandler.Home renders the landing page
// from — the current hero copy plus the carousel/Selected work lists.
type PublicLandingView struct {
	Eyebrow        string
	Title          string
	Message        string
	CarouselSlides []model.CarouselSlide
	SelectedWork   []model.SelectedWorkItem
}

// GetPublicView fetches everything the landing page needs in one call.
func (s *LandingContentService) GetPublicView(ctx context.Context) (PublicLandingView, error) {
	hero, err := s.Repo.GetHero(ctx)
	if err != nil {
		return PublicLandingView{}, fmt.Errorf("get hero: %w", err)
	}
	slides, err := s.Repo.ListCarouselSlides(ctx)
	if err != nil {
		return PublicLandingView{}, fmt.Errorf("list carousel slides: %w", err)
	}
	items, err := s.Repo.ListSelectedWorkItems(ctx)
	if err != nil {
		return PublicLandingView{}, fmt.Errorf("list selected work items: %w", err)
	}
	return PublicLandingView{
		Eyebrow:        hero.Eyebrow,
		Title:          hero.Title,
		Message:        hero.Message,
		CarouselSlides: slides,
		SelectedWork:   items,
	}, nil
}

// HeroFormView backs components/content-hero-form.html.
type HeroFormView struct {
	Eyebrow string
	Title   string
	Message string
	// Error is a curated, user-facing validation message (e.g. "title is
	// required") — safe to render directly, never a raw internal error.
	// "" means no error.
	Error string
}

// CarouselEditorView backs components/content-carousel-editor.html.
type CarouselEditorView struct {
	Slides []model.CarouselSlide
	// Full is true once 5 slides already exist — the "Add slide" form
	// disables itself (docs/features/landing-carousel.md's cap).
	Full bool
	// Error is a curated, user-facing validation message. "" means no error.
	Error string
}

// WorkEditorView backs components/content-work-editor.html.
type WorkEditorView struct {
	Items []model.SelectedWorkItem
	// Error is a curated, user-facing validation message. "" means no error.
	Error string
}

// EditorView backs web/templates/pages/settings-content.html
// (GET /settings/content).
type EditorView struct {
	Hero     HeroFormView
	Carousel CarouselEditorView
	Work     WorkEditorView
}

// Get assembles the full /settings/content view.
func (s *LandingContentService) Get(ctx context.Context) (EditorView, error) {
	hero, err := s.heroView(ctx)
	if err != nil {
		return EditorView{}, err
	}
	carousel, err := s.carouselView(ctx)
	if err != nil {
		return EditorView{}, err
	}
	work, err := s.workView(ctx)
	if err != nil {
		return EditorView{}, err
	}
	return EditorView{Hero: hero, Carousel: carousel, Work: work}, nil
}

func (s *LandingContentService) heroView(ctx context.Context) (HeroFormView, error) {
	hero, err := s.Repo.GetHero(ctx)
	if err != nil {
		return HeroFormView{}, fmt.Errorf("get hero: %w", err)
	}
	return HeroFormView{Eyebrow: hero.Eyebrow, Title: hero.Title, Message: hero.Message}, nil
}

// SaveHero validates and persists a hero-form submission
// (POST /settings/content/hero). A validation failure is reported inline
// on the returned view (Error set, err nil) — only a genuine failure (e.g.
// a DB error) returns a non-nil err, which the caller must not show to
// the client directly.
func (s *LandingContentService) SaveHero(ctx context.Context, eyebrow, title, message string) (HeroFormView, error) {
	input, err := ValidateHeroInput(eyebrow, title, message)
	if err != nil {
		return HeroFormView{Eyebrow: eyebrow, Title: title, Message: message, Error: err.Error()}, nil
	}
	if err := s.Repo.SaveHero(ctx, model.HeroContent{Eyebrow: input.Eyebrow, Title: input.Title, Message: input.Message}); err != nil {
		return HeroFormView{}, fmt.Errorf("save hero: %w", err)
	}
	return s.heroView(ctx)
}

func (s *LandingContentService) carouselView(ctx context.Context) (CarouselEditorView, error) {
	slides, err := s.Repo.ListCarouselSlides(ctx)
	if err != nil {
		return CarouselEditorView{}, fmt.Errorf("list carousel slides: %w", err)
	}
	return CarouselEditorView{Slides: slides, Full: len(slides) >= maxCarouselSlides}, nil
}

func (s *LandingContentService) carouselViewWithError(ctx context.Context, message string) (CarouselEditorView, error) {
	view, err := s.carouselView(ctx)
	if err != nil {
		return CarouselEditorView{}, err
	}
	view.Error = message
	return view, nil
}

// CreateSlide validates and inserts a new carousel slide
// (POST /settings/content/carousel). See SaveHero's doc comment for the
// (view, err) contract.
func (s *LandingContentService) CreateSlide(ctx context.Context, imagePath, alt, caption, linkURL string, external bool) (CarouselEditorView, error) {
	input, err := ValidateCarouselSlideInput(imagePath, alt, caption, linkURL, external)
	if err != nil {
		return s.carouselViewWithError(ctx, err.Error())
	}

	count, err := s.Repo.CountCarouselSlides(ctx)
	if err != nil {
		return CarouselEditorView{}, fmt.Errorf("count carousel slides: %w", err)
	}
	if count >= maxCarouselSlides {
		return s.carouselViewWithError(ctx, ErrCarouselFull.Error())
	}

	if err := s.Repo.CreateCarouselSlide(ctx, model.CarouselSlide{
		ImagePath: input.ImagePath, Alt: input.Alt, Caption: input.Caption, LinkURL: input.LinkURL, External: input.External,
	}); err != nil {
		return CarouselEditorView{}, fmt.Errorf("create carousel slide: %w", err)
	}
	return s.carouselView(ctx)
}

// UpdateSlide validates and updates an existing carousel slide by ID
// (PUT /settings/content/carousel/{id}).
func (s *LandingContentService) UpdateSlide(ctx context.Context, id int64, imagePath, alt, caption, linkURL string, external bool) (CarouselEditorView, error) {
	input, err := ValidateCarouselSlideInput(imagePath, alt, caption, linkURL, external)
	if err != nil {
		return s.carouselViewWithError(ctx, err.Error())
	}
	if err := s.Repo.UpdateCarouselSlide(ctx, model.CarouselSlide{
		ID: id, ImagePath: input.ImagePath, Alt: input.Alt, Caption: input.Caption, LinkURL: input.LinkURL, External: input.External,
	}); err != nil {
		return CarouselEditorView{}, fmt.Errorf("update carousel slide: %w", err)
	}
	return s.carouselView(ctx)
}

// DeleteSlide removes a carousel slide by ID
// (DELETE /settings/content/carousel/{id}).
func (s *LandingContentService) DeleteSlide(ctx context.Context, id int64) (CarouselEditorView, error) {
	if err := s.Repo.DeleteCarouselSlide(ctx, id); err != nil {
		return CarouselEditorView{}, fmt.Errorf("delete carousel slide: %w", err)
	}
	return s.carouselView(ctx)
}

// MoveSlide swaps a carousel slide's display order with its neighbor
// (POST /settings/content/carousel/{id}/move). direction is "up" or
// "down"; anything else is a no-op (see repository.moveSortOrder).
func (s *LandingContentService) MoveSlide(ctx context.Context, id int64, direction string) (CarouselEditorView, error) {
	if err := s.Repo.MoveCarouselSlide(ctx, id, direction); err != nil {
		return CarouselEditorView{}, fmt.Errorf("move carousel slide: %w", err)
	}
	return s.carouselView(ctx)
}

func (s *LandingContentService) workView(ctx context.Context) (WorkEditorView, error) {
	items, err := s.Repo.ListSelectedWorkItems(ctx)
	if err != nil {
		return WorkEditorView{}, fmt.Errorf("list selected work items: %w", err)
	}
	return WorkEditorView{Items: items}, nil
}

func (s *LandingContentService) workViewWithError(ctx context.Context, message string) (WorkEditorView, error) {
	view, err := s.workView(ctx)
	if err != nil {
		return WorkEditorView{}, err
	}
	view.Error = message
	return view, nil
}

// CreateWorkItem validates and inserts a new Selected-work card
// (POST /settings/content/selected-work).
func (s *LandingContentService) CreateWorkItem(ctx context.Context, kicker, title, description, liveURL string, external bool) (WorkEditorView, error) {
	input, err := ValidateWorkItemInput(kicker, title, description, liveURL, external)
	if err != nil {
		return s.workViewWithError(ctx, err.Error())
	}
	if err := s.Repo.CreateSelectedWorkItem(ctx, model.SelectedWorkItem{
		Kicker: input.Kicker, Title: input.Title, Description: input.Description, LiveURL: input.LiveURL, External: input.External,
	}); err != nil {
		return WorkEditorView{}, fmt.Errorf("create selected work item: %w", err)
	}
	return s.workView(ctx)
}

// UpdateWorkItem validates and updates an existing Selected-work card by
// ID (PUT /settings/content/selected-work/{id}).
func (s *LandingContentService) UpdateWorkItem(ctx context.Context, id int64, kicker, title, description, liveURL string, external bool) (WorkEditorView, error) {
	input, err := ValidateWorkItemInput(kicker, title, description, liveURL, external)
	if err != nil {
		return s.workViewWithError(ctx, err.Error())
	}
	if err := s.Repo.UpdateSelectedWorkItem(ctx, model.SelectedWorkItem{
		ID: id, Kicker: input.Kicker, Title: input.Title, Description: input.Description, LiveURL: input.LiveURL, External: input.External,
	}); err != nil {
		return WorkEditorView{}, fmt.Errorf("update selected work item: %w", err)
	}
	return s.workView(ctx)
}

// DeleteWorkItem removes a Selected-work card by ID
// (DELETE /settings/content/selected-work/{id}).
func (s *LandingContentService) DeleteWorkItem(ctx context.Context, id int64) (WorkEditorView, error) {
	if err := s.Repo.DeleteSelectedWorkItem(ctx, id); err != nil {
		return WorkEditorView{}, fmt.Errorf("delete selected work item: %w", err)
	}
	return s.workView(ctx)
}

// MoveWorkItem swaps a Selected-work card's display order with its
// neighbor (POST /settings/content/selected-work/{id}/move).
func (s *LandingContentService) MoveWorkItem(ctx context.Context, id int64, direction string) (WorkEditorView, error) {
	if err := s.Repo.MoveSelectedWorkItem(ctx, id, direction); err != nil {
		return WorkEditorView{}, fmt.Errorf("move selected work item: %w", err)
	}
	return s.workView(ctx)
}
