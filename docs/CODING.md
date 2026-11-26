# Delegated Coding

`pi_coder(task, target_path)` starts a fresh Pi coding agent for one focused
file. The parent decides what to build; the child implements and checks it;
the parent independently decides whether the result meets the contract.

## Configure the provider

Both variables are required. There is no default provider or model:

```bash
export PI_CODER_PROVIDER=local-coder
export PI_CODER_MODEL=coding-model
```

These select an existing Pi provider and model; they do not register a provider
or configure its endpoint. Configure those separately through Pi's provider
configuration, including `~/.pi/agent/models.json` for a custom provider.

An illustrative OpenAI-compatible provider entry follows. Replace `<port>`
and the model identifier with values for your server; the URL is loopback only,
not a working endpoint. Merge the entry into your external Pi configuration,
not this repository:

```json
{
  "providers": {
    "local-coder": {
      "baseUrl": "http://localhost:<port>/v1",
      "api": "openai-completions",
      "apiKey": "$PI_CODER_API_KEY",
      "models": [{ "id": "coding-model" }]
    }
  }
}
```

`PI_CODER_API_KEY` is optional to pi-tools. Set it through your normal secret
manager only when your Pi provider configuration references it. The installed
Pi version's `models.json` syntax uses `$PI_CODER_API_KEY` for environment
lookup; a plain `PI_CODER_API_KEY` string is a literal credential value.
Check your Pi version's custom-provider documentation when configuring auth.
Other Pi authentication methods do not require this variable.

Never put credential values in `task`, command arguments, checked-in files,
or copied test output. The parent Pi process and nested Pi process retain the
credential for provider requests. The shell guard removes `PI_CODER_API_KEY`
from bash subprocess environments, not from every tool or credential file.

Optionally set `PI_CODER_THINKING` to a Pi thinking level: `off`, `minimal`,
`low`, `medium`, `high`, `xhigh`, or `max`. Availability and interpretation
depend on the selected model and Pi version. Omitting it leaves thinking
selection to Pi rather than imposing a pi-tools default.

Missing or blank provider/model values produce a configuration error before
starting the child. Unsupported nonblank thinking levels also fail before
spawn. Configure these variables in the environment that starts the parent Pi.

## Load the extensions

The source-installed package loads all its extensions by default. Use
`pi config` to disable or select resources from installed packages; project
overrides are available through `pi config -l`.

For a checkout, run from its root to select explicit extension files:

```bash
pi --no-extensions -e ./extensions/pi-coder.ts -e ./extensions/bash-guard.ts
```

`--no-extensions` disables discovery, not explicit `-e` files. Loading a whole
package through `-e` instead loads its selected package resources. The coder
loads its shell guard for nested calls; loading `bash-guard` in the parent also
changes the parent's bash tool.

## Parent and child responsibilities

The parent owns architecture and the file contract. Each task must include:

- the target file's purpose and exact public signatures
- permitted source-file writes and any permitted generated test artifacts
- input/output behavior, exit codes, and edge cases
- relevant neighboring interfaces and dependencies
- exact build flags, test commands, integration checks, and expected results
- any observed failure from an earlier call

Specify required behavior without dictating the implementation line by line.
Prefer small, focused files. `target_path` is absolute or relative to the
calling working directory. Include the target and relevant paths in the task
contract so the child knows what to inspect and write.

The child has tools. It writes the requested file on the shared filesystem,
compiles, runs, tests, and corrects its implementation. The extension reports
what landed; it must not overwrite the file with the worker's stdout.

Each call starts without the parent's conversation or previous-call history.
That does not prevent the child from inspecting files through its tools.
Do not rely on hidden conversation context or assume the child remembers a
previous attempt.

The nested Pi uses JSON print mode and keeps its built-in tools enabled.
Automatic discovery of extensions, context files, skills, prompt templates,
and MCP servers is disabled; the shell guard is loaded explicitly. Pi's
`--offline` flag disables startup network operations such as update checks,
not provider requests or the child's ability to access the network.

## Independent acceptance is mandatory

Every worker report is **pending parent verification**, including reports that
say compilation and tests passed. The parent must:

1. Compare the actual working-tree changes with the starting state, including
   untracked files and generated artifacts.
2. Inspect the real diff and confirm every changed file is permitted. Do not
   silently discard someone else's changes when checking the allowed files.
3. Independently run the specified compile and test commands and read their
   complete output.
4. Independently run the required integration checks for the assembled work.
5. Accept only when the actual code and independently observed results satisfy
   the contract.

A preview, token count, zero child exit, or worker statement is not evidence
that these checks passed. If verification fails, send a new writing task with
the precise defect and observed output. Do not call `pi_coder` only to inspect,
test, or verify an existing file: it is a writing tool and can rewrite it.

The result can include the worker's final report, a file preview, and reported
token usage. Usage depends on the provider's JSON events and is not a measure
of correctness or a guarantee of lower cost.

Tool results expose `details.coderUsage.inputTokens`, `outputTokens`, and
`reasoningTokens`. These aggregate recognized assistant-message usage fields;
missing fields contribute zero, which does not prove the provider used no
tokens. The final assistant text is a self-test report, not an acceptance
record. The file preview is deliberately partial; inspect the complete diff.

Configuration, spawn, cancellation, transcript overflow, nonzero-exit,
assistant-failure, missing-final-report, and missing-target failures are tool
errors. A readable target
and successful worker report still do not establish that the child changed
the intended file or met the task contract.

Failures reject the tool call with a sanitized error message so the real Pi
host marks the tool execution as failed. They are not successful tool results
carrying an `isError` field that the host may ignore.

## Shell limits and prerequisites

The guard requires Node.js 24 or later, Bash on `PATH`, and POSIX process groups.
It supervises each Bash command through Pi's command-execution operations in
TypeScript rather than wrapping the command string with an external utility.
GNU `timeout`, `gtimeout`, and Homebrew coreutils are not required. Linux
execution has been checked; macOS execution has not.

`PI_BASH_TIMEOUT_S` accepts a positive finite number of seconds up to
2,147,483.647 seconds, Node's timer ceiling. Missing, zero, negative,
non-numeric, infinite, and overflowing values fall back to 120 seconds.
At the deadline the guard sends TERM to the owned command group, followed
by KILL after 10 seconds if needed. Guard-deadline exit statuses are 124 and
137. A shorter per-call timeout remains effective; a longer one cannot extend
the configured ceiling.

Each command has its own detached process group. Command exit kills background
members of that group so ordinary background jobs cannot outlive their command.
Command cancellation kills the owned group; it does not kill independent
command groups. Deliberately creating another session can escape the group.
Process supervision is not containment or a same-user security restriction.

Three different runtime controls must not be confused:

- The shell deadline applies per bash command, not to the complete worker
  lifetime. The shell guard's TERM-to-KILL grace period is 10 seconds.
- `pi_coder` retains at most 8 MiB of combined nested-Pi stdout and stderr.
  Crossing that transcript-capture limit fails the delegation and terminates
  its process group. Cancellation and transcript overflow send TERM, then KILL
  after one second if needed; this is distinct from the shell guard's grace.
- Shell-command output files and disk spill have no volume cap. The transcript
  limit is not a disk quota. A fast command can write substantial data during
  its allowed runtime, and a worker can issue several commands.

There is no total worker deadline. Set task-specific checks and monitor resource
use for commands that may loop or produce large output. The result's file size
describes actual UTF-8 bytes, not the length of its redacted text preview.

## Access and trust

The parent, child, and tools run as the same user with shared filesystem and
network access. A one-file instruction is not an enforced filesystem rule.
The shell guard is not a sandbox, a general credential filter, or a disk quota.
Other tools, other environment credentials, and accessible files remain
available. Use an external isolation mechanism if the workload requires a
stronger restriction.

See [testing guidance](TESTING.md) for offline checks and live validation, and
[ADR-012](../DESIGN.md#adr-012-delegate-implementation-without-delegating-acceptance)
for the architectural decision.
