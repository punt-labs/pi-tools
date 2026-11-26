# Changelog

Changes are grouped under Unreleased until the first tagged release.

## Unreleased

### Added

- `pi_coder(task, target_path)` delegates one file to a stateless, tool-using
  Pi child that writes, compiles, runs, and tests on the shared filesystem.
- Required `PI_CODER_PROVIDER` and `PI_CODER_MODEL` configuration selects the
  coder without vendor-specific defaults. `PI_CODER_THINKING` optionally
  selects a Pi thinking level.
- Coder reporting includes the final worker report, file preview, and available
  JSON-event token usage, with failures reported separately from success.
- Retained nested-Pi stdout and stderr have an 8 MiB combined transcript cap.
  Overflow fails the delegation. Cancellation and overflow terminate the coder
  process group with TERM and a one-second KILL escalation, separately from
  shell-command deadlines.
- A bash guard applies a 120-second default per-command timeout, configurable
  through `PI_BASH_TIMEOUT_S`, with KILL after a 10-second TERM grace period.
- Node-based POSIX process-group supervision kills ordinary background jobs
  when their command exits, honors shorter per-call timeouts, and cancels only
  the owned group. It requires no GNU `timeout` executable.
- The bash guard removes optional `PI_CODER_API_KEY` from shell subprocess
  environments while Pi processes retain it for configured provider auth.
- Delegated-coding guidance and ADR-012 define the parent's architecture
  ownership and mandatory independent diff, file-scope, test, and integration
  verification before acceptance.
- A deterministic loopback-provider smoke exercises real installed parent and
  nested Pi processes, file writes, guarded shell checks, and failure events
  using fake credentials rather than a paid coding model.

### Changed

- Markdown lint uses repository npm tooling and explicit tracked paths from
  the current Git worktree's index, excluding runtime captures and scratch
  files without skipping a worktree inside an ignored parent directory.

### Fixed

- The keep smoke bounds the actual Pi process instead of attempting to run
  the shell builtin `wait` through `timeout`. It preserves nonzero Pi exits,
  escalates timeout termination, creates its artifact directory, and cleans
  only its uniquely named tmux session.
- Keep smoke validation requires actual successful JSON tool-completion
  events rather than matching tool names in prompts or narration. Offline
  fake-executable regressions cover the public `make smoke-pi` entry point.
- Keep smoke artifacts and printed diagnostics redact optional
  `PI_CODER_API_KEY` values, including JSON-escaped echoes. Stateful UTF-8
  decoding preserves split Unicode characters before redaction and validation.
- Keep smoke checks require run, capture, stop, then empty-list order. The final
  assistant outcome rejects errors, aborts, and truncation while allowing a
  completed retry to recover from an earlier provider error.
- Unknown or unsupported Pi CLI options produce guidance to select a
  compatible CLI on `PATH` (tested: 1.6.1), without dropping isolation flags,
  retrying, or changing the original nonzero exit status.

### Security and operational limits

- Child agents share the current user's filesystem, network, and tools.
  Source-file scope is an instruction, not a filesystem restriction.
- Shell timeouts are not a total worker deadline, an output cap, or a sandbox.
  Credential removal does not filter every tool, environment secret, or file.
- The coder transcript cap does not cap shell-command output files or disk
  spill. File-size reports describe actual UTF-8 bytes rather than redacted
  preview character counts.
- The guard requires Node.js 24, Bash, and POSIX process groups. Linux execution
  is checked; macOS execution is not yet checked. Deliberate new sessions can
  escape command-group supervision.
- A worker's report remains pending parent verification; it is not proof that
  the requested behavior or integration checks passed.
