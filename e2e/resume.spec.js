// /resume page rendering and print affordance. See docs/features/resume.md
// (User Flow, UI states, Print support). The backend half of this
// coverage — that the content is genuinely read from Postgres, not a
// fixture — lives in cmd/server/e2e_test.go.
const { test, expect } = require('@playwright/test');

test('renders banner, sidebar, summary, and timeline', async ({ page }) => {
	await page.goto('/resume');

	await expect(page.locator('#resume-banner')).toContainText('Vincent Megia');
	await expect(page.locator('#resume-banner')).toContainText('Principal / Staff Software Engineer');

	await expect(page.locator('#resume-sidebar')).toContainText('Core Expertise');
	await expect(page.locator('#resume-sidebar')).toContainText('Education');
	await expect(page.locator('#resume-sidebar').getByRole('link', { name: 'See all projects' })).toBeVisible();

	const timeline = page.locator('[aria-label="Experience timeline"]');
	await expect(timeline).toContainText('Singtel');
	await expect(timeline).toContainText('Sofgen');
	await expect(timeline.getByText('Current', { exact: true }).first()).toBeVisible();
});

test('experience roles expose nested sub-projects', async ({ page }) => {
	await page.goto('/resume');

	const sofgenRole = page.locator('.resume-role', { hasText: 'Senior Software Engineer' });
	await expect(sofgenRole.locator('.resume-subproject')).toHaveCount(2);
	await expect(sofgenRole).toContainText('Barclays Wealth');
	await expect(sofgenRole).toContainText('PayPal');
});

// Regression test for the timeline connector (vertical line + per-role
// dot, current role highlighted) present in the reviewed design artifact
// but missing from the first implementation pass — see docs/features/
// resume.md's Visual Direction "Timeline connector".
test('timeline connector line and current-role dot render on desktop, hidden on mobile', async ({ page, isMobile }) => {
	await page.goto('/resume');

	const line = page.locator('[aria-label="Experience timeline"] > div').first();
	const currentDot = page.locator('.resume-role', { hasText: 'Singtel' }).locator('xpath=preceding-sibling::span');

	if (isMobile) {
		await expect(line).toBeHidden();
		await expect(currentDot).toBeHidden();
		return;
	}

	await expect(line).toBeVisible();
	await expect(currentDot).toBeVisible();
	await expect(currentDot).toHaveClass(/border-accent/);
});

test('"See all projects" navigates to /projects via HTMX, not a full reload', async ({ page }) => {
	await page.goto('/resume');

	const [response] = await Promise.all([
		page.waitForResponse((r) => r.url().endsWith('/projects') && r.request().headers()['hx-request'] === 'true'),
		page.locator('#resume-sidebar').getByRole('link', { name: 'See all projects' }).click(),
	]);

	expect(response.ok()).toBeTruthy();
	await expect(page).toHaveURL(/\/projects$/);
});

test('print button is present and triggers window.print()', async ({ page }) => {
	await page.goto('/resume');

	const printButton = page.locator('#resume-print-button');
	await expect(printButton).toBeVisible();
	await expect(printButton).toContainText('Print / Save as PDF');

	const printCalled = page.evaluate(
		() => new Promise((resolve) => {
			window.print = () => resolve(true);
		})
	);
	await printButton.click();
	await expect.poll(async () => printCalled).toBeTruthy();
});

test('external contact/project links open in a new tab safely', async ({ page }) => {
	await page.goto('/resume');

	const githubLink = page.locator('#resume-banner').getByRole('link', { name: /github\.com/ });
	await expect(githubLink).toHaveAttribute('target', '_blank');
	await expect(githubLink).toHaveAttribute('rel', /noopener/);
	await expect(githubLink).toHaveAttribute('rel', /noreferrer/);
});

test('dark mode toggle changes the resume page theme', async ({ page }) => {
	await page.goto('/resume');
	const html = page.locator('html');

	await expect(html).not.toHaveClass(/dark/);
	await page.locator('[data-theme-toggle]').first().click();
	await expect(html).toHaveClass(/dark/);

	// Reload to confirm the cookie persisted server-side (dark-mode.md's
	// no-flash requirement) rather than only flipping a client-side class.
	await page.reload();
	await expect(html).toHaveClass(/dark/);
});
