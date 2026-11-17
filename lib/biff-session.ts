// The bridge's own Biff session: created fresh, attached by its stable id,
// ended at shutdown, and never left as the repository's default session.
//
// `biff session new` also points the repository's default-session pointer at
// the new session (the session a bare `biff` attaches to). The bridge puts the
// previous default back, so a person running `biff` in the same repository
// never lands in the bridge's mailbox. The pointer is read through biff's own
// module, using the interpreter that runs the installed `biff` command.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

const RELAY_TIMEOUT_MS = 20_000;

export interface BiffSessionOptions {
	/** Directory biff runs in; decides the repository and its relay config. */
	cwd: string | undefined;
}

/** The interpreter behind the `biff` command, from its shebang. */
async function biffPython(): Promise<string | undefined> {
	try {
		const { stdout } = await exec("sh", ["-c", "command -v biff"]);
		const shebang = (await readFile(stdout.trim(), "utf8")).split("\n", 1)[0];
		return shebang.startsWith("#!") ? shebang.slice(2).trim() : undefined;
	} catch {
		return undefined;
	}
}

const POINTER_SCRIPT = `
import sys
from pathlib import Path
from biff.cli_session_pointer import CurrentPointer
from biff._stdlib import get_repo_common_root
root = get_repo_common_root()
pointer = CurrentPointer.default()
if sys.argv[1] == "read":
    print((pointer.read(Path(root)) or "") if root else "")
elif root and sys.argv[2]:
    pointer.write(Path(root), sys.argv[2])
`;

/** The repository's default-session id, or "" when there is none or it can't be read. */
export async function readDefaultSession(opts: BiffSessionOptions): Promise<string> {
	const python = await biffPython();
	if (!python) return "";
	try {
		const { stdout } = await exec(python, ["-c", POINTER_SCRIPT, "read"], {
			cwd: opts.cwd,
			timeout: 10_000,
		});
		return stdout.trim();
	} catch {
		return "";
	}
}

/** Point the repository's default session back at `id` (no-op for ""). */
export async function restoreDefaultSession(opts: BiffSessionOptions, id: string): Promise<void> {
	if (!id) return;
	const python = await biffPython();
	if (!python) return;
	try {
		await exec(python, ["-c", POINTER_SCRIPT, "write", id], { cwd: opts.cwd, timeout: 10_000 });
	} catch {
		// Best effort: a stale default only means bare `biff` starts a new session.
	}
}

/**
 * Create a fresh session named `tty` and return its stable id (unchanged by
 * `biff tty` renames). Ends any leftover live session with that name first.
 * Leaves the repository's default session as it was.
 */
export async function createOwnedSession(opts: BiffSessionOptions, tty: string): Promise<string> {
	const previousDefault = await readDefaultSession(opts);
	await endSession(opts, tty);
	try {
		const { stdout } = await exec("biff", ["--json", "session", "new", "--tty", tty], {
			cwd: opts.cwd,
			timeout: RELAY_TIMEOUT_MS,
		});
		const id = (JSON.parse(stdout) as { id?: unknown }).id;
		if (typeof id !== "string" || !id) throw new Error("biff session new returned no id");
		return id;
	} catch (error) {
		const stderr = (error as { stderr?: string }).stderr?.trim();
		throw new Error("biff session new failed" + (stderr ? `: ${stderr}` : ""));
	} finally {
		await restoreDefaultSession(opts, previousDefault);
	}
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
