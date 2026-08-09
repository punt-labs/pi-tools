NPM ?= npm
MARKDOWNLINT ?= markdownlint-cli2

.PHONY: help check lint typecheck test docs check-docs format clean coverage tools smoke-pi

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-24s %s\n", $$1, $$2}'

check: typecheck test check-docs ## Run all quality gates

typecheck: ## Type-check TypeScript extensions
	$(NPM) exec tsc -- --noEmit

test: ## Run unit tests
	$(NPM) exec vitest -- run

lint: typecheck check-docs ## Lint (typecheck + markdown)

docs: check-docs ## Lint markdown

check-docs: ## Lint markdown
	$(MARKDOWNLINT) "**/*.md" "#node_modules" "#.direnv"

smoke-pi: ## Run pi RPC smoke test (requires pi + model API key)
	./tests/smoke-pi.sh

coverage: ## Run tests with coverage
	$(NPM) exec vitest -- run --coverage

format: ## Check formatting (placeholder)
	@echo "No formatter configured yet"

tools: ## Install development dependencies
	$(NPM) install

clean: ## Remove build artifacts
	rm -rf dist coverage .tmp/smoke-pi-output.jsonl
