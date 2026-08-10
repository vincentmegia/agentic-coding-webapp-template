// /fishing-game page: canvas game shell, HUD, start/round-over/shop
// overlays, and the Postgres-backed leaderboard. See
// docs/features/fishing-game.md (User Flow, UI states, HTMX Interactions)
// and web/static/js/fishing-game.js (the actual game loop this page loads).
//
// The game simulation is driven by `Math.random()` (fish/hazard spawn
// timing) and reaching round-over "naturally" — either 3 hazard hits or the
// 1000-mile depth cap — is not reliably fast enough to drive from a browser
// test without real flakiness risk. Tests below that need a finished round
// instead call `window.__fishingGameTestHooks.forceRoundOver(outcome)`, a
// test-only hook fishing-game.js exposes from inside init() (see that
// file's comment on the hook itself) which routes through the exact same
// engine-state.js transitions (applyHazardHit/advance) and the real
// endRound() real play uses — nothing about the round-over path itself is
// faked, only the wait for a random hit/depth-cap is skipped.
const { test, expect } = require('@playwright/test');

// Matches cmd/server/e2e_test.go's fishing-game subtest naming
// (`e2e-<UnixNano()%1_000_000>`): short, timestamp-derived, safe to re-run
// against the shared dev leaderboard without meaningfully polluting it, and
// well within player_name's 20-char bound.
function testPlayerName() {
	return `e2e-${Date.now() % 1_000_000}`;
}

async function startDive(page) {
	await page.locator('#fishing-start-dive-button').click();
	// The hook is installed synchronously inside init(), at page load — this
	// just guards against any timing edge case rather than expecting a real
	// wait.
	await page.waitForFunction(() => typeof window.__fishingGameTestHooks?.forceRoundOver === 'function');
}

async function forceRoundOver(page, outcome) {
	await startDive(page);
	await page.evaluate((o) => window.__fishingGameTestHooks.forceRoundOver(o), outcome);
	await expect(page.locator('#fishing-round-over-screen')).toBeVisible();
}

test.describe('nav → Fishing Game', () => {
	test('Home ▾ → Fishing Game navigates and renders the real game shell, not the placeholder', async ({ page }) => {
		await page.goto('/');
		await page.locator('#home-menu-trigger').click();
		await expect(page.locator('#home-menu-list')).toBeVisible();

		await page.getByRole('menuitem', { name: 'Fishing Game' }).click();

		await expect(page).toHaveURL(/\/fishing-game$/);
		await expect(page.locator('#fishing-canvas')).toBeVisible();
		await expect(page.locator('#fishing-hud-depth')).toBeVisible();
		await expect(page.locator('#fishing-start-screen')).toBeVisible();
	});
});

test.describe('/fishing-game direct page load', () => {
	test('renders canvas, HUD, start screen, and correctly hides the other overlays', async ({ page }) => {
		await page.goto('/fishing-game');

		await expect(page.locator('#fishing-canvas')).toBeVisible();
		for (const id of ['fishing-hud-depth', 'fishing-hud-score', 'fishing-hud-lives', 'fishing-hud-tokens', 'fishing-hud-streak']) {
			await expect(page.locator(`#${id}`)).toBeVisible();
		}

		await expect(page.locator('#fishing-start-screen')).toBeVisible();
		await expect(page.locator('#fishing-round-over-screen')).toBeHidden();
		await expect(page.locator('#fishing-shop-screen')).toBeHidden();

		await expect(page.getByRole('heading', { name: 'Leaderboard' })).toBeVisible();
	});

	test('leaderboard fragment loads on page load into a real empty or populated state', async ({ page }) => {
		await page.goto('/fishing-game');

		const leaderboard = page.locator('#fishing-leaderboard');
		await expect(leaderboard).not.toContainText('Loading leaderboard');

		const isEmptyState = await leaderboard.getByText('No scores yet').isVisible();
		if (!isEmptyState) {
			await expect(leaderboard.locator('li').first()).toBeVisible();
		}
	});
});

test.describe('playing', () => {
	test('Start Dive hides the start screen and the depth HUD genuinely advances', async ({ page }) => {
		await page.goto('/fishing-game');
		await page.locator('#fishing-start-dive-button').click();

		await expect(page.locator('#fishing-start-screen')).toBeHidden();

		const depthLocator = page.locator('#fishing-hud-depth');
		const initialDepth = Number(await depthLocator.textContent());

		// Depth accumulation is driven by descentSpeed()/advance(), not by
		// RNG-dependent fish/hazard spawning — polling for it to increase is
		// a reliable signal the real requestAnimationFrame loop is running.
		await expect.poll(async () => Number(await depthLocator.textContent()), {
			timeout: 5000,
		}).toBeGreaterThan(initialDepth);
	});
});

test.describe('shop', () => {
	test('lists all 6 gear rows in the documented order, each disabled with 0 tokens, and closes back to the start screen', async ({ page }) => {
		await page.goto('/fishing-game');
		await page.locator('#fishing-start-shop-button').click();
		await expect(page.locator('#fishing-shop-screen')).toBeVisible();

		const expectedOrder = [
			'hullPlating',
			'ballastThrusters',
			'magneticLure',
			'sonarRange',
			'goldenBait',
			'emergencyBallast',
		];
		const rows = page.locator('[data-gear-key]');
		await expect(rows).toHaveCount(expectedOrder.length);
		const keys = await rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-gear-key')));
		expect(keys).toEqual(expectedOrder);

		for (const key of expectedOrder) {
			const row = page.locator(`[data-gear-key="${key}"]`);
			await expect(row.locator('[data-gear-level]')).toBeVisible();
			await expect(row.locator('[data-gear-cost]')).toBeVisible();
			const buyButton = row.locator('[data-gear-buy]');
			await expect(buyButton).toBeVisible();
			// Fresh save == 0 tokens: doc's UI table says buying must be
			// functionally disabled, not just visually.
			await expect(buyButton).toBeDisabled();
		}

		await page.locator('#fishing-shop-close-button').click();
		await expect(page.locator('#fishing-shop-screen')).toBeHidden();
		await expect(page.locator('#fishing-start-screen')).toBeVisible();
	});
});

test.describe('reset progress', () => {
	// Seeds a non-zero save directly into localStorage before fishing-game.js
	// runs, so "reset" has something real to clear (a fresh save is already
	// all zeros, which wouldn't distinguish a working reset from a no-op).
	async function seedSave(page) {
		await page.addInitScript(() => {
			window.localStorage.setItem('fishing-game:v1', JSON.stringify({
				version: 1,
				tokens: 120,
				gear: { hullPlating: 0, ballastThrusters: 0, magneticLure: 0, sonarRange: 0, goldenBait: 0, emergencyBallast: 0 },
				bestScore: 500,
				bestDepth: 300,
			}));
		});
	}

	test('confirming the reset clears tokens and best score', async ({ page }) => {
		await seedSave(page);
		await page.goto('/fishing-game');
		await expect(page.locator('#fishing-start-tokens')).toHaveText('120');

		await page.locator('#fishing-start-shop-button').click();
		page.once('dialog', (dialog) => dialog.accept());
		await page.locator('#fishing-shop-reset-button').click();

		await expect(page.locator('#fishing-start-screen')).toBeVisible();
		await expect(page.locator('#fishing-start-tokens')).toHaveText('0');
		await expect(page.locator('#fishing-start-best-score')).toHaveText('0');
	});

	test('declining the reset confirmation leaves progress untouched', async ({ page }) => {
		await seedSave(page);
		await page.goto('/fishing-game');

		await page.locator('#fishing-start-shop-button').click();
		page.once('dialog', (dialog) => dialog.dismiss());
		await page.locator('#fishing-shop-reset-button').click();

		// resetProgress() returns early on a declined confirm(), before ever
		// touching the save or the screen — still on the shop, unchanged.
		await expect(page.locator('#fishing-shop-screen')).toBeVisible();
		await expect(page.locator('#fishing-shop-tokens')).toHaveText('120');

		await page.locator('#fishing-shop-close-button').click();
		await expect(page.locator('#fishing-start-tokens')).toHaveText('120');
		await expect(page.locator('#fishing-start-best-score')).toHaveText('500');
	});
});

test.describe('round-over (via the deterministic test hook)', () => {
	test('a hazard-hit round-over shows "You were caught!" and a real summary', async ({ page }) => {
		await page.goto('/fishing-game');
		await forceRoundOver(page, 'caught');

		const roundOver = page.locator('#fishing-round-over-screen');
		await expect(roundOver).toHaveAttribute('data-outcome', 'caught');
		await expect(page.locator('#fishing-round-over-title')).toHaveText('You were caught!');
		await expect(page.locator('#fishing-round-over-fish-caught')).toHaveText(/^\d+$/);
		await expect(page.locator('#fishing-round-over-score')).toHaveText(/^\d+$/);
		await expect(page.locator('#fishing-round-over-depth')).toHaveText(/^\d+$/);
		await expect(page.locator('#fishing-round-over-tokens')).toHaveText(/^\d+$/);
	});

	test('reaching the depth cap shows "You reached the abyss!"', async ({ page }) => {
		await page.goto('/fishing-game');
		await forceRoundOver(page, 'reached-abyss');

		const roundOver = page.locator('#fishing-round-over-screen');
		await expect(roundOver).toHaveAttribute('data-outcome', 'reached-abyss');
		await expect(page.locator('#fishing-round-over-title')).toHaveText('You reached the abyss!');
		// advance()'s depth cap clamp guarantees exactly 1000, deterministically.
		await expect(page.locator('#fishing-round-over-depth')).toHaveText('1000');
	});

	test('submitting the leaderboard form adds the new entry, a real POST /fishing-game/score round trip', async ({ page }) => {
		await page.goto('/fishing-game');
		await forceRoundOver(page, 'reached-abyss');

		const playerName = testPlayerName();
		await page.locator('#fishing-round-over-name-input').fill(playerName);

		const [response] = await Promise.all([
			page.waitForResponse((r) => r.url().includes('/fishing-game/score') && r.request().method() === 'POST'),
			page.locator('#fishing-round-over-submit-button').click(),
		]);
		expect(response.ok()).toBeTruthy();

		// Tolerant of leftover rows from previous runs — only asserts the new
		// entry is present, never exact leaderboard length/order.
		await expect(page.locator('#fishing-leaderboard')).toContainText(playerName);
	});

	test('"Dive Again" starts a fresh round: screens hidden, HUD reset', async ({ page }) => {
		await page.goto('/fishing-game');
		await forceRoundOver(page, 'caught');

		await page.locator('#fishing-round-over-dive-again-button').click();

		// Depth is checked first and as a bounded range, not an exact '0':
		// it's a live counter that starts advancing again the instant the new
		// round's requestAnimationFrame loop ticks, so under heavy parallel
		// test-suite load enough wall-clock time can pass before this
		// assertion runs for depth to have already climbed past 0 — this
		// still proves the round genuinely reset (rather than continuing
		// from the forced round-over's depth, e.g. 1000 for reached-abyss)
		// without being racy against a value that never stops moving.
		await expect
			.poll(async () => Number(await page.locator('#fishing-hud-depth').textContent()))
			.toBeLessThan(200);
		await expect(page.locator('#fishing-hud-lives')).toHaveText('3');
		await expect(page.locator('#fishing-round-over-screen')).toBeHidden();
		await expect(page.locator('#fishing-start-screen')).toBeHidden();
	});
});

// Testing Plan: "No console errors (including no CSP violations) on
// /fishing-game" — same pattern as nav.spec.js's equivalent check for '/'
// and '/resume'.
test('no console errors on load, including no CSP violations', async ({ page }) => {
	const errors = [];
	page.on('console', (msg) => {
		if (msg.type() === 'error') errors.push(msg.text());
	});
	page.on('pageerror', (err) => errors.push(String(err)));

	await page.goto('/fishing-game');
	// Play briefly so the requestAnimationFrame loop itself (canvas drawing,
	// spawn/collision code) also gets a chance to throw, not just page load.
	await page.locator('#fishing-start-dive-button').click();
	await page.waitForTimeout(500);

	expect(errors).toEqual([]);
});
