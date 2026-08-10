// Header dropdown nav behavior (web/static/js/nav-menu.js,
// web/templates/components/nav-menu.html). See docs/features/home.md's
// Business Rules and UI states.
const { test, expect } = require('@playwright/test');

test.describe('desktop nav dropdown', () => {
	test('opens on trigger click and lists items', async ({ page }) => {
		await page.goto('/');
		const trigger = page.locator('#home-menu-trigger');
		const list = page.locator('#home-menu-list');

		await expect(trigger).toHaveAttribute('aria-expanded', 'false');
		await expect(list).toBeHidden();

		await trigger.click();

		await expect(trigger).toHaveAttribute('aria-expanded', 'true');
		await expect(list).toBeVisible();
		await expect(list.getByRole('menuitem', { name: 'Resume' })).toBeVisible();
	});

	// Regression test for the bug fixed here: the dropdown stayed open
	// after selecting an item, because the "close on outside click"
	// handler never fires for a click on the item itself (it's inside the
	// menu, not outside it). nav-menu.js now closes on item click directly.
	test('closes after selecting an item, not just on outside click', async ({ page }) => {
		await page.goto('/');
		await page.locator('#home-menu-trigger').click();
		await expect(page.locator('#home-menu-list')).toBeVisible();

		await page.getByRole('menuitem', { name: 'Resume' }).click();

		await expect(page).toHaveURL(/\/resume$/);
		await expect(page.locator('#home-menu-trigger')).toHaveAttribute('aria-expanded', 'false');
		await expect(page.locator('#home-menu-list')).toBeHidden();
	});

	test('closes on outside click', async ({ page }) => {
		await page.goto('/');
		await page.locator('#home-menu-trigger').click();
		await expect(page.locator('#home-menu-list')).toBeVisible();

		await page.locator('body').click({ position: { x: 5, y: 400 } });

		await expect(page.locator('#home-menu-list')).toBeHidden();
	});

	test('closes on Escape and returns focus to the trigger', async ({ page }) => {
		await page.goto('/');
		const trigger = page.locator('#home-menu-trigger');
		await trigger.click();
		await expect(page.locator('#home-menu-list')).toBeVisible();

		await page.keyboard.press('Escape');

		await expect(page.locator('#home-menu-list')).toBeHidden();
		await expect(trigger).toBeFocused();
	});
});

test.describe('mobile nav panel', () => {
	test.use({ viewport: { width: 375, height: 800 } });

	test('opens, navigates, and closes on selection', async ({ page }) => {
		await page.goto('/');
		await page.locator('[data-mobile-nav-trigger]').click();
		await expect(page.locator('[data-mobile-nav-panel]')).toBeVisible();

		await page.locator('[data-mobile-nav-panel]').getByRole('link', { name: /Resume/ }).click();

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
// wrapper — so navigating via the dropdown (as opposed to a direct
// page load, which base.html always wrapped correctly) destroyed
// #main-content's own mx-auto/max-w-5xl/padding classes, leaving the new
// page full-bleed with no container. This specifically drives navigation
// through the dropdown — not page.goto(), which only exercises the
// full-page path and would never have caught this — and checks the
// resulting container's computed width/padding, not just its presence.
test.describe('container survives an HTMX nav swap (not just a direct page load)', () => {
	for (const [label, itemName] of [['resume', 'Resume'], ['a placeholder route', 'Projects']]) {
		test(`navigating to ${label} via the dropdown keeps #main-content's container classes`, async ({ page }) => {
			await page.goto('/');
			const before = await page.locator('#main-content').boundingBox();

			await page.locator('#home-menu-trigger').click();
			await page.getByRole('menuitem', { name: itemName, exact: true }).click();
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
