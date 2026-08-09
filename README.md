# pi-tools

Shared Punt Labs pi extensions, skills, prompts, and themes.

This repo is for small pi-native utilities that are useful across
projects but not large enough to justify their own product repository.

## Extensions

### keep

Manage long-running tmux processes from inside pi. The agent can
start, inspect, send input to, and stop tmux sessions that host
CLI processes like PR check watchers, biff REPLs, dev servers, or
any command that should outlive a single tool call.

Tools registered for the LLM:

- **keep_watch** — start a command that refreshes every N seconds
- **keep_run** — start a long-running or interactive command
- **keep_capture** — read current output from a kept session
- **keep_send** — send a line of input to an interactive session
- **keep_stop** — stop a kept session
- **keep_list** — list all active kept sessions

Each tool manages a named tmux session prefixed with `keep-`.

Example agent usage:

- start a PR check watcher, then capture it later to check status
- start a biff REPL, send commands, capture replies
- start a dev server, capture logs, stop when done

Common watch patterns:

- `gh -R owner/repo pr checks <number>` — PR CI status
- `bd ready` — Beads ready work
- `ls -lah <dir>` — directory changes
- `curl -s <health-url>` — service health
- `tail -n 40 <logfile>` — log tail

Capture returns the latest refreshed snapshot, not history.
For watch sessions, the watch header line is stripped
automatically so the agent sees clean command output.

The `/keep` slash command is also available for direct human use
with the same subcommands.

## Development

This repo is Nix-first. See `docs/TESTING.md` for the testing
pyramid.

Required gate before committing:

```text
make check
```

## Scope

Good fits for this repo:

- small pi extensions
- thin CLI wrappers
- shared prompt templates
- reusable skills

Poor fits:

- tools with a non-trivial engine (use their own repo)
- tools needing their own release process
