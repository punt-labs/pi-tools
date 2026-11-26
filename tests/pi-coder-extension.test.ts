import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piCoderExtension from "../extensions/pi-coder.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), readFile: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));

interface Result {
	content: { text: string }[];
	details: Record<string, unknown>;
}

async function failureMessage(pending: Promise<Result>): Promise<string> {
	try {
		await pending;
	} catch (error) {
		if (error instanceof Error) return error.message;
		throw error;
	}
	throw new Error("Expected a rejected tool call so Pi marks tool_execution_end.isError true");
}
interface Tool {
	name: string;
	description: string;
	promptGuidelines: string[];
	execute(
		id: string,
		params: { task: string; target_path: string },
		signal?: AbortSignal,
		onUpdate?: (result: Result) => void,
		ctx?: { cwd: string },
	): Promise<Result>;
}

function registeredTool(): Tool {
	let tool: Tool | undefined;
	piCoderExtension({ registerTool: (value: Tool) => (tool = value) } as unknown as ExtensionAPI);
	if (!tool) throw new Error("tool not registered");
	const registered = tool;
	return {
		...registered,
		execute: (id, params, signal, onUpdate, ctx = { cwd: process.cwd() }) =>
			registered.execute(id, params, signal, onUpdate, ctx),
	};
}

function fakeChild(stdout: string, code: number | null = 0, stderr = "") {
	const child = Object.assign(new EventEmitter(), {
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
		kill: vi.fn(() => true),
	});
	mocks.spawn.mockImplementation(() => {
		queueMicrotask(() => {
			child.stdout.emit("data", Buffer.from(stdout));
			child.stderr.emit("data", Buffer.from(stderr));
			child.emit("close", code);
		});
		return child;
	});
	return child;
}

function assistant(text = "self-tests passed", extra = {}): string {
	return JSON.stringify({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text }], ...extra },
	});
}

beforeEach(() => {
	vi.resetAllMocks();
	vi.stubEnv("PI_CODER_PROVIDER", "test-provider");
	vi.stubEnv("PI_CODER_MODEL", "test-model");
	vi.stubEnv("PI_CODER_THINKING", "");
	mocks.readFile.mockResolvedValue("export const value = 1;\n");
	fakeChild(assistant());
});
afterEach(() => vi.unstubAllEnvs());

describe("pi_coder execution contract", () => {
	it("emits a real Pi SDK tool_execution_end failure for missing coder configuration", async () => {
		vi.stubEnv("PI_CODER_PROVIDER", "");
		const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
		const corePath = join(
			dirname(sdkRequire.resolve("@earendil-works/pi-agent-core/package.json")),
			"dist/agent-loop.js",
		);
		const { runAgentLoop } = (await import(corePath)) as {
			runAgentLoop: (...args: unknown[]) => Promise<unknown>;
		};
		const tool = registeredTool();
		const events: Record<string, unknown>[] = [];
		let turn = 0;
		await runAgentLoop(
			[{ role: "user", content: "delegate", timestamp: 0 }],
			{ systemPrompt: "test", messages: [], tools: [tool] },
			{ model: { provider: "fake", id: "fake" }, convertToLlm: (messages: unknown) => messages },
			(event: Record<string, unknown>) => {
				events.push(event);
			},
			undefined,
			() => {
				const message = {
					role: "assistant",
					stopReason: turn++ === 0 ? "toolUse" : "stop",
					content:
						turn === 1
							? [
									{
										type: "toolCall",
										id: "coder-call",
										name: "pi_coder",
										arguments: { task: "write", target_path: "out.ts" },
									},
								]
							: [],
				};
				return {
					async *[Symbol.asyncIterator]() {
						yield await Promise.resolve({ type: "done", message });
					},
					result: () => Promise.resolve(message),
				};
			},
		);
		expect(events.find((event) => event.type === "tool_execution_end")).toMatchObject({
			isError: true,
		});
		expect(mocks.spawn).not.toHaveBeenCalled();
	});
	it("returns a clear configuration error without spawning when provider/model are absent", async () => {
		vi.stubEnv("PI_CODER_PROVIDER", "");
		vi.stubEnv("PI_CODER_MODEL", "");
		const message = await failureMessage(
			registeredTool().execute("1", { task: "write it", target_path: "out.ts" }),
		);
		expect(message).toContain("PI_CODER_PROVIDER");
		expect(message).toContain("PI_CODER_MODEL");
		expect(mocks.spawn).not.toHaveBeenCalled();
	});
	it("uses provider-neutral configuration, includes target path, and keeps fake credentials out of arguments", async () => {
		vi.stubEnv("PI_CODER_API_KEY", "fake-coder-key");
		vi.stubEnv("PI_CODER_THINKING", "max");
		const result = await registeredTool().execute("1", { task: "write it", target_path: "out.ts" });
		const [command, args] = mocks.spawn.mock.calls[0] as [string, string[]];
		expect(command).toBe("pi");
		expect(args.slice(0, 4)).toEqual(["--provider", "test-provider", "--model", "test-model"]);
		expect(args).toContain("max");
		expect(args.at(-1)).toContain(process.cwd() + "/out.ts");
		expect(args.join(" ")).not.toContain("fake-coder-key");
		expect(JSON.stringify(result)).not.toContain("fake-coder-key");
		expect(result.content[0].text).toContain("awaiting boss verification");
	});

	it("resolves target and subprocess cwd from the execution context, not the Node process", async () => {
		const cwd = join(process.cwd(), ".tmp", "other-workspace");
		await registeredTool().execute(
			"1",
			{ task: "write it", target_path: "out.ts" },
			undefined,
			undefined,
			{ cwd },
		);
		const [, args, options] = mocks.spawn.mock.calls[0] as [string, string[], { cwd: string }];
		expect(options.cwd).toBe(cwd);
		expect(args.at(-1)).toContain(join(cwd, "out.ts"));
		expect(mocks.readFile).toHaveBeenCalledWith(join(cwd, "out.ts"), "utf8");
	});

	it.each(["off", "minimal", "low", "medium", "high", "xhigh", "max"])(
		"accepts thinking level %s",
		async (level) => {
			vi.stubEnv("PI_CODER_THINKING", level);
			await registeredTool().execute("1", { task: "write it", target_path: "out.ts" });
			expect(mocks.spawn.mock.calls[0][1]).toContain(level);
		},
	);

	it("rejects unsupported thinking without spawning or exposing its value", async () => {
		vi.stubEnv("PI_CODER_THINKING", "fake-invalid-secret");
		const message = await failureMessage(
			registeredTool().execute("1", { task: "write it", target_path: "out.ts" }),
		);
		expect(message).toContain("PI_CODER_THINKING");
		expect(message).not.toContain("fake-invalid-secret");
		expect(mocks.spawn).not.toHaveBeenCalled();
	});

	it("does not start an already-cancelled delegation", async () => {
		const controller = new AbortController();
		controller.abort();
		const message = await failureMessage(
			registeredTool().execute("1", { task: "write it", target_path: "out.ts" }, controller.signal),
		);
		expect(message).toMatch(/cancel/i);
		expect(mocks.spawn).not.toHaveBeenCalled();
	});

	it("terminates a running child, escalates after one second, and removes the abort listener", async () => {
		vi.useFakeTimers();
		try {
			const child = fakeChild("");
			mocks.spawn.mockReturnValue(child);
			const controller = new AbortController();
			const removeListener = vi.spyOn(controller.signal, "removeEventListener");
			const pending = failureMessage(
				registeredTool().execute(
					"1",
					{ task: "write it", target_path: "out.ts" },
					controller.signal,
				),
			);
			controller.abort();
			expect(child.kill).toHaveBeenCalledWith("SIGTERM");
			await vi.advanceTimersByTimeAsync(1000);
			expect(child.kill).toHaveBeenCalledWith("SIGKILL");
			child.emit("close", 0);
			expect(await pending).toMatch(/cancel/i);
			expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects spawn failures so Pi marks a tool error", async () => {
		const child = fakeChild("");
		mocks.spawn.mockImplementation(() => {
			queueMicrotask(() => child.emit("error", new Error("fake spawn failure")));
			return child;
		});
		const message = await failureMessage(
			registeredTool().execute("1", { task: "write it", target_path: "out.ts" }),
		);
		expect(message).toContain("fake spawn failure");
	});

	it("redacts a fake credential echoed by a failed provider", async () => {
		vi.stubEnv("PI_CODER_API_KEY", "fake-echoed-coder-key");
		fakeChild("", 1, "provider rejected fake-echoed-coder-key");
		const message = await failureMessage(
			registeredTool().execute("1", { task: "write it", target_path: "out.ts" }),
		);
		expect(message).not.toContain("fake-echoed-coder-key");
		expect(message).toContain("[REDACTED]");
	});

	it("redacts a fake credential from assistant reports and file previews", async () => {
		vi.stubEnv("PI_CODER_API_KEY", "fake-echoed-coder-key");
		fakeChild(assistant("fake-echoed-coder-key"));
		mocks.readFile.mockResolvedValue("fake-echoed-coder-key");
		const result = await registeredTool().execute("1", { task: "write it", target_path: "out.ts" });
		expect(JSON.stringify(result)).not.toContain("fake-echoed-coder-key");
	});

	it("redacts literal and JSON-escaped fake credentials from failed child diagnostics", async () => {
		const fakeKey = 'fake-"quoted"\\coder-key';
		const escapedKey = JSON.stringify(fakeKey).slice(1, -1);
		vi.stubEnv("PI_CODER_API_KEY", fakeKey);
		fakeChild("", 1, "literal: " + fakeKey + "\n" + JSON.stringify({ rejectedKey: fakeKey }));
		const message = await failureMessage(
			registeredTool().execute("1", { task: "write it", target_path: "out.ts" }),
		);
		expect(message).not.toContain(fakeKey);
		expect(message).not.toContain(escapedKey);
		expect(message).toContain('"rejectedKey":"[REDACTED]"');
		expect(mocks.spawn).toHaveBeenCalledTimes(1);
		const [, args] = mocks.spawn.mock.calls[0] as [string, string[]];
		expect(args.join(" ")).not.toContain(fakeKey);
	});

	it("redacts literal and JSON-escaped fake credentials from successful reports and previews", async () => {
		const fakeKey = 'fake-"quoted"\\coder-key';
		const escapedKey = JSON.stringify(fakeKey).slice(1, -1);
		const source = "π😀 " + fakeKey + "\n" + JSON.stringify({ key: fakeKey });
		vi.stubEnv("PI_CODER_API_KEY", fakeKey);
		fakeChild(assistant("literal: " + fakeKey + "\nescaped: " + escapedKey));
		mocks.readFile.mockResolvedValue(source);
		const result = await registeredTool().execute("1", { task: "write it", target_path: "out.ts" });
		const display = result.content[0].text;
		expect(display).not.toContain(fakeKey);
		expect(display).not.toContain(escapedKey);
		expect(display).toContain('"key":"[REDACTED]"');
		expect(display).toContain(String(Buffer.byteLength(source, "utf8")) + " bytes at out.ts");
		expect(mocks.spawn).toHaveBeenCalledTimes(1);
		const [, args] = mocks.spawn.mock.calls[0] as [string, string[]];
		expect(args.join(" ")).not.toContain(fakeKey);
	});

	it("reports actual UTF-8 file bytes before redacting the fake credential for display", async () => {
		const fakeKey = "fake-byte-count-key";
		const source = "π😀 " + fakeKey + "\n";
		vi.stubEnv("PI_CODER_API_KEY", fakeKey);
		fakeChild(assistant("self-tested " + fakeKey));
		mocks.readFile.mockResolvedValue(source);
		const result = await registeredTool().execute("1", { task: "write it", target_path: "out.ts" });
		expect(result.content[0].text).toContain(
			String(Buffer.byteLength(source, "utf8")) + " bytes at out.ts",
		);
		expect(JSON.stringify(result)).not.toContain(fakeKey);
		expect(result.content[0].text).toContain("π😀 [REDACTED]");
	});

	it("treats assistant failure events as failure even with exit zero and a target file", async () => {
		fakeChild(assistant("", { stopReason: "error", errorMessage: "fake provider unavailable" }));
		const message = await failureMessage(
			registeredTool().execute("1", { task: "write it", target_path: "out.ts" }),
		);
		expect(message).toContain("fake provider unavailable");
	});

	it("does not present an old target file as success without a final assistant report", async () => {
		fakeChild(JSON.stringify({ type: "agent_start" }));
		await expect(
			registeredTool().execute("1", { task: "write it", target_path: "out.ts" }),
		).rejects.toThrow("no final assistant report");
	});

	it("returns an error when no target file exists", async () => {
		mocks.readFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
		await expect(
			registeredTool().execute("1", { task: "write it", target_path: "out.ts" }),
		).rejects.toThrow("produced no file");
	});

	it("reports nonzero exits and signal termination as errors", async () => {
		fakeChild("", null, "terminated");
		await expect(
			registeredTool().execute("1", { task: "write it", target_path: "out.ts" }),
		).rejects.toThrow("exit=-1");
	});

	it.each(["Unknown option: --no-mcp", "Unsupported CLI option: --no-context-files"])(
		"explains compatible Pi requirements when the CLI rejects isolation options: %s",
		async (diagnostic) => {
			vi.stubEnv("PI_CODER_API_KEY", "fake-cli-error-key");
			fakeChild("", 1, diagnostic + "\nfake-cli-error-key");
			const message = await failureMessage(
				registeredTool().execute("1", { task: "write", target_path: "out.ts" }),
			);
			expect(message).toContain("compatible Pi CLI is required");
			expect(message).toContain("tested with Pi 1.6.1");
			expect(message).toContain("correct pi executable is on PATH");
			expect(message).toContain(diagnostic);
			expect(message).not.toContain("fake-cli-error-key");
			expect(mocks.spawn).toHaveBeenCalledTimes(1);
			expect(mocks.spawn.mock.calls[0][1]).toContain("--no-mcp");
		},
	);

	it("does not mislabel an ordinary provider failure as a CLI compatibility failure", async () => {
		fakeChild("", 1, "fake provider unavailable");
		const message = await failureMessage(
			registeredTool().execute("1", { task: "write", target_path: "out.ts" }),
		);
		expect(message).toContain("fake provider unavailable");
		expect(message).not.toContain("compatible Pi CLI");
	});

	it("stops collection and terminates the child when output exceeds eight MiB", async () => {
		const child = fakeChild("x".repeat(9 * 1024 * 1024));
		await expect(
			registeredTool().execute("1", { task: "write", target_path: "out.ts" }),
		).rejects.toThrow("output exceeded");
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
	});

	it("requires independent boss verification and describes actual filesystem access", () => {
		const tool = registeredTool();
		expect(tool.description).not.toContain("Bifrost");
		expect(tool.promptGuidelines.join(" ")).not.toContain(
			"Treat its successful final report as the verification result",
		);
		expect(tool.promptGuidelines.join(" ")).toContain("independently");
		expect(tool.description).toContain("filesystem");
	});
});
