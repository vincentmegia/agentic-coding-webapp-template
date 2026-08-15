// /projects page: heading + subhead, and a grid of project cards
// (internal/handler/pages.go's projectItems). The Fishing Game card is real
// (this site's own shipped mini-game, linked via an internal "Play now" HTMX
// nav link) — the pulled-in design mockup's four fictional sample cards
// (Fieldnotes/Tidewatch/Loom UI/Nightlight, from a claude.ai/design
// "Personal website and portfolio" project's Projects.dc.html) were removed
// once a real project existed, so it's currently the grid's only entry. See
// web/templates/pages/projects.html and internal/handler/template.go's
// Project struct for the full contract.
const { test, expect } = require('@playwright/test');

const PROJECTS = [
	{
		title: 'Fishing Game',
		description: 'A canvas arcade mini-game — cast a line, dive for fish, and dodge hazards on the way down, with a public leaderboard for the best runs.',
		tags: ['Go', 'Canvas', 'PostgreSQL'],
	},
];

test('direct page load renders heading, subhead, and all project cards', async ({ page }) => {
	await page.goto('/projects');

	await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
	// Subhead copy contains a curly apostrophe/em dash (&rsquo;/&mdash;) — only
	// asserting the plain-ASCII tail avoids coupling this test to exact
	// unicode punctuation.
	await expect(page.locator('#main-content')).toContainText('still growing');

	const cards = page.locator('.project-card');
	await expect(cards).toHaveCount(PROJECTS.length);

	for (const project of PROJECTS) {
		const card = cards.filter({ hasText: project.title });
		await expect(card.getByRole('heading', { name: project.title, level: 3 })).toBeVisible();
		await expect(card).toContainText(project.description);
		for (const tag of project.tags) {
			await expect(card).toContainText(tag);
		}
	}
});

// The only project (internal/handler/pages.go's projectItems) doesn't set
// External: true, so projects.html's `{{if .External}}` "Live demo" branch
// never renders — the Fishing Game's LiveURL instead takes the `{{else}}`
// "Play now" branch (tested separately below). Asserting the absence of
// "Live demo" (rather than no test at all) still guards the conditional
// itself — a future regression that renders it unconditionally would be
// caught here.
test('no "Live demo" link renders — the only project doesn\'t set External: true', async ({ page }) => {
	await page.goto('/projects');
	await expect(page.getByRole('link', { name: 'Live demo' })).toHaveCount(0);
});

// The Fishing Game card is the one project with a LiveURL (External: false,
// the default), so it alone gets projects.html's `{{else}}` "Play now"
// branch instead of "Live demo".
test('the Fishing Game card has a "Play now" link', async ({ page }) => {
	await page.goto('/projects');
	const card = page.locator('.project-card').filter({ hasText: 'Fishing Game' });
	await expect(card.getByRole('link', { name: 'Play now' })).toBeVisible();
	await expect(card.getByRole('link', { name: 'Live demo' })).toHaveCount(0);
});

test('marks the Projects link as aria-current when on this page', async ({ page }) => {
	await page.goto('/projects');
	const nav = page.locator('#primary-nav');

	await expect(nav.getByRole('link', { name: 'Projects', exact: true })).toHaveAttribute('aria-current', 'page');
	await expect(nav.getByRole('link', { name: 'Home', exact: true })).not.toHaveAttribute('aria-current', 'page');
});

// Regression test for a real, previously-shipped bug: hx-swap="outerHTML"
// (home.md's HTMX Interactions) replaces the *entire* #main-content element
// with the server's fragment response. Every content template used to
// render only its inner content, not its own <main id="main-content">
// wrapper — so navigating via the nav (as opposed to a direct page load,
// which base.html always wrapped correctly) destroyed #main-content's own
// mx-auto/max-w-5xl/padding classes, leaving the new page full-bleed with no
// container. See e2e/nav.spec.js's identically-named describe block for the
// full story and the pattern this follows exactly, applied here to
// /projects specifically.
test.describe('container survives an HTMX nav swap (not just a direct page load)', () => {
	test("navigating to /projects via the header nav keeps #main-content's container classes", async ({ page }) => {
		await page.goto('/');
		const before = await page.locator('#main-content').boundingBox();

		await page.locator('#primary-nav').getByRole('link', { name: 'Projects', exact: true }).click();
		await page.waitForLoadState('networkidle');

		const main = page.locator('#main-content');
		await expect(main).toHaveCount(1); // outerHTML swap must not duplicate or drop it
		await expect(main).toHaveClass(/mx-auto/);
		await expect(main).toHaveClass(/max-w-5xl/);

		const after = await main.boundingBox();
		// A full-bleed regression would make the post-swap container as wide
		// as the viewport; the pre-swap (correctly full-page-rendered)
		// container is the known-good width to compare against.
		expect(after.width).toBeLessThanOrEqual(before.width + 2);
	});
});

// Regression coverage for the Fishing Game card's "Play now" link
// specifically: it's a same-tab internal nav link using the same
// hx-get/hx-target="#main-content"/hx-swap="outerHTML"/hx-push-url pattern
// as #primary-nav's own links (components/header.html), not a plain <a
// href> full-page navigation. Follows the exact "container survives an HTMX
// nav swap" pattern from the describe block above, applied to this click
// instead of a header-nav click, plus the extra checks called out in
// docs/features/projects.md's Testing Plan: the real /fishing-game game
// shell renders, and web/static/js/nav-menu.js's
// updateActiveNavLinks() (which re-runs on every htmx:afterSwap) correctly
// leaves every #primary-nav link non-current, since /fishing-game isn't
// Home/Projects/About.
test.describe('the Fishing Game card\'s "Play now" link', () => {
	test('navigates to /fishing-game via HTMX, renders the real game shell, and clears nav aria-current', async ({ page }) => {
		await page.goto('/projects');
		const before = await page.locator('#main-content').boundingBox();

		await page.locator('.project-card').filter({ hasText: 'Fishing Game' }).getByRole('link', { name: 'Play now' }).click();
		await page.waitForLoadState('networkidle');

		await expect(page).toHaveURL(/\/fishing-game$/);
		await expect(page.locator('#fishing-canvas')).toBeVisible();
		await expect(page.locator('#fishing-start-screen')).toBeVisible();

		const main = page.locator('#main-content');
		await expect(main).toHaveCount(1); // outerHTML swap must not duplicate or drop it
		await expect(main).toHaveClass(/mx-auto/);
		await expect(main).toHaveClass(/max-w-5xl/);

		const after = await main.boundingBox();
		// A full-bleed regression would make the post-swap container as wide
		// as the viewport; the pre-swap (correctly full-page-rendered)
		// container is the known-good width to compare against.
		expect(after.width).toBeLessThanOrEqual(before.width + 2);

		const nav = page.locator('#primary-nav');
		await expect(nav.getByRole('link', { name: 'Home', exact: true })).not.toHaveAttribute('aria-current', 'page');
		await expect(nav.getByRole('link', { name: 'Projects', exact: true })).not.toHaveAttribute('aria-current', 'page');
		await expect(nav.getByRole('link', { name: 'About', exact: true })).not.toHaveAttribute('aria-current', 'page');
	});
});

// Same pattern as every other spec file in this repo (e.g. nav.spec.js,
// resume.spec.js, fishing-game.spec.js) — this app has a strict CSP
// (internal/middleware/middleware.go) that has previously silently blocked
// things like htmx's auto-injected indicator <style> tag.
test('no console errors on load, including no CSP violations', async ({ page }) => {
	const errors = [];
	page.on('console', (msg) => {
		if (msg.type() === 'error') errors.push(msg.text());
	});
	page.on('pageerror', (err) => errors.push(String(err)));

	await page.goto('/projects');

	expect(errors).toEqual([]);
});
