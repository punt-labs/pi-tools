import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const exec = promisify(execFile);

const PREFIX = "keep-";

interface Kept {
	name: string;
	session: string;
	mode: "watch" | "run";
	command: string;
	interval?: number;
	startedAt: string;
}

const registry = new Map<string, Kept>();

export default function keepExtension(pi: ExtensionAPI) {
	pi.registerCommand("keep-watch", {
		description: "Start a watched command in a tmux session (refreshes every N seconds)",
		handler: async (args, ctx) => {
			const parsed = parseWatchArgs(args);
			if (!parsed) {
				ctx.ui.notify("Usage: /keep-watch <name> <seconds> <command>", "error");
				return;
			}
			const { name, interval, command } = parsed;
			const session = PREFIX + name;

			if (registry.has(name)) {
				ctx.ui.notify(`${name} is already running`, "error");
				return;
			}

			try {
				await tmux("new-session", "-d", "-s", session, `watch -n ${interval} ${command}`);
				registry.set(name, {
					name,
					session,
					mode: "watch",
					command,
					interval,
					startedAt: new Date().toISOString(),
				});
				ctx.ui.notify(`Started watch: ${name} (every ${interval}s)`, "info");
			} catch (error) {
				ctx.ui.notify(`Failed to start: ${errorMessage(error)}`, "error");
			}
		},
	});

	pi.registerCommand("keep-run", {
		description: "Start a long-running command in a tmux session",
		handler: async (args, ctx) => {
			const parsed = parseRunArgs(args);
			if (!parsed) {
				ctx.ui.notify("Usage: /keep-run <name> <command>", "error");
				return;
			}
			const { name, command } = parsed;
			const session = PREFIX + name;

			if (registry.has(name)) {
				ctx.ui.notify(`${name} is already running`, "error");
				return;
			}

			try {
				await tmux("new-session", "-d", "-s", session, command);
				registry.set(name, {
					name,
					session,
					mode: "run",
					command,
					startedAt: new Date().toISOString(),
				});
				ctx.ui.notify(`Started: ${name}`, "info");
			} catch (error) {
				ctx.ui.notify(`Failed to start: ${errorMessage(error)}`, "error");
			}
		},
	});

	pi.registerCommand("keep-capture", {
		description: "Capture current output from a kept tmux session",
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name) {
				ctx.ui.notify("Usage: /keep-capture <name>", "error");
				return;
			}
			const session = PREFIX + name;

			try {
				const result = await tmux("capture-pane", "-t", session, "-p");
				const output = result.stdout.trimEnd();
				if (output) {
					ctx.ui.notify(output, "info");
				} else {
					ctx.ui.notify(`${name}: pane is empty`, "info");
				}
			} catch (error) {
				ctx.ui.notify(`Failed to capture: ${errorMessage(error)}`, "error");
			}
		},
	});

	pi.registerCommand("keep-send", {
		description: "Send input text to a kept tmux session",
		handler: async (args, ctx) => {
			const parsed = parseSendArgs(args);
			if (!parsed) {
				ctx.ui.notify("Usage: /keep-send <name> <text>", "error");
				return;
			}
			const { name, text } = parsed;
			const session = PREFIX + name;

			try {
				await tmux("send-keys", "-t", session, text, "Enter");
				ctx.ui.notify(`Sent to ${name}`, "info");
			} catch (error) {
				ctx.ui.notify(`Failed to send: ${errorMessage(error)}`, "error");
			}
		},
	});

	pi.registerCommand("keep-stop", {
		description: "Stop a kept tmux session",
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name) {
				ctx.ui.notify("Usage: /keep-stop <name>", "error");
				return;
			}
			const session = PREFIX + name;

			try {
				await tmux("kill-session", "-t", session);
				registry.delete(name);
				ctx.ui.notify(`Stopped: ${name}`, "info");
			} catch (error) {
				ctx.ui.notify(`Failed to stop: ${errorMessage(error)}`, "error");
			}
		},
	});

	pi.registerCommand("keep-list", {
		description: "List all kept tmux sessions",
		handler: async (_args, ctx) => {
			if (registry.size === 0) {
				ctx.ui.notify("No active keep sessions", "info");
				return;
			}
			const lines: string[] = [];
			for (const kept of registry.values()) {
				const age = timeSince(kept.startedAt);
				if (kept.mode === "watch") {
					lines.push(`${kept.name} [watch ${kept.interval}s] ${age} — ${kept.command}`);
				} else {
					lines.push(`${kept.name} [run] ${age} — ${kept.command}`);
				}
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

async function tmux(...args: string[]) {
	return exec("tmux", args);
}

function parseWatchArgs(raw: string): { name: string; interval: number; command: string } | null {
	const trimmed = raw.trim();
	const spaceIdx = trimmed.indexOf(" ");
	if (spaceIdx < 0) return null;
	const name = trimmed.slice(0, spaceIdx);
	const rest = trimmed.slice(spaceIdx + 1).trim();
	const spaceIdx2 = rest.indexOf(" ");
	if (spaceIdx2 < 0) return null;
	const intervalStr = rest.slice(0, spaceIdx2);
	const interval = parseInt(intervalStr, 10);
	if (isNaN(interval) || interval <= 0) return null;
	const command = rest.slice(spaceIdx2 + 1).trim();
	if (!command) return null;
	return { name, interval, command };
}

function parseRunArgs(raw: string): { name: string; command: string } | null {
	const trimmed = raw.trim();
	const spaceIdx = trimmed.indexOf(" ");
	if (spaceIdx < 0) return null;
	const name = trimmed.slice(0, spaceIdx);
	const command = trimmed.slice(spaceIdx + 1).trim();
	if (!command) return null;
	return { name, command };
}

function parseSendArgs(raw: string): { name: string; text: string } | null {
	const trimmed = raw.trim();
	const spaceIdx = trimmed.indexOf(" ");
	if (spaceIdx < 0) return null;
	const name = trimmed.slice(0, spaceIdx);
	const text = trimmed.slice(spaceIdx + 1);
	if (!text) return null;
	return { name, text };
}

function timeSince(iso: string): string {
	const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60}m`;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
