// /bus-stops — Bus Stop Finder (docs/features/bus-stop-finder.md), against
// the real server plus the fake LTA (cmd/fakelta).
//
// Prerequisites: the server must run with LTA_BASE_URL=http://127.0.0.1:8099
// and a non-empty LTA_ACCOUNT_KEY, with `go run ./cmd/fakelta` listening on
// :8099 and the initial sync done (it runs on boot when bus_stops is empty).
// Fixture stops sit around Victoria St; (1.297, 103.853) is ~17 m from
// 01012 Hotel Grand Pacific, with 7 fixture stops inside 500 m.
//
// Arrival minutes are relative to "now", so these specs assert patterns
// (e.g. /^~?\d+$/), never exact minute values. Fake-LTA guarantees used:
// 01012 service 7's first bus is always "Arr" and its third is a timetable
// estimate; service 61 is "No Est. Available"; service 960 is "Not In
// Operation" (outside its one-minute 05:00 window).
//
// Geolocation outcomes other than "granted" are forced with an init script
// that replaces navigator.geolocation.getCurrentPosition, so denied/timeout
// behave identically in Chromium and WebKit.
const { test, expect } = require('@playwright/test');

const VICTORIA_ST = { latitude: 1.29702, longitude: 103.85304 };
const LOAD_LABELS = /^(Seats available|Standing room|Limited standing|Crowding unknown)(, timetable estimate)?$/;

// Records CSP violations (both the DOM event and console errors) so every
// test can assert none happened.
async function watchCSP(page) {
	const violations = [];
	page.on('console', (msg) => {
		if (msg.type() === 'error' && /Content Security Policy/i.test(msg.text())) violations.push(msg.text());
	});
	await page.addInitScript(() => {
		window.__cspViolations = [];
		document.addEventListener('securitypolicyviolation', (e) => {
			window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`);
		});
	});
	return async () => {
		const fromPage = await page.evaluate(() => window.__cspViolations || []);
		return violations.concat(fromPage);
	};
}

async function forceGeolocationError(page, code) {
	await page.addInitScript((errorCode) => {
		navigator.geolocation.getCurrentPosition = (_ok, fail) => {
			setTimeout(() => fail({ code: errorCode, message: 'forced by test' }), 50);
		};
	}, code);
}

test.describe('granted location', () => {
	test.use({ geolocation: VICTORIA_ST, permissions: ['geolocation'] });

	test('explainer first, then 5 nearest stops with the nearest expanded and live arrivals', async ({ page }) => {
		const cspViolations = await watchCSP(page);
		await page.goto('/bus-stops');

		await expect(page.getByRole('heading', { name: 'Bus Stop Finder', level: 1 })).toBeVisible();
		await expect(page.locator('#bus-explainer')).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Find the stops around you' })).toBeVisible();
		await expect(page.locator('.bus-stop-card')).toHaveCount(0);
		const headers = (await page.request.get('/bus-stops')).headers();
		expect(headers['permissions-policy']).toBe('geolocation=(self)');

		const nearbyRequest = page.waitForRequest((r) => r.url().includes('/bus-stops/nearby'));
		await page.locator('#bus-explainer').getByRole('button', { name: 'Use my location' }).click();
		const url = new URL((await nearbyRequest).url());
		// Rounded to 3 decimals in the browser before sending.
		expect(url.searchParams.get('lat')).toBe('1.297');
		expect(url.searchParams.get('lng')).toBe('103.853');

		const cards = page.locator('.bus-stop-card');
		await expect(cards).toHaveCount(5);
		await expect(page.locator('#bus-explainer')).toBeHidden();
		await expect(page.locator('#bus-stop-results')).toContainText('Nearby stops');

		// Nearest first, with distance and walk time.
		const first = cards.first();
		await expect(first).toHaveAttribute('data-code', '01012');
		await expect(first).toContainText('Hotel Grand Pacific');
		await expect(first).toContainText(/\d+ m/);
		// Walking time lives in the opened stop's detail panel (layout v2).
		await expect(page.locator('#bus-detail-01012')).toContainText(/\d+ m · \d+ min walk/);
		const distances = await cards.evaluateAll((els) => els.map((el) => Number(el.dataset.distance)));
		expect(distances).toEqual([...distances].sort((a, b) => a - b));
		expect(Math.max(...distances)).toBeLessThanOrEqual(500);

		// Nearest auto-expanded, polling every 20 s.
		await expect(first).toHaveAttribute('data-selected', 'true');
		await expect(first.locator('.bus-stop-toggle')).toHaveAttribute('aria-expanded', 'true');
		const arrivals = page.locator('#bus-arrivals-01012');
		await expect(arrivals).toHaveAttribute('data-state', 'live');
		await expect(arrivals).toHaveAttribute('hx-trigger', 'every 20s');
		await expect(arrivals).toContainText(/Updated (just now|\d+ s ago)/);

		// Service 7: "Arr", then minutes, third a "~" timetable estimate.
		const service7 = arrivals.locator('.bus-service-row[data-service="7"]');
		const labels = await service7.locator('.bus-time-label').allTextContents();
		expect(labels).toHaveLength(3);
		expect(labels[0].trim()).toBe('Arr');
		expect(labels[1].trim()).toMatch(/^\d+$/);
		expect(labels[2].trim()).toMatch(/^~\d+$/);
		await expect(service7.locator('.bus-time[data-scheduled="true"]')).toHaveCount(1);

		// Every time label is "Arr", "N" or "~N"; every crowding bar is labelled.
		for (const text of await arrivals.locator('.bus-time-label').allTextContents()) {
			expect(text.trim()).toMatch(/^(Arr|~?\d+)$/);
		}
		const loadLabels = await arrivals.locator('.bus-load').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
		expect(loadLabels.length).toBeGreaterThan(0);
		for (const label of loadLabels) expect(label).toMatch(LOAD_LABELS);

		// LTA advisement messages for services without arrival data.
		await expect(arrivals.locator('.bus-service-row[data-service="61"]')).toContainText('No Est. Available');
		await expect(arrivals.locator('.bus-service-row[data-service="960"]')).toContainText('Not In Operation');
		// Loop service shown as its own row.
		await expect(arrivals.locator('.bus-service-row[data-service="225G"]')).toBeVisible();

		// Coordinates never reach the address bar.
		expect(page.url()).not.toContain('lat=');

		expect(await cspViolations()).toEqual([]);
	});

	test('selecting another stop expands it and collapses the previous one', async ({ page }) => {
		await page.goto('/bus-stops');
		await page.locator('#bus-explainer').getByRole('button', { name: 'Use my location' }).click();
		const cards = page.locator('.bus-stop-card');
		await expect(cards).toHaveCount(5);
		await expect(page.locator('#bus-arrivals-01012')).toHaveAttribute('data-state', 'live');

		const second = cards.nth(1);
		const secondCode = await second.getAttribute('data-code');
		await second.locator('.bus-stop-toggle').click();

		await expect(second).toHaveAttribute('data-selected', 'true');
		await expect(page.locator(`#bus-arrivals-${secondCode}`)).toHaveAttribute('data-state', 'live');
		await expect(cards.first()).toHaveAttribute('data-selected', 'false');
		await expect(cards.first().locator('.bus-stop-toggle')).toHaveAttribute('aria-expanded', 'false');
		// The collapsed card's polling element is gone.
		const collapsed = page.locator('#bus-arrivals-01012');
		await expect(collapsed).toBeHidden();
		await expect(collapsed).not.toHaveAttribute('hx-trigger', /.+/);
		await expect(page.locator('.bus-stop-card[data-selected="true"]')).toHaveCount(1);

		// Clicking the open card again collapses it.
		await second.locator('.bus-stop-toggle').click();
		await expect(page.locator('.bus-stop-card[data-selected="true"]')).toHaveCount(0);
	});

	test('keyboard: stop cards are buttons reachable and operable by keyboard', async ({ page }) => {
		await page.goto('/bus-stops');
		await page.locator('#bus-explainer').getByRole('button', { name: 'Use my location' }).click();
		await expect(page.locator('.bus-stop-card')).toHaveCount(5);
		const toggle = page.locator('.bus-stop-card').nth(2).locator('.bus-stop-toggle');
		await toggle.focus();
		await page.keyboard.press('Enter');
		await expect(page.locator('.bus-stop-card').nth(2)).toHaveAttribute('data-selected', 'true');
	});

	test('fits a phone screen without horizontal scrolling', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/bus-stops');
		await page.locator('#bus-explainer').getByRole('button', { name: 'Use my location' }).click();
		await expect(page.locator('#bus-arrivals-01012')).toHaveAttribute('data-state', 'live');
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
		expect(overflow).toBeLessThanOrEqual(0);
	});
});

test.describe('location outcomes other than "near stops"', () => {
	test('denied → "Location is off" panel, and search still finds stops with arrivals', async ({ page }) => {
		const cspViolations = await watchCSP(page);
		await forceGeolocationError(page, 1);
		await page.goto('/bus-stops');
		await page.locator('#bus-explainer').getByRole('button', { name: 'Use my location' }).click();

		await expect(page.locator('#bus-location-off')).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Location is turned off' })).toBeVisible();
		await expect(page.locator('#bus-explainer')).toBeHidden();
		await expect(page.locator('#bus-search')).toBeVisible();

		await page.getByLabel('Find stops by postal code, stop code or road').fill('Victoria');
		await page.locator('#bus-search').getByRole('button', { name: 'Search' }).click();
		await expect(page.locator('#bus-stop-results')).toContainText('Search results');
		const card = page.locator('.bus-stop-card[data-code="01012"]');
		await expect(card).toBeVisible();
		await expect(card).toHaveAttribute('data-distance', '');
		// Search results aren't auto-expanded.
		await expect(page.locator('.bus-stop-card[data-selected="true"]')).toHaveCount(0);
		await card.locator('.bus-stop-toggle').click();
		await expect(page.locator('#bus-arrivals-01012')).toHaveAttribute('data-state', 'live');

		expect(await cspViolations()).toEqual([]);
	});

	test('timeout → its own heading in the same panel', async ({ page }) => {
		await forceGeolocationError(page, 3);
		await page.goto('/bus-stops');
		await page.locator('#bus-explainer').getByRole('button', { name: 'Use my location' }).click();
		await expect(page.getByRole('heading', { name: 'Finding your location took too long' })).toBeVisible();
		await expect(page.locator('#bus-search')).toBeVisible();
	});

	test('"Search by postal code or stop code" skips location entirely', async ({ page }) => {
		await page.goto('/bus-stops');
		await page.getByRole('button', { name: 'Search by postal code or stop code' }).click();
		await expect(page.locator('#bus-search')).toBeVisible();
		await expect(page.getByLabel('Find stops by postal code, stop code or road')).toBeFocused();
		await page.getByLabel('Find stops by postal code, stop code or road').fill('0101');
		await page.keyboard.press('Enter');
		await expect(page.locator('.bus-stop-card[data-code="01012"]')).toBeVisible();
	});

	test('search with no matches shows the empty state', async ({ page }) => {
		await page.goto('/bus-stops');
		await page.getByRole('button', { name: 'Search by postal code or stop code' }).click();
		await page.getByLabel('Find stops by postal code, stop code or road').fill('Nowhere Lane');
		await page.keyboard.press('Enter');
		await expect(page.locator('#bus-stop-results')).toContainText('No stops match “Nowhere Lane”');
	});
});

test.describe('where this bus goes', () => {
	test.use({ geolocation: { latitude: 1.297, longitude: 103.853 }, permissions: ['geolocation'] });

	test('Route shows the onward stops, survives an arrivals refresh, and closes', async ({ page }) => {
		await page.goto('/bus-stops');
		await page.locator('#bus-explainer').getByRole('button', { name: 'Use my location' }).click();
		const row = page.locator('#bus-arrivals-01012 .bus-service-row[data-service="7"]');
		await expect(row).toBeVisible();
		const btn = row.getByRole('button', { name: 'Route of bus 7' });
		await expect(btn).toHaveAttribute('aria-pressed', 'false');
		await btn.click();

		const route = page.locator('#bus-route-01012 .bus-route');
		await expect(route.getByRole('heading', { name: 'Bus 7 from Hotel Grand Pacific' })).toBeVisible();
		await expect(route).toContainText(/3 stops · [\d.]+ km to Clementi Int/);
		await expect(route.locator('.bus-route-stops li')).toHaveCount(4); // boarding + 3 onward
		await expect(route.locator('.bus-route-stops li').last()).toContainText('terminus');
		await expect(route.locator('.bus-route-approach li')).toHaveCount(1);
		await expect(btn).toHaveAttribute('aria-pressed', 'true');

		// An arrivals refresh re-renders the rows; the route stays open and
		// its button stays pressed.
		await page.evaluate(() => window.htmx.ajax('GET', '/bus-stops/01012/arrivals', { target: '#bus-arrivals-01012', swap: 'outerHTML' }));
		await expect(page.locator('#bus-arrivals-01012 .bus-service-row[data-service="7"] .bus-route-toggle')).toHaveAttribute('aria-pressed', 'true');
		await expect(route).toBeVisible();

		// A route that ends here says so instead of listing nothing.
		await page.locator('#bus-arrivals-01012 .bus-service-row[data-service="12"] .bus-route-toggle').click();
		await expect(page.locator('#bus-route-01012 .bus-route-ends')).toContainText('Hotel Grand Pacific is the last stop for bus 12');
		await expect(page.locator('#bus-arrivals-01012 .bus-service-row[data-service="7"] .bus-route-toggle')).toHaveAttribute('aria-pressed', 'false');

		// Pressing the open route's button again closes it; collapsing the
		// stop closes it too.
		await page.locator('#bus-arrivals-01012 .bus-service-row[data-service="12"] .bus-route-toggle').click();
		await expect(page.locator('#bus-route-01012')).toBeEmpty();
		await page.locator('#bus-arrivals-01012 .bus-service-row[data-service="7"] .bus-route-toggle').click();
		await expect(route).toBeVisible();
		await page.locator('.bus-stop-card[data-code="01012"] .bus-stop-toggle').click();
		await expect(page.locator('#bus-route-01012')).toBeEmpty();
	});
});

test.describe('postal code search', () => {
	// Postal codes are geocoded by the server through ONEMAP_BASE_URL, which
	// `make run-e2e` points at cmd/fakelta's fake OneMap (see its header for
	// the four postal codes it knows).
	async function searchFor(page, q) {
		await page.goto('/bus-stops');
		await page.getByRole('button', { name: 'Search by postal code or stop code' }).click();
		await page.getByLabel('Find stops by postal code, stop code or road').fill(q);
		await page.keyboard.press('Enter');
	}

	test('a 6-digit postal code shows the nearest stops with the nearest expanded', async ({ page }) => {
		const cspViolations = await watchCSP(page);
		await searchFor(page, '188592');
		const results = page.locator('#bus-stop-results');
		await expect(results.getByRole('heading', { name: 'Stops near Bras Basah Complex' })).toBeVisible();
		await expect(results).toContainText('within 500 m of 188592');
		const cards = page.locator('.bus-stop-card');
		await expect(cards).toHaveCount(5);
		await expect(cards.first()).toHaveAttribute('data-code', '01012');
		await expect(page.locator('#bus-detail-01012')).toContainText(/\d+ m · \d+ min walk/);
		// Nearest expanded with live arrivals, like a location search.
		await expect(cards.first().locator('button').first()).toHaveAttribute('aria-expanded', 'true');
		await expect(page.locator('#bus-arrivals-01012 .bus-service-row').first()).toBeVisible();
		expect(await cspViolations()).toEqual([]);
	});

	test('a 5-digit query is still a stop code search', async ({ page }) => {
		await searchFor(page, '01012');
		await expect(page.locator('#bus-stop-results')).toContainText('Search results');
		await expect(page.locator('.bus-stop-card[data-code="01012"]')).toBeVisible();
	});

	test('unknown postal code, no stops nearby, and OneMap down each get their own message', async ({ page }) => {
		await searchFor(page, '999999');
		await expect(page.locator('[data-bus-state="postal-not-found"]')).toContainText("We couldn't find an address for that postal code");
		await expect(page.locator('#bus-search')).toBeVisible();

		await page.getByLabel('Find stops by postal code, stop code or road').fill('456789');
		await page.keyboard.press('Enter');
		await expect(page.locator('#bus-stop-results')).toContainText('No bus stops within 500 m of 1 Fake Far Road');

		await page.getByLabel('Find stops by postal code, stop code or road').fill('111111');
		await page.keyboard.press('Enter');
		await expect(page.locator('[data-bus-state="postal-unavailable"]')).toContainText('Postal code search is unavailable right now');
	});
});

test.describe('outside Singapore', () => {
	test.use({ geolocation: { latitude: 51.5007, longitude: -0.1246 }, permissions: ['geolocation'] });

	test('shows the Singapore-only message and offers search', async ({ page }) => {
		await page.goto('/bus-stops');
		await page.locator('#bus-explainer').getByRole('button', { name: 'Use my location' }).click();
		await expect(page.locator('#bus-stop-results')).toContainText('Bus Stop Finder only covers Singapore');
		await expect(page.locator('[data-bus-state="outside-sg"]')).toBeVisible();
		await expect(page.locator('#bus-search')).toBeVisible();
		await expect(page.locator('.bus-stop-card')).toHaveCount(0);
	});
});

test.describe('in Singapore but nowhere near a stop', () => {
	test.use({ geolocation: { latitude: 1.42, longitude: 103.7 }, permissions: ['geolocation'] });

	test('shows the empty state and offers search', async ({ page }) => {
		await page.goto('/bus-stops');
		await page.locator('#bus-explainer').getByRole('button', { name: 'Use my location' }).click();
		await expect(page.locator('#bus-stop-results')).toContainText('No bus stops within 500 m');
		await expect(page.locator('#bus-search')).toBeVisible();
	});
});

test.describe('server-side validation', () => {
	test('fragments reject bad input with fixed copy and status codes', async ({ request }) => {
		const shortQuery = await request.get('/bus-stops/search?q=a');
		expect(shortQuery.status()).toBe(400);
		expect(await shortQuery.text()).toContain('Enter 2 to 40 characters');

		const badCode = await request.get('/bus-stops/12ab3/arrivals');
		expect(badCode.status()).toBe(400);
		expect(await badCode.text()).toContain('valid stop code');

		const unknownCode = await request.get('/bus-stops/99999/arrivals');
		expect(unknownCode.status()).toBe(404);
		expect(await unknownCode.text()).toContain("couldn&#39;t find that stop");

		const garbage = await request.get('/bus-stops/nearby?lat=abc&lng=103.8');
		expect(garbage.status()).toBe(400);
	});
});

test.describe('map', () => {
	test.use({ geolocation: VICTORIA_ST, permissions: ['geolocation'] });

	test('without a Maps key: list only, and Google is never contacted', async ({ page }) => {
		await page.goto('/bus-stops');
		const key = await page.locator('#bus-stops-app').getAttribute('data-maps-key');
		test.skip(!!key, 'server has GOOGLE_MAPS_API_KEY set; list-only mode not active');

		const googleRequests = [];
		page.on('request', (r) => {
			if (/googleapis\.com|gstatic\.com/.test(r.url())) googleRequests.push(r.url());
		});
		await expect(page.locator('#bus-map-panel')).toHaveCount(0);
		await page.locator('#bus-explainer').getByRole('button', { name: 'Use my location' }).click();
		await expect(page.locator('.bus-stop-card')).toHaveCount(5);
		await expect(page.locator('#bus-arrivals-01012')).toHaveAttribute('data-state', 'live');
		expect(googleRequests).toEqual([]);
	});

	test('with a Maps key: loads only after location, one marker per card, plain-text titles, selection synced', async ({ page }) => {
		await page.goto('/bus-stops');
		const key = await page.locator('#bus-stops-app').getAttribute('data-maps-key');
		test.skip(!key, 'server has no GOOGLE_MAPS_API_KEY; map is disabled');

		const cspViolations = await watchCSP(page);
		let mapsLoads = 0;
		await page.route('https://maps.googleapis.com/**', async (route) => {
			mapsLoads++;
			await route.fulfill({ contentType: 'application/javascript', body: FAKE_MAPS_SCRIPT });
		});
		await page.reload();
		await page.waitForTimeout(300);
		expect(mapsLoads).toBe(0); // nothing loaded before location is granted

		await page.locator('#bus-explainer').getByRole('button', { name: 'Use my location' }).click();
		await expect(page.locator('.bus-stop-card')).toHaveCount(5);
		await expect.poll(() => page.evaluate(() => (window.__fakeMaps ? window.__fakeMaps.markers.filter((m) => !/^Bus /.test(m.opts.title)).length : 0))).toBe(6); // 5 stops + "You are here" (live-bus markers counted separately below)
		expect(mapsLoads).toBe(1);
		await expect(page.locator('#bus-map')).toBeVisible();
		await expect(page.locator('#bus-recenter')).toBeVisible();

		const markers = await page.evaluate(() => window.__fakeMaps.markers.map((m) => ({ title: m.opts.title, label: m.opts.label && m.opts.label.text })));
		const cards = await page.locator('.bus-stop-card').evaluateAll((els) => els.map((el) => ({ title: `${el.dataset.name} (${el.dataset.code})`, label: el.dataset.rank })));
		for (const card of cards) expect(markers).toContainEqual(card);
		expect(markers).toContainEqual({ title: 'You are here', label: undefined });

		// Marker click selects the matching card.
		const third = await page.locator('.bus-stop-card').nth(2).getAttribute('data-code');
		await page.evaluate((code) => {
			const m = window.__fakeMaps.markers.find((x) => x.opts.title.endsWith(`(${code})`));
			m.listeners.click();
		}, third);
		await expect(page.locator(`.bus-stop-card[data-code="${third}"]`)).toHaveAttribute('data-selected', 'true');

		// Live buses: the open stop's monitored buses appear as markers.
		const busTitles = () => page.evaluate(() => window.__fakeMaps.markers.map((m) => m.opts.title).filter((t) => /^Bus /.test(t)));
		await expect.poll(async () => (await busTitles()).length).toBeGreaterThan(0);
		for (const t of await busTitles()) expect(t).toMatch(/^Bus \w+, (arriving|\d+ min away)$/);

		// Route of bus 7 from the nearest stop: a solid onward line (white
		// casing + colour) and a dashed approach line, plus a dot per stop.
		await page.locator('.bus-stop-card[data-code="01012"] .bus-stop-toggle').click(); // reopen 01012
		const routeBtn = page.locator('#bus-arrivals-01012 .bus-service-row[data-service="7"] .bus-route-toggle');
		await routeBtn.click();
		await expect(page.locator('#bus-route-01012 .bus-route')).toBeVisible();
		await expect.poll(() => page.evaluate(() => window.__fakeMaps.polylines.length)).toBe(3);
		const dots = await page.evaluate(() => window.__fakeMaps.markers.filter((m) => m.opts.zIndex === 7).map((m) => m.opts.title));
		expect(dots).toEqual(['Bras Basah Cplx', 'Orchard Stn', 'Clementi Int']);
		// Closing the route removes its overlays.
		await routeBtn.click();
		await expect.poll(() => page.evaluate(() => window.__fakeMaps.polylines.length)).toBe(0);

		const csp = (await page.request.get('/bus-stops')).headers()['content-security-policy'];
		expect(csp).toMatch(/script-src 'nonce-[^']+' 'strict-dynamic'/);
		expect(await cspViolations()).toEqual([]);
	});
});

test.describe('map from a search (no location shared)', () => {
	test('a postal search loads the map, marks the address, and zooms on scroll', async ({ page }) => {
		await page.goto('/bus-stops');
		const key = await page.locator('#bus-stops-app').getAttribute('data-maps-key');
		test.skip(!key, 'server has no GOOGLE_MAPS_API_KEY; map is disabled');

		const cspViolations = await watchCSP(page);
		let mapsLoads = 0;
		await page.route('https://maps.googleapis.com/**', async (route) => {
			mapsLoads++;
			await route.fulfill({ contentType: 'application/javascript', body: FAKE_MAPS_SCRIPT });
		});
		await page.reload();
		// Before anything: the placeholder says what it is, and Google isn't loaded.
		await expect(page.locator('#bus-map-placeholder-note')).toContainText('The map appears once you share your location or search');
		expect(mapsLoads).toBe(0);

		await page.getByRole('button', { name: 'Search by postal code or stop code' }).click();
		await page.getByLabel('Find stops by postal code, stop code or road').fill('188592');
		await page.keyboard.press('Enter');
		await expect(page.locator('.bus-stop-card')).toHaveCount(5);

		await expect.poll(() => page.evaluate(() => (window.__fakeMaps ? window.__fakeMaps.maps.length : 0))).toBe(1);
		expect(mapsLoads).toBe(1);
		await expect(page.locator('#bus-map')).toBeVisible();
		await expect(page.locator('#bus-map-placeholder-note')).toBeHidden();

		const titles = await page.evaluate(() => window.__fakeMaps.markers.map((m) => m.opts.title));
		expect(titles).toContain('188592 · Bras Basah Complex'); // the searched address
		expect(titles).not.toContain('You are here'); // location was never shared
		expect(titles.filter((t) => /\(\d{5}\)$/.test(t))).toHaveLength(5); // one per stop

		// Desktop pointer: scroll zooms / drag pans directly (no ⌘+scroll needed).
		expect(await page.evaluate(() => window.__fakeMaps.maps[0].opts.gestureHandling)).toBe('greedy');
		expect(await cspViolations()).toEqual([]);
	});
});

// Minimal stand-in for the Maps JS API surface bus-stops.js uses. Records
// every Marker so the test can check titles/labels, and calls the loader's
// callback named in its own script URL.
const FAKE_MAPS_SCRIPT = `
(function () {
	const record = { markers: [], maps: [], polylines: [] };
	window.__fakeMaps = record;
	class LatLngBounds { constructor() { this.points = []; } extend(p) { this.points.push(p); } }
	class Map {
		constructor(el, opts) { this.el = el; this.opts = opts; record.maps.push(this); }
		fitBounds() {} panTo() {} setZoom() {}
	}
	class Polyline {
		constructor(opts) { this.opts = opts; record.polylines.push(this); }
		setMap(map) { if (map === null) { record.polylines = record.polylines.filter((p) => p !== this); } }
	}
	class Marker {
		constructor(opts) { this.opts = opts; this.listeners = {}; record.markers.push(this); }
		addListener(name, fn) { this.listeners[name] = fn; }
		setMap(map) { if (map === null) { record.markers = record.markers.filter((m) => m !== this); } }
		setIcon(icon) { this.opts.icon = icon; }
		setZIndex(z) { this.opts.zIndex = z; }
	}
	const maps = {
		Map, Marker, Polyline, LatLngBounds,
		SymbolPath: { CIRCLE: 0 },
		importLibrary: async (name) => (name === 'maps' ? { Map } : { Marker }),
	};
	window.google = { maps };
	const src = document.currentScript && document.currentScript.src;
	const cb = src ? new URL(src).searchParams.get('callback') : null;
	if (cb && typeof window[cb] === 'function') window[cb]();
})();
`;
