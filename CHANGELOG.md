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
- A bash guard applies a 120-second default per-command timeout, configurable
  through `PI_BASH_TIMEOUT_S`, with KILL after a 10-second TERM grace period.
- The bash guard removes optional `PI_CODER_API_KEY` from shell subprocess
  environments while Pi processes retain it for configured provider auth.
- Delegated-coding guidance and ADR-012 define the parent's architecture
  ownership and mandatory independent diff, file-scope, test, and integration
  verification before acceptance.

### Changed

- Markdown lint uses repository npm tooling and excludes gitignored runtime
  captures and scratch files while retaining repository-owned Markdown checks.

### Security and operational limits

- Child agents share the current user's filesystem, network, and tools.
  Source-file scope is an instruction, not a filesystem restriction.
- Shell timeouts are not a total worker deadline, an output cap, or a sandbox.
  Credential removal does not filter every tool, environment secret, or file.
- GNU `timeout` must be available by that name, including on macOS.
- A worker's report remains pending parent verification; it is not proof that
  the requested behavior or integration checks passed.
