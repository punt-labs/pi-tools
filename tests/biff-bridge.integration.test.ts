import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import biffBridgeExtension from "../extensions/biff-bridge.js";
import { sendAndWait } from "../lib/tmux-wait.js";

const exec = promisify(execFile);
const prompt = /▶\s*$/;
const peerSession = `biff-bridge-peer-${String(process.pid)}`;
const bridgeSession = `keep-biff-bridge-${String(process.pid)}`;
const peerTty = `peer-${String(process.pid)}`;

interface ToolResult {
	content: { type: string; text: string }[];
}

interface RegisteredTool {
	name: string;
	execute: (...args: unknown[]) => Promise<ToolResult>;
}

type Handler = (...args: unknown[]) => unknown;

const integrationEnabled = process.env.BIFF_INTEGRATION === "1";

describe.skipIf(!integrationEnabled)("biff bridge real-relay integration", () => {
	let shutdown: Handler | undefined;

	afterEach(async () => {
		if (shutdown) await shutdown();
		await killSession(peerSession);
		await killSession(bridgeSession);
	});

	it("owns both endpoints across send, notification, read, and shutdown", async () => {
		const handlers = new Map<string, Handler>();
		const tools = new Map<string, RegisteredTool>();
		const statuses: string[] = [];
		const notifications: string[] = [];
		const fakePi = {
			on(event: string, handler: Handler) {
				handlers.set(event, handler);
			},
			registerTool(tool: RegisteredTool) {
				tools.set(tool.name, tool);
			},
		} as unknown as ExtensionAPI;
		const context = {
			ui: {
				setStatus(_id: string, text: string | undefined) {
					if (text !== undefined) statuses.push(text);
				},
				notify(message: string) {
					notifications.push(message);
				},
			},
		};

		await startPeer();
		const peerStatus = await sendAndWait(peerSession, "status", prompt);
		const user = /user:\s*(\S+)/.exec(peerStatus)?.[1];
		expect(user).toBeTruthy();

		biffBridgeExtension(fakePi);
		const start = requiredHandler(handlers, "session_start");
		shutdown = requiredHandler(handlers, "session_shutdown");
		await start({}, context);
		expect(statuses).toContain("biff: connected");

		const outbound = `bridge-to-peer-${String(Date.now())}`;
		const writeResult = await requiredTool(tools, "biff_write").execute("call-1", {
			to: `${String(user)}:${peerTty}`,
			message: outbound,
		});
		expect(resultText(writeResult)).toContain("Message sent");
		await waitForPeerUnread();
		expect(await sendAndWait(peerSession, "read", prompt)).toContain(outbound);

		const inbound = `peer-to-bridge-${String(Date.now())}`;
		const bridgeAddress = `${String(user)}:pi-${String(process.pid)}`;
		expect(await sendAndWait(peerSession, `write ${bridgeAddress} ${inbound}`, prompt)).toContain(
			"Message sent",
		);

		await waitUntil(
			() => notifications.some((message) => message.includes("unread message")),
			20_000,
		);
		expect(statuses.some((status) => /biff: \d+ unread/.test(status))).toBe(true);

		const readResult = await requiredTool(tools, "biff_read").execute("call-2", {});
		expect(resultText(readResult)).toContain(inbound);

		await shutdown();
		shutdown = undefined;
		await expect(exec("tmux", ["has-session", "-t", bridgeSession])).rejects.toThrow();
	}, 45_000);
});

async function startPeer(): Promise<void> {
	await exec("tmux", ["new-session", "-d", "-s", peerSession, "biff"]);
	await waitUntil(async () => {
		const pane = await exec("tmux", ["capture-pane", "-t", peerSession, "-p"]);
		return prompt.test(pane.stdout);
	}, 15_000);
	await sendAndWait(peerSession, `tty ${peerTty}`, prompt);
}

async function waitForPeerUnread(): Promise<void> {
	await waitUntil(async () => {
		const status = await sendAndWait(peerSession, "status", prompt);
		return /unread:\s*[1-9]\d*/.test(status);
	}, 10_000);
}

async function waitUntil(
	condition: () => boolean | Promise<boolean>,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`condition not met within ${String(timeoutMs)}ms`);
}

async function killSession(session: string): Promise<void> {
	try {
		await exec("tmux", ["kill-session", "-t", session]);
	} catch {
		// Already absent.
	}
}

function requiredHandler(handlers: Map<string, Handler>, name: string): Handler {
	const handler = handlers.get(name);
	if (!handler) throw new Error(`missing ${name} handler`);
	return handler;
}

function requiredTool(tools: Map<string, RegisteredTool>, name: string): RegisteredTool {
	const tool = tools.get(name);
	if (!tool) throw new Error(`missing ${name} tool`);
	return tool;
}

function resultText(result: ToolResult): string {
	return result.content.map((item) => item.text).join("\n");
}
