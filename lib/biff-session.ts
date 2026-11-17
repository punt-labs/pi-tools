// The bridge's own Biff session: created fresh, attached by its stable id,
// ended at shutdown, and never left as the repository's default session.
//
// `biff session new` also points the repository's default-session pointer at
// the new session (the session a bare `biff` attaches to). The bridge puts the
// previous default back, so a person running `biff` in the same repository
// never lands in the bridge's mailbox. The pointer is read through biff's own
// module, using the interpreter that runs the installed `biff` command.
//
// Known limitation: this is a read, create, restore sequence outside biff, so
// it can race another process changing the pointer in between. The restore
// only writes when the pointer still names the bridge's new session, which
// keeps a newer `biff session use` or another bridge's restore; the remaining
// window is the moment between that check and the write. Any failure to read
// or restore is reported as a warning rather than ignored. The real fix is a
// `biff session new` option that leaves the pointer alone (biff issue PL-1137).

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

const RELAY_TIMEOUT_MS = 20_000;

export interface BiffSessionOptions {
	/** Directory biff runs in; decides the repository and its relay config. */
	cwd: string | undefined;
}

/**
 * The interpreter behind the `biff` command, from its shebang: an absolute
 * path (uv, pipx) or `/usr/bin/env <name>`. Throws when it can't be found.
 */
export async function biffPython(): Promise<string> {
	const { stdout } = await exec("sh", ["-c", "command -v biff"]);
	const launcher = stdout.trim();
	const firstLine = (await readFile(launcher, "utf8")).split("\n", 1)[0];
	return pythonFromShebang(firstLine, launcher);
}

/** Pure part of biffPython: map a launcher's first line to an interpreter. */
export async function pythonFromShebang(firstLine: string, launcher: string): Promise<string> {
	const words = firstLine.startsWith("#!") ? firstLine.slice(2).trim().split(/\s+/) : [];
	if (words.length === 1 && words[0].startsWith("/") && !words[0].endsWith("/sh")) return words[0];
	if (words.length >= 2 && words[0].endsWith("/env") && /^python[0-9.]*$/.test(words[1])) {
		const { stdout } = await exec("sh", ["-c", `command -v ${words[1]}`]);
		return stdout.trim();
	}
	throw new Error(`can't find the Python behind ${launcher} (first line: ${firstLine})`);
}

// read: print the pointed id. restore <expected> <previous>: put <previous>
// back only if the pointer still names <expected> (our new session); print
// "kept" when someone else changed it meanwhile. An empty <previous> removes
// the pointer, matching a repository that had no default before.
const POINTER_SCRIPT = `
import sys
from pathlib import Path
from biff.cli_session_pointer import CurrentPointer
from biff._stdlib import get_repo_common_root
root = get_repo_common_root()
if not root:
    sys.exit("not inside a git repository")
pointer = CurrentPointer.default()
repo = Path(root)
if sys.argv[1] == "read":
    print(pointer.read(repo) or "")
elif pointer.read(repo) != sys.argv[2]:
    print("kept")
elif sys.argv[3]:
    pointer.write(repo, sys.argv[3])
else:
    (pointer.root / pointer.repo_key(repo)).unlink(missing_ok=True)
`;

async function runPointerScript(opts: BiffSessionOptions, args: string[]): Promise<string> {
	const python = await biffPython();
	try {
		const { stdout } = await exec(python, ["-c", POINTER_SCRIPT, ...args], {
			cwd: opts.cwd,
			timeout: 10_000,
		});
		return stdout.trim();
	} catch (error) {
		throw new Error(lastStderrLine(error));
	}
}

/** The repository's default-session id ("" when there is none). Throws when it can't be read. */
export async function readDefaultSession(opts: BiffSessionOptions): Promise<string> {
	return runPointerScript(opts, ["read"]);
}

/**
 * Point the repository's default session back at `previous`, but only if it
 * still names `expected`. Returns false when someone changed it meanwhile.
 */
export async function restoreDefaultSession(
	opts: BiffSessionOptions,
	expected: string,
	previous: string,
): Promise<boolean> {
	return (await runPointerScript(opts, ["restore", expected, previous])) !== "kept";
}

export interface OwnedSession {
	/** Stable session id (`cli-…`), unchanged by `biff tty` renames. */
	id: string;
	/** Set when the repository's default session couldn't be checked or restored. */
	warning?: string;
}

/**
 * Create a fresh session named `tty`. Ends any leftover live session with
 * that name first, and puts the repository's default session back as it was.
 * A failure to do that is returned as a warning: the session still works,
 * but a bare `biff` in this repository may now attach to the bridge's session.
 */
export async function createOwnedSession(
	opts: BiffSessionOptions,
	tty: string,
): Promise<OwnedSession> {
	let previous: string | undefined;
	let warning: string | undefined;
	try {
		previous = await readDefaultSession(opts);
	} catch (error) {
		warning = "could not read the repository's default biff session: " + messageOf(error);
	}
	await endSession(opts, tty);
	let id: string;
	try {
		const { stdout } = await exec("biff", ["--json", "session", "new", "--tty", tty], {
			cwd: opts.cwd,
			timeout: RELAY_TIMEOUT_MS,
		});
		const parsed = (JSON.parse(stdout) as { id?: unknown }).id;
		if (typeof parsed !== "string" || !parsed) throw new Error("biff session new returned no id");
		id = parsed;
	} catch (error) {
		throw new Error("biff session new failed: " + lastStderrLine(error));
	}
	if (previous !== undefined) {
		try {
			await restoreDefaultSession(opts, id, previous);
		} catch (error) {
			warning = "could not restore the repository's default biff session: " + messageOf(error);
		}
	}
	if (warning) {
		warning += `. A bare \`biff\` here may now attach to ${tty}; run \`biff session use <name>\` to fix.`;
	}
	return warning ? { id, warning } : { id };
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function lastStderrLine(error: unknown): string {
	const stderr = (error as { stderr?: string }).stderr?.trim();
	return stderr ? (stderr.split("\n").pop() ?? stderr) : messageOf(error);
}

/** End a session by name or id; quietly does nothing if it isn't live. */
export async function endSession(opts: BiffSessionOptions, ref: string): Promise<void> {
	if (!ref) return;
	try {
		await exec("biff", ["session", "end", ref], { cwd: opts.cwd, timeout: RELAY_TIMEOUT_MS });
	} catch {
		// Already ended, or never created.
	}
}
