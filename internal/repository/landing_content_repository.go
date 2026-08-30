package repository

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/vincentmegia/vincentmegia/internal/model"
)

// LandingContentRepository reads/writes the landing_hero,
// landing_carousel_slides, and landing_selected_work_items tables. See
// docs/features/landing-content-authoring.md's Data Model.
type LandingContentRepository struct {
	DB *sql.DB
}

// NewLandingContentRepository wraps an already-open database handle.
func NewLandingContentRepository(db *sql.DB) *LandingContentRepository {
	return &LandingContentRepository{DB: db}
}

// GetHero fetches the landing_hero singleton row (id = 1).
func (repo *LandingContentRepository) GetHero(ctx context.Context) (model.HeroContent, error) {
	const query = `SELECT eyebrow, title, message FROM landing_hero WHERE id = 1`

	var h model.HeroContent
	if err := repo.DB.QueryRowContext(ctx, query).Scan(&h.Eyebrow, &h.Title, &h.Message); err != nil {
		return model.HeroContent{}, fmt.Errorf("query landing_hero: %w", err)
	}
	return h, nil
}

// SaveHero updates the landing_hero singleton row (id = 1).
func (repo *LandingContentRepository) SaveHero(ctx context.Context, h model.HeroContent) error {
	const query = `
		UPDATE landing_hero
		SET eyebrow = $1, title = $2, message = $3, updated_at = NOW()
		WHERE id = 1`

	if _, err := repo.DB.ExecContext(ctx, query, h.Eyebrow, h.Title, h.Message); err != nil {
		return fmt.Errorf("update landing_hero: %w", err)
	}
	return nil
}

// ListCarouselSlides fetches every landing_carousel_slides row, in display order.
func (repo *LandingContentRepository) ListCarouselSlides(ctx context.Context) ([]model.CarouselSlide, error) {
	const query = `
		SELECT id, image_path, alt, caption, link_url, external, sort_order
		FROM landing_carousel_slides
		ORDER BY sort_order`

	rows, err := repo.DB.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("query landing_carousel_slides: %w", err)
	}
	defer rows.Close()

	var slides []model.CarouselSlide
	for rows.Next() {
		var s model.CarouselSlide
		if err := rows.Scan(&s.ID, &s.ImagePath, &s.Alt, &s.Caption, &s.LinkURL, &s.External, &s.SortOrder); err != nil {
			return nil, fmt.Errorf("scan landing_carousel_slides row: %w", err)
		}
		slides = append(slides, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate landing_carousel_slides: %w", err)
	}
	return slides, nil
}

// CountCarouselSlides reports how many carousel slides currently exist, so
// the service layer can enforce the 5-slide cap
// (docs/features/landing-carousel.md's Business Rules) before inserting.
func (repo *LandingContentRepository) CountCarouselSlides(ctx context.Context) (int, error) {
	const query = `SELECT COUNT(*) FROM landing_carousel_slides`

	var count int
	if err := repo.DB.QueryRowContext(ctx, query).Scan(&count); err != nil {
		return 0, fmt.Errorf("count landing_carousel_slides: %w", err)
	}
	return count, nil
}

// CreateCarouselSlide inserts a new slide at the end of the display order.
func (repo *LandingContentRepository) CreateCarouselSlide(ctx context.Context, s model.CarouselSlide) error {
	const query = `
		INSERT INTO landing_carousel_slides (image_path, alt, caption, link_url, external, sort_order)
		VALUES ($1, $2, $3, $4, $5, COALESCE((SELECT MAX(sort_order) FROM landing_carousel_slides), 0) + 1)`

	if _, err := repo.DB.ExecContext(ctx, query, s.ImagePath, s.Alt, s.Caption, s.LinkURL, s.External); err != nil {
		return fmt.Errorf("insert landing_carousel_slides: %w", err)
	}
	return nil
}

// UpdateCarouselSlide updates a slide's content fields by ID. SortOrder is
// left untouched — it only changes via MoveCarouselSlide.
func (repo *LandingContentRepository) UpdateCarouselSlide(ctx context.Context, s model.CarouselSlide) error {
	const query = `
		UPDATE landing_carousel_slides
		SET image_path = $1, alt = $2, caption = $3, link_url = $4, external = $5
		WHERE id = $6`

	if _, err := repo.DB.ExecContext(ctx, query, s.ImagePath, s.Alt, s.Caption, s.LinkURL, s.External, s.ID); err != nil {
		return fmt.Errorf("update landing_carousel_slides: %w", err)
	}
	return nil
}

// DeleteCarouselSlide removes a slide by ID.
func (repo *LandingContentRepository) DeleteCarouselSlide(ctx context.Context, id int64) error {
	const query = `DELETE FROM landing_carousel_slides WHERE id = $1`

	if _, err := repo.DB.ExecContext(ctx, query, id); err != nil {
		return fmt.Errorf("delete landing_carousel_slides: %w", err)
	}
	return nil
}

// MoveCarouselSlide swaps a slide's sort_order with its immediate
// neighbor ("up" = the previous slide, "down" = the next slide). A no-op
// (not an error) when the slide is already at that end of the order — see
// moveSortOrder's doc comment for the shared swap logic, reused by
// MoveSelectedWorkItem below.
func (repo *LandingContentRepository) MoveCarouselSlide(ctx context.Context, id int64, direction string) error {
	return moveSortOrder(ctx, repo.DB, "landing_carousel_slides", id, direction)
}

// ListSelectedWorkItems fetches every landing_selected_work_items row, in
// display order.
func (repo *LandingContentRepository) ListSelectedWorkItems(ctx context.Context) ([]model.SelectedWorkItem, error) {
	const query = `
		SELECT id, kicker, title, description, live_url, external, sort_order
		FROM landing_selected_work_items
		ORDER BY sort_order`

	rows, err := repo.DB.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("query landing_selected_work_items: %w", err)
	}
	defer rows.Close()

	var items []model.SelectedWorkItem
	for rows.Next() {
		var it model.SelectedWorkItem
		if err := rows.Scan(&it.ID, &it.Kicker, &it.Title, &it.Description, &it.LiveURL, &it.External, &it.SortOrder); err != nil {
			return nil, fmt.Errorf("scan landing_selected_work_items row: %w", err)
		}
		items = append(items, it)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate landing_selected_work_items: %w", err)
	}
	return items, nil
}

// CreateSelectedWorkItem inserts a new card at the end of the display order.
func (repo *LandingContentRepository) CreateSelectedWorkItem(ctx context.Context, it model.SelectedWorkItem) error {
	const query = `
		INSERT INTO landing_selected_work_items (kicker, title, description, live_url, external, sort_order)
		VALUES ($1, $2, $3, $4, $5, COALESCE((SELECT MAX(sort_order) FROM landing_selected_work_items), 0) + 1)`

	if _, err := repo.DB.ExecContext(ctx, query, it.Kicker, it.Title, it.Description, it.LiveURL, it.External); err != nil {
		return fmt.Errorf("insert landing_selected_work_items: %w", err)
	}
	return nil
}

// UpdateSelectedWorkItem updates a card's content fields by ID. SortOrder
// is left untouched — it only changes via MoveSelectedWorkItem.
func (repo *LandingContentRepository) UpdateSelectedWorkItem(ctx context.Context, it model.SelectedWorkItem) error {
	const query = `
		UPDATE landing_selected_work_items
		SET kicker = $1, title = $2, description = $3, live_url = $4, external = $5
		WHERE id = $6`

	if _, err := repo.DB.ExecContext(ctx, query, it.Kicker, it.Title, it.Description, it.LiveURL, it.External, it.ID); err != nil {
		return fmt.Errorf("update landing_selected_work_items: %w", err)
	}
	return nil
}

// DeleteSelectedWorkItem removes a card by ID.
func (repo *LandingContentRepository) DeleteSelectedWorkItem(ctx context.Context, id int64) error {
	const query = `DELETE FROM landing_selected_work_items WHERE id = $1`

	if _, err := repo.DB.ExecContext(ctx, query, id); err != nil {
		return fmt.Errorf("delete landing_selected_work_items: %w", err)
	}
	return nil
}

// MoveSelectedWorkItem swaps a card's sort_order with its immediate
// neighbor. See MoveCarouselSlide's doc comment.
func (repo *LandingContentRepository) MoveSelectedWorkItem(ctx context.Context, id int64, direction string) error {
	return moveSortOrder(ctx, repo.DB, "landing_selected_work_items", id, direction)
}

// moveSortOrder swaps a row's sort_order with its immediate neighbor
// ("up" = the row with the next-lower sort_order, "down" = the row with
// the next-higher sort_order) within a transaction, so a crash between
// the two UPDATEs can never leave two rows sharing the same sort_order.
// table is always one of the two Go source constants passed by
// MoveCarouselSlide/MoveSelectedWorkItem above, never caller/DB-sourced
// input, so building the query by string concatenation here is safe. A
// direction other than "up"/"down", or an id already at that end of the
// order, is a no-op rather than an error — the caller doesn't need to
// special-case the boundary.
func moveSortOrder(ctx context.Context, db *sql.DB, table string, id int64, direction string) error {
	var comparator, order string
	switch direction {
	case "up":
		comparator, order = "<", "DESC"
	case "down":
		comparator, order = ">", "ASC"
	default:
		return nil
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin transaction: %w", err)
	}
	defer tx.Rollback()

	var currentOrder int
	if err := tx.QueryRowContext(ctx, fmt.Sprintf(`SELECT sort_order FROM %s WHERE id = $1`, table), id).Scan(&currentOrder); err != nil {
		if err == sql.ErrNoRows {
			return nil
		}
		return fmt.Errorf("query %s sort_order: %w", table, err)
	}

	var neighborID, neighborOrder int64
	query := fmt.Sprintf(
		`SELECT id, sort_order FROM %s WHERE sort_order %s $1 ORDER BY sort_order %s LIMIT 1`,
		table, comparator, order,
	)
	if err := tx.QueryRowContext(ctx, query, currentOrder).Scan(&neighborID, &neighborOrder); err != nil {
		if err == sql.ErrNoRows {
			return nil // already at this end of the order
		}
		return fmt.Errorf("query %s neighbor: %w", table, err)
	}

	if _, err := tx.ExecContext(ctx, fmt.Sprintf(`UPDATE %s SET sort_order = $1 WHERE id = $2`, table), neighborOrder, id); err != nil {
		return fmt.Errorf("update %s sort_order: %w", table, err)
	}
	if _, err := tx.ExecContext(ctx, fmt.Sprintf(`UPDATE %s SET sort_order = $1 WHERE id = $2`, table), currentOrder, neighborID); err != nil {
		return fmt.Errorf("update %s neighbor sort_order: %w", table, err)
	}

	return tx.Commit()
}
