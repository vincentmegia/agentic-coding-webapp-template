package service

import (
	"errors"
	"strings"
)

// maxCarouselSlides mirrors docs/features/landing-carousel.md's existing
// cap ("up to 5 slides") — content authoring must not let the owner
// exceed it.
const maxCarouselSlides = 5

var (
	ErrHeroEyebrowRequired = errors.New("eyebrow is required")
	ErrHeroTitleRequired   = errors.New("title is required")
	ErrHeroMessageRequired = errors.New("message is required")

	ErrSlideImagePathRequired = errors.New("image path is required")
	ErrSlideAltRequired       = errors.New("alt text is required")
	ErrCarouselFull           = errors.New("the carousel is limited to 5 slides")

	ErrWorkKickerRequired      = errors.New("kicker is required")
	ErrWorkTitleRequired       = errors.New("title is required")
	ErrWorkDescriptionRequired = errors.New("description is required")
	ErrWorkLiveURLRequired     = errors.New("live URL is required")
)

// HeroInput is a trimmed, validated landing_hero submission.
type HeroInput struct {
	Eyebrow string
	Title   string
	Message string
}

// ValidateHeroInput trims and validates a hero-form submission
// (POST /settings/content/hero). All three fields are required, per
// docs/features/landing-content-authoring.md's Business Rules.
func ValidateHeroInput(eyebrow, title, message string) (HeroInput, error) {
	in := HeroInput{
		Eyebrow: strings.TrimSpace(eyebrow),
		Title:   strings.TrimSpace(title),
		Message: strings.TrimSpace(message),
	}
	if in.Eyebrow == "" {
		return HeroInput{}, ErrHeroEyebrowRequired
	}
	if in.Title == "" {
		return HeroInput{}, ErrHeroTitleRequired
	}
	if in.Message == "" {
		return HeroInput{}, ErrHeroMessageRequired
	}
	return in, nil
}

// CarouselSlideInput is a trimmed, validated carousel-slide submission.
type CarouselSlideInput struct {
	ImagePath string
	Alt       string
	Caption   string
	LinkURL   string
	External  bool
}

// ValidateCarouselSlideInput trims and validates a carousel-slide
// submission (POST/PUT /settings/content/carousel[/{id}]). ImagePath and
// Alt are required; Caption and LinkURL stay optional — mirrors
// model.CarouselSlide's existing shape.
func ValidateCarouselSlideInput(imagePath, alt, caption, linkURL string, external bool) (CarouselSlideInput, error) {
	in := CarouselSlideInput{
		ImagePath: strings.TrimSpace(imagePath),
		Alt:       strings.TrimSpace(alt),
		Caption:   strings.TrimSpace(caption),
		LinkURL:   strings.TrimSpace(linkURL),
		External:  external,
	}
	if in.ImagePath == "" {
		return CarouselSlideInput{}, ErrSlideImagePathRequired
	}
	if in.Alt == "" {
		return CarouselSlideInput{}, ErrSlideAltRequired
	}
	return in, nil
}

// WorkItemInput is a trimmed, validated Selected-work-card submission.
type WorkItemInput struct {
	Kicker      string
	Title       string
	Description string
	LiveURL     string
	External    bool
}

// ValidateWorkItemInput trims and validates a Selected-work-card
// submission (POST/PUT /settings/content/selected-work[/{id}]). Kicker,
// Title, Description, and LiveURL are all required.
func ValidateWorkItemInput(kicker, title, description, liveURL string, external bool) (WorkItemInput, error) {
	in := WorkItemInput{
		Kicker:      strings.TrimSpace(kicker),
		Title:       strings.TrimSpace(title),
		Description: strings.TrimSpace(description),
		LiveURL:     strings.TrimSpace(liveURL),
		External:    external,
	}
	if in.Kicker == "" {
		return WorkItemInput{}, ErrWorkKickerRequired
	}
	if in.Title == "" {
		return WorkItemInput{}, ErrWorkTitleRequired
	}
	if in.Description == "" {
		return WorkItemInput{}, ErrWorkDescriptionRequired
	}
	if in.LiveURL == "" {
		return WorkItemInput{}, ErrWorkLiveURLRequired
	}
	return in, nil
}
