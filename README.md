# pi-tools

Small, reusable extensions for the
[Pi coding agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent).
The package provides tools for managing long-running terminal processes,
connecting Pi sessions to [Biff](https://github.com/punt-labs/biff), and
delegating file implementation to a separately configured Pi coding agent.
Its shell guard gives Pi bash commands a default time limit.

> [!IMPORTANT]
> This project is in early development. It is installed from source, and its
> tool APIs may change before the first tagged release. Pin a Git commit when
> reproducibility matters.

## Requirements

- macOS or Linux
- [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)
- [tmux](https://github.com/tmux/tmux/wiki)
- [Biff](https://github.com/punt-labs/biff) only when using the Biff bridge
- GNU coreutils `timeout` on `PATH` when using the shell guard or coder
- A configured Pi provider and model when using `pi_coder`

On macOS, coreutils commonly installs `gtimeout`; expose its GNU `timeout`
command on `PATH`. The guard invokes `timeout`, not `gtimeout`. See
[`docs/CODING.md`](docs/CODING.md) for provider and shell-guard setup.

Pi extensions execute with the same system access as Pi itself. Review an
extension before installing it, especially when Pi can run commands without
confirmation.

## Install

Install the package for the current user:

```bash
pi install git:github.com/punt-labs/pi-tools
```

Try it for one Pi run without changing settings:

```bash
pi -e git:github.com/punt-labs/pi-tools
```

Pin an installation to a tag or commit by adding `@<ref>`:

```bash
pi install git:github.com/punt-labs/pi-tools@<commit-sha>
```

The package loads all extensions by default. Use `pi config` to disable an
extension you do not need, including `pi-coder` and `bash-guard`. Loading the
guard changes the parent session's bash tool too, not only nested coder calls.
If the Biff bridge is enabled without an installed and authenticated `biff`
command, Pi displays a startup warning; the `keep` extension remains usable.

For a local source checkout, load only the coder and its shell guard:

```bash
pi --no-extensions -e ./extensions/pi-coder.ts -e ./extensions/bash-guard.ts
```

`--no-extensions` disables discovery; explicit `-e` paths still load. A package
path loads its selected package resources, while a file path loads that
extension. Configure the provider before making a coder call.

Update or remove the package with Pi's package manager:

```bash
pi update --extensions
pi remove git:github.com/punt-labs/pi-tools
```

## Extensions

### `pi-coder`

`pi_coder(task, target_path)` delegates one focused file to a fresh Pi agent.
The parent owns architecture, file boundaries, interfaces, allowed writes, and
acceptance checks. The child writes the file on the shared filesystem, then
compiles, runs, and tests its implementation with tools.

Set both `PI_CODER_PROVIDER` and `PI_CODER_MODEL`; neither has a default.
`PI_CODER_THINKING` optionally selects a Pi thinking level. Provider endpoint
and authentication setup belong in Pi configuration, not the task prompt.
`PI_CODER_API_KEY` is an optional credential for a provider configured to use
it; it is not a provider selector or an automatic authentication mapping.

Each call has no previous conversation or previous-call history. It can still
inspect accessible files and use the same user's network and tools. A requested
source-file scope is an instruction, not a filesystem restriction.

The returned worker report is **pending parent verification**. Before accepting,
the parent must inspect the actual diff, enforce allowed files, and independently
run the specified tests and integration checks. A file preview, worker report,
or token-usage summary is not proof. Never call this writing tool merely to
verify an existing file. See [`docs/CODING.md`](docs/CODING.md) for the full
contract and configuration example.

### `bash-guard`

Replace Pi's bash tool with a wrapper that applies GNU `timeout` to each command.
`PI_BASH_TIMEOUT_S` accepts a positive finite number of seconds; missing or
invalid values use 120 seconds. The wrapper sends TERM at the limit, followed
by KILL after a further 10 seconds if needed.

This is a per-command limit, not a total worker-runtime limit or hard output
cap. Fast commands can still produce substantial output before timeout.
The guard removes `PI_CODER_API_KEY` from bash subprocess environments; parent
and nested Pi processes retain it for provider authentication. It does not
remove every credential or restrict access to credential files, other tools,
the filesystem, or the network.

### `keep`

Manage long-running or interactive processes in tmux without leaving Pi. The
extension owns sessions with a `keep-` prefix and exposes their current output
to the agent.

| Tool | Purpose |
| --- | --- |
| `keep_watch` | Refresh a command and optionally wake the agent with output |
| `keep_run` | Start a long-running or interactive command |
| `keep_after` | Capture a kept session after a delay and wake the agent |
| `keep_capture` | Read the current output from a kept session |
| `keep_send` | Send one line to an interactive session |
| `keep_stop` | Stop a kept session |
| `keep_list` | List active kept sessions |

The `/keep` command provides the same operations for direct human use.

Example uses include watching pull-request checks, running a development
server, or keeping an interactive CLI available across agent turns. Watch
sessions return the latest refreshed snapshot rather than their entire output
history. `keep_watch` supports `change` (the default), `always`, and `never`
wake policies. A wake injects the current pane and triggers another agent turn;
busy turns coalesce to the newest update. A watch whose tmux session exits on
its own stops automatically and delivers a final notice rather than repeating
capture failures.

Session names must use 1-64 characters from `A-Z`, `a-z`, `0-9`, `-`, and `_`.
The name becomes part of the tmux target, so characters such as `:` and `.`
are rejected. `keep_send` delivers exactly one line and rejects control
characters, including embedded newlines. Watch and delayed-wake intervals must
be no larger than the Node timer ceiling (about 24.8 days).

### `/every`

Schedule a bounded repeating LLM instruction:

```text
/every <n>s|<n>m|<n>h <LLM command> <max_times>
```

For example:

```text
/every 120s vox say "What's up?" 5
```

Use `/every status` to inspect the active schedule and `/every stop` to cancel
it. Timer ticks that occur while the agent is busy coalesce into one pending
delivery, and all schedules are cancelled when the Pi session shuts down. The
interval must be no larger than the Node timer ceiling (about 24.8 days). See
[`docs/SCHEDULING.md`](docs/SCHEDULING.md) for delivery semantics and complete
PR, Biff, and Vox examples.

### `biff-bridge`

Connect Pi to Biff through a process-owned, durable Biff REPL. Every Pi process
uses a distinct tmux session and Biff TTY, preventing concurrent Pi sessions
from consuming one another's messages. The extension polls for unread mail,
raises Pi notifications, and shows the same status as Biff's Claude Code
statusline in the footer: `user:tty(N)` with the unread count (highlighted when
nonzero, `(n)` when messages are off), then the team wall when one is posted.

Install and authenticate Biff before enabling this extension. See the
[Biff installation instructions](https://github.com/punt-labs/biff#quick-start).

Biff reads its relay and team settings from `.punt-labs/biff/config.yaml` and
`config.local.yaml` at the root of the git repository it starts in, and
silently falls back to a public demo relay when it finds neither. The bridge
therefore starts Biff in the nearest enclosing repository that has a Biff
config, so a repository nested inside a configured workspace repository uses
the workspace's relay. A configured directory that is not itself a git
repository is skipped, because Biff cannot start there. If no directory has
one, the bridge warns that Biff is on the demo relay. `BIFF_CWD` overrides
the search with a fixed directory:

```bash
export BIFF_CWD=~/Coding/punt-labs
```

| Tools | Purpose |
| --- | --- |
| `biff_who`, `biff_finger` | Inspect current presence |
| `biff_last` | Inspect session history |
| `biff_status`, `biff_plan` | Inspect and publish bridge state |
| `biff_tty`, `biff_mesg` | Control the bridge session |
| `biff_read`, `biff_write` | Receive and send direct messages |
| `biff_wall` | Read, post, or clear the team wall |
| `biff_timestamps` | Control talk message timestamps |
| `biff_talk_start` | Initiate or accept a talk |
| `biff_talk_read` | Read new talk activity |
| `biff_talk_send` | Send a talk line |
| `biff_talk_end` | Cancel or end a talk |

Each Pi process owns its own Biff session, named `pi-<pid>`: the bridge
creates it at startup and ends it at shutdown, so stale sessions don't pile up
in `biff who`. Message, plan and wall text may contain quotes, apostrophes and
line breaks; line breaks are sent as ` / ` because Biff messages are one line.

The four talk tools adapt Biff's modal BSD-style `talk` interface to discrete
Pi tool calls. The bridge can initiate or accept an invitation, exchange lines,
and detect local cancellation or either participant hanging up.

Unread notification uses a 15-second polling interval. A newly increased unread
count updates Pi's UI and triggers an agent turn; the agent then calls
`biff_read` explicitly so polling never consumes inbox messages.

## Development

Clone the repository and install its Node development dependencies:

```bash
git clone https://github.com/punt-labs/pi-tools.git
cd pi-tools
npm install
make check
```

The repository includes a Nix development shell for macOS and Linux:

```bash
nix develop
npm install
make check
```

`make check` runs TypeScript type checking, ESLint, Prettier verification,
offline helper and extension tests, and Markdown linting. Local process tests
require bash and GNU `timeout`; offline means no live provider or relay is
needed, not that every test is a pure function.

Real-relay tests own both Biff endpoints but require tmux, an authenticated Biff
installation, and network access:

```bash
make test-integration
```

The relay suite is intentionally excluded from `make check` so the default gate
remains deterministic and offline. See [`docs/TESTING.md`](docs/TESTING.md) for
the full test strategy and [`DESIGN.md`](DESIGN.md) for accepted architectural
decisions.

Coder-specific configuration and independent acceptance checks are documented
in [`docs/CODING.md`](docs/CODING.md). Release-facing changes are recorded in
[`CHANGELOG.md`](CHANGELOG.md).

The coder's deterministic loopback smoke uses real installed parent and nested
Pi processes with fake provider responses and credentials. It exercises tool
invocation and file/shell checks, not real-model coding quality. See the testing
guide for its platform requirements and the separate live acceptance workflow.

## Repository scope

This repository is intended for Pi-native utilities with small implementations
and no independent release lifecycle: extensions, thin CLI adapters, prompt
templates, themes, and reusable skills. Larger tools with their own engines or
release requirements should live in dedicated repositories.

## License

[MIT](LICENSE) © 2026 Punt Labs
