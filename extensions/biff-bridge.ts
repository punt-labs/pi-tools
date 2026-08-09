import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const exec = promisify(execFile);

const KEEP_NAME = "biff-bridge";
const KEEP_SESSION = "keep-" + KEEP_NAME;
const POLL_INTERVAL_MS = 15_000;

let pollTimer: ReturnType<typeof setInterval> | undefined;
let lastUnreadNotified = 0;

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
		// wait for REPL to initialize
		await new Promise((resolve) => setTimeout(resolve, 2000));
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

async function biffCommand(cmd: string): Promise<string> {
	const err = await ensureBiffRepl();
	if (err) return "biff REPL not running: " + err;

	await tmux("send-keys", "-t", KEEP_SESSION, cmd, "Enter");
	// wait for command output
	await new Promise((resolve) => setTimeout(resolve, 1500));

	const r = await tmux("capture-pane", "-t", KEEP_SESSION, "-p");
	return r.stdout.trimEnd();
}

function extractLatestOutput(pane: string, cmd: string): string {
	// Find the last occurrence of the prompt followed by the command,
	// then take everything between that and the next prompt.
	const lines = pane.split("\n");
	let startIdx = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].includes("▶") && lines[i].includes(cmd)) {
			startIdx = i + 1;
			break;
		}
	}
	if (startIdx < 0) return pane;

	let endIdx = lines.length;
	for (let i = startIdx; i < lines.length; i++) {
		if (lines[i].includes("▶") && !lines[i].includes(cmd)) {
			endIdx = i;
			break;
		}
	}

	return lines.slice(startIdx, endIdx).join("\n").trim();
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

		// Set a TTY name for this session
		await tmux("send-keys", "-t", KEEP_SESSION, "tty pi-bridge", "Enter");
		await new Promise((resolve) => setTimeout(resolve, 500));

		ctx.ui.setStatus("biff", "biff: connected");

		// Start unread poller
		pollTimer = setInterval(() => {
			void pollUnread(ctx);
		}, POLL_INTERVAL_MS);
	});

	pi.on("session_shutdown", () => {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = undefined;
		}
		// Leave the biff REPL running — it may be shared or
		// the user may want it to persist across sessions.
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
				const pane = await biffCommand("who");
				return result(extractLatestOutput(pane, "who"));
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
				const pane = await biffCommand("read");
				return result(extractLatestOutput(pane, "read"));
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
				const pane = await biffCommand("write " + params.to + " " + params.message);
				return result(extractLatestOutput(pane, "write"));
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
				const pane = await biffCommand("plan " + params.text);
				return result(extractLatestOutput(pane, "plan"));
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
				const pane = await biffCommand("finger " + params.user);
				return result(extractLatestOutput(pane, "finger"));
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
	try {
		const pane = await biffCommand("status");
		const output = extractLatestOutput(pane, "status");
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
		// polling failure is silent — do not spam notifications
	}
}
