import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import biffBridgeExtension from "../extensions/biff-bridge.js";
import { capturePane, sendAndWait } from "../lib/tmux-wait.js";

const exec = promisify(execFile);
const prompt = /▶\s*$/;
const bridgeSession = `keep-biff-bridge-${String(process.pid)}`;
let fixtureSequence = 0;

interface ToolResult {
	content: { type: string; text: string }[];
}

interface RegisteredTool {
	name: string;
	execute: (...args: unknown[]) => Promise<ToolResult>;
}

type Handler = (...args: unknown[]) => unknown;

class RelayFixture {
	readonly handlers = new Map<string, Handler>();
	readonly tools = new Map<string, RegisteredTool>();
	readonly statuses: string[] = [];
	readonly notifications: string[] = [];
	readonly wakes: string[] = [];
	readonly peerSession: string;
	readonly peerTty: string;
	readonly peerAddress: string;
	readonly bridgeAddress: string;
	private shutdown: Handler | undefined;

	private constructor(
		readonly user: string,
		sequence: number,
	) {
		this.peerSession = `biff-bridge-peer-${String(process.pid)}-${String(sequence)}`;
		this.peerTty = `peer-${String(process.pid)}-${String(sequence)}`;
		this.peerAddress = `${user}:${this.peerTty}`;
		this.bridgeAddress = `${user}:pi-${String(process.pid)}`;
	}

	static async start(): Promise<RelayFixture> {
		fixtureSequence += 1;
		const peerSession = `biff-bridge-peer-${String(process.pid)}-${String(fixtureSequence)}`;
		const peerTty = `peer-${String(process.pid)}-${String(fixtureSequence)}`;
		await exec("tmux", ["new-session", "-d", "-s", peerSession, "biff"]);
		await waitUntil(async () => prompt.test(await capturePane(peerSession)), 15_000);
		await sendAndWait(peerSession, `tty ${peerTty}`, prompt);
		const peerStatus = await sendAndWait(peerSession, "status", prompt);
		const user = /user:\s*(\S+)/.exec(peerStatus)?.[1];
		if (!user) throw new Error("peer status did not contain a user");

		const fixture = new RelayFixture(user, fixtureSequence);
		const fakePi = {
			on(event: string, handler: Handler) {
				fixture.handlers.set(event, handler);
			},
			registerTool(tool: RegisteredTool) {
				fixture.tools.set(tool.name, tool);
			},
			sendMessage(message: { content: string }) {
				fixture.wakes.push(message.content);
			},
		} as unknown as ExtensionAPI;
		const context = {
			isIdle() {
				return true;
			},
			ui: {
				setStatus(_id: string, text: string | undefined) {
					if (text !== undefined) fixture.statuses.push(text);
				},
				notify(message: string) {
					fixture.notifications.push(message);
				},
			},
		};

		biffBridgeExtension(fakePi);
		await requiredHandler(fixture.handlers, "session_start")({}, context);
		fixture.shutdown = requiredHandler(fixture.handlers, "session_shutdown");
		return fixture;
	}

	async tool(name: string, params: Record<string, unknown> = {}): Promise<string> {
		const result = await requiredTool(this.tools, name).execute(`call-${name}`, params);
		return result.content.map((item) => item.text).join("\n");
	}

	async peer(command: string): Promise<string> {
		return sendAndWait(this.peerSession, command, prompt);
	}

	async shutdownBridge(): Promise<void> {
		if (!this.shutdown) return;
		const shutdown = this.shutdown;
		this.shutdown = undefined;
		await shutdown();
	}

	async cleanup(): Promise<void> {
		await this.shutdownBridge();
		await stopPeer(this.peerSession);
		await killSession(bridgeSession);
	}
}

const integrationEnabled = process.env.BIFF_INTEGRATION === "1";

describe.skipIf(!integrationEnabled)("biff bridge real-relay integration", () => {
	let fixture: RelayFixture | undefined;

	afterEach(async () => {
		await fixture?.cleanup();
		fixture = undefined;
	});

	it("starts an isolated identity and shuts it down", async () => {
		fixture = await RelayFixture.start();
		expect(fixture.statuses).toContain("biff: connected");
		expect(await fixture.tool("biff_status")).toContain(`session: pi-${String(process.pid)}`);
		const who = await fixture.tool("biff_who");
		expect(who).toContain(fixture.peerTty);
		expect(who).toContain(`pi-${String(process.pid)}`);

		await fixture.shutdownBridge();
		expect(await sessionExists(bridgeSession)).toBe(false);
	}, 30_000);

	it("reports presence, plan, and login history", async () => {
		fixture = await RelayFixture.start();
		const plan = `integration-plan-${String(Date.now())}`;
		expect(await fixture.tool("biff_plan", { text: plan })).toContain("Plan:");
		expect(await fixture.tool("biff_finger", { user: fixture.bridgeAddress })).toContain(plan);
		expect(
			await fixture.tool("biff_last", {
				user: fixture.user,
				count: 10,
			}),
		).toContain(fixture.user);
		expect(await fixture.tool("biff_plan", { clear: true })).toBe("Plan:");
	}, 30_000);

	it("changes message and TTY session controls", async () => {
		fixture = await RelayFixture.start();
		expect(await fixture.tool("biff_mesg", { value: "n" })).toBe("is n");
		expect(await fixture.tool("biff_mesg", { value: "y" })).toBe("is y");
		const temporaryTty = `itest-${String(process.pid)}-${String(fixtureSequence)}`;
		expect(await fixture.tool("biff_tty", { name: temporaryTty })).toContain(temporaryTty);
		expect(await fixture.tool("biff_tty", { name: `pi-${String(process.pid)}` })).toContain(
			`pi-${String(process.pid)}`,
		);
	}, 30_000);

	it("posts, reads, and clears the wall", async () => {
		fixture = await RelayFixture.start();
		const wall = `integration-wall-${String(Date.now())}`;
		try {
			expect(
				await fixture.tool("biff_wall", {
					action: "post",
					message: wall,
					duration: "30m",
				}),
			).toContain("Wall posted");
			expect(await fixture.tool("biff_wall", { action: "read" })).toContain(wall);
			expect(await fixture.peer("wall")).toContain(wall);
		} finally {
			await fixture.tool("biff_wall", { action: "clear" });
		}
		expect(await fixture.tool("biff_wall", { action: "read" })).toContain("No active wall");
	}, 30_000);

	it("exchanges direct messages and reports unread mail", async () => {
		fixture = await RelayFixture.start();
		const activeFixture = fixture;
		const outbound = `bridge-to-peer-${String(Date.now())}`;
		expect(
			await fixture.tool("biff_write", {
				to: fixture.peerAddress,
				message: outbound,
			}),
		).toContain("Message sent");
		await waitUntil(
			async () => /unread:\s*[1-9]\d*/.test(await activeFixture.peer("status")),
			10_000,
		);
		expect(await fixture.peer("read")).toContain(outbound);

		const inbound = `peer-to-bridge-${String(Date.now())}`;
		expect(await fixture.peer(`write ${fixture.bridgeAddress} ${inbound}`)).toContain(
			"Message sent",
		);
		await waitUntil(
			() => activeFixture.notifications.some((message) => message.includes("unread message")),
			20_000,
		);
		expect(fixture.statuses.some((status) => /biff: \d+ unread/.test(status))).toBe(true);
		expect(fixture.wakes.some((wake) => wake.includes("Biff inbox update"))).toBe(true);
		expect(await fixture.tool("biff_read")).toContain(inbound);
	}, 40_000);

	it("conducts talk with the bridge as inviter", async () => {
		fixture = await RelayFixture.start();
		expect(await fixture.tool("biff_timestamps", { value: "on" })).toBe("Timestamps on.");
		const opening = `talk-opening-${String(Date.now())}`;
		expect(await fixture.tool("biff_talk_start", { to: fixture.peerAddress, opening })).toContain(
			"Waiting for",
		);
		expect(
			await sendAndWaitForPaneText(
				fixture.peerSession,
				`talk ${fixture.bridgeAddress}`,
				"Connected to",
				5000,
			),
		).toContain("Connected to");
		expect(await fixture.tool("biff_talk_read", { timeoutMs: 5000 })).toContain("Connected to");

		const outbound = `bridge-talk-${String(Date.now())}`;
		expect(await fixture.tool("biff_talk_send", { message: outbound })).toContain(
			"Talk message sent",
		);
		await waitForPaneText(fixture.peerSession, outbound, 5000);
		const inbound = `peer-talk-${String(Date.now())}`;
		await sendKeysLiteral(fixture.peerSession, inbound);
		const talkRead = await fixture.tool("biff_talk_read", { timeoutMs: 5000 });
		expect(talkRead).toContain(inbound);
		expect(talkRead).toMatch(/\[\d{2}:\d{2}\]/);

		const talkEnd = await fixture.tool("biff_talk_end");
		expect(talkEnd).not.toContain("Failed:");
		expect(talkEnd).toContain("ended");
		await waitForPaneText(fixture.peerSession, "ended", 5000);
		expect(await fixture.tool("biff_timestamps", { value: "off" })).toBe("Timestamps off.");
	}, 40_000);

	it("conducts talk with the bridge as accepter", async () => {
		fixture = await RelayFixture.start();
		const opening = `peer-opening-${String(Date.now())}`;
		expect(
			await sendAndWaitForPaneText(
				fixture.peerSession,
				`talk ${fixture.bridgeAddress} ${opening}`,
				"Waiting for",
				5000,
			),
		).toContain("Waiting for");
		expect(await fixture.tool("biff_talk_start", { to: fixture.peerAddress })).toContain(
			"Connected to",
		);

		const inbound = `accepted-peer-talk-${String(Date.now())}`;
		await sendKeysLiteral(fixture.peerSession, inbound);
		expect(await fixture.tool("biff_talk_read", { timeoutMs: 5000 })).toContain(inbound);
		const outbound = `accepted-bridge-talk-${String(Date.now())}`;
		expect(await fixture.tool("biff_talk_send", { message: outbound })).toContain(
			"Talk message sent",
		);
		await waitForPaneText(fixture.peerSession, outbound, 5000);

		await sendKeysLiteral(fixture.peerSession, "end");
		expect(await fixture.tool("biff_talk_read", { timeoutMs: 5000 })).toContain("ended");
		expect(await fixture.tool("biff_status")).toContain("relay:");
	}, 40_000);

	it("rejects invalid talk state and cancels a pending invite", async () => {
		fixture = await RelayFixture.start();
		expect(await fixture.tool("biff_talk_read")).toBe("No active talk session.");
		expect(await fixture.tool("biff_talk_send", { message: "too-early" })).toBe(
			"Talk is not connected yet.",
		);
		expect(await fixture.tool("biff_talk_end")).toBe("No active talk session.");

		expect(await fixture.tool("biff_talk_start", { to: fixture.peerAddress })).toContain(
			"Waiting for",
		);
		expect(await fixture.tool("biff_talk_start", { to: fixture.peerAddress })).toBe(
			"A talk session is already active.",
		);
		expect(await fixture.tool("biff_talk_send", { message: "still-too-early" })).toBe(
			"Talk is not connected yet.",
		);
		const cancelled = await fixture.tool("biff_talk_end");
		expect(cancelled).not.toContain("Failed:");
		expect(cancelled).toContain("cancelled");
		expect(await fixture.tool("biff_status")).toContain("relay:");
	}, 40_000);
});

async function sendAndWaitForPaneText(
	session: string,
	command: string,
	needle: string,
	timeoutMs: number,
): Promise<string> {
	const before = await capturePane(session);
	const prior = occurrences(before, needle);
	await sendKeysLiteral(session, command);
	let pane = before;
	await waitUntil(async () => {
		pane = await capturePane(session);
		return occurrences(pane, needle) > prior;
	}, timeoutMs);
	return pane;
}

async function waitForPaneText(session: string, needle: string, timeoutMs: number): Promise<void> {
	await waitUntil(async () => (await capturePane(session)).includes(needle), timeoutMs);
}

function occurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
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

async function sessionExists(session: string): Promise<boolean> {
	try {
		await exec("tmux", ["has-session", "-t", session]);
		return true;
	} catch {
		return false;
	}
}

async function stopPeer(session: string): Promise<void> {
	if (!(await sessionExists(session))) return;
	await sendKeysLiteral(session, "end");
	await new Promise((resolve) => setTimeout(resolve, 250));
	await sendKeysLiteral(session, "exit");
	try {
		await waitUntil(async () => !(await sessionExists(session)), 3000);
	} catch {
		await killSession(session);
	}
}

async function sendKeysLiteral(session: string, text: string): Promise<void> {
	await exec("tmux", ["send-keys", "-t", session, "-l", text]);
	await exec("tmux", ["send-keys", "-t", session, "Enter"]);
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
