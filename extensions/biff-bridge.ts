import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sendAndWait } from "../lib/tmux-wait.js";

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

async function tmux(...args: string[]) {
	return exec("tmux", args);
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

async function biffCommand(cmd: string): Promise<string> {
	return enqueueCommand(async () => {
		const err = await ensureBiffRepl();
		if (err) return "biff REPL not running: " + err;
		return sendAndWait(KEEP_SESSION, cmd, BIFF_PROMPT);
	});
}

function result(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

export default function biffBridgeExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const err = await ensureBiffRepl();
		if (err) {
			ctx.ui.notify("biff-bridge: could not start biff REPL: " + err, "warning");
			return;
		}

		// Each Pi process owns a distinct biff identity and tmux session.
		await biffCommand("tty " + BIFF_TTY);

		ctx.ui.setStatus("biff", "biff: connected");

		pollTimer = setInterval(() => {
			void pollUnread(ctx);
		}, POLL_INTERVAL_MS);
	});

	pi.on("session_shutdown", async () => {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = undefined;
		}
		try {
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
		description: "Set what you are currently working on. " + "Visible to teammates via biff_who.",
		parameters: {
			type: "object",
			properties: {
				text: { type: "string", description: "Plan text describing current work" },
			},
			required: ["text"],
		},
		async execute(_toolCallId, rawParams) {
			const params = rawParams as { text: string };
			try {
				return result(await biffCommand("plan " + params.text));
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
}

async function pollUnread(ctx: {
	ui: {
		setStatus(id: string, text: string | undefined): void;
		notify(msg: string, type: "info" | "warning" | "error"): void;
	};
}) {
	if (queuedCommands > 0) return;
	try {
		const output = await biffCommand("status");
		const match = /unread:\s*(\d+)/.exec(output);
		const count = match ? parseInt(match[1], 10) : 0;

		if (count > 0) {
			ctx.ui.setStatus("biff", "biff: " + String(count) + " unread");
			if (count > lastUnreadNotified) {
				ctx.ui.notify("biff: " + String(count) + " unread message(s)", "info");
			}
		} else {
			ctx.ui.setStatus("biff", "biff: connected");
		}
		lastUnreadNotified = count;
	} catch {
		// polling failure is silent
	}
}
