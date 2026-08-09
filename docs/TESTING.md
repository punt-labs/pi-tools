# Testing

`pi-tools` tests extensions at multiple levels. Keep the lower layers
fast and automated; keep pi-level tests small and explicit.

## Testing pyramid

- TypeScript typecheck: all extensions compile cleanly. Automated.
- TypeScript unit tests: command parsing, argument routing, registry
  logic. Automated via vitest.
- Markdown lint: all docs pass markdownlint. Automated.
- Pi extension smoke: extensions load in a real pi session and
  commands execute. Manual smoke in pi via tmux.

## TypeScript typecheck

All extension source must compile without errors.

Runs as part of the project gate.

## TypeScript unit tests

Unit tests cover parsing, routing, and state logic without requiring
tmux, pi, or external services.

For `keep`, tests should cover:

- argument parsing for watch, run, capture, send, stop
- subcommand dispatch
- registry add/remove/list
- error paths for missing arguments and duplicate names

Run via vitest. Coverage reported but not gated for thin adapter
code.

## Markdown lint

All checked-in markdown must pass markdownlint, excluding
`node_modules` and `.direnv`.

## Pi extension smoke

Smoke tests verify that extensions load in a real pi session and
commands respond.

A valid smoke run for `keep` verifies:

- pi starts with `pi-tools` as a loaded package or local extension
- the startup view lists the keep extension
- `/keep help` prints usage
- `/keep run` starts a tmux session
- `/keep capture` returns pane output
- `/keep stop` removes the session
- `/keep list` reflects changes

Use tmux for visible pi sessions so the pane can be inspected.

## Required gate

Before committing:

- typecheck passes
- unit tests pass
- markdown lint passes

Before changing pi extension behavior:

- perform the relevant smoke checks and record the result
