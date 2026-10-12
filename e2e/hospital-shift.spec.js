// /hospital-shift: canvas game shell, the ER loop (triage → bed treatments
// → discharge), Karen, coffee, hallucinations, handover/paycheck and the
// Postgres leaderboard (docs/features/hospital-shift.md). The shift clock
// runs 6–10 real minutes and arrivals are random, so — like
// library-game.spec.js — every test drives the real click/key paths but
// takes exact coordinates and forced spawns from
// `window.__hospitalShiftTestHooks`.
const { test, expect } = require('@playwright/test');
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

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

// Throwaway leaderboard rows must be cleaned up: the dev Postgres is the
// real leaderboard (see fishing-game.spec.js).
function testPlayerName() {
	return `e2e-${Date.now() % 1_000_000}`;
}

async function deleteTestScore(playerName) {
	const client = new Client({ connectionString: databaseURL() });
	await client.connect();
	try {
		await client.query('DELETE FROM hospital_scores WHERE player_name = $1', [playerName]);
	} finally {
		await client.end();
	}
}

/** Seeds the save at a given shift (5+ so surgery cases can arrive). */
async function seedSave(page, currentShift = 5, monthToDateGard = 0) {
	await page.addInitScript(({ shift, gard }) => {
		window.localStorage.setItem('hospital-game:v1', JSON.stringify({
			version: 1, monthToDateGard: gard, currentShift: shift, bestRunTotal: 0, karenSeed: 1,
		}));
	}, { shift: currentShift, gard: monthToDateGard });
}

async function startShift(page) {
	await page.locator('#hospital-start-shift-button').click();
	await page.waitForFunction(() => window.__hospitalShiftTestHooks?.getShiftState()?.phase === 'playing');
}

const hooks = (page, name, ...args) => page.evaluate(([n, a]) => window.__hospitalShiftTestHooks[n](...a), [name, args]);

/** Canvas world point -> page point, letterbox-aware (fullscreen engages on Start Shift). */
async function canvasToPage(page, point) {
	const box = await page.locator('#hospital-canvas').boundingBox();
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
	return { x: box.x + offsetX + (point.x / 960) * contentWidth, y: box.y + offsetY + (point.y / 600) * contentHeight };
}

async function clickCanvasPoint(page, point) {
	const p = await canvasToPage(page, point);
	await page.mouse.click(p.x, p.y);
}

async function waitUntilArrived(page) {
	await page.waitForFunction(() => window.__hospitalShiftTestHooks.isPlayerMoving() === false, null, { timeout: 10000 });
}

/** A station on the player's current floor (Stairs/Elevator exist on both). */
async function station(page, kind, bedIndex) {
	const stations = await hooks(page, 'getStations');
	const floor = await hooks(page, 'getCurrentFloor');
	const matches = stations.filter((s) => s.kind === kind && (bedIndex === undefined || s.bedIndex === bedIndex));
	return matches.find((s) => s.floor === floor) || matches[0];
}

/** Up the Stairs to the Supply Room, take a bandage roll, back down in the Elevator. */
async function fetchBandageRoll(page) {
	await walkTo(page, 'stairs');
	expect(await hooks(page, 'getCurrentFloor')).toBe(2);
	await walkTo(page, 'supply-cart');
	expect((await shiftState(page)).hasBandage).toBe(true);
	await walkTo(page, 'elevator');
	expect(await hooks(page, 'getCurrentFloor')).toBe(1);
}

async function walkTo(page, kind, bedIndex) {
	await clickCanvasPoint(page, await station(page, kind, bedIndex));
	await waitUntilArrived(page);
}

async function waitForOverlay(page, kind) {
	await page.waitForFunction((k) => window.__hospitalShiftTestHooks.getOverlay()?.kind === k, kind, { timeout: 10000 });
	return hooks(page, 'getOverlay');
}

async function shiftState(page) {
	return hooks(page, 'getShiftState');
}

async function bedOf(page, patientId) {
	const s = await shiftState(page);
	return s.beds.findIndex((b) => b?.id === patientId);
}

/** Spawns a patient with a known condition and triages them correctly via the real click path; returns [id, bedIndex]. */
async function admit(page, conditionId, level) {
	const id = await hooks(page, 'spawnPatientNow', conditionId);
	const slot = (await hooks(page, 'getTriageSlots')).find((s) => s.id === id);
	await clickCanvasPoint(page, { x: slot.x, y: slot.y - 20 });
	await waitUntilArrived(page);
	const overlay = await waitForOverlay(page, 'triage');
	expect(overlay.patientId).toBe(id);
	await page.keyboard.press(String({ red: 1, yellow: 2, green: 3 }[level]));
	await page.waitForFunction((pid) => window.__hospitalShiftTestHooks.getShiftState().beds.some((b) => b?.id === pid), id);
	return [id, await bedOf(page, id)];
}

/** Passes the open skill check (gauge parked in the gold zone, then sampled with Space). */
async function passSkillCheck(page) {
	await hooks(page, 'setSkillGauge', 0.5);
	await page.keyboard.press('Space');
}

test.describe('/hospital-shift page', () => {
	test('renders canvas, HUD and start screen with the paycheck hidden', async ({ page }) => {
		await page.goto('/hospital-shift');
		await expect(page.locator('h1')).toHaveText('Hospital Shift');
		await expect(page.locator('#hospital-canvas')).toBeVisible();
		await expect(page.locator('#hospital-start-screen')).toBeVisible();
		await expect(page.locator('#hospital-paycheck-screen')).toBeHidden();
		await expect(page.locator('#hospital-hud-clock')).toHaveText('--:--');
	});

	test('leaderboard fragment loads', async ({ page }) => {
		await page.goto('/hospital-shift');
		await expect(page.locator('#hospital-leaderboard')).not.toContainText('Loading leaderboard');
	});

	test('Start Shift begins at 7 AM', async ({ page }) => {
		await page.goto('/hospital-shift');
		await startShift(page);
		await expect(page.locator('#hospital-start-screen')).toBeHidden();
		await expect(page.locator('#hospital-hud-shift')).toHaveText('1/30');
		await expect(page.locator('#hospital-hud-clock')).toHaveText(/^7:0\d AM$/);
	});
});

test.describe('triage', () => {
	test('a correct call beds the patient with no mistake; a wrong one is corrected and counted', async ({ page }) => {
		await seedSave(page);
		await page.goto('/hospital-shift');
		await startShift(page);
		const [, bed] = await admit(page, 'asthma', 'red');
		expect(bed).toBeGreaterThanOrEqual(0);
		expect((await shiftState(page)).mistakeCount).toBe(0);

		const id = await hooks(page, 'spawnPatientNow', 'sprain');
		const slot = (await hooks(page, 'getTriageSlots')).find((s) => s.id === id);
		await clickCanvasPoint(page, { x: slot.x, y: slot.y - 20 });
		await waitUntilArrived(page);
		await waitForOverlay(page, 'triage');
		const red = (await hooks(page, 'getTriageButtonRects'))[0];
		await clickCanvasPoint(page, { x: red.x + 20, y: red.y + 20 });
		const s = await shiftState(page);
		expect(s.mistakeCount).toBe(1);
		expect(s.beds.find((b) => b?.id === id).level).toBe('green');
	});
});

test.describe('treatments', () => {
	test('vitals, bandage and meds: a deep cut is treated and discharged', async ({ page }) => {
		await seedSave(page);
		await page.goto('/hospital-shift');
		await startShift(page);
		const [id, bed] = await admit(page, 'cut', 'yellow');

		await walkTo(page, 'bed', bed);
		await waitForOverlay(page, 'skill');
		await passSkillCheck(page);
		await expect.poll(async () => (await shiftState(page)).beds[bed]?.step).toBe(1);

		// Bandage: no roll in hand → the bed sends you upstairs for one.
		await walkTo(page, 'bed', bed);
		expect(await hooks(page, 'getOverlay')).toBeNull();
		await expect(page.locator('#hospital-toast')).toContainText('Supply Cart upstairs');
		await fetchBandageRoll(page);
		// Then trace the real path with the mouse held down.
		await walkTo(page, 'bed', bed);
		const bandage = await waitForOverlay(page, 'bandage');
		const pts = bandage.path;
		const start = await canvasToPage(page, pts[0]);
		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		for (let i = 1; i < pts.length; i++) {
			for (let k = 1; k <= 8; k++) {
				const p = await canvasToPage(page, { x: pts[i - 1].x + ((pts[i].x - pts[i - 1].x) * k) / 8, y: pts[i - 1].y + ((pts[i].y - pts[i - 1].y) * k) / 8 });
				await page.mouse.move(p.x, p.y);
			}
		}
		await page.mouse.up();
		await expect.poll(async () => (await shiftState(page)).beds[bed]?.step).toBe(2);
		expect((await shiftState(page)).hasBandage).toBe(false); // the roll was used up
		await page.waitForFunction(() => window.__hospitalShiftTestHooks.getOverlay() === null);

		// Meds: the wrong drug is a mistake, the right one is carried to the bed.
		await walkTo(page, 'med-cabinet');
		const meds = await waitForOverlay(page, 'meds');
		const layout = await hooks(page, 'getMedsLayout');
		const decoy = layout.bottles.find((b) => b.name !== meds.order.drug);
		await clickCanvasPoint(page, { x: decoy.x + 40, y: decoy.y + 40 });
		const dose = layout.doses.find((d) => d.dose === meds.order.dose);
		await clickCanvasPoint(page, { x: dose.x + 20, y: dose.y + 20 });
		expect((await shiftState(page)).mistakeCount).toBe(1);
		const right = layout.bottles.find((b) => b.name === meds.order.drug);
		await clickCanvasPoint(page, { x: right.x + 40, y: right.y + 40 });
		await clickCanvasPoint(page, { x: dose.x + 20, y: dose.y + 20 });
		expect((await shiftState(page)).carried).toMatchObject({ kind: 'meds', patientId: id });

		await walkTo(page, 'bed', bed);
		const s = await shiftState(page);
		expect(s.beds[bed]).toBeNull();
		expect(s.discharged).toBe(1);
	});

	test('oxygen: clicking a skull is a missed pump (a mistake), finding the three hearts finishes it', async ({ page }) => {
		await seedSave(page);
		await page.goto('/hospital-shift');
		await startShift(page);
		const [, bed] = await admit(page, 'allergy', 'red');
		await walkTo(page, 'bed', bed);
		const overlay = await waitForOverlay(page, 'oxygen');
		expect(overlay.items.filter((it) => it.kind === 'heart')).toHaveLength(3);
		const skull = overlay.items.find((it) => it.kind === 'skull');
		await clickCanvasPoint(page, skull);
		expect((await shiftState(page)).mistakeCount).toBe(1);
		// The same skull can't cost twice.
		await clickCanvasPoint(page, skull);
		expect((await shiftState(page)).mistakeCount).toBe(1);
		const hearts = overlay.items.filter((it) => it.kind === 'heart');
		await clickCanvasPoint(page, hearts[0]);
		expect((await hooks(page, 'getOverlay')).hits).toBe(1);
		for (const heart of hearts.slice(1)) await clickCanvasPoint(page, heart);
		await expect.poll(async () => (await shiftState(page)).beds[bed]?.step).toBe(1);
		expect(await hooks(page, 'getOverlay')).toBeNull();
	});

	test('surgery: wheel the gurney to the OR and pass three stages', async ({ page }) => {
		await seedSave(page);
		await page.goto('/hospital-shift');
		await startShift(page);
		const [, bed] = await admit(page, 'appendicitis', 'red');
		for (let step = 0; step < 2; step++) {
			await walkTo(page, 'bed', bed);
			await waitForOverlay(page, 'skill');
			await passSkillCheck(page);
			await expect.poll(async () => (await shiftState(page)).beds[bed]?.step).toBe(step + 1);
		}
		await walkTo(page, 'bed', bed);
		expect((await shiftState(page)).carried?.kind).toBe('gurney');
		await walkTo(page, 'operating-room');
		await waitForOverlay(page, 'skill');
		for (let i = 0; i < 3; i++) {
			await passSkillCheck(page);
			await page.waitForTimeout(50);
		}
		const s = await shiftState(page);
		expect(s.beds[bed]).toBeNull();
		expect(s.carried).toBeNull();
		expect(s.discharged).toBe(1);
	});

	test('a bandage roll in your pocket doesn\'t stop you taking the gurney and operating', async ({ page }) => {
		await seedSave(page);
		await page.goto('/hospital-shift');
		await startShift(page);
		await fetchBandageRoll(page);
		const [, bed] = await admit(page, 'appendicitis', 'red');
		for (let step = 0; step < 2; step++) {
			await walkTo(page, 'bed', bed);
			await waitForOverlay(page, 'skill');
			await passSkillCheck(page);
			await expect.poll(async () => (await shiftState(page)).beds[bed]?.step).toBe(step + 1);
		}
		await walkTo(page, 'bed', bed);
		expect((await shiftState(page)).carried?.kind).toBe('gurney');
		await walkTo(page, 'operating-room');
		await waitForOverlay(page, 'skill');
		for (let i = 0; i < 3; i++) {
			await passSkillCheck(page);
			await page.waitForTimeout(50);
		}
		const s = await shiftState(page);
		expect(s.beds[bed]).toBeNull();
		expect(s.hasBandage).toBe(true);
	});

	test('the × button backs out of a minigame without a mistake', async ({ page }) => {
		await seedSave(page);
		await page.goto('/hospital-shift');
		await startShift(page);
		const [, bed] = await admit(page, 'sprain', 'green');
		await walkTo(page, 'bed', bed);
		await waitForOverlay(page, 'skill');
		const close = await hooks(page, 'getCloseRect');
		await clickCanvasPoint(page, { x: close.x + 14, y: close.y + 14 });
		const s = await shiftState(page);
		expect(await hooks(page, 'getOverlay')).toBeNull();
		expect(s.activeTask).toBeNull();
		expect(s.mistakeCount).toBe(0);
	});
});

test.describe('the Supply Room (2nd Floor)', () => {
	test('the HUD button switches floors, and only that floor\'s stations are reachable', async ({ page }) => {
		await page.goto('/hospital-shift');
		await startShift(page);
		await expect(page.locator('#hospital-floor-button')).toHaveText('Go Upstairs');
		await page.locator('#hospital-floor-button').click();
		expect(await hooks(page, 'getCurrentFloor')).toBe(2);
		await expect(page.locator('#hospital-floor-button')).toHaveText('Go Downstairs');
		await expect(page.locator('#hospital-floor-button')).toHaveAttribute('aria-pressed', 'true');
		// A bed sits where the empty stockroom floor is upstairs — clicking there
		// just walks, it doesn't reach the bed.
		const bed = (await hooks(page, 'getStations')).find((s) => s.kind === 'bed');
		await clickCanvasPoint(page, bed);
		await waitUntilArrived(page);
		expect(await hooks(page, 'getOverlay')).toBeNull();
		await page.locator('#hospital-floor-button').click();
		expect(await hooks(page, 'getCurrentFloor')).toBe(1);
	});

	test('you can come back down during handover to reach the office', async ({ page }) => {
		await page.goto('/hospital-shift');
		await startShift(page);
		await walkTo(page, 'stairs');
		await hooks(page, 'skipToClosing');
		await walkTo(page, 'stairs');
		expect(await hooks(page, 'getCurrentFloor')).toBe(1);
		await walkTo(page, 'office');
		await expect(page.locator('#hospital-paycheck-screen')).toBeVisible();
	});

	test('one roll at a time: no second roll while you already have one', async ({ page }) => {
		await seedSave(page);
		await page.goto('/hospital-shift');
		await startShift(page);
		await fetchBandageRoll(page);
		await walkTo(page, 'stairs');
		await walkTo(page, 'supply-cart');
		await expect(page.locator('#hospital-toast')).toContainText('already have a bandage roll');
	});
});

test.describe('helping staff', () => {
	async function clickStaff(page, key) {
		const member = (await hooks(page, 'getStaff')).find((a) => a.key === key);
		await clickCanvasPoint(page, { x: member.x, y: member.y - 20 });
	}

	test('Dr. Okafor steps in for a patient about to be transferred', async ({ page }) => {
		await page.goto('/hospital-shift');
		await startShift(page);
		const [id, bed] = await admit(page, 'sprain', 'green');
		await hooks(page, 'setBedPatienceFraction', bed, 0.2);
		await hooks(page, 'setDoctorCooldown', 0);
		await expect.poll(async () => (await shiftState(page)).doctorAssists, { timeout: 15000 }).toBe(1);
		const s = await shiftState(page);
		expect(s.beds[bed].id).toBe(id);
		expect(s.beds[bed].step).toBe(1);
		expect(s.beds[bed].patienceRemainingSeconds / s.beds[bed].patienceMaxSeconds).toBeGreaterThanOrEqual(0.45);
		await expect(page.locator('#hospital-toast')).toContainText('Dr. Okafor stepped in');
	});

	test('the Orderly wheels a surgery patient to the OR when clicked', async ({ page }) => {
		await seedSave(page);
		await page.goto('/hospital-shift');
		await startShift(page);
		const [id, bed] = await admit(page, 'appendicitis', 'red');
		for (let step = 0; step < 2; step++) {
			await walkTo(page, 'bed', bed);
			await waitForOverlay(page, 'skill');
			await passSkillCheck(page);
			await expect.poll(async () => (await shiftState(page)).beds[bed]?.step).toBe(step + 1);
		}
		await clickStaff(page, 'orderly');
		await expect(page.locator('#hospital-toast')).toContainText('Orderly is on his way');
		await expect.poll(async () => (await shiftState(page)).orPatient?.patientId, { timeout: 20000 }).toBe(id);
		await walkTo(page, 'operating-room');
		await waitForOverlay(page, 'skill');
		for (let i = 0; i < 3; i++) {
			await passSkillCheck(page);
			await page.waitForTimeout(50);
		}
		const s = await shiftState(page);
		expect(s.beds[bed]).toBeNull();
		expect(s.orPatient).toBeNull();
	});

	test('the Orderly says so when nobody needs surgery', async ({ page }) => {
		await page.goto('/hospital-shift');
		await startShift(page);
		await clickStaff(page, 'orderly');
		await expect(page.locator('#hospital-toast')).toContainText('Nobody needs wheeling');
	});

	test('the Stock tech comes downstairs and hands you a bandage roll', async ({ page }) => {
		await page.goto('/hospital-shift');
		await startShift(page);
		await hooks(page, 'bringStockTechDownNow');
		await expect.poll(async () => (await hooks(page, 'getStaff')).find((a) => a.key === 'stockTech').floor).toBe(1);
		await hooks(page, 'freezeStaff', 'stockTech');
		await clickStaff(page, 'stockTech');
		await expect.poll(async () => (await shiftState(page)).hasBandage, { timeout: 10000 }).toBe(true);
		expect(await hooks(page, 'getCurrentFloor')).toBe(1);
	});
});

test.describe('Coffee Machine', () => {
	test('a perfect pour refills Sanity, lifts Ward Mood and tips', async ({ page }) => {
		await page.goto('/hospital-shift');
		await startShift(page);
		await hooks(page, 'setSanity', 30);
		await hooks(page, 'setWardMood', 50);
		await walkTo(page, 'coffee-machine');
		const overlay = await waitForOverlay(page, 'coffee-pour');
		await page.keyboard.down('Space');
		await hooks(page, 'setCoffeePourFill', (overlay.band.low + overlay.band.high) / 2);
		await page.keyboard.up('Space');
		const s = await shiftState(page);
		expect(s.sanity).toBeGreaterThan(95);
		expect(s.wardMood).toBe(70);
		expect(s.bonusGard).toBeGreaterThanOrEqual(10);
	});
});

test.describe('Karen', () => {
	test('explaining triage earns a tip; letting her cut in is a mistake', async ({ page }) => {
		await page.goto('/hospital-shift');
		await startShift(page);
		await hooks(page, 'forceKarenShiftNow');
		await walkTo(page, 'triage-desk');
		await waitForOverlay(page, 'karen');
		const buttons = await hooks(page, 'getKarenButtonRects');
		await clickCanvasPoint(page, { x: buttons.letCut.x + 20, y: buttons.letCut.y + 20 });
		const s = await shiftState(page);
		expect(s.karen.outcome).toBe('letCut');
		expect(s.mistakeCount).toBe(1);
		expect(s.wardMood).toBe(50);
	});
});

test.describe('hallucinations', () => {
	test('at 0 Sanity a ghost appears in the triage line and startles you', async ({ page }) => {
		await page.goto('/hospital-shift');
		await startShift(page);
		await hooks(page, 'setSanity', 0);
		await hooks(page, 'spawnGhostNow');
		const ghost = (await hooks(page, 'getTriageSlots')).find((s) => s.kind === 'ghost');
		expect((await hooks(page, 'getHallucinations')).intensity).toBe(1);
		await hooks(page, 'setSanity', 20);
		await clickCanvasPoint(page, { x: ghost.x, y: ghost.y - 20 });
		await waitUntilArrived(page);
		expect((await shiftState(page)).sanity).toBeLessThanOrEqual(15.1);
		expect((await shiftState(page)).mistakeCount).toBe(0);
	});
});

test.describe('handover and paycheck', () => {
	test('the office is locked during play, then pays out after handover', async ({ page }) => {
		await page.goto('/hospital-shift');
		await startShift(page);
		await walkTo(page, 'office');
		await expect(page.locator('#hospital-paycheck-screen')).toBeHidden();
		await hooks(page, 'skipToClosing');
		await walkTo(page, 'office');
		await expect(page.locator('#hospital-paycheck-screen')).toBeVisible();
		await expect(page.locator('#hospital-paycheck-shift-total')).toHaveText('4000 Gard');
		await expect(page.locator('#hospital-final-paycheck-block')).toBeHidden();
		await page.locator('#hospital-paycheck-next-shift-button').click();
		await expect(page.locator('#hospital-hud-shift')).toHaveText('2/30');
	});

	test('shift 30 shows the Final Paycheck and submits to the real leaderboard', async ({ page }) => {
		const playerName = testPlayerName();
		try {
			await seedSave(page, 30, 140000);
			await page.goto('/hospital-shift');
			await startShift(page);
			await hooks(page, 'skipToClosing');
			await walkTo(page, 'office');
			await expect(page.locator('#hospital-paycheck-screen')).toHaveAttribute('data-final', 'true');
			await expect(page.locator('#hospital-final-paycheck-block')).toBeVisible();
			await page.locator('#hospital-paycheck-name-input').fill(playerName);
			const [response] = await Promise.all([
				page.waitForResponse((r) => r.url().includes('/hospital-shift/score') && r.request().method() === 'POST'),
				page.locator('#hospital-paycheck-submit-button').click(),
			]);
			expect(response.ok()).toBeTruthy();
			await expect(page.locator('#hospital-leaderboard')).toContainText(playerName);
			await expect(page.locator('#hospital-leaderboard')).toContainText('144000 Gard');
		} finally {
			await deleteTestScore(playerName);
		}
	});
});

test.describe('revisiting via HTMX after navigating away', () => {
	test('a second HTMX visit still starts a shift', async ({ page }) => {
		await page.goto('/projects');
		const playNow = () => page.locator('.project-card').filter({ hasText: 'Hospital Shift' }).getByRole('link', { name: 'Play now' });
		const projectsLink = () => page.locator('#primary-nav').getByRole('link', { name: 'Projects', exact: true });
		await playNow().click();
		await expect(page.locator('#hospital-canvas')).toBeVisible();
		await projectsLink().click();
		await expect(page).toHaveURL(/\/projects$/);
		await playNow().click();
		await expect(page.locator('#hospital-start-screen')).toBeVisible();
		await startShift(page);
		await expect(page.locator('#hospital-hud-shift')).toHaveText('1/30');
	});
});

test('no console errors on load and during play', async ({ page }) => {
	const errors = [];
	page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
	page.on('pageerror', (err) => errors.push(String(err)));
	await seedSave(page);
	await page.goto('/hospital-shift');
	await startShift(page);
	for (const c of ['cut', 'appendicitis', 'asthma']) await hooks(page, 'spawnPatientNow', c);
	await page.waitForTimeout(400);
	await page.locator('#hospital-fullscreen-button').click();
	await page.waitForTimeout(200);
	expect(errors).toEqual([]);
});
