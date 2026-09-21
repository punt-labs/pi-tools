# Scheduling and Agent Wake-Up

Pi normally runs only in response to user input. `pi-tools` adds a
session-scoped scheduler that can inject an event and request another agent
turn after the current turn has settled.

## Delivery model

Scheduled events use Pi's extension API:

```typescript
pi.sendMessage(message, {
  deliverAs: "followUp",
  triggerTurn: true,
});
```

A source may have only one pending event. If a timer fires while the agent is
busy, newer output from that source replaces its older pending output. When the
agent settles, pending events are delivered together in one turn. This avoids
overlapping turns and unbounded queues.

All timers and pending events are cancelled on session shutdown, including
reload, new-session, resume, fork, and process exit. Kept tmux processes may
remain alive, but they cannot wake a replacement Pi session.

## Watching commands

`keep_watch` runs a command under tmux `watch` and samples its visible pane at
the requested interval:

```text
keep_watch(
  name="pr-checks",
  interval=30,
  command="gh -R punt-labs/pi-tools pr checks 1",
  wake="change",
  message="Continue when all checks and reviews are clean."
)
```

Wake policies:

- `change` is the default. The first snapshot wakes the agent; later snapshots
  wake it only when normalized output changes.
- `always` wakes the agent every interval, including unchanged output.
- `never` only refreshes the tmux pane. Use `keep_capture` to inspect it.

`keep_stop` cancels the watch timer and any pending event before terminating
tmux. A watch also stops on its own when its tmux session exits outside
`keep_stop` (its process finished or the pane was killed): the next sample
detects the missing session, cancels the schedule, drops its snapshot and
registry entry, and delivers one final notice that the watch has stopped. This
replaces what would otherwise be a repeating capture failure for a dead
session.

`keep_after` provides a one-shot alternative for a long-running process:

```text
keep_after(
  name="build",
  seconds=60,
  message="Inspect the build output and continue."
)
```

Scheduling another `keep_after` for the same name replaces the previous timer.

Watch and delayed-wake intervals must fall within the Node timer range, from 1
millisecond to 2,147,483,647 milliseconds (about 24.8 days). A larger value is
rejected rather than silently clamped, which would otherwise collapse into a
busy loop. Session names are restricted to 1-64 characters from `A-Z`, `a-z`,
`0-9`, `-`, and `_`; because a name becomes part of the tmux target, delimiters
such as `:` and `.` are rejected so a watch cannot address another session.

## Repeating LLM instructions

The `/every` command schedules a bounded arbitrary instruction:

```text
/every <time> <LLM command> <max_times>
```

`<time>` is a positive integer followed by `s`, `m`, or `h`. The resulting
interval must fall within the Node timer range (up to about 24.8 days); a larger
value is rejected. The final positive integer is required and limits delivered
instructions. Everything between the time and final integer is the instruction.

Examples:

```text
/every 30s check the deployment and report its status 12
/every 2m vox say "What's up?" 5
/every 1h summarize recent progress 3
```

Management commands:

```text
/every status
/every stop
```

The maximum counts delivered instructions, not elapsed timer ticks. Ticks that
occur while the agent is busy coalesce into one pending delivery and therefore
consume one run when eventually delivered. The final delivery cancels the
schedule before its agent turn starts.

`/every` injects an LLM instruction; it does not execute a shell command. A
request such as `vox say "What's up?"` starts an agent turn, and the agent then
calls the available Vox capability. Response time includes model and tool
latency, so the interval controls attempted delivery rather than exact audible
or textual output time.

## Pull-request flow

A typical PR monitor uses change-triggered delivery:

1. The agent starts `keep_watch` for `gh pr checks` and ends its turn.
2. The first snapshot reports the initial state.
3. Unchanged pending output causes no additional model turns.
4. A transition to pass or fail wakes the agent with the latest pane.
5. On success, the agent stops the watch, reads review comments and unresolved
   threads separately, and merges only when all review requirements are clean.
6. On failure, the agent fixes the branch and leaves the watch running for the
   next state change.

Green check output alone is not evidence that reviews and conversation threads
are clean.

## Biff message flow

The Biff bridge owns a durable REPL and polls `status` every 15 seconds. When
unread count increases:

1. The footer and notification are updated.
2. A `biff:inbox` event is submitted to the scheduler.
3. Pi starts a turn immediately when idle, or after the current turn settles.
4. The agent calls `biff_read` to retrieve and mark messages read.
5. The agent continues the task or replies with `biff_write`.

Polling never reads or consumes inbox messages. Multiple unread changes while
the agent is busy coalesce into one wake-up with the newest count.

The current polling delay is 0–15 seconds, averaging approximately 7.5 seconds,
plus model latency. Event-driven Biff delivery is a possible future
replacement for polling.

## Vox example

```text
/every 120s vox say "What's up?" 5
```

At each delivered interval, Pi injects the instruction and triggers an agent
turn. The agent invokes Vox, and the schedule stops after five delivered
instructions. Use `/every stop` to cancel it earlier.
