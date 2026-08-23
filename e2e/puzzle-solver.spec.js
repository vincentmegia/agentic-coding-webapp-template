// /puzzle-solver page: a 30x30 canvas grid where the visitor marks a Start
// and End cell, draws walls, then runs an animated DFS solve. See
// docs/features/puzzle-solver.md (User Flow, Business Rules, Testing Plan).
//
// This is the first canvas-game spec in this repo to drive interaction via
// raw grid coordinates rather than fixed HUD buttons (fishing-game.spec.js
// has no canvas-coordinate clicking to mirror) — cell centers are computed
// from #puzzle-canvas's own bounding box (20px cells, 30x30 grid, per the
// doc's Visual Direction) rather than hardcoded pixel offsets, so this
// still works if the canvas is scaled responsively by its aspect-ratio
// wrapper.
const { test, expect } = require('@playwright/test');

// The 600x600 canvas plus the toolbar/status chrome above it doesn't fit
// inside the projects' default viewport, and every click below goes through
// raw page.mouse.click(x, y) at coordinates read from #puzzle-canvas's
// boundingBox() — unlike locator.click(), that never auto-scrolls the
// target into view first, so a cell whose y falls past the default
// viewport's bottom edge would silently miss. A viewport tall/wide enough
// to fit the whole canvas without scrolling sidesteps that instead of
// scrolling mid-test and having to re-read boundingBox() after every scroll.
test.use({ viewport: { width: 1000, height: 1000 } });

// puzzle-solver.js's default per-cell reveal interval is tuned for a
// pleasant real-visitor animation, not a test suite asserting the *end*
// state of a solve — a near-full-grid DFS (e.g. the "fully enclosed End"
// case below, which visits nearly every reachable cell) can otherwise take
// several real seconds and flirt with timeouts on a slower browser/CI
// runner. puzzle-solver.js exposes window.__puzzleSolverTestHooks for
// exactly this, mirroring fishing-game.js's equivalent hook.
async function speedUpSolveAnimation(page) {
	await page.evaluate(() => window.__puzzleSolverTestHooks.setAnimationIntervalMs(0));
}

// Returns the page-space {x, y} center of grid cell (row, col), scaled from
// #puzzle-canvas's actual rendered size (not just its intrinsic
// width/height attributes) so this works whether or not the canvas is
// CSS-scaled by its aspect-ratio wrapper.
async function cellCenter(page, row, col) {
	const box = await page.locator('#puzzle-canvas').boundingBox();
	const cellW = box.width / 30;
	const cellH = box.height / 30;
	return {
		x: box.x + (col + 0.5) * cellW,
		y: box.y + (row + 0.5) * cellH,
	};
}

async function clickCell(page, row, col) {
	const { x, y } = await cellCenter(page, row, col);
	await page.mouse.click(x, y);
}

// Drags from cell (r1, c1) to (r2, c2) in a straight line (same row or same
// column only — enough for every wall shape these tests need), pausing
// briefly at each intermediate cell so the drag genuinely passes over it
// rather than jumping straight from endpoint to endpoint.
async function dragCells(page, cells) {
	const first = await cellCenter(page, cells[0][0], cells[0][1]);
	await page.mouse.move(first.x, first.y);
	await page.mouse.down();
	for (const [row, col] of cells.slice(1)) {
		const { x, y } = await cellCenter(page, row, col);
		await page.mouse.move(x, y);
	}
	await page.mouse.up();
}

async function setStart(page, row, col) {
	await page.locator('#puzzle-tool-start').click();
	await clickCell(page, row, col);
}

async function setEnd(page, row, col) {
	await page.locator('#puzzle-tool-end').click();
	await clickCell(page, row, col);
}

test.describe('/puzzle-solver direct page load', () => {
	test('renders an empty grid with Solve disabled and the initial status hint', async ({ page }) => {
		await page.goto('/puzzle-solver');

		await expect(page.locator('#puzzle-canvas')).toBeVisible();
		await expect(page.locator('#puzzle-solve-button')).toBeDisabled();
		await expect(page.locator('#puzzle-status')).toHaveText(/set a start and end/i);
	});
});

test.describe('placing Start/End', () => {
	test('Solve enables only once both Start and End are set', async ({ page }) => {
		await page.goto('/puzzle-solver');

		await setStart(page, 5, 5);
		await expect(page.locator('#puzzle-solve-button')).toBeDisabled();

		await setEnd(page, 5, 20);
		await expect(page.locator('#puzzle-solve-button')).toBeEnabled();
	});

	test('the active tool button shows aria-pressed=true while selected', async ({ page }) => {
		await page.goto('/puzzle-solver');

		await page.locator('#puzzle-tool-wall').click();
		await expect(page.locator('#puzzle-tool-wall')).toHaveAttribute('aria-pressed', 'true');
		await expect(page.locator('#puzzle-tool-start')).toHaveAttribute('aria-pressed', 'false');

		await page.locator('#puzzle-tool-start').click();
		await expect(page.locator('#puzzle-tool-start')).toHaveAttribute('aria-pressed', 'true');
		await expect(page.locator('#puzzle-tool-wall')).toHaveAttribute('aria-pressed', 'false');
	});
});

test.describe('solving', () => {
	test('a reachable Start/End with a non-blocking wall finds a path', async ({ page }) => {
		await page.goto('/puzzle-solver');
		await speedUpSolveAnimation(page);

		await setStart(page, 5, 5);
		await setEnd(page, 5, 25);

		// A short vertical wall well clear of row 5 (both endpoints' row) —
		// present only to prove wall cells don't break a solve that doesn't
		// need to route through them, not to force a detour.
		await page.locator('#puzzle-tool-wall').click();
		await dragCells(page, [
			[10, 15],
			[11, 15],
			[12, 15],
		]);

		await page.locator('#puzzle-solve-button').click();

		// Grid editing tools lock while the DFS animation runs.
		await expect(page.locator('#puzzle-tool-wall')).toBeDisabled();
		await expect(page.locator('#puzzle-tool-start')).toBeDisabled();
		await expect(page.locator('#puzzle-tool-end')).toBeDisabled();

		await expect(page.locator('#puzzle-status')).toHaveText(/path found/i, { timeout: 10_000 });

		// Locks release once the solve animation finishes.
		await expect(page.locator('#puzzle-tool-wall')).toBeEnabled();
	});

	test('End fully enclosed by walls reports no path found', async ({ page }) => {
		await page.goto('/puzzle-solver');
		await speedUpSolveAnimation(page);

		await setStart(page, 5, 5);
		await setEnd(page, 20, 20);

		// A closed ring of wall cells one cell out from End (20,20) on all
		// four sides seals it off from every orthogonal neighbor, so DFS
		// (orthogonal-only, per the doc's Business Rules) can never reach it
		// regardless of where Start is.
		await page.locator('#puzzle-tool-wall').click();
		const ring = [
			[19, 19], [19, 20], [19, 21],
			[20, 19], [20, 21],
			[21, 19], [21, 20], [21, 21],
		];
		for (const [row, col] of ring) {
			await clickCell(page, row, col);
		}

		await page.locator('#puzzle-solve-button').click();
		await expect(page.locator('#puzzle-status')).toHaveText(/no path found/i, { timeout: 10_000 });
	});
});

test.describe('Reset Grid', () => {
	test('clears Start/End/walls back to the initial empty-grid state', async ({ page }) => {
		await page.goto('/puzzle-solver');

		await setStart(page, 3, 3);
		await setEnd(page, 3, 10);
		await expect(page.locator('#puzzle-solve-button')).toBeEnabled();

		await page.locator('#puzzle-reset-button').click();

		await expect(page.locator('#puzzle-solve-button')).toBeDisabled();
		await expect(page.locator('#puzzle-status')).toHaveText(/set a start and end/i);
	});
});

// Regression test for a real bug: puzzle-solver.js's DOM wiring only ran
// via the bottom-of-file `bootstrap()` call fired once when the module's
// top-level code first executed — but a `<script type="module">`'s
// top-level code runs at most once per resolved URL for the page's whole
// lifetime (per spec). htmx recreates and re-inserts the <script> tag on
// every HTMX navigation, but the browser does not re-execute an
// already-evaluated module, so a *second* visit to /puzzle-solver in the
// same tab (navigate away, then back) left the freshly swapped-in
// #puzzle-canvas completely unwired — a blank, non-interactive grid. Fixed
// by also re-running bootstrap() from a persistent `htmx:afterSwap`
// listener (registered once, during whichever visit is this file's one
// execution, and alive for every later swap since document.body survives
// them all). This test drives the exact real-world path that surfaced it:
// /projects → Play now → back to /projects → Play now again, all via HTMX,
// no full page reload in between.
test.describe('revisiting via HTMX after navigating away', () => {
	test('a second HTMX visit in the same tab still renders and stays fully interactive', async ({ page }) => {
		await page.goto('/projects');
		const playNow = () => page.locator('.project-card').filter({ hasText: 'Puzzle Solver' }).getByRole('link', { name: 'Play now' });
		const projectsLink = () => page.locator('#primary-nav').getByRole('link', { name: 'Projects', exact: true });

		await playNow().click();
		await expect(page.locator('#puzzle-canvas')).toBeVisible();

		await projectsLink().click();
		await expect(page).toHaveURL(/\/projects$/);

		await playNow().click();
		await expect(page.locator('#puzzle-canvas')).toBeVisible();

		// The real bug left the canvas visible but inert — assert actual
		// interactivity on this second-visit instance, not just presence.
		await setStart(page, 5, 5);
		await setEnd(page, 5, 20);
		await expect(page.locator('#puzzle-solve-button')).toBeEnabled();

		await speedUpSolveAnimation(page);
		await page.locator('#puzzle-solve-button').click();
		await expect(page.locator('#puzzle-status')).toHaveText(/path found/i, { timeout: 10_000 });
	});
});

// Testing Plan: no console errors, same pattern as fishing-game.spec.js's
// equivalent check.
test('no console errors on load or after a full place/wall/solve cycle', async ({ page }) => {
	const errors = [];
	page.on('console', (msg) => {
		if (msg.type() === 'error') errors.push(msg.text());
	});
	page.on('pageerror', (err) => errors.push(String(err)));

	await page.goto('/puzzle-solver');
	await setStart(page, 2, 2);
	await setEnd(page, 2, 27);
	await page.locator('#puzzle-solve-button').click();
	await page.waitForTimeout(1000);

	expect(errors).toEqual([]);
});
