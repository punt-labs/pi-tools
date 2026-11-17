// The bridge's own Biff session: created fresh, attached by its stable id,
// ended at shutdown, and never left as the repository's default session.
//
// `biff session new` also points the repository's default-session pointer at
// the new session (the session a bare `biff` attaches to). The bridge puts the
// previous default back, so a person running `biff` in the same repository
// never lands in the bridge's mailbox. The pointer is read through biff's own
// module, using the interpreter that runs the installed `biff` command.
//
// Two bridges starting together would otherwise race: B could read A's
// temporary session as "the previous default" and put it back. The whole
// read, create, restore sequence therefore holds a per-repository OS lock
// (flock, keyed like biff's pointer, in ~/.punt-labs/biff) that every bridge
// (and the integration peers) takes. A person running
// `biff session use` meanwhile doesn't take the lock, so the restore only
// writes when the pointer still names the bridge's new session; the
// remaining window is the moment between that check and the write. Any failure to read
// or restore is reported as a warning rather than ignored. The real fix is a
// `biff session new` option that leaves the pointer alone (biff issue PL-1137).

import { execFile, spawn } from "node:child_process";
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

// Python helpers run with -P -E. They start in the repository, and -P keeps
// that directory off sys.path, so a checked-in `biff.py` or `biff/` can't
// shadow the installed package; -E ignores PYTHON* variables (PYTHONPATH).
// Not -I: it also drops user site-packages, where `pip install --user`
// puts biff. -P needs Python 3.11; biff requires 3.13.
async function runPointerScript(opts: BiffSessionOptions, args: string[]): Promise<string> {
	const python = await biffPython();
	try {
		const { stdout } = await exec(python, ["-P", "-E", "-c", POINTER_SCRIPT, ...args], {
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
	return withRepoLock(opts, () => createUnlocked(opts, tty));
}

const LOCK_WAIT_MS = 60_000;

// Takes an exclusive flock and holds it until stdin closes. The kernel drops
// the lock when this process exits for any reason, so a crashed holder never
// leaves a stale lock and nobody else can release it.
//
// The lock file is keyed exactly like biff's own default-session pointer
// (get_repo_common_root + CurrentPointer.repo_key), so every checkout and
// worktree that shares a pointer shares a lock. It lives beside the pointers
// in ~/.punt-labs/biff, in a directory only this user can write, so another
// local user can't swap the file out from under a holder.
const LOCK_SCRIPT = `
import fcntl, os, sys
from pathlib import Path
from biff.cli_session_pointer import CurrentPointer
from biff._stdlib import get_repo_common_root
root = get_repo_common_root()
if not root:
    sys.exit("not inside a git repository")
pointer = CurrentPointer.default()
locks = pointer.root.parent / "bridge-locks"
locks.mkdir(mode=0o700, parents=True, exist_ok=True)
if locks.stat().st_uid != os.getuid():
    sys.exit(f"{locks} is not owned by this user")
locks.chmod(0o700)
path = locks / (pointer.repo_key(Path(root)) + ".lock")
fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX)
print("locked", flush=True)
sys.stdin.read()
`;

/**
 * Run `fn` holding the repository's bridge lock (flock, held by a small child
 * process running biff's Python). Throws, without running `fn`, if the lock
 * isn't confirmed within LOCK_WAIT_MS: running unlocked could leave another
 * bridge's session as the repository default.
 */
export async function withRepoLock<T>(opts: BiffSessionOptions, fn: () => Promise<T>): Promise<T> {
	const holder = spawn(await biffPython(), ["-P", "-E", "-c", LOCK_SCRIPT], {
		cwd: opts.cwd,
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	holder.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	try {
		const acquired = await new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				resolve(false);
			}, LOCK_WAIT_MS);
			const settle = (value: boolean) => {
				clearTimeout(timer);
				resolve(value);
			};
			holder.stdout.once("data", (chunk: Buffer) => {
				settle(chunk.toString().startsWith("locked"));
			});
			holder.once("exit", () => {
				settle(false);
			});
			holder.once("error", () => {
				settle(false);
			});
		});
		if (!acquired) {
			const reason = stderr.trim().split("\n").pop() ?? "";
			throw new Error(
				"could not take the bridge session lock" +
					(reason ? `: ${reason}` : ` within ${String(LOCK_WAIT_MS / 1000)}s`),
			);
		}
		return await fn();
	} finally {
		holder.stdin.end();
		holder.kill();
	}
}

async function createUnlocked(opts: BiffSessionOptions, tty: string): Promise<OwnedSession> {
	let previous: string | undefined;
	let warning: string | undefined;
	try {
		previous = await readDefaultSession(opts);
	} catch (error) {
		warning = "could not read the repository's default biff session: " + messageOf(error);
	}
	await endSession(opts, tty).catch(() => undefined);
	// Ids that existed before creation, so an ambiguous failure can't mistake
	// an older record with the same name (in any repository) for ours.
	const before = await liveSessionIds(opts).catch(() => undefined);
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
		// A timeout or garbled reply may come after biff created the session and
		// moved the pointer. Undo both by name (unique to this process), so a
		// failed start leaves nothing live and no bridge session as the default.
		const cleanup = await undoAmbiguousCreate(opts, tty, previous, before);
		throw new Error(
			"biff session new failed: " + lastStderrLine(error) + (cleanup ? `; ${cleanup}` : ""),
		);
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

/**
 * Undo a `session new` whose reply was lost: find the session it may have
 * created, put the default pointer back (or clear it, when the previous value
 * is unknown, rather than leave it naming an ended session), then end it.
 * Returns a description of anything it couldn't do, or "" when clean.
 */
async function undoAmbiguousCreate(
	opts: BiffSessionOptions,
	tty: string,
	previous: string | undefined,
	before: Set<string> | undefined,
): Promise<string> {
	let id: string | undefined;
	try {
		id = await newSessionId(opts, tty, before);
	} catch (error) {
		return `could not check for a half-created session ${tty}: ${messageOf(error)}`;
	}
	if (!id) return "";
	const problems: string[] = [];
	try {
		await restoreDefaultSession(opts, id, previous ?? "");
	} catch (error) {
		problems.push(`could not restore the default session: ${messageOf(error)}`);
	}
	try {
		await endSession(opts, id);
	} catch (error) {
		problems.push(messageOf(error));
	}
	return problems.join("; ");
}

interface SessionRow {
	name?: unknown;
	state?: unknown;
	id?: unknown;
}

async function listSessions(opts: BiffSessionOptions): Promise<SessionRow[]> {
	const { stdout } = await exec("biff", ["--json", "session", "ls"], {
		cwd: opts.cwd,
		timeout: RELAY_TIMEOUT_MS,
	});
	return JSON.parse(stdout) as SessionRow[];
}

async function liveSessionIds(opts: BiffSessionOptions): Promise<Set<string>> {
	const rows = await listSessions(opts);
	return new Set(
		rows.flatMap((r) => (r.state === "live" && typeof r.id === "string" ? [r.id] : [])),
	);
}

/**
 * Id of the live session named `tty` that wasn't there before creation.
 * With no `before` snapshot, only an unambiguous single match is trusted.
 */
async function newSessionId(
	opts: BiffSessionOptions,
	tty: string,
	before: Set<string> | undefined,
): Promise<string | undefined> {
	const matches = (await listSessions(opts)).flatMap((r) =>
		r.name === tty && r.state === "live" && typeof r.id === "string" && !before?.has(r.id)
			? [r.id]
			: [],
	);
	return matches.length === 1 ? matches[0] : undefined;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function lastStderrLine(error: unknown): string {
	const stderr = (error as { stderr?: string }).stderr?.trim();
	return stderr ? (stderr.split("\n").pop() ?? stderr) : messageOf(error);
}

/**
 * End a session by name or id. Succeeds quietly when it doesn't exist or has
 * already ended; any other failure (relay timeout, auth) is thrown, so the
 * caller can keep the id and report it rather than leave a live session.
 */
export async function endSession(opts: BiffSessionOptions, ref: string): Promise<void> {
	if (!ref) return;
	try {
		await exec("biff", ["session", "end", ref], { cwd: opts.cwd, timeout: RELAY_TIMEOUT_MS });
	} catch (error) {
		const stderr = (error as { stderr?: string }).stderr ?? "";
		if (/unknown session:| ended at /.test(stderr)) return;
		throw new Error(`biff session end ${ref} failed: ${lastStderrLine(error)}`);
	}
}
