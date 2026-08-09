# pi-tools

Small, reusable extensions for the
[Pi coding agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent).
The package currently provides tools for managing long-running terminal
processes and connecting Pi sessions to
[Biff](https://github.com/punt-labs/biff).

> [!IMPORTANT]
> This project is in early development. It is installed from source, and its
> tool APIs may change before the first tagged release. Pin a Git commit when
> reproducibility matters.

## Requirements

- macOS or Linux
- [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)
- [tmux](https://github.com/tmux/tmux/wiki)
- [Biff](https://github.com/punt-labs/biff) only when using the Biff bridge

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
extension you do not need. If the Biff bridge is enabled without an installed
and authenticated `biff` command, Pi displays a startup warning; the `keep`
extension remains usable.

Update or remove the package with Pi's package manager:

```bash
pi update --extensions
pi remove git:github.com/punt-labs/pi-tools
```

## Extensions

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
busy turns coalesce to the newest update.

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
delivery, and all schedules are cancelled when the Pi session shuts down. See
[`docs/SCHEDULING.md`](docs/SCHEDULING.md) for delivery semantics and complete
PR, Biff, and Vox examples.

### `biff-bridge`

Connect Pi to Biff through a process-owned, durable Biff REPL. Every Pi process
uses a distinct tmux session and Biff TTY, preventing concurrent Pi sessions
from consuming one another's messages. The extension polls for unread mail,
raises Pi notifications, and displays connection or unread state in the
footer.

Install and authenticate Biff before enabling this extension. See the
[Biff installation instructions](https://github.com/punt-labs/biff#quick-start).

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
offline unit tests, and Markdown linting.

Real-relay tests own both Biff endpoints but require tmux, an authenticated Biff
installation, and network access:

```bash
make test-integration
```

The relay suite is intentionally excluded from `make check` so the default gate
remains deterministic and offline. See [`docs/TESTING.md`](docs/TESTING.md) for
the full test strategy and [`DESIGN.md`](DESIGN.md) for accepted architectural
decisions.

## Repository scope

This repository is intended for Pi-native utilities with small implementations
and no independent release lifecycle: extensions, thin CLI adapters, prompt
templates, themes, and reusable skills. Larger tools with their own engines or
release requirements should live in dedicated repositories.

## License

[MIT](LICENSE) © 2026 Punt Labs
