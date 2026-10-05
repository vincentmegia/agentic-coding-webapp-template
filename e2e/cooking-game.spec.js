// /kitchen-shift's v4 additions (docs/features/cooking-game.md's Status:
// the Library-style art pass, the Rice Station, Karen's shift-18 rematch,
// and the four mechanics ported from Library Shift — Coffee Pour,
// low-Sanity hallucinations, 0-Reputation penalties, the Gard counter).
// The page's older behavior (HTMX nav, revisit wiring) stays covered in
// e2e/projects.spec.js.
//
// Same approach as e2e/library-game.spec.js: every interaction goes
// through the real click-to-walk-then-act path, with
// `window.__cookingGameTestHooks` supplying exact station positions and
// skipping only the randomly-timed waits (a customer's walk-in, the slow
// Sanity/Reputation drains) — never the interaction itself.
const { test, expect } = require('@playwright/test');

const STORAGE_KEY = 'cooking-game:v2';

// These tests walk the player around in real time (several station trips
// each); under a full parallel run WebKit can need more than the default
// 30 s, so give every test here a minute.
test.describe.configure({ timeout: 60_000 });

/** Seeds localStorage so the page loads straight into `shift` with the one-time intro already seen. */
async function seedSave(page, shift, extra = {}) {
	await page.addInitScript(({ key, save }) => {
		window.localStorage.setItem(key, JSON.stringify(save));
	}, {
		key: STORAGE_KEY,
		save: { version: 1, monthToDateGard: 0, currentShift: shift, gear: {}, bestMonthTotal: 0, hasSeenIntro: true, ...extra },
	});
}

async function startShift(page, shift = 1) {
	await seedSave(page, shift);
	await page.goto('/kitchen-shift');
	await page.locator('#cooking-start-shift-button').click();
	await page.waitForFunction(() => window.__cookingGameTestHooks?.getShiftState()?.phase === 'playing');
	await waitForStableCanvas(page);
}

/**
 * "Start Shift" requests fullscreen, which resizes the canvas a moment
 * later. A click aimed from a bounding box read mid-transition lands on
 * the wrong world point (a real flake, most visible under parallel load),
 * so wait until two reads 150 ms apart agree.
 */
async function waitForStableCanvas(page) {
	let previous = null;
	for (let i = 0; i < 20; i++) {
		const box = await page.locator('#cooking-canvas').boundingBox();
		if (previous && Math.abs(box.width - previous.width) < 0.5 && Math.abs(box.height - previous.height) < 0.5
			&& Math.abs(box.x - previous.x) < 0.5 && Math.abs(box.y - previous.y) < 0.5) return;
		previous = box;
		await page.waitForTimeout(150);
	}
}

/** Canvas-space (960x600) to page coordinates — letterbox-aware, the inverse of cooking-game.js's canvasCoordsFromEvent (see library-game.spec.js's identical helper for why fullscreen makes this necessary). */
async function canvasToPage(page, point) {
	const box = await page.locator('#cooking-canvas').boundingBox();
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

async function waitUntilArrived(page) {
	await page.waitForFunction(() => window.__cookingGameTestHooks.isPlayerMoving() === false, null, { timeout: 15000 });
}

/** Clicks a station by id (switching rooms first if needed) and waits for the walk + arrival to finish. */
async function walkToStation(page, id) {
	const station = await page.evaluate((stationId) => window.__cookingGameTestHooks.stationPosition(stationId), id);
	const room = await page.evaluate(() => window.__cookingGameTestHooks.getRoom());
	if (station.room !== room) await page.locator('#cooking-room-button').click();
	const p = await canvasToPage(page, station);
	await page.mouse.click(p.x, p.y);
	await waitUntilArrived(page);
}

async function clickCanvasPoint(page, point) {
	const p = await canvasToPage(page, point);
	await page.mouse.click(p.x, p.y);
}

/** Walks to a waiting customer's table, then writes their order down on the order pad by clicking the dish they asked for. */
async function takeOrder(page, tableId) {
	await walkToStation(page, `table-${tableId}`);
	await page.waitForFunction(() => window.__cookingGameTestHooks.getOrderPad() !== null, null, { timeout: 5000 });
	const pad = await page.evaluate(() => window.__cookingGameTestHooks.getOrderPad());
	const rows = await page.evaluate(() => window.__cookingGameTestHooks.orderPadRows());
	await clickCanvasPoint(page, rows.find((r) => r.name === pad.dishName));
	await page.waitForFunction(() => window.__cookingGameTestHooks.getOrderPad() === null);
}

async function pickFromPanel(page, item) {
	await expect(page.locator('#cooking-station-panel')).toBeVisible();
	await page.locator('#cooking-station-panel-list button', { hasText: item }).first().click();
	await page.locator('#cooking-station-panel-close-button').click();
}

const hooks = (page, fn, arg) => page.evaluate(fn, arg);

test.describe('order pad', () => {
	test('arriving at a waiting customer opens the pad; the right pick places the order', async ({ page }) => {
		await startShift(page, 11);
		const tableId = await hooks(page, () => window.__cookingGameTestHooks.freeTableId());
		await hooks(page, (id) => window.__cookingGameTestHooks.seatCustomerNow(id, 'Pasta'), tableId);
		await walkToStation(page, `table-${tableId}`);
		const pad = await hooks(page, () => window.__cookingGameTestHooks.getOrderPad());
		expect(pad).toMatchObject({ tableId, dishName: 'Pasta' });
		expect(pad.choices).toHaveLength(4);
		expect(pad.choices).toContain('Pasta');
		// Nothing is ordered until it's written down.
		expect((await hooks(page, () => window.__cookingGameTestHooks.getShiftState())).orders).toHaveLength(0);

		const rows = await hooks(page, () => window.__cookingGameTestHooks.orderPadRows());
		await clickCanvasPoint(page, rows.find((r) => r.name === 'Pasta'));
		await expect.poll(() => hooks(page, () => window.__cookingGameTestHooks.getOrderPad())).toBeNull();
		const order = (await hooks(page, () => window.__cookingGameTestHooks.getShiftState())).orders[0];
		expect(order).toMatchObject({ tableId, dishName: 'Pasta', customerSanityRemaining: 100 });
		await expect(page.locator('#cooking-toast')).toContainText('Wrote down: Pasta');
	});

	test('a wrong pick is crossed out and costs an annoyance; number keys pick too', async ({ page }) => {
		await startShift(page, 11);
		const tableId = await hooks(page, () => window.__cookingGameTestHooks.freeTableId());
		await hooks(page, (id) => window.__cookingGameTestHooks.seatCustomerNow(id, 'Pasta'), tableId);
		await walkToStation(page, `table-${tableId}`);
		const pad = await hooks(page, () => window.__cookingGameTestHooks.getOrderPad());
		const wrongIndex = pad.choices.findIndex((name) => name !== 'Pasta');
		await page.keyboard.press(String(wrongIndex + 1));
		expect((await hooks(page, () => window.__cookingGameTestHooks.getOrderPad())).wrong).toEqual([pad.choices[wrongIndex]]);
		await expect(page.locator('#cooking-toast')).toContainText('No, I said the Pasta');

		await page.keyboard.press(String(pad.choices.indexOf('Pasta') + 1));
		await expect.poll(() => hooks(page, () => window.__cookingGameTestHooks.getOrderPad())).toBeNull();
		const order = (await hooks(page, () => window.__cookingGameTestHooks.getShiftState())).orders[0];
		expect(order.customerSanityRemaining).toBe(75);
	});

	// The ✕ rather than Escape: in fullscreen, Safari (WebKit) spends
	// Escape on exiting fullscreen and the page never receives it.
	test('the ✕ walks away without taking the order', async ({ page }) => {
		await startShift(page, 11);
		const tableId = await hooks(page, () => window.__cookingGameTestHooks.freeTableId());
		await hooks(page, (id) => window.__cookingGameTestHooks.seatCustomerNow(id, 'Pasta'), tableId);
		await walkToStation(page, `table-${tableId}`);
		await clickCanvasPoint(page, await hooks(page, () => window.__cookingGameTestHooks.orderPadClosePoint()));
		expect(await hooks(page, () => window.__cookingGameTestHooks.getOrderPad())).toBeNull();
		expect((await hooks(page, () => window.__cookingGameTestHooks.getShiftState())).orders).toHaveLength(0);
	});
});

test.describe('picking up ingredients', () => {
	// Regression: the toast used to live outside #cooking-game-container
	// (the fullscreen target), so in fullscreen "Tray full" was invisible
	// and a full tray made the Fridge/Cabinet look broken.
	test('toasts render inside the fullscreen container, and a full tray says so in the panel', async ({ page }) => {
		await startShift(page);
		await expect(page.locator('#cooking-game-container #cooking-toast')).toHaveCount(1);
		await expect(page.locator('#cooking-game-container #cooking-interact-hint')).toHaveCount(1);

		await walkToStation(page, 'fridge');
		await expect(page.locator('#cooking-station-panel-tray')).toHaveText('Tray: 0/3');
		for (const item of ['Cheese', 'Milk', 'Egg']) {
			await page.locator('#cooking-station-panel-list button', { hasText: item }).first().click();
		}
		await expect(page.locator('#cooking-station-panel-tray')).toContainText('Tray full (3/3)');
		await expect(page.locator('#cooking-station-panel-list button', { hasText: 'Lettuce' })).toBeDisabled();
		expect((await hooks(page, () => window.__cookingGameTestHooks.getHeld())).inventory).toEqual(['Cheese', 'Milk', 'Egg']);
	});
});

test.describe('serving food', () => {
	async function seatAndOrder(page, dish) {
		const tableId = await hooks(page, () => window.__cookingGameTestHooks.freeTableId());
		await hooks(page, ([id, d]) => window.__cookingGameTestHooks.seatCustomerNow(id, d), [tableId, dish]);
		await takeOrder(page, tableId);
		return tableId;
	}

	test('the right dish is served with a confirmation', async ({ page }) => {
		await startShift(page);
		const tableId = await seatAndOrder(page, 'Garden Salad');
		await hooks(page, () => window.__cookingGameTestHooks.setHeldDish('Garden Salad'));
		await walkToStation(page, `table-${tableId}`);
		await expect(page.locator('#cooking-toast')).toContainText(`Served Garden Salad to Table ${tableId}`);
		expect((await hooks(page, () => window.__cookingGameTestHooks.getShiftState())).orders).toHaveLength(0);
	});

	test('a wrong dish says what they actually wanted', async ({ page }) => {
		await startShift(page);
		const tableId = await seatAndOrder(page, 'Garden Salad');
		await hooks(page, () => window.__cookingGameTestHooks.setHeldDish('Grilled Cheese'));
		await walkToStation(page, `table-${tableId}`);
		await expect(page.locator('#cooking-toast')).toContainText('wanted Garden Salad');
	});

	test('the Trash Bin throws away a late order (and loose ingredients), but never cookware', async ({ page }) => {
		await startShift(page);
		await hooks(page, () => window.__cookingGameTestHooks.setHeldDish('Burger'));
		await walkToStation(page, 'trash-dining');
		await expect(page.locator('#cooking-toast')).toContainText('Tossed Burger in the trash');
		expect((await hooks(page, () => window.__cookingGameTestHooks.getHeld())).heldDish).toBeNull();

		await walkToStation(page, 'cookware-closet');
		await pickFromPanel(page, 'Pan');
		await walkToStation(page, 'fridge');
		await pickFromPanel(page, 'Cheese');
		await walkToStation(page, 'trash-kitchen');
		await expect(page.locator('#cooking-toast')).toContainText('Tossed Cheese in the trash');
		const held = await hooks(page, () => window.__cookingGameTestHooks.getHeld());
		expect(held.inventory).toEqual([]);
		expect(held.cookware).toEqual(['Pan']);

		await walkToStation(page, 'trash-kitchen');
		await expect(page.locator('#cooking-toast')).toContainText('Nothing on your tray');
	});

	test('a customer who runs out of patience says so, and bringing food afterwards explains why nothing happens', async ({ page }) => {
		await startShift(page);
		const tableId = await seatAndOrder(page, 'Garden Salad');
		await hooks(page, () => {
			const h = window.__cookingGameTestHooks;
			h.setShiftStats({ orders: h.getShiftState().orders.map((o) => ({ ...o, patienceRemainingSeconds: 0.01 })) });
		});
		await expect(page.locator('#cooking-toast')).toContainText(`Table ${tableId} got tired of waiting and left`);
		await hooks(page, () => window.__cookingGameTestHooks.setHeldDish('Garden Salad'));
		await walkToStation(page, `table-${tableId}`);
		await expect(page.locator('#cooking-toast')).toContainText(`Nobody at Table ${tableId} is waiting for food`);
	});
});

test.describe("Duke's office", () => {
	test('locked during the shift; open from 11:30 PM, paying straight away with skipped chores docked', async ({ page }) => {
		await startShift(page);
		await walkToStation(page, 'boss-office');
		await expect(page.locator('#cooking-toast')).toContainText('opens at 11:30 PM');
		await expect(page.locator('#cooking-paycheck-screen')).toBeHidden();

		// Serve one customer so a dirty table is left behind.
		const tableId = await hooks(page, () => window.__cookingGameTestHooks.freeTableId());
		await hooks(page, (id) => window.__cookingGameTestHooks.seatCustomerNow(id, 'Garden Salad'), tableId);
		await takeOrder(page, tableId);
		await hooks(page, () => window.__cookingGameTestHooks.setHeldDish('Garden Salad'));
		await walkToStation(page, `table-${tableId}`);

		await hooks(page, () => window.__cookingGameTestHooks.endClock());
		// Jumping the whole clock at once also leaves the player at 0 Sanity
		// for most of it (a real −30% hallucination cut) — clear that so this
		// checks only the chore penalties.
		await hooks(page, () => window.__cookingGameTestHooks.setShiftStats({ zeroSanitySeconds: 0, zeroReputationSeconds: 0 }));
		await expect(page.locator('#cooking-toast')).toContainText('closing time');
		await walkToStation(page, 'boss-office');
		await expect(page.locator('#cooking-paycheck-screen')).toBeVisible();
		await expect(page.locator('#cooking-paycheck-outcome')).toContainText('skipped chores: 1 dirty table, unwashed dishes, no shutdown (−300g)');
		await expect(page.locator('#cooking-paycheck-shift-total')).toHaveText('3700 Gard');
	});
});

test.describe('closing chores in any order', () => {
	test('shutting down at the Counter works right away after 11:30, with leftover chores docked', async ({ page }) => {
		await startShift(page);
		const tableId = await hooks(page, () => window.__cookingGameTestHooks.freeTableId());
		await hooks(page, (id) => window.__cookingGameTestHooks.seatCustomerNow(id, 'Garden Salad'), tableId);
		await takeOrder(page, tableId);
		await hooks(page, () => window.__cookingGameTestHooks.setHeldDish('Garden Salad'));
		await walkToStation(page, `table-${tableId}`);
		await hooks(page, () => window.__cookingGameTestHooks.endClock());
		await hooks(page, () => window.__cookingGameTestHooks.setShiftStats({ zeroSanitySeconds: 0, zeroReputationSeconds: 0 }));

		// Wash the dishes before touching the dirty table — allowed now.
		await walkToStation(page, 'cleaning-closet');
		await expect.poll(() => hooks(page, () => window.__cookingGameTestHooks.getShiftState().dishesWashed), { timeout: 5000 }).toBe(true);

		await walkToStation(page, 'counter');
		await expect(page.locator('#cooking-toast')).toContainText('Restaurant shut down. Still undone: 1 dirty table');
		expect((await hooks(page, () => window.__cookingGameTestHooks.getShiftState())).phase).toBe('paycheck');

		await walkToStation(page, 'boss-office');
		await expect(page.locator('#cooking-paycheck-outcome')).toContainText('skipped chores: 1 dirty table (−50g)');
	});
});

test.describe('order notepad', () => {
	test('written orders show on the side notepad; clicking one makes it the active order', async ({ page }) => {
		await startShift(page, 11);
		const notepad = page.locator('#cooking-order-notepad');
		await expect(notepad).toBeVisible();
		await expect(notepad).toContainText('No orders yet');

		const first = await hooks(page, () => window.__cookingGameTestHooks.freeTableId());
		await hooks(page, (id) => window.__cookingGameTestHooks.seatCustomerNow(id, 'Pasta'), first);
		// A waiting customer is listed by table only — never by dish, which
		// is what the order pad asks you to catch.
		await expect(page.locator('#cooking-order-waiting')).toContainText(`T${first}`);
		await expect(page.locator('#cooking-order-waiting')).not.toContainText('Pasta');
		await takeOrder(page, first);
		const second = await hooks(page, () => window.__cookingGameTestHooks.freeTableId());
		await hooks(page, (id) => window.__cookingGameTestHooks.seatCustomerNow(id, 'Burger'), second);
		await takeOrder(page, second);

		const tickets = page.locator('#cooking-order-queue [data-order-table]');
		await expect(tickets).toHaveCount(2);
		await expect(page.locator(`[data-order-table="${first}"]`)).toContainText('Pasta');
		await expect(page.locator(`[data-order-table="${second}"]`)).toHaveAttribute('aria-pressed', 'true');

		await page.locator(`[data-order-table="${first}"]`).click();
		await expect(page.locator(`[data-order-table="${first}"]`)).toHaveAttribute('aria-pressed', 'true');
		expect((await hooks(page, () => window.__cookingGameTestHooks.getHeld())).activeOrderTableId).toBe(first);
		// Switching from the notepad isn't a table re-visit — no annoyance.
		const order = (await hooks(page, () => window.__cookingGameTestHooks.getShiftState())).orders.find((o) => o.tableId === first);
		expect(order.customerSanityRemaining).toBe(100);
	});
});

test.describe('Rice Station', () => {
	test('the Recipe Book lists both rice dishes, and Chicken Rice cooks at the Rice Station with the Rice Cooker', async ({ page }) => {
		await startShift(page, 11);
		await page.locator('#cooking-recipe-book-button').click();
		await expect(page.locator('#cooking-recipe-book-list')).toContainText('Chicken Rice');
		await expect(page.locator('#cooking-recipe-book-list')).toContainText('Omurice');
		await expect(page.locator('#cooking-recipe-book-list')).toContainText('Rice Station + Rice Cooker');
		await page.locator('#cooking-recipe-book-close-button').click();

		const tableId = await hooks(page, () => window.__cookingGameTestHooks.freeTableId());
		await hooks(page, (id) => window.__cookingGameTestHooks.seatCustomerNow(id, 'Chicken Rice'), tableId);
		await takeOrder(page, tableId);
		expect((await hooks(page, () => window.__cookingGameTestHooks.getHeld())).activeOrderTableId).toBe(tableId);

		// Arriving without the Rice Cooker explains what's missing.
		await walkToStation(page, 'rice-station');
		await expect(page.locator('#cooking-toast')).toContainText('Rice Cooker');

		await walkToStation(page, 'cookware-closet');
		await pickFromPanel(page, 'Rice Cooker');
		await walkToStation(page, 'cabinet');
		await page.locator('#cooking-station-panel-list button', { hasText: 'Rice' }).first().click();
		await page.locator('#cooking-station-panel-list button', { hasText: 'Herbs' }).first().click();
		await page.locator('#cooking-station-panel-close-button').click();
		await walkToStation(page, 'fridge');
		await pickFromPanel(page, 'Chicken');

		await walkToStation(page, 'rice-station');
		await expect(page.locator('#cooking-gauge')).toBeVisible();
		await hooks(page, () => window.__cookingGameTestHooks.setCookGauge(0.5));
		await page.locator('#cooking-gauge-button').click();
		await expect.poll(() => hooks(page, () => window.__cookingGameTestHooks.getHeld().heldDish)).toBe('Chicken Rice');
	});
});

test.describe("Karen's shift-18 rematch", () => {
	test('she remembers you: the rematch line, shorter patience, and a bigger tip on a correct serve', async ({ page }) => {
		test.setTimeout(60000);
		await startShift(page, 18);
		const encounter = await hooks(page, () => window.__cookingGameTestHooks.getKarenEncounter());
		expect(encounter).toMatchObject({ rematch: true, patienceSeconds: 9, tipGard: 250 });

		await page.waitForFunction(() => window.__cookingGameTestHooks.getKaren() !== null, null, { timeout: 30000 });
		await expect(page.locator('#cooking-toast')).toContainText('YOU AGAIN');
		const { tableId } = await hooks(page, () => window.__cookingGameTestHooks.getKaren());
		// Regression: she must sit at a table Tier 2 has actually unlocked
		// (tables 1-18 — see floor-plan.js's isTableUnlocked).
		expect(tableId).toBeLessThanOrEqual(18);

		await takeOrder(page, tableId);
		const order = await hooks(page, (id) => window.__cookingGameTestHooks.getShiftState().orders.find((o) => o.tableId === id), tableId);
		expect(order.patienceMaxSeconds).toBeLessThanOrEqual(9);

		await hooks(page, (dish) => window.__cookingGameTestHooks.setHeldDish(dish), order.dishName);
		await walkToStation(page, `table-${tableId}`);
		await expect.poll(() => hooks(page, () => window.__cookingGameTestHooks.getShiftState().bonusGard)).toBe(250);
	});
});

test.describe('Coffee Machine (Coffee Pour minigame)', () => {
	test('arriving opens the pour instead of refilling instantly; a perfect pour refills Sanity and tips 10g', async ({ page }) => {
		await startShift(page);
		await hooks(page, () => window.__cookingGameTestHooks.setShiftStats({ sanity: 30 }));
		await walkToStation(page, 'coffee-machine');
		const pour = await hooks(page, () => window.__cookingGameTestHooks.getCoffeePour());
		expect(pour).not.toBeNull();
		expect(pour.grade).toBeNull();

		const center = await canvasToPage(page, { x: 480, y: 300 });
		await page.mouse.move(center.x, center.y);
		await page.mouse.down();
		const target = (pour.band.min + pour.band.max) / 2;
		await hooks(page, (fill) => window.__cookingGameTestHooks.setCoffeePourFill(fill), target);
		await page.mouse.up();

		await expect.poll(() => hooks(page, () => window.__cookingGameTestHooks.getShiftState().bonusGard)).toBe(10);
		expect(await hooks(page, () => window.__cookingGameTestHooks.getShiftState().sanity)).toBeGreaterThan(95);
		await expect.poll(() => hooks(page, () => window.__cookingGameTestHooks.getCoffeePour())).toBeNull();
	});

	test('holding Space until it overflows spills all over you: −50 Sanity and coffee stains', async ({ page }) => {
		await startShift(page);
		await walkToStation(page, 'coffee-machine');
		await page.keyboard.down(' ');
		await hooks(page, () => window.__cookingGameTestHooks.setCoffeePourFill(0.99));
		await expect.poll(() => hooks(page, () => window.__cookingGameTestHooks.getCoffeePour()?.grade)).toBe('spilled');
		await page.keyboard.up(' ');
		const sanity = await hooks(page, () => window.__cookingGameTestHooks.getShiftState().sanity);
		expect(sanity).toBeLessThan(55);
		expect(await hooks(page, () => window.__cookingGameTestHooks.getCoffeeSplashSeconds())).toBeGreaterThan(0);
		await expect(page.locator('#cooking-toast')).toContainText('Hot coffee');
	});
});

test.describe('hallucinations', () => {
	test('at 0 Sanity: full intensity, a ghost customer startles you, and the cook gauge gets narrower', async ({ page }) => {
		await startShift(page, 11);
		await hooks(page, () => window.__cookingGameTestHooks.setShiftStats({ sanity: 0 }));
		expect((await hooks(page, () => window.__cookingGameTestHooks.getHallucinations())).intensity).toBe(1);

		const ghost = await hooks(page, () => window.__cookingGameTestHooks.spawnGhostNow());
		await walkToStation(page, `table-${ghost.tableId}`);
		await expect(page.locator('#cooking-toast')).toContainText("there's no one there");
		const after = await hooks(page, () => window.__cookingGameTestHooks.getHallucinations());
		expect(after.ghosts.find((g) => g.id === ghost.id)).toBeUndefined();

		// Shaky hands: the Stove's success window is half its normal width.
		// Gather at full Sanity (so nothing gets dropped on the way), then
		// drop to 0 just before walking to the Stove.
		await hooks(page, () => window.__cookingGameTestHooks.setShiftStats({ sanity: 100 }));
		const tableId = await hooks(page, () => window.__cookingGameTestHooks.freeTableId());
		await hooks(page, (id) => window.__cookingGameTestHooks.seatCustomerNow(id, 'Grilled Cheese'), tableId);
		await takeOrder(page, tableId);
		await walkToStation(page, 'cookware-closet');
		await pickFromPanel(page, 'Pan');
		await walkToStation(page, 'cabinet');
		await pickFromPanel(page, 'Bread');
		await walkToStation(page, 'fridge');
		await pickFromPanel(page, 'Cheese');
		await hooks(page, () => window.__cookingGameTestHooks.setShiftStats({ sanity: 0 }));
		await walkToStation(page, 'stove');
		const zone = await hooks(page, () => window.__cookingGameTestHooks.getCookZone());
		// At 0 Sanity, shaky hands can (randomly, by design) drop an
		// ingredient on that last walk, in which case no gauge opens.
		test.skip(zone === null, 'shaky hands dropped an ingredient on the way to the Stove');
		expect(zone.end - zone.start).toBeCloseTo(0.08, 5);
	});
});

test.describe('zero Reputation', () => {
	test('a customer storms out and a complaint letter docks Gard while Reputation is at 0', async ({ page }) => {
		await startShift(page);
		const tableId = await hooks(page, () => window.__cookingGameTestHooks.freeTableId());
		await hooks(page, (id) => window.__cookingGameTestHooks.seatCustomerNow(id, 'Garden Salad'), tableId);
		await takeOrder(page, tableId);
		await hooks(page, () => window.__cookingGameTestHooks.setShiftStats({ reputation: 0, reputationStormTimer: 19.9, zeroReputationSeconds: 29.9 }));

		await expect.poll(() => hooks(page, () => window.__cookingGameTestHooks.getShiftState().stormOuts)).toBe(1);
		const state = await hooks(page, () => window.__cookingGameTestHooks.getShiftState());
		expect(state.complaints).toBe(1);
		expect(state.orders.find((o) => o.tableId === tableId)).toBeUndefined();
		expect(await hooks(page, () => window.__cookingGameTestHooks.getNetShiftGard())).toBe(-25);

		// The paycheck itemizes the complaint. Reputation goes back up first:
		// skipToClosing ticks the whole shift clock in one go, which at 0
		// Reputation would (correctly) pile up ~10 more complaint letters.
		await hooks(page, () => window.__cookingGameTestHooks.setShiftStats({ reputation: 50 }));
		await hooks(page, () => window.__cookingGameTestHooks.skipToClosing());
		await hooks(page, () => window.__cookingGameTestHooks.collectPaycheck());
		await expect(page.locator('#cooking-paycheck-outcome')).toContainText('1 complaint letter (−25g)');
	});
});

test.describe('Gard counter', () => {
	test('earning Gard pops a "+N g" and the counter tracks it', async ({ page }) => {
		await startShift(page);
		await hooks(page, () => window.__cookingGameTestHooks.setShiftStats({ bonusGard: 40 }));
		await expect.poll(() => hooks(page, () => window.__cookingGameTestHooks.getGardPops().length)).toBe(1);
		const pops = await hooks(page, () => window.__cookingGameTestHooks.getGardPops());
		expect(pops[0].amount).toBe(40);
		expect(await hooks(page, () => window.__cookingGameTestHooks.getNetShiftGard())).toBe(40);
	});
});

test('no console errors on load and during play, including no CSP violations', async ({ page }) => {
	const errors = [];
	page.on('pageerror', (e) => errors.push(String(e)));
	page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
	await startShift(page, 21);
	await hooks(page, () => window.__cookingGameTestHooks.setShiftStats({ sanity: 0, reputation: 0 }));
	await page.locator('#cooking-room-button').click();
	await page.waitForTimeout(1500);
	await page.locator('#cooking-room-button').click();
	await page.waitForTimeout(1500);
	expect(errors).toEqual([]);
});
