import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseTwoArgs, parseThreeArgs } from "../lib/parse.js";
import * as registry from "../lib/registry.js";
import { formatList, stripWatchHeader } from "../lib/format.js";

const exec = promisify(execFile);

async function tmux(...args: string[]) {
	return exec("tmux", args);
}

function result(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

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
			const session = registry.sessionName(params.name);
			const err = registry.add({
				name: params.name,
				session,
				mode: "watch",
				command: params.command,
				interval: params.interval,
				startedAt: new Date().toISOString(),
			});
			if (err) return result(err);
			try {
				await tmux(
					"new-session",
					"-d",
					"-s",
					session,
					"watch -n " + String(params.interval) + " " + params.command,
				);
				return result(
					"Started watch: " + params.name + " (every " + String(params.interval) + "s)",
				);
			} catch (error) {
				registry.remove(params.name);
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
			const session = registry.sessionName(params.name);
			const err = registry.add({
				name: params.name,
				session,
				mode: "run",
				command: params.command,
				startedAt: new Date().toISOString(),
			});
			if (err) return result(err);
			try {
				await tmux("new-session", "-d", "-s", session, params.command);
				return result(`Started: ${params.name}`);
			} catch (error) {
				registry.remove(params.name);
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
				const r = await tmux("capture-pane", "-t", registry.sessionName(params.name), "-p");
				const kept = registry.get(params.name);
				const output =
					kept?.mode === "watch" ? stripWatchHeader(r.stdout.trimEnd()) : r.stdout.trimEnd();
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
				await tmux("send-keys", "-t", registry.sessionName(params.name), params.text, "Enter");
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
				await tmux("kill-session", "-t", registry.sessionName(params.name));
				registry.remove(params.name);
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
		execute() {
			return Promise.resolve(result(formatList(registry.list())));
		},
	});

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
					cmdList(ctx);
					return;
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
	const session = registry.sessionName(parsed.first);
	const err = registry.add({
		name: parsed.first,
		session,
		mode: "watch",
		command: parsed.rest,
		interval,
		startedAt: new Date().toISOString(),
	});
	if (err) {
		ctx.ui.notify(err, "error");
		return;
	}
	try {
		await tmux(
			"new-session",
			"-d",
			"-s",
			session,
			"watch -n " + String(interval) + " " + parsed.rest,
		);
		ctx.ui.notify("Started watch: " + parsed.first + " (every " + String(interval) + "s)", "info");
	} catch (error) {
		registry.remove(parsed.first);
		ctx.ui.notify(`Failed: ${errorMessage(error)}`, "error");
	}
}

async function cmdRun(args: string, ctx: ExtensionCommandContext) {
	const parsed = parseTwoArgs(args);
	if (!parsed) {
		ctx.ui.notify("Usage: /keep run <name> <command>", "error");
		return;
	}
	const session = registry.sessionName(parsed.first);
	const err = registry.add({
		name: parsed.first,
		session,
		mode: "run",
		command: parsed.rest,
		startedAt: new Date().toISOString(),
	});
	if (err) {
		ctx.ui.notify(err, "error");
		return;
	}
	try {
		await tmux("new-session", "-d", "-s", session, parsed.rest);
		ctx.ui.notify(`Started: ${parsed.first}`, "info");
	} catch (error) {
		registry.remove(parsed.first);
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
		const r = await tmux("capture-pane", "-t", registry.sessionName(name), "-p");
		const kept = registry.get(name);
		const output =
			kept?.mode === "watch" ? stripWatchHeader(r.stdout.trimEnd()) : r.stdout.trimEnd();
		ctx.ui.notify(output || `${name}: pane is empty`, "info");
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
		await tmux("send-keys", "-t", registry.sessionName(parsed.first), parsed.rest, "Enter");
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
		await tmux("kill-session", "-t", registry.sessionName(name));
		registry.remove(name);
		ctx.ui.notify(`Stopped: ${name}`, "info");
	} catch (error) {
		ctx.ui.notify(`Failed: ${errorMessage(error)}`, "error");
	}
}

function cmdList(ctx: ExtensionCommandContext) {
	ctx.ui.notify(formatList(registry.list()), "info");
}
