import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseTwoArgs, parseThreeArgs } from "../lib/parse.js";

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
	pi.registerTool({
		name: "keep_watch",
		label: "Keep Watch",
		description:
			"Start a command in a tmux session that refreshes every N seconds. " +
			"Use for PR check monitoring, periodic status checks, or any repeating command.",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "Short name for this watch session" },
				interval: { type: "number", description: "Refresh interval in seconds" },
				command: { type: "string", description: "Shell command to watch" },
			},
			required: ["name", "interval", "command"],
		},
		async execute(_toolCallId, rawParams) {
			const params = rawParams as { name: string; interval: number; command: string };
			const session = PREFIX + params.name;
			if (registry.has(params.name)) {
				return result(`${params.name} is already running`);
			}
			try {
				await tmux("new-session", "-d", "-s", session, `watch -n ${params.interval} ${params.command}`);
				registry.set(params.name, {
					name: params.name,
					session,
					mode: "watch",
					command: params.command,
					interval: params.interval,
					startedAt: new Date().toISOString(),
				});
				return result(`Started watch: ${params.name} (every ${params.interval}s)`);
			} catch (error) {
				return result(`Failed to start: ${errorMessage(error)}`);
			}
		},
	});

	pi.registerTool({
		name: "keep_run",
		label: "Keep Run",
		description:
			"Start a long-running or interactive command in a tmux session. " +
			"Use for biff REPLs, dev servers, or any process that should stay alive.",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "Short name for this session" },
				command: { type: "string", description: "Shell command to run" },
			},
			required: ["name", "command"],
		},
		async execute(_toolCallId, rawParams) {
			const params = rawParams as { name: string; command: string };
			const session = PREFIX + params.name;
			if (registry.has(params.name)) {
				return result(`${params.name} is already running`);
			}
			try {
				await tmux("new-session", "-d", "-s", session, params.command);
				registry.set(params.name, {
					name: params.name,
					session,
					mode: "run",
					command: params.command,
					startedAt: new Date().toISOString(),
				});
				return result(`Started: ${params.name}`);
			} catch (error) {
				return result(`Failed to start: ${errorMessage(error)}`);
			}
		},
	});

	pi.registerTool({
		name: "keep_capture",
		label: "Keep Capture",
		description:
			"Capture current visible output from a kept tmux session. " +
			"Returns the pane contents without attaching.",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "Name of the kept session to capture" },
			},
			required: ["name"],
		},
		async execute(_toolCallId, rawParams) {
			const params = rawParams as { name: string };
			try {
				const r = await tmux("capture-pane", "-t", PREFIX + params.name, "-p");
				const output = r.stdout.trimEnd();
				return result(output || `${params.name}: pane is empty`);
			} catch (error) {
				return result(`Failed to capture: ${errorMessage(error)}`);
			}
		},
	});

	pi.registerTool({
		name: "keep_send",
		label: "Keep Send",
		description:
			"Send a line of input to a kept tmux session. " +
			"Use for interactive REPLs like biff where you need to type commands.",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "Name of the kept session" },
				text: { type: "string", description: "Text to send (Enter is appended automatically)" },
			},
			required: ["name", "text"],
		},
		async execute(_toolCallId, rawParams) {
			const params = rawParams as { name: string; text: string };
			try {
				await tmux("send-keys", "-t", PREFIX + params.name, params.text, "Enter");
				return result(`Sent to ${params.name}`);
			} catch (error) {
				return result(`Failed to send: ${errorMessage(error)}`);
			}
		},
	});

	pi.registerTool({
		name: "keep_stop",
		label: "Keep Stop",
		description: "Stop a kept tmux session and remove it from the registry.",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "Name of the kept session to stop" },
			},
			required: ["name"],
		},
		async execute(_toolCallId, rawParams) {
			const params = rawParams as { name: string };
			try {
				await tmux("kill-session", "-t", PREFIX + params.name);
				registry.delete(params.name);
				return result(`Stopped: ${params.name}`);
			} catch (error) {
				return result(`Failed to stop: ${errorMessage(error)}`);
			}
		},
	});

	pi.registerTool({
		name: "keep_list",
		label: "Keep List",
		description: "List all active kept tmux sessions with their mode, age, and command.",
		parameters: { type: "object", properties: {} },
		async execute() {
			if (registry.size === 0) {
				return result("No active keep sessions");
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
			return result(lines.join("\n"));
		},
	});

	// Also register a slash command for direct human use
	pi.registerCommand("keep", {
		description: "Manage kept tmux sessions: watch, run, capture, send, stop, list, help",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const spaceIdx = trimmed.indexOf(" ");
			const sub = spaceIdx < 0 ? trimmed : trimmed.slice(0, spaceIdx);
			const rest = spaceIdx < 0 ? "" : trimmed.slice(spaceIdx + 1).trim();

			switch (sub) {
				case "watch":
					return cmdWatch(rest, ctx);
				case "run":
					return cmdRun(rest, ctx);
				case "capture":
					return cmdCapture(rest, ctx);
				case "send":
					return cmdSend(rest, ctx);
				case "stop":
					return cmdStop(rest, ctx);
				case "list":
					return cmdList(ctx);
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

function result(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

async function tmux(...args: string[]) {
	return exec("tmux", args);
}

async function cmdWatch(args: string, ctx: ExtensionCommandContext) {
	const parsed = parseThreeArgs(args);
	if (!parsed) {
		ctx.ui.notify("Usage: /keep watch <name> <seconds> <command>", "error");
		return;
	}
	const interval = parseInt(parsed.second, 10);
	if (isNaN(interval) || interval <= 0) {
		ctx.ui.notify("Interval must be a positive number", "error");
		return;
	}
	const session = PREFIX + parsed.first;
	if (registry.has(parsed.first)) {
		ctx.ui.notify(`${parsed.first} is already running`, "error");
		return;
	}
	try {
		await tmux("new-session", "-d", "-s", session, `watch -n ${interval} ${parsed.rest}`);
		registry.set(parsed.first, {
			name: parsed.first,
			session,
			mode: "watch",
			command: parsed.rest,
			interval,
			startedAt: new Date().toISOString(),
		});
		ctx.ui.notify(`Started watch: ${parsed.first} (every ${interval}s)`, "info");
	} catch (error) {
		ctx.ui.notify(`Failed: ${errorMessage(error)}`, "error");
	}
}

async function cmdRun(args: string, ctx: ExtensionCommandContext) {
	const parsed = parseTwoArgs(args);
	if (!parsed) {
		ctx.ui.notify("Usage: /keep run <name> <command>", "error");
		return;
	}
	const session = PREFIX + parsed.first;
	if (registry.has(parsed.first)) {
		ctx.ui.notify(`${parsed.first} is already running`, "error");
		return;
	}
	try {
		await tmux("new-session", "-d", "-s", session, parsed.rest);
		registry.set(parsed.first, {
			name: parsed.first,
			session,
			mode: "run",
			command: parsed.rest,
			startedAt: new Date().toISOString(),
		});
		ctx.ui.notify(`Started: ${parsed.first}`, "info");
	} catch (error) {
		ctx.ui.notify(`Failed: ${errorMessage(error)}`, "error");
	}
}

async function cmdCapture(args: string, ctx: ExtensionCommandContext) {
	const name = args.trim();
	if (!name) {
		ctx.ui.notify("Usage: /keep capture <name>", "error");
		return;
	}
	try {
		const r = await tmux("capture-pane", "-t", PREFIX + name, "-p");
		ctx.ui.notify(r.stdout.trimEnd() || `${name}: pane is empty`, "info");
	} catch (error) {
		ctx.ui.notify(`Failed: ${errorMessage(error)}`, "error");
	}
}

async function cmdSend(args: string, ctx: ExtensionCommandContext) {
	const parsed = parseTwoArgs(args);
	if (!parsed) {
		ctx.ui.notify("Usage: /keep send <name> <text>", "error");
		return;
	}
	try {
		await tmux("send-keys", "-t", PREFIX + parsed.first, parsed.rest, "Enter");
		ctx.ui.notify(`Sent to ${parsed.first}`, "info");
	} catch (error) {
		ctx.ui.notify(`Failed: ${errorMessage(error)}`, "error");
	}
}

async function cmdStop(args: string, ctx: ExtensionCommandContext) {
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
		ctx.ui.notify(`Failed: ${errorMessage(error)}`, "error");
	}
}

async function cmdList(ctx: ExtensionCommandContext) {
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
