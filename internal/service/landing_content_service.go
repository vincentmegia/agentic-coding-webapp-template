package service

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/vincentmegia/vincentmegia/internal/model"
	"github.com/vincentmegia/vincentmegia/internal/repository"
)

// LandingContentService aggregates the landing_hero/landing_carousel_slides/
// landing_selected_work_items tables for three callers: the public landing
// page, this site's own /settings/content editor, and the internal JSON API
// HQ calls (docs/features/landing-content-api.md).
//
// Method naming splits those last two apart deliberately:
//
//   - The plain methods (CreateSlide, UpdateSlide, ...) are the API shape:
//     they return the stored model and a typed error, so a JSON caller can
//     distinguish a validation failure (422) from an unknown ID (404) from
//     an internal fault (500).
//   - The *Form methods are the HTML-editor shape: they return a rendered
//     view-model and fold validation failures into a display string, since
//     an HTML form re-renders itself with an inline message rather than
//     surfacing a status code.
//
// The *Form methods are thin wrappers over the API methods, so both callers
// share exactly one validation path — HQ cannot end up enforcing different
// rules than the site's own editor, which is the main reason to route HQ
// through this service rather than let it write SQL directly.
type LandingContentService struct {
	Repo *repository.LandingContentRepository
}

// NewLandingContentService wraps a LandingContentRepository.
func NewLandingContentService(repo *repository.LandingContentRepository) *LandingContentService {
	return &LandingContentService{Repo: repo}
}

// validationErrors are the sentinels that represent "the caller sent
// something unacceptable" as opposed to an internal fault. The JSON API
// maps these to 422 and the HTML editor renders them inline; anything not
// in this set is logged and never shown to a caller.
var validationErrors = []error{
	ErrHeroEyebrowRequired,
	ErrHeroTitleRequired,
	ErrHeroMessageRequired,
	ErrSlideImagePathRequired,
	ErrSlideAltRequired,
	ErrWorkKickerRequired,
	ErrWorkTitleRequired,
	ErrWorkDescriptionRequired,
	ErrWorkLiveURLRequired,
	ErrReorderInvalid,
}

// IsValidationError reports whether err is one of the curated,
// user-facing validation sentinels above — safe to show a caller
// verbatim, unlike a wrapped database error.
func IsValidationError(err error) bool {
	for _, sentinel := range validationErrors {
		if errors.Is(err, sentinel) {
			return true
		}
	}
	return false
}

// IsNotFoundError reports whether err means "no such row" — mapped to 404
// by the JSON API.
func IsNotFoundError(err error) bool {
	return errors.Is(err, ErrSlideNotFound) || errors.Is(err, ErrWorkItemNotFound)
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

// ---------------------------------------------------------------------------
// API shape — returns models and typed errors. See the type's doc comment.
// ---------------------------------------------------------------------------

// GetHero returns the current hero copy.
func (s *LandingContentService) GetHero(ctx context.Context) (model.HeroContent, error) {
	hero, err := s.Repo.GetHero(ctx)
	if err != nil {
		return model.HeroContent{}, fmt.Errorf("get hero: %w", err)
	}
	return hero, nil
}

// ReplaceHero validates and stores all three hero fields, returning the
// stored (trimmed) values so a caller sees exactly what will render.
func (s *LandingContentService) ReplaceHero(ctx context.Context, eyebrow, title, message string) (model.HeroContent, error) {
	input, err := ValidateHeroInput(eyebrow, title, message)
	if err != nil {
		return model.HeroContent{}, err
	}
	hero := model.HeroContent{Eyebrow: input.Eyebrow, Title: input.Title, Message: input.Message}
	if err := s.Repo.SaveHero(ctx, hero); err != nil {
		return model.HeroContent{}, fmt.Errorf("save hero: %w", err)
	}
	return hero, nil
}

// ListSlides returns every carousel slide in display order.
func (s *LandingContentService) ListSlides(ctx context.Context) ([]model.CarouselSlide, error) {
	slides, err := s.Repo.ListCarouselSlides(ctx)
	if err != nil {
		return nil, fmt.Errorf("list carousel slides: %w", err)
	}
	return slides, nil
}

// GetSlide returns one carousel slide, or ErrSlideNotFound.
func (s *LandingContentService) GetSlide(ctx context.Context, id int64) (model.CarouselSlide, error) {
	slide, err := s.Repo.GetCarouselSlide(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return model.CarouselSlide{}, ErrSlideNotFound
		}
		return model.CarouselSlide{}, fmt.Errorf("get carousel slide: %w", err)
	}
	return slide, nil
}

// CreateSlide validates and appends a carousel slide. Returns
// ErrCarouselFull when the 5-slide cap is already reached
// (docs/features/landing-carousel.md's Business Rules) — enforced here
// rather than in the schema, which is exactly why direct database writes
// could previously exceed it.
func (s *LandingContentService) CreateSlide(ctx context.Context, imagePath, alt, caption, linkURL string, external bool) (model.CarouselSlide, error) {
	input, err := ValidateCarouselSlideInput(imagePath, alt, caption, linkURL, external)
	if err != nil {
		return model.CarouselSlide{}, err
	}

	count, err := s.Repo.CountCarouselSlides(ctx)
	if err != nil {
		return model.CarouselSlide{}, fmt.Errorf("count carousel slides: %w", err)
	}
	if count >= maxCarouselSlides {
		return model.CarouselSlide{}, ErrCarouselFull
	}

	slide, err := s.Repo.CreateCarouselSlide(ctx, model.CarouselSlide{
		ImagePath: input.ImagePath, Alt: input.Alt, Caption: input.Caption, LinkURL: input.LinkURL, External: input.External,
	})
	if err != nil {
		return model.CarouselSlide{}, fmt.Errorf("create carousel slide: %w", err)
	}
	return slide, nil
}

// UpdateSlide validates and updates a slide's content fields. sort_order is
// never written here — see ReorderSlides.
func (s *LandingContentService) UpdateSlide(ctx context.Context, id int64, imagePath, alt, caption, linkURL string, external bool) (model.CarouselSlide, error) {
	input, err := ValidateCarouselSlideInput(imagePath, alt, caption, linkURL, external)
	if err != nil {
		return model.CarouselSlide{}, err
	}
	slide, err := s.Repo.UpdateCarouselSlide(ctx, model.CarouselSlide{
		ID: id, ImagePath: input.ImagePath, Alt: input.Alt, Caption: input.Caption, LinkURL: input.LinkURL, External: input.External,
	})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return model.CarouselSlide{}, ErrSlideNotFound
		}
		return model.CarouselSlide{}, fmt.Errorf("update carousel slide: %w", err)
	}
	return slide, nil
}

// DeleteSlide removes a slide, or returns ErrSlideNotFound.
func (s *LandingContentService) DeleteSlide(ctx context.Context, id int64) error {
	if err := s.Repo.DeleteCarouselSlide(ctx, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrSlideNotFound
		}
		return fmt.Errorf("delete carousel slide: %w", err)
	}
	return nil
}

// ReorderSlides renumbers every slide's display order to match ids, which
// must list every existing slide exactly once (ErrReorderInvalid
// otherwise). Returns the reordered list.
func (s *LandingContentService) ReorderSlides(ctx context.Context, ids []int64) ([]model.CarouselSlide, error) {
	if err := s.Repo.ReorderCarouselSlides(ctx, ids); err != nil {
		if errors.Is(err, repository.ErrReorderIDMismatch) {
			return nil, ErrReorderInvalid
		}
		return nil, fmt.Errorf("reorder carousel slides: %w", err)
	}
	return s.ListSlides(ctx)
}

// ListWorkItems returns every Selected work card in display order.
func (s *LandingContentService) ListWorkItems(ctx context.Context) ([]model.SelectedWorkItem, error) {
	items, err := s.Repo.ListSelectedWorkItems(ctx)
	if err != nil {
		return nil, fmt.Errorf("list selected work items: %w", err)
	}
	return items, nil
}

// GetWorkItem returns one Selected work card, or ErrWorkItemNotFound.
func (s *LandingContentService) GetWorkItem(ctx context.Context, id int64) (model.SelectedWorkItem, error) {
	item, err := s.Repo.GetSelectedWorkItem(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return model.SelectedWorkItem{}, ErrWorkItemNotFound
		}
		return model.SelectedWorkItem{}, fmt.Errorf("get selected work item: %w", err)
	}
	return item, nil
}

// CreateWorkItem validates and appends a Selected work card. Unlike the
// carousel there is no count cap.
func (s *LandingContentService) CreateWorkItem(ctx context.Context, kicker, title, description, liveURL string, external bool) (model.SelectedWorkItem, error) {
	input, err := ValidateWorkItemInput(kicker, title, description, liveURL, external)
	if err != nil {
		return model.SelectedWorkItem{}, err
	}
	item, err := s.Repo.CreateSelectedWorkItem(ctx, model.SelectedWorkItem{
		Kicker: input.Kicker, Title: input.Title, Description: input.Description, LiveURL: input.LiveURL, External: input.External,
	})
	if err != nil {
		return model.SelectedWorkItem{}, fmt.Errorf("create selected work item: %w", err)
	}
	return item, nil
}

// UpdateWorkItem validates and updates a card's content fields.
func (s *LandingContentService) UpdateWorkItem(ctx context.Context, id int64, kicker, title, description, liveURL string, external bool) (model.SelectedWorkItem, error) {
	input, err := ValidateWorkItemInput(kicker, title, description, liveURL, external)
	if err != nil {
		return model.SelectedWorkItem{}, err
	}
	item, err := s.Repo.UpdateSelectedWorkItem(ctx, model.SelectedWorkItem{
		ID: id, Kicker: input.Kicker, Title: input.Title, Description: input.Description, LiveURL: input.LiveURL, External: input.External,
	})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return model.SelectedWorkItem{}, ErrWorkItemNotFound
		}
		return model.SelectedWorkItem{}, fmt.Errorf("update selected work item: %w", err)
	}
	return item, nil
}

// DeleteWorkItem removes a card, or returns ErrWorkItemNotFound.
func (s *LandingContentService) DeleteWorkItem(ctx context.Context, id int64) error {
	if err := s.Repo.DeleteSelectedWorkItem(ctx, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrWorkItemNotFound
		}
		return fmt.Errorf("delete selected work item: %w", err)
	}
	return nil
}

// ReorderWorkItems renumbers every card's display order to match ids. See
// ReorderSlides.
func (s *LandingContentService) ReorderWorkItems(ctx context.Context, ids []int64) ([]model.SelectedWorkItem, error) {
	if err := s.Repo.ReorderSelectedWorkItems(ctx, ids); err != nil {
		if errors.Is(err, repository.ErrReorderIDMismatch) {
			return nil, ErrReorderInvalid
		}
		return nil, fmt.Errorf("reorder selected work items: %w", err)
	}
	return s.ListWorkItems(ctx)
}

// ---------------------------------------------------------------------------
// HTML-editor shape — view-models with inline error strings. Thin wrappers
// over the API methods above; see the type's doc comment.
// ---------------------------------------------------------------------------

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
	hero, err := s.GetHero(ctx)
	if err != nil {
		return HeroFormView{}, err
	}
	return HeroFormView{Eyebrow: hero.Eyebrow, Title: hero.Title, Message: hero.Message}, nil
}

// SaveHeroForm validates and persists a hero-form submission
// (POST /settings/content/hero). A validation failure is reported inline on
// the returned view (Error set, err nil) — only a genuine failure (e.g. a
// DB error) returns a non-nil err, which the caller must not show to the
// client directly.
func (s *LandingContentService) SaveHeroForm(ctx context.Context, eyebrow, title, message string) (HeroFormView, error) {
	if _, err := s.ReplaceHero(ctx, eyebrow, title, message); err != nil {
		if IsValidationError(err) {
			return HeroFormView{Eyebrow: eyebrow, Title: title, Message: message, Error: err.Error()}, nil
		}
		return HeroFormView{}, err
	}
	return s.heroView(ctx)
}

func (s *LandingContentService) carouselView(ctx context.Context) (CarouselEditorView, error) {
	slides, err := s.ListSlides(ctx)
	if err != nil {
		return CarouselEditorView{}, err
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

// CreateSlideForm is CreateSlide's HTML-editor counterpart. ErrCarouselFull
// renders inline here rather than as a 409.
func (s *LandingContentService) CreateSlideForm(ctx context.Context, imagePath, alt, caption, linkURL string, external bool) (CarouselEditorView, error) {
	if _, err := s.CreateSlide(ctx, imagePath, alt, caption, linkURL, external); err != nil {
		if IsValidationError(err) || errors.Is(err, ErrCarouselFull) {
			return s.carouselViewWithError(ctx, err.Error())
		}
		return CarouselEditorView{}, err
	}
	return s.carouselView(ctx)
}

// UpdateSlideForm is UpdateSlide's HTML-editor counterpart.
func (s *LandingContentService) UpdateSlideForm(ctx context.Context, id int64, imagePath, alt, caption, linkURL string, external bool) (CarouselEditorView, error) {
	if _, err := s.UpdateSlide(ctx, id, imagePath, alt, caption, linkURL, external); err != nil {
		if IsValidationError(err) || errors.Is(err, ErrSlideNotFound) {
			return s.carouselViewWithError(ctx, err.Error())
		}
		return CarouselEditorView{}, err
	}
	return s.carouselView(ctx)
}

// DeleteSlideForm is DeleteSlide's HTML-editor counterpart. A slide that's
// already gone is treated as success, not an error: the editor's delete is
// idempotent by design, so a double-clicked or stale delete button
// re-renders the list rather than showing a spurious failure banner. The
// JSON API deliberately does not share that leniency — it answers 404.
func (s *LandingContentService) DeleteSlideForm(ctx context.Context, id int64) (CarouselEditorView, error) {
	if err := s.DeleteSlide(ctx, id); err != nil && !errors.Is(err, ErrSlideNotFound) {
		return CarouselEditorView{}, err
	}
	return s.carouselView(ctx)
}

// MoveSlideForm swaps a slide's display order with its neighbour
// (POST /settings/content/carousel/{id}/move). direction is "up" or
// "down"; anything else is a no-op (see repository.moveSortOrder).
//
// This stays a neighbour swap rather than routing through ReorderSlides:
// it's the editor's existing up/down-button interaction, and the JSON
// API's full-list reorder is a different primitive for a different caller
// (docs/features/landing-content-api.md's Decision 2).
func (s *LandingContentService) MoveSlideForm(ctx context.Context, id int64, direction string) (CarouselEditorView, error) {
	if err := s.Repo.MoveCarouselSlide(ctx, id, direction); err != nil {
		return CarouselEditorView{}, fmt.Errorf("move carousel slide: %w", err)
	}
	return s.carouselView(ctx)
}

func (s *LandingContentService) workView(ctx context.Context) (WorkEditorView, error) {
	items, err := s.ListWorkItems(ctx)
	if err != nil {
		return WorkEditorView{}, err
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

// CreateWorkItemForm is CreateWorkItem's HTML-editor counterpart.
func (s *LandingContentService) CreateWorkItemForm(ctx context.Context, kicker, title, description, liveURL string, external bool) (WorkEditorView, error) {
	if _, err := s.CreateWorkItem(ctx, kicker, title, description, liveURL, external); err != nil {
		if IsValidationError(err) {
			return s.workViewWithError(ctx, err.Error())
		}
		return WorkEditorView{}, err
	}
	return s.workView(ctx)
}

// UpdateWorkItemForm is UpdateWorkItem's HTML-editor counterpart.
func (s *LandingContentService) UpdateWorkItemForm(ctx context.Context, id int64, kicker, title, description, liveURL string, external bool) (WorkEditorView, error) {
	if _, err := s.UpdateWorkItem(ctx, id, kicker, title, description, liveURL, external); err != nil {
		if IsValidationError(err) || errors.Is(err, ErrWorkItemNotFound) {
			return s.workViewWithError(ctx, err.Error())
		}
		return WorkEditorView{}, err
	}
	return s.workView(ctx)
}

// DeleteWorkItemForm is DeleteWorkItem's HTML-editor counterpart. See
// DeleteSlideForm for why an already-deleted card is treated as success.
func (s *LandingContentService) DeleteWorkItemForm(ctx context.Context, id int64) (WorkEditorView, error) {
	if err := s.DeleteWorkItem(ctx, id); err != nil && !errors.Is(err, ErrWorkItemNotFound) {
		return WorkEditorView{}, err
	}
	return s.workView(ctx)
}

// MoveWorkItemForm swaps a card's display order with its neighbour. See
// MoveSlideForm.
func (s *LandingContentService) MoveWorkItemForm(ctx context.Context, id int64, direction string) (WorkEditorView, error) {
	if err := s.Repo.MoveSelectedWorkItem(ctx, id, direction); err != nil {
		return WorkEditorView{}, fmt.Errorf("move selected work item: %w", err)
	}
	return s.workView(ctx)
}
