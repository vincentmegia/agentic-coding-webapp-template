# Build/test/run tooling for vincentmegia.com. See
# docs/skills/go-backend/SKILL.md "Code Quality" — these targets wrap the
# same underlying commands documented there; use whichever is convenient.

.PHONY: help deps build run run-fake run-e2e fakelta dev test test-e2e vet fmt tidy check css css-watch clean

help: ## Show this help.
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

deps: ## Install Go module dependencies and npm devDependencies (Tailwind CLI, Playwright).
	go mod download
	npm install
	npx playwright install chromium

build: ## Build the server binary into bin/server.
	go build -o bin/server ./cmd/server

run: ## Run the server (go run, no build artifact). Requires DATABASE_URL (or .env) — see docs/features/resume.md.
	go run ./cmd/server

fakelta: ## Run the dev-only fake LTA DataMall on 127.0.0.1:8099 (docs/features/bus-stop-finder.md).
	go run ./cmd/fakelta

run-fake: ## Run the server against the fake LTA + OneMap (start `make fakelta` first).
	LTA_BASE_URL=http://127.0.0.1:8099 ONEMAP_BASE_URL=http://127.0.0.1:8099 LTA_ACCOUNT_KEY=fake-key go run ./cmd/server

# DATABASE_URL from the environment, else .env; the e2e server gets the same
# database with search_path=bus_e2e so Playwright's fake-LTA fixtures never
# mix with the real synced bus data in the default schema.
E2E_DB_URL = $$(u="$${DATABASE_URL:-$$(sed -nE 's/^DATABASE_URL=//p' .env)}"; case "$$u" in (*\?*) echo "$$u&search_path=bus_e2e";; (*) echo "$$u?search_path=bus_e2e";; esac)

run-e2e: ## Run the server Playwright expects: fake LTA + isolated bus_e2e schema (start `make fakelta` first).
	@psql "$${DATABASE_URL:-$$(sed -nE 's/^DATABASE_URL=//p' .env)}" -qc 'CREATE SCHEMA IF NOT EXISTS bus_e2e'
	DATABASE_URL="$(E2E_DB_URL)" LTA_BASE_URL=http://127.0.0.1:8099 ONEMAP_BASE_URL=http://127.0.0.1:8099 LTA_ACCOUNT_KEY=fake-key go run ./cmd/server

dev: css run ## Build CSS once, then run the server — the everyday local-dev entrypoint.

test: ## Run the Go test suite (includes cmd/server's DB-gated end-to-end test).
	go test ./...

test-e2e: ## Run the frontend end-to-end suite (Playwright) — starts/reuses the real server. Requires DATABASE_URL/.env.
	npm run test:e2e

vet: ## Run go vet.
	go vet ./...

fmt: ## Format all Go source.
	gofmt -w .

tidy: ## Tidy go.mod/go.sum.
	go mod tidy

check: fmt vet test ## Format, vet, and test — run before committing (docs/skills/go-backend/SKILL.md "Code Quality").

css: ## Compile web/static/css/app.css to output.css (minified).
	npm run build:css

css-watch: ## Rebuild output.css automatically as app.css/templates change.
	npm run watch:css

clean: ## Remove build artifacts.
	rm -rf bin
