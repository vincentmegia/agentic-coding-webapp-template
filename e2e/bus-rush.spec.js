// /bus-rush: canvas game, HUD, start/run-over/shop overlays and the
// Postgres-backed leaderboard (docs/features/bus-rush.md). A natural crash
// depends on random traffic, so tests that need a finished run call
// window.__busRushTestHooks.crash(), which applies real hits through the
// game's own hit()/endRun() path.
const { test, expect } = require('@playwright/test');
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// Same resolution as fishing-game.spec.js: process env wins, else .env.
function databaseURL() {
	if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
	const envPath = path.join(__dirname, '..', '.env');
	if (!fs.existsSync(envPath)) return undefined;
	for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
		const match = line.match(/^\s*DATABASE_URL\s*=\s*(.*?)\s*$/);
		if (match) return match[1];
	}
	return undefined;
}

// Deletes exactly the row this test submitted (no LIKE), in whichever
// schema the e2e server wrote it to.
async function deleteTestScore(playerName) {
	const client = new Client({ connectionString: databaseURL() });
	await client.connect();
	try {
		for (const table of ['bus_e2e.bus_rush_scores', 'public.bus_rush_scores']) {
			await client.query(`DELETE FROM ${table} WHERE player_name = $1`, [playerName]).catch(() => {});
		}
	} finally {
		await client.end();
	}
}

test('renders canvas, HUD and start screen with the other overlays hidden', async ({ page }) => {
	await page.goto('/bus-rush');
	await expect(page.locator('#bus-rush-canvas')).toBeVisible();
	await expect(page.locator('#bus-rush-start-screen')).toBeVisible();
	await expect(page.locator('#bus-rush-run-over-screen')).toBeHidden();
	await expect(page.locator('#bus-rush-shop-screen')).toBeHidden();
	await expect(page.locator('#bus-rush-leaderboard')).not.toContainText('Loading leaderboard');
});

test('Start Run begins a run: distance advances and ↑ raises speed', async ({ page }) => {
	await page.goto('/bus-rush');
	await page.locator('#bus-rush-start-button').click();
	await expect(page.locator('#bus-rush-start-screen')).toBeHidden();

	const distance = page.locator('#bus-rush-hud-distance');
	await expect.poll(async () => parseInt(await distance.textContent(), 10), { timeout: 5000 }).toBeGreaterThan(0);

	const speed = page.locator('#bus-rush-hud-speed');
	const before = parseInt(await speed.textContent(), 10);
	await page.keyboard.down('ArrowUp');
	await expect.poll(async () => parseInt(await speed.textContent(), 10), { timeout: 5000 }).toBeGreaterThan(before);
	await page.keyboard.up('ArrowUp');
});

test('crashing ends the run, awards tokens, and the shop spends them', async ({ page }) => {
	await page.goto('/bus-rush');
	await page.evaluate(() => window.localStorage.removeItem('bus-rush:v1'));
	await page.reload();
	await page.locator('#bus-rush-start-button').click();
	await page.evaluate(() => window.__busRushTestHooks.crash());
	await expect(page.locator('#bus-rush-run-over-screen')).toBeVisible();
	await expect(page.locator('#bus-rush-hud-lives')).toHaveText('0');

	await page.evaluate(() => window.__busRushTestHooks.grantTokens(100));
	await page.locator('#bus-rush-run-over-shop-button').click();
	const engine = page.locator('[data-upgrade-key="engine"]');
	await engine.locator('[data-upgrade-buy]').click();
	await expect(engine.locator('[data-upgrade-level]')).toHaveText('1');

	// Persisted across a reload.
	await page.reload();
	await page.locator('#bus-rush-start-shop-button').click();
	await expect(page.locator('[data-upgrade-key="engine"] [data-upgrade-level]')).toHaveText('1');
});

test('a finished run can be submitted to the leaderboard', async ({ page }) => {
	const playerName = `e2e-${Date.now() % 1_000_000}`;
	try {
		await page.goto('/bus-rush');
		await page.locator('#bus-rush-start-button').click();
		await page.evaluate(() => window.__busRushTestHooks.crash());
		await page.locator('#bus-rush-name-input').fill(playerName);
		await page.locator('#bus-rush-submit-button').click();
		await expect(page.locator('#bus-rush-leaderboard')).toContainText(playerName);
		await expect(page.locator('#bus-rush-submit-button')).toBeDisabled();
	} finally {
		await deleteTestScore(playerName);
	}
});

test('revisiting via HTMX still wires the game', async ({ page }) => {
	await page.goto('/projects');
	const card = page.locator('.project-card').filter({ hasText: 'Bus Rush' });
	await card.getByRole('link', { name: 'Play now' }).click();
	await expect(page).toHaveURL(/\/bus-rush$/);
	await page.goBack();
	await page.locator('.project-card').filter({ hasText: 'Bus Rush' }).getByRole('link', { name: 'Play now' }).click();
	await page.locator('#bus-rush-start-button').click();
	await expect.poll(async () => parseInt(await page.locator('#bus-rush-hud-distance').textContent(), 10), { timeout: 5000 }).toBeGreaterThan(0);
});
