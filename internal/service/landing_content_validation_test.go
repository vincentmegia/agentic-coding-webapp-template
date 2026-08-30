package service

import "testing"

func TestValidateHeroInput(t *testing.T) {
	tests := []struct {
		name                          string
		eyebrow, title, message       string
		wantEyebrow, wantTitle, wantM string
		wantErr                       error
	}{
		{
			name: "valid submission", eyebrow: "Software Engineer", title: "Hi", message: "Body",
			wantEyebrow: "Software Engineer", wantTitle: "Hi", wantM: "Body",
		},
		{
			name: "fields are trimmed", eyebrow: "  Software Engineer  ", title: " Hi ", message: " Body ",
			wantEyebrow: "Software Engineer", wantTitle: "Hi", wantM: "Body",
		},
		{name: "empty eyebrow", eyebrow: "", title: "Hi", message: "Body", wantErr: ErrHeroEyebrowRequired},
		{name: "whitespace-only eyebrow", eyebrow: "   ", title: "Hi", message: "Body", wantErr: ErrHeroEyebrowRequired},
		{name: "empty title", eyebrow: "Software Engineer", title: "", message: "Body", wantErr: ErrHeroTitleRequired},
		{name: "empty message", eyebrow: "Software Engineer", title: "Hi", message: "", wantErr: ErrHeroMessageRequired},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ValidateHeroInput(tt.eyebrow, tt.title, tt.message)
			if tt.wantErr != nil {
				if err != tt.wantErr {
					t.Fatalf("ValidateHeroInput() error = %v, want %v", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("ValidateHeroInput() unexpected error: %v", err)
			}
			if got.Eyebrow != tt.wantEyebrow || got.Title != tt.wantTitle || got.Message != tt.wantM {
				t.Fatalf("ValidateHeroInput() = %+v, want {%q %q %q}", got, tt.wantEyebrow, tt.wantTitle, tt.wantM)
			}
		})
	}
}

func TestValidateCarouselSlideInput(t *testing.T) {
	tests := []struct {
		name                             string
		imagePath, alt, caption, linkURL string
		external                         bool
		want                             CarouselSlideInput
		wantErr                          error
	}{
		{
			name: "valid, minimal", imagePath: "/img.svg", alt: "Alt text",
			want: CarouselSlideInput{ImagePath: "/img.svg", Alt: "Alt text"},
		},
		{
			name: "valid, full", imagePath: " /img.svg ", alt: " Alt ", caption: " Cap ", linkURL: " https://x ", external: true,
			want: CarouselSlideInput{ImagePath: "/img.svg", Alt: "Alt", Caption: "Cap", LinkURL: "https://x", External: true},
		},
		{name: "missing image path", imagePath: "", alt: "Alt", wantErr: ErrSlideImagePathRequired},
		{name: "missing alt", imagePath: "/img.svg", alt: "", wantErr: ErrSlideAltRequired},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ValidateCarouselSlideInput(tt.imagePath, tt.alt, tt.caption, tt.linkURL, tt.external)
			if tt.wantErr != nil {
				if err != tt.wantErr {
					t.Fatalf("ValidateCarouselSlideInput() error = %v, want %v", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("ValidateCarouselSlideInput() unexpected error: %v", err)
			}
			if got != tt.want {
				t.Fatalf("ValidateCarouselSlideInput() = %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestValidateWorkItemInput(t *testing.T) {
	tests := []struct {
		name                                string
		kicker, title, description, liveURL string
		wantErr                             error
	}{
		{name: "valid submission", kicker: "Game", title: "Fishing Game", description: "Desc", liveURL: "/fishing-game"},
		{name: "missing kicker", kicker: "", title: "T", description: "D", liveURL: "/x", wantErr: ErrWorkKickerRequired},
		{name: "missing title", kicker: "Game", title: "", description: "D", liveURL: "/x", wantErr: ErrWorkTitleRequired},
		{name: "missing description", kicker: "Game", title: "T", description: "", liveURL: "/x", wantErr: ErrWorkDescriptionRequired},
		{name: "missing live URL", kicker: "Game", title: "T", description: "D", liveURL: "", wantErr: ErrWorkLiveURLRequired},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := ValidateWorkItemInput(tt.kicker, tt.title, tt.description, tt.liveURL, false)
			if tt.wantErr != nil {
				if err != tt.wantErr {
					t.Fatalf("ValidateWorkItemInput() error = %v, want %v", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("ValidateWorkItemInput() unexpected error: %v", err)
			}
		})
	}
}
