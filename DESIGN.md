# Design Decisions

This document records architectural decisions for `pi-tools`. Implementation
and operational guidance live in [`README.md`](README.md),
[`docs/SCHEDULING.md`](docs/SCHEDULING.md), and
[`docs/TESTING.md`](docs/TESTING.md).

## ADR-001: Keep pi-tools a source-installed Pi package

- **Status:** Accepted
- **Date:** 2026-08-09

### ADR-001 Context

Punt Labs needs small Pi-native extensions, skills, prompts, and themes that are
useful across repositories but do not warrant independent products or release
systems.

### ADR-001 Decision

Maintain `pi-tools` as one Pi package with conventional resource directories
and a `package.json` Pi manifest. Distribute it from Git until a tagged or npm
release process is justified. Load extensions independently so users can
disable resources through `pi config`.

### ADR-001 Consequences

- One installation can provide `keep`, `/every`, and the Biff bridge.
- Source installations can pin a Git commit for reproducibility.
- APIs remain explicitly pre-release until the first tagged version.
- Utilities with substantial engines or independent release requirements must
  move to dedicated repositories.

### ADR-001 Alternatives considered

- **One repository per extension:** rejected because release and maintenance
  overhead would dominate these small integrations.
- **Copy extensions into each project:** rejected because fixes and safety
  changes would diverge.

## ADR-002: Use tmux for durable local processes

- **Status:** Accepted
- **Date:** 2026-08-09

### ADR-002 Context

Pi tool calls are finite, but agents need development servers, command
watchers, REPLs, and other processes to remain available across turns. The
initial deployment environment is a trusted, single-user workstation where Pi,
tmux, and kept commands all run as the same Unix account.

### ADR-002 Decision

Use tmux as the local process host. Prefix managed sessions with `keep-`, keep
an in-memory registry for metadata, and expose start, capture, send, stop, and
list operations as native Pi tools.

Treat tmux strictly as a persistence and terminal-control mechanism. It is not
a sandbox, authorization system, tenant boundary, secret store, or resource
manager. Its only default access boundary is the owning Unix account and the
permissions on its local socket.

### ADR-002 Consequences

- Processes survive the tool call that started them.
- Humans can inspect or attach to the underlying tmux session.
- Pane capture returns a bounded visible snapshot rather than unbounded logs.
- Kept processes can outlive a Pi session, while automatic wake timers cannot.
- Registry metadata is process-local and is not a durable inventory across Pi
  process restarts.
- Kept commands have the same filesystem, credential, environment, and network
  authority as Pi and the current Unix user.
- Root and any process running as the same user can inspect, control, or kill a
  kept session.
- Secrets printed in a pane can remain available through tmux capture.
- Captured output delivered to an LLM is untrusted input and can contain prompt
  injection.
- The `keep-` prefix is a collision-avoidance convention, not proof of
  ownership.

### ADR-002 Required hardening

Before treating the implementation as complete, `keep` must satisfy the items
below. Each is annotated with its current status.

- **Done.** Restrict names to a small, documented safe character set and
  length. `registry.isValidName` enforces `A-Za-z0-9_-`, 1-64 characters, and
  `registry.add` rejects any other name before registration; the set is
  documented in `README.md` and `docs/SCHEDULING.md`. A name becomes part of a
  tmux target, so this blocks target delimiters such as `:` and `.`.
- **Done.** Require a registry-owned entry before capture, send, stop, or
  delayed wake. Each of those operations checks `registry.get` first (in both
  the tool and `/keep` forms), and session-creating paths validate the name
  through `registry.add`, so unsafe names never enter the registry and these
  operations stay confined to owned sessions.
- **Done.** Continue sending interactive text with literal tmux input.
  `keep_send` uses literal send-keys and rejects control characters (including
  embedded newlines) so a single call cannot submit extra input.
- **Open.** Truncate model-bound output and identify it as untrusted command
  output.
- **Done.** Cancel timers and pending events before terminating a session.
  `keep_stop` and `session_shutdown` cancel timers and pending events, and a
  watch whose tmux session exits on its own terminates through a token-guarded
  scheduler stop rather than repeating failures.
- **Done.** Avoid claiming that tmux provides process or privilege isolation.
  The consequences above and this ADR state the same-user threat model
  explicitly.

A dedicated tmux socket namespace may reduce accidental interaction with a
user's ordinary tmux sessions. It does not protect against the same Unix user
and therefore does not change the security boundary.

### ADR-002 Revisit triggers

Revisit this decision and introduce a container, sandbox, dedicated OS user,
virtual machine, remote execution boundary, or stronger process manager when
any of these become true:

- kept commands or their dependencies are not trusted
- the extension runs on a multi-user host, shared runner, or hosted service
- different users, repositories, or agents require tenant isolation
- commands must not inherit Pi's credentials, SSH agent, files, or network
- captured output can contain adversarial content that must not reach the model
- secrets must be protected from pane capture or same-user processes
- CPU, memory, process count, runtime, or network access must be enforced
- schedules or process inventories must survive Pi or machine restarts
- auditability requires durable ownership and lifecycle records

The ADR remains accepted only while the trusted, single-user workstation threat
model holds.

### ADR-002 Alternatives considered

- **Child processes owned directly by a tool call:** rejected because they can
  be terminated with the call or lose interactive input.
- **Files plus background shell jobs:** rejected because ownership, capture,
  and interactive control are weaker.
- **Dedicated tmux socket:** useful for namespace hygiene but rejected as a
  security boundary because same-user authority is unchanged.
- **Container or virtual machine by default:** deferred because current commands
  are trusted and the operational cost is not yet justified. This becomes the
  preferred direction when a revisit trigger is met.

## ADR-003: Bridge Biff through one durable REPL

- **Status:** Accepted
- **Date:** 2026-08-09

### ADR-003 Context

Biff identity is process-scoped. Separate one-shot CLI commands create separate
sessions, so presence, inbox state, talk invitations, and TTY identity do not
persist across calls.

### ADR-003 Decision

Run one durable Biff REPL in a tmux session owned by each Pi process. Route all
Biff tools through that REPL rather than spawning one-shot Biff commands.

### ADR-003 Consequences

- Biff identity and unread state persist across Pi tool calls.
- The bridge can participate in modal talk.
- Startup must wait for the Biff prompt and tolerate relay latency.
- Shutdown should request graceful `exit` before killing tmux.
- The bridge depends on tmux and an installed, authenticated Biff CLI.

### ADR-003 Alternatives considered

- **One-shot Biff subprocesses:** rejected because each command loses the
  process identity.
- **A shared global bridge REPL:** rejected because concurrent Pi sessions could
  consume one another's messages.
- **A new Biff protocol client inside Pi:** deferred because it would duplicate
  Biff transport and authentication logic.

## ADR-004: Give every Pi process distinct Biff and tmux ownership

- **Status:** Accepted
- **Date:** 2026-08-09

### ADR-004 Context

Multiple Pi processes can run concurrently on one machine. A global tmux
session or Biff TTY would cause identity collisions and nondeterministic inbox
consumption.

### ADR-004 Decision

Name the bridge tmux session `keep-biff-bridge-<pid>` and its default Biff TTY
`pi-<pid>`. Only the creating Pi process may clean up that tmux session. Biff
remains responsible for relay-side disconnected-session reaping.

The bridge starts Biff in the nearest directory, from Pi's working directory
upward, that has `.punt-labs/biff/config.yaml` or `config.local.yaml`
(`BIFF_CWD` overrides it). Biff reads relay settings only from the directory
it starts in and otherwise uses its public demo relay, so a Pi session started
in an unconfigured repository used to land on the wrong relay without notice;
the bridge now warns when it finds no config.

The bridge **owns** its Biff session rather than attaching to whatever the
repo's pointer names. A bare `biff` attaches to the repo's pointed session, so
two bridges (or a bridge and a test peer) in one repo shared one session, and
each restart reused an old one: `biff who` listed stale TTYs, and messages to
a peer landed in the shared mailbox. `lib/biff-session.ts` now:

- ends any leftover live session named `pi-<pid>` and creates a fresh one,
  keeping its stable id (`cli-…`);
- restores the repository's previous default session afterwards, because
  `biff session new` also makes the new session the default, which would put
  a person running bare `biff` in the same repo into the bridge's mailbox.
  Bridges in one repository hold a shared OS lock (`flock` on a file in the
  temp directory, held by a small child process) across the read, create
  and restore, so one bridge never saves another's temporary session as the
  default. The kernel releases it when the holder exits, so a crash can't
  leave a stale lock and no bridge ever removes another's. The restore only
  writes if the pointer still names the bridge's new session, so a
  concurrent `biff session use` wins. A failure to read or restore the
  pointer is shown as a warning;
- attaches with `biff --session <id>` and ends `<id>` at shutdown, so both
  still work after `biff_tty` renames the session;
- does the relay round trips before the REPL's startup wait begins;
- ends the session if the REPL then fails to start, and is serialised with
  shutdown so a startup still in flight can't leave a session behind.

The pointer restore keeps a known, narrow race with people (who don't take
the bridges' lock): biff offers no way to create a session without moving the
pointer, so a `biff session use` landing between the bridge's check and its
write is lost. The fix belongs in biff (PL-1137), as a `session new` option
that leaves the pointer alone; the lock and restore code go once biff has it.

The footer status follows Biff's Claude Code statusline (`biff/statusline.py`):
`user:tty(N)`, highlighted when N > 0, `(n)` after `biff mesg n`, and the wall
as `▶ sender: text`. It comes from the same `status` poll, also run once at
startup. Pi's footer is one line, so the wall follows the label instead of
taking a second line.

The demo-relay warning is shown once per session, and also applies when
`BIFF_CWD` names a directory without a Biff config. A `BIFF_RELAY_URL`
override counts as a configured relay.

### Arguments to the Biff REPL

The REPL tokenises commands with Python `shlex`, so raw text broke on an
unbalanced quote: an apostrophe ("Jim's") produced `Parse error: No closing
quotation`. `lib/biff-args.ts` builds every command line:

- identifiers (address, user, TTY, duration) must be one plain token;
- free text (message, plan, wall post) is flattened to one line (line breaks
  become ` / `, tabs become spaces) and passed as one `shlex`-quoted argument;
- `talk` and talk lines aren't `shlex`-parsed by Biff, so their text is
  flattened but not quoted;
- other control characters are still rejected, because tmux literal input
  would turn them into extra keystrokes.

After a talk ends the REPL is rebuilt and reattaches to the session it already
owns instead of ending and recreating it. A talk counts as ended on either of
Biff's two closing lines, matched as whole lines only: the partner's
`▶  USER has ended the conversation.` or the REPL's own
`Talk with USER ended.`. A partner typing those words in a talk message does
not end it.

### ADR-004 Consequences

- Concurrent Pi sessions remain isolated.
- Cleanup is based on explicit ownership, never session age.
- Tests can identify and remove only their own endpoints.
- A future orphan collector must verify both PID and process start time before
  touching a session.

### ADR-004 Alternatives considered

- **Fixed session names:** rejected because they share identity and state.
- **Age-based cleanup:** rejected because a long-running valid session can be
  older than an orphan.

## ADR-005: Serialize and frame ordinary Biff REPL commands

- **Status:** Accepted
- **Date:** 2026-08-09

### ADR-005 Context

The unread poller and agent tools share one interactive REPL. Concurrent writes
can interleave, and naive substring matching can confuse output such as
`unread:` with a `read` command. Fixed sleeps are slow and fail under relay
latency.

### ADR-005 Decision

Serialize ordinary REPL commands through one promise queue. Send text with
literal tmux input, then send Enter separately. Detect completion by finding an
exact prompt-prefixed command echo followed by the next prompt. Capture joined
scrollback so wrapped output remains parseable.

### ADR-005 Consequences

- Polling and tools cannot interleave commands.
- Commands return as soon as prompt completion is observed.
- Literal input prevents text such as `end` from becoming a terminal key name.
- Prompt framing has dedicated unit tests.
- Modal talk cannot use this adapter and requires a separate state machine.

### ADR-005 Alternatives considered

- **Fixed command sleeps:** rejected because timing varies and every call pays
  the worst-case delay.
- **Substring searches:** rejected because command names occur inside output.
- **Parallel command execution:** rejected because one terminal cannot safely
  multiplex independent request-response streams.

## ADR-006: Expose Biff talk as four stateful tools

- **Status:** Accepted
- **Date:** 2026-08-09

### ADR-006 Context

Biff `talk` is modal. It includes invitation, waiting, acceptance, connected
conversation, asynchronous peer lines, cancellation, and hangup. It does not
follow ordinary command-prompt completion rules.

### ADR-006 Decision

Expose talk through four tools:

- `biff_talk_start`
- `biff_talk_read`
- `biff_talk_send`
- `biff_talk_end`

Track `idle`, `waiting`, and `connected` state inside the bridge. Wait for talk
event markers rather than ordinary prompts. After local or remote talk exit,
restart the owned REPL and reclaim its TTY because Biff does not reliably
restore ordinary prompt framing after modal talk.

### ADR-006 Consequences

- Pi can act as either inviter or accepter.
- Waiting cancellation and connected hangup are explicit operations.
- Ordinary Biff tools are blocked while talk is active.
- Restarting after talk briefly reconnects the Biff identity but restores
  deterministic command framing.
- Both talk roles and both hangup directions require real-relay tests.

### ADR-006 Alternatives considered

- **One blocking `biff_talk` tool:** rejected because a tool call cannot cleanly
  represent asynchronous, multi-turn conversation.
- **Treat talk lines as ordinary commands:** rejected because modal input and
  output do not use ordinary prompt framing.

## ADR-007: Use one session-scoped wake scheduler

- **Status:** Accepted
- **Date:** 2026-08-09

### ADR-007 Context

A background process or timer does not by itself continue a Pi agent. The
extension must inject an event and request a new turn. Independent timers can
otherwise create overlapping turns, duplicate messages, and unbounded queues.

### ADR-007 Decision

Use one shared wake scheduler for `keep`, `/every`, and Biff inbox events.
Deliver through `pi.sendMessage` with `deliverAs: "followUp"` and
`triggerTurn: true`. Keep at most one pending event per source; the newest event
replaces the older event from that source. Deliver pending sources together
when Pi is idle or emits `agent_settled`.

Cancel timers and pending events during every `session_shutdown`. Use generation
tokens so an asynchronous producer that finishes after cancellation cannot
inject a late wake.

### ADR-007 Consequences

- Background events can autonomously resume the agent.
- Busy ticks coalesce instead of accumulating model turns.
- Different sources can share one resumed turn.
- Timers do not cross reload, new-session, resume, fork, or process-exit
  boundaries.
- Exact response time still includes model and tool latency.

### ADR-007 Alternatives considered

- **Call `sendMessage` independently from each timer:** rejected because busy
  sources can create overlapping or duplicate turns.
- **Persist schedules across sessions:** rejected because instructions from an
  abandoned conversation must not enter a replacement session.
- **Only display UI notifications:** rejected because notifications do not
  continue the agent.

## ADR-008: Separate keep sampling from wake policy

- **Status:** Accepted
- **Date:** 2026-08-09

### ADR-008 Context

Some watches should wake the agent on every sample, some only when state
changes, and some should remain passive. Making every refresh a model turn can
create high cost and context noise, while never waking makes autonomous PR or
deployment monitoring impossible.

### ADR-008 Decision

Give `keep_watch` three policies:

- `change`: wake for the first snapshot and changed normalized output; default.
- `always`: wake every interval, including unchanged output.
- `never`: update tmux only and require manual capture.

Include an optional instruction with delivered output. Add `keep_after` for a
one-shot delayed capture of an existing kept session. `keep_stop` cancels both
repeating and one-shot wake state before killing tmux.

### ADR-008 Consequences

- PR and deployment watches avoid turns while state is unchanged.
- Explicit `always` supports true interval-driven loops.
- Passive logging remains available.
- `keep_after` supports long-running commands that do not fit `watch`.
- The first `change` snapshot always provides a baseline to the agent.

### ADR-008 Alternatives considered

- **Always wake:** rejected as the default because unchanged output can create
  unlimited model turns.
- **Only wake on change:** rejected as the sole policy because some workflows
  require periodic inspection despite stable output.
- **Keep manual capture only:** rejected because it cannot resume an idle agent.

## ADR-009: Make /every bounded and instruction-oriented

- **Status:** Accepted
- **Date:** 2026-08-09

### ADR-009 Context

Users need a small recurring scheduler for arbitrary LLM instructions. An
unbounded schedule is easy to forget and can create unlimited model usage.
Executing the text directly as a shell command would conflate agent
instructions with process execution.

### ADR-009 Decision

Use this grammar:

```text
/every <time> <LLM command> <max_times>
```

`time` is a positive integer with `s`, `m`, or `h`. The final positive integer
is required and bounds delivered instructions. Everything between them is the
LLM instruction. Provide `/every status` and `/every stop`. Allow only one
active schedule per Pi session.

Count deliveries, not elapsed ticks. Busy ticks coalesce and consume one run
when eventually delivered. Cancel the timer before the final agent turn starts.

### ADR-009 Consequences

- Every schedule has a finite upper bound.
- Arbitrary instructions, including Vox requests, are supported.
- `/every` triggers an agent; it does not execute shell text directly.
- Provider and tool latency mean output is not guaranteed at an exact wall-clock
  instant.

### ADR-009 Alternatives considered

- **Unbounded repetition:** rejected because accidental schedules can consume
  unlimited model turns.
- **A pipe delimiter before the maximum:** rejected in favor of the simpler
  positional grammar requested by users.
- **Direct command execution:** rejected because `/every` is an LLM scheduler,
  not a shell scheduler.

## ADR-010: Wake on Biff unread changes but read explicitly

- **Status:** Accepted
- **Date:** 2026-08-09

### ADR-010 Context

The bridge originally polled unread status only to update Pi notifications and
the footer. That informed a human but could not resume an idle agent. Polling
must not silently consume inbox messages.

### ADR-010 Decision

Poll Biff status every 15 seconds. When unread count increases, update the UI
and submit a `biff:inbox` event to the wake scheduler. The resumed agent must
call `biff_read` explicitly to retrieve and mark messages read.

### ADR-010 Consequences

- Incoming Biff messages can autonomously continue a task.
- Multiple changes while busy coalesce to the newest unread count.
- Polling latency is 0–15 seconds, averaging about 7.5 seconds, plus model
  latency.
- Inbox consumption remains visible as a tool call.
- Event-driven Biff delivery remains a future improvement.

### ADR-010 Alternatives considered

- **UI notification only:** rejected because it does not wake the agent.
- **Auto-read in the poller:** rejected because polling would consume messages
  outside an explicit agent action.
- **Shorter polling without measurement:** deferred pending a separate latency,
  relay-load, and event-delivery decision.

## ADR-011: Own both endpoints in real-relay tests

- **Status:** Accepted
- **Date:** 2026-08-09

### ADR-011 Context

A human or another agent is an unreliable integration-test fixture. A single
large scenario also produces poor diagnostics because one failure prevents
later behavior from running and the test name does not identify the broken
contract.

### ADR-011 Decision

Make real-relay tests opt-in and have them own the bridge REPL, peer REPL, fake
Pi host, unique TTYs, and cleanup. Split relay behavior into focused tests for
lifecycle, presence, controls, wall, messaging, talk roles, and cancellation.
Keep offline unit and static checks in `make check`; run relay validation with
`make test-integration`.

### ADR-011 Consequences

- Relay tests are deterministic with respect to endpoint ownership.
- Test names identify the failed behavior.
- External tests take longer and require Biff authentication and network
  access.
- Unconditional cleanup prevents most leaked test sessions; interrupted test
  processes may still require ownership-verified cleanup.
- Scheduler parsing, coalescing, cancellation, and wake policies remain fast
  offline unit tests.

### ADR-011 Alternatives considered

- **Use a human or teammate as the peer:** rejected because availability and
  timing make tests nondeterministic.
- **One end-to-end test:** rejected because failures have low diagnostic value.
- **Run relay tests in the default gate:** rejected because `make check` must
  remain offline and deterministic.
