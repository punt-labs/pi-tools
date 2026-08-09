import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseTwoArgs, parseThreeArgs } from "../lib/parse.js";
import * as registry from "../lib/registry.js";
import { formatList, stripWatchHeader } from "../lib/format.js";
import { wakeScheduler } from "../lib/wake-scheduler.js";

const exec = promisify(execFile);
const watchSnapshots = new Map<string, string>();

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
	pi.on("session_start", (_event, ctx) => wakeScheduler.configure(pi, ctx));
	pi.on("agent_settled", () => wakeScheduler.flush());
	pi.on("session_shutdown", () => {
		watchSnapshots.clear();
		wakeScheduler.shutdown();
	});

	pi.registerTool({
		name: "keep_watch",
		label: "Keep Watch",
		description:
			"Start a command in tmux that refreshes every N seconds. By default, changed " +
			"output is injected and triggers another agent turn; use wake=always for every " +
			"interval or wake=never for manual keep_capture only.",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "Short name for this watch session" },
				interval: { type: "number", description: "Refresh interval in seconds" },
				command: { type: "string", description: "Shell command to watch" },
				wake: {
					type: "string",
					enum: ["change", "always", "never"],
					description: "When output should trigger another agent turn",
				},
				message: { type: "string", description: "Instruction delivered with output" },
			},
			required: ["name", "interval", "command"],
		},
		async execute(_toolCallId, rawParams) {
			const params = rawParams as unknown as {
				name: string;
				interval: number;
				command: string;
				wake?: "change" | "always" | "never";
				message?: string;
			};
			if (!Number.isFinite(params.interval) || params.interval <= 0) {
				return result("Interval must be a positive number");
			}
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
				const wake = params.wake ?? "change";
				if (wake !== "never") {
					scheduleWatch(params.name, params.interval, wake, params.message);
				}
				return result(
					"Started watch: " +
						params.name +
						" (every " +
						String(params.interval) +
						"s, wake " +
						wake +
						")",
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
		name: "keep_after",
		label: "Keep After",
		description:
			"After a delay, capture a kept session, inject its output with an instruction, " +
			"and trigger another agent turn.",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "Name of the kept session" },
				seconds: { type: "number", description: "Delay in seconds" },
				message: { type: "string", description: "Instruction delivered with the capture" },
			},
			required: ["name", "seconds", "message"],
		},
		execute(_toolCallId, rawParams) {
			const params = rawParams as { name: string; seconds: number; message: string };
			if (!Number.isFinite(params.seconds) || params.seconds <= 0) {
				return Promise.resolve(result("Seconds must be a positive number"));
			}
			if (!registry.get(params.name)) {
				return Promise.resolve(result(`Unknown kept session: ${params.name}`));
			}
			wakeScheduler.scheduleAfter(`after:${params.name}`, params.seconds * 1000, async () => ({
				source: `keep_after: ${params.name}`,
				content: `${params.message}\n\nCurrent output:\n${await captureOutput(params.name)}`,
			}));
			return Promise.resolve(
				result(`Scheduled capture of ${params.name} in ${String(params.seconds)}s`),
			);
		},
	});

	pi.registerTool({
		name: "keep_capture",
		label: "Keep Capture",
		description:
			"Capture the latest visible output from a kept tmux session. " +
			"Returns a snapshot of the current pane, not history. " +
			"For watch sessions, the watch header is stripped automatically.",
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
				await tmux("send-keys", "-t", registry.sessionName(params.name), "-l", params.text);
				await tmux("send-keys", "-t", registry.sessionName(params.name), "Enter");
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
				wakeScheduler.cancel(`watch:${params.name}`);
				wakeScheduler.cancel(`after:${params.name}`);
				watchSnapshots.delete(params.name);
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
				case "after":
					cmdAfter(rest, ctx);
					return;
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
							"  after <name> <seconds> <message>\n" +
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

async function captureOutput(name: string): Promise<string> {
	const r = await tmux("capture-pane", "-t", registry.sessionName(name), "-p");
	const output = r.stdout.trimEnd();
	return registry.get(name)?.mode === "watch" ? stripWatchHeader(output) : output;
}

export function shouldWakeWatch(
	wake: "change" | "always" | "never",
	previous: string | undefined,
	current: string,
): boolean {
	if (wake === "never") return false;
	return wake === "always" || previous === undefined || previous !== current;
}

function scheduleWatch(
	name: string,
	interval: number,
	wake: "change" | "always",
	message?: string,
): void {
	wakeScheduler.scheduleEvery(`watch:${name}`, interval * 1000, async () => {
		const output = await captureOutput(name);
		const previous = watchSnapshots.get(name);
		watchSnapshots.set(name, output);
		if (!shouldWakeWatch(wake, previous, output)) return undefined;
		return {
			source: `keep_watch update: ${name}`,
			content: `${message ?? "Review this output and continue the task."}\n\nCurrent output:\n${output || "(empty pane)"}`,
		};
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
		scheduleWatch(parsed.first, interval, "change");
		ctx.ui.notify(
			"Started watch: " + parsed.first + " (every " + String(interval) + "s, wake change)",
			"info",
		);
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

function cmdAfter(args: string, ctx: ExtensionCommandContext): void {
	const parsed = parseThreeArgs(args);
	if (!parsed) {
		ctx.ui.notify("Usage: /keep after <name> <seconds> <message>", "error");
		return;
	}
	const seconds = Number(parsed.second);
	if (!Number.isFinite(seconds) || seconds <= 0) {
		ctx.ui.notify("Seconds must be a positive number", "error");
		return;
	}
	if (!registry.get(parsed.first)) {
		ctx.ui.notify(`Unknown kept session: ${parsed.first}`, "error");
		return;
	}
	wakeScheduler.scheduleAfter(`after:${parsed.first}`, seconds * 1000, async () => ({
		source: `keep_after: ${parsed.first}`,
		content: `${parsed.rest}\n\nCurrent output:\n${await captureOutput(parsed.first)}`,
	}));
	ctx.ui.notify(`Scheduled capture of ${parsed.first} in ${String(seconds)}s`, "info");
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
		await tmux("send-keys", "-t", registry.sessionName(parsed.first), "-l", parsed.rest);
		await tmux("send-keys", "-t", registry.sessionName(parsed.first), "Enter");
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
		wakeScheduler.cancel(`watch:${name}`);
		wakeScheduler.cancel(`after:${name}`);
		watchSnapshots.delete(name);
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
