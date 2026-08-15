// /projects page: heading + subhead, and a grid of hand-authored placeholder
// project cards (Fieldnotes/Tidewatch/Loom UI/Nightlight —
// internal/handler/pages.go's projectItems), pulled from a claude.ai/design
// "Personal website and portfolio" project's Projects.dc.html. See
// web/templates/pages/projects.html and internal/handler/template.go's
// Project struct for the full contract.
const { test, expect } = require('@playwright/test');

const PROJECTS = [
	{
		title: 'Fieldnotes',
		description: 'A minimal journaling app for capturing ideas on the move, synced offline-first.',
		tags: ['React', 'PWA', 'IndexedDB'],
	},
	{
		title: 'Tidewatch',
		description: 'A real-time surf and tide dashboard for local breaks, built for quick morning checks.',
		tags: ['Next.js', 'D3'],
	},
	{
		title: 'Loom UI',
		description: 'A small open-source component kit for fast, honest prototypes.',
		tags: ['TypeScript', 'Storybook'],
	},
	{
		title: 'Nightlight',
		description: 'A sleep and focus timer with ambient soundscapes, built for quiet evenings.',
		tags: ['Swift', 'iOS'],
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

// None of the 4 placeholder projects (internal/handler/pages.go's
// projectItems) currently set LiveURL, so projects.html's `{{if .LiveURL}}`
// "Live demo" link never renders. Asserting its absence (rather than writing
// no test at all) still guards the conditional itself — a future regression
// that renders the link unconditionally would be caught here.
test('no "Live demo" link renders yet — none of the placeholder projects have a LiveURL', async ({ page }) => {
	await page.goto('/projects');
	await expect(page.getByRole('link', { name: 'Live demo' })).toHaveCount(0);
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
