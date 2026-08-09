import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { capturePane, sendAndWait } from "../lib/tmux-wait.js";
import { wakeScheduler } from "../lib/wake-scheduler.js";

const exec = promisify(execFile);

const KEEP_SESSION = `keep-biff-bridge-${String(process.pid)}`;
const BIFF_TTY = `pi-${String(process.pid)}`;
const BIFF_PROMPT = /▶\s*$/;
const POLL_INTERVAL_MS = 15_000;
const STARTUP_TIMEOUT_MS = 15_000;

let pollTimer: ReturnType<typeof setInterval> | undefined;
let lastUnreadNotified = 0;
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
	if (await tmuxSessionExists()) {
		await tmux("send-keys", "-t", KEEP_SESSION, "-l", "exit");
		await tmux("send-keys", "-t", KEEP_SESSION, "Enter");
		const deadline = Date.now() + 3000;
		while (Date.now() < deadline && (await tmuxSessionExists())) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		if (await tmuxSessionExists()) await tmux("kill-session", "-t", KEEP_SESSION);
	}
	const startupError = await ensureBiffRepl();
	if (startupError) throw new Error(startupError);
	await runBiffCommand("tty " + BIFF_TTY);
}

async function ensureBiffRepl(): Promise<string | null> {
	try {
		await tmux("has-session", "-t", KEEP_SESSION);
		return null;
	} catch {
		// session does not exist, start it
	}
	try {
		await tmux("new-session", "-d", "-s", KEEP_SESSION, "biff");
		// wait for initial REPL startup and prompt
		const deadline = Date.now() + STARTUP_TIMEOUT_MS;
		while (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 300));
			const r = await tmux("capture-pane", "-t", KEEP_SESSION, "-p");
			if (BIFF_PROMPT.test(r.stdout)) return null;
		}
		return "biff REPL did not show prompt within 15s";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
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

function paneDelta(before: string, after: string): string {
	let shared = 0;
	const limit = Math.min(before.length, after.length);
	while (shared < limit && before[shared] === after[shared]) shared += 1;
	return after.slice(shared).trim();
}

function updateTalkMode(text: string): void {
	if (text.includes("Connected to ")) talkMode = "connected";
	if (text.includes("Talk with ") && (text.includes(" ended.") || text.includes(" cancelled."))) {
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

async function sendAndWaitForTalkEvent(command: string, events: string[]): Promise<string> {
	return enqueueCommand(async () => {
		const err = await ensureBiffRepl();
		if (err) return "biff REPL not running: " + err;
		const before = await capturePane(KEEP_SESSION);
		const counts = events.map((event) => occurrences(before, event));
		await tmux("send-keys", "-t", KEEP_SESSION, "-l", command);
		await tmux("send-keys", "-t", KEEP_SESSION, "Enter");
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			const pane = await capturePane(KEEP_SESSION);
			if (events.some((event, index) => occurrences(pane, event) > counts[index])) {
				return paneDelta(before, pane);
			}
		}
		throw new Error("biff talk event did not arrive within 10s");
	});
}

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
			if (BIFF_PROMPT.test(afterMessage)) return paneDelta(before, pane);
		}
		throw new Error("biff talk send did not complete within 10s");
	});
}

export default function biffBridgeExtension(pi: ExtensionAPI) {
	pi.on("agent_settled", () => wakeScheduler.flush());
	pi.on("session_start", async (_event, ctx) => {
		wakeScheduler.configure(pi, ctx);
		const err = await ensureBiffRepl();
		if (err) {
			ctx.ui.notify("biff-bridge: could not start biff REPL: " + err, "warning");
			return;
		}

		// Each Pi process owns a distinct biff identity and tmux session.
		await runBiffCommand("tty " + BIFF_TTY);

		ctx.ui.setStatus("biff", "biff: connected");

		pollTimer = setInterval(() => {
			void pollUnread(ctx);
		}, POLL_INTERVAL_MS);
	});

	pi.on("session_shutdown", async () => {
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
			try {
				return result(await biffCommand("write " + params.to + " " + params.message));
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
			const command = params.clear ? "plan clear" : "plan " + (params.text ?? "");
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
			try {
				return result(await biffCommand("finger " + params.user));
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
			const count = params.count === undefined ? "" : " --count " + String(params.count);
			const user = params.user ? " " + params.user : "";
			try {
				return result(await biffCommand("last" + count + user));
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
				command = "wall " + (params.message ?? "");
				if (params.duration) command += " " + params.duration;
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
			try {
				return result(await biffCommand("tty " + params.name));
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
			const command = "talk " + params.to + (params.opening ? " " + params.opening : "");
			try {
				const output = await sendAndWaitForTalkEvent(command, [
					"Waiting for ",
					"Connected to ",
					" is not online.",
					"Talk needs a specific session",
					"Already in a talk",
					"Error:",
				]);
				if (output.includes("Waiting for ")) talkMode = "waiting";
				if (output.includes("Connected to ")) talkMode = "connected";
				talkSnapshot = await capturePane(KEEP_SESSION);
				return result(output);
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
				if (output.includes(" ended.") || output.includes(" cancelled.")) {
					await restartOwnedRepl();
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
			try {
				await sendTalkLine(params.message);
				talkSnapshot = await capturePane(KEEP_SESSION);
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
				const output = await sendAndWaitForTalkEvent("end", [" ended.", " cancelled."]);
				talkMode = "idle";
				talkSnapshot = "";
				await restartOwnedRepl();
				return result(output);
			} catch (error) {
				return result("Failed: " + errorMessage(error));
			}
		},
	});
}

async function pollUnread(ctx: {
	ui: {
		setStatus(id: string, text: string | undefined): void;
		notify(msg: string, type: "info" | "warning" | "error"): void;
	};
}) {
	if (queuedCommands > 0 || talkMode !== "idle") return;
	try {
		const output = await biffCommand("status");
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
			ctx.ui.setStatus("biff", "biff: connected");
		}
		lastUnreadNotified = count;
	} catch {
		// polling failure is silent
	}
}
