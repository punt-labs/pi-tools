NPM ?= npm
MARKDOWNLINT ?= markdownlint-cli2

.PHONY: help check lint typecheck test test-integration docs check-docs format format-check clean coverage tools smoke-pi

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-24s %s\n", $$1, $$2}'

check: typecheck lint format-check test check-docs ## Run all quality gates

typecheck: ## Type-check TypeScript
	$(NPM) exec tsc -- --noEmit

lint: ## Lint TypeScript with eslint
	$(NPM) exec eslint -- .

format-check: ## Check formatting with prettier
	$(NPM) exec prettier -- --check .

format: ## Auto-format with prettier
	$(NPM) exec prettier -- --write .

test: ## Run unit tests
	$(NPM) exec vitest -- run

test-integration: ## Run real-relay biff bridge integration test
	BIFF_INTEGRATION=1 $(NPM) exec vitest -- run tests/biff-bridge.integration.test.ts

docs: check-docs ## Lint markdown

check-docs: ## Lint markdown
	$(MARKDOWNLINT) "**/*.md" "#node_modules" "#.direnv"

smoke-pi: ## Run pi RPC smoke test (requires pi + model API key)
	./tests/smoke-pi.sh

coverage: ## Run tests with coverage
	$(NPM) exec vitest -- run --coverage

tools: ## Install development dependencies
	$(NPM) install

clean: ## Remove build artifacts
	rm -rf dist coverage .tmp/smoke-pi-output.jsonl
