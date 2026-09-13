package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/vincentmegia/vincentmegia/internal/model"
)

// LandingContentRepository reads/writes the landing_hero,
// landing_carousel_slides, and landing_selected_work_items tables. See
// docs/features/landing-content-authoring.md's Data Model.
//
// DB and ReadDB are separate handles, same split and reasoning as
// ResumeRepository's own doc comment (docs/features/resume.md's Security
// Considerations): writes use DB, pure reads use ReadDB.
type LandingContentRepository struct {
	DB     *sql.DB
	ReadDB *sql.DB
}

// NewLandingContentRepository wraps two already-open database handles —
// db for writes, readDB for reads.
func NewLandingContentRepository(db, readDB *sql.DB) *LandingContentRepository {
	return &LandingContentRepository{DB: db, ReadDB: readDB}
}

// GetHero fetches the landing_hero singleton row (id = 1). Read-only —
// uses ReadDB.
func (repo *LandingContentRepository) GetHero(ctx context.Context) (model.HeroContent, error) {
	const query = `SELECT eyebrow, title, message FROM landing_hero WHERE id = 1`

	var h model.HeroContent
	if err := repo.ReadDB.QueryRowContext(ctx, query).Scan(&h.Eyebrow, &h.Title, &h.Message); err != nil {
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

// ListCarouselSlides fetches every landing_carousel_slides row, in display
// order. Read-only — uses ReadDB.
func (repo *LandingContentRepository) ListCarouselSlides(ctx context.Context) ([]model.CarouselSlide, error) {
	const query = `
		SELECT id, image_path, alt, caption, link_url, external, sort_order
		FROM landing_carousel_slides
		ORDER BY sort_order`

	rows, err := repo.ReadDB.QueryContext(ctx, query)
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
// Read-only — uses ReadDB (the pre-insert count check was never
// transactionally coupled to the insert itself, so reading it from a
// separate connection changes nothing about that existing race window).
func (repo *LandingContentRepository) CountCarouselSlides(ctx context.Context) (int, error) {
	const query = `SELECT COUNT(*) FROM landing_carousel_slides`

	var count int
	if err := repo.ReadDB.QueryRowContext(ctx, query).Scan(&count); err != nil {
		return 0, fmt.Errorf("count landing_carousel_slides: %w", err)
	}
	return count, nil
}

// GetCarouselSlide fetches one slide by ID. Returns a wrapped
// sql.ErrNoRows when the slide doesn't exist — see this file's
// "not-found convention" note on DeleteCarouselSlide. Read-only — uses
// ReadDB.
func (repo *LandingContentRepository) GetCarouselSlide(ctx context.Context, id int64) (model.CarouselSlide, error) {
	const query = `
		SELECT id, image_path, alt, caption, link_url, external, sort_order
		FROM landing_carousel_slides
		WHERE id = $1`

	var s model.CarouselSlide
	err := repo.ReadDB.QueryRowContext(ctx, query, id).
		Scan(&s.ID, &s.ImagePath, &s.Alt, &s.Caption, &s.LinkURL, &s.External, &s.SortOrder)
	if err != nil {
		return model.CarouselSlide{}, fmt.Errorf("query landing_carousel_slides id %d: %w", id, err)
	}
	return s, nil
}

// CreateCarouselSlide inserts a new slide at the end of the display order
// and returns it, including the assigned ID and sort_order — the JSON API
// needs both for its 201 response and Location header
// (docs/features/landing-content-api.md).
func (repo *LandingContentRepository) CreateCarouselSlide(ctx context.Context, s model.CarouselSlide) (model.CarouselSlide, error) {
	const query = `
		INSERT INTO landing_carousel_slides (image_path, alt, caption, link_url, external, sort_order)
		VALUES ($1, $2, $3, $4, $5, COALESCE((SELECT MAX(sort_order) FROM landing_carousel_slides), 0) + 1)
		RETURNING id, image_path, alt, caption, link_url, external, sort_order`

	var out model.CarouselSlide
	err := repo.DB.QueryRowContext(ctx, query, s.ImagePath, s.Alt, s.Caption, s.LinkURL, s.External).
		Scan(&out.ID, &out.ImagePath, &out.Alt, &out.Caption, &out.LinkURL, &out.External, &out.SortOrder)
	if err != nil {
		return model.CarouselSlide{}, fmt.Errorf("insert landing_carousel_slides: %w", err)
	}
	return out, nil
}

// UpdateCarouselSlide updates a slide's content fields by ID and returns
// the stored row. SortOrder is left untouched — it changes only via
// MoveCarouselSlide or ReorderCarouselSlides. Returns a wrapped
// sql.ErrNoRows when the slide doesn't exist (RETURNING yields no row).
func (repo *LandingContentRepository) UpdateCarouselSlide(ctx context.Context, s model.CarouselSlide) (model.CarouselSlide, error) {
	const query = `
		UPDATE landing_carousel_slides
		SET image_path = $1, alt = $2, caption = $3, link_url = $4, external = $5
		WHERE id = $6
		RETURNING id, image_path, alt, caption, link_url, external, sort_order`

	var out model.CarouselSlide
	err := repo.DB.QueryRowContext(ctx, query, s.ImagePath, s.Alt, s.Caption, s.LinkURL, s.External, s.ID).
		Scan(&out.ID, &out.ImagePath, &out.Alt, &out.Caption, &out.LinkURL, &out.External, &out.SortOrder)
	if err != nil {
		return model.CarouselSlide{}, fmt.Errorf("update landing_carousel_slides id %d: %w", s.ID, err)
	}
	return out, nil
}

// DeleteCarouselSlide removes a slide by ID.
//
// Not-found convention (shared by every by-ID method in this file):
// deleting a row that isn't there returns a wrapped sql.ErrNoRows rather
// than succeeding silently, so the JSON API can answer 404
// (docs/features/landing-content-api.md's Error Handling). Callers that
// genuinely want idempotent deletes — the site's own HTML editor, where a
// double-clicked delete should not surface an error banner — swallow that
// specific error themselves; see LandingContentService.DeleteSlide.
func (repo *LandingContentRepository) DeleteCarouselSlide(ctx context.Context, id int64) error {
	const query = `DELETE FROM landing_carousel_slides WHERE id = $1`

	res, err := repo.DB.ExecContext(ctx, query, id)
	if err != nil {
		return fmt.Errorf("delete landing_carousel_slides: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("delete landing_carousel_slides rows affected: %w", err)
	}
	if affected == 0 {
		return fmt.Errorf("delete landing_carousel_slides id %d: %w", id, sql.ErrNoRows)
	}
	return nil
}

// ReorderCarouselSlides renumbers every slide's sort_order to 1..n in the
// order given. ids must list every existing slide exactly once — see
// reorderRows, which enforces that and does the whole renumber in one
// transaction.
func (repo *LandingContentRepository) ReorderCarouselSlides(ctx context.Context, ids []int64) error {
	return reorderRows(ctx, repo.DB, "landing_carousel_slides", ids)
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
// display order. Read-only — uses ReadDB.
func (repo *LandingContentRepository) ListSelectedWorkItems(ctx context.Context) ([]model.SelectedWorkItem, error) {
	const query = `
		SELECT id, kicker, title, description, live_url, external, sort_order
		FROM landing_selected_work_items
		ORDER BY sort_order`

	rows, err := repo.ReadDB.QueryContext(ctx, query)
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

// GetSelectedWorkItem fetches one card by ID. See GetCarouselSlide — same
// not-found convention. Read-only — uses ReadDB.
func (repo *LandingContentRepository) GetSelectedWorkItem(ctx context.Context, id int64) (model.SelectedWorkItem, error) {
	const query = `
		SELECT id, kicker, title, description, live_url, external, sort_order
		FROM landing_selected_work_items
		WHERE id = $1`

	var it model.SelectedWorkItem
	err := repo.ReadDB.QueryRowContext(ctx, query, id).
		Scan(&it.ID, &it.Kicker, &it.Title, &it.Description, &it.LiveURL, &it.External, &it.SortOrder)
	if err != nil {
		return model.SelectedWorkItem{}, fmt.Errorf("query landing_selected_work_items id %d: %w", id, err)
	}
	return it, nil
}

// CreateSelectedWorkItem inserts a new card at the end of the display
// order and returns it. See CreateCarouselSlide for why it returns the row.
func (repo *LandingContentRepository) CreateSelectedWorkItem(ctx context.Context, it model.SelectedWorkItem) (model.SelectedWorkItem, error) {
	const query = `
		INSERT INTO landing_selected_work_items (kicker, title, description, live_url, external, sort_order)
		VALUES ($1, $2, $3, $4, $5, COALESCE((SELECT MAX(sort_order) FROM landing_selected_work_items), 0) + 1)
		RETURNING id, kicker, title, description, live_url, external, sort_order`

	var out model.SelectedWorkItem
	err := repo.DB.QueryRowContext(ctx, query, it.Kicker, it.Title, it.Description, it.LiveURL, it.External).
		Scan(&out.ID, &out.Kicker, &out.Title, &out.Description, &out.LiveURL, &out.External, &out.SortOrder)
	if err != nil {
		return model.SelectedWorkItem{}, fmt.Errorf("insert landing_selected_work_items: %w", err)
	}
	return out, nil
}

// UpdateSelectedWorkItem updates a card's content fields by ID and returns
// the stored row. SortOrder is left untouched — it changes only via
// MoveSelectedWorkItem or ReorderSelectedWorkItems.
func (repo *LandingContentRepository) UpdateSelectedWorkItem(ctx context.Context, it model.SelectedWorkItem) (model.SelectedWorkItem, error) {
	const query = `
		UPDATE landing_selected_work_items
		SET kicker = $1, title = $2, description = $3, live_url = $4, external = $5
		WHERE id = $6
		RETURNING id, kicker, title, description, live_url, external, sort_order`

	var out model.SelectedWorkItem
	err := repo.DB.QueryRowContext(ctx, query, it.Kicker, it.Title, it.Description, it.LiveURL, it.External, it.ID).
		Scan(&out.ID, &out.Kicker, &out.Title, &out.Description, &out.LiveURL, &out.External, &out.SortOrder)
	if err != nil {
		return model.SelectedWorkItem{}, fmt.Errorf("update landing_selected_work_items id %d: %w", it.ID, err)
	}
	return out, nil
}

// DeleteSelectedWorkItem removes a card by ID. See DeleteCarouselSlide's
// not-found convention note.
func (repo *LandingContentRepository) DeleteSelectedWorkItem(ctx context.Context, id int64) error {
	const query = `DELETE FROM landing_selected_work_items WHERE id = $1`

	res, err := repo.DB.ExecContext(ctx, query, id)
	if err != nil {
		return fmt.Errorf("delete landing_selected_work_items: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("delete landing_selected_work_items rows affected: %w", err)
	}
	if affected == 0 {
		return fmt.Errorf("delete landing_selected_work_items id %d: %w", id, sql.ErrNoRows)
	}
	return nil
}

// ReorderSelectedWorkItems renumbers every card's sort_order to 1..n in
// the order given. See ReorderCarouselSlides.
func (repo *LandingContentRepository) ReorderSelectedWorkItems(ctx context.Context, ids []int64) error {
	return reorderRows(ctx, repo.DB, "landing_selected_work_items", ids)
}

// MoveSelectedWorkItem swaps a card's sort_order with its immediate
// neighbor. See MoveCarouselSlide's doc comment.
func (repo *LandingContentRepository) MoveSelectedWorkItem(ctx context.Context, id int64, direction string) error {
	return moveSortOrder(ctx, repo.DB, "landing_selected_work_items", id, direction)
}

// ErrReorderIDMismatch is returned by reorderRows when the supplied ID
// list is not exactly the set of IDs currently in the table — a partial
// list, a duplicate, or an unknown ID. Reordering a subset is rejected
// outright rather than applied, since a partial renumber would silently
// collide with the sort_order values it left alone
// (docs/features/landing-content-api.md's Reorder section).
var ErrReorderIDMismatch = errors.New("reorder id list must contain every existing id exactly once")

// reorderRows renumbers table's sort_order to 1..n following ids, in one
// transaction. table is always a Go source constant passed by
// ReorderCarouselSlides/ReorderSelectedWorkItems above, never caller- or
// DB-sourced input, so building the query by string concatenation here is
// safe (same reasoning as moveSortOrder below).
//
// The whole point of taking a full ordered list rather than a per-row
// sort_order write is that this can validate the set before touching
// anything: an ID list that doesn't exactly match what's in the table is
// ErrReorderIDMismatch and nothing is written.
func reorderRows(ctx context.Context, db *sql.DB, table string, ids []int64) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin transaction: %w", err)
	}
	defer tx.Rollback()

	// Lock the rows for the duration so a concurrent insert/delete can't
	// invalidate the set check between here and the updates below.
	rows, err := tx.QueryContext(ctx, fmt.Sprintf(`SELECT id FROM %s FOR UPDATE`, table))
	if err != nil {
		return fmt.Errorf("query %s ids: %w", table, err)
	}
	existing := make(map[int64]bool)
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return fmt.Errorf("scan %s id: %w", table, err)
		}
		existing[id] = true
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("iterate %s ids: %w", table, err)
	}
	rows.Close()

	if len(ids) != len(existing) {
		return ErrReorderIDMismatch
	}
	seen := make(map[int64]bool, len(ids))
	for _, id := range ids {
		if !existing[id] || seen[id] {
			return ErrReorderIDMismatch
		}
		seen[id] = true
	}

	stmt := fmt.Sprintf(`UPDATE %s SET sort_order = $1 WHERE id = $2`, table)
	for i, id := range ids {
		if _, err := tx.ExecContext(ctx, stmt, i+1, id); err != nil {
			return fmt.Errorf("update %s sort_order for id %d: %w", table, id, err)
		}
	}

	return tx.Commit()
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
