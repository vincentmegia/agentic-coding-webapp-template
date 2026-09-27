// /library-game page: canvas game shell, HUD, start/paycheck overlays, and
// the Postgres-backed leaderboard (docs/features/library-game.md's User
// Flow, UI, HTMX Interactions). See web/static/js/library-game.js (the
// actual game loop this page loads) and web/static/js/library/{rules,
// engine-state,floor-plan}.js (the pure logic/geometry it drives).
//
// This game's real-time shift clocks run 600/480/360 seconds per tier
// (rules.js's ROUND_TIER_CLOCK_SECONDS — deliberately much slower than
// Kitchen Shift's own 300/180/120s, per the doc's "don't go so fast"
// Business Rule) and every patron/book arrival is Math.random()-timed, so
// waiting any of it out naturally is not a realistic option for a browser
// test. Every test below instead drives the SAME real click-to-move/
// click-to-interact path a player uses, but gets its coordinates and
// spawn timing from `window.__libraryGameTestHooks` (installed synchronously
// inside init() — see that file's own comment on the hooks object) rather
// than guessing where a randomly-scattered item landed or waiting for a
// randomly-timed spawn. Nothing about the interaction path itself is
// bypassed: hooks only supply exact positions/timing, and one test
// (`skipToClosing`) fast-forwards the shift clock the same way Kitchen
// Shift's own `__cookingGameTestHooks.skipToClosing` does, by calling the
// real `tick()` transitions with a large delta rather than a fake phase
// assignment.
const { test, expect } = require('@playwright/test');
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// Resolves DATABASE_URL the same way internal/config/config.go does — see
// fishing-game.spec.js's identical helper for the full explanation of why
// this file has to parse .env itself rather than relying on the process
// environment already having it.
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

// Matches cmd/server/e2e_test.go's naming convention for throwaway
// leaderboard rows (e2e-<UnixNano()%1_000_000>) — well within
// player_name's 20-char bound. See fishing-game.spec.js's identical helper
// for why every test that submits one of these MUST clean it up: this
// repo's dev Postgres has no separate test database, so an uncleaned row
// here is a real row on a real public leaderboard.
function testPlayerName() {
	return `e2e-${Date.now() % 1_000_000}`;
}

async function deleteTestScore(playerName) {
	const connectionString = databaseURL();
	if (!connectionString) {
		throw new Error('DATABASE_URL not found (checked process.env and repo-root .env) — cannot clean up test leaderboard row');
	}
	const client = new Client({ connectionString });
	await client.connect();
	try {
		await client.query('DELETE FROM library_scores WHERE player_name = $1', [playerName]);
	} finally {
		await client.end();
	}
}

async function startShift(page) {
	await page.locator('#library-start-shift-button').click();
	await page.waitForFunction(() => typeof window.__libraryGameTestHooks?.getShiftState === 'function');
}

/**
 * Converts a canvas-space {x, y} (library-game.js's internal 960x600 world)
 * to real page coordinates, via the canvas element's own bounding box —
 * the exact inverse of library-game.js's own `canvasCoordsFromEvent`.
 *
 * This letterbox-aware math is NOT optional here: `startShift()` calls
 * `requestFullscreen()` unconditionally, and a real user-gesture click (which
 * is exactly what Playwright's `.click()` is) actually succeeds in putting
 * `#library-game-container` into real Fullscreen in headless Chromium — a
 * real discovery made debugging this suite, not a documented assumption.
 * Once fullscreen engages, app.css's `#library-game-container:fullscreen`
 * override stretches `#library-canvas-wrapper` to a non-960:600 box and
 * relies on `object-fit: contain` to letterbox the canvas's actual visible
 * content back to the right aspect ratio — so the canvas's own
 * getBoundingClientRect() box no longer matches its rendered content 1:1. A
 * naive linear `(point.x / 960) * box.width` mapping (this function's first
 * draft) silently clicked the wrong world position by however much
 * letterbox padding fullscreen introduced — small enough to still land
 * inside a generous hit radius (a station's 84px box, Karen's 150x40
 * buttons) but consistently outside a small icon's tight one (an 18-20px
 * Return Cart book/overlay item), which is exactly the failure pattern this
 * fix resolves.
 */
async function canvasToPage(page, point) {
	const box = await page.locator('#library-canvas').boundingBox();
	const worldAspect = 960 / 600;
	let contentWidth = box.width;
	let contentHeight = box.height;
	let offsetX = 0;
	let offsetY = 0;
	if (box.width / box.height > worldAspect) {
		contentWidth = box.height * worldAspect;
		offsetX = (box.width - contentWidth) / 2;
	} else {
		contentHeight = box.width / worldAspect;
		offsetY = (box.height - contentHeight) / 2;
	}
	return {
		x: box.x + offsetX + (point.x / 960) * contentWidth,
		y: box.y + offsetY + (point.y / 600) * contentHeight,
	};
}

async function clickCanvasPoint(page, point) {
	const p = await canvasToPage(page, point);
	await page.mouse.click(p.x, p.y);
}

/**
 * Looks up one station by kind (and, for bookshelves, genreId). Stairs,
 * Elevator, and Front Desk exist as one instance PER FLOOR (floor-plan.js) —
 * preferring a match on the player's CURRENT floor (falling back to any
 * match otherwise) means a kind-only lookup finds the one actually usable
 * right now, rather than always the first one buildStations() happens to
 * list (which silently picked 1st Floor's instance even from 2nd Floor in
 * an earlier version of this helper — a real test bug, not a game bug: it
 * made "walk to the Elevator" tests actually walk to the OTHER floor's
 * Elevator, invisible and unclickable from where the player stood).
 */
async function getStation(page, kind, extra) {
	return page.evaluate(({ kind: k, extra: e }) => {
		const hooks = window.__libraryGameTestHooks;
		const matches = hooks.getStations().filter((s) => s.kind === k && (!e || s.genreId === e));
		return matches.find((s) => s.floor === hooks.getCurrentFloor()) || matches[0];
	}, { kind, extra });
}

/** Waits for the player's current walk (if any) to finish — library-game.js's `moveTarget` clears the instant `updatePlayer` detects arrival and fires the station's `handleArrival`, so this is the reliable "the click's real effect has now happened" signal, not a distance guess against the station's approach-point standoff. */
async function waitUntilArrived(page) {
	await page.waitForFunction(() => window.__libraryGameTestHooks.isPlayerMoving() === false, { timeout: 10000 });
}

/** Clicks a station and waits for the player to actually walk up to and arrive at it — every interaction in this game is click-to-walk-then-act, so tests need to wait out the walk, not just the click. Switches floor first via the HUD button if the target station isn't on the player's current floor (a randomly-spawned book/borrow request can land on either of GENRES' two floor-split shelves — see floor-plan.js's FLOOR_1_GENRE_COUNT). */
async function walkToStation(page, kind, extra) {
	const station = await getStation(page, kind, extra);
	const currentFloor = await page.evaluate(() => window.__libraryGameTestHooks.getCurrentFloor());
	if (station.floor !== currentFloor) {
		await page.locator('#library-floor-button').click();
	}
	await clickCanvasPoint(page, station);
	await waitUntilArrived(page);
}

/** Clicks a Return Cart book or Front Desk patron slot (queues the pickup/accept action) and waits for the player's resulting walk-to-station to finish, at which point library-game.js's handleArrival executes the queued action. Mirrors `walkToStation`'s own single click-then-wait shape rather than issuing a second, redundant click on the station itself. */
async function clickQueueItem(page, point) {
	await clickCanvasPoint(page, point);
	await waitUntilArrived(page);
}

async function getOverlay(page) {
	return page.evaluate(() => window.__libraryGameTestHooks.getOverlay());
}

async function waitForOverlay(page, kind) {
	await page.waitForFunction((k) => window.__libraryGameTestHooks.getOverlay()?.kind === k, kind, { timeout: 10000 });
	return getOverlay(page);
}

/** Resolves the shared Shelf/Checkout Skill-Check overlay as a success — sets the gauge into the success zone via the test hook, then clicks the canvas to sample it, the exact same click path a real player uses. */
async function resolveSkillCheckSuccess(page) {
	await page.evaluate(() => window.__libraryGameTestHooks.setSkillCheckGauge(0.5));
	await clickCanvasPoint(page, { x: 480, y: 300 });
}

test.describe('/library-game direct page load', () => {
	test('renders canvas, HUD, start screen, and correctly hides the paycheck screen', async ({ page }) => {
		await page.goto('/library-game');

		await expect(page.locator('#library-canvas')).toBeVisible();
		for (const id of ['library-hud-shift', 'library-hud-clock', 'library-hud-status']) {
			await expect(page.locator(`#${id}`)).toBeVisible();
		}

		await expect(page.locator('#library-start-screen')).toBeVisible();
		await expect(page.locator('#library-paycheck-screen')).toBeHidden();

		await expect(page.getByRole('heading', { name: 'Leaderboard' })).toBeVisible();
	});

	test('leaderboard fragment loads into a real empty or populated state', async ({ page }) => {
		await page.goto('/library-game');

		const leaderboard = page.locator('#library-leaderboard');
		await expect(leaderboard).not.toContainText('Loading leaderboard');

		const isEmptyState = await leaderboard.getByText(/no scores/i).isVisible().catch(() => false);
		if (!isEmptyState) {
			await expect(leaderboard.locator('li, tr').first()).toBeVisible();
		}
	});
});

test.describe('starting a shift', () => {
	test('Start Shift hides the start screen and the HUD shows shift 1/30 and a real clock reading', async ({ page }) => {
		await page.goto('/library-game');
		await startShift(page);

		await expect(page.locator('#library-start-screen')).toBeHidden();
		await expect(page.locator('#library-hud-shift')).toHaveText('1/30');
		// inGameTimeLabel's format, e.g. "8:00 AM" at shift start.
		await expect(page.locator('#library-hud-clock')).toHaveText(/^\d{1,2}:\d{2} (AM|PM)$/);
	});
});

test.describe('floor switching', () => {
	test('the HUD floor button and the Stairs/Elevator stations all move the player to 2nd Floor and back', async ({ page }) => {
		await page.goto('/library-game');
		await startShift(page);

		expect(await page.evaluate(() => window.__libraryGameTestHooks.getCurrentFloor())).toBe(1);

		await expect(page.locator('#library-floor-button')).toHaveText('Go Upstairs');
		await page.locator('#library-floor-button').click();
		expect(await page.evaluate(() => window.__libraryGameTestHooks.getCurrentFloor())).toBe(2);
		await expect(page.locator('#library-floor-button')).toHaveText('Go Downstairs');

		await page.locator('#library-floor-button').click();
		expect(await page.evaluate(() => window.__libraryGameTestHooks.getCurrentFloor())).toBe(1);

		// Now via the in-world Stairs/Elevator stations themselves, not the HUD shortcut.
		await walkToStation(page, 'stairs');
		expect(await page.evaluate(() => window.__libraryGameTestHooks.getCurrentFloor())).toBe(2);

		await walkToStation(page, 'elevator');
		expect(await page.evaluate(() => window.__libraryGameTestHooks.getCurrentFloor())).toBe(1);
	});

	test('floor switching still works during closing-wait (a 2nd-Floor trip must not strand the player away from the 1st-Floor-only Boss\'s Office)', async ({ page }) => {
		await page.goto('/library-game');
		await startShift(page);
		await page.evaluate(() => window.__libraryGameTestHooks.skipToClosing());

		await page.locator('#library-floor-button').click();
		expect(await page.evaluate(() => window.__libraryGameTestHooks.getCurrentFloor())).toBe(2);
		await page.locator('#library-floor-button').click();
		expect(await page.evaluate(() => window.__libraryGameTestHooks.getCurrentFloor())).toBe(1);
	});
});

test.describe('shelving books', () => {
	test('shelving a normal book via the Return Cart and the Shelf Skill-Check', async ({ page }) => {
		await page.goto('/library-game');
		await startShift(page);

		const book = await page.evaluate(() => {
			window.__libraryGameTestHooks.spawnBookNow(false);
			return window.__libraryGameTestHooks.getReturnCartSlots()[0];
		});
		expect(book.isCoinHunt).toBe(false);

		await clickQueueItem(page, book);
		// pickUpBook resolves synchronously on arrival — confirm it actually happened.
		await expect.poll(async () => page.evaluate(() => window.__libraryGameTestHooks.getShiftState().carriedBook !== null)).toBe(true);

		await walkToStation(page, 'bookshelf', book.genreId);
		await waitForOverlay(page, 'skill-check');

		await resolveSkillCheckSuccess(page);
		await expect.poll(async () => getOverlay(page)).toBe(null);
		expect(await page.evaluate(() => window.__libraryGameTestHooks.getShiftState().carriedBook)).toBe(null);
	});

	test('a wrong-shelf arrival blocks the skill-check (no silent mistake)', async ({ page }) => {
		await page.goto('/library-game');
		await startShift(page);

		const book = await page.evaluate(() => {
			window.__libraryGameTestHooks.spawnBookNow(false);
			return window.__libraryGameTestHooks.getReturnCartSlots()[0];
		});
		await clickQueueItem(page, book);

		const stations = await page.evaluate(() => window.__libraryGameTestHooks.getStations());
		const wrongShelf = stations.find((s) => s.kind === 'bookshelf' && s.genreId !== book.genreId && s.floor === 1);
		await clickCanvasPoint(page, wrongShelf);
		await waitUntilArrived(page);

		expect(await getOverlay(page)).toBe(null);
		const mistakesBefore = await page.evaluate(() => window.__libraryGameTestHooks.getShiftState().mistakeCount);
		expect(mistakesBefore).toBe(0);
		expect(await page.evaluate(() => window.__libraryGameTestHooks.getShiftState().carriedBook)).not.toBe(null);
	});

	test('shelving a Coin Hunt book opens the Coin Hunt minigame and banks found Gard', async ({ page }) => {
		await page.goto('/library-game');
		await startShift(page);

		const book = await page.evaluate(() => {
			window.__libraryGameTestHooks.spawnBookNow(true);
			return window.__libraryGameTestHooks.getReturnCartSlots()[0];
		});
		expect(book.isCoinHunt).toBe(true);

		await clickQueueItem(page, book);
		await walkToStation(page, 'bookshelf', book.genreId);

		const overlay = await waitForOverlay(page, 'coin-hunt');
		expect(overlay.items.length).toBeGreaterThan(0);

		for (const item of overlay.items) {
			await clickCanvasPoint(page, item);
		}

		await expect.poll(async () => getOverlay(page)).toBe(null);
		const bonusGard = await page.evaluate(() => window.__libraryGameTestHooks.getShiftState().bonusGard);
		expect(bonusGard).toBeGreaterThan(0);
	});
});

test.describe('fines', () => {
	test('accepting a fine and completing the Fines Sort minigame banks it', async ({ page }) => {
		await page.goto('/library-game');
		await startShift(page);

		await page.evaluate(() => window.__libraryGameTestHooks.spawnFineNow(50));
		const slot = await page.evaluate(() => window.__libraryGameTestHooks.getFrontDeskSlots().find((s) => s.kind === 'fine'));
		await clickQueueItem(page, slot);
		await expect.poll(async () => page.evaluate(() => window.__libraryGameTestHooks.getShiftState().carriedFine !== null)).toBe(true);

		await walkToStation(page, 'fines-counter');
		const overlay = await waitForOverlay(page, 'fines-sort');
		const realItems = overlay.items.filter((i) => i.real);
		expect(realItems.length).toBeGreaterThan(0);

		for (const item of realItems) {
			await clickCanvasPoint(page, item);
		}

		await expect.poll(async () => getOverlay(page)).toBe(null);
		const bonusGard = await page.evaluate(() => window.__libraryGameTestHooks.getShiftState().bonusGard);
		expect(bonusGard).toBe(50);
	});
});

test.describe('borrowing', () => {
	test('fulfilling a borrow request: Find the Book, then the Checkout Skill-Check', async ({ page }) => {
		await page.goto('/library-game');
		await startShift(page);

		await page.evaluate(() => window.__libraryGameTestHooks.spawnBorrowNow());
		const slot = await page.evaluate(() => window.__libraryGameTestHooks.getFrontDeskSlots().find((s) => s.kind === 'borrow'));
		await clickQueueItem(page, slot);

		const info = await page.evaluate(() => window.__libraryGameTestHooks.getActiveBorrowInfo());
		expect(info).not.toBe(null);

		await walkToStation(page, 'bookshelf', info.genreId);
		const findOverlay = await waitForOverlay(page, 'find-the-book');
		const correct = findOverlay.items.find((i) => i.correct);
		expect(correct).toBeTruthy();

		await clickCanvasPoint(page, correct);
		await expect.poll(async () => getOverlay(page)).toBe(null);
		expect(await page.evaluate(() => window.__libraryGameTestHooks.getShiftState().activeBorrow?.stage)).toBe('checkout');

		await walkToStation(page, 'front-desk');
		await waitForOverlay(page, 'skill-check');
		await resolveSkillCheckSuccess(page);

		await expect.poll(async () => getOverlay(page)).toBe(null);
		expect(await page.evaluate(() => window.__libraryGameTestHooks.getShiftState().activeBorrow)).toBe(null);
	});
});

test.describe('Coffee Machine', () => {
	test('visiting the Coffee Machine restores Sanity to full', async ({ page }) => {
		await page.goto('/library-game');
		await startShift(page);

		// Sanity drains passively every second of play (rules.js's
		// SANITY_DRAIN_PER_SECOND) — wait long enough for that to be
		// observable before checking the Coffee Machine actually restores it.
		await expect.poll(async () => page.evaluate(() => window.__libraryGameTestHooks.getShiftState().sanity)).toBeLessThan(100);

		await walkToStation(page, 'coffee-machine');
		const after = await page.evaluate(() => window.__libraryGameTestHooks.getShiftState().sanity);
		// restoreSanity() sets it to exactly SANITY_MAX (100) the instant the
		// player arrives, but the game loop's passive per-second drain keeps
		// running afterward — a small margin, not an exact 100, avoids this
		// assertion being racy against however many milliseconds pass between
		// arrival and this read.
		expect(after).toBeGreaterThan(99);
	});
});

test.describe("Karen's scripted event", () => {
	test('collecting her fine banks Gard with no mistake', async ({ page }) => {
		await page.goto('/library-game');
		await startShift(page);
		await page.evaluate(() => window.__libraryGameTestHooks.forceKarenShiftNow());

		const slot = await page.evaluate(() => window.__libraryGameTestHooks.getFrontDeskSlots().find((s) => s.kind === 'karen'));
		expect(slot).toBeTruthy();
		await clickQueueItem(page, slot);

		const overlay = await waitForOverlay(page, 'karen');
		expect(overlay).toBeTruthy();

		// "Collect the Fine" button, per library-game.js's karenButtonRects().
		await clickCanvasPoint(page, { x: 480 - 150 / 2 - 10, y: 430 + 20 });

		await expect.poll(async () => getOverlay(page)).toBe(null);
		const state = await page.evaluate(() => window.__libraryGameTestHooks.getShiftState());
		expect(state.karen.outcome).toBe('collectFine');
		expect(state.mistakeCount).toBe(0);
		expect(state.bonusGard).toBeGreaterThan(0);
	});

	test('letting it slide counts a mistake and drains library mood', async ({ page }) => {
		await page.goto('/library-game');
		await startShift(page);
		await page.evaluate(() => window.__libraryGameTestHooks.forceKarenShiftNow());

		const slot = await page.evaluate(() => window.__libraryGameTestHooks.getFrontDeskSlots().find((s) => s.kind === 'karen'));
		await clickQueueItem(page, slot);
		await waitForOverlay(page, 'karen');

		// "Let It Slide" button.
		await clickCanvasPoint(page, { x: 480 + 10 + 75, y: 430 + 20 });

		await expect.poll(async () => getOverlay(page)).toBe(null);
		const state = await page.evaluate(() => window.__libraryGameTestHooks.getShiftState());
		expect(state.karen.outcome).toBe('letItSlide');
		expect(state.mistakeCount).toBe(1);
		expect(state.libraryMood).toBeLessThan(100);
	});
});

test.describe('a full shift and the closing-wait lock', () => {
	test("the Boss's Office is locked during play, then payable once closing-wait elapses", async ({ page }) => {
		await page.goto('/library-game');
		await startShift(page);

		await walkToStation(page, 'boss-office');
		await expect(page.locator('#library-paycheck-screen')).toBeHidden();
		await expect(page.locator('#library-toast')).toContainText(/closing/i);

		await page.evaluate(() => window.__libraryGameTestHooks.skipToClosing());
		expect(await page.evaluate(() => window.__libraryGameTestHooks.isBossOfficeReady())).toBe(true);

		await walkToStation(page, 'boss-office');
		await expect(page.locator('#library-paycheck-screen')).toBeVisible();
		await expect(page.locator('#library-paycheck-shift-total')).toHaveText(/Gard/);
		await expect(page.locator('#library-paycheck-month-total')).toHaveText(/Gard/);
		await expect(page.locator('#library-final-paycheck-block')).toBeHidden();
		await expect(page.locator('#library-paycheck-next-shift-button')).toBeVisible();
	});
});

test.describe('leaderboard submission (final shift)', () => {
	test('reaching shift 30 shows the Final Paycheck block and a real POST /library-game/score round trip', async ({ page }) => {
		const playerName = testPlayerName();
		try {
			// Seed the save directly at shift 30 rather than playing 29 real
			// shifts — this test is about the leaderboard submission plumbing,
			// not the shift-progression loop (covered above).
			await page.addInitScript(() => {
				window.localStorage.setItem('library-game:v1', JSON.stringify({
					version: 1,
					monthToDateGard: 50000,
					currentShift: 30,
					bestRunTotal: 0,
					karenSeed: 1,
				}));
			});
			await page.goto('/library-game');
			await startShift(page);

			await page.evaluate(() => window.__libraryGameTestHooks.skipToClosing());
			await walkToStation(page, 'boss-office');

			await expect(page.locator('#library-paycheck-screen')).toHaveAttribute('data-final', 'true');
			await expect(page.locator('#library-final-paycheck-block')).toBeVisible();
			await expect(page.locator('#library-paycheck-new-month-button')).toBeVisible();

			await page.locator('#library-paycheck-name-input').fill(playerName);

			const [response] = await Promise.all([
				page.waitForResponse((r) => r.url().includes('/library-game/score') && r.request().method() === 'POST'),
				page.locator('#library-paycheck-submit-button').click(),
			]);
			expect(response.ok()).toBeTruthy();

			await expect(page.locator('#library-leaderboard')).toContainText(playerName);
		} finally {
			await deleteTestScore(playerName);
		}
	});
});

// First Person Mode (docs/features/library-game.md's Scope: added after the
// game shipped, per the user's explicit "seeing in first person and seeing
// anything but yourself"). Same "drive the real input path, use test hooks
// only for exact positioning/facing so the test isn't hostage to walking
// there via clicks" philosophy as the rest of this file:
// `setPlayerPosition`/`setPlayerFacing` put the player in a known spot near
// a station instead of navigating First Person's own turn/move controls to
// find it (which the "on-screen buttons and arrow keys" test below already
// covers on its own), then every interaction still goes through the real
// button click/keyboard path into the exact same `handleArrival` station
// logic Top-Down's click-to-move already uses.
test.describe('First Person Mode', () => {
	test('the camera toggle flips label/aria-pressed and shows/hides the First Person control cluster', async ({ page }) => {
		await page.goto('/library-game');
		await startShift(page);

		await expect(page.locator('#library-camera-button')).toHaveText('First Person');
		await expect(page.locator('#library-camera-button')).toHaveAttribute('aria-pressed', 'false');
		await expect(page.locator('#library-fp-controls')).toBeHidden();

		await page.locator('#library-camera-button').click();
		await expect(page.locator('#library-camera-button')).toHaveText('Top-Down View');
		await expect(page.locator('#library-camera-button')).toHaveAttribute('aria-pressed', 'true');
		await expect(page.locator('#library-fp-controls')).toBeVisible();

		await page.locator('#library-camera-button').click();
		await expect(page.locator('#library-camera-button')).toHaveText('First Person');
		await expect(page.locator('#library-fp-controls')).toBeHidden();
	});

	test("the player's own sprite is drawn every frame in Top-Down but never drawn in First Person", async ({ page }) => {
		await page.goto('/library-game');
		await startShift(page);

		await expect.poll(async () => page.evaluate(() => window.__libraryGameTestHooks.wasPlayerSpriteDrawnLastFrame())).toBe(true);

		await page.locator('#library-camera-button').click();
		await expect.poll(async () => page.evaluate(() => window.__libraryGameTestHooks.wasPlayerSpriteDrawnLastFrame())).toBe(false);

		// And back again — confirms this is a live per-frame flag reacting to
		// the toggle, not a one-time snapshot from shift start.
		await page.locator('#library-camera-button').click();
		await expect.poll(async () => page.evaluate(() => window.__libraryGameTestHooks.wasPlayerSpriteDrawnLastFrame())).toBe(true);
	});

	test('on-screen buttons and arrow keys both turn and move the player', async ({ page }) => {
		await page.goto('/library-game');
		await startShift(page);
		await page.locator('#library-camera-button').click();

		const initialFacing = await page.evaluate(() => window.__libraryGameTestHooks.getPlayerFacing());
		await page.locator('#library-fp-turn-right-button').dispatchEvent('pointerdown');
		await page.waitForTimeout(300);
		await page.locator('#library-fp-turn-right-button').dispatchEvent('pointerup');
		const afterButtonTurn = await page.evaluate(() => window.__libraryGameTestHooks.getPlayerFacing());
		expect(Math.abs(afterButtonTurn - initialFacing)).toBeGreaterThan(0.1);

		await page.keyboard.down('ArrowLeft');
		await page.waitForTimeout(300);
		await page.keyboard.up('ArrowLeft');
		const afterKeyTurn = await page.evaluate(() => window.__libraryGameTestHooks.getPlayerFacing());
		expect(Math.abs(afterKeyTurn - afterButtonTurn)).toBeGreaterThan(0.1);

		const beforeMove = await page.evaluate(() => window.__libraryGameTestHooks.getPlayerPosition());
		await page.locator('#library-fp-forward-button').dispatchEvent('pointerdown');
		await page.waitForTimeout(300);
		await page.locator('#library-fp-forward-button').dispatchEvent('pointerup');
		const afterButtonMove = await page.evaluate(() => window.__libraryGameTestHooks.getPlayerPosition());
		expect(Math.hypot(afterButtonMove.x - beforeMove.x, afterButtonMove.y - beforeMove.y)).toBeGreaterThan(5);

		await page.keyboard.down('ArrowDown');
		await page.waitForTimeout(300);
		await page.keyboard.up('ArrowDown');
		const afterKeyMove = await page.evaluate(() => window.__libraryGameTestHooks.getPlayerPosition());
		expect(Math.hypot(afterKeyMove.x - afterButtonMove.x, afterKeyMove.y - afterButtonMove.y)).toBeGreaterThan(5);
	});

	test('interacting with the Coffee Machine in First Person (via the Enter key) restores Sanity, same as Top-Down', async ({ page }) => {
		await page.goto('/library-game');
		await startShift(page);

		// Sanity drains passively (rules.js's SANITY_DRAIN_PER_SECOND) — wait
		// for that to be observable before checking the Coffee Machine
		// actually restores it, same setup as the Top-Down Coffee Machine test.
		await expect.poll(async () => page.evaluate(() => window.__libraryGameTestHooks.getShiftState().sanity)).toBeLessThan(100);

		await page.locator('#library-camera-button').click();
		const coffee = await getStation(page, 'coffee-machine');
		await page.evaluate(({ x, y }) => {
			window.__libraryGameTestHooks.setPlayerPosition(x, y + 60); // just south of it...
			window.__libraryGameTestHooks.setPlayerFacing(0); // ...facing north, i.e. looking straight at it.
		}, coffee);

		await expect.poll(async () => page.evaluate(() => window.__libraryGameTestHooks.getFirstPersonScene().interactTarget?.ref?.kind))
			.toBe('coffee-machine');

		await page.keyboard.press('Enter');

		const after = await page.evaluate(() => window.__libraryGameTestHooks.getShiftState().sanity);
		expect(after).toBeGreaterThan(99);
	});

	test('interacting with Stairs in First Person (via the on-screen Interact button) switches floors and resets to a sensible facing, same as Top-Down', async ({ page }) => {
		await page.goto('/library-game');
		await startShift(page);
		await page.locator('#library-camera-button').click();

		const stairs = await getStation(page, 'stairs');
		await page.evaluate(({ x, y }) => {
			window.__libraryGameTestHooks.setPlayerPosition(x, y + 60);
			window.__libraryGameTestHooks.setPlayerFacing(0);
		}, stairs);

		await expect.poll(async () => page.evaluate(() => window.__libraryGameTestHooks.getFirstPersonScene().interactTarget?.ref?.kind))
			.toBe('stairs');

		await page.locator('#library-fp-interact-button').click();

		expect(await page.evaluate(() => window.__libraryGameTestHooks.getCurrentFloor())).toBe(2);
		// FLOOR_2_ENTRY_POINT (floor-plan.js) is exactly the canvas center, so
		// `defaultFacingTowardCenter` from that same point resolves to exactly 0.
		const pos = await page.evaluate(() => window.__libraryGameTestHooks.getPlayerPosition());
		expect(pos.x).toBeCloseTo(480, 0);
		expect(pos.y).toBeCloseTo(300, 0);
		expect(await page.evaluate(() => window.__libraryGameTestHooks.getPlayerFacing())).toBeCloseTo(0, 5);
	});

	test('toggling back to Top-Down after First Person still supports normal click-to-move', async ({ page }) => {
		await page.goto('/library-game');
		await startShift(page);

		await page.locator('#library-camera-button').click(); // -> First Person
		await page.locator('#library-camera-button').click(); // -> back to Top-Down

		await expect.poll(async () => page.evaluate(() => window.__libraryGameTestHooks.getShiftState().sanity)).toBeLessThan(100);
		await walkToStation(page, 'coffee-machine');
		const sanity = await page.evaluate(() => window.__libraryGameTestHooks.getShiftState().sanity);
		expect(sanity).toBeGreaterThan(99);
	});
});

// Regression test for the same class of bug documented in cooking-game.js's
// bootstrap()/fishing-game.spec.js's own revisit test: a `<script
// type="module">`'s top-level code runs at most once per resolved URL for
// the page's whole lifetime, so a second HTMX-driven visit to /library-game
// in the same tab (navigate away, then back) risks leaving the freshly
// swapped-in canvas/start screen visually present but completely inert.
// Drives the exact real-world path: /projects → Play now → back to
// /projects → Play now again, all via HTMX, no full page reload in between.
test.describe('revisiting via HTMX after navigating away', () => {
	test('a second HTMX visit in the same tab still renders and stays fully interactive', async ({ page }) => {
		await page.goto('/projects');
		const playNow = () => page.locator('.project-card').filter({ hasText: 'Library Shift' }).getByRole('link', { name: 'Play now' });
		const projectsLink = () => page.locator('#primary-nav').getByRole('link', { name: 'Projects', exact: true });

		await playNow().click();
		await expect(page.locator('#library-canvas')).toBeVisible();

		await projectsLink().click();
		await expect(page).toHaveURL(/\/projects$/);

		await playNow().click();
		await expect(page.locator('#library-canvas')).toBeVisible();

		// The real bug this guards against left the canvas/start screen visible
		// but inert — assert actual interactivity on this second-visit
		// instance, not just presence.
		await expect(page.locator('#library-start-screen')).toBeVisible();
		await startShift(page);
		await expect(page.locator('#library-start-screen')).toBeHidden();
		await expect(page.locator('#library-hud-shift')).toHaveText('1/30');
	});
});

// Testing Plan: "No console errors... zero console errors" — same pattern
// as every other game spec in this repo.
test('no console errors on load and during play, including no CSP violations', async ({ page }) => {
	const errors = [];
	page.on('console', (msg) => {
		if (msg.type() === 'error') errors.push(msg.text());
	});
	page.on('pageerror', (err) => errors.push(String(err)));

	await page.goto('/library-game');
	await startShift(page);
	await page.evaluate(() => {
		window.__libraryGameTestHooks.spawnBookNow(false);
		window.__libraryGameTestHooks.spawnFineNow(30);
		window.__libraryGameTestHooks.spawnBorrowNow();
	});
	await page.waitForTimeout(500);
	await page.locator('#library-floor-button').click();
	await page.waitForTimeout(200);
	await page.locator('#library-floor-button').click();
	await page.waitForTimeout(200);
	await page.locator('#library-fullscreen-button').click();
	await page.waitForTimeout(200);

	// First Person Mode: toggle in, exercise its turn/move/interact controls
	// for a few frames, then toggle back out.
	await page.locator('#library-camera-button').click();
	await page.locator('#library-fp-turn-right-button').dispatchEvent('pointerdown');
	await page.waitForTimeout(150);
	await page.locator('#library-fp-turn-right-button').dispatchEvent('pointerup');
	await page.locator('#library-fp-forward-button').dispatchEvent('pointerdown');
	await page.waitForTimeout(150);
	await page.locator('#library-fp-forward-button').dispatchEvent('pointerup');
	await page.locator('#library-fp-interact-button').click();
	await page.waitForTimeout(200);
	await page.locator('#library-camera-button').click();

	expect(errors).toEqual([]);
});
