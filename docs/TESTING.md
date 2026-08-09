# Testing

`pi-tools` tests extensions at multiple levels. Every tier except
the pi smoke test runs without external dependencies.

## Testing pyramid

- TS unit tests: registry, formatting, parsing logic in `lib/`.
  Automated via vitest. No mocks, no external deps.
- TS typecheck: all extensions and lib code compile cleanly.
  Automated.
- Markdown lint: all docs pass markdownlint. Automated.
- Pi RPC smoke: extension loads in a real pi session, agent calls
  tools, results verified. Automated but requires pi binary and
  model API key.

## Unit tests

Unit tests live in `tests/` and cover pure logic in `lib/`:

- `registry.test.ts` — add, remove, has, list, duplicate rejection,
  session name prefixing
- `format.test.ts` — time formatting, entry formatting, list
  formatting with fixed timestamps
- `keep.test.ts` — argument parsing for two-arg and three-arg
  patterns

These tests have no external dependencies. They verify input/output
behavior of extracted functions.

## TypeScript typecheck

All source under `extensions/`, `lib/`, and `tests/` must compile
without errors.

## Markdown lint

All checked-in markdown must pass markdownlint, excluding
`node_modules` and `.direnv`.

## Pi RPC smoke test

Automated pass/fail test against a live pi process. Verifies the
full tool surface from the agent's perspective:

- pi starts with the keep extension loaded
- agent is prompted to use keep tools
- output is checked for tool call evidence

Run separately because it requires pi and a model API key:

- `make smoke-pi`

Not included in `make check`.

## Required gates

Before committing code changes:

- `make check`

Before changing tool behavior:

- `make smoke-pi` (when pi and credentials are available)
