import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

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
	pi.registerCommand("keep", {
		description: "Manage long-running tmux processes: watch, run, capture, send, stop, list",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const spaceIdx = trimmed.indexOf(" ");
			const sub = spaceIdx < 0 ? trimmed : trimmed.slice(0, spaceIdx);
			const rest = spaceIdx < 0 ? "" : trimmed.slice(spaceIdx + 1).trim();

			switch (sub) {
				case "watch":
					return doWatch(rest, ctx);
				case "run":
					return doRun(rest, ctx);
				case "capture":
					return doCapture(rest, ctx);
				case "send":
					return doSend(rest, ctx);
				case "stop":
					return doStop(rest, ctx);
				case "list":
					return doList(ctx);
				case "":
				case "help":
					ctx.ui.notify(
						"Usage: /keep <subcommand>\n" +
							"  watch <name> <seconds> <command>\n" +
							"  run <name> <command>\n" +
							"  capture <name>\n" +
							"  send <name> <text>\n" +
							"  stop <name>\n" +
							"  list",
						"info",
					);
					return;
				default:
					ctx.ui.notify(`Unknown subcommand: ${sub}. Try /keep help`, "error");
			}
		},
	});
}

async function doWatch(args: string, ctx: ExtensionCommandContext) {
	const parsed = parseThreeArgs(args);
	if (!parsed) {
		ctx.ui.notify("Usage: /keep watch <name> <seconds> <command>", "error");
		return;
	}
	const { first: name, second: intervalStr, rest: command } = parsed;
	const interval = parseInt(intervalStr, 10);
	if (isNaN(interval) || interval <= 0) {
		ctx.ui.notify("Interval must be a positive number of seconds", "error");
		return;
	}
	const session = PREFIX + name;

	if (registry.has(name)) {
		ctx.ui.notify(`${name} is already running`, "error");
		return;
	}

	try {
		await tmux("new-session", "-d", "-s", session, `watch -n ${interval} ${command}`);
		registry.set(name, { name, session, mode: "watch", command, interval, startedAt: new Date().toISOString() });
		ctx.ui.notify(`Started watch: ${name} (every ${interval}s)`, "info");
	} catch (error) {
		ctx.ui.notify(`Failed to start: ${errorMessage(error)}`, "error");
	}
}

async function doRun(args: string, ctx: ExtensionCommandContext) {
	const parsed = parseTwoArgs(args);
	if (!parsed) {
		ctx.ui.notify("Usage: /keep run <name> <command>", "error");
		return;
	}
	const { first: name, rest: command } = parsed;
	const session = PREFIX + name;

	if (registry.has(name)) {
		ctx.ui.notify(`${name} is already running`, "error");
		return;
	}

	try {
		await tmux("new-session", "-d", "-s", session, command);
		registry.set(name, { name, session, mode: "run", command, startedAt: new Date().toISOString() });
		ctx.ui.notify(`Started: ${name}`, "info");
	} catch (error) {
		ctx.ui.notify(`Failed to start: ${errorMessage(error)}`, "error");
	}
}

async function doCapture(args: string, ctx: ExtensionCommandContext) {
	const name = args.trim();
	if (!name) {
		ctx.ui.notify("Usage: /keep capture <name>", "error");
		return;
	}
	try {
		const result = await tmux("capture-pane", "-t", PREFIX + name, "-p");
		const output = result.stdout.trimEnd();
		ctx.ui.notify(output || `${name}: pane is empty`, "info");
	} catch (error) {
		ctx.ui.notify(`Failed to capture: ${errorMessage(error)}`, "error");
	}
}

async function doSend(args: string, ctx: ExtensionCommandContext) {
	const parsed = parseTwoArgs(args);
	if (!parsed) {
		ctx.ui.notify("Usage: /keep send <name> <text>", "error");
		return;
	}
	try {
		await tmux("send-keys", "-t", PREFIX + parsed.first, parsed.rest, "Enter");
		ctx.ui.notify(`Sent to ${parsed.first}`, "info");
	} catch (error) {
		ctx.ui.notify(`Failed to send: ${errorMessage(error)}`, "error");
	}
}

async function doStop(args: string, ctx: ExtensionCommandContext) {
	const name = args.trim();
	if (!name) {
		ctx.ui.notify("Usage: /keep stop <name>", "error");
		return;
	}
	try {
		await tmux("kill-session", "-t", PREFIX + name);
		registry.delete(name);
		ctx.ui.notify(`Stopped: ${name}`, "info");
	} catch (error) {
		ctx.ui.notify(`Failed to stop: ${errorMessage(error)}`, "error");
	}
}

async function doList(ctx: ExtensionCommandContext) {
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
}

async function tmux(...args: string[]) {
	return exec("tmux", args);
}

export function parseTwoArgs(raw: string): { first: string; rest: string } | null {
	const trimmed = raw.trim();
	const idx = trimmed.indexOf(" ");
	if (idx < 0) return null;
	const first = trimmed.slice(0, idx);
	const rest = trimmed.slice(idx + 1).trim();
	if (!rest) return null;
	return { first, rest };
}

export function parseThreeArgs(raw: string): { first: string; second: string; rest: string } | null {
	const a = parseTwoArgs(raw);
	if (!a) return null;
	const b = parseTwoArgs(a.rest);
	if (!b) return null;
	return { first: a.first, second: b.first, rest: b.rest };
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
