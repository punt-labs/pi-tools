import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { capturePane, sendAndWait } from "../lib/tmux-wait.js";
import { biffLine, checkToken, flattenText } from "../lib/biff-args.js";
import { findBiffCwd, hasBiffConfig } from "../lib/biff-config.js";
import { createOwnedSession, endSession } from "../lib/biff-session.js";
import { isTalkHangup } from "../lib/biff-talk.js";
import { wakeScheduler } from "../lib/wake-scheduler.js";

const exec = promisify(execFile);

const KEEP_SESSION = `keep-biff-bridge-${String(process.pid)}`;
const BIFF_TTY = `pi-${String(process.pid)}`;
const BIFF_PROMPT = /▶\s*$/;
const POLL_INTERVAL_MS = 15_000;
// Where the biff REPL starts, which decides the relay config it reads
// (lib/biff-config.ts):
//   1. BIFF_CWD, when set (explicit choice);
//   2. else the nearest directory, from Pi's working directory upward, that
//      has a .punt-labs/biff config (a repo, or a workspace like ~/Coding/punt-labs);
//   3. else Pi's working directory, and the user is warned that biff will use
//      its public demo relay instead of the team's.
function biffCwdFromEnv(): string | undefined {
	const value = process.env.BIFF_CWD?.trim() ?? "";
	return value === "" ? undefined : value; // empty = unset
}

const BIFF_CWD = biffCwdFromEnv() ?? findBiffCwd(process.cwd());

// Whether biff will fall back to its public demo relay: no config where it
// starts (an explicit BIFF_CWD is checked too, since it may point at an
// unconfigured directory), and no BIFF_RELAY_URL override in the environment.
const ON_DEMO_RELAY =
	!(BIFF_CWD !== undefined && hasBiffConfig(BIFF_CWD)) &&
	(process.env.BIFF_RELAY_URL?.trim() ?? "") === "";
const CONNECTED_STATUS = ON_DEMO_RELAY ? "biff: connected (demo relay)" : "biff: connected";
const STARTUP_TIMEOUT_MS = 15_000;

let pollTimer: ReturnType<typeof setInterval> | undefined;
let lastUnreadNotified = 0;
// Bumped on every session_shutdown. A poll captures the generation before it
// awaits `status`; if it changes while awaiting, the session has ended and the
// poll must not enqueue a wake or touch the UI of a replacement session.
let sessionGeneration = 0;
let queuedCommands = 0;
let commandTail: Promise<void> = Promise.resolve();
let talkMode: "idle" | "waiting" | "connected" = "idle";
let talkSnapshot = "";

async function tmux(...args: string[]) {
	return exec("tmux", args);
}

async function tmuxSessionExists(): Promise<boolean> {
	try {
		await tmux("has-session", "-t", KEEP_SESSION);
		return true;
	} catch {
		return false;
	}
}

async function restartOwnedRepl(): Promise<void> {
	// Serialize the whole teardown+rebuild against every other biff command so the
	// unread poller can never issue `status` into a dying or half-started REPL.
	await enqueueCommand(async () => {
		if (await tmuxSessionExists()) {
			await tmux("send-keys", "-t", KEEP_SESSION, "-l", "exit");
			await tmux("send-keys", "-t", KEEP_SESSION, "Enter");
			const deadline = Date.now() + 3000;
			while (Date.now() < deadline && (await tmuxSessionExists())) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			if (await tmuxSessionExists()) await tmux("kill-session", "-t", KEEP_SESSION);
		}
		// Reattaches to the session we already own (ownedSessionId is kept).
		const startupError = await ensureBiffRepl();
		if (startupError) throw new Error(startupError);
	});
}

// The bridge owns its Biff session: created fresh at startup (lib/biff-session),
// attached by its stable id, and ended at shutdown. Using the id rather than
// the `pi-<pid>` name keeps reattach and shutdown working after `biff_tty`
// renames the session. A bare `biff` would instead attach to the repository's
// default session, shared with anyone else running biff in that repository.
let ownedSessionId = "";

// Serialises session ownership with shutdown, so a startup that is still
// creating the session can't leave one behind after shutdown has run.
let lifecycle: Promise<void> = Promise.resolve();
let shuttingDown = false;
// A function, not a direct read, because the flag changes while startup awaits
// the relay; reading it through a call keeps that visible to the type checker.
function isShuttingDown(): boolean {
	return shuttingDown;
}

function biffOpts(): { cwd: string | undefined } {
	return { cwd: BIFF_CWD };
}

async function endOwnedSession(): Promise<void> {
	const id = ownedSessionId;
	ownedSessionId = "";
	await endSession(biffOpts(), id);
}

// Start the REPL attached to the owned session, creating the session first if
// the bridge doesn't own one yet. The relay round trips happen before the
// prompt wait starts, so a slow relay can't eat into the REPL's startup time.
async function ensureBiffRepl(): Promise<string | null> {
	try {
		await tmux("has-session", "-t", KEEP_SESSION);
		return null;
	} catch {
		// session does not exist, start it
	}
	if (isShuttingDown()) return "the Pi session is shutting down";
	try {
		if (!ownedSessionId) ownedSessionId = await createOwnedSession(biffOpts(), BIFF_TTY);
		if (isShuttingDown()) {
			await endOwnedSession();
			return "the Pi session is shutting down";
		}
		const cwdArgs = BIFF_CWD ? ["-c", BIFF_CWD] : [];
		await tmux(
			"new-session",
			"-d",
			"-s",
			KEEP_SESSION,
			...cwdArgs,
			`biff --session ${ownedSessionId}`,
		);
		// Keep the pane if biff exits, so its error can be reported.
		await tmux("set-option", "-t", KEEP_SESSION, "remain-on-exit", "on");
		const deadline = Date.now() + STARTUP_TIMEOUT_MS;
		while (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 300));
			const r = await tmux("capture-pane", "-t", KEEP_SESSION, "-p");
			if (BIFF_PROMPT.test(r.stdout)) return null;
			const dead = await tmux("display-message", "-p", "-t", KEEP_SESSION, "#{pane_dead}");
			if (dead.stdout.trim() === "1") {
				await tmux("kill-session", "-t", KEEP_SESSION).catch(() => undefined);
				return "biff exited: " + lastLines(r.stdout);
			}
		}
		await tmux("kill-session", "-t", KEEP_SESSION).catch(() => undefined);
		return `biff REPL did not show prompt within ${String(STARTUP_TIMEOUT_MS / 1000)}s`;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

function lastLines(text: string): string {
	return text.trim().split("\n").slice(-3).join(" / ");
}

function enqueueCommand<T>(operation: () => Promise<T>): Promise<T> {
	queuedCommands += 1;
	const run = commandTail.then(operation, operation);
	commandTail = run.then(
		() => undefined,
		() => undefined,
	);
	return run.finally(() => {
		queuedCommands -= 1;
	});
}

async function runBiffCommand(cmd: string): Promise<string> {
	return enqueueCommand(async () => {
		const err = await ensureBiffRepl();
		if (err) return "biff REPL not running: " + err;
		return sendAndWait(KEEP_SESSION, cmd, BIFF_PROMPT);
	});
}

async function biffCommand(cmd: string): Promise<string> {
	if (talkMode !== "idle") {
		return "A talk session is active. Use biff_talk_send, biff_talk_read, or biff_talk_end.";
	}
	return runBiffCommand(cmd);
}

function result(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

// Model-controlled strings reach the biff REPL as one tmux literal line, and the
// REPL tokenises most commands with Python shlex. So identifiers must be single
// plain tokens, and free text is flattened to one line and passed as a single
// shlex-quoted argument (lib/biff-args.ts). Unquoted, an apostrophe ("Jim's")
// made biff reply "Parse error: No closing quotation", and a newline was
// rejected outright.
function textArg(value: string, field: string): { text: string } | { error: string } {
	const flat = flattenText(value);
	if ("error" in flat) return { error: `${field} ${flat.error}.` };
	if (!flat.text) return { error: `${field} must not be empty.` };
	return flat;
}

function paneDelta(before: string, after: string): string {
	let shared = 0;
	const limit = Math.min(before.length, after.length);
	while (shared < limit && before[shared] === after[shared]) shared += 1;
	return after.slice(shared).trim();
}

function updateTalkMode(text: string): void {
	if (text.includes("Connected to ")) talkMode = "connected";
	if (isTalkHangup(text)) {
		talkMode = "idle";
	}
}

async function readTalkDelta(timeoutMs: number): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	do {
		const pane = await capturePane(KEEP_SESSION);
		const delta = paneDelta(talkSnapshot, pane);
		if (delta) {
			talkSnapshot = pane;
			updateTalkMode(delta);
			return delta;
		}
		if (timeoutMs === 0) break;
		await new Promise((resolve) => setTimeout(resolve, 100));
	} while (Date.now() < deadline);
	return "No new talk activity.";
}

function occurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

interface TalkEventResult {
	delta: string;
	// The exact pane observed when the event fired. Using it as the talk baseline
	// avoids a race where a peer's first line arrives between event detection and a
	// later capture, which would fold that line into the baseline and lose it.
	pane: string;
}

async function sendAndWaitForTalkEvent(
	command: string,
	events: string[],
): Promise<TalkEventResult> {
	return enqueueCommand(async () => {
		const err = await ensureBiffRepl();
		if (err) return { delta: "biff REPL not running: " + err, pane: "" };
		const before = await capturePane(KEEP_SESSION);
		const counts = events.map((event) => occurrences(before, event));
		await tmux("send-keys", "-t", KEEP_SESSION, "-l", command);
		await tmux("send-keys", "-t", KEEP_SESSION, "Enter");
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			const pane = await capturePane(KEEP_SESSION);
			if (events.some((event, index) => occurrences(pane, event) > counts[index])) {
				return { delta: paneDelta(before, pane), pane };
			}
		}
		throw new Error("biff talk event did not arrive within 10s");
	});
}

// Returns the pane captured at send completion so the caller can use it as the
// talk baseline without a second capture that could race incoming peer output.
async function sendTalkLine(message: string): Promise<string> {
	return enqueueCommand(async () => {
		const before = await capturePane(KEEP_SESSION);
		const prior = occurrences(before, message);
		await tmux("send-keys", "-t", KEEP_SESSION, "-l", message);
		await tmux("send-keys", "-t", KEEP_SESSION, "Enter");
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			const pane = await capturePane(KEEP_SESSION);
			if (occurrences(pane, message) <= prior) continue;
			const afterMessage = pane.slice(pane.lastIndexOf(message) + message.length);
			if (BIFF_PROMPT.test(afterMessage)) return pane;
		}
		throw new Error("biff talk send did not complete within 10s");
	});
}

export default function biffBridgeExtension(pi: ExtensionAPI) {
	pi.on("agent_settled", () => wakeScheduler.flush());
	pi.on("session_start", async (_event, ctx) => {
		wakeScheduler.configure(pi, ctx);
		// Sample the generation before any await so a session_shutdown during
		// startup (which increments it) invalidates this session's poll timer
		// rather than the timer inheriting the post-shutdown value.
		const generation = sessionGeneration;
		// A fresh Pi session must re-announce any standing unread mail, so clear the
		// baseline that suppresses duplicate notifications within a single session.
		lastUnreadNotified = 0;
		shuttingDown = false;
		const start = lifecycle.then(async () => {
			const startError = await ensureBiffRepl();
			// A failed start must not leave a live session behind in `biff who`.
			if (startError) await endOwnedSession();
			return startError;
		});
		lifecycle = start.then(() => undefined);
		const err = await start;
		if (err) {
			ctx.ui.notify("biff-bridge: could not start biff REPL: " + err, "warning");
			return;
		}

		// The owned session is created under BIFF_TTY, so no `tty` rename is needed.

		// If the session shut down while we were starting up, do not install a
		// poll timer that would outlive this session (session_shutdown already ran
		// and cannot clear a timer created afterwards).
		if (generation !== sessionGeneration) return;

		if (ON_DEMO_RELAY) {
			ctx.ui.notify(
				"biff-bridge: no .punt-labs/biff config in " +
					(BIFF_CWD ?? process.cwd() + " or its parents") +
					", so biff uses its public demo relay. " +
					"Set BIFF_CWD to a directory with your team's biff config.",
				"warning",
			);
		}
		ctx.ui.setStatus("biff", CONNECTED_STATUS);

		pollTimer = setInterval(() => {
			void pollUnread(ctx, generation);
		}, POLL_INTERVAL_MS);
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		sessionGeneration += 1;
		wakeScheduler.shutdown();
		talkMode = "idle";
		talkSnapshot = "";
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = undefined;
		}
		try {
			await tmux("send-keys", "-t", KEEP_SESSION, "-l", "exit");
			await tmux("send-keys", "-t", KEEP_SESSION, "Enter");
			const deadline = Date.now() + 3000;
			while (Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				try {
					await tmux("has-session", "-t", KEEP_SESSION);
				} catch {
					return;
				}
			}
			await tmux("kill-session", "-t", KEEP_SESSION);
		} catch {
			// The REPL may already have exited.
		} finally {
			// End the session so it doesn't linger in `biff who` as a stale tty.
			// Chained after any startup still creating it, so neither can outlive shutdown.
			lifecycle = lifecycle.then(endOwnedSession);
			await lifecycle;
		}
	});

	pi.registerTool({
		name: "biff_who",
		label: "Biff Who",
		description:
			"Show active team members and what they are working on. " +
			"Returns the biff who table from the durable biff session.",
		parameters: { type: "object", properties: {} },
		async execute() {
			try {
				return result(await biffCommand("who"));
			} catch (error) {
				return result("Failed: " + errorMessage(error));
			}
		},
	});

	pi.registerTool({
		name: "biff_read",
		label: "Biff Read",
		description:
			"Check inbox for new messages. Marks all as read. " +
			"Returns message content from the durable biff session.",
		parameters: { type: "object", properties: {} },
		async execute() {
			try {
				return result(await biffCommand("read"));
			} catch (error) {
				return result("Failed: " + errorMessage(error));
			}
		},
	});

	pi.registerTool({
		name: "biff_write",
		label: "Biff Write",
		description:
			"Send a message to a teammate. The target should be " +
			"a user:tty address from biff_who output.",
		parameters: {
			type: "object",
			properties: {
				to: { type: "string", description: "Target address (e.g. claude:tty4)" },
				message: { type: "string", description: "Message text to send" },
			},
			required: ["to", "message"],
		},
		async execute(_toolCallId, rawParams) {
			const params = rawParams as { to: string; message: string };
			const invalid = checkToken(params.to, "to");
			if (invalid) return result(invalid);
			const message = textArg(params.message, "message");
			if ("error" in message) return result(message.error);
			try {
				return result(await biffCommand(biffLine("write", params.to.trim(), message.text)));
			} catch (error) {
				return result("Failed: " + errorMessage(error));
			}
		},
	});

	pi.registerTool({
		name: "biff_plan",
		label: "Biff Plan",
		description: "Set or clear what you are currently working on. Visible via biff_who.",
		parameters: {
			type: "object",
			properties: {
				text: { type: "string", description: "Plan text describing current work" },
				clear: { type: "boolean", description: "Clear the current plan" },
			},
		},
		async execute(_toolCallId, rawParams) {
			const params = rawParams as { text?: string; clear?: boolean };
			const text = params.text?.trim();
			if (!params.clear && !text) {
				return result("Provide non-empty text or set clear=true.");
			}
			let command = "plan clear";
			if (!params.clear) {
				const plan = textArg(text ?? "", "text");
				if ("error" in plan) return result(plan.error);
				command = biffLine("plan", plan.text);
			}
			try {
				return result(await biffCommand(command));
			} catch (error) {
				return result("Failed: " + errorMessage(error));
			}
		},
	});

	pi.registerTool({
		name: "biff_finger",
		label: "Biff Finger",
		description: "Check what a specific user is working on and their availability.",
		parameters: {
			type: "object",
			properties: {
				user: { type: "string", description: "User to look up (e.g. claude:tty4)" },
			},
			required: ["user"],
		},
		async execute(_toolCallId, rawParams) {
			const params = rawParams as { user: string };
			const invalid = checkToken(params.user, "user");
			if (invalid) return result(invalid);
			try {
				return result(await biffCommand(biffLine("finger", params.user.trim())));
			} catch (error) {
				return result("Failed: " + errorMessage(error));
			}
		},
	});

	pi.registerTool({
		name: "biff_status",
		label: "Biff Status",
		description: "Show relay connection, identity, session, unread count, and wall.",
		parameters: { type: "object", properties: {} },
		async execute() {
			try {
				return result(await biffCommand("status"));
			} catch (error) {
				return result("Failed: " + errorMessage(error));
			}
		},
	});

	pi.registerTool({
		name: "biff_last",
		label: "Biff Last",
		description: "Show recent biff session login and logout history.",
		parameters: {
			type: "object",
			properties: {
				user: { type: "string", description: "Optional user filter" },
				count: { type: "number", description: "Maximum entries, 1 through 100" },
			},
		},
		async execute(_toolCallId, rawParams) {
			const params = rawParams as { user?: string; count?: number };
			const normalizedCount =
				params.count === undefined
					? undefined
					: Math.min(100, Math.max(1, Math.trunc(params.count)));
			const args = normalizedCount === undefined ? [] : ["--count", String(normalizedCount)];
			if (params.user) {
				const invalid = checkToken(params.user, "user");
				if (invalid) return result(invalid);
				args.push(params.user.trim());
			}
			try {
				return result(await biffCommand(biffLine("last", ...args)));
			} catch (error) {
				return result("Failed: " + errorMessage(error));
			}
		},
	});

	pi.registerTool({
		name: "biff_wall",
		label: "Biff Wall",
		description: "Read, post, or clear the team wall broadcast.",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["read", "post", "clear"] },
				message: { type: "string", description: "Broadcast text for post" },
				duration: { type: "string", description: "Optional duration such as 30m or 2h" },
			},
			required: ["action"],
		},
		async execute(_toolCallId, rawParams) {
			const params = rawParams as unknown as {
				action: "read" | "post" | "clear";
				message?: string;
				duration?: string;
			};
			let command = "wall";
			if (params.action === "clear") command = "wall clear";
			if (params.action === "post") {
				if (!params.message?.trim()) {
					return result("A non-empty message is required to post the wall.");
				}
				const message = textArg(params.message, "message");
				if ("error" in message) return result(message.error);
				const args = [message.text];
				if (params.duration) {
					const invalid = checkToken(params.duration, "duration");
					if (invalid) return result(invalid);
					args.push(params.duration.trim());
				}
				command = biffLine("wall", ...args);
			}
			try {
				return result(await biffCommand(command));
			} catch (error) {
				return result("Failed: " + errorMessage(error));
			}
		},
	});

	pi.registerTool({
		name: "biff_mesg",
		label: "Biff Mesg",
		description: "Enable or suppress message notifications for this biff session.",
		parameters: {
			type: "object",
			properties: { value: { type: "string", enum: ["y", "n"] } },
			required: ["value"],
		},
		async execute(_toolCallId, rawParams) {
			const params = rawParams as unknown as { value: "y" | "n" };
			try {
				return result(await biffCommand("mesg " + params.value));
			} catch (error) {
				return result("Failed: " + errorMessage(error));
			}
		},
	});

	pi.registerTool({
		name: "biff_tty",
		label: "Biff TTY",
		description: "Rename this biff session's human-readable TTY alias.",
		parameters: {
			type: "object",
			properties: { name: { type: "string", description: "Unique TTY alias" } },
			required: ["name"],
		},
		async execute(_toolCallId, rawParams) {
			const params = rawParams as { name: string };
			const invalid = checkToken(params.name, "name");
			if (invalid) return result(invalid);
			try {
				return result(await biffCommand(biffLine("tty", params.name.trim())));
			} catch (error) {
				return result("Failed: " + errorMessage(error));
			}
		},
	});

	pi.registerTool({
		name: "biff_timestamps",
		label: "Biff Timestamps",
		description: "Turn timestamps on or off for subsequently displayed talk messages.",
		parameters: {
			type: "object",
			properties: { value: { type: "string", enum: ["on", "off"] } },
			required: ["value"],
		},
		async execute(_toolCallId, rawParams) {
			const params = rawParams as unknown as { value: "on" | "off" };
			try {
				return result(await biffCommand("timestamps " + params.value));
			} catch (error) {
				return result("Failed: " + errorMessage(error));
			}
		},
	});

	pi.registerTool({
		name: "biff_talk_start",
		label: "Biff Talk Start",
		description: "Invite a specific user:tty session to talk, or accept their pending invite.",
		parameters: {
			type: "object",
			properties: {
				to: { type: "string", description: "Specific user:tty address" },
				opening: { type: "string", description: "Optional opening message" },
			},
			required: ["to"],
		},
		async execute(_toolCallId, rawParams) {
			if (talkMode !== "idle") return result("A talk session is already active.");
			const params = rawParams as { to: string; opening?: string };
			const invalid = checkToken(params.to, "to");
			if (invalid) return result(invalid);
			// biff parses "talk" by whitespace, not shlex: quotes would arrive
			// literally, so the opening is flattened to one line but not quoted.
			let opening = "";
			if (params.opening?.trim()) {
				const flat = textArg(params.opening, "opening");
				if ("error" in flat) return result(flat.error);
				opening = flat.text;
			}
			// Close the idle gate synchronously, before any await, so a second talk start
			// or an ordinary biff tool issued in the same turn cannot slip past it.
			talkMode = "waiting";
			const command = "talk " + params.to.trim() + (opening ? " " + opening : "");
			try {
				const { delta, pane } = await sendAndWaitForTalkEvent(command, [
					"Waiting for ",
					"Connected to ",
					" is not online.",
					"Talk needs a specific session",
					"Already in a talk",
					"Error:",
				]);
				if (delta.includes("Connected to ")) talkMode = "connected";
				else if (delta.includes("Waiting for ")) talkMode = "waiting";
				else talkMode = "idle";
				if (talkMode === "idle") return result(delta);
				// Baseline from the pane observed at event time so a peer line that lands
				// during/just after connection is not folded into the snapshot and lost.
				talkSnapshot = pane;
				return result(delta);
			} catch (error) {
				talkMode = "idle";
				return result("Failed: " + errorMessage(error));
			}
		},
	});

	pi.registerTool({
		name: "biff_talk_read",
		label: "Biff Talk Read",
		description: "Read newly arrived talk activity and refresh connection state.",
		parameters: {
			type: "object",
			properties: {
				timeoutMs: { type: "number", description: "Wait up to this many milliseconds" },
			},
		},
		async execute(_toolCallId, rawParams) {
			if (talkMode === "idle") return result("No active talk session.");
			const params = rawParams as { timeoutMs?: number };
			const timeout = Math.max(0, Math.min(params.timeoutMs ?? 0, 10_000));
			try {
				const output = await readTalkDelta(timeout);
				if (isTalkHangup(output)) {
					// The talk is over on the relay; reset local state unconditionally so a
					// failed REPL rebuild cannot wedge the bridge and re-send end on retry.
					try {
						await restartOwnedRepl();
					} finally {
						talkMode = "idle";
						talkSnapshot = "";
					}
				}
				return result(output);
			} catch (error) {
				return result("Failed: " + errorMessage(error));
			}
		},
	});

	pi.registerTool({
		name: "biff_talk_send",
		label: "Biff Talk Send",
		description: "Send one line to the currently connected talk partner.",
		parameters: {
			type: "object",
			properties: { message: { type: "string", description: "Talk message" } },
			required: ["message"],
		},
		async execute(_toolCallId, rawParams) {
			if (talkMode !== "connected") return result("Talk is not connected yet.");
			const params = rawParams as { message: string };
			// Talk lines are sent exactly as typed (no shlex), so flatten, don't quote.
			const message = textArg(params.message, "message");
			if ("error" in message) return result(message.error);
			try {
				// Use the pane observed at send completion as the baseline so a peer line
				// arriving right after our send is not folded into the snapshot and lost.
				talkSnapshot = await sendTalkLine(message.text);
				return result("Talk message sent.");
			} catch (error) {
				return result("Failed: " + errorMessage(error));
			}
		},
	});

	pi.registerTool({
		name: "biff_talk_end",
		label: "Biff Talk End",
		description: "End a connected talk or withdraw a pending invitation.",
		parameters: { type: "object", properties: {} },
		async execute() {
			if (talkMode === "idle") return result("No active talk session.");
			try {
				const { delta } = await sendAndWaitForTalkEvent("end", [" ended.", " cancelled."]);
				// The talk is over on the relay; reset local state unconditionally so a
				// failed REPL rebuild cannot wedge the bridge and re-send end on retry.
				try {
					await restartOwnedRepl();
				} finally {
					talkMode = "idle";
					talkSnapshot = "";
				}
				return result(delta);
			} catch (error) {
				return result("Failed: " + errorMessage(error));
			}
		},
	});
}

async function pollUnread(
	ctx: {
		ui: {
			setStatus(id: string, text: string | undefined): void;
			notify(msg: string, type: "info" | "warning" | "error"): void;
		};
	},
	generation: number,
) {
	if (queuedCommands > 0 || talkMode !== "idle") return;
	try {
		const output = await biffCommand("status");
		// The session may have shut down while we awaited `status`; if so, do not
		// enqueue a wake or write UI that belongs to a replacement session.
		if (generation !== sessionGeneration) return;
		const match = /unread:\s*(\d+)/.exec(output);
		const count = match ? parseInt(match[1], 10) : 0;

		if (count > 0) {
			ctx.ui.setStatus("biff", "biff: " + String(count) + " unread");
			if (count > lastUnreadNotified) {
				ctx.ui.notify("biff: " + String(count) + " unread message(s)", "info");
				wakeScheduler.enqueue("biff:inbox", {
					source: "Biff inbox update",
					content:
						`You have ${String(count)} unread Biff message(s). ` +
						"Call biff_read to retrieve them and continue the conversation or task.",
				});
			}
		} else {
			// The demo-relay warning is shown once, at session_start; only the status here.
			ctx.ui.setStatus("biff", CONNECTED_STATUS);
		}
		lastUnreadNotified = count;
	} catch {
		// polling failure is silent
	}
}
