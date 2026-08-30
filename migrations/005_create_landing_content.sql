-- Schema and a seed of today's hand-authored copy live in one migration,
-- same reasoning as 001_create_and_seed_resume.sql: single-owner site, no
-- per-environment variance, so a second file would only add migration
-- surface. See docs/features/landing-content-authoring.md's Data Model.

-- +goose Up
CREATE TABLE landing_hero (
    id         BIGINT PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- singleton row
    eyebrow    TEXT NOT NULL,
    title      TEXT NOT NULL,
    message    TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE landing_carousel_slides (
    id         BIGSERIAL PRIMARY KEY,
    image_path TEXT NOT NULL,
    alt        TEXT NOT NULL,
    caption    TEXT NOT NULL DEFAULT '',
    link_url   TEXT NOT NULL DEFAULT '',
    external   BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE landing_selected_work_items (
    id          BIGSERIAL PRIMARY KEY,
    kicker      TEXT NOT NULL,
    title       TEXT NOT NULL,
    description TEXT NOT NULL,
    live_url    TEXT NOT NULL DEFAULT '',
    external    BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order  INTEGER NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed: today's hand-authored copy, verbatim (internal/handler/pages.go's
-- former landingCarouselSlides/selectedWorkItems vars, and
-- web/templates/pages/landing.html's hero text) — this migration is a
-- no-op visually until the owner edits something via /settings/content.
INSERT INTO landing_hero (id, eyebrow, title, message) VALUES (
    1,
    'Software Engineer',
    'Hi, I''m Vincent Megia.',
    'I build things with Go, Postgres, and HTMX — practical software with sound engineering behind it. Below is a running log of what I''ve shipped, plus a full résumé if you want the formal version.'
);

INSERT INTO landing_carousel_slides (image_path, alt, caption, link_url, external, sort_order) VALUES
    ('/static/images/carousel/1.svg', 'Illustration of a keyboard', 'Engineering, hands-on — placeholder caption', '', FALSE, 1),
    ('/static/images/carousel/2.svg', 'Illustration of a client/server/database system architecture diagram', 'System design & architecture — placeholder caption', '/projects', FALSE, 2),
    ('/static/images/carousel/3.svg', 'Illustration of a desktop computer workstation', 'Where the work happens — placeholder caption', '', FALSE, 3),
    ('/static/images/carousel/4.svg', 'Illustration of a server rack', 'Infrastructure & backend systems — placeholder caption', 'https://github.com/vincentmegia', TRUE, 4),
    ('/static/images/carousel/5.svg', 'Illustration of a code editor window', 'Code — placeholder caption', '', FALSE, 5);

INSERT INTO landing_selected_work_items (kicker, title, description, live_url, external, sort_order) VALUES
    ('Game', 'Fishing Game', 'A canvas arcade mini-game — cast a line, dive for fish, and dodge hazards on the way down, with a public leaderboard for the best runs.', '/fishing-game', FALSE, 1),
    ('Game', 'Kitchen Shift', 'A top-down restaurant-shift sim — take orders, cook, and close up clean across a 30-shift month, with a public leaderboard for the best months.', '/kitchen-shift', FALSE, 2),
    ('Tool', 'Puzzle Solver', 'A 30×30 pathfinding visualizer — mark a start and end, draw walls, then watch a depth-first search explore the grid and trace the path it finds.', '/puzzle-solver', FALSE, 3);

-- +goose Down
DROP TABLE landing_selected_work_items;
DROP TABLE landing_carousel_slides;
DROP TABLE landing_hero;
