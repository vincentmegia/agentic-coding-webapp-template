// Header nav behavior. The desktop primary nav is a flat Home/Projects/About
// link row (#primary-nav) plus a Résumé button (web/templates/components/
// header.html), replacing the earlier Home dropdown — see
// internal/handler/nav.go's primaryNavItems doc comment for the rationale.
// The Settings dropdown (web/static/js/nav-menu.js, components/nav-menu.html)
// still exists but is gated behind auth, so it isn't covered here.
const { test, expect } = require('@playwright/test');

test.describe('desktop primary nav', () => {
	test('renders Home/Projects/About as plain links plus a Résumé button', async ({ page }) => {
		await page.goto('/');
		const nav = page.locator('#primary-nav');

		await expect(nav.getByRole('link', { name: 'Home', exact: true })).toBeVisible();
		await expect(nav.getByRole('link', { name: 'Projects', exact: true })).toBeVisible();
		await expect(nav.getByRole('link', { name: 'About', exact: true })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Résumé', exact: true })).toBeVisible();
	});

	test('marks the current page with aria-current and updates it after navigating', async ({ page }) => {
		await page.goto('/');
		const nav = page.locator('#primary-nav');

		await expect(nav.getByRole('link', { name: 'Home', exact: true })).toHaveAttribute('aria-current', 'page');

		await nav.getByRole('link', { name: 'Projects', exact: true }).click();
		await page.waitForLoadState('networkidle');

		await expect(page).toHaveURL(/\/projects$/);
		await expect(nav.getByRole('link', { name: 'Projects', exact: true })).toHaveAttribute('aria-current', 'page');
		await expect(nav.getByRole('link', { name: 'Home', exact: true })).not.toHaveAttribute('aria-current', 'page');
	});

	test('Résumé button navigates to /resume via HTMX', async ({ page }) => {
		await page.goto('/');
		await page.getByRole('link', { name: 'Résumé', exact: true }).click();
		await expect(page).toHaveURL(/\/resume$/);
	});
});

test.describe('mobile nav panel', () => {
	test.use({ viewport: { width: 375, height: 800 } });

	test('opens, navigates, and closes on selection', async ({ page }) => {
		await page.goto('/');
		await page.locator('[data-mobile-nav-trigger]').click();
		await expect(page.locator('[data-mobile-nav-panel]')).toBeVisible();

		await page.locator('[data-mobile-nav-panel]').getByRole('link', { name: 'Résumé', exact: true }).click();

		await expect(page).toHaveURL(/\/resume$/);
		await expect(page.locator('[data-mobile-nav-panel]')).toBeHidden();
	});
});

// Regression coverage for the CSP violation fixed alongside the dropdown
// bug: htmx auto-injects a <style> tag for .htmx-indicator unless told not
// to (base.html's htmx-config meta tag disables it), which the app's
// strict Content-Security-Policy (go-backend's Security Headers) was
// silently blocking on every page load.
test('no console errors on load, including no CSP violations', async ({ page }) => {
	const errors = [];
	page.on('console', (msg) => {
		if (msg.type() === 'error') errors.push(msg.text());
	});
	page.on('pageerror', (err) => errors.push(String(err)));

	await page.goto('/');
	await page.goto('/resume');

	expect(errors).toEqual([]);
});

// Regression test for a real, previously-shipped bug: hx-swap="outerHTML"
// (home.md's HTMX Interactions) replaces the *entire* #main-content
// element with the server's fragment response. Every content template
// used to render only its inner content, not its own <main id="main-content">
// wrapper — so navigating via the nav (as opposed to a direct page load,
// which base.html always wrapped correctly) destroyed #main-content's own
// mx-auto/max-w-5xl/padding classes, leaving the new page full-bleed with
// no container. This specifically drives navigation through the header nav
// — not page.goto(), which only exercises the full-page path and would
// never have caught this — and checks the resulting container's computed
// width/padding, not just its presence.
test.describe('container survives an HTMX nav swap (not just a direct page load)', () => {
	const cases = [
		['resume', (page) => page.getByRole('link', { name: 'Résumé', exact: true }).click()],
		['a placeholder route', (page) => page.locator('#primary-nav').getByRole('link', { name: 'Projects', exact: true }).click()],
	];

	for (const [label, click] of cases) {
		test(`navigating to ${label} via the header nav keeps #main-content's container classes`, async ({ page }) => {
			await page.goto('/');
			const before = await page.locator('#main-content').boundingBox();

			await click(page);
			await page.waitForLoadState('networkidle');

			const main = page.locator('#main-content');
			await expect(main).toHaveCount(1); // outerHTML swap must not duplicate or drop it
			await expect(main).toHaveClass(/mx-auto/);
			await expect(main).toHaveClass(/max-w-5xl/);

			const after = await main.boundingBox();
			// A full-bleed regression would make the post-swap container as
			// wide as the viewport; the pre-swap (correctly full-page-rendered)
			// container is the known-good width to compare against.
			expect(after.width).toBeLessThanOrEqual(before.width + 2);
		});
	}
});
