# Testing

`pi-tools` tests extensions at multiple levels. The default `make check` gate
is offline and deterministic. Real-relay, real-Pi loopback, and live-model
checks are separate integration tiers with different prerequisites.

## Testing pyramid

- TS helper tests: registry, formatting, parsing, coder arguments, output
  handling, and shell-command wrapping in `lib/`. Automated via Vitest.
- Offline extension tests: fake Pi hosts and controlled subprocesses exercise
  tool registration, provider configuration, shell environments, and reporting.
  These are integration checks without a live provider or relay.
- Local process tests: execute guarded shell commands, including termination
  of a runaway command. Require Node.js 24, Bash, and POSIX process groups,
  but no network or GNU `timeout`.
- TS typecheck: all extensions and lib code compile cleanly.
  Automated.
- Markdown lint: all docs pass markdownlint. Automated.
- Biff real-relay integration: a fake Pi host and two owned biff
  endpoints verify the bridge lifecycle and message round trip.
  Automated but requires tmux, biff authentication, and relay access.
- Pi JSON-mode smoke: extension loads in a real Pi process and the agent calls
  tools. Requires the Pi binary, configured provider credentials, and tmux for
  the keep smoke. Live coder acceptance also requires independent inspection
  and execution; a worker's successful report is not sufficient.
- Real-Pi coder loopback smoke: installed parent and nested Pi processes use
  a deterministic local fake provider, actual file writes, and real guarded
  shell checks. Requires a compatible Pi CLI, Node.js 24, Bash, and POSIX process
  groups. Uses fake credentials, not a paid model or real provider key.

## Unit tests

Helper tests live in `tests/` and cover logic in `lib/`:

- `registry.test.ts` — add, remove, has, list, duplicate rejection,
  session name prefixing, and safe-name validation (accepted characters,
  rejection of tmux target delimiters, whitespace, empty, and over-length
  names, and rejection before registration)
- `format.test.ts` — time formatting, entry formatting, list
  formatting with fixed timestamps
- `keep.test.ts` — argument parsing for two-arg and three-arg
  patterns
- `tmux-wait.test.ts` — exact command framing and prompt completion
- `wake-scheduler.test.ts` — one-shot delivery, busy-event coalescing,
  cancellation, in-flight cancellation, shutdown, schedulable-delay bounds,
  out-of-range rejection, and the stop protocol (final wake delivered and
  rescheduling halted, and no delivery when an in-flight stop resumes after
  cancellation)
- `keep-watch.test.ts` — first, changed, always, and never wake policies
- `every.test.ts` — bounded `/every` parsing for seconds, minutes, hours,
  arbitrary instructions, and invalid syntax
- `biff-args.test.ts` — identifier validation and quoting free text for Biff
- `biff-config.test.ts` — configuration discovery and repository selection
- `biff-session.test.ts` — owned-session lifecycle and pointer management
- `biff-status.test.ts` — footer/status formatting
- `biff-talk.test.ts` — modal talk framing and state parsing
- `pi-coder.test.ts` — self-contained prompts, target paths, provider/model
  selection, child arguments, JSON report/usage parsing, and tool-enabled
  implementation instructions
- `bash-guard.test.ts` — deadline configuration, validation, exit statuses,
  missing Bash diagnostics, execution without GNU `timeout`, runaway-command
  termination, cancellation, and independence of separate command groups
- `bash-guard-runtime.test.ts` — real process-group supervision, background-job
  cleanup when commands exit, TERM/KILL escalation, and cancellation
- `markdownlint.test.ts` — tracked-path selection includes ignored-parent
  worktrees while runtime captures, scratch files, and the deposited tracker
  guide remain excluded
- `smoke-pi.test.ts` — fake Pi/tmux executables exercise the keep smoke entry
  point, JSON event validation, exit preservation, timeout escalation, unique
  session ownership, and artifact creation without live credentials or models

The pure helper cases verify input/output behavior without external services.
Some cases use controlled mocks or local subprocesses. In particular, the bash
guard's execution tests require Bash and POSIX process groups. Offline does
not mean no local executable dependencies.

## Offline extension integration tests

The coder and guard tests also exercise extension registration and execution:

- `pi-coder-extension.test.ts` — configured tool invocation, child-process
  behavior, on-disk file reporting, and failure paths through a fake Pi host
- `bash-guard-extension.test.ts` — registered bash-tool behavior, timeout
  configuration, and removal of `PI_CODER_API_KEY` from shell environments

These run under `make test` and `make check`. Controlled processes and fake
hosts do not prove that a real Pi provider accepts the configuration or that
a live model follows the file contract. Live validation is a separate tier.

The installed Pi CLI and repository SDK can have different versions. Type
checking and mocked hosts do not establish the real CLI's runtime behavior.
In particular, verify failures in actual Pi JSON tool-result events: a resolved
object with `isError` is not sufficient for hosts that only mark thrown errors
as tool failures. Error messages must not expose the configured credential.

The parent's acceptance protocol must remain explicit in the registered tool
guidance: inspect the actual diff, enforce allowed files, and independently
run specified tests and integration checks. Never change that guidance to
treat worker self-reporting as proof.

## TypeScript typecheck

All source under `extensions/`, `lib/`, and `tests/` must compile
without errors.

## Markdown lint

`lib/lint-docs.ts` selects explicit tracked Markdown paths from the current Git
worktree's index, then passes them to markdownlint. This works even when the
worktree is inside an ignored parent directory. Stage new Markdown files before
running this gate so they are included.

Dependency documentation, untracked runtime captures and scratch files, and
the deposited tracker guide under `.punt-labs/punt/` are not repository-authored
documentation. The deposited guide remains excluded by the lint configuration.
Audit the tracked inventory with `git ls-files '*.md'`; do not treat captured
session logs as this repository's writing.

## Biff real-relay integration

`biff-bridge.integration.test.ts` owns both sides of a real message
exchange. It verifies the complete Biff REPL surface:

- startup, status, `tty`, `who`, `finger`, `last`, plan set/clear,
  `mesg n`/`mesg y`, timestamp on/off, and graceful `exit`
- direct writes and reads in both directions, including automatic
  unread notification, footer state, and scheduled agent wake-up
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

## Pi smoke test

The `smoke-pi` target runs `tests/smoke-pi.sh`, which delegates process handling
and event validation to the test-only `tests/smoke-keep.ts` runner. It uses a
live Pi process in JSON print mode. Its scope is the keep tools, not every
extension:

- pi starts with the keep extension loaded
- agent is prompted to use keep tools
- output must contain successful `tool_execution_end` events for `keep_run`,
  `keep_capture`, `keep_stop`, and `keep_list`; tool names in prompts or
  narration do not count, and failed tool events fail the smoke
- result text must confirm the unique session started and stopped, capture
  the expected output marker, and report an empty keep registry; text-only
  failures cannot pass merely because Pi sets `isError` to false
- those successful events must occur in run, capture, stop, empty-list order;
  an earlier registry inspection cannot replace the post-stop check
- the final assistant `message_end` outcome must not be `error`, `aborted`, or
  `length`, even after successful tools and exit zero; a later completed
  assistant retry can recover from an earlier provider error

Run separately because it requires Pi, tmux, a configured model provider, and
Node.js with `--experimental-strip-types` support:

- `make smoke-pi`

Not included in `make check`.

The runner bounds actual Pi execution to 30 seconds by default. Set the
test-only `PI_KEEP_SMOKE_TIMEOUT_S` to a positive finite number to change it.
Timeout sends TERM to the owned process group, followed by KILL after one
second if needed, and returns exit 124. Nonzero Pi exits retain their exit code
when invoking the script directly; `make` reports its own failure status.
The runner requires no external `timeout` executable.

Each run creates `.tmp/keep-smoke-*` artifacts in its working directory and
uses a unique tmux name. Cleanup targets only that exact session and the owned
Pi process group. Captured stdout and stderr each have a 1,048,576-character
test-harness limit. These harness limits are not production coder limits.
Both streams use stateful UTF-8 decoding so split characters remain intact
before event validation and credential redaction.

Per-run diagnostic directories are intentionally retained for inspection.
`make clean` preserves them; it removes build output and the legacy smoke file,
not `.tmp/keep-smoke-*` or `.tmp/smoke-coder-*` diagnostics.

Before retaining either artifact or printing diagnostics and metadata, the
runner redacts the optional `PI_CODER_API_KEY` value, including its JSON-escaped
form. It does not claim to filter every credential. Raw events remain available
in memory for tool-result validation, and nonzero Pi exits retain their status.

Successful tool events alone do not prove every resulting process state.
Inspect the actual smoke output when evaluating its result. This target does
not establish coder delegation, credential filtering, or independent parent
verification. Its offline regression suite uses fake executables and never
contacts the real model provider or host tmux.

## Real-Pi coder loopback smoke

`tests/smoke-pi-coder.ts` starts a loopback OpenAI-compatible fake provider and
runs the installed Pi CLI as both parent and nested coder. Scripted responses
exercise real extension loading and tool execution without asking a live
model to generate code.

Run the dedicated target separately from `make check`:

```bash
make smoke-coder
```

The scenarios cover:

- a child writing the exact fixture file and running a guarded shell check
- an independent parent shell check of the actual file
- the configured fake credential reaching provider authentication, but not
  model conversation text, process arguments, or guarded shell environments
- reported token usage from deterministic fixture events
- missing target, missing provider, and missing model as actual Pi tool errors
- explicit nested extension selection and disabled automatic discovery

Artifacts are retained in `.tmp/smoke-coder-*`, including per-scenario Pi event
logs and requests. The harness bounds its own subprocess runtime and captured
output. These test-harness limits are separate from `pi_coder`'s 8 MiB combined
nested-Pi transcript cap. Neither limit creates a production worker deadline
or a volume cap on shell-command output files and disk spill.

Process-argument checks preload `argv-probe.cjs` through `NODE_OPTIONS` and read
the resulting `node-startup.jsonl`. This records startup arguments before Pi
changes its process title; the checks do not read Linux `/proc`.
Execution has been verified on Linux; macOS execution remains unverified.
The fixture does not verify real-model coding quality, model compliance,
provider compatibility beyond its scripted responses, or the full
compile/test/integration contract for a real task. Those remain separate live
validation and parent acceptance requirements.

## Live coder validation

Load the checkout's coder and shell guard using the command in
[`CODING.md`](CODING.md#load-the-extensions). Configure the required provider
and model before calling the tool. Use a disposable, owned directory and a
small deterministic task with exact build and integration commands.

Verify the complete parent/child workflow:

1. The parent defines one target file, its public contract, allowed artifacts,
   and exact compile/test commands.
2. The parent calls `pi_coder(task, target_path)` rather than writing source
   through a shell command.
3. The child writes the file and runs its compile/test loop using tools.
4. The tool returns a report pending parent verification, with usage metadata
   when supplied by the provider.
5. The parent inspects actual changes, checks permitted files, and independently
   executes the compile, test, and integration commands before acceptance.

Also exercise failure reporting and a new correction call with observed
failures. Confirm that successive calls do not inherit conversation history.
Shared files remain visible; do not interpret fresh conversation state as
filesystem isolation.

Run credential checks with a disposable test value, never a production secret.
Verify that guarded bash subprocesses lack `PI_CODER_API_KEY` while Pi still
authenticates through its configured provider. This does not establish removal
of other credentials or protection against file/tool access.

Record the Pi version, provider/model identifiers, tested commit, exact commands,
observed results, changed files, and the parent's independent verification.
Do not claim live-provider validation from the offline extension tests.

## Manual wake-up validation

After changing scheduler integration, reload a Pi session that uses the local
package and verify bounded recurring delivery:

```text
/every 5s Say exactly "scheduler test" and nothing else 2
```

Expected: two autonomous turns followed by `/every status` reporting no active
schedule.

Verify an output-driven wake by asking the agent to start this watch and stop
it after the first update:

```text
keep_watch(name="wake-test", interval=5, command="date +%s", wake="always")
```

Finally, leave Pi idle and send its Biff identity a message from a separately
owned Biff endpoint. Expected: an automatic inbox turn within the 15-second
polling window, followed by an explicit `biff_read` call.

## Required gates

Before committing code changes:

- `make check`

Before changing biff bridge behavior:

- `make test-integration` (when biff and relay access are available)

Before changing the general tool surface:

- `make smoke-pi` (when pi and credentials are available)

Before accepting coder or shell-guard changes:

- `make check`, including helper, local-process, and offline extension tests
- the live coder workflow above, with an independently checked diff and rerun
  acceptance commands
- any task-specific integration checks; Biff relay tests remain a separate
  requirement when changing the Biff bridge

For documentation-only changes, run `make check-docs`. If `markdownlint-cli2`
is not on `PATH`, select the installed repository binary explicitly:

```bash
make check-docs MARKDOWNLINT=./node_modules/.bin/markdownlint-cli2
```

Unavailable provider credentials or relay access mean the corresponding live
tier is unverified, not passed. State that gap in the handoff.
