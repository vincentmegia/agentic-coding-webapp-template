// Frontend end-to-end config. Drives a real browser against the actual
// running server (not a mock) — see docs/features/home.md and
// docs/features/resume.md for the behavior these specs cover, and
// cmd/server/e2e_test.go for the backend half of this coverage.
//
// Requires DATABASE_URL (or .env — see .env.example) exactly like the
// server itself, since `webServer` below boots the real app via `make
// run`, migrations and all — there is no mocked backend here.
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
	testDir: '.',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	reporter: 'list',
	use: {
		baseURL: 'http://localhost:8080',
		trace: 'retain-on-failure',
	},
	projects: [
		{ name: 'chromium', use: { ...devices['Desktop Chrome'] } },
		// WebKit is Safari's actual engine — worth running against
		// directly rather than assuming Chromium coverage transfers,
		// since this site is developed and used on macOS/Safari.
		{ name: 'webkit', use: { ...devices['Desktop Safari'] } },
	],
	// Two processes: the dev-only fake LTA DataMall (cmd/fakelta) that the
	// Bus Stop Finder spec needs, and the real server pointed at it via
	// `make run-e2e`, which also isolates the bus tables in a bus_e2e schema
	// so the fake fixtures never mix with real synced LTA data. With
	// reuseExistingServer, an already-running server on :8080 is used as-is
	// — start it with `make run-e2e` (not `make run`) for
	// e2e/bus-stops.spec.js to pass. See docs/features/bus-stop-finder.md's
	// Testing Plan.
	webServer: [
		{
			command: 'go run ./cmd/fakelta',
			cwd: '..',
			url: 'http://127.0.0.1:8099/healthz',
			reuseExistingServer: true,
			timeout: 60_000,
		},
		{
			command: 'make run-e2e',
			cwd: '..',
			url: 'http://localhost:8080/healthz',
			reuseExistingServer: true,
			timeout: 60_000,
		},
	],
});
