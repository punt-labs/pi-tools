# Testing

`pi-tools` tests extensions at multiple levels. Every tier except
the pi smoke test runs without external dependencies.

## Testing pyramid

- TS unit tests: registry, formatting, parsing logic in `lib/`.
  Automated via vitest. No mocks, no external deps.
- TS typecheck: all extensions and lib code compile cleanly.
  Automated.
- Markdown lint: all docs pass markdownlint. Automated.
- Biff real-relay integration: a fake Pi host and two owned biff
  endpoints verify the bridge lifecycle and message round trip.
  Automated but requires tmux, biff authentication, and relay access.
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
- `tmux-wait.test.ts` — exact command framing and prompt completion

These tests have no external dependencies. They verify input/output
behavior of extracted functions.

## TypeScript typecheck

All source under `extensions/`, `lib/`, and `tests/` must compile
without errors.

## Markdown lint

All checked-in markdown must pass markdownlint, excluding
`node_modules` and `.direnv`.

## Biff real-relay integration

`biff-bridge.integration.test.ts` owns both sides of a real message
exchange. It verifies the complete Biff REPL surface:

- startup, status, `tty`, `who`, `finger`, `last`, plan set/clear,
  `mesg n`/`mesg y`, timestamp on/off, and graceful `exit`
- direct writes and reads in both directions, including automatic
  unread notification and footer state
- wall post, peer read, and clear
- talk invite, accept, connected state, timestamped bidirectional
  lines, local hangup, and remote hangup
- the bridge as both talk inviter and accepter
- restoration of ordinary command framing after modal talk
- extension shutdown and unconditional cleanup of both owned endpoints

Run separately because it requires local biff authentication and relay
access:

- `make test-integration`

The test is skipped during `make check`, so unit and static gates remain
offline and deterministic.

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

Before changing biff bridge behavior:

- `make test-integration` (when biff and relay access are available)

Before changing the general tool surface:

- `make smoke-pi` (when pi and credentials are available)
